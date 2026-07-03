//! A single-layer LSTM with a dense sigmoid head, trained with
//! backpropagation-through-time (BPTT) and per-element gradient clipping.
//!
//! ## Architecture
//!
//! For each timestep `t` the cell consumes the per-step input `x_t` (size
//! `input_size`) together with the previous hidden/cell state:
//!
//! ```text
//!   z   = [x_t ; h_{t-1}]                      (size input_size + hidden_size)
//!   f_t = σ(Wf·z + bf)   i_t = σ(Wi·z + bi)
//!   g_t = tanh(Wg·z + bg) o_t = σ(Wo·z + bo)
//!   c_t = f_t ⊙ c_{t-1} + i_t ⊙ g_t
//!   h_t = o_t ⊙ tanh(c_t)
//! ```
//!
//! The final hidden state `h_T` is concatenated with the *static* entry-feature
//! vector (the original 18-dim snapshot) and pushed through a dense layer to a
//! single logit, then a sigmoid → confidence in `[0, 1]`.
//!
//! Static features are model *inputs*, not parameters, so no gradient flows into
//! them — only into the LSTM gates and the dense head.

use crate::rng::Rng;

const LABEL_SMOOTHING: f64 = 0.05;
const GRAD_CLIP: f64 = 5.0;
const EPS: f64 = 1e-7;

#[inline]
fn sigmoid(x: f64) -> f64 {
    if x >= 0.0 {
        1.0 / (1.0 + (-x).exp())
    } else {
        let e = x.exp();
        e / (1.0 + e)
    }
}

#[inline]
fn clip(g: f64) -> f64 {
    g.clamp(-GRAD_CLIP, GRAD_CLIP)
}

#[inline]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Trainable parameters. Gate matrices are row-major `[hidden_size, gate_in]`
/// where `gate_in = input_size + hidden_size`.
#[derive(Clone)]
pub struct Lstm {
    pub input_size: usize,
    pub hidden_size: usize,
    pub static_size: usize,
    gate_in: usize,

    // Gate weights (forget, input, candidate, output) + biases.
    wf: Vec<f64>,
    wi: Vec<f64>,
    wg: Vec<f64>,
    wo: Vec<f64>,
    bf: Vec<f64>,
    bi: Vec<f64>,
    bg: Vec<f64>,
    bo: Vec<f64>,

    // Dense head over [h_T ; static] -> 1 logit.
    wd: Vec<f64>, // len = hidden_size + static_size
    bd: f64,
}

/// Per-timestep activations cached on the forward pass for use in BPTT.
// Flattened per-timestep activations to avoid per-step Vec allocations.
struct Trace {
    // Flat buffers where each step occupies `hidden_size` entries.
    // Index: step * hidden_size + h
    z: Vec<f64>,          // concatenated [x_t ; h_{t-1}] per step (size steps * gate_in)
    f: Vec<f64>,          // forget gate activations (steps * hidden)
    i: Vec<f64>,          // input gate activations
    g: Vec<f64>,          // candidate gate activations
    o: Vec<f64>,          // output gate activations
    c: Vec<f64>,          // cell state c_t (steps * hidden)
    c_prev: Vec<f64>,     // cell state c_{t-1} (steps * hidden)
    tanh_c: Vec<f64>,     // tanh(c_t) (steps * hidden)
    steps: usize,         // number of timesteps processed
    h_final: Vec<f64>,    // final hidden state h_T (len hidden)
    combined: Vec<f64>,   // concatenated [h_T ; static] (len hidden+static)
    y_hat: f64,           // final prediction
}

