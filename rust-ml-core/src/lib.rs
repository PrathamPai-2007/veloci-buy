#![deny(clippy::all)]

//! Native ML core for veloci-buy, exposed to Node.js via napi-rs.
//!
//! Hosts a single-layer LSTM (see [`lstm`]) used to score token candidates from
//! a rolling price/feature sequence plus a static entry-feature snapshot. All
//! heavy math (forward pass + BPTT training) runs here; the TypeScript side only
//! marshals data and persists serialized weights.

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod lstm;
mod ppo;
mod rng;

use lstm::Lstm;
use ppo::PpoPolicy;

/// Liveness check used by the TS wrapper to confirm the addon loaded.
#[napi]
pub fn ping() -> String {
    "pong".to_string()
}

/// Metrics returned from a training run.
#[napi(object)]
pub struct TrainResult {
    pub epochs_ran: u32,
    pub final_loss: f64,
    pub samples: u32,
}

/// A trainable LSTM scoring network bound to JavaScript.
#[napi]
pub struct LstmNetwork {
    inner: Lstm,
}

#[napi]
impl LstmNetwork {
    /// Creates a fresh network.
    ///
    /// * `input_size`  — per-timestep feature dimension of the sequence.
    /// * `hidden_size` — LSTM cell width.
    /// * `static_size` — dimension of the static entry-feature snapshot.
    /// * `seed`        — RNG seed for deterministic weight initialisation.
    #[napi(constructor)]
    pub fn new(input_size: u32, hidden_size: u32, static_size: u32, seed: f64) -> Self {
        LstmNetwork {
            inner: Lstm::new(
                input_size as usize,
                hidden_size as usize,
                static_size as usize,
                seed as u64,
            ),
        }
    }

    #[napi(getter)]
    pub fn input_size(&self) -> u32 {
        self.inner.input_size as u32
    }

    #[napi(getter)]
    pub fn hidden_size(&self) -> u32 {
        self.inner.hidden_size as u32
    }

    #[napi(getter)]
    pub fn static_size(&self) -> u32 {
        self.inner.static_size as u32
    }

    /// Inference via nested Vecs (legacy). Returns confidence in `[0, 1]`.
    #[napi]
    pub fn predict(&self, sequence: Vec<Vec<f64>>, static_features: Vec<f64>) -> f64 {
        self.inner.predict(&sequence, &static_features)
    }

    /// Inference from a flat Float64Array. Avoids building a nested JS array on the
    /// caller side; the slice is zero-copy into Rust, then chunked into per-step Vecs
    /// for the existing predict API. `seq_flat` must have length `seq_len * input_size`.
    #[napi]
    pub fn predict_typed(
        &self,
        seq_flat: &[f64],
        seq_len: u32,
        static_features: &[f64],
    ) -> f64 {
        let input_size = self.inner.input_size;
        let seq_vecs: Vec<Vec<f64>> = (0..seq_len as usize)
            .map(|i| {
                let start = i * input_size;
                seq_flat[start..start + input_size].to_vec()
            })
            .collect();
        self.inner.predict(&seq_vecs, static_features)
    }

    /// Trains in place over the full dataset using nested Vecs (legacy).
    /// Each `sequences[k]` is a sequence of per-step vectors; `statics[k]` the matching
    /// static snapshot; `labels[k]` the binary outcome (0/1).
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn train(
        &self,
        sequences: Vec<Vec<Vec<f64>>>,
        statics: Vec<Vec<f64>>,
        labels: Vec<f64>,
        epochs: u32,
        lr: f64,
        batch_size: u32,
        pos_weight: f64,
        seed: f64,
    ) -> Result<AsyncTask<LstmTrainTask>> {
        let lstm = self.inner.clone();
        Ok(AsyncTask::new(LstmTrainTask {
            lstm,
            sequences,
            statics,
            labels,
            epochs,
            lr,
            batch_size,
            pos_weight,
            seed,
        }))
    }

    /// Flattens all weights for persistence.
    #[napi]
    pub fn serialize(&self) -> Vec<f64> {
        self.inner.serialize()
    }

