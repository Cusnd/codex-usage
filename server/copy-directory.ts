import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

// fs.cpSync can crash on Unicode source paths in Windows Node 22.23.2.
// The bundled Skill contains only directories and regular files.
export function copyDirectory(source: string, target: string) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error(`Unsupported Skill entry: ${entry.name}`);
  }
}
