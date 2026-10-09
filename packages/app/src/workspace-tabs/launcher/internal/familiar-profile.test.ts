import { expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_PROFILES } from "@getpaseo/protocol/terminal-profiles";
import { familiarToolForTerminalProfile, prepareTerminalProfileLaunch } from "./familiar-profile";

it.each(["aider", "goose", "openrig", "claude-squad"])(
  "routes the unchanged built-in %s through setup",
  (id) => {
    const original = DEFAULT_TERMINAL_PROFILES.find((item) => item.id === id)!;
    expect(familiarToolForTerminalProfile(original)).toBe(id);
    expect(familiarToolForTerminalProfile({ ...original, name: "Renamed shortcut" })).toBe(id);
    expect(
      familiarToolForTerminalProfile({ ...original, command: "/my/custom/wrapper" }),
    ).toBeUndefined();
    expect(
      familiarToolForTerminalProfile({
        ...original,
        args: [...(original.args ?? []), "--my-flag"],
      }),
    ).toBeUndefined();
    expect(familiarToolForTerminalProfile({ ...original, id: "my-profile" })).toBeUndefined();
  },
);
it("preserves prompt CLIs and the default shell", () => {
  expect(familiarToolForTerminalProfile(null)).toBeUndefined();
  for (const id of ["claude", "codex", "opencode", "pi"])
    expect(
      familiarToolForTerminalProfile(DEFAULT_TERMINAL_PROFILES.find((item) => item.id === id)!),
    ).toBeUndefined();
});
it.each(["claude", "codex"])(
  "resolves the actual installed %s command while preserving a literal typed prompt",
  async (id) => {
    const profile = DEFAULT_TERMINAL_PROFILES.find((item) => item.id === id)!;
    const invokePluginRpc = vi.fn().mockResolvedValue({
      mode: "terminal",
      command: "/usr/bin/env",
      args: [
        "PATH=/managed/bin:/usr/bin",
        `/Applications/Native.app/Contents/Resources/${id}`,
        "--config",
        "native",
      ],
    });
    const prompt = "--help $(never-run)\nContinue this exact input";
    const launch = await prepareTerminalProfileLaunch(
      { invokePluginRpc },
      "/new/worktree",
      profile,
      prompt,
    );
    expect(invokePluginRpc).toHaveBeenCalledWith("familiar-workspace", "tools.prepare", {
      id,
      action: "launch",
      surface: "terminal",
      cwd: "/new/worktree",
    });
    expect(launch.command).toBe("/usr/bin/env");
    expect(launch.args).toEqual([
      "PATH=/managed/bin:/usr/bin",
      `/Applications/Native.app/Contents/Resources/${id}`,
      "--config",
      "native",
      "--",
      prompt,
    ]);
  },
);
it("keeps custom native wrappers unchanged and never falls back silently after a canonical discovery failure", async () => {
  const invokePluginRpc = vi
    .fn()
    .mockRejectedValue(new Error("Codex is not installed. Open Set up."));
  const profile = DEFAULT_TERMINAL_PROFILES.find((item) => item.id === "codex")!;
  await expect(
    prepareTerminalProfileLaunch({ invokePluginRpc }, "/project", profile, ""),
  ).rejects.toThrow("Codex is not installed");
  invokePluginRpc.mockClear();
  expect(
    await prepareTerminalProfileLaunch(
      { invokePluginRpc },
      "/project",
      { ...profile, command: "/custom/codex" },
      "literal",
    ),
  ).toEqual({ name: "Codex", command: "/custom/codex", args: ["literal"] });
  expect(invokePluginRpc).not.toHaveBeenCalled();
});
