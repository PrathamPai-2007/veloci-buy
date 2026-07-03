//! Deterministic pseudo-random number generator.
//!
//! Training and weight initialization must be reproducible so that the
//! determinism integration tests (and any cross-run comparisons) hold. We use
//! splitmix64 — tiny, fast, and fully deterministic from a single u64 seed.

pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        // Avoid a zero state degenerating the stream.
        Rng {
            state: seed ^ 0x9E37_79B9_7F4A_7C15,
        }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform f64 in [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        // Take the top 53 bits for a full-precision mantissa.
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform f64 in [-limit, limit) — used for Xavier/Glorot init.
    pub fn uniform(&mut self, limit: f64) -> f64 {
        (self.next_f64() * 2.0 - 1.0) * limit
    }

    /// Standard normal sample N(0, 1) via the Box–Muller transform.
    pub fn normal(&mut self) -> f64 {
        let u1 = self.next_f64().max(1e-12);
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }

    /// Returns a Fisher–Yates shuffle order of `0..n`.
    pub fn shuffle_indices(&mut self, n: usize) -> Vec<usize> {
        let mut idx: Vec<usize> = (0..n).collect();
        for i in (1..n).rev() {
            let j = (self.next_u64() % (i as u64 + 1)) as usize;
            idx.swap(i, j);
        }
        idx
    }
}
