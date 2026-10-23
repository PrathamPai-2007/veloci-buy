export class BaseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class RateLimitError extends BaseError {
  constructor(
    message: string,
    public readonly retryAfterMs: number = 1000,
    cause?: unknown
  ) {
    super(message, 'RATE_LIMIT_EXCEEDED', cause);
  }
}

export class RpcError extends BaseError {
  constructor(
    message: string,
    public readonly endpointIndex?: number,
    cause?: unknown
  ) {
    super(message, 'RPC_ERROR', cause);
  }
}

export class AuditTimeoutError extends BaseError {
  constructor(
    message: string,
    public readonly serviceName: string,
    cause?: unknown
  ) {
    super(message, 'AUDIT_TIMEOUT', cause);
  }
}

export class InsufficientLiquidityError extends BaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'INSUFFICIENT_LIQUIDITY', cause);
  }
}

export class SimulationError extends BaseError {
  constructor(message: string, cause?: unknown) {
    super(message, 'SIMULATION_FAILED', cause);
  }
}
