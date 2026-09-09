# Contributing to Codex Usage

Help people understand their Codex activity without losing the context behind the numbers. Start with the [user guide](docs/USER_GUIDE.md) for behavior and the [technical reference](docs/TECHNICAL_REFERENCE.md) for data contracts.

## Develop locally

Use Windows x64 or macOS x64/arm64 with Node.js 22.13+ (22.x), 24.x, or 26.x:

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. For a production build, run `npm run build` followed by `npm start`, then open `http://127.0.0.1:8765`. This foreground server stops with Ctrl+C; the product CLI is `node bin/codex-usage.mjs` after building.

## Verify a change

Before submitting application changes, run:

```powershell
npm run check
npm test
npm run build
npm run smoke
npm run package:smoke
```

The smoke checks use isolated data. The package smoke test installs into a temporary prefix and tests lifecycle/startup without the real login or startup folder. For documentation-only changes, check relative links, anchors, command examples, and image readability; do not add business-logic tests for prose edits.

## Use reproducible examples

After building, run `npx tsx scripts/design-preview.ts`. It creates an in-memory database, an empty temporary Codex directory, and synthetic account responses on port 8766. Set `CODEX_USAGE_PREVIEW_PORT` if needed. It verifies a seven-day dataset and a four-agent family, including one nested child. Stop the preview with Ctrl+C.

For public screenshots, use this dataset and the fixed September 2–9, 2026 range, not the real local service. Capture the useful region of the real rendered application and inspect it at README width. See [screenshot reproduction](docs/images/README.md). Keep the English and Chinese READMEs and user guides aligned when behavior changes.

Keep Codex source records read-only. Test parser and account changes with synthetic fixtures. Do not include personal session files, login files, SQLite databases, task titles, project paths, or real-account screenshots in issues, pull requests or demo assets. Preserve decimal-string token precision and the distinction between local activity and account-level snapshots.

Report bugs through GitHub Issues with the application/Node version, OS version and architecture, reproduction steps, and sanitized error text. Never paste `auth.json`, tokens or the private `instance.json` token. For UI changes include screenshots using the synthetic `scripts/design-preview.ts` dataset.

CI checks Windows x64, macOS Apple Silicon (`macos-15`) and Intel (`macos-15-intel`) across the existing Node matrix. macOS package smoke uses a unique temporary launchd job and removes it afterward. Use browser-control tools for UI acceptance, not Playwright. Record actual macOS CI and desktop results separately in [compatibility status](docs/MACOS_COMPATIBILITY.md); compilation on Windows is not proof of macOS support.
