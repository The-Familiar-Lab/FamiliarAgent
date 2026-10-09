# Run original tools and connect their results

FamiliarAgent invokes an original tool's CLI, API or public runtime methods. The original tool keeps its model loop, sessions, permissions, orchestration and files. FamiliarAgent records the input, original work ID, outcome and connection to the shared session. Opening an original app remains available alongside these actions.

This guide describes the v0.15 setup and native-action implementation checked on 2026-10-09 UTC. Setup checks used actual product-generated installation plans and original runtimes. Earlier installed-desktop checks cover native-action delivery and cross-server reads. These checks do not imply that every feature or provider of every listed project was tested.

## Install or sign in from your session

1. Select the destination server. In **Familiar Hub → Tools**, choose **Set up / Sign in** on the tool card. Selecting a tool from the session also opens its setup dialog instead of silently doing nothing.
2. Choose **Install** when it is missing. For an existing desktop app, **Install integration files** prepares verified action paths while preserving its original profile. Installation opens a terminal on the selected server.
3. Wait for the original installer to finish, select the tool again, then choose **Check setup**. Opening an installer is not installation success; an installed executable is not proof of authentication.
4. Complete the available original setup action, such as **Sign in** or **Choose provider / Sign in**. Credentials stay on their owning server.
5. Return to **Familiar Hub** from the terminal's new-tab menu. It restores the project, logical session, destination server and folder selected before setup. Select the tool and choose **Use in this session** to open its actions or provider choices.

**Use installed paths** saves native action settings without opening an empty terminal. First-install defaults preserve existing settings; explicitly applying installed paths replaces the relevant defaults. Required native choices such as model, planner or existing work ID still belong to the selected action. **Ask agent to set up** remains available for additional prerequisites.

| Tool                | Setup after installation                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code / Codex | **Sign in**, complete the original browser/device flow, then **Check setup**.                                                                                                                                                                                                            |
| Aider               | Select the API provider and **Add API key**. Paste it only into the hidden-input terminal. Return to **Check setup**, select the same provider and **Use saved API key**. A private key file does not prove model access or billing.                                                     |
| Goose               | **Choose provider / Sign in** opens the original provider configuration. Complete its native sign-in, then **Check setup**.                                                                                                                                                              |
| OpenRig             | **Start OpenRig** opens the original workflow. Rigs, seats and their provider accounts remain OpenRig-owned.                                                                                                                                                                             |
| Hydra               | **Start original tool** prepares its dedicated profile/socket and starts the original daemon with the scoped compatibility launcher. Keep its terminal open while using native actions.                                                                                                  |
| Codeg               | **Start original tool** prepares a loopback address and private token file. Then **Use in this session → Run actions → Install Codeg agent** installs the selected original ACP adapter. Authenticate that provider, then use **Create Codeg conversation** and **Send input to Codeg**. |
| OpenHarness         | **Sign in** opens the original account flow; complete it yourself. Then **Check setup → Start native daemon**. **Open native terminal** exposes its TUI. The local daemon/TUI works signed out, but the current public **Start with Harness** command requires the original SSO account. |

## Installation checks and locations

| Destination | Actual product installer checks                                                     | Checks from the permanent installation                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mac         | Orca, Hydra, Codeg, Alethe, Codey, wshobson/agents and OpenHarness: seven installed | Orca CLI version; Hydra daemon/list; Codeg HTTP list and original ACP installer; Alethe tool schema; Codey native chat catalog; agents plugin inspection; OpenHarness signed-out status and local start → running → stop |
| Ubuntu x64  | wshobson/agents, Codeg and Codey: three installed                                   | Native plugin inspection, Codeg HTTP list plus original ACP installer, and Codey's native chat catalog using its private Node runtime                                                                                    |

These are installation/service checks, separate from the real model turns below. No SSO approval or paid model call was performed during these setup checks. OpenHarness's authenticated new-agent workflow still needs the user's original login.

Pinned releases and source builds live under `~/.local/share/familiaragent/state/tools/native/`; dedicated Hydra, Codeg and Codey profiles live under `state/familiar/native/`. Archives are checked against upstream SHA-256 values; source builds verify the original Git commit before running dependency/build scripts. Unrecognized existing installation folders are not overwritten.

Codey installs only the original core/gateway workspaces and a verified private Node 24.21.0 runtime, alongside FamiliarAgent's Node 22 runtime on Ubuntu. OpenHarness uses a pinned, verified original installer. Its runtime versions and updates then follow upstream manifests. That installer retains its official `~/.harness` profile and `~/.local/bin/harness` launcher, updates the shell PATH, and may request an administrator password for missing Linux system packages. Original account stores are not copied into FamiliarAgent.

