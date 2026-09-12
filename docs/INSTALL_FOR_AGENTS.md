# Agent installation guide

[Product overview](../README.md) · [User guide](USER_GUIDE.md) · [Technical reference](TECHNICAL_REFERENCE.md)

Use this procedure when the user asks you to install Codex Usage. Reading this document alone does not authorize installation. Version 0.1.3 introduced Windows x64 and macOS x64/arm64 support with Node.js 22.13+ (22.x), 24.x, or 26.x. The application reads local Codex records and does not invoke a model. Cloud history upload is optional and starts only after the user enables and binds cloud synchronization.

The current unreleased source tree adds Linux x64/arm64. For a source-tree validation, build and install its candidate archive rather than assuming the public npm package contains these changes. Follow [Linux support](LINUX_COMPATIBILITY.md): verify the loopback service and local import independently; systemd registration is available only with a working non-root user manager. WSL x64 evidence does not verify arm64 or login/suspend behavior.

## Install from npm with an existing Node runtime

**macOS x64/arm64:** use version 0.1.3 or later and follow [Mac installation](MACOS_COMPATIBILITY.md) using existing supported Node/npm. Inspect `command -v node`, `command -v codex-usage`, `node -p 'process.arch'`, and `npm prefix --global`; install with `npm install --global @esoren/codex-usage`, then run the common CLI checks in section 3. Sections 1–2 are Windows-only.

On macOS doctor must report `darwin` and `x64` or `arm64`, `webAssets: true`, and a verified service after start. Data/logs default to `~/Library/Application Support/CodexUsage`; Codex records and Skills use `~/.codex` or explicit overrides. If the CLI is missing, invoke `"$(npm prefix --global)/bin/codex-usage"`. Use a writable user prefix rather than `sudo`. Every command must succeed before continuing.

For Windows x64 with Node.js 22.13+ (22.x), 24.x, or 26.x and npm, inspect `Get-Command codex-usage -ErrorAction SilentlyContinue` first. If the legacy package is installed, use the migration procedure below. Otherwise:

```powershell
npm install -g @esoren/codex-usage
if ($LASTEXITCODE -ne 0) { throw 'Installation did not complete' }
```

Continue at **3. Verify the service and install the Skill**. This route uses the current npm global prefix (`npm prefix --global`); it does not install a private Node runtime. If the runtime is missing, use the GitHub installer procedure below. Older GitHub releases still install the legacy package.

## 1. Inspect the environment and download the installer

Run PowerShell as the current user, without elevation. First inspect `Get-Command codex-usage -ErrorAction SilentlyContinue` and `Get-Command node.exe -ErrorAction SilentlyContinue`. Preserve unrelated installations. Resolve this repository's latest stable release, download the installation script from that tag, and inspect it before running it:

```powershell
$latest = Invoke-WebRequest -UseBasicParsing 'https://github.com/Cusnd/codex-usage/releases/latest'
$releaseUri = if ($latest.BaseResponse.ResponseUri) { $latest.BaseResponse.ResponseUri.AbsoluteUri } else { $latest.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
if ($releaseUri -notmatch '^https://github\.com/Cusnd/codex-usage/releases/tag/(v\d+\.\d+\.\d+)$') { throw 'No supported stable release' }
$releaseTag = $Matches[1]
$installer = Join-Path $env:TEMP ('codex-usage-install-' + [guid]::NewGuid().ToString() + '.ps1')
Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/Cusnd/codex-usage/$releaseTag/scripts/install.ps1" -OutFile $installer
Get-Content -LiteralPath $installer
```

## 2. Install the verified release

