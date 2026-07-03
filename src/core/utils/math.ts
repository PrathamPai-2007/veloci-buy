export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value < 0.01 && value > 0) return `$${value.toFixed(6)}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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

export function ratioToPercentString(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

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

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function computeStandardDeviation(values: number[]): number {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
  return Math.sqrt(variance);
}

export function computeSpread(bid: number, ask: number): number {
  if (!(bid > 0) || !(ask > 0)) return 0;
  return Math.abs(ask - bid) / ((ask + bid) / 2);
}
