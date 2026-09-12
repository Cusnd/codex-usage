/** Portable normalization of absolute source paths, independent of the viewing device. */
export function normalizeSourcePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const windows = /^[a-z]:/i.test(value) || value.startsWith('\\\\') || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(value);
  if (!windows) {
    const absolute = value.startsWith('/'), parts: string[] = [];
    for (const part of value.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '..' || !absolute) parts.push(part);
    }
    return (absolute ? '/' : '') + parts.join('/') || '.';
  }
  const plain = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase();
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(plain), drive = /^[a-z]:/.exec(plain);
  const root = unc ? `\\\\${unc[1]}\\${unc[2]}\\` : drive ? drive[0] + (plain[2] === '\\' ? '\\' : '') : '\\';
  const parts: string[] = [];
  for (const part of plain.slice(unc ? unc[0].length : root.length).split('\\')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !root.endsWith('\\')) parts.push(part);
  }
  return root + parts.join('\\');
}
