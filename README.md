# FamiliarAgent

FamiliarAgent connects existing agent tools, conversations and project folders across machines. Its macOS app provides a common place to switch tools, share working context and continue a logical session while each original harness keeps control of its model loop, permissions and orchestration.

The desktop and runtime build on Paseo 0.11.1, reusing its chat, providers, terminals, editor, file explorer, Git worktrees, browser panels and plugin system. FamiliarAgent adds the integration layer; it is a separate project and is not an official Paseo release.

**Current source version: 0.16.3.** Pullboard now opens its original live web view automatically in the same project on local and SSH hosts. Private browser tabs keep the original process in its terminal and offer **Open Pullboard** for reopening. Adds verified native installers for infrastructure tools, Cursor and Antigravity CLI setup, Linux Orca runtime support, and fixes for Electron installation recipes, superharness dependencies and Claude Squad input detection. Includes direct project dragging, guided account-first setup, configurable setup agents and reusable Codex/Claude connections for Goose. Start with the [setup and composition guide](docs/setup-and-composition.md); original tool actions and their native prerequisites are documented in the [native actions guide](docs/native-tool-actions.md).

- [Tool-by-tool installation and verification scope](docs/tool-verification.md)
- [Using Familiar Hub](docs/familiar-hub.md)
- [Native tool actions, result connections and verified scope](docs/native-tool-actions.md)
- [Development, verification and source history](docs/familiar-development.md)
- [Changelog](CHANGELOG.md)
- [Source repository](https://github.com/The-Familiar-Lab/FamiliarAgent)

## What it connects

| Area                 | Current behavior                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects and servers | **All servers** brings connected hosts together. Link existing folders on each machine and choose a destination for each operation.                                                                                         |
| Sessions             | Link a native conversation or an external history source. **Switch tool & continue** keeps the logical session; **Fork session here** creates a separate branch.                                                            |
| Selected results     | **Use result…** connects a verified completed response to another native input in the same logical session. **Inputs / Results** shows source, destination and delivery status.                                             |
| Shared context       | Revisioned memory, bounded continuation context and MCP access to original conversation pages. Conflicting writes are rejected.                                                                                             |
| Tools and interfaces | Open supported native terminal and web interfaces inside FamiliarAgent, or launch installed desktop apps in their own windows. Register a command or URL, use available install recipes, or choose **Ask agent to set up**. |
| Skills and MCP       | Map existing skill directories, inject supported session MCP configuration and explicitly share HTTP MCP definitions. Target-specific paths and executables remain on their owning servers.                                 |
| Files and Git        | Reuse the file explorer, editor, media playback, uploads, downloads and Git/worktree operations. **Separate Git worktree** provides optional isolation.                                                                     |
| History              | Discover supported Cursor, VS Code, Codex, Claude and Antigravity records. Search and hide/restore the index; read the original source on demand. ChatGPT history uses official export JSON.                                |
| Discord              | Optionally connect AI Agent Discord Connector to a native agent or a logical session that follows its active native agent after a tool switch.                                                                              |

The [native actions guide](docs/native-tool-actions.md) describes the new explicit CLI/API adapters, saved settings and result connections, including prerequisites and native workflows that remain unverified. Native workflow checks and final application release checks are recorded separately.

The catalog contains different kinds of entries: CLI launch connections, installed desktop apps and reference projects requiring a command or URL. An entry is not a complete adapter for every feature of that project. Native provider sessions, terminal harnesses and external desktop apps expose different capabilities.

## Continuing work without copying every conversation

A logical session links native executions and source references. Supported agents receive shared context through `familiar_context`, `familiar_history`, `familiar_memory` and `familiar_skills`; the native agent decides when to call those tools. **Shared session connected** identifies linked native chats, and **Open Familiar Hub** returns to their common session.

A fork records its parent revision and history boundaries. Original conversations stay on their owning machine, and later parent messages are excluded from the fork's recorded boundary. Missing or rewritten sources produce an error. Source reads still require I/O and access to the owning server.

Folder mapping does not synchronize code or install a shared filesystem. Each destination needs its own existing checkout, worktree or shared mount. Provider-private heap state, model caches, credentials and unpublished orchestration checkpoints are not portable between arbitrary tools. See the [Hub guide](docs/familiar-hub.md) for the supported flows and limits.

## Installation and data

The current desktop target is macOS; connected Ubuntu/Linux servers run the user-scoped runtime. **Add server** reuses trusted SSH configuration and can install the runtime remotely without root access. Existing agent accounts still require their native authentication flow.

- macOS application: `/Applications/FamiliarAgent.app`
- Mac/Linux data root: `~/.local/share/familiaragent/`
- CLI launcher: `~/.local/share/familiaragent/bin/familiar`

The data root separates application state, desktop settings, Discord configuration, provider tools and runtime files. Explicit environment overrides remain supported. Migration checks for running processes and conflicting stores before moving legacy data; it does not merge unrelated stores automatically. A checkout or application reinstall does not replace user data.

SSH and daemon ports are separate settings and are preserved from the selected connection profile. Shared context access is scoped to the linked sessions and sources. Relevant session changes renew those connections; failures retain the saved session and provide a recovery error. Runtime updates are deferred while an agent is working or its state cannot be established.

Keep one installed app and use Git for source versions. Local builds without a configured FamiliarAgent update feed use manual updates. The upstream Paseo updater does not replace this app.

## Build and verify

Use Node.js 24 and the committed npm lockfiles. The Discord connector has a separate dependency tree. The [development guide](docs/familiar-development.md) describes the complete setup, required builds, CI scope and release procedure.

After setup and prerequisite builds:

```sh
npm run verify:familiar -- --workspace --app
npm run verify:familiar -- --integration
```

The verification runner checks types, lint, targeted regressions and temporary daemon transports without opening the app. It does not log into real accounts, call paid models or validate every external tool. Actual SSH, provider and final macOS UI checks are separate.

To build a local Apple Silicon app after verification:

```sh
npm run build:desktop -- --dir --mac --arm64
```

The output is `packages/desktop/release/mac-arm64/FamiliarAgent.app`. A local ad-hoc signed build is not a Developer ID signed and notarized release. Do not use inherited upstream release or deployment commands as FamiliarAgent publishing shortcuts.

## Source and licenses

FamiliarAgent retains Paseo's Apache-2.0 license and original attribution. The pinned upstream commit is recorded in [UPSTREAM.json](UPSTREAM.json); the original README is preserved in [UPSTREAM-README.md](UPSTREAM-README.md). Internal `@getpaseo/*` package names remain where the reused code requires them. FamiliarAgent's product version is maintained separately from those upstream package versions.

AI Agent Discord Connector is included under MIT in [integrations/discord-connector](integrations/discord-connector), with its [license](integrations/discord-connector/LICENSE) and [source record](integrations/discord-connector/UPSTREAM.json). History-reader source attribution and component licenses are recorded in [THIRD-PARTY.txt](plugins/familiar-workspace/THIRD-PARTY.txt).

See [LICENSE](LICENSE) and [NOTICE-FamiliarAgent.md](NOTICE-FamiliarAgent.md) for the retained license and modification notices. Referenced tools that are launched externally retain their own installation, account and license requirements.
