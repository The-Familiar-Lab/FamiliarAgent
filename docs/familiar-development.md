# FamiliarAgent development and source history

The product repository is [The-Familiar-Lab/FamiliarAgent](https://github.com/The-Familiar-Lab/FamiliarAgent). Use commits and branches to preserve working versions. Keep one installed `/Applications/FamiliarAgent.app`; generated app bundles are disposable build outputs, not source backups.

The first commit, `7171e0f` (`Import pinned Paseo baseline for FamiliarAgent`), preserves the imported Paseo baseline. FamiliarAgent changes follow it as separate commits. Upstream license notices, attribution and internal `@getpaseo/*` package names remain where the reused code requires them. Do not rewrite that baseline merely to rename the product.

## Local verification

Use Node.js 24 and npm from the product repository root. Both dependency trees have committed npm lockfiles; the Discord connector is intentionally installed separately from the root workspaces.

Desktop packaging also uses the root npm lockfile. Keep package-manager metadata consistent with that choice: an inherited pnpm declaration selects the wrong dependency collector, whose fallback rejects security overrides that intentionally replace an upstream dependency range. The npm collector uses the installed, override-aware dependency graph.

```sh
npm ci --no-audit --no-fund
npm ci --prefix integrations/discord-connector --no-audit --no-fund
npm run prisma:generate --prefix integrations/discord-connector -- --schema=prisma/schema.prisma
npm run build:server
npm run build --workspace=@getpaseo/expo-two-way-audio
npm run verify:familiar -- --integration
```

Generate the connector's Prisma client explicitly after installation: a prefix install can run its postinstall hook from a different initial directory and leave generic client stubs. `prisma:generate` creates the typed client from the committed schema; it does not migrate or open a database.

Building the server also builds its shared packages and the CLI. The real MCP transport regression invokes that compiled CLI. The two-way audio package needs its declarations for app type checking. Run builds before verification; a concurrent clean build can remove outputs while another process is using them.

During editing, `npm run verify:familiar -- --workspace --app` selects affected areas. Supported scopes are `desktop`, `workspace`, `server`, `app`, `discord` and `cli`. The default checks all six. `--integration` additionally runs real HTTP/WebSocket and MCP transports against temporary local daemons with test providers. The runner limits parallel work and gives each check a four-minute deadline.

Reports and per-check logs are saved to `../work/familiar-verification/`, outside the product checkout. Verification does not launch Electron, log into Discord, call a paid model, install a remote server or read production conversation state. Real account, SSH and final macOS UI checks are separate release validation.

## GitHub checks

`.github/workflows/ci.yml` runs **FamiliarAgent checks** on pushes to `main`, pull requests targeting `main`, merge queues and manual dispatch. It uses Ubuntu 24.04, Node.js 24, the two npm lockfiles, the builds above and the bounded verification runner. It needs no repository secrets. Its GitHub token has read-only repository contents access, and checkout does not persist Git credentials. New commits cancel superseded checks for the same pull request or ref.

Verification logs are retained as a GitHub Actions artifact for seven days, including failed checks when logs exist. CI resolves their directory to an absolute path before upload; artifact path patterns cannot contain `..`. No app package is produced by this workflow. A passing check establishes the automated scope above; it does not establish that every external harness, account or operating system has been exercised.

The inherited Paseo deployment, Docker publishing, release, rollout, EAS/mobile, desktop packaging and Nix-update workflows were removed from the active workflow directory. Their earlier contents remain in the baseline commit. The old `scripts/ci-workflow.test.mjs` was removed because it asserted that retired infrastructure. There is no automated website, relay, npm, container or application release publishing in the FamiliarAgent workflow.

Some upstream release/deploy commands remain in package scripts and upstream documentation for provenance. Do not use `release:*`, upstream deploy scripts or `npm version` as FamiliarAgent publishing shortcuts: they can update package versions, stage changes or target original package names and infrastructure. A FamiliarAgent release pipeline needs its own reviewed destinations, signing and distribution policy before being enabled.

## macOS development package

On an Apple Silicon Mac, build the current source into one reusable output directory:

```sh
npm run build:desktop -- --dir --mac --arm64
```

This exports the web UI, compiles the desktop host, builds the server/CLI, bundles the built-in plugins and Discord bridge, and packages the remote runtime. The app output is `packages/desktop/release/mac-arm64/FamiliarAgent.app`. Validate that bundle, quit the installed app, and replace `/Applications/FamiliarAgent.app`; do not create another renamed backup app. Keep the current installed app until the replacement has built successfully. Rebuilding overwrites the build output, while Git preserves the source revision. Remove the disposable build bundle after the installed version has passed its final checks.

The current development macOS package is ad-hoc signed and is not notarized for public distribution. A source tag does not imply an Apple-signed release.

## Remote runtime packaging

The remote bundle contains npm archives of the current CLI/server and their internal workspace dependencies, with a generated npm lockfile. External direct versions come from the root lockfile; scoped dependency overrides come from the root package manifest. Internal packages must resolve to the bundled archives. Generating the remote lock can access the npm registry, and its integrity-pinned result travels with the bundle. It does not mutate the product lockfile.

On the target host, setup prepares Node.js and a user-scoped launcher. An update installs the bundle's dependencies in a private staging directory while the existing server remains available. The installer checks retained agent states before staging and again before stopping, then replaces the complete runtime and verifies the daemon's workspace API. A failed replacement restores the prior runtime and build digest. User state is outside this transaction.

The final idle check and daemon shutdown are separate operations; they do not provide an atomic admission lock against a new turn starting in that interval. Updates should be applied while work is idle. The installer rejects a pending recovery directory rather than overwriting it, and a verified unchanged bundle needs no dependency download.

The 0.12.0 dependency check covered the actual Mac bundle and installed Ubuntu runtime, not just the monorepo's production-labelled dependency graph. No matching known advisories remained in their physically included package versions in the checked npm audit snapshots. The separately generated portable runtime lock also passed `npm audit --omit=dev`. This is a dated package check, not a complete security audit; inherited website, mobile and development dependency graphs still have findings.

AI SDK is pinned to 5.0.220: it includes the provider-utils advisory fix without introducing the vulnerable Undici 5/busboy 2 chain found in the newer 5.0.273 release. The app's development-only WebSocket constraint retains the compatible upstream Wrangler placement; the desktop, server, CLI and relay use WebSocket 8.22.0. The server uses Node.js UUID generation instead of the additional UUID package.

## Daily changes and releases

1. Start a focused branch from the current `main`, and keep source changes and relevant documentation together.
2. Run the affected checks locally, then the complete verification before requesting review.
3. Inspect `git diff` and `git status` before committing. Exclude app bundles, runtime archives, dependency folders, local test outputs, credentials and user conversation data.
4. Push the branch and open a pull request. After the first successful GitHub run, configure branch protection to require **FamiliarAgent checks** if repository policy calls for it. This document does not change repository settings.
5. Review the source diff and check results, then merge. Tag a reviewed release commit only when its separate packaging and actual app validation are complete.

Keep packaged installers in a deliberate release destination when a release is published; do not retain a new installed app copy for every debugging attempt. Git records source history, while the canonical user data directory `~/.local/share/familiaragent/` remains outside Git and is not replaced by a checkout, build or reinstall. Source control is not a backup for user data.

The workflow definition and local commands can be validated before pushing. A GitHub-hosted run is verified only after Actions reports its result; local validation alone is not evidence that the hosted job has passed.
