# Set up once, then choose your tools

A new FamiliarAgent installation opens Familiar Hub. **Set up tools** is also available at the top of the Hub for existing installations. Existing workspace restoration still returns to the workspace you last used.

## The default setup flow

1. **Connect Codex or Claude Code.** Choose an online server and connect one account. An account already signed in has a **Select** button; **Selected** identifies the engine used for setup. FamiliarAgent uses the original provider's login flow and checks that login without running a model request.
2. **Choose tools.** Select the uninstalled tools you want, or use **Select all**. Installed tools have a distinct appearance and a checked, disabled selection; they are included for connection checks, not blind reinstallation. The **?** control on the right explains each original tool. **Choose setup agent →** advances to the next step.
3. **Delegate setup.** Choose the server and either an existing agent conversation or a new Codex/Claude agent. For a new agent, choose **Setup model**, its supported **Setup thinking** level and **Setup permission mode**. Existing conversations keep their current configuration. One explicit request asks that agent to prepare all selected tools. Installation instructions, original sources and the selected scope travel with the request.
4. **Check and use.** Check installation and account status after the agent finishes. A detected binary alone does not prove model access or a working external service. Any remaining login or service step stays visible with a setup action.

The setup draft survives closing the Hub. **Ask agent to set up** is available for individual catalog entries too. Selecting an existing agent does not silently interrupt its running turn. If no usable agent exists, connect Codex or Claude Code first.

## Use Codex or Claude Code inside Goose

In Goose setup, choose **Use existing Codex** or **Use existing Claude Code**. FamiliarAgent installs the original ACP adapter into its private tool directory, then remembers the non-secret choice for Goose launches. You do not enter a Provider API URL or create another API key. The original account remains on the execution server.

The selection is applied both to **Open terminal** and to original Goose task actions. **Use original Goose profile** removes the Familiar-owned selection without deleting Goose settings or account data. Advanced per-action provider settings remain explicit overrides.

For an ACP continuation, FamiliarAgent keeps the logical session and shared memory while creating a fresh native execution when required. It supplies a bounded portion of recent history and connects the original shared-context MCP. Original source sessions remain unchanged; full histories are read through their references when needed. Native execution IDs are recorded so results retain their provenance.

## Reuse a prepared server

Tool setup shows existing installations on other connected servers. Select **Use installation on …** to use one. The project needs a folder mapping on that server, and the original account must be ready there. FamiliarAgent routes the session and its shared references to that execution server instead of copying account files around the fleet.

Each machine still needs binaries compatible with its operating system if it will execute the tool locally. Choosing an already prepared execution server avoids that duplicate installation.

## Keep several projects on screen

Drag a top project tab or a workspace title from the left sidebar onto a project screen. Drop at the left, right, top or bottom edge to split that screen; the highlighted preview shows the destination. Drop in the center to replace that pane. The old project remains in the tab bar and its sessions are not closed. Already visible projects move instead of creating duplicate screens.

Drag tabs along the top bar to reorder them. Drag a divider to adjust its size. Nested horizontal and vertical splits can show up to four projects, including projects from different servers. Each project keeps its original conversation, terminal, files and unfinished input while docking or resizing. Clicking a visible project's tab focuses its existing pane; clicking a hidden tab replaces the focused pane. **×** closes only that view, preserving native sessions and files. Mobile uses the focused project. There is no separate layout-mode toolbar or project picker for arranging the screen.

For a remote folder, choose the execution server before **Browse**. The folder browser lists that server's directories. Click a folder to enter it, use **Up** for its parent, or enter an absolute path and choose **Go**. **Show hidden folders** and **Show more folders** reveal additional entries. **Select this folder** confirms the current directory; browsing and **Cancel** do not create a project or copy files. If the server is offline or the directory cannot be read, the error is shown and selection is disabled. Local Mac browsing keeps the system folder picker.

## Continue a conversation

