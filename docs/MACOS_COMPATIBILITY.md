# macOS compatibility — candidate, not yet released

The source adds macOS Apple Silicon (`arm64`) and Intel (`x64`) compatibility. The published `@esoren/codex-usage@0.1.2` remains Windows-only. This update does not publish a new package or establish macOS support solely from Windows tests.

## Install the candidate on a Mac

Use Node.js 22.13+ (22.x), 24.x, or 26.x and npm, with a macOS version supported by that Node distribution. No private Node installer, Homebrew formula or DMG is supplied. Use an existing writable npm prefix.

From this checkout, check each command's exit status before continuing:

```sh
node -p 'process.platform + "/" + process.arch + " " + process.version'
npm ci
npm run check
npm test
npm run build
npm run smoke
npm run package:smoke
npm pack
```

Install the actual archive printed by `npm pack` using its absolute path. The source version is unchanged, so the filename may still contain `0.1.2`:

```sh
npm install --global /absolute/path/to/esoren-codex-usage-0.1.2.tgz
codex-usage doctor --json
codex-usage start --json
codex-usage summary --days 7 --json
codex-usage skill install
codex-usage
```

Do not substitute the registry's Windows-only 0.1.2 for the locally built candidate. When receiving an archive from someone else, verify its supplied SHA-256 using `shasum -a 256 /absolute/path/to/candidate.tgz`. After a compatible release is verified and published, installation will use `npm install --global @esoren/codex-usage`.

If the command is missing, inspect `npm prefix --global` and invoke `"$(npm prefix --global)/bin/codex-usage"`. Do not add `sudo` to work around an unwritable system prefix; use a user-owned npm prefix or an existing user-managed Node installation.

## Paths and lifecycle

| Item | macOS behavior |
| --- | --- |
| Data/logs | `~/Library/Application Support/CodexUsage`, overridden by `CODEX_USAGE_DATA_DIR`. |
| Codex records | `~/.codex`, overridden by `CODEX_HOME`; originals remain read-only. |
| Skill | `<Codex home>/skills/codex-usage`; records absolute Node/CLI paths. |
| Login startup | `~/Library/LaunchAgents/com.esoren.codex-usage.plist`; test directory overridden by `CODEX_USAGE_STARTUP_DIR`. |
| Browser | `/usr/bin/open` opens the loopback URL; failure prints a manual URL. |
| Platforms | Windows x64 and macOS x64/arm64; Linux and Windows ARM64 are not included. |

`autostart enable` registers a one-shot launcher for the next login, without immediately starting a stopped service. `start` starts it now; `stop` stops it without a keep-alive restart. `autostart disable` removes only the owned registration for future logins, leaving the current service running. A foreign or different-data-directory registration is a conflict and is preserved.

The launcher captures Node, CLI, PATH, PORT and relevant Codex/data-directory overrides. After changing Node or the npm prefix, reinstall the Skill and re-enable previously enabled autostart to update absolute paths. macOS can block background items in System Settings; `autostart status` reports owned configuration, not proof of an allowed login launch.

To update, stop the service, install the verified candidate/release into the same prefix, reinstall the Skill, and re-enable previously enabled autostart. To uninstall:

```sh
codex-usage autostart disable
codex-usage stop
codex-usage skill uninstall
npm uninstall --global @esoren/codex-usage
```

Data, logs and Skill backups remain. To migrate an old cache, stop its old service, then use `codex-usage migrate --from '/Users/name/old data/usage.sqlite'`; existing destinations are not overwritten.

## Validation status

- Windows x64 / Node 26.7.0: type checks, build, production API/assets smoke and npm installation/lifecycle smoke passed. The suite has 57 tests: 55 pass, with 2 macOS-only cases skipped. Browser-control acceptance verified task/turn navigation, platform-neutral settings text and the isolated startup switch (off → on → off). No macOS result is inferred from these checks.
- macOS CI: configured for `macos-15` (arm64) and `macos-15-intel` (x64), with Node 22.13.0/22.x, 24.0.0/24.x and 26.0.0/26.x. Not run from this Windows workspace.
- macOS permissions, npm symlinks and process-group cleanup: tests require a real Mac runner; a Windows skip is not a pass.
- macOS LaunchAgent: package smoke validates the actual plist with `plutil`, bootstraps a uniquely labelled copy in the login domain `gui/<uid>`, waits for the launcher to exit while its service survives, verifies stop does not restart, and removes the job. Smoke tests do not change real login items.
- macOS desktop: browser opening, logout/login and OS background-item approval are optional follow-up checks; they are not the compatibility completion gate. The native CI matrix validates the Node backend and real launchd lifecycle.
- npm publication: not performed by this update.

Compatibility completion is based on a successful native CI matrix: Windows x64 and macOS arm64/x64, with real npm installation, backend tests, production assets/API and launchd/service lifecycle checks. Keep existing browser regression checks for the shared web frontend. If additional desktop spot checks are needed, use browser-control tooling with synthetic records and an isolated startup directory; no physical Mac is required to complete the backend compatibility update.
