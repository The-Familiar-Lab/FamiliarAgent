import { afterEach, expect, test, vi } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";

let context: DaemonTestContext | undefined;
let root: string | undefined;
afterEach(async () => {
  await context?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("advisor creation preserves explicit read-only context without projecting skills or injecting shared MCP", async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "familiar-advisor-")));
  const home = path.join(root, ".paseo");
  vi.stubEnv("PASEO_HOME", home);
  const clients = createTestAgentClients({ supportsMcpServers: true });
  const claudeCreate = vi.spyOn(clients.claude, "createSession");
  const codexCreate = vi.spyOn(clients.codex, "createSession");
  context = await createDaemonTestContext({
    paseoHomeRoot: root,
    pluginsEnabled: true,
    agentClients: clients,
    builtinPlugins: new BuiltinPluginLoader(
      path.resolve(import.meta.dirname, "../../../../../plugins"),
      ["familiar-workspace"],
    ),
  });
  const skill = path.join(root, "original-skill");
  const project = path.join(root, "project");
  await mkdir(skill);
  await mkdir(project);
  await writeFile(path.join(skill, "SKILL.md"), "# Original instructions\n");
  const shared = { id: "shared", type: "http", url: "https://mcp.example.test", enabled: true };
  await context.client.invokePluginRpc("familiar-workspace", "resources.save", {
    revision: 0,
    skills: [{ id: "review", path: skill, enabled: true }],
    mcp: [shared],
  });
  const resourceFile = path.join(home, "familiar/resources.json");
  const originalResources = await readFile(resourceFile);
  const readonlyContext = {
    type: "stdio" as const,
    command: process.execPath,
    args: ["context", "mcp", "--session", "source-session", "--read-only"],
  };
  for (const provider of ["codex", "claude"] as const) {
    const labels = { familiarAdvisor: "true", familiarAdvisorSource: "source-session" };
    const agent = await context.client.createAgent({
      provider,
      cwd: project,
      title: "Ask Familiar",
      labels,
      mcpServers: { familiar_context: readonlyContext },
    });
    expect(agent.labels).toMatchObject(labels);
    const nativeCreate = provider === "codex" ? codexCreate : claudeCreate;
    const nativeConfig = nativeCreate.mock.calls.at(-1)![0];
    expect(nativeConfig.mcpServers?.familiar_context).toEqual(readonlyContext);
    expect(nativeConfig.mcpServers).not.toHaveProperty("shared");
    await expect(lstat(path.join(project, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(project, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await readFile(resourceFile)).toEqual(originalResources);
  // The caller marker is exact; ordinary agents retain the previous projection and MCP behavior.
  await context.client.createAgent({
    provider: "codex",
    cwd: project,
    labels: { familiarAdvisor: "false" },
  });
  expect(codexCreate.mock.calls.at(-1)![0].mcpServers?.shared).toEqual({
    type: "http",
    url: shared.url,
  });
  expect(await readlink(path.join(project, ".agents/skills/review"))).toBe(skill);
  expect(await readFile(path.join(skill, "SKILL.md"), "utf8")).toBe("# Original instructions\n");
}, 30_000);
