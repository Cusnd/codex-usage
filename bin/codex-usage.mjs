#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (process.versions.node.includes('-') || !((major === 22 && minor >= 13) || major === 24 || major === 26)) {
  console.error(`Codex Usage requires Node.js 22.13+ (22.x), 24.x, or 26.x; current version: ${process.version}. Install a supported Node.js release.`);
  process.exit(1);
}
if (!(process.platform === 'win32' && process.arch === 'x64') && !(['darwin', 'linux'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch))) {
  console.error(`Codex Usage supports Windows x64 and macOS/Linux x64/arm64; current platform: ${process.platform}/${process.arch}.`);
  process.exit(1);
}
await import('../dist/apps/local/cli.js');
