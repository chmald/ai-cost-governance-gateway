const MICRODOLLARS = 1_000_000n;

export function parseUsd(value: string): number {
  const clean = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(clean)) {
    throw new Error("Enter a non-negative USD amount with no more than 6 decimal places (for example, 25.50).");
  }
  const [whole, fraction = ""] = clean.split(".");
  const micros = BigInt(whole) * MICRODOLLARS + BigInt(fraction.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("This amount exceeds the supported microdollar range.");
  }
  return Number(micros);
}

export function usdInput(micros: number): string {
  if (!Number.isSafeInteger(micros)) throw new Error("Invalid microdollar amount.");
  const magnitude = BigInt(Math.abs(micros));
  const fraction = (magnitude % MICRODOLLARS).toString().padStart(6, "0").replace(/0+$/, "");
  return `${micros < 0 ? "-" : ""}${magnitude / MICRODOLLARS}${fraction ? `.${fraction}` : ""}`;
}

export function formatUsd(micros: number): string {
  if (!Number.isSafeInteger(micros)) return "Unavailable";
  const magnitude = BigInt(Math.abs(micros));
  const whole = (magnitude / MICRODOLLARS).toLocaleString("en-US");
  const fraction = (magnitude % MICRODOLLARS).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${micros < 0 ? "−" : ""}$${whole}.${fraction}`;
}

export function utcMonth(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return `${period} · UTC month`;
  const date = new Date(`${period}-01T00:00:00Z`);
  return `${date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} · UTC month`;
}

export function utcTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unavailable"
    : `${date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

export function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label} must be a positive whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive whole number.`);
  return parsed;
}
