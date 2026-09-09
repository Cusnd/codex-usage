# npm releases

## macOS cleanup patch completed — 0.1.4

This follow-up fixes an intermittent macOS RPC cleanup failure discovered in a post-release main-branch run. A zero-signal process-group probe returning `EPERM` now keeps cleanup in its bounded wait/escalation path; actual termination signals retain their permission checks. The native regression injects the inconclusive probe into a real process group with a descendant that ignores SIGTERM, and verifies that cleanup still terminates it.

`@esoren/codex-usage@0.1.4` was published publicly on 2026-09-09 from annotated tag [`v0.1.4`](https://github.com/Cusnd/codex-usage/tree/v0.1.4), commit `3a14dfe0dc4665677e4de77244ab6e2e10bfad7d`, after [PR #5](https://github.com/Cusnd/codex-usage/pull/5) and release [PR #6](https://github.com/Cusnd/codex-usage/pull/6). The [release workflow](https://github.com/Cusnd/codex-usage/actions/runs/34345499737) succeeded on its first attempt: all 18 native platform/runtime checks passed, and the exact uploaded archive passed installation/lifecycle checks. The registry reports `latest: 0.1.4`.

The downloaded registry archive matches the workflow's full SHA-512 integrity and the registry provenance subject. The provenance payload identifies the same source commit, tag and `publish.yml`; no independent signature verification was performed. SHA-256: `b98301959e77a2eeb23dd5cb4d8921a2545aaa1a33e2e72c792b3497bb893fac`. Evidence is under `release-artifacts/npm-esoren-0.1.4/`, including `published-release-receipt.json` and the official archive in `registry/`.

The earlier local candidate has a different archive hash: 40 of 44 files are byte-identical; three files differ only by CRLF/LF line endings, and `dist/web/index.html` additionally differs by one blank line. The complete comparison is recorded in `candidate-registry-comparison.json`; all file contents agree after those documented whitespace differences. The published archive is identified by the workflow and registry hashes above.

The official registry download also passed the full isolated Windows installation/lifecycle smoke test on the minimum supported Node 22.13.0, including concurrent/repeated startup, API/assets, port conflicts, Skill installation, reinstall/data preservation, migration and shutdown. Its log is `registry/package-smoke-node22.13.0.log` in the evidence directory.

## Cross-platform release completed — 0.1.3

The candidate supports Windows x64 and macOS x64/arm64 with Node 22.13+ (22.x), 24.x and 26.x. The native compatibility matrix passed all 18 jobs for the implementation; see [compatibility status](MACOS_COMPATIBILITY.md). The independent `main` and `master` histories were joined by merge commit `b9556ab`, preserving the validated tree and both histories. Completed branches were retired; their worktree directories remain intact at detached commits.

`@esoren/codex-usage@0.1.3` was published publicly on 2026-09-09 through GitHub Actions Trusted Publishing, from annotated tag [`v0.1.3`](https://github.com/Cusnd/codex-usage/tree/v0.1.3), commit `6ceaf7e8bc863593f836fae18da3739faf33a90c`. It initially became `latest` and was superseded by 0.1.4. The [release workflow](https://github.com/Cusnd/codex-usage/actions/runs/34338249802) passed all 18 native platform/runtime combinations and tested the exact archive before uploading it.

The registry download's SHA-512 matches npm metadata and the registry provenance subject; provenance identifies the same tag, source commit and `publish.yml` workflow. SHA-256: `891ed7da59629940b24bff680dbfb6972294624170ba5634b7cee274b782660d`. The full archive, metadata, attestations and verification receipt are stored under `release-artifacts/npm-esoren-0.1.3/registry/` and `release-artifacts/npm-esoren-0.1.3/published-release-receipt.json`. Desktop spot checks remain optional follow-up, not a compatibility release gate.

The downloaded registry archive passed the full isolated Windows installation/lifecycle smoke test on Node 22.13.0, including three occupied-port attempts that returned explicit CLI errors and a check that every synthetic Node process exited before cleanup.

The first upload succeeded but its 50-second registry verification window expired while npm's publish-time scan was pending. Registry availability was then verified separately, and the failed job was rerun successfully: the existing version, channel and rebuilt archive integrity matched exactly. Subsequent release jobs allow up to 20 minutes for availability, log the full expected integrity before publishing, and retain a bounded overall job timeout. Upload acceptance and verified registry availability are separate outcomes.

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
- Current release: `0.1.4` on the `latest` channel.
- Supported platforms: Windows x64 and macOS x64/arm64, Node.js 22.13+ (22.x), 24.x, or 26.x.
- Ship the CLI, compiled server/shared code, built web assets, Skill, runtime helper, license and user documentation.
- Keep existing GitHub Release installation working while adding npm installation.

## Prepare and verify

The release instruction authorizes completing the current develop release, including necessary fixes and their relevant checks, integration, versioning, publication and cleanup. Follow the authorization and stopping rules in the [project workflow](../.agents/workflow.md). Routine fixes do not restart approval. The historical receipts above describe past investigations, not mandatory checks for every release.

1. Set the confirmed scoped name in `package.json` and synchronize `package-lock.json`. Remove `private: true` only once the target is confirmed.
2. Check the registry for the exact package and version and verify the logged-in npm account has access to the scope.
3. Update installation and uninstall examples in both languages. Adapt the GitHub installer for the scoped installation directory and tarball naming before publishing a new GitHub Release. Preserve the existing Skill ownership marker for upgrade compatibility.
4. Complete the platform matrix for the final candidate, or reuse a successful run for the exact same Git tree. Do not repeat it merely because squash/merge changes the commit SHA. Relevant content changes require new validation.
5. The release job builds once, then packs with `--ignore-scripts` so the prepack hook does not build again. It inspects the file list and records the archive integrity and source commit.
6. The release job sets `CODEX_USAGE_TEST_TARBALL` and runs `npm run package:smoke` against that exact archive, then uploads the same file. A second local candidate build and full smoke run are not prerequisites for an already validated automated release.

## First publication

The maintainer completes `npm login --registry=https://registry.npmjs.org/` and any browser/2FA prompts personally. Do not put passwords, OTPs or npm tokens in this repository or task messages.

Use the exact validated tarball, rather than rebuilding implicitly at publication time:

```powershell
npm whoami --registry=https://registry.npmjs.org/
npm publish <validated-tarball.tgz> --access public --registry=https://registry.npmjs.org/ --dry-run --ignore-scripts
npm publish <validated-tarball.tgz> --access public --registry=https://registry.npmjs.org/ --ignore-scripts
```

The user's release instruction authorizes the final publish within the agreed scope; do not request approval again for each routine step. A dry run is not evidence of publishing permission or version availability. Authentication and 2FA may still be required for a manual first publication.

## Registry verification and installation

Allow time for npm's publish-time scan before treating an initial registry 404 as a failed publish. npm documents a typical delay of about five minutes, sometimes 15 minutes or more. `npm dist-tag ls @esoren/codex-usage` can work while the package is still unavailable. Do not republish or change the version merely because the first download is not yet available. See [npm publish-time scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).

Publication is complete when the release script confirms registry availability, the intended version/channel and integrity matching the archive already tested before upload. This is one bounded verification stage; stop checking after it succeeds. Report the result, synchronize branches and finish cleanup.

Do not routinely download the published archive for another full smoke test, compare it file by file with an earlier local candidate, or make formatting differences a new release gate. Investigate only a concrete anomaly such as a registry integrity mismatch or a reported installation failure. A successful release workflow already supplies the completion evidence; no separate local re-verification is required.

Users with the supported runtime can then run:

```powershell
npm install -g @esoren/codex-usage
codex-usage --version
codex-usage
codex-usage skill install
```

For subsequent releases, choose a new version; published name/version pairs cannot be reused. Follow the [project workflow](../.agents/workflow.md): merge the version into `main`, then push its annotated version tag to trigger GitHub Actions Trusted Publishing. Ordinary test runs do not publish packages.

References: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish), [public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
