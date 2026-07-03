//! Regime-conditioned PPO policy for exit-parameter selection.
//!
//! The agent observes a market-regime state vector and outputs continuous exit
//! parameters (stop-loss, trailing-stop, and two take-profit multiples). It is
//! trained with Proximal Policy Optimization (clipped surrogate objective)
//! against a reward that *replays* each historical trade's recorded peak price
//! under the chosen parameters — the same simulation the central-difference
//! optimizer uses, but now conditioned on regime so different market conditions
//! get different exit shapes.
//!
//! Because each trade's reward depends only on the action taken for that trade
//! (not on a sequence of decisions), this is a contextual bandit; PPO's clipped
//! ratio still applies and stabilizes the policy-gradient step.
//!
//! ## Policy
//!
//! Diagonal Gaussian over `action_dim` pre-squash values:
//!
//! ```text
//!   mean = W·state + b           (W: [A, S], b: [A])
//!   z    = mean + exp(log_std) ⊙ ε,  ε ~ N(0, I)
//!   pᵢ   = minᵢ + (maxᵢ − minᵢ)·σ(zᵢ)   (squash to each param's bounds)
//! ```
//!
//! Log-probabilities are computed in the pre-squash Gaussian space (clipped
//! action / no tanh-Jacobian correction) — standard and adequate for a bandit.

use crate::rng::Rng;

const LOG_STD_MIN: f64 = -4.0;
const LOG_STD_MAX: f64 = 1.0;
const LOG_2PI: f64 = 1.837_877_066_409_345_5;

#[inline]
fn sigmoid(x: f64) -> f64 {
    if x >= 0.0 {
        1.0 / (1.0 + (-x).exp())
    } else {
        let e = x.exp();
        e / (1.0 + e)
    }
}

#[derive(Clone)]
pub struct PpoPolicy {
    pub state_dim: usize,
    pub action_dim: usize,
    w: Vec<f64>,   // [action_dim * state_dim], row-major
    b: Vec<f64>,   // [action_dim]
    log_std: Vec<f64>, // [action_dim]
    action_min: Vec<f64>,
    action_max: Vec<f64>,
}

impl PpoPolicy {
    pub fn new(
        state_dim: usize,
        action_min: Vec<f64>,
        action_max: Vec<f64>,
        seed: u64,
    ) -> Self {
        let action_dim = action_min.len();
        let mut rng = Rng::new(seed);
        // Small random mean weights; start exploration at a moderate std.
        let limit = (1.0 / (state_dim.max(1)) as f64).sqrt() * 0.1;
        let w = (0..action_dim * state_dim).map(|_| rng.uniform(limit)).collect();
        PpoPolicy {
            state_dim,
            action_dim,
            w,
            b: vec![0.0; action_dim],
            log_std: vec![-0.7; action_dim], // std ≈ 0.5 in pre-squash space
            action_min,
            action_max,
        }
    }

    fn mean(&self, state: &[f64]) -> Vec<f64> {
        (0..self.action_dim)
            .map(|a| {
                let base = a * self.state_dim;
                let dot: f64 = (0..self.state_dim)
                    .map(|j| self.w[base + j] * state.get(j).copied().unwrap_or(0.0))
                    .sum();
                self.b[a] + dot
            })
            .collect()
    }

    #[inline]
    fn std(&self, a: usize) -> f64 {
        self.log_std[a].clamp(LOG_STD_MIN, LOG_STD_MAX).exp()
    }

    /// Maps a pre-squash value to the actual parameter within its bounds.
    fn squash(&self, a: usize, z: f64) -> f64 {
        self.action_min[a] + (self.action_max[a] - self.action_min[a]) * sigmoid(z)
    }

    /// Deterministic inference: the squashed mean action for a regime state.
    pub fn predict(&self, state: &[f64]) -> Vec<f64> {
        let mean = self.mean(state);
        (0..self.action_dim).map(|a| self.squash(a, mean[a])).collect()
    }

