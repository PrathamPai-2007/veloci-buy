/**
 * Formats a numeric USD price or value into a standardized human-readable string.
 * @param value - Numeric USD value to format.
 * @returns Formatted USD string (e.g. "$1,234.56" or "$0.000123").
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value < 0.01 && value > 0) return `$${value.toFixed(6)}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Converts a raw atomic token balance (BigInt) into a human-readable decimal string.
 * @param amount - Raw atomic token quantity.
 * @param decimals - Token decimal precision.
 * @param precision - Maximum fractional decimal places to retain.
 * @returns Decimal representation string.
 */
export function atomicToDecimalString(
  amount: bigint | number | string,
  decimals: number,
  precision: number = Math.min(decimals, 6)
): string {
  const raw = BigInt(amount);
  const negative = raw < 0n;
  const unsigned = negative ? raw * -1n : raw;
  const base = 10n ** BigInt(decimals);
  const whole = unsigned / base;
  const fraction = unsigned % base;
  const fractionString = fraction
    .toString()
    .padStart(decimals, '0')
    .slice(0, precision)
    .replace(/0+$/, '');
  const text = fractionString ? `${whole}.${fractionString}` : whole.toString();
  return negative ? `-${text}` : text;
}

/**
 * Converts a decimal token amount into raw atomic units string.
 * @param value - Human-readable decimal amount.
 * @param decimals - Token decimal precision.
 * @returns Atomic units string representation.
 */
export function decimalToAtomic(value: string | number, decimals: number): string {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }

  const [wholePart, fractionPart = ''] = normalized.split('.');
  if (!wholePart) return '0';
  const paddedFraction = `${fractionPart}${'0'.repeat(decimals)}`.slice(0, decimals);
  return `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, '') || '0';
}

/**
 * Converts a fractional ratio [0, 1] into a formatted percentage string.
 * @param value - Ratio value.
 * @returns Percentage string (e.g. "12.34%").
 */
export function ratioToPercentString(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Computes a floating point ratio from two BigInt numbers safely using a scaling factor.
 * @param numerator - Numerator BigInt.
 * @param denominator - Denominator BigInt.
 * @param scale - Precision scaling factor (default: 1,000,000).
 * @returns Scaled floating point ratio.
 */
export function bigintRatioToNumber(
  numerator: bigint,
  denominator: bigint,
  scale: bigint = 1_000_000n
): number {
  if (denominator <= 0n) {
    return 0;
  }
  return Number((numerator * scale) / denominator) / Number(scale);
}

/**
 * Clamps a numeric value between a minimum and maximum bound.
 * @param value - Input value.
 * @param minimum - Lower bound.
 * @param maximum - Upper bound.
 * @returns Clamped numeric value.
 */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Computes the sample standard deviation for an array of numbers.
 * @param values - Numerical sample values.
 * @returns Standard deviation or 0 if fewer than 2 elements.
 */
export function computeStandardDeviation(values: number[]): number {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * Computes relative spread between bid and ask prices.
 * @param bid - Highest bid price.
 * @param ask - Lowest ask price.
 * @returns Relative percentage spread ratio.
 */
export function computeSpread(bid: number, ask: number): number {
  if (!(bid > 0) || !(ask > 0)) return 0;
  return Math.abs(ask - bid) / ((ask + bid) / 2);
}
