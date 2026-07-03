/**
 * Shared gating helpers for the scoring models: the block-rate circuit breaker
 * and the confidence→TP-profile mapping. Extracted so a single ScoringModel and
 * the EnsembleModel apply identical gating semantics.
 */

const CIRCUIT_BREAKER_WINDOW = 100;
const CIRCUIT_BREAKER_MAX_BLOCK_RATE = 0.4;
const CIRCUIT_BREAKER_RESET_RATE = 0.2;

/**
 * Rolling-window circuit breaker. If the model blocks too large a fraction of
 * recent candidates it trips (gating paused) until the rate normalizes, with
 * hysteresis between the trip and reset thresholds to avoid flapping.
 */
export class CircuitBreaker {
  private window: boolean[] = [];
  private active = false;

  record(blocked: boolean): void {
    this.window.push(blocked);
    if (this.window.length > CIRCUIT_BREAKER_WINDOW) this.window.shift();

    if (this.window.length < CIRCUIT_BREAKER_WINDOW) {
      this.active = false;
      return;
    }
    const blockRate = this.window.filter(Boolean).length / this.window.length;
    if (blockRate > CIRCUIT_BREAKER_MAX_BLOCK_RATE) {
      this.active = true;
    } else if (blockRate < CIRCUIT_BREAKER_RESET_RATE) {
      this.active = false;
    }
    // Between thresholds: keep current state (hysteresis).
  }

  isActive(): boolean {
    return this.active;
  }

  reset(): void {
    this.window = [];
    this.active = false;
  }
}

/** Maps a confidence and gate threshold to a take-profit aggressiveness profile. */
export function confidenceToTpProfile(confidence: number, threshold: number): 'high' | 'standard' {
  if (confidence >= threshold + 0.25) return 'high';
  return 'standard';
}
