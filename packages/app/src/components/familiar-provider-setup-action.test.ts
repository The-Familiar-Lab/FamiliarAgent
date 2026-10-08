import { expect, it, vi } from "vitest";
import { prepareProviderSignIn } from "./familiar-provider-setup-action";
function client() {
  return {
    invokePluginRpc: vi.fn().mockResolvedValue({
      cwd: "/host/sign-in",
      command: "/bin/sh",
      args: ["-c", "exec codex login --device-auth"],
    }),
    createWorkspace: vi.fn().mockResolvedValue({ workspace: { id: "wks_test" }, error: null }),
    createTerminal: vi.fn().mockResolvedValue({ terminal: { id: "terminal-test" }, error: null }),
  };
}
it("opens native login in the workspace returned by the selected host", async () => {
  const host = client();
  const result = await prepareProviderSignIn(host, "codex");
  expect(host.createWorkspace).toHaveBeenCalledWith({
    source: { kind: "directory", path: "/host/sign-in" },
    title: "Agent sign-in",
  });
  expect(host.createTerminal).toHaveBeenCalledWith(
    "/host/sign-in",
    "codex sign-in",
    undefined,
    expect.objectContaining({ workspaceId: "wks_test" }),
  );
  expect(result.terminalId).toBe("terminal-test");
});
it("does not proceed after workspace failure or pretend terminal failure is success", async () => {
  const host = client();
  host.createWorkspace.mockResolvedValueOnce({ workspace: null, error: "Directory denied" });
  await expect(prepareProviderSignIn(host, "codex")).rejects.toThrow("Directory denied");
  expect(host.createTerminal).not.toHaveBeenCalled();
  host.createTerminal.mockResolvedValueOnce({ terminal: null, error: "Terminal unavailable" });
  await expect(prepareProviderSignIn(host, "claude")).rejects.toThrow("Terminal unavailable");
});
it("rejects malformed server recipes before creating a workspace", async () => {
  const host = client();
  host.invokePluginRpc.mockResolvedValueOnce({ command: "/bin/sh" });
  await expect(prepareProviderSignIn(host, "codex")).rejects.toThrow();
  expect(host.createWorkspace).not.toHaveBeenCalled();
});
