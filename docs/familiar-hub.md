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

**Tools** can open native terminal and web interfaces inside FamiliarAgent, open installed desktop applications, register a command or URL, and offer supported install recipes. **Ask agent to set up** delegates an explicit setup task to a real native agent.

The catalog distinguishes 9 CLI entries, 6 desktop-app entries and 9 reference entries. A reference entry requires its own command or URL configuration. A catalog entry does not imply complete compatibility with every feature of that project.

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

Discord is an optional entry point through AI Agent Discord Connector. A channel can follow a logical session's active native agent after a tool switch. Terminal and web interfaces do not automatically acquire a native chat/approval API.

Advanced settings expose authority routing, resource mappings and limits. Cross-server readers receive access only to the selected source references and sessions. Saved connections are restored once when the daemon starts and renewed when the relevant session is opened or changed. An offline source can make its original history unavailable.

## Verified scope and limits

The release validation includes actual Mac Codex and Ubuntu Claude using the same logical session, reading original history through MCP, updating shared memory, and creating a pointer fork. Archived original conversations remained readable after daemon restart without manually renewing the connection. The installed Hub also forked a Mac session to a native Ubuntu Claude chat; destination model and thinking settings were retained. Explicitly unstarted Codex sessions recovered after restart without resetting their logical identity, workspace or MCP configuration. Native Git worktrees, terminal execution and bounded history reading have separate automated and live checks.

The initial live fork manifest was 1,155 bytes; this is one measured case, not a constant size guarantee. Resource measurements and passing fixtures do not establish every tool/account combination. Real Discord account operation, user-provided ChatGPT exports and closed harness internals require separate validation.

Provider-private heap state, model KV caches, credentials and unpublished orchestration checkpoints are not portable across arbitrary tools. Original source files and the owning server remain necessary for uncopied history.
