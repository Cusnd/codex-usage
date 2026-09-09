#!/usr/bin/env node
// Compatibility entrypoint. Query logic lives in the installed CLI.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
const configPath = fileURLToPath(new URL('../.codex-usage-cli.json', import.meta.url));
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
const candidates = [process.env.CODEX_USAGE_CLI, config?.cli, fileURLToPath(new URL('../../../bin/codex-usage.mjs', import.meta.url)),
  ...(process.platform === 'win32' && process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'CodexUsage/tools/node_modules/codex-detailed-usage/bin/codex-usage.mjs')] : [])];
const cli = candidates.find(file => file && existsSync(file));
if (!cli) { console.error('Install Codex Usage first; see docs/INSTALL_FOR_AGENTS.md.'); process.exit(1); }
const child = spawn(config?.node || process.execPath, [cli, ...process.argv.slice(2), '--json'], { stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
