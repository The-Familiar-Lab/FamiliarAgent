import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  symlink,
  readlink,
  rm,
  lstat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ResourceLibrary } from "./resources.js";

let root: string;
let library: ResourceLibrary;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "familiar-skills-")));
  library = new ResourceLibrary(path.join(root, "state"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function skill(name: string, text = `# ${name}\nOriginal content\n`) {
  const folder = path.join(root, name);
  await mkdir(folder);
  await writeFile(path.join(folder, "SKILL.md"), text);
  return { id: name, path: folder, enabled: true };
}

describe("registered shared skill actions", () => {
  it("adds canonical source references without changing source contents and idempotently keeps identical mappings", async () => {
    const entry = await skill("review");
    const original = await readFile(path.join(entry.path, "SKILL.md"));
    const alias = path.join(root, "alias");
    await symlink(entry.path, alias, "dir");
    const first = await library.useSkills({
      expectedRevision: 0,
      skills: [{ ...entry, path: alias }],
    });
    expect(first).toMatchObject({ status: "added", resources: { revision: 1, skills: [entry] } });
    expect(await library.useSkills({ expectedRevision: 1, skills: [entry] })).toEqual({
      status: "unchanged",
      resources: first.resources,
    });
    expect(await readFile(path.join(entry.path, "SKILL.md"))).toEqual(original);
  });
  it("rejects conflicting mappings and an invalid batch atomically", async () => {
    const original = await skill("review");
    const other = await skill("different");
    await library.useSkills({ expectedRevision: 0, skills: [original] });
    await expect(
      library.useSkills({ expectedRevision: 1, skills: [{ ...original, path: other.path }] }),
    ).rejects.toThrow("preserved");
    await expect(
      library.useSkills({
        expectedRevision: 1,
        skills: [other, { id: "missing", path: path.join(root, "missing"), enabled: true }],
      }),
    ).rejects.toThrow();
    expect((await library.list()).skills).toEqual([original]);
    expect((await library.list()).revision).toBe(1);
  });
  it("serializes same-revision additions and keeps unrelated MCP settings", async () => {
    const first = await skill("one"),
      second = await skill("two");
    const mcp = {
      id: "kept",
      type: "http" as const,
      url: "https://mcp.example.test",
      enabled: true,
    };
    await library.save({ revision: 0, skills: [], mcp: [mcp] });
    const outcomes = await Promise.allSettled(
      [first, second].map((entry) => library.useSkills({ expectedRevision: 1, skills: [entry] })),
    );
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await library.list()).toMatchObject({ revision: 2, mcp: [mcp] });
    expect((await library.list()).skills).toHaveLength(1);
  });
  it("bounds reads, reports truncation, and never accepts an arbitrary unregistered file path", async () => {
    const text = "# Review\n" + "source line\n".repeat(10000);
    const entry = await skill("review", text);
    await library.useSkills({ expectedRevision: 0, skills: [entry] });
    expect(await library.readSkill({ id: "review", maxCharacters: 256 })).toMatchObject({
      text: text.slice(0, 256),
      truncated: true,
      path: path.join(entry.path, "SKILL.md"),
    });
    await expect(library.readSkill({ id: "unknown" })).rejects.toThrow("not registered");
    await expect(
      library.readSkill({ id: "review", path: "/unrelated/file" } as never),
    ).rejects.toThrow();
    await expect(library.readSkill({ id: "review", maxCharacters: 65537 })).rejects.toThrow();
  });
  it("refuses a SKILL.md symlink escaping its registered source folder", async () => {
    const entry = await skill("review");
    await library.useSkills({ expectedRevision: 0, skills: [entry] });
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "PRIVATE OUTSIDE CONTENT");
    await rm(path.join(entry.path, "SKILL.md"));
    await symlink(outside, path.join(entry.path, "SKILL.md"));
    await expect(library.readSkill({ id: "review" })).rejects.toThrow("inside its registered");
    expect(await readFile(outside, "utf8")).toBe("PRIVATE OUTSIDE CONTENT");
  });
  it("rejects a replaced FIFO without waiting for a writer", async () => {
    const entry = await skill("review");
    await library.useSkills({ expectedRevision: 0, skills: [entry] });
    const file = path.join(entry.path, "SKILL.md");
    await rm(file);
    execFileSync("mkfifo", [file]);
    await expect(library.readSkill({ id: "review" })).rejects.toThrow("regular file");
  });
  it("requires the observed revision for project application and removes only owned links after disable/remove", async () => {
    const entry = await skill("review");
    const source = path.join(entry.path, "SKILL.md");
    const original = await readFile(source);
    const project = path.join(root, "project");
    await mkdir(project);
    await library.useSkills({ expectedRevision: 0, skills: [entry] });
    await expect(
      library.project({ cwd: project, toolId: "codex", expectedRevision: 0 }),
    ).rejects.toThrow("changed");
    await expect(lstat(path.join(project, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    const target = path.join(project, ".agents/skills/review");
    expect(
      (await library.project({ cwd: project, toolId: "codex", expectedRevision: 1 })).paths,
    ).toEqual([target]);
    expect(await readlink(target)).toBe(entry.path);
    const unmanaged = path.join(project, ".agents/skills/personal");
    await mkdir(unmanaged);
    await writeFile(path.join(unmanaged, "SKILL.md"), "Personal skill");
    expect(
      await library.changeSkill({ id: "review", action: "disable", expectedRevision: 1 }),
    ).toMatchObject({ revision: 2, skills: [{ ...entry, enabled: false }] });
    expect(
      (await library.project({ cwd: project, toolId: "codex", expectedRevision: 2 })).removed,
    ).toEqual([target]);
    await library.changeSkill({ id: "review", action: "enable", expectedRevision: 2 });
    await library.project({ cwd: project, toolId: "codex", expectedRevision: 3 });
    await library.changeSkill({ id: "review", action: "remove", expectedRevision: 3 });
    expect(
      (await library.project({ cwd: project, toolId: "codex", expectedRevision: 4 })).removed,
    ).toEqual([target]);
    expect(await readFile(source)).toEqual(original);
    expect(await readFile(path.join(unmanaged, "SKILL.md"), "utf8")).toBe("Personal skill");
  });
  it("rejects stale enable/remove requests without replacing the winning change", async () => {
    const entry = await skill("review");
    await library.useSkills({ expectedRevision: 0, skills: [entry] });
    const results = await Promise.allSettled([
      library.changeSkill({ id: "review", action: "disable", expectedRevision: 1 }),
      library.changeSkill({ id: "review", action: "remove", expectedRevision: 1 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await library.list()).revision).toBe(2);
    expect(await readFile(path.join(entry.path, "SKILL.md"), "utf8")).toContain("Original content");
  });
});