impl Lstm {
    pub fn new(input_size: usize, hidden_size: usize, static_size: usize, seed: u64) -> Self {
        let gate_in = input_size + hidden_size;
        let mut rng = Rng::new(seed);

        // Xavier/Glorot uniform for the gate matrices.
        let gate_limit = (6.0 / (gate_in + hidden_size) as f64).sqrt();
        let mut init_gate = || -> Vec<f64> {
            (0..hidden_size * gate_in)
                .map(|_| rng.uniform(gate_limit))
                .collect()
        };
        let wf = init_gate();
        let wi = init_gate();
        let wg = init_gate();
        let wo = init_gate();

        let dense_in = hidden_size + static_size;
        let dense_limit = (6.0 / (dense_in + 1) as f64).sqrt();
        let wd = (0..dense_in).map(|_| rng.uniform(dense_limit)).collect();

        Lstm {
            input_size,
            hidden_size,
            static_size,
            gate_in,
            wf,
            wi,
            wg,
            wo,
            // Forget-gate bias initialised to 1.0 — a standard trick that helps
            // gradients flow across long sequences early in training.
            bf: vec![1.0; hidden_size],
            bi: vec![0.0; hidden_size],
            bg: vec![0.0; hidden_size],
            bo: vec![0.0; hidden_size],
            wd,
            bd: 0.0,
        }
    }

    /// Matrix-vector for one gate row block: out[h] = b[h] + Σ_k W[h,k]·z[k].
    fn gate_pre(&self, w: &[f64], b: &[f64], z: &[f64]) -> Vec<f64> {
        let mut out = vec![0.0; self.hidden_size];
        for h in 0..self.hidden_size {
            let mut acc = b[h];
            let base = h * self.gate_in;
            for k in 0..self.gate_in {
                acc += w[base + k] * z[k];
            }
            out[h] = acc;
        }
        out
    }

    /// Forward pass over a single sequence. `sequence[t]` has length
    /// `input_size`; `static_features` has length `static_size`.
    fn forward_trace(&self, sequence: &[Vec<f64>], static_features: &[f64]) -> Trace {
        let steps = sequence.len();
        let mut h_prev = vec![0.0; self.hidden_size];
        let mut c_prev = vec![0.0; self.hidden_size];

        // Pre‑allocate flat buffers
        let mut tr = Trace {
            z: Vec::with_capacity(steps * self.gate_in),
            f: Vec::with_capacity(steps * self.hidden_size),
            i: Vec::with_capacity(steps * self.hidden_size),
            g: Vec::with_capacity(steps * self.hidden_size),
            o: Vec::with_capacity(steps * self.hidden_size),
            c: Vec::with_capacity(steps * self.hidden_size),
            c_prev: Vec::with_capacity(steps * self.hidden_size),
            tanh_c: Vec::with_capacity(steps * self.hidden_size),
            steps,
            h_final: vec![0.0; self.hidden_size],
            combined: Vec::new(),
            y_hat: 0.0,
        };

        for x in sequence.iter() {
            // Build z = [x ; h_prev]
            let mut z = Vec::with_capacity(self.gate_in);
            for k in 0..self.input_size {
                z.push(x.get(k).copied().unwrap_or(0.0));
            }
            z.extend_from_slice(&h_prev);

            // Compute gate activations
            let f: Vec<f64> = self.gate_pre(&self.wf, &self.bf, &z).iter().map(|v| sigmoid(*v)).collect();
            let i: Vec<f64> = self.gate_pre(&self.wi, &self.bi, &z).iter().map(|v| sigmoid(*v)).collect();
            let g: Vec<f64> = self.gate_pre(&self.wg, &self.bg, &z).iter().map(|v| v.tanh()).collect();
            let o: Vec<f64> = self.gate_pre(&self.wo, &self.bo, &z).iter().map(|v| sigmoid(*v)).collect();

            let mut c = vec![0.0; self.hidden_size];
            let mut tanh_c = vec![0.0; self.hidden_size];
            let mut h = vec![0.0; self.hidden_size];
            for n in 0..self.hidden_size {
                c[n] = f[n] * c_prev[n] + i[n] * g[n];
                tanh_c[n] = c[n].tanh();
                h[n] = o[n] * tanh_c[n];
            }

            // Append flat data for this timestep
            tr.z.extend_from_slice(&z);
            tr.f.extend_from_slice(&f);
            tr.i.extend_from_slice(&i);
            tr.g.extend_from_slice(&g);
            tr.o.extend_from_slice(&o);
            tr.c_prev.extend_from_slice(&c_prev);
            tr.c.extend_from_slice(&c);
            tr.tanh_c.extend_from_slice(&tanh_c);

            h_prev = h;
            c_prev = c;
        }

        tr.h_final = h_prev.clone();

        // Dense head over [h_T ; static]
        let mut combined = Vec::with_capacity(self.hidden_size + self.static_size);
        combined.extend_from_slice(&h_prev);
        for s in 0..self.static_size {
            combined.push(static_features.get(s).copied().unwrap_or(0.0));
        }
        tr.y_hat = sigmoid(self.bd + dot(&self.wd, &combined));
        tr.combined = combined;
        tr
    }