    /// Restores weights produced by `serialize`. Returns false on shape mismatch.
    #[napi]
    pub fn deserialize(&mut self, flat: Vec<f64>) -> bool {
        self.inner.deserialize(&flat)
    }
}

/// Result of a PPO training run.
#[napi(object)]
pub struct PpoTrainResult {
    pub iters_ran: u32,
    pub final_avg_reward: f64,
    pub samples: u32,
}

/// Regime-conditioned PPO policy for continuous exit parameters, bound to JS.
#[napi]
pub struct RlExitPolicy {
    inner: PpoPolicy,
}

#[napi]
impl RlExitPolicy {
    /// `action_min`/`action_max` are the per-parameter bounds (same order the
    /// caller uses for predict/reward): [stopLoss, trailingStop, tp0, tp1].
    #[napi(constructor)]
    pub fn new(state_dim: u32, action_min: Vec<f64>, action_max: Vec<f64>, seed: f64) -> Self {
        RlExitPolicy {
            inner: PpoPolicy::new(state_dim as usize, action_min, action_max, seed as u64),
        }
    }

    #[napi(getter)]
    pub fn action_dim(&self) -> u32 {
        self.inner.action_dim as u32
    }

    /// Deterministic exit parameters for a regime state vector.
    #[napi]
    pub fn predict(&self, state: Vec<f64>) -> Vec<f64> {
        self.inner.predict(&state)
    }

    /// Trains over a batch of trades. `states[k]` is the regime vector for trade
    /// k; `peak_mults[k] = highestPrice/entryPrice`; `stakes[k]` the notional.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn train(
        &mut self,
        states: Vec<Vec<f64>>,
        peak_mults: Vec<f64>,
        stakes: Vec<f64>,
        iters: u32,
        epochs: u32,
        lr: f64,
        clip: f64,
        entropy_coef: f64,
        seed: f64,
    ) -> PpoTrainResult {
        let (iters_ran, final_avg_reward) = self.inner.train(
            &states,
            &peak_mults,
            &stakes,
            iters as usize,
            epochs as usize,
            lr,
            clip,
            entropy_coef,
            seed as u64,
        );
        PpoTrainResult {
            iters_ran: iters_ran as u32,
            final_avg_reward,
            samples: states.len() as u32,
        }
    }

    #[napi]
    pub fn serialize(&self) -> Vec<f64> {
        self.inner.serialize()
    }

    #[napi]
    pub fn deserialize(&mut self, flat: Vec<f64>) -> bool {
        self.inner.deserialize(&flat)
    }
}

pub struct LstmTrainTask {
    lstm: Lstm,
    sequences: Vec<Vec<Vec<f64>>>,
    statics: Vec<Vec<f64>>,
    labels: Vec<f64>,
    epochs: u32,
    lr: f64,
    batch_size: u32,
    pos_weight: f64,
    seed: f64,
}

#[napi]
impl Task for LstmTrainTask {
    type Output = (Lstm, TrainResult);
    type JsValue = TrainAsyncTaskResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let (epochs_ran, final_loss) = self.lstm.train(
            &self.sequences,
            &self.statics,
            &self.labels,
            self.epochs as usize,
            self.lr,
            self.batch_size as usize,
            self.pos_weight,
            self.seed as u64,
        );
        let samples = self.sequences.len() as u32;
        Ok((
            self.lstm.clone(),
            TrainResult {
                epochs_ran: epochs_ran as u32,
                final_loss,
                samples,
            },
        ))
    }

    fn resolve(&mut self, _env: Env, (trained_lstm, result): Self::Output) -> Result<Self::JsValue> {
        let weights = trained_lstm.serialize();
        Ok(TrainAsyncTaskResult {
            weights,
            epochs_ran: result.epochs_ran,
            final_loss: result.final_loss,
            samples: result.samples,
        })
    }
}

#[napi(object)]
pub struct TrainAsyncTaskResult {
    pub weights: Vec<f64>,
    pub epochs_ran: u32,
    pub final_loss: f64,
    pub samples: u32,
}
