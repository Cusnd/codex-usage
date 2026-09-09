// Build the real React application with only the synthetic browser data adapter.
import { build } from 'vite';
import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await build({mode:'showcase'});
await copyFile(path.join(root,'node_modules/sql.js/LICENSE'),path.join(root,'showcase/build/sql-js-license.txt'));
await copyFile(path.join(root,'node_modules/@fontsource-variable/inter/LICENSE'),path.join(root,'showcase/build/font-license.txt'));
await writeFile(path.join(root,'showcase/build/_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
`);
console.log('Showcase built from the shared React frontend and synthetic fixture. No personal service queried.');