    /// Inference: returns confidence in [0, 1].
    pub fn predict(&self, sequence: &[Vec<f64>], static_features: &[f64]) -> f64 {
        if sequence.is_empty() {
            // No temporal context — fall back to the dense head on a zero hidden
            // state so the static features still contribute.
            let mut combined = vec![0.0; self.hidden_size];
            for s in 0..self.static_size {
                combined.push(static_features.get(s).copied().unwrap_or(0.0));
            }
            return sigmoid(self.bd + dot(&self.wd, &combined));
        }
        self.forward_trace(sequence, static_features).y_hat
    }

    /// Accumulates gradients for one (sequence, static, label) example into the
    /// provided gradient accumulator and returns the BCE loss for the example.
    #[allow(clippy::too_many_arguments)]
    fn backward(&self, tr: &Trace, label: f64, grads: &mut Grads) -> f64 {
        let steps = tr.steps;
        let y = label * (1.0 - LABEL_SMOOTHING) + 0.5 * LABEL_SMOOTHING;
        let p = tr.y_hat.clamp(EPS, 1.0 - EPS);
        let loss = -(y * p.ln() + (1.0 - y) * (1.0 - p).ln());

        // Dense head gradient
        let dlogit = tr.y_hat - y;
        for k in 0..tr.combined.len() {
            grads.wd[k] += dlogit * tr.combined[k];
        }
        grads.bd += dlogit;

        // Gradient into h_T
        let mut dh: Vec<f64> = self.wd[..self.hidden_size].iter().map(|w| dlogit * w).collect();
        let mut dc_next = vec![0.0; self.hidden_size];

        for step_rev in (0..steps).rev() {
            let base_z = step_rev * self.gate_in;
            let base_hidden = step_rev * self.hidden_size;

            let z = &tr.z[base_z..base_z + self.gate_in];
            let f = &tr.f[base_hidden..base_hidden + self.hidden_size];
            let i = &tr.i[base_hidden..base_hidden + self.hidden_size];
            let g = &tr.g[base_hidden..base_hidden + self.hidden_size];
            let o = &tr.o[base_hidden..base_hidden + self.hidden_size];
            let tanh_c = &tr.tanh_c[base_hidden..base_hidden + self.hidden_size];
            let c_prev = &tr.c_prev[base_hidden..base_hidden + self.hidden_size];

            let mut df_raw = vec![0.0; self.hidden_size];
            let mut di_raw = vec![0.0; self.hidden_size];
            let mut dg_raw = vec![0.0; self.hidden_size];
            let mut do_raw = vec![0.0; self.hidden_size];

            for n in 0..self.hidden_size {
                let do_n = dh[n] * tanh_c[n];
                let mut dc = dh[n] * o[n] * (1.0 - tanh_c[n] * tanh_c[n]) + dc_next[n];

                let df_n = dc * c_prev[n];
                let di_n = dc * g[n];
                let dg_n = dc * i[n];

                // Gate pre-activation gradients (apply activation derivatives).
                do_raw[n] = do_n * o[n] * (1.0 - o[n]);
                df_raw[n] = df_n * f[n] * (1.0 - f[n]);
                di_raw[n] = di_n * i[n] * (1.0 - i[n]);
                dg_raw[n] = dg_n * (1.0 - g[n] * g[n]);

                // Carry cell gradient to previous step.
                dc *= f[n];
                dc_next[n] = dc;
            }

            // Weight/bias grads and dz accumulation for each gate.
            let mut dz = vec![0.0; self.gate_in];
            accumulate_gate(&mut grads.wf, &mut grads.bf, &df_raw, z, &self.wf, &mut dz, self.gate_in);
            accumulate_gate(&mut grads.wi, &mut grads.bi, &di_raw, z, &self.wi, &mut dz, self.gate_in);
            accumulate_gate(&mut grads.wg, &mut grads.bg, &dg_raw, z, &self.wg, &mut dz, self.gate_in);
            accumulate_gate(&mut grads.wo, &mut grads.bo, &do_raw, z, &self.wo, &mut dz, self.gate_in);

            // dz's tail (after input_size) is the gradient w.r.t. h_{t-1}.
            for n in 0..self.hidden_size {
                dh[n] = dz[self.input_size + n];
            }
        }

        loss
    }

