# Contributing

Use Windows x64 with Node.js >=26.7.0. Run `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm run smoke`, and `npm run package:smoke` before submitting a change. The package smoke test installs into an isolated temporary prefix and never uses your real login or startup folder.

Keep Codex source records read-only. Test parser and account changes with synthetic fixtures. Do not include personal session files, login files, SQLite databases, task titles, project paths, or real-account screenshots in issues, pull requests or demo assets. Preserve decimal-string token precision and the distinction between local activity and account-level snapshots.

Report bugs through GitHub Issues with the application/Node version, Windows version, reproduction steps, and sanitized error text. Never paste `auth.json`, tokens or the private `instance.json` token. For UI changes include screenshots using the synthetic `scripts/design-preview.ts` dataset.

This is a Windows-first release. Changes for other systems are welcome with an explicit support statement and installation/lifecycle tests; do not infer platform support from TypeScript compilation alone.
