export const tokenFields = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;
export function label(value: string | null): string {
  return value ? value.split(/[\\/]/).filter(Boolean).at(-1) || value : "未知";
}
export function ratio(a: bigint | null, b: bigint | null): number | null {
  return a === null || b === null || b === 0n
    ? null
    : Number((a * 1_000_000n) / b) / 1_000_000;
}
