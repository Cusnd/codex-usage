# npm release plan

## Cross-platform release candidate — 0.1.3

The candidate supports Windows x64 and macOS x64/arm64 with Node 22.13+ (22.x), 24.x and 26.x. The native compatibility matrix passed all 18 jobs for the implementation; see [compatibility status](MACOS_COMPATIBILITY.md). The independent `main` and `master` histories were joined by merge commit `b9556ab`, preserving the validated tree and both histories. Completed branches were retired; their worktree directories remain intact at detached commits.

Version 0.1.3 is undergoing final CI and exact-archive verification. Publication is not yet confirmed. Evidence is stored under `release-artifacts/npm-esoren-0.1.3/`. Desktop spot checks are optional follow-up, not a compatibility release gate.

## First release completed — 2026-09-09

`@esoren/codex-usage@0.1.1` was published publicly with the `latest` tag. The authenticated publisher was `sorenliu`, verified as owner of the `esoren` organization. Anonymous registry access, registry metadata, SHA-512 integrity, and the downloaded tarball's SHA-256 were verified. The downloaded registry archive passed the isolated installation/lifecycle smoke test.

Local evidence is in `release-artifacts/npm-esoren-0.1.1/`: candidate archive, `SHA256SUMS`, pack manifest, registry metadata, registry download and release receipt. SHA-256: `150f4c77be3e2fea175488b736dbf0312475b24b72834853cf79f4222dab91bc`.

This package was built from the current working tree, including uncommitted application changes; it is not represented by the existing Git HEAD alone. Source status and the baseline revision are recorded in the receipt. This npm publication did not create a Git commit, push source, or replace a GitHub Release.

## LTS compatibility release completed — 0.1.2

The published package supports Windows x64 on Node 22.13+ (22.x), 24.x and 26.x. The public install command is `npm install -g @esoren/codex-usage`. It also fixes managed shutdown with unused HTTP connections and bundled Skill copying from Unicode paths on Node 22.23.2.

All six Windows runtimes (22.13.0, 22.23.2, 24.0.0, 24.21.0, 26.0.0 and 26.8.1) passed type checks, 49 tests, builds, service smoke checks and isolated npm installation/lifecycle checks. Evidence and the exact candidate are under `release-artifacts/npm-esoren-0.1.2/`.

Published publicly after npm browser authentication. The official registry now reports `latest: 0.1.2` and the supported engines. Registry SHA-512 integrity and downloaded SHA256 match the validated candidate. An unpinned `npm install -g @esoren/codex-usage` in an isolated prefix on Node 24.21.0 passed the full installation/lifecycle smoke test. No Git commit, source push or GitHub Release was created.

## Release target

- Public scoped npm package: `@esoren/codex-usage`; CLI remains `codex-usage`.
- Candidate version: `0.1.3`, subject to availability under the chosen scope.
- Supported platforms: Windows x64 and macOS x64/arm64, Node.js 22.13+ (22.x), 24.x, or 26.x.
- Ship the CLI, compiled server/shared code, built web assets, Skill, runtime helper, license and user documentation.
- Keep existing GitHub Release installation working while adding npm installation.

## Prepare and verify

1. Set the confirmed scoped name in `package.json` and synchronize `package-lock.json`. Remove `private: true` only once the target is confirmed.
2. Check the registry for the exact package and version and verify the logged-in npm account has access to the scope.
3. Update installation and uninstall examples in both languages. Adapt the GitHub installer for the scoped installation directory and tarball naming before publishing a new GitHub Release. Preserve the existing Skill ownership marker for upgrade compatibility.
4. Run `npm test`, `npm run build`, and `npm run smoke`.
5. Run `npm pack --json --pack-destination release-artifacts`. The `prepack` hook builds from current source. Inspect the file list for required assets and excluded local data, credentials, generated previews and development files.
6. Set `CODEX_USAGE_TEST_TARBALL` to the absolute candidate tarball path, then run `npm run package:smoke`. This verifies that exact archive in an isolated temporary global prefix, including service lifecycle, API/assets, Skill installation, startup and data preservation.
7. Save its SHA-256 and npm integrity value. Record the source revision and any uncommitted source changes so the candidate can be traced. Any source changes after validation require a fresh package and relevant checks.

## First publication

The maintainer completes `npm login --registry=https://registry.npmjs.org/` and any browser/2FA prompts personally. Do not put passwords, OTPs or npm tokens in this repository or task messages.

Use the exact validated tarball, rather than rebuilding implicitly at publication time:

```powershell
npm whoami --registry=https://registry.npmjs.org/
npm publish <validated-tarball.tgz> --access public --registry=https://registry.npmjs.org/ --dry-run --ignore-scripts
npm publish <validated-tarball.tgz> --access public --registry=https://registry.npmjs.org/ --ignore-scripts
```

The final publish is performed after the package target and candidate are reviewed. A dry run is not evidence of publishing permission or version availability. Authentication and 2FA may still be required at publication time.

## Registry verification and installation

Allow time for npm's publish-time scan before treating an initial registry 404 as a failed publish. npm documents a typical delay of about five minutes, sometimes 15 minutes or more. `npm dist-tag ls @esoren/codex-usage` can work while the package is still unavailable. Do not republish or change the version merely because the first download is not yet available. See [npm publish-time scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).

After publication, read back `name`, `version`, `dist.integrity`, `bin`, `engines`, `os`, and `cpu` with `npm view` against the official registry. Download the exact registry version with `npm pack @esoren/codex-usage@0.1.3`, compare integrity with the candidate, and run the isolated package smoke test against the downloaded archive.

Users with the supported runtime can then run:

```powershell
npm install -g @esoren/codex-usage
codex-usage --version
codex-usage
codex-usage skill install
```

For subsequent releases, choose a new version; published name/version pairs cannot be reused. Consider GitHub Actions trusted publishing after the first release and npm package ownership are established. Keep automated publication separate from ordinary test runs.

References: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish), [public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