    /// PPO training over a batch of (state, peak_mult, stake) trades.
    /// Returns (iterations_ran, final_avg_reward).
    #[allow(clippy::too_many_arguments)]
    pub fn train(
        &mut self,
        states: &[Vec<f64>],
        peak_mults: &[f64],
        stakes: &[f64],
        iters: usize,
        epochs: usize,
        lr: f64,
        clip: f64,
        entropy_coef: f64,
        seed: u64,
    ) -> (usize, f64) {
        let n = states.len();
        if n == 0 {
            return (0, 0.0);
        }
        let mut rng = Rng::new(seed);
        let mut last_avg_reward = 0.0;

        for _ in 0..iters {
            // ── Rollout: sample one action per trade, record reward & old log-prob.
            let mut zs = vec![vec![0.0; self.action_dim]; n];
            let mut old_lp = vec![0.0; n];
            let mut rewards = vec![0.0; n];

            for i in 0..n {
                let mean = self.mean(&states[i]);
                let mut lp = 0.0;
                for a in 0..self.action_dim {
                    let std = self.std(a);
                    let eps = rng.normal();
                    let z = mean[a] + std * eps;
                    zs[i][a] = z;
                    lp += gaussian_logprob(z, mean[a], std);
                }
                old_lp[i] = lp;
                rewards[i] = self.reward(&zs[i], peak_mults[i], stakes[i]);
            }

            // ── Advantages: batch-baseline (mean) then normalize.
            let mean_r = rewards.iter().sum::<f64>() / n as f64;
            last_avg_reward = mean_r;
            let var = rewards.iter().map(|r| (r - mean_r).powi(2)).sum::<f64>() / n as f64;
            let std_r = var.sqrt().max(1e-6);
            let adv: Vec<f64> = rewards.iter().map(|r| (r - mean_r) / std_r).collect();

            // ── PPO update: K epochs of clipped surrogate ascent.
            for _ in 0..epochs {
                for i in 0..n {
                    let mean = self.mean(&states[i]);
                    let mut new_lp = 0.0;
                    for a in 0..self.action_dim {
                        new_lp += gaussian_logprob(zs[i][a], mean[a], self.std(a));
                    }
                    let ratio = (new_lp - old_lp[i]).exp();
                    let a_i = adv[i];

                    // Clipped surrogate: gradient flows only when unclipped branch wins.
                    let unclipped = ratio * a_i;
                    let clipped = ratio.clamp(1.0 - clip, 1.0 + clip) * a_i;
                    let use_grad = unclipped <= clipped; // min() selects unclipped
                    let coef = if use_grad { ratio * a_i } else { 0.0 };

                    // Ascend surrogate + entropy on each action dim.
                    for a in 0..self.action_dim {
                        let std = self.std(a);
                        let d_lp_d_mean = (zs[i][a] - mean[a]) / (std * std);
                        let d_lp_d_logstd = (zs[i][a] - mean[a]).powi(2) / (std * std) - 1.0;

                        let g_mean = coef * d_lp_d_mean;
                        // Entropy of a Gaussian increases with log_std → encourage exploration.
                        // Scaled by 1/n so the per-batch entropy push stays bounded rather
                        // than accumulating across every sample update (which would inflate
                        // std to its ceiling and prevent convergence).
                        let g_logstd = coef * d_lp_d_logstd + entropy_coef / n as f64;

                        // mean = W·s + b
                        let base = a * self.state_dim;
                        for j in 0..self.state_dim {
                            self.w[base + j] += lr * g_mean * states[i].get(j).copied().unwrap_or(0.0);
                        }
                        self.b[a] += lr * g_mean;
                        self.log_std[a] =
                            (self.log_std[a] + lr * g_logstd).clamp(LOG_STD_MIN, LOG_STD_MAX);
                    }
                }
            }
        }
        (iters, last_avg_reward)
    }

    /// Replays one trade's PnL under the squashed action. Mirrors the TypeScript
    /// `simulateSamplePnl`: a 50/50 split across two take-profit rungs with a
    /// trailing-stop (or stop-loss) exit on the remainder.
    fn reward(&self, z: &[f64], peak_mult: f64, stake: f64) -> f64 {
        let sl = self.squash(0, z[0]);
        let trailing = self.squash(1, z[1]);
        let tp0 = self.squash(2, z[2]);
        let mut tp1 = self.squash(3, z[3]);
        if tp1 <= tp0 {
            tp1 = tp0 + 0.1;
        }
        sim_trade_pnl(peak_mult, stake, sl, trailing, tp0.max(1.0 + 1e-6), tp1)
            .max(-stake) // bound reward magnitude
    }

    pub fn serialize(&self) -> Vec<f64> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.w);
        out.extend_from_slice(&self.b);
        out.extend_from_slice(&self.log_std);
        out
    }

    pub fn deserialize(&mut self, flat: &[f64]) -> bool {
        let expected = self.w.len() + self.b.len() + self.log_std.len();
        if flat.len() != expected {
            return false;
        }
        let mut idx = 0;
        for v in self.w.iter_mut() {
            *v = flat[idx];
            idx += 1;
        }
        for v in self.b.iter_mut() {
            *v = flat[idx];
            idx += 1;
        }
        for v in self.log_std.iter_mut() {
            *v = flat[idx];
            idx += 1;
        }
        true
    }
}

#[inline]
fn gaussian_logprob(z: f64, mean: f64, std: f64) -> f64 {
    let d = (z - mean) / std;
    -0.5 * d * d - std.ln() - 0.5 * LOG_2PI
}

/// Peak-multiple PnL replay. `peak_mult = highest/entry`; `stake` is the notional.
fn sim_trade_pnl(peak_mult: f64, stake: f64, sl: f64, trailing: f64, tp0: f64, tp1: f64) -> f64 {
    if peak_mult <= 1.0 {
        return -sl * stake;
    }
    let mut pnl = 0.0;
    let mut remaining = 1.0;
    let split = 0.5;
    if peak_mult >= tp0 {
        pnl += stake * remaining * split * (tp0 - 1.0);
        remaining -= split;
    }
    if peak_mult >= tp1 {
        pnl += stake * remaining * (tp1 - 1.0);
        remaining = 0.0;
    }
    if remaining > 0.0 {
        let trailing_exit = peak_mult * (1.0 - trailing);
        let exit_mult = (1.0 - sl).max(trailing_exit);
        pnl += stake * remaining * (exit_mult - 1.0);
    }
    pnl
}
