# Codex Usage

**See where your Codex tokens go.**

A local dashboard for understanding your Codex activity. Follow a usage spike from a project to a task and down to an individual turn. See how much work came from the main agent and its subagents—or ask your agent to look up the numbers for you.

[Explore the live example](https://codex-usage-showcase.sorenliu.workers.dev) · [Get started](#get-started) · [User guide](docs/USER_GUIDE.md) · [简体中文](README.zh-CN.md)

Windows x64 · macOS Apple Silicon / Intel · Local-first · Apache-2.0

The current development tree adds Linux x64/arm64 and a multi-device cloud dashboard. These changes have not been published to npm. Linux installation paths and verification limits are documented in [Linux support](docs/LINUX_COMPATIBILITY.md); implementation and acceptance evidence are tracked in [the cloud implementation record](docs/design/multi-device-cloud-panel-implementation-progress-2026-09-11.md).

Version 0.1.3 adds macOS Apple Silicon and Intel support, verified by native GitHub Actions jobs on both architectures. See [macOS compatibility](docs/MACOS_COMPATIBILITY.md) for installation and run records. Version 0.1.2 and earlier support Windows only.

Try the [live example](https://codex-usage-showcase.sorenliu.workers.dev) before installing. It runs the same React frontend with synthetic records, including task and turn details, agent teams, filters, and browser-local cost settings. Your own usage is available in the local app.

![Codex Usage overview with seven days of activity, token composition, daily trend, and synthetic account limits](docs/images/overview.png)

*119.21M tokens across 28 tasks and 92 turns. Captured from the live example using the same frontend as the local app. All usage and account limits shown are synthetic; the current UI is in Chinese.*

## Follow the numbers to the work

### From a busy day to a single turn

Start with the daily trend, open a day to see its hours, and narrow the view by project, model, or reasoning effort. Move into a task to inspect its turns, or browse turns across tasks to find the largest ones. Your filters stay with you as you explore.

### See the whole agent team

A task can delegate work, and those subagents can delegate again. View **the current agent, all subagents, and the team total** separately, then open any agent to inspect its turns. Each row shows that agent's own usage, so a busy child does not disappear inside its parent's number.

![Task details with individual turns and an expanded agent team, including two direct subagents and one nested subagent](docs/images/agent-team.png)

*One example task: 18.2M tokens from the current agent, 30.4M from its descendants, and 48.6M for the team. Chinese UI; synthetic data.*

### Understand what changed

Compare periods to find which projects, models, or tasks account for an increase. Separate uncached input, cache reads, and output to understand the composition of that usage. Optional API reference costs add another perspective when you need it.

### Ask your agent

Install the included Skill and use the same data from a conversation:

> Which tasks used the most tokens over the last seven days?
>
> How many tokens did this task's subagents use?
>
> Which tasks have a low cache-hit share?

The Skill queries the local service through the CLI. Its answers retain the time range, source, and missing-data caveats, so you can check what a number represents.

## Get started

**Let your agent install it.** Give it this prompt:

> Install Codex Usage using https://github.com/Cusnd/codex-usage/blob/main/docs/INSTALL_FOR_AGENTS.md, install its Skill, and show me how to open the dashboard.

The [installation guide](docs/INSTALL_FOR_AGENTS.md) covers verified downloads and a user-level Node setup when needed.

**Already have Node.js 22.13+ (22.x), 24.x, or 26.x on Windows x64 or macOS x64/arm64?** Install the public npm package:

```powershell
npm install -g @esoren/codex-usage
codex-usage
```

The npm package includes the built web app. The package name is **`@esoren/codex-usage`**; the command is `codex-usage`. The unscoped npm package `codex-usage` belongs to another project. Existing `codex-detailed-usage` installations should follow the [migration steps](docs/INSTALL_FOR_AGENTS.md#migrate-a-legacy-package-to-npm) before switching.

To enable agent queries:

```powershell
codex-usage skill install
```

Open a fresh agent task if the newly installed Skill is not discovered yet. First-time history import may take a few minutes; the app shows progress.

## Your data, in context

- **Local history stays local.** The app reads your Codex records without modifying them and does not upload usage history. Its cache contains usage metadata, including task titles and project paths, rather than chat bodies or tool output.
- **Account limits are a separate view.** Available account features use your existing Codex login. Local token activity and account-level snapshots cover different things and are not added together.
- **Optional cloud viewing across devices.** Enable sync on each computer to use the same complete UI at [quota.esoren.com](https://quota.esoren.com). Usage is merged and deduplicated by default, with device filters; account quotas remain separate. History remains available while collectors are offline. Full sync includes original task titles and project paths, while excluding chats, tool bodies and login credentials. This branch's updated client is pending npm release; see the [cloud setup guide](docs/USER_GUIDE.md#view-quotas-from-another-device).
- **Reference costs are estimates.** Optional API pricing does not represent your ChatGPT subscription bill. Incomplete records or unknown prices remain marked as incomplete.
- **Coverage follows your records.** Results reflect recognizable history retained on this computer; they are not a complete multi-device account ledger.

## Explore further

| Looking for… | Start here |
| --- | --- |
| Filters, comparisons, startup, upgrades, and troubleshooting | [User guide](docs/USER_GUIDE.md) |
| A repeatable installation procedure for an agent | [Agent installation guide](docs/INSTALL_FOR_AGENTS.md) |
| CLI/API behavior, counting rules, and data sources | [Technical reference](docs/TECHNICAL_REFERENCE.md) |
| Development and contribution checks | [Contributing](CONTRIBUTING.md) |
| Building the interactive example and reproducing its screenshots | [Example frontend](showcase/README.md) · [Screenshot guide](docs/images/README.md) |

Found a problem? [Open an issue](https://github.com/Cusnd/codex-usage/issues) with reproduction steps and sanitized errors.

Licensed under [Apache-2.0](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependencies, fonts, and attribution.
