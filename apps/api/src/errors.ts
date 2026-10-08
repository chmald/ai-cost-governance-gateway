export class GatewayError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new GatewayError(status, code, message);
}

export function operationalError(event: string, code: string, correlationId?: string): void {
  console.error(JSON.stringify({ level: "error", event, code, ...(correlationId ? { correlationId } : {}) }));
}

export function safeNumber(value: bigint | string | number): number {
  const n = BigInt(value);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(503, "UNSAFE_AMOUNT", "An amount exceeds supported safe-integer limits.");
  }
  return Number(n);
}

export function ceilCharge(tokens: number, rate: number): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(rate) || rate <= 0) {
    fail(400, "INVALID_AMOUNT", "Tokens and positive prices must be safe integers.");
  }
  return (BigInt(tokens) * BigInt(rate) + 999_999n) / 1_000_000n;
}
