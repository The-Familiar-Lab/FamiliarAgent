import type { ToolGuide } from "@getpaseo/protocol/familiar-tools";

// Tool semantics are shared by every entry point. Installation and account state
// are checked separately on the selected execution server.
const GUIDES: Record<string, ToolGuide> = {
  claude: {
    summary: "Claude Code edits, tests and explores your project with its own agent tools.",
    whenToUse: [
      "Continue a Claude Code conversation",
      "Work on code using Claude's tools and skills",
    ],
    execution: "Runs the original Claude Code on the selected server using its existing account.",
    continuation:
      "Native Claude history can resume; other tools receive selected results and shared context.",
  },
  codex: {
    summary: "Codex works on your repository with its native approvals, tools and model settings.",
    whenToUse: ["Continue an existing Codex task", "Implement or review changes with Codex"],
    execution: "Runs the original Codex on the selected server using its existing login.",
    continuation:
      "Native Codex sessions can resume; shared context connects work from other tools.",
  },
  aider: {
    summary: "Aider is a terminal coding assistant focused on editing files and working with Git.",
    whenToUse: ["Make focused repository edits", "Use Aider's original edit and commit workflow"],
    execution:
      "Opens native Aider in the project folder. Its configured model API credentials are required.",
    continuation:
      "Selected results can be attached as read-only context; another tool's private state is not an Aider session.",
  },
  goose: {
    summary: "Goose runs its own agent workflow with extensions, tools and selectable providers.",
    whenToUse: [
      "Use Goose extensions and MCP tools",
      "Work through a supported existing Codex or Claude provider",
    ],
    execution:
      "Runs native Goose on the selected server. Choose an existing-account connection or its original provider setup.",
    continuation:
      "FamiliarAgent keeps the same shared session and context. When ACP needs a fresh native runtime, continuation connects recent history and shared-memory references automatically.",
  },
  openrig: {
    summary: "OpenRig manages agent teams, seats and their work through its original rig service.",
    whenToUse: ["Use OpenRig's multi-agent workflow", "Inspect native rig seats and team activity"],
    execution:
      "Runs native OpenRig. Its service must be started and its underlying agents signed in on that server.",
    continuation:
      "Rig results and selected context can feed the same Familiar session; OpenRig keeps ownership of seats and coordination.",
  },
  "claude-squad": {
    summary: "Claude Squad manages parallel terminal agents with tmux and Git worktrees.",
    whenToUse: ["Work on several isolated branches", "Manage parallel native terminal agents"],
    execution: "Opens the original Squad interface with its tmux and Git prerequisites.",
    continuation:
      "Share project context and selected results; Squad owns each worktree and terminal session.",
  },
  superharness: {
    summary: "Superharness provides its own agent workflow, work queue and verification steps.",
    whenToUse: ["Run a queued multi-step workflow", "Inspect native task and verification outputs"],
    execution: "Uses the installed original Superharness commands and configured agent account.",
    continuation:
      "FamiliarAgent links native task IDs and result references; it does not replace Superharness's loop.",
  },
  orca: {
    summary: "Orca provides a project-oriented interface and native agent workflow.",
    whenToUse: ["Use Orca's project and agent interface", "Run a supported original Orca action"],
    execution: "Opens an installed original app or configured native command on its owning server.",
    continuation:
      "Shared context and selected results connect Orca work with other tools; its own runtime state stays native.",
  },
  hydra: {
    summary: "Hydra manages native agents and worktrees through its own service.",
    whenToUse: [
      "Use Hydra's parallel workspace workflow",
      "Inspect or continue a native Hydra task",
    ],
    execution: "Uses the original Hydra service and its configured agents on the selected server.",
    continuation: "FamiliarAgent links outputs and context while Hydra owns its agent lifecycle.",
  },
  alethe: {
    summary: "Alethe supplies its original planning and MCP capabilities.",
    whenToUse: ["Use native planning tools", "Connect Alethe capabilities to a compatible agent"],
    execution: "Runs the installed original commands or MCP service.",
    continuation:
      "Planning results can become inputs to another tool within the same logical session.",
  },
  codey: {
    summary: "Codey exposes its own agent gateway and native task workflow.",
    whenToUse: ["Run a task through Codey", "Inspect native gateway results"],
    execution: "Uses the original Codey gateway and its provider configuration.",
    continuation:
      "Native task outputs are linked into the Familiar session; Codey retains execution control.",
  },
  codeg: {
    summary: "Codeg works with projects and conversations through native ACP agents.",
    whenToUse: ["Use Codeg's ACP-based workflow", "Continue a native Codeg conversation"],
    execution: "Runs the original Codeg service and requires a configured ACP agent.",
    continuation:
      "Selected context and outputs connect tools; native ACP session support determines full resume.",
  },
  openharness: {
    summary: "OpenHarness provides its own terminal interface and agent service.",
    whenToUse: ["Use the original OpenHarness workflow", "Inspect or run its native agent tasks"],
    execution: "Runs original OpenHarness; complete its required SSO and agent setup first.",
    continuation:
      "FamiliarAgent links its outputs and context, while authentication and native task state remain in OpenHarness.",
  },
  agents: {
    summary: "wshobson/agents is a collection of agent instructions, plugins and skills.",
    whenToUse: [
      "Add specialist instructions to a supported harness",
      "Reuse an existing skill instead of implementing a new agent",
    ],
    execution:
      "Installs or inspects the original collection; it is not an independent model runtime.",
    continuation:
      "The chosen harness loads the selected instructions. Removing a mapping does not erase context already read by an agent.",
  },
  firetower: {
    summary: "Firetower manages remote coding workspaces and agent workers.",
    whenToUse: ["Run work on a prepared remote worker", "Inspect native remote workspace activity"],
    execution: "Uses the original Firetower service and worker configuration.",
    continuation:
      "Workspaces and tasks stay native; selected responses can continue in another tool or server.",
  },
  skulk: {
    summary: "Skulk manages remote agents, tmux sessions and worktrees over SSH.",
    whenToUse: ["Use a native remote terminal workflow", "Manage SSH worktrees and agents"],
    execution: "Runs original Skulk with its SSH and remote command prerequisites.",
    continuation:
      "Connects project context and outputs; remote terminals and worktrees stay on their original server.",
  },
  bssh: {
    summary: "bssh is a parallel SSH and cluster shell tool.",
    whenToUse: [
      "Run an operational command on selected hosts",
      "Use native cluster shell and file transfer features",
    ],
    execution:
      "Runs the original bssh commands using configured SSH access. It is not an AI model provider.",
    continuation:
      "Command outputs and files can be selected as inputs to an agent in the same Familiar session.",
  },
  coder: {
    summary: "Coder provisions and manages development workspaces on your infrastructure.",
    whenToUse: [
      "Open an existing Coder workspace",
      "Use your Coder templates and development environments",
    ],
    execution:
      "Connects to the original Coder deployment; login, templates and infrastructure remain there.",
    continuation:
      "Register a workspace's execution host and folder to connect its files and agent context.",
  },
  juicefs: {
    summary:
      "JuiceFS provides a shared filesystem backed by its metadata and object storage services.",
    whenToUse: [
      "Use an existing shared project mount across servers",
      "Inspect a configured native JuiceFS filesystem",
    ],
    execution:
      "Uses the original JuiceFS client and an explicitly configured filesystem. Folder mapping alone does not create a mount.",
    continuation:
      "A mounted shared folder can be mapped on multiple hosts without duplicating every project file.",
  },
  pullboard: {
    summary: "Pullboard keeps a task board and work specifications alongside a Git project.",
    whenToUse: [
      "Share work items between different coding tools",
      "Inspect tasks, facts and verification results",
    ],
    execution:
      "Runs the original local board and CLI. Initialize the selected project explicitly; no model account is required.",
    continuation:
      "A selected board item or result can become another agent's input while the original board stays authoritative.",
  },
  "docker-skills": {
    summary:
      "Docker Skills provides reusable instructions for Docker and related development tasks.",
    whenToUse: [
      "Add Docker expertise to a supported agent",
      "Enable or remove selected Docker skills during work",
    ],
    execution:
      "Registers original SKILL.md folders. This does not install Docker Engine or start containers.",
    continuation:
      "Supported tools read the shared skill mappings or context MCP; native harness reload behavior still applies.",
  },
};

const EDITORS = new Set(["cursor", "antigravity", "antigravity-ide", "vscode", "chatgpt"]);
export function guideForTool(tool: { id: string; name: string; description: string }): ToolGuide {
  if (GUIDES[tool.id]) return GUIDES[tool.id]!;
  if (EDITORS.has(tool.id))
    return {
      summary: tool.description,
      whenToUse: [
        `Continue working in ${tool.name}'s own interface`,
        "Connect supported existing conversation history",
      ],
      execution: `Opens the installed original ${tool.name} app or configured CLI. Its own login and UI remain native.`,
      continuation:
        "Only supported history sources or explicit exports are linked. Private editor state is not automatically portable to another harness.",
    };
  return {
    summary: tool.description || tool.name,
    whenToUse: ["Use this registered tool's original interface or command"],
    execution:
      "Uses the command or URL registered on the selected server; check its native prerequisites.",
    continuation:
      "Share selected results and explicit context. Native state transfer depends on this tool's supported interfaces.",
  };
}
