import path from "node:path";

export function projectPath(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const windows = /^[a-z]:/i.test(value) || value.startsWith('\\\\') || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(value);
  if (!windows) {
    const normalized = path.posix.normalize(value);
    return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
  }
  const plain = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  const normalized = path.win32.normalize(plain).toLowerCase();
  return normalized === path.win32.parse(normalized).root ? normalized : normalized.replace(/[\\/]+$/, '');
}

export { label, ratio } from "../../foundation/query-values.js";

export const yieldLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export { parseJson, json, integer } from '../../foundation/values.js';