Automatic archive support follows available upstream releases: Orca currently supports macOS arm64/x64; Alethe supports macOS arm64/x64 and Linux x64. Unsupported architectures show a limitation instead of a ready state. Hydra's Linux source build needs its native build toolchain and was not part of the Ubuntu installation checks above. Original installation methods remain available.

## Start an original action

1. Open **Familiar Hub → Tools**. Select the destination server and an existing project folder on it.
2. Choose **Run actions** on a supported tool card, or select the tool under **Run an original tool**.
3. Select the action. Setup supplies supported installed paths and service settings. Enter remaining choices such as model, planner or original work ID. Existing services can keep their own URL, socket and private credential-file settings. Optional settings are under **Advanced**.
4. Choose **Save settings** to reuse this server's settings for this tool and action. Settings on another server are independent.
5. Run the action using its named button. Its record appears under **Native actions** in the same shared session.

Use an original read/status action first when connecting an existing service. **Use original ID** is offered when that tool has an action accepting the original ID; it selects the record's server, folder and work ID for that follow-up. It does not invent a new native session or import all of its history.

The original interfaces remain available through **Open terminal**, **Open inside FamiliarAgent** and **Open app**, according to each catalog entry's supported surfaces. Desktop apps keep their own windows. Installing FamiliarAgent does not automatically install, configure or log into every external product. **Ask agent to set up** can prepare the native prerequisites; account sign-in and infrastructure access still follow the original product's flow.

## Connect a result to the next tool

From a completed action, choose **Use result…**. In **Inputs / Results**, choose an input-capable original action, its server and settings, add the instruction, then choose **Send input to tool**. Supported native chats also offer **Use result…** on a completed assistant response.

The source and destination stay in the same logical session. The connection retains the selected source's identity and digest. A native-action source selects that action's whole bounded result; it does not select an arbitrary hidden checkpoint or a private in-memory object. The source is read and verified before delivery. A newer unrelated response is not silently substituted.

A completed action's result can also be a structured status, file listing or diagnostic; it need not be an assistant answer. The original tool decides how to process the next input. FamiliarAgent does not create an additional planning or orchestration loop.

Only actions explicitly declared as **prompt inputs** are offered as automatic result destinations. Command and data actions remain available under **Run an original tool**:

- A native model prompt or work-queue task can receive a selected result and instruction.
- A raw terminal, SSH command or tmux pane cannot safely be assumed to be a model prompt. Orca terminal input, Skulk input, bssh execution and Coder execution are command actions.
- A file write or search query is a data action. An agent-result wrapper is not automatically written as file data or executed by a shell.

The exact result envelope remains available to the original tool. In native chat, **Connected result** presents the instruction and selected response; **Original input** shows the original payload. Copy and replay preserve the exact native input.

## Read the outcome

| State       | Meaning                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `running`   | FamiliarAgent's invocation is still active.                                                                                            |
| `submitted` | The original tool accepted the request or queued work. This does **not** mean its agent finished. Use the original read/status action. |
| `completed` | The particular action returned successfully. A completed read/list/create action is not proof of a completed model task.               |
| `failed`    | A definite validation or execution failure was recorded.                                                                               |
| `unknown`   | The invocation ended without establishing whether the original tool accepted or completed the change. It is not automatically retried. |

When an outcome is unknown, inspect the original work. Then select **I checked the original task**, describe what it showed, and choose **Release retry lock** if a new attempt is appropriate. Releasing the lock does not mark the original task successful. Cancelling an invocation is also not a universal cancellation API for an independently running external service.

The list shows previews, not every full input/output. **View full result** reads the full bounded result on demand. **Use result…** also fetches the original full result before creating a connection. Running records are refreshed while the view is open; no permanent per-tool polling service is added. Large output must be narrowed with the native read limits or inspected through its original files/interface.

## Supported original actions and verified scope

There are 85 explicit native actions across dedicated adapters for the following 17 projects. This count describes explicit public operations, not complete compatibility with every internal feature. Claude/Codex native chat providers, the reused Paseo interface, history discovery, editor/app launch entries and Discord are separate parts of FamiliarAgent.