    /// Applies an averaged, clipped SGD step from accumulated gradients.
    fn apply_grads(&mut self, grads: &Grads, lr: f64, n: f64) {
        let scale = lr / n.max(1.0);
        step_vec(&mut self.wf, &grads.wf, scale);
        step_vec(&mut self.wi, &grads.wi, scale);
        step_vec(&mut self.wg, &grads.wg, scale);
        step_vec(&mut self.wo, &grads.wo, scale);
        step_vec(&mut self.bf, &grads.bf, scale);
        step_vec(&mut self.bi, &grads.bi, scale);
        step_vec(&mut self.bg, &grads.bg, scale);
        step_vec(&mut self.bo, &grads.bo, scale);
        step_vec(&mut self.wd, &grads.wd, scale);
        self.bd -= scale * clip(grads.bd);
    }

    /// Full training run. Returns (epochs_ran, final_avg_loss).
    #[allow(clippy::too_many_arguments)]
    pub fn train(
        &mut self,
        sequences: &[Vec<Vec<f64>>],
        statics: &[Vec<f64>],
        labels: &[f64],
        epochs: usize,
        lr: f64,
        batch_size: usize,
        pos_weight: f64,
        seed: u64,
    ) -> (usize, f64) {
        let n = sequences.len();
        if n == 0 {
            return (0, 0.0);
        }
        let mut rng = Rng::new(seed);
        let mut last_loss = 0.0;
        let mut epochs_ran = 0;

        for _ in 0..epochs {
            epochs_ran += 1;
            let order = rng.shuffle_indices(n);
            let mut epoch_loss = 0.0;

            for chunk in order.chunks(batch_size.max(1)) {
                let mut grads = Grads::zeros(self);
                let mut weight_sum = 0.0;
                for &idx in chunk {
                    let tr = self.forward_trace(&sequences[idx], &statics[idx]);
                    let w = if labels[idx] >= 0.5 { pos_weight } else { 1.0 };
                    // Scale this example's gradient by its class weight by
                    // running backward `w`-times worth via post-scaling.
                    let loss = self.backward_weighted(&tr, labels[idx], &mut grads, w);
                    epoch_loss += loss;
                    weight_sum += w;
                }
                self.apply_grads(&grads, lr, weight_sum);
            }

            last_loss = epoch_loss / n as f64;
        }
        (epochs_ran, last_loss)
    }

    /// backward() with a per-example weight folded into the accumulated grads.
    fn backward_weighted(&self, tr: &Trace, label: f64, grads: &mut Grads, w: f64) -> f64 {
        if (w - 1.0).abs() < 1e-12 {
            return self.backward(tr, label, grads);
        }
        let mut tmp = Grads::zeros(self);
        let loss = self.backward(tr, label, &mut tmp);
        grads.add_scaled(&tmp, w);
        loss
    }

