#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 26 || (Number(process.versions.node.split('.')[0]) === 26 && Number(process.versions.node.split('.')[1]) < 7)) {
  console.error('Codex Usage requires Node.js >=26.7.0. See docs/INSTALL_FOR_AGENTS.md.');
  process.exit(1);
}
await import('../dist/server/cli.js');