After inspecting it, run the downloaded file in a child process. The current installer resolves the latest stable package again when it runs; the script tag is fixed by the download above, but the package version is not pinned by an installer argument. For a specific package version, use the [verified manual procedure](USER_GUIDE.md#manual-installation).

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
if ($LASTEXITCODE -ne 0) { throw 'Installation did not complete' }
```

`-ExecutionPolicy Bypass` applies to that process only. Do not change machine execution policy. The installer reuses a compatible x64 Node with npm; otherwise it downloads the latest Node 24 LTS patch from `nodejs.org`, verifies the archive against the official HTTPS SHA256SUMS, and extracts it under the user's installation directory. It verifies the Release `.tgz` against `SHA256SUMS`, installs with npm default lifecycle behavior, and copies the verified Node executable beside the npm command shims so an older system Node cannot take precedence. Only the installation prefix is added to the user PATH; existing Node installations are not replaced.

The default npm prefix is `%LOCALAPPDATA%\CodexUsage\tools`. No npm registry publication is required; runtime dependencies are downloaded from npm during installation. The package and installer are public; account login files are never part of installation.

For isolated validation, set `CODEX_USAGE_DATA_DIR`, `CODEX_HOME`, `CODEX_BIN` to an intentionally missing executable, and `CODEX_USAGE_STARTUP_DIR` to temporary directories, select an unused `PORT`, and invoke the installer with `-InstallRoot <temporary-prefix> -NoUserPath`. Never enable the real user's startup for a smoke test.

## 3. Verify the service and install the Skill

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

### Handle failures at the affected step

| Failure | Response |
| --- | --- |
| Runtime, download, or checksum failure | Stop installation and report the failing check; do not bypass integrity verification or substitute a similarly named npm package. |
| Service identity or startup failure | Inspect `doctor`, `status`, and the service log; preserve unrelated processes and startup entries. |
| Unmanaged Skill conflict | Preserve the directory and report its location; do not overwrite it. |
| Account capability unavailable | Report limits and history status separately; continue verifying local statistics. |

Do not print login files or the private instance token. Logs are under `%LOCALAPPDATA%\CodexUsage` unless the data directory was explicitly changed.

## 4. Hand the installation back to the user

After successful installation, tell the user:

- Run **`codex-usage`** to start/reuse the service and open the dashboard. No subcommand is required.
- Enable **登录系统后后台启动** in Web Settings, or run `codex-usage autostart enable`. Leave it disabled unless requested. Login startup does not open a browser and may be delayed by the OS.
- With the default local service running, enter **https://usage.esoren.com** in the browser. It redirects to **http://127.0.0.1:8765/** on that same device; the address bar changes. It cannot install/start the application or access another computer.
- The domain needs internet. The local address and CLI work offline for local statistics. A custom `PORT` requires its own local URL; the domain always uses 8765.
- Ask the Agent to analyze recorded usage. Examples: `summary --days 7 --json`, `breakdown --days 7 --group-by model --json`, `agents --id TASK_ID --json`.
- `codex-usage stop` stops the service. Browser and terminal closure do not stop it. `autostart disable` affects future logins, not the current process.

Report the installed version, install path, working local URL, Skill path, actual startup state, import status, and any unavailable account capabilities. Do not equate account limits with local token history or missing data with zero.

## Upgrade, migrate, or uninstall

On macOS use the same npm/CLI lifecycle sequence in zsh/bash; see [macOS lifecycle](MACOS_COMPATIBILITY.md#paths-and-lifecycle). After changing Node or the prefix, reinstall the Skill and re-enable previously enabled autostart. Migration accepts a quoted POSIX path, e.g. `codex-usage migrate --from '/Users/name/old data/usage.sqlite'`. Uninstall with `autostart disable`, `stop`, `skill uninstall`, then `npm uninstall --global @esoren/codex-usage` in the actual prefix. Retain cached data and Codex originals; preserve unmanaged LaunchAgents. macOS registration takes effect next login, not immediately.

For a scoped npm installation, stop the service, install the desired `@esoren/codex-usage` version into the same prefix, reinstall the Skill, and re-enable autostart if it was enabled. The cache remains outside the installed package directory.

For an installation managed by the script, rerun it: it stops the old service, verifies and installs the new package, preserves the data directory, and updates an enabled startup launcher. Reinstall the managed Skill afterward. For other prefixes, stop the existing CLI first and use that prefix explicitly.

To import an older checkout's cache, cleanly stop that checkout's server, then run `codex-usage migrate --from C:\absolute\old-checkout\data\usage.sqlite`. The command refuses an existing destination or SQLite sidecar files, checks integrity, copies and verifies SHA-256, and preserves the original. It does not discover databases from the current directory.

### Migrate a legacy package to npm

The legacy `codex-detailed-usage` package and `@esoren/codex-usage` provide the same command. Record the old prefix, data-directory overrides, and `codex-usage autostart status --json` before migration. Use the old installation's CLI to disable autostart and stop its service. Keep its managed Skill so installing the new Skill can back it up and update its CLI path. Do not install both package names into the same prefix.

With a compatible Node/npm on PATH, substitute the actual old prefix below (script installs normally use `%LOCALAPPDATA%\CodexUsage\tools`; regular npm installs use `npm prefix --global`):

```powershell
codex-usage autostart disable
codex-usage stop
$prefix = Join-Path $env:LOCALAPPDATA 'CodexUsage\tools'
npm uninstall --global --prefix $prefix codex-detailed-usage
if ($LASTEXITCODE -ne 0) { throw 'Legacy package removal failed' }
npm install --global --prefix $prefix @esoren/codex-usage
if ($LASTEXITCODE -ne 0) { throw 'Scoped package installation failed; keep the data directory and retry' }
& (Join-Path $prefix 'codex-usage.cmd') skill install
& (Join-Path $prefix 'codex-usage.cmd') start --json
```

Preserve the old data-directory environment overrides and re-enable autostart only if previously enabled. The uninstall removes the old npm package, not the external cache or Codex records. If this installation only has a private npm runtime, use the Node/npm invocation shown below for both uninstall and install. Verify the new installation before reporting migration complete.

### Uninstall

For a regular scoped npm installation, run `codex-usage autostart disable`, `codex-usage stop`, and `codex-usage skill uninstall`, then `npm uninstall --global @esoren/codex-usage` using its actual prefix. For a script-managed installation:

```powershell
codex-usage autostart disable
codex-usage stop
codex-usage skill uninstall
$prefix = Join-Path $env:LOCALAPPDATA 'CodexUsage\tools'
$packageName = if (Test-Path -LiteralPath (Join-Path $prefix 'node_modules/@esoren/codex-usage/package.json')) { '@esoren/codex-usage' } else { 'codex-detailed-usage' }
$runtimeRoot = Join-Path $prefix 'runtime'
$privateNpm = if (Test-Path -LiteralPath $runtimeRoot) {
  Get-ChildItem -LiteralPath $runtimeRoot -Directory | Where-Object { $_.Name -match '^node-v(22|24|26)\.\d+\.\d+-win-x64$' } |
    Sort-Object { [version]($_.Name -replace '^node-v|\-win-x64$', '') } -Descending |
    ForEach-Object { Join-Path $_.FullName 'node_modules/npm/bin/npm-cli.js' } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if ($privateNpm -and (Test-Path -LiteralPath $privateNpm)) {
  & (Join-Path $prefix 'node.exe') $privateNpm uninstall --global --prefix $prefix $packageName
} else {
  npm uninstall --global --prefix $prefix $packageName
}
```

For a custom installation prefix, substitute the actual prefix. The user's cache, startup launcher file, logs, managed Skill backups, and optional private Node runtime are retained. Remove retained files or PATH entries only when the user requests full cleanup and after verifying their exact ownership and paths. Never delete the user's Codex source records.
