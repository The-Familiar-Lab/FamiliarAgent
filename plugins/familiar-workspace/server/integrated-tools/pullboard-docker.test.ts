import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolActionContext, ToolActionRequest } from "../tool-actions/contracts.js";
import { pullboardAdapter } from "./pullboard.js";
import { dockerSkillsAdapter, inspectDockerSkills } from "./docker-skills.js";
import { integratedRecipe } from "./setup-recipes.js";
import { prepareIntegratedSetup, readIntegratedSetup } from "./setup.js";

let root: string;
let context: ToolActionContext;
const request = (action: string, values: Partial<ToolActionRequest> = {}): ToolActionRequest => ({
  toolId: "pullboard",
  action,
  cwd: root,
  sessionId: "same-session",
  input: "Exact input\n' $HOME $(never-execute)",
  parameters: {},
  ...values,
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "familiar-pullboard-docker-"));
  context = {
    runDirectory: root,
    signal: new AbortController().signal,
    resolveCommand: vi.fn(async (command) => command),
    exec: vi.fn(async () => ({
      stdout: '{"version":1,"item":{"item_id":12}}',
      stderr: "",
      exitCode: 0,
    })),
    request: vi.fn(),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function skillPack(directory = root) {
  await mkdir(join(directory, "skills/docker-compose-patterns"), { recursive: true });
  await writeFile(
    join(directory, "skills.sh.json"),
    JSON.stringify({
      groupings: [
        { title: "Compose", description: "Native guidance", skills: ["docker-compose-patterns"] },
      ],
    }),
  );
  await writeFile(
    join(directory, "skills/docker-compose-patterns/SKILL.md"),
    "---\nname: docker-compose-patterns\n---\nOriginal guidance.",
  );
  return directory;
}

describe("original Pullboard command boundaries", () => {
  it("keeps a selected result byte-for-byte in the native brief and reports filing, not execution", async () => {
    const input = request("add", {
      parameters: { lane: "build", title: "A title; $(literal)", criterion: "--literal criterion" },
    });
    const output = await pullboardAdapter.execute(input, context);
    expect(output).toMatchObject({ state: "submitted", nativeId: "12" });
    expect(await readFile(join(root, "pullboard-brief.txt"), "utf8")).toBe(input.input);
    expect(context.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "add",
          "build",
          "A title; $(literal)",
          "--brief-file",
          join(root, "pullboard-brief.txt"),
          "--criterion=--literal criterion",
          "--json",
        ],
      }),
    );
  });
  it("rejects option-shaped positional values and invalid native IDs before execution", async () => {
    await expect(
      pullboardAdapter.execute(
        request("add", { parameters: { lane: "--help", title: "Title" } }),
        context,
      ),
    ).rejects.toThrow("option marker");
    await expect(
      pullboardAdapter.execute(request("read", { nativeId: "1 --all" }), context),
    ).rejects.toThrow("positive native");
    expect(context.exec).not.toHaveBeenCalled();
  });
  it("preserves the original refusal and repair instead of pretending success", async () => {
    vi.mocked(context.exec).mockResolvedValue({
      stdout:
        '{"version":1,"error":{"code":"NO_LANE","message":"Missing lane","next":"Declare it first"}}',
      stderr: "",
      exitCode: 1,
    });
    await expect(pullboardAdapter.execute(request("init"), context)).rejects.toThrow(
      "NO_LANE. Missing lane Declare it first",
    );
  });
  it("rejects incompatible responses and never auto-initializes while reading", async () => {
    vi.mocked(context.exec).mockResolvedValue({ stdout: '{"version":2}', stderr: "", exitCode: 0 });
    await expect(pullboardAdapter.execute(request("status"), context)).rejects.toThrow(
      "response version",
    );
    expect(context.exec).toHaveBeenCalledOnce();
    expect(context.exec).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["status", "--json"] }),
    );
  });
  it("exports a finite native snapshot and never persists a live session-secret URL", async () => {
    vi.mocked(context.exec).mockResolvedValue({
      stdout: JSON.stringify({ version: 1, path: join(root, "pullboard-view") }),
      stderr: "",
      exitCode: 0,
    });
    const output = await pullboardAdapter.execute(request("snapshot"), context);
    expect(output.artifacts?.[0]?.path).toBe(join(root, "pullboard-view/index.html"));
    expect(context.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["view", "--export", join(root, "pullboard-view"), "--json"],
      }),
    );
    expect(JSON.stringify(output)).not.toContain("?k=");
  });
});

describe("original Docker skill references", () => {
  it("reads source guidance and returns host paths without executing a model or Docker", async () => {
    await skillPack();
    const input = request("read", {
      toolId: "docker-skills",
      parameters: { packRoot: root },
      nativeId: "docker-compose-patterns",
    });
    const output = await dockerSkillsAdapter.execute(input, context);
    expect(output.text).toBe(
      await readFile(join(root, "skills/docker-compose-patterns/SKILL.md"), "utf8"),
    );
    expect(context.exec).not.toHaveBeenCalled();
    expect(context.request).not.toHaveBeenCalled();
  });
  it("refuses duplicated inventory IDs and a skill directory outside its pack", async () => {
    await skillPack();
    const file = join(root, "skills.sh.json");
    const index = JSON.parse(await readFile(file, "utf8"));
    index.groupings[0].skills.push("docker-compose-patterns");
    await writeFile(file, JSON.stringify(index));
    await expect(inspectDockerSkills(root)).rejects.toThrow("duplicate");
    index.groupings[0].skills.pop();
    await writeFile(file, JSON.stringify(index));
    await rm(join(root, "skills/docker-compose-patterns"), { recursive: true });
    await symlink(tmpdir(), join(root, "skills/docker-compose-patterns"));
    await expect(inspectDockerSkills(root)).rejects.toThrow("inside the selected pack");
  });
  it("registers nothing on install preparation, then explicitly returns only strict resource references", async () => {
    vi.mocked(context.exec).mockResolvedValue({ stdout: "v24.21.0\n", stderr: "", exitCode: 0 });
    const options = { id: "docker-skills", root, cwd: root };
    const install = await prepareIntegratedSetup({ ...options, action: "install" }, context);
    expect(install?.skills).toBeUndefined();
    const recipe = integratedRecipe("docker-skills", process.platform, process.arch)!;
    const folder = join(root, "tools/native", `docker-skills-${recipe.version}`);
    await skillPack(folder);
    for (const file of recipe.verify.filter((entry) => entry !== "skills.sh.json")) {
      await mkdir(join(folder, file, ".."), { recursive: true });
      await writeFile(join(folder, file), "original manifest");
    }
    await writeFile(
      join(folder, ".familiar-install.json"),
      JSON.stringify({ id: "docker-skills", version: recipe.version }),
    );
    const configured = await prepareIntegratedSetup({ ...options, action: "configure" }, context);
    expect(configured?.skills).toEqual([
      {
        id: "docker-compose-patterns",
        path: await realpath(join(folder, "skills/docker-compose-patterns")),
        enabled: true,
      },
    ]);
    expect(await readIntegratedSetup(options, context)).toMatchObject({
      installation: "installed",
      account: "not-required",
      actions: [{ id: "configure", label: "Add to Memory & Skills" }],
    });
  });
});
