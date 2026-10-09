# Familiar Hub

FamiliarAgent connects projects and conversations across existing agent tools and machines. The original tool still runs its own model loop, team, permissions and workspace operations. FamiliarAgent maintains the common session identity, shared decisions and links to the original sources.

## Start with an existing project

1. Open **Familiar Hub**. **All servers** shows connected hosts together.
2. In **Projects**, use an existing folder and choose **Create project**.
3. Select another server and **Link folder** to map that server's existing project directory.
4. In **Sessions**, use **Link session** for a native conversation, or use **History → Use in session** for an external conversation.
5. Select a destination server, tool, model and thinking option. **Switch tool & continue** keeps the logical session. **Fork session here** creates a separate branch.

**Shared session connected** appears in native chats linked to a common session. **Open Familiar Hub** returns to that session's tools, server choices and shared context.

A linked folder is a location mapping, not a file sync operation. The destination needs an existing checkout, worktree or shared mount. **Separate Git worktree** uses the original workspace service and Git object storage. Uncommitted changes stay in their original folder.

## Connect a particular result to the next tool

1. Open a completed Codex or Claude response and select **Use result…** beside **Copy**.
2. **Inputs / Results** opens with the exact response preview. Choose an existing conversation in this logical session or **New agent**; for a new agent select its server, folder, provider, model and thinking setting.
3. Write the next instruction and select **Send input**. The destination runs the work using its original provider. A result card links the original response to the receiving conversation while retaining the same logical session.
4. Use **Open original**, **Open conversation** and the result preview to follow the connection. **Accepted** means that the native input was acknowledged, not that its task has finished.

An unlinked source is connected to a project and logical session only when you explicitly send. Preview and **Cancel** do not create a new session. Existing targets belonging to another logical session are rejected instead of silently reassigned. A new target receives the selected result and instruction without an automatic recent-history prefix.

Connected input messages show **Your instruction** and **Selected response**. Expand **Original input** to inspect the unchanged native payload. If a new-target acknowledgement is lost, retry retains the original server, folder and model until the draft is cancelled.

The source stays on its owning server. A result record stores the original boundary, selection position, content hash and a short preview; the target receives only the selected text and instruction. Source files are streamed and checked rather than copied or read wholly into memory. Changed, missing, ambiguous or oversized selections produce an error. Current limits are 32 text segments, 64 KiB of selected text and 16 KiB of instructions. A large original transcript still takes time to read and validate.

A busy destination is not interrupted. **Check status** reads its delivery receipt after an uncertain outcome and does not resend the input. **Send prepared input** applies only to an input that has not yet been claimed for delivery. For a tool without a supported input API, **Copy input** and **Open tool** keep the native workflow available; copying does not record an automatic delivery.

## What travels between tools

| State                                | How it is connected                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Project decisions and session memory | Revisioned shared records; conflicting updates are rejected                  |
| Original conversations               | Source IDs, bounded pages and fixed history boundaries                       |
| Immediate working context            | A size-limited continuation plus references to earlier history               |
| Skills                               | Links to existing directories on the selected server                         |
| MCP tools                            | Supported native launch configuration and explicitly shared HTTP definitions |
| Code and artifacts                   | Existing file UI, Git/worktree operations and explicit transfers             |
| Native orchestration                 | The original harness runs it; public context and tool interfaces connect it  |

The MCP tools `familiar_context`, `familiar_history` and `familiar_memory` let supported agents read shared state, fetch earlier conversation pages and save decisions. The native tool decides when to use them.

A fork stores its parent revision and history boundaries instead of duplicating the full transcript. Codex and Claude references resolve the original provider files on their owning machine. Archive moves remain readable; later appended messages are excluded. Rewritten or missing source data produces an error. Reading and validating a large source still requires I/O on its owner, even though the full history is not held in memory or copied to the destination.

## Tools and screens

**Tools** can open native terminal and web interfaces inside FamiliarAgent, open installed desktop applications, and register a command or URL. **Set up / Sign in** opens the selected server’s installation and authentication steps; selecting a session tool also opens this dialog. Choose **Install**, complete the original terminal flow, then **Check setup → Use in this session**. Installation and account readiness are separate. **Ask agent to set up** delegates additional prerequisites to a real native agent. See the [native tool guide](native-tool-actions.md) for exact provider steps and the verified Mac/Ubuntu setup matrix.

The catalog distinguishes native chat, terminal, web, desktop and reference surfaces. Seventeen native-action adapters expose 85 explicit operations; their original tool owns execution and orchestration. A catalog entry or installed binary does not imply complete compatibility or authentication for every feature.

- Claude/Codex native sessions and supported CLI launches receive the common session MCP configuration.
- Goose receives a per-launch extension without overwriting its global profile.
- Cursor and VS Code can receive project-level MCP configuration while preserving existing JSONC settings. Their native trust and tool approval controls remain in effect. VS Code's Codex extension uses separate provider configuration.
- Supported terminal harnesses can pass the session context to Claude/Codex children. Their team layout, loops and Git behavior remain native.
- Desktop applications open in their own windows. FamiliarAgent embeds terminal and web surfaces, not arbitrary desktop windows.

## Servers, files and history