    /// Flattens all parameters into a single Vec for persistence.
    pub fn serialize(&self) -> Vec<f64> {
        let mut out = Vec::new();
        for v in [&self.wf, &self.wi, &self.wg, &self.wo, &self.bf, &self.bi, &self.bg, &self.bo, &self.wd] {
            out.extend_from_slice(v);
        }
        out.push(self.bd);
        out
    }

    /// Loads parameters from a flat Vec produced by `serialize`. Returns false
    /// on a length mismatch (e.g. architecture changed).
    pub fn deserialize(&mut self, flat: &[f64]) -> bool {
        if flat.len() != self.serialized_len() {
            return false;
        }
        let mut idx = 0;
        let mut take = |dst: &mut Vec<f64>| {
            for v in dst.iter_mut() {
                *v = flat[idx];
                idx += 1;
            }
        };
        take(&mut self.wf);
        take(&mut self.wi);
        take(&mut self.wg);
        take(&mut self.wo);
        take(&mut self.bf);
        take(&mut self.bi);
        take(&mut self.bg);
        take(&mut self.bo);
        take(&mut self.wd);
        self.bd = flat[idx];
        true
    }

    fn serialized_len(&self) -> usize {
        4 * self.wf.len() + 4 * self.hidden_size + self.wd.len() + 1
    }
}

/// Gradient accumulator with the same shape as `Lstm` parameters.
struct Grads {
    wf: Vec<f64>,
    wi: Vec<f64>,
    wg: Vec<f64>,
    wo: Vec<f64>,
    bf: Vec<f64>,
    bi: Vec<f64>,
    bg: Vec<f64>,
    bo: Vec<f64>,
    wd: Vec<f64>,
    bd: f64,
}

impl Grads {
    fn zeros(m: &Lstm) -> Self {
        Grads {
            wf: vec![0.0; m.wf.len()],
            wi: vec![0.0; m.wi.len()],
            wg: vec![0.0; m.wg.len()],
            wo: vec![0.0; m.wo.len()],
            bf: vec![0.0; m.hidden_size],
            bi: vec![0.0; m.hidden_size],
            bg: vec![0.0; m.hidden_size],
            bo: vec![0.0; m.hidden_size],
            wd: vec![0.0; m.wd.len()],
            bd: 0.0,
        }
    }

    fn add_scaled(&mut self, other: &Grads, w: f64) {
        for (a, b) in self.wf.iter_mut().zip(&other.wf) { *a += b * w; }
        for (a, b) in self.wi.iter_mut().zip(&other.wi) { *a += b * w; }
        for (a, b) in self.wg.iter_mut().zip(&other.wg) { *a += b * w; }
        for (a, b) in self.wo.iter_mut().zip(&other.wo) { *a += b * w; }
        for (a, b) in self.bf.iter_mut().zip(&other.bf) { *a += b * w; }
        for (a, b) in self.bi.iter_mut().zip(&other.bi) { *a += b * w; }
        for (a, b) in self.bg.iter_mut().zip(&other.bg) { *a += b * w; }
        for (a, b) in self.bo.iter_mut().zip(&other.bo) { *a += b * w; }
        for (a, b) in self.wd.iter_mut().zip(&other.wd) { *a += b * w; }
        self.bd += other.bd * w;
    }
}

/// Accumulates dW (outer product of d_raw and z), db, and propagates dz += Wᵀ·d_raw.
fn accumulate_gate(
    dw: &mut [f64],
    db: &mut [f64],
    d_raw: &[f64],
    z: &[f64],
    w: &[f64],
    dz: &mut [f64],
    gate_in: usize,
) {
    for (h, &dr) in d_raw.iter().enumerate() {
        db[h] += dr;
        let base = h * gate_in;
        for k in 0..gate_in {
            dw[base + k] += dr * z[k];
            dz[k] += w[base + k] * dr;
        }
    }
}

/// param -= scale * clip(grad), element-wise.
fn step_vec(param: &mut [f64], grad: &[f64], scale: f64) {
    for (p, &g) in param.iter_mut().zip(grad) {
        *p -= scale * clip(g);
    }
}
