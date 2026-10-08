import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { forkWorktree } from "./entry.js";
import { CreateAgentLifecycleDispatch } from "../../../../packages/server/src/server/agent/create-agent-lifecycle-dispatch.js";
import { createWorktreeCore } from "../../../../packages/server/src/server/worktree-core.js";

it("the Hub fork request creates a real native worktree using a resolved branch instead of rejected HEAD", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "familiar-hub-worktree-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init", "-b", "trunk");
    writeFileSync(path.join(repo, "file.txt"), "committed\n");
    git("add", "file.txt");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    );
    writeFileSync(path.join(repo, "file.txt"), "uncommitted source change\n");
    const dispatcher = new CreateAgentLifecycleDispatch({
      paseoHome: path.join(root, "state"),
      worktreesRoot: path.join(root, "worktrees"),
      createPaseoWorktreeWorkflow: async (input, overrides) =>
        createWorktreeCore(input, {
          github: {} as Parameters<typeof createWorktreeCore>[1]["github"],
          workspaceGitService: {
            resolveRepoRoot: async () => repo,
            resolveDefaultBranch: async () => "trunk",
            resolveForge: async () => null,
          },
          ...overrides,
        }),
    } as ConstructorParameters<typeof CreateAgentLifecycleDispatch>[0]);
    const created = await dispatcher.createWorktreeForRequest({
      cwd: repo,
      target: forkWorktree("test"),
      firstAgentContext: { prompt: "Continue work" },
      hasLegacyGitOptions: false,
    });
    expect(created?.worktree.worktreePath).not.toBe(repo);
    expect(readFileSync(path.join(created!.worktree.worktreePath, "file.txt"), "utf8")).toBe(
      "committed\n",
    );
    expect(readFileSync(path.join(repo, "file.txt"), "utf8")).toBe("uncommitted source change\n");
    await expect(
      dispatcher.createWorktreeForRequest({
        cwd: repo,
        target: { ...forkWorktree("invalid"), base: "HEAD" },
        firstAgentContext: { prompt: "Continue work" },
        hasLegacyGitOptions: false,
      }),
    ).rejects.toThrow("Base branch cannot be HEAD");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
