# Public screenshot reproduction

The README images were captured on September 8, 2026 from the [published interactive example](https://codex-usage-showcase.sorenliu.workers.dev/). It uses the same React frontend as the local application, with deterministic synthetic usage and account data. Never capture the personal local service for public documentation.

## Prepare

Use the published example, or run `npm run showcase:build` followed by `npx wrangler dev --config showcase/wrangler.jsonc --port 8877`. See the [example frontend guide](../../showcase/README.md).

Use America/New_York, disable reference costs, and select recent seven days. The example clock is fixed at `2026-09-08T18:00:00Z`. The fixture has 119,210,000 tokens, 28 tasks and 92 turns; account windows are synthetic as well. Wait for loaded records and fonts before capturing, and move the pointer away from interactive charts.

## Overview

Open `/` at a 1440px viewport width. Capture the first 1100 CSS pixels of the page at 2x density as `overview.png`. Verify 119.21M tokens, 28 / 92 sessions and turns, the daily trend, and the clearly labeled synthetic account windows. The saved PNG is 2880 × 2200 pixels.

## Task and agent team

Open `/threads/example-session-01` at a 1440px viewport width. Keep the agent details expanded and capture the first 1800 CSS pixels at 2x density as `agent-team.png`. This includes the task's six turns and all four agent rows. The saved PNG is 2880 × 3600 pixels.

Verify the team totals: 18.2M current agent, 30.4M descendants, 48.6M team. Two direct children include one child with its own nested child. Each agent row reports its own usage.

Inspect the actual screenshots before publishing; do not reconstruct the UI as a mockup. Current source captures and browser validation are recorded in the [shared frontend report](../design/shared-frontend/README.md). Historical design screenshots are not an approved source for public product screenshots.
