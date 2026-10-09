import type { TerminalProfile } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  DEFAULT_TERMINAL_PROFILES,
  profileTakesPrompt,
  resolveTerminalProfileLaunch,
} from "@getpaseo/protocol/terminal-profiles";
import { z } from "zod";

function defaultProfileId(profile: TerminalProfile | null): string | undefined {
  if (!profile) return undefined;
  const builtIn = DEFAULT_TERMINAL_PROFILES.find((item) => item.id === profile.id);
  if (!builtIn || profile.command !== builtIn.command) return undefined;
  const args = profile.args ?? [];
  const originalArgs = builtIn.args ?? [];
  return args.length === originalArgs.length && args.every((arg, i) => arg === originalArgs[i])
    ? builtIn.id
    : undefined;
}

/** Only unchanged built-in harness shortcuts use setup. Custom shells and prompt CLIs stay native. */
export function familiarToolForTerminalProfile(
  profile: TerminalProfile | null,
): string | undefined {
  return profile && !profileTakesPrompt(profile) ? defaultProfileId(profile) : undefined;
}

const terminalPlan = z.object({
  mode: z.literal("terminal"),
  command: z.string().min(1),
  args: z.array(z.string()).max(128),
});

/** Managed discovery includes app-bundled Codex and the same scoped PATH/MCP as Hub launches. */
export async function prepareTerminalProfileLaunch(
  client: Pick<DaemonClient, "invokePluginRpc">,
  cwd: string,
  profile: TerminalProfile,
  prompt: string,
) {
  const resolved = resolveTerminalProfileLaunch(profile, prompt);
  const id = defaultProfileId(profile);
  if (id !== "claude" && id !== "codex") return resolved;
  const plan = terminalPlan.parse(
    await client.invokePluginRpc("familiar-workspace", "tools.prepare", {
      id,
      action: "launch",
      surface: "terminal",
      cwd,
    }),
  );
  return {
    ...plan,
    name: profile.name,
    args: [...plan.args, ...(resolved.args.length ? ["--", ...resolved.args] : [])],
  };
}