Open **Familiar Hub** in the conversation's right sidebar. Browse by **Project** or **Server**, open the conversation preview, then confirm **Select session**. Viewing a preview does not import, link or change the conversation.

Choose **Continue with another tool** to keep the logical session, or **Fork to another server** to create a branch. Select the tool and execution server; mapped folders are reused. The original tools retain their model loops, teams, permissions and worktree behavior. FamiliarAgent links the inputs, selected outputs and shared working context.

**New tab** and **New workspace → Launch** use the same managed tool discovery and setup paths. Custom terminal profiles retain their custom command and arguments. Failed launches show the actual exit code and a bounded diagnostic rather than an empty terminal.

## Choose memory and skills for this conversation

Open **Familiar Hub** in the current conversation's right sidebar, then choose **Memory & Skills**. A linked conversation is selected automatically. For an unlinked conversation, inspect its preview and confirm **Select session** before changing shared choices.

Under **Use in this session**, check **Shared project and session memory** and the individual skills you want to use. The list combines registered skills from connected servers, showing each owner and original path. A skill with the same name on two servers remains two distinct sources. Choosing a remote skill saves a reference to its registered ID; it does not copy its directory or run its scripts. An unavailable selected source can still be unchecked.

Use **? What these checks change** or the skill's **? About** help by hover, keyboard focus or click. **Preview original instructions** reads a bounded portion of the original SKILL.md only when requested. Skill programs and dependencies remain on the server where the original tool runs.

A check changes what this logical session can receive on its next Familiar context read or continuation. Unchecking shared memory or a skill stops future shared-context delivery for this session. It does not erase instructions the current model already read, change another session, or remove a native tool's independently configured skills. A fork inherits the choices and can then change its own selection.

**Advanced · Library defaults, native project links & MCP** contains server-wide registration, enable/disable/remove, and project application. These are distinct from the session checkboxes. Changes are revision-checked; removal deletes only Familiar-owned mappings or links, preserving original files and unrelated project files. A native harness controls when its filesystem skill list reloads.

Agents connected to the regular shared-context MCP can use `familiar_skills` to list/read/add/enable/disable/remove/apply skills. Read first to obtain the current revision. Selected instructions can be read on demand through `familiar_skill`, which checks the session selection and source registry.

**Docker Skills** registers the original Docker knowledge pack. It does not install Docker Engine. **Pullboard** runs its original Git-project task board; initialize the selected project explicitly before using its board UI or task actions. Its original task descriptions, facts and exported snapshots can become inputs for other tools.

## Development checks

`npm run verify:familiar -- --integration` runs bounded parallel type, lint and focused tests, plus actual temporary-daemon checks. It covers the two launch entry points, startup routing, grouped previews, setup delegation, skill revisions, source preservation, and terminal creation/exit ordering. Native Mac and Ubuntu smoke checks then verify original installations and provider connections. Electron interaction is reserved for final release verification.

## Ask Familiar in the right sidebar

Choose **Ask Familiar** at the top of the Hub. Select **Advisor server** and **Advisor agent**, enter a question, and choose **Ask Familiar here**. If an account is not ready, **Connect Codex** or **Connect Claude Code** opens its original setup. Installed does not mean signed in.

The advisor is a separate native conversation that stays inside the right panel. It receives a bounded excerpt of the source conversation, selected shared context when linked, and the connected tool catalog. Its Familiar MCP exposes only context, original history and selected-skill reads. The advisor does not become the source session's active endpoint; asking for recommendations does not install a tool or switch the original conversation.

Continue with **Ask a follow-up** and **Send to advisor**. **Open full conversation** opens the same native advisor when you need its complete history, tool details or original approval controls. Pending approval is shown in the panel and must be handled in that original conversation. **Hide advisor** stops the panel's live observation while keeping the native conversation; reopening it in the same Hub panel resumes observation. The panel's source remains the conversation captured when the advisor started even if you browse another Hub session.

