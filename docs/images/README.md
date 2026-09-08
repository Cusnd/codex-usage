# Public screenshot reproduction

These are captures of the real production UI with synthetic data. They replace the old long analysis capture and settings preview in the product README. Do not use the screenshots under historical design reports as public demo data; some reports used local records.

## Prepare

Run `npm run build`, then `npx tsx scripts/design-preview.ts`. The isolated server defaults to `http://127.0.0.1:8766`, uses an in-memory database and an empty temporary Codex directory, and never reads personal accounts. It verifies 119.21M tokens, 28 tasks, 92 turns, and a four-agent family.

## Analysis

- Open `/analysis?range=custom&from=2026-09-02T04:00:00Z&to=2026-09-09T04:00:00Z` on the preview server.
- Set the viewport to 1280 × 1100. Select the first project, `codex-usage`, so the task list replaces the empty selection prompt.
- Wait for the task rows, loaded fonts, and chart animation to settle. Move the pointer away from charts and controls.
- Capture the `main` element as `analysis.png`. This includes the complete trend, composition, four projects, and four tasks without a page footer or clipped rows.

## Agent team

- Open `/threads/example-session-01?range=custom&from=2026-09-02T04:00:00Z&to=2026-09-09T04:00:00Z`.
- Set the viewport to 1040 × 900 and scroll `.agent-usage` into view. Wait for all four agent rows and fonts to load.
- Capture that region with 18 pixels of vertical padding and the full viewport width as `agent-team.png`.
- Verify the three totals: 18.2M current agent, 30.4M descendants, 48.6M team. The two direct children include one child with its own nested child.

Store intermediate captures under ignored `output/playwright/`, inspect them at typical GitHub reading width, then copy the final PNG files here. Do not stretch, reconstruct, or replace the application UI with a mockup. The public showcase's interactive example is separately identified as a curated example, not a screenshot.
