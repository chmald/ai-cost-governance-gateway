import { describe, expect, it } from "vitest";
import { formatUsd, parseUsd, positiveInteger, usdInput, utcMonth } from "./money";

describe("exact USD microdollars", () => {
  it.each([
    ["0", 0], ["0.000001", 1], ["0.10", 100_000], ["12.345678", 12_345_678],
    [" 25.50 ", 25_500_000], ["9007199254.740991", Number.MAX_SAFE_INTEGER],
  ])("converts %s without floating-point arithmetic", (input, expected) => {
    expect(parseUsd(input)).toBe(expected);
    expect(parseUsd(usdInput(expected))).toBe(expected);
  });
  it.each(["-1", "1e3", "1,000", "$2", "", ".5", "NaN", "Infinity", "0.0000001", "9007199254.740992", "1."])(
    "rejects invalid or unsafe input %s rather than rounding", (value) => {
      expect(() => parseUsd(value)).toThrow();
    },
  );
  it("formats sub-cent values and maximum values exactly", () => {
    expect(formatUsd(1)).toBe("$0.000001");
    expect(formatUsd(100_000)).toBe("$0.10");
    expect(formatUsd(12_345_678)).toBe("$12.345678");
    expect(formatUsd(-1_000_000)).toBe("−$1.00");
    expect(formatUsd(Number.MAX_SAFE_INTEGER)).toBe("$9,007,199,254.740991");
  });
  it("never disguises unavailable or invalid amounts as zero", () => {
    expect(formatUsd(Number.NaN)).toBe("Unavailable");
    expect(formatUsd(0.2)).toBe("Unavailable");
    expect(formatUsd(undefined as unknown as number)).toBe("Unavailable");
  });
  it("labels the ledger's month as UTC, independent of local timezone", () => {
    expect(utcMonth("2026-09")).toBe("September 2026 · UTC month");
  });
  it.each(["0", "-1", "2.5", "1e3", "Infinity", "9007199254740992"])("rejects invalid token count %s", (value) => {
    expect(() => positiveInteger(value, "Tokens")).toThrow("Tokens must be a positive whole number.");
  });
});
