# Install Codex Usage for a user

Use this procedure when the user asks you to install Codex Usage. Reading this document alone does not authorize installation. Supported release: Windows x64, Node.js >=26.7.0. The application reads local Codex records; it does not invoke a model or upload usage history.

## Install a verified release

Run PowerShell as the current user, without elevation. First inspect `Get-Command codex-usage -ErrorAction SilentlyContinue` and `Get-Command node.exe -ErrorAction SilentlyContinue`. Preserve unrelated installations. Resolve this repository's latest stable release, pin its tag for the installation script, and inspect the downloaded script before running it:

```powershell
$latest = Invoke-WebRequest -UseBasicParsing 'https://github.com/Cusnd/codex-usage/releases/latest'
$releaseUri = if ($latest.BaseResponse.ResponseUri) { $latest.BaseResponse.ResponseUri.AbsoluteUri } else { $latest.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
if ($releaseUri -notmatch '^https://github\.com/Cusnd/codex-usage/releases/tag/(v\d+\.\d+\.\d+)$') { throw 'No supported stable release' }
$releaseTag = $Matches[1]
$installer = Join-Path $env:TEMP ('codex-usage-install-' + [guid]::NewGuid().ToString() + '.ps1')
Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/Cusnd/codex-usage/$releaseTag/scripts/install.ps1" -OutFile $installer
Get-Content -LiteralPath $installer
```

After inspecting it, run the downloaded file in a child process:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
if ($LASTEXITCODE -ne 0) { throw 'Installation did not complete' }
```

`-ExecutionPolicy Bypass` applies to that process only. Do not change machine execution policy. The installer reuses a compatible x64 Node with npm; otherwise it downloads Node 26.7.0 from `nodejs.org`, verifies the archive against the official HTTPS SHA256SUMS, and extracts it under the user's installation directory. It verifies the Release `.tgz` against `SHA256SUMS`, installs with lifecycle scripts disabled, and copies the verified Node executable beside the npm command shims so an older system Node cannot take precedence. Only the installation prefix is added to the user PATH; existing Node installations are not replaced.

The default npm prefix is `%LOCALAPPDATA%\CodexUsage\tools`. No npm registry publication is required; runtime dependencies are downloaded from npm during installation. The package and installer are public; account login files are never part of installation.

For isolated validation, set `CODEX_USAGE_DATA_DIR`, `CODEX_HOME`, `CODEX_BIN` to an intentionally missing executable, and `CODEX_USAGE_STARTUP_DIR` to temporary directories, select an unused `PORT`, and invoke the installer with `-InstallRoot <temporary-prefix> -NoUserPath`. Never enable the real user's startup for a smoke test.

## Verify and install the Skill

New terminals inherit the updated user PATH. To continue in the same Agent shell, explicitly invoke `%LOCALAPPDATA%\CodexUsage\tools\codex-usage.cmd` (substitute a custom prefix if used), or reload the user/machine PATH. The installation's Node executable is `tools\node.exe`. Run:

```powershell
codex-usage --version
codex-usage doctor --json
codex-usage start --json
codex-usage status --json
codex-usage summary --days 7 --json
codex-usage skill install --json
```

Every command must exit successfully. Confirm that doctor reports Windows x64, `webAssets: true` and a verified service after start. Verify HTTP 200 from `http://127.0.0.1:8765/` and `/api/status` (substitute an explicitly configured port). Service readiness does not mean historical import has finished. Report import progress or use `codex-usage refresh --source local --wait --timeout 300 --json` to wait. Account capability errors can coexist with correct local statistics.

The Skill is installed under `$CODEX_HOME\skills\codex-usage`, defaulting to `$HOME\.codex\skills\codex-usage`. An unmanaged existing Skill is a conflict: preserve it and report its location. Updates to a managed Skill preserve the old directory in `codex-usage-skill-backups`. A newly installed Skill may require a fresh Agent task to be discovered; do not claim the current task has loaded it automatically.

If Node/npm, downloads, checksums, startup registration, or service identity verification fails, stop that dependent step and report the actual error. Do not substitute a similarly named npm package, remove foreign processes, overwrite another Skill, or bypass integrity checks. Diagnose with `doctor`, `status`, and `%LOCALAPPDATA%\CodexUsage\service.log`; do not print login files or the private instance token.

## Explain how to use it

After successful installation, tell the user:

- Run **`codex-usage`** to start/reuse the service and open the dashboard. No subcommand is required.
- Enable **登录 Windows 后后台启动** in Web Settings, or run `codex-usage autostart enable`. Leave it disabled unless requested. Login startup does not open a browser and may be delayed by Windows.
- With the default local service running, enter **https://usage.esoren.com** in the browser. It redirects to **http://127.0.0.1:8765/** on that same device; the address bar changes. It cannot install/start the application or access another computer.
- The domain needs internet. The local address and CLI work offline for local statistics. A custom `PORT` requires its own local URL; the domain always uses 8765.
- Ask the Agent to analyze recorded usage. Examples: `summary --days 7 --json`, `breakdown --days 7 --group-by model --json`, `agents --id TASK_ID --json`.
- `codex-usage stop` stops the service. Browser and terminal closure do not stop it. `autostart disable` affects future logins, not the current process.

Report the installed version, install path, working local URL, Skill path, actual startup state, import status, and any unavailable account capabilities. Do not equate account limits with local token history or missing data with zero.

## Upgrade, migration and uninstall

For an installation managed by the script, rerun it: it stops the old service, verifies and installs the new package, preserves the data directory, and updates an enabled startup launcher. Reinstall the managed Skill afterward. For other prefixes, stop the existing CLI first and use that prefix explicitly.

To import an older checkout's cache, cleanly stop that checkout's server, then run `codex-usage migrate --from C:\absolute\old-checkout\data\usage.sqlite`. The command refuses an existing destination or SQLite sidecar files, checks integrity, copies and verifies SHA-256, and preserves the original. It does not discover databases from the current directory.

To uninstall:

```powershell
codex-usage autostart disable
codex-usage stop
codex-usage skill uninstall
npm uninstall --global --prefix "$env:LOCALAPPDATA\CodexUsage\tools" codex-detailed-usage
```

For a custom installation prefix, substitute the actual prefix. The user's cache, startup launcher file, logs, managed Skill backups, and optional private Node runtime are retained. Remove retained files or PATH entries only when the user requests full cleanup and after verifying their exact ownership and paths. Never delete the user's Codex source records.
