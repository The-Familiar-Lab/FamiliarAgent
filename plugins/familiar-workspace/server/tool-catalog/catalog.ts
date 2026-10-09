import type { ToolEntry } from "../../shared/tool-catalog.js";

export interface BuiltinTool {
  id: string;
  name: string;
  description: string;
  capabilities: ToolEntry["capabilities"];
  sourceUrl?: string;
  license: string;
  command?: string;
  args?: string[];
  nativeProvider?: string;
  desktopApp?: string;
  desktopOpensFolder?: boolean;
  install?: { kind: "npm" | "python" | "native"; package: string; with?: string[] };
  notes?: string[];
}

/** Entry points checked against the pinned reference repositories on 2026-10-08.
 * These are launch adapters; native loops and sessions remain owned by each tool. */
export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
  {
    id: "pullboard",
    name: "Pullboard",
    description: "Original Git project work board, spec-linked items and independent verification.",
    capabilities: ["orchestration", "workspace", "git", "skills"],
    sourceUrl: "https://github.com/pullboard-dev/pullboard",
    license: "MIT",
    command: "pullboard",
    args: ["view", "--no-open"],
    install: { kind: "npm", package: "pullboard@0.8.1" },
    notes: [
      "Requires Node.js 22.13 or newer and Git. Initialize a selected Git project through Run actions; installation never changes project hooks or documents.",
      "Open terminal starts the original loopback board view. Its private link stays in that terminal. Pullboard does not call a model; original agents own the work and verification.",
    ],
  },
  {
    id: "docker-skills",
    name: "Docker Skills",
    description:
      "Docker-authored portable skills for Dockerfiles, Compose, Docker Agent and Sandboxes.",
    capabilities: ["skills", "context"],
    sourceUrl: "https://github.com/docker/skills",
    license: "Apache-2.0",
    notes: [
      "Set up installs a reviewed source snapshot. Add to Memory & Skills registers original directories for supported project projections without copying skill folders.",
      "Knowledge skills only: Docker Engine, Compose, Docker Agent and Sandboxes remain separately installed original tools.",
    ],
  },
  {
    id: "claude",
    name: "Claude Code",
    description: "Native agent chat, tools and skills.",
    capabilities: ["harness", "context", "skills", "mcp"],
    sourceUrl: "https://github.com/anthropics/claude-code",
    license: "Proprietary runtime",
    command: "claude",
    nativeProvider: "claude",
    install: { kind: "npm", package: "@anthropic-ai/claude-code" },
  },
  {
    id: "codex",
    name: "Codex",
    description: "Native agent chat with existing sessions and sandbox controls.",
    capabilities: ["harness", "context", "skills", "mcp", "git"],
    sourceUrl: "https://github.com/openai/codex",
    license: "Apache-2.0",
    command: "codex",
    nativeProvider: "codex",
    desktopApp: "ChatGPT.app",
    desktopOpensFolder: false,
    install: { kind: "npm", package: "@openai/codex" },
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Open the current project in Cursor or use its installed CLI.",
    capabilities: ["harness", "context", "skills", "mcp"],
    sourceUrl: "https://cursor.com/docs",
    license: "Proprietary runtime",
    command: "cursor-agent",
    install: { kind: "native", package: "cursor" },
    desktopApp: "Cursor.app",
    notes: ["Editor chat state stays in Cursor. CLI and editor sessions are not interchangeable."],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    description: "Current native agent app and CLI, with independently owned sessions.",
    capabilities: ["harness", "context", "skills", "mcp"],
    sourceUrl: "https://www.antigravity.google/docs",
    license: "Proprietary runtime",
    command: "agy",
    nativeProvider: "antigravity",
    install: { kind: "native", package: "antigravity" },
    desktopApp: "Antigravity.app",
    notes: [
      "The current CLI provider and historical IDE transcripts use different native session formats.",
    ],
  },
  {
    id: "antigravity-ide",
    name: "Antigravity IDE",
    description: "Open the project in the original Antigravity IDE.",
    capabilities: ["harness", "context", "skills", "mcp", "workspace", "git"],
    sourceUrl: "https://www.antigravity.google/docs",
    license: "Proprietary runtime",
    desktopApp: "Antigravity IDE.app",
    notes: [
      "Historical IDE chats remain in this app; the current Antigravity CLI uses a different native session format.",
    ],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    description: "Open the original ChatGPT conversation app.",
    capabilities: ["context"],
    sourceUrl: "https://chatgpt.com/",
    license: "Proprietary runtime",
    desktopApp: "ChatGPT Classic.app",
    desktopOpensFolder: false,
    notes: [
      "Conversations and sign-in remain in ChatGPT. Use its native attach/import actions or link an exported conversation in History.",
    ],
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    description: "Open the project with its original editor and installed agent extensions.",
    capabilities: ["workspace", "git"],
    sourceUrl: "https://code.visualstudio.com/docs",
    license: "Microsoft distribution; Code - OSS source MIT",
    desktopApp: "Visual Studio Code.app",
    notes: [
      "Agent extension conversations stay in their original providers. Opening this editor does not import another runtime's private state.",
    ],
  },
  {
    id: "aider",
    name: "Aider",
    description: "Repository-aware terminal editing and native Git changes.",
    capabilities: ["harness", "context", "git"],
    sourceUrl: "https://github.com/Aider-AI/aider",
    license: "Apache-2.0",
    command: "aider",
    install: { kind: "python", package: "aider-chat" },
    notes: [
      "Context is attached as a read-only file; Aider retains its own chat history and model configuration.",
    ],
  },
  {
    id: "goose",
    name: "Goose",
    description: "Native terminal agent, extensions and desktop-compatible configuration.",
    capabilities: ["harness", "context", "skills", "mcp"],
    sourceUrl: "https://github.com/aaif-goose/goose",
    license: "Apache-2.0",
    command: "goose",
    args: ["session"],
    install: { kind: "native", package: "goose" },
    notes: [
      "Choose Use existing Codex or Use existing Claude Code in setup; other providers can use the original Goose configuration. Extensions remain Goose-owned.",
      "A selected FamiliarAgent session is connected through Goose's per-launch stdio extension; the native profile and conversation are preserved.",
    ],
  },
  {
    id: "openrig",
    name: "OpenRig",
    description: "Persistent teams, native orchestration, queues and workspaces.",
    capabilities: ["orchestration", "workspace", "context", "skills", "mcp", "git"],
    sourceUrl: "https://github.com/mvschwarz/openrig",
    license: "Apache-2.0",
    command: "rig",
    args: ["tui"],
    install: { kind: "npm", package: "@openrig/cli" },
    notes: [
      "The foreground dashboard connects to an existing OpenRig daemon. Team creation, approvals and loops remain in OpenRig. It does not reuse a shared tmux shell with an older PATH.",
    ],
  },
  {
    id: "claude-squad",
    name: "Claude Squad",
    description: "Parallel native terminal agents with worktree isolation.",
    capabilities: ["orchestration", "workspace", "git"],
    sourceUrl: "https://github.com/smtg-ai/claude-squad",
    license: "AGPL-3.0",
    command: "cs",
    install: { kind: "native", package: "claude-squad" },
    notes: [
      "Uses the original terminal UI and tmux/worktrees; launching does not import or recreate a team.",
    ],
  },
  {
    id: "superharness",
    name: "superharness",
    description: "Native task contracts, handoff, dispatch and watcher controls.",
    capabilities: ["orchestration", "context", "skills", "mcp", "workspace"],
    sourceUrl: "https://github.com/artificemachine/superharness",
    license: "Apache-2.0",
    command: "superharness",
    args: ["dashboard-ui"],
    install: {
      kind: "python",
      package: "superharness",
      with: ["claude-agent-sdk==0.2.165"],
    },
    notes: [
      "Initialize the project with superharness init before using its tasks. The native dashboard owns its loop state.",
    ],
  },
  {
    id: "orca",
    name: "Orca",
    description: "Original desktop workspace and session UI.",
    capabilities: ["harness", "context", "skills", "mcp", "workspace", "git"],
    sourceUrl: "https://github.com/stablyai/orca",
    license: "MIT",
    desktopApp: "Orca.app",
  },
  {
    id: "hydra",
    name: "Hydra",
    description: "Original desktop multi-agent workspace.",
    capabilities: ["orchestration", "workspace", "git"],
    sourceUrl: "https://github.com/jpdlr/hydra",
    license: "MIT",
    desktopApp: "Hydra.app",
  },
  {
    id: "alethe",
    name: "Alethe",
    description: "Original agent orchestration and context system.",
    capabilities: ["orchestration", "context", "workspace"],
    sourceUrl: "https://github.com/Kc1t/alethe-agents",
    license: "AGPL-3.0",
  },
  {
    id: "codey",
    name: "Codey",
    description: "Native gateway and multi-channel agent system.",
    capabilities: ["harness", "context", "orchestration"],
    sourceUrl: "https://github.com/its-ahoh/codey",
    license: "MIT",
  },
  {
    id: "codeg",
    name: "Codeg",
    description: "Original desktop agent workspace and browser surface.",
    capabilities: ["harness", "context", "workspace", "git"],
    sourceUrl: "https://github.com/spacering-net/codeg",
    license: "Apache-2.0",
    desktopApp: "Codeg.app",
  },
  {
    id: "openharness",
    name: "OpenHarness",
    description: "Original agent packs, tools and native orchestration UI.",
    capabilities: ["harness", "context", "skills", "mcp", "orchestration"],
    sourceUrl: "https://github.com/autonomous-ai/openharness",
    license: "MIT",
  },
  {
    id: "agents",
    name: "wshobson/agents",
    description: "Shared source skills and native multi-harness plugin adapters.",
    capabilities: ["skills", "mcp", "orchestration"],
    sourceUrl: "https://github.com/wshobson/agents",
    license: "MIT",
    notes: [
      "Register selected local skill directories in Shared resources. Native marketplace plugins also contain harness-specific agents, hooks and commands.",
    ],
  },
  {
    id: "firetower",
    command: "firetower",
    name: "Firetower",
    description: "Original compute pool and remote session management.",
    capabilities: ["orchestration", "workspace"],
    sourceUrl: "https://github.com/firetower-cloud/firetower",
    license: "AGPL-3.0",
  },
  {
    id: "skulk",
    command: "skulk",
    name: "Skulk",
    description: "Original SSH, worktree and tmux orchestration.",
    capabilities: ["orchestration", "workspace", "git"],
    sourceUrl: "https://github.com/frantufro/skulk",
    license: "MIT",
  },
  {
    id: "bssh",
    command: "bssh",
    name: "bssh",
    description: "Original parallel SSH and cluster shell.",
    capabilities: ["workspace"],
    sourceUrl: "https://github.com/lablup/bssh",
    license: "Apache-2.0",
  },
  {
    id: "coder",
    command: "coder",
    name: "Coder",
    description: "Existing development workspace infrastructure.",
    capabilities: ["workspace", "git"],
    sourceUrl: "https://github.com/coder/coder",
    license: "AGPL-3.0 / enterprise components",
    notes: [
      "Connect the deployed Coder web URL. FamiliarAgent does not provision its infrastructure.",
    ],
  },
  {
    id: "juicefs",
    command: "juicefs",
    name: "JuiceFS",
    description: "Existing shared filesystem mounts can be mapped as project folders.",
    capabilities: ["workspace"],
    sourceUrl: "https://github.com/juicedata/juicefs",
    license: "Apache-2.0",
    notes: [
      "Mount setup needs an existing metadata/object-storage configuration. No filesystem is created by a tool launch.",
    ],
  },
];
