

export function queryParameters(params: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') {
    if (Array.isArray(value)) value.forEach(entry => search.append(key, String(entry)));
    else search.set(key, String(value));
  }
  return search;
}