Updates use the native subscription and bounded recent-history reads, with no idle polling. If delivery becomes uncertain, **Check delivery** reads the original receipt. It does not resend the question automatically. A recommendation is not execution: choose the suggested setup or continuation action explicitly when ready.

## v0.16 verification status

The v0.16 build is installed on Mac and Ubuntu. The automated release run passed **1,682 tests** with type and lint checks; the final client pass separately passed **123 tests**. The latter overlaps the full run and is not an additional release-test count.

Final installed-app checks have confirmed **Add project** with both Mac and Ubuntu project views, **Stacked**, closing a project view, and navigating into a remote folder through **Browse**. Installed-app checks also confirmed New tab → Goose → agent selection → a real Codex setup task, returning after restart with installed/signed-in status, and an inline Ask Familiar response based on the source conversation. Session-scoped memory/skill selection and advisor lifecycle/error behavior have focused code tests; actual cross-host MCP reads confirmed selection and removal. these results do not imply that every UI control, external account or tool workflow has been manually verified.

## v0.16.1 drag-layout and setup verification

Version 0.16.1 replaces the v0.16 arrangement controls with direct project dragging. The final focused run passed **1,010 tests**, application/workspace type checks and lint. It exercises native project drag payloads, sidebar event isolation, all five drop positions, tab reorder, nested splits, migration of saved layouts, input and DOM-order preservation, divider cancellation, setup choices and configuration delivery. File drags keep their original handlers. A separate temporary-daemon check initialized the actual Codex provider, saved the selected model/thinking/permission configuration and read an empty timeline without sending a model turn.

After the existing user setup task finished, the revision was installed on Mac and Ubuntu. Installed-app checks confirmed a top project tab moving into a right split, a left-sidebar workspace joining a nested split, divider resizing, preserved existing conversations, signed-in provider selection, **Select all**, distinct installed-tool cards with right-side help, and the actual model/thinking/permission dropdowns. No installation request was sent during this UI check. The installed Mac frontend matches the build; Mac and Ubuntu plugin bundles have the same hash. The Ubuntu deployment preserved all 18 existing agents, 94 original record files, shared composition state and Goose settings.

Node-based setup recipes now carry their required Node execution mode explicitly, including when the bundled Electron helper runs from a clean setup shell. The revision adds no dependency. These results cover this change and do not assert manual verification of every external tool or account.

## v0.16.2 installation and account checks

The catalog distinguishes an installed desktop app from an available native CLI. Cursor and Antigravity now have original **Install** and **Sign in** actions, with native account checks. A CLI can still need sign-in when its editor is already signed in. Aider uses **Add API key**; OpenHarness uses its original **Sign in** flow. After authentication, choose **Check setup** and run a small task before treating the account as ready.

Infrastructure setup installs the original verified binaries into the selected server's private tool folder. Coder, Firetower and JuiceFS still need the native service/backend appropriate to your project; use an existing connection or **Ask agent to set up**. Mac Firetower connects to a Linux control plane. JuiceFS file sharing requires shared reachable metadata/object storage; installing its binary does not create that infrastructure or enable macFUSE.

Original installer scripts run in Node mode inside the packaged Electron helper, and installation fails if the expected executable is missing. The superharness recipe includes its required Claude SDK. Linux Orca uses its original verified daemon files, and Hydra reports missing native compiler prerequisites before installation. Automatic project-icon discovery runs outside the main daemon so a blocked folder cannot consume all of its filesystem workers.

The final code run passed **1,832 tests**, all six relevant type checks and lint. It includes blocked native file reads, cancellation, process limits, project restoration and daemon filesystem isolation. See the [tool verification report](tool-verification.md) for original execution checks, account requirements and the final installed-runtime status.

If an original file cannot be opened, check its location and folder access. On Mac, select that project through **Add project → Browse** using the system folder picker, then retry the failed action. The application does not grant itself Full Disk Access. A failed file read remains an error; it is not treated as an empty history or completed native task.
