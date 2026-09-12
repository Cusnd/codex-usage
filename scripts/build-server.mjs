import { existsSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
// TypeScript does not remove outputs whose source files were deleted.
// Only these compiler output directories may be replaced; never follow an external link.
for (const name of ['server', 'shared', 'apps', 'modules', 'tooling']) {
  const target = path.resolve(root, 'dist', name);
  if (!existsSync(target)) continue;
  const actual = realpathSync(target), relative = path.relative(root, actual);
  if (actual !== target || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Refusing to clean compiler output outside its workspace directory: ' + target);
  rmSync(target, { recursive: true });
}
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.server.json'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
