

export function parseJson(text: string): any {
  // Node 26 exposes the original JSON number lexeme to a reviver, before precision is lost.
  return JSON.parse(text, ((
    _key: string,
    value: unknown,
    context?: { source?: string },
  ) => {
    if (
      typeof value === "number" &&
      context?.source &&
      /^-?\d+$/.test(context.source) &&
      !Number.isSafeInteger(value)
    )
      return BigInt(context.source);
    return value;
  }) as Parameters<typeof JSON.parse>[1]);
}

export function json(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

export function integer(value: unknown): bigint | null {
  if (typeof value === "bigint")
    return value >= 0n && value <= 9223372036854775807n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value))
    return integer(BigInt(value));
  return null;
}
