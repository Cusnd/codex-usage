# Linux support

Linux x64 and arm64 use the same local dashboard and collector as Windows and macOS. Supported Node versions remain 22.13+ within 22.x, 24.x, and 26.x. Install a verified candidate or released package into a user-owned npm prefix, then run:

```sh
npm install --global @esoren/codex-usage
codex-usage doctor --json
codex-usage start
```

This document describes the implementation in this source tree; it does not claim that an npm release containing it has been published. Use the candidate archive when checking an unreleased implementation.

| Item | Linux behavior |
| --- | --- |
| Data and manual-service logs | `$XDG_DATA_HOME/CodexUsage`, or `~/.local/share/CodexUsage` when unset. Relative XDG values are ignored. |
| Explicit data directory | `CODEX_USAGE_DATA_DIR` must be absolute. Existing data stays in place; no original Codex files are moved. |
| Codex source records | `~/.codex`, overridden by `CODEX_HOME`; originals stay read-only. |
| User autostart unit | `$XDG_CONFIG_HOME/systemd/user/codex-usage.service`, defaulting to `~/.config/systemd/user/codex-usage.service`. |
| Isolated startup testing | `CODEX_USAGE_STARTUP_DIR` redirects the unit and its `default.target.wants` link together. |
| Browser | `xdg-open` opens the loopback URL when DISPLAY or WAYLAND_DISPLAY is present. |
| Single instance | A loopback listener protects the real data-directory path, retaining POSIX case. A collision fails without stopping the other listener. |

On a server without a desktop, use `start` and open the printed loopback URL from an appropriate local browser or an SSH tunnel. `open` reports the manual URL and returns an error when no browser can open; the running service remains available. For cloud binding, use `cloud connect --no-open` and follow the verification URL in its response. The service always binds to loopback.

`autostart enable` writes a managed systemd user unit, validates it using `systemd-analyze --user verify`, creates its `default.target.wants` link, and reloads user-unit definitions. This is registration for the next user-manager startup; it does not start a stopped service. `autostart disable` removes only the owned unit and link, reloads definitions, and leaves an already running process alone. The service is a foreground Node process with `Restart=no`, so `codex-usage stop` does not trigger a restart.

The commands require a non-root user with an available systemd user manager. They neither use root nor turn on lingering. An unavailable manager appears as `supported: false` with a reason in `autostart status`, `doctor`, and the settings API. Ordinary background `start` still works. Whether services survive the final logout is controlled by the system's existing user-manager policy. Native unit logs are available with `journalctl --user -u codex-usage.service`.

The unit captures the current absolute Node and service paths, PORT, PATH, data directory and explicit Codex/XDG overrides. Only this environment allowlist is written; credentials and arbitrary environment variables are not copied. Spaces, Chinese characters, percent specifiers and dollar signs are escaped for systemd. Unmanaged units, symlinks, or registrations for another data directory are reported as conflicts and retained.

After changing Node or the npm installation path: stop the service, update the package, reinstall an installed Skill, and re-enable previously enabled autostart to refresh the recorded paths. Then `start` the service. To uninstall:

```sh
codex-usage autostart disable
codex-usage stop
codex-usage skill uninstall
npm uninstall --global @esoren/codex-usage
```

Data and Skill backups remain.

The platform workflow keeps the existing Windows/macOS targets and adds `ubuntu-24.04` x64 and `ubuntu-24.04-arm` arm64 for all six Node versions. All 30 jobs are required for reusable CI evidence; the old 18-job record is insufficient. Linux package smoke covers an installed archive, Chinese/space paths, default and explicit data directories, headless browser feedback, missing user manager, concurrent startup, identity checks, shutdown, reinstall/data preservation, guard and port collisions. When a real user manager is available it also validates and starts a uniquely named runtime-only unit, checks that its MainPID is the service, and verifies that disabling autostart preserves the process and stopping does not restart it. This temporary unit is never enabled for login. A missing user manager prints `NOT VERIFIED` for that lifecycle check.

The test suite does not establish logout/login, suspend/resume, Linux arm64 hardware behavior or a successful 30-job GitHub run merely by generating files. Record those results separately from unit tests and local x64 runtime checks.

References: [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/), [systemd service definitions](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml), [systemctl enable/disable semantics](https://github.com/systemd/systemd/blob/main/man/systemctl.xml).
