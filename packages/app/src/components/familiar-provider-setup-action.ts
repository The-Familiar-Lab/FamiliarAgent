import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
const recipe = z.object({ cwd: z.string(), command: z.string(), args: z.array(z.string()) });
export async function prepareProviderSignIn(
  client: Pick<DaemonClient, "invokePluginRpc" | "createWorkspace" | "createTerminal">,
  provider: "codex" | "claude",
) {
  const command = recipe.parse(
    await client.invokePluginRpc("familiar-workspace", "provider.setup", { provider }),
  );
  const created = await client.createWorkspace({
    source: { kind: "directory", path: command.cwd },
    title: "Agent sign-in",
  });
  if (created.error || !created.workspace)
    throw new Error(created.error ?? "Unable to open sign-in workspace");
  const terminal = await client.createTerminal(command.cwd, `${provider} sign-in`, undefined, {
    command: command.command,
    args: command.args,
    workspaceId: created.workspace.id,
  });
  if (terminal.error || !terminal.terminal)
    throw new Error(terminal.error ?? "Unable to open sign-in terminal");
  return { workspace: created.workspace, terminalId: terminal.terminal.id };
}
