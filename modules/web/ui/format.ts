

export function exact(value: string | null | undefined): string {
  if (value == null) return "—";
  try {
    return BigInt(value).toLocaleString("zh-CN");
  } catch {
    return value;
  }
}

export function compact(value: string | null | undefined): string {
  if (value == null) return "—";
  const n = BigInt(value),
    sign = n < 0n ? "-" : "",
    a = n < 0n ? -n : n;
  for (const [base, suffix] of [
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1000n, "K"],
  ] as const)
    if (a >= base) return `${sign}${Number((a * 100n) / base) / 100}${suffix}`;
  return value;
}

export const percent = (value: number | null | undefined) =>
  value == null ? "—" : `${(value * 100).toFixed(1)}%`;