**Add server** reuses an existing trusted SSH configuration and installs the runtime in the remote user's directory. Linux servers are supported. The selected SSH profile supplies its SSH and daemon ports. No root installation is required.

Data uses `~/.local/share/familiaragent/` on Mac and Linux. The macOS app is `/Applications/FamiliarAgent.app`. Explicit environment overrides remain supported. Existing data is migrated with checks for running processes and conflicting stores.

**Files** opens the original file explorer, editor and media surfaces. Uploads, drag attachments, streaming playback and downloads use the native file APIs.

**History** indexes supported Cursor, VS Code, Codex, Claude and Antigravity sources. Search and hide/restore operate on the index; originals remain in their source applications. ChatGPT history requires official export JSON. Account-wide cloud scraping and private app checkpoint conversion are not provided.

## Discord and advanced configuration

Discord is an optional entry point through AI Agent Discord Connector. In **Settings → Integrations**, a channel can follow a logical session's active native agent after a tool switch. Existing connector tokens can remain in their original private files on an SSH server; a separate role-restricted channel keeps the original bot and channels intact. See [Discord shared sessions](discord-shared-sessions.md). Terminal and web interfaces do not automatically acquire a native chat/approval API.

Advanced settings expose authority routing, resource mappings and limits. Cross-server readers receive access only to the selected source references and sessions. Saved connections are restored once when the daemon starts and renewed when the relevant session is opened or changed. An offline source can make its original history unavailable.

## Verified scope and limits

Selected-result validation covers actual Mac Codex → Ubuntu Claude → Mac Codex in the same logical session, exact prepared/native input hashes, exclusion of later messages and duplicate-send suppression. The installed macOS UI also created a new Ubuntu Claude target through **Use result… → New agent → Send input** and displayed its real response with the selected model and thinking setting.

The earlier release validation includes actual Mac Codex and Ubuntu Claude using the same logical session, reading original history through MCP, updating shared memory, and creating a pointer fork. Archived original conversations remained readable after daemon restart without manually renewing the connection. The installed Hub also forked a Mac session to a native Ubuntu Claude chat; destination model and thinking settings were retained. Explicitly unstarted Codex sessions recovered after restart without resetting their logical identity, workspace or MCP configuration. Native Git worktrees, terminal execution and bounded history reading have separate automated and live checks.

The initial live fork manifest was 1,155 bytes; this is one measured case, not a constant size guarantee. Resource measurements and passing fixtures do not establish every tool/account combination. An authorized message sent through the signed-in Discord UI completed Gateway → Mac relay → Ubuntu Codex → Discord, with a delivered receipt and matching native reply. This verifies that conversation path, not every Discord command or tool combination. User-provided ChatGPT exports and closed harness internals require separate validation.

Provider-private heap state, model KV caches, credentials and unpublished orchestration checkpoints are not portable across arbitrary tools. Original source files and the owning server remain necessary for uncopied history.

## Pullboard live view

Launching Pullboard with **Open terminal** keeps the original `pullboard view --no-open` process alive. Once it announces readiness, FamiliarAgent opens its original web UI as a browser tab in that same project. No URL copying is required. This also works on SSH hosts: the desktop reuses the selected SSH profile and retains the original service's Host/Origin and private-key checks.

Return to the terminal and choose **Open Pullboard** to reopen the view. A failed connection shows a retry action without exposing the private URL. Terminal exit stops the original service; closing only its browser tab does not stop it. Private view URLs, page storage and cache are not persisted by the browser; after restarting FamiliarAgent, reopen the original terminal to discover a running service again. Original terminal output retention is unchanged.

Automatic readiness detection recognizes Pullboard's explicit ready announcement, superharness's adjacent dashboard/project lines, and Codeg's original server-listening announcement. Only validated loopback URLs are opened. Unrelated URLs and authentication links printed by agents are not automatically opened. superharness stays in the foreground with its original browser auto-opening disabled; Codeg keeps its native browser login and project selection. An already healthy managed Codeg service is reopened without starting a duplicate server.

## Original interfaces and session activity

**Launch** selects the supported original interface. Installed desktop apps open in their own window; folder arguments are passed only where supported. Desktop launcher diagnostics remain available under **View launcher**, while the Hub stays on the shared session. Headless infrastructure tools and libraries with no idle interface offer **Run actions** instead of starting a help-only command. Linux hosts do not pretend to provide a Mac desktop interface.

In native chat or an original terminal, **View session activity** opens the matching shared session in the right sidebar. A terminal not linked to any session says so explicitly. **Session activity** shows each owning server's latest observation and offers **Open original**, **Check setup / launch again**, **View result** and **Use result…** as applicable. Original action results are read only when requested; complete transcripts and private URLs are not copied into activity records.

The statuses describe observed native behavior: running, waiting, idle, closed, unavailable, or external app ownership. An accepted action is shown as submitted, not completed. A desktop launcher's exit does not prove app readiness or successful work; inspect its original window or launcher output. External app progress remains native when no public status interface exists.

Visible running work refreshes every four seconds. Hidden panels, hidden windows and idle/external/error states do not poll. **Refresh activity** checks again; disconnected or older servers show a per-server error without hiding the other hosts. If linking fails after creating an original process, **Retry linking original** reuses that process. Existing context, memory and selected-result transfer continue to use the logical session's established mapping.
