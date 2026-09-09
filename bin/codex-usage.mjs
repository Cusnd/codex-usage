#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (process.versions.node.includes('-') || !((major === 22 && minor >= 13) || major === 24 || major === 26)) {
  console.error(`Codex Usage requires Node.js 22.13+ (22.x), 24.x, or 26.x on Windows x64; current version: ${process.version}. Install a supported Node.js LTS release.`);
  process.exit(1);
}
await import('../dist/server/cli.js');