| Original tool                                                           | Actions exposed                                                                                 | Native check / remaining prerequisite                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Aider](https://github.com/Aider-AI/aider) 0.86.2                       | One-shot editor input; read native Markdown chat history                                        | Installed and invoked; the available provider rejected authentication. A successful model answer remains unverified. An exit code of zero with only Aider error output is rejected as a result.                                                                                                                         |
| [Goose](https://github.com/aaif-goose/goose) 1.54.0                     | Run, continue native session, list and export/read session                                      | Real run, same native ID continuation and exported response passed. A cross-server check also read Familiar shared memory through MCP.                                                                                                                                                                                  |
| [OpenRig](https://github.com/mvschwarz/openrig) 0.6.6                   | List seats, submit/read queue work, read seat output                                            | Real native queue submission, agent pickup, `done` transition and agent-authored result passed. Requires an existing native rig/agent seat.                                                                                                                                                                             |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) 1.0.20          | List native sessions, send to an idle Claude composer, read output                              | A native TUI-created worktree/tmux session received input and returned a real answer. Create/manage the native session in the original interface. The adapter rejects panes that cannot be identified as an idle Claude composer.                                                                                       |
| [superharness](https://github.com/artificemachine/superharness) 1.84.1  | Initialize, create/queue tasks, dispatch, delegate, read contract, native SDK run               | Native SDK response and CLI delegate passed. A later full queue check completed all four original contract tasks, with zero active work and three verified output files. Dispatch still returns submitted; separate native contract/status records establish completion. Earlier failed inbox attempts remain recorded. |
| [Orca](https://github.com/stablyai/orca) 1.4.223                        | Create/list terminals, read retained output, send terminal input                                | Original headless runtime, terminal create/send/read and a Claude response passed. Requires a running original runtime and a project registered in Orca. Terminal output is not a structured assistant transcript.                                                                                                      |
| [Hydra](https://github.com/jpdlr/hydra) 0.2.61                          | Prepare compatibility launcher, list/start/read headless runs                                   | Original Claude headless run completed with a real response. Its original CLI arguments require the narrowly scoped launcher described below. The old Codex `-q` path is not offered.                                                                                                                                   |
| [Codeg](https://github.com/spacering-net/codeg) 0.34.0                  | Install native ACP adapter; list/create/read conversation; send through ACP                     | Original backend created a conversation, connected its native Claude ACP agent and persisted a completed assistant turn. Requires native agent installation and authentication.                                                                                                                                         |
| [Alethe](https://github.com/Kc1t/alethe-agents) 1.7.0                   | MCP status/delegate/check; standalone native worker run                                         | The original standalone Codex worker reported `worker_done` / `succeeded`. Standalone work is separate from the desktop app's queue. Unsupported policy/model options are rejected after reading the native schema.                                                                                                     |
| [Codey](https://github.com/its-ahoh/codey) 0.13.4                       | List/read/create/continue chats through original gateway methods                                | A real reply and continuation recalling the previous marker used the same native chat ID. Setup builds the original core/gateway, installs private Node 24.21.0 and uses a separate integration-owned profile.                                                                                                          |
| [OpenHarness](https://github.com/autonomous-ai/openharness)             | Native sign-in status, history search, new native task                                          | Official installation, signed-out status and local daemon start/stop passed. The public new-agent CLI needs original SSO; its model task is not yet verified. Native search needs the original local index, not necessarily SSO.                                                                                        |
| [wshobson/agents](https://github.com/wshobson/agents) marketplace 1.7.1 | Inspect selected plugin; run it through native Claude                                           | Real `python-development:python-code-style` Skill invocation and assistant response verified. This is not a test of every marketplace plugin.                                                                                                                                                                           |
| [Firetower](https://github.com/firetower-cloud/firetower) 0.44.0        | Worker diagnostics; hosts/readiness/repositories; sessions/conversation/files; create/send/stop | Original authenticated server created a ClaudeCode workspace, reached Ready, accepted a prompt, returned a real completed assistant turn through native conversation history, listed files and returned to HandedBack after stop. Codex still needs the original adjacent code-mode host prerequisite.                  |
| [Skulk](https://github.com/frantufro/skulk) 0.7.1                       | Doctor/list/new/status/logs/diff/send/archive                                                   | Actual Mac→Linux SSH worktree/tmux create/status/logs/diff/archive passed. Raw pane input is a command action, not an automatic prompt destination.                                                                                                                                                                     |
| [bssh](https://github.com/lablup/bssh) 3.0.1                            | Ping, parallel command, upload/download                                                         | Actual SSH command and byte-identical file round trip passed. Existing OpenSSH policy is resolved into an isolated compatible configuration; unsupported algorithms/configurations fail.                                                                                                                                |
| [Coder](https://github.com/coder/coder) 2.36.7                          | List templates/workspaces, show/create/start/stop, execute through native SSH                   | A real template provisioned its original workspace agent; lookup, command, stop/start and command after restart passed. Existing Coder service, template and native login are required.                                                                                                                                 |
| [JuiceFS](https://github.com/juicedata/juicefs) 1.4.1 CE                | Status, list/read/write/mkdir, upload/download                                                  | Real SQLite metadata/file-object volume plus authenticated WebDAV passed, including native sync and byte-identical special-character filenames. A production multi-server volume still needs a shared reachable backend.                                                                                                |

The model-backed checks above used the original native execution paths. Separate regression tests use controlled processes and responses to test failures, cancellation, size limits, identity checks, retries and UI state. Mock tests are not counted as real model/infrastructure checks.

## Native setup details

Prefer the original project's supported installer and login flow. Place binaries in an enduring user-owned location, not in a temporary validation directory. Familiar's tool discovery includes `$PASEO_HOME/tools/bin` and the configured search path; with the default layout this is `~/.local/share/familiaragent/state/tools/bin`. Actions with an executable setting can use an explicit path.

Keep credentials in the original product's account store or a private file/environment value on its owning server. Do not paste tokens into prompt text. Codeg and Alethe accept a token-file path; Firetower and JuiceFS use private profile files. The field description identifies the required format and native endpoint.

- **Goose / Aider:** configure and authenticate an original provider. Model access in another app does not automatically authorize it in these tools. Goose's Claude Code provider is a separate native process; continuation uses the original session and a bounded recent-history restoration when needed.
- **Claude Squad / OpenRig:** create the original tmux/worktree session or native rig/seat first. Familiar's actions attach to those native identities. A source label in OpenRig is not a live seat endpoint; queue transitions and captured output remain authoritative.
- **superharness:** install the original Python entrypoint and `claude-agent-sdk`, then initialize its project. Its unattended SDK/Claude execution uses the original bypass-permissions mode; `run`, `delegate` and `dispatch` require an explicit `bypassPermissions` setting. Familiar does not silently select it. Successful task creation or queueing alone is not successful orchestration. The later queue check used adapter defaults and the original non-PTY CLI path: four tasks reached done, no active queue entries remained, and three output file contents/hashes matched. Native close removed its worktree before dispatcher cleanup, leaving a warning and stale path display; the actual folder was absent and no task remained active. This queue check did not verify a model MCP call.
- **Orca:** install/start the original app or headless runtime, install its CLI and register the project. The original headless install requires its pinned Node runtime, artifact hashes and native PTY components. A packaged Electron profile and an `orcad` data root have different environment contracts.
- **Hydra:** use **Set up / Sign in → Install → Start original tool**, or supply an existing original `out/main/daemon.js` and native PTY dependency. **Prepare Hydra launcher** takes the entry path, dedicated profile, socket and Node executable and returns a launcher artifact. Preparation does not start the daemon or modify its profile. Execute the returned native command, then use the same socket for actions. For verified Hydra 0.2.x, the launcher adds only the missing `--verbose` to Claude print/stream-json arguments. Other commands stay unchanged; unexpected versions/modes fail. Keep the profile separate from a running desktop profile.
- **Codeg:** **Start original tool** prepares its dedicated server and private token file. **Install Codeg agent** invokes the original ACP installer with `cleanFirst=false`; authenticate its original provider before sending a task. Existing services can keep their own URL/token-file settings. Sending reads the conversation's owning folder and native session ID and asks the original backend to connect/resume it. It does not substitute the UI's current folder for a different original conversation.
- **Alethe:** select the original MCP executable and authenticated Codex executable for standalone work. App-queue access additionally needs its native MCP URL, token file and planner ID. The native `tools/list` decides which read-only/model options are supported. Older native `check` calls can consume deliveries.
- **Codey:** setup builds only the original core/gateway packages with its private Node runtime and compatible native SQLite modules. Existing installations can select their own built checkout and empty dedicated data directory. An unrelated existing profile is rejected; profile access is serialized. The bridge invokes the original public gateway classes, not a new chat loop.
- **agents:** select one actual `plugins/<plugin-name>` directory from the original checkout. Native `--plugin-dir` loads it per invocation without changing global marketplace settings.
- **OpenHarness:** local daemon/TUI use does not require SSO. The public new-agent CLI does, and uses explicit `ask` permission mode plus a checked native agent-ID acknowledgement. Complete its original login for that workflow. History search depends on the native local index, not a fabricated empty result or a blanket SSO requirement.
- **Firetower / Coder:** provide the original server, login, workers or templates. Provisioning follows their native policies. A local development fixture is not a production cloud deployment recipe.
- **Skulk / bssh:** use an existing trusted SSH configuration and installed remote prerequisites. Skulk's original project config owns the branch/worktree/tmux policy. bssh keeps host-key verification and intersects supported algorithms with the configured policy; it does not weaken the user's SSH settings to make a connection succeed.
- **JuiceFS:** point at an existing volume and authenticated WebDAV/native sync endpoint, or deliberately create a separate test volume with the original tool. Familiar folder mapping alone does not mount or synchronize a filesystem.

## Shared session context and actual cross-server composition

Supported launch paths prepare session-scoped context and MCP configuration for the native process. Claude/Codex child command wrappers and Goose extensions reuse the existing Familiar context service. Native execution still decides whether to read that context.

A running external HTTP daemon, an already-open desktop app, an explicitly bypassed executable wrapper or an SDK without a per-invocation MCP option cannot be assumed to inherit those settings. In particular, the verified superharness SDK path has no per-launch MCP configuration hook. Familiar does not rewrite global project configuration to pretend otherwise. An explicit selected-result input remains usable independently of automatic MCP inheritance.

A real two-machine check completed this chain:

1. Original Goose ran on Linux and called `familiar_context` to read shared memory owned by the Mac controller.
2. The user-selected Goose result was captured and passed as input to native Claude with a selected wshobson plugin on the Mac.
3. The Mac response retained the expected shared-memory marker in the same logical session.
4. Replaying the same operation did not send a duplicate task, and the original source stayed intact.

A second real check connected the Linux Goose result to a Mac native Codex agent and received its response. After archiving the Codex source, restarting both daemons and using the normal reconnect/bridge setup path, the archived response was restored and sent back to the same original Goose session ID. Goose replied with the expected shared-memory marker. Replaying the operation preserved the original result and did not create a duplicate send.

The installed desktop UI also completed **Inspect native skill package → Use result… → Original tool → Send input to tool**. The original Claude process returned the requested marker, with both actions and the delivery receipt attached to the same session. Full-result viewing, saved per-server settings and restoration after restart were checked. A completed immutable tool result can also be read through a scoped context connection; its owning store validates the tool, session, folder and content digest before sharing it.

These checks verify those specific native-tool/MCP/result paths. It does not make every private harness heap, checkpoint, credential or file tree portable between arbitrary products.

## Discord and original interfaces

A configured AI Agent Discord Connector can keep using a shared session. Existing chat, status, permission and file controls remain. For a channel bound to a shared session, native-action commands include:

- `!fa tools` — list supported native tools/actions on its active destination.
- `!fa run <tool> <action> <input>` — run using settings saved in FamiliarAgent.
- `!fa actions` / `!fa action <run-id>` — inspect action summaries or an original action in that session.
- `!fa cancel <run-id>` — request cancellation of the Familiar invocation.

These commands retain configured user/role authorization and native permission behavior. In an actual Discord channel, the configured bot created, read, edited and deleted an owned test message; its downloaded attachment matched the original byte count and SHA-256. This verifies the native REST/file transport. Separately, an authorized test message sent through the signed-in Discord UI completed Gateway → Mac relay → Ubuntu Codex → Discord with a matching native answer and delivered receipt. The token stayed in its original server-side file and the original bot/channel configuration was preserved. This verifies a real conversation round trip, not every listed command. Configure the connector in **Settings → Integrations**; see [Discord shared sessions](discord-shared-sessions.md) for existing-config references and dedicated channels. Server routes and required settings must be valid. Use the desktop/native interface for setup or actions that need additional choices.

## Verification and scope

From a prepared checkout with Node.js 24, run:

```sh
npm run verify:familiar -- --integration
```

The workspace test target discovers the full `plugins/familiar-workspace` directory: adapter contracts, process/HTTP transport, durable action storage, source/result connections and Hub UI tests. New suites do not need duplicate explicit registration. The runner also checks the selected desktop/server/app/CLI/Discord paths and isolated daemon transport tests.

This fast check opens no desktop app, signs into no external account and makes no paid model request. The actual native workflows in the table were tested separately. User credentials, private machine names and raw test conversations are not included in this public guide. The earlier v0.14 fast run passed 1,394 tests plus type and lint checks. The final v0.15 fast run passed 1,445 tests plus type and lint checks, including real initialized-daemon RPC checks. Setup regressions cover missing tools, cancelled credential entry, settings-contract validation and restoring the same session after setup. The installed Ubuntu runtime read a 608-byte tool result from its Mac owner through the normal UI-established SSH context connection with matching content and digest.

On macOS, project-root watches run in one shared worker so an OS folder-access decision cannot block the daemon thread during startup. A bounded setup deadline retains the existing background reconciliation path; it does not grant folder permissions. Other filesystem operations still follow macOS access rules.
