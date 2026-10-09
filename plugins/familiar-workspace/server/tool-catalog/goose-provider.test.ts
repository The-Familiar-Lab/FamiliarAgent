import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  gooseProviderEnvironment,
  goosePreferencesFile,
  prepareGooseProvider,
  readGooseProvider,
  gooseAdapterBins,
} from "./goose-provider.js";
import { ToolCatalog } from "./service.js";
import { ToolSetup } from "./setup.js";
import { gooseAdapter } from "../native-tools/goose.js";
import type { ToolActionContext } from "../tool-actions/contracts.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "familiar-goose-' "));
  roots.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  for (const name of ["goose", "codex", "claude"])
    await writeFile(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const tools = new ToolCatalog(root, {
    home: root,
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
  });
  return { root, tools, bin };
}
it("does not change Goose preferences when setup is only prepared or installation fails", async () => {
  const { root, tools, bin } = await fixture();
  await writeFile(path.join(bin, "npm"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  const before = { provider: "claude-acp", model: "current", mode: "smart_approve" };
  await mkdir(path.dirname(goosePreferencesFile(root)), { recursive: true });
  await writeFile(goosePreferencesFile(root), JSON.stringify(before));
  const plan = await prepareGooseProvider(root, root, tools, "codex");
  expect(await readGooseProvider(root)).toEqual(before);
  expect(() => execFileSync(plan.command!, plan.args, { stdio: "pipe" })).toThrow();
  expect(await readGooseProvider(root)).toEqual(before);
});
it("commits only nonsecret Familiar preferences after installation and uses them in native launch", async () => {
  const { root, tools, bin } = await fixture();
  await writeFile(
    path.join(bin, "npm"),
    '#!/bin/sh\nmkdir -p "$3/node_modules/.bin"\nprintf "#!/bin/sh\\nexit 0\\n" > "$3/node_modules/.bin/codex-acp"\nchmod 700 "$3/node_modules/.bin/codex-acp"\n',
    { mode: 0o700 },
  );
  const plan = await prepareGooseProvider(root, root, tools, "codex");
  execFileSync(plan.command!, plan.args, { stdio: "pipe" });
  expect(await gooseProviderEnvironment(root)).toEqual({
    GOOSE_PROVIDER: "codex-acp",
    GOOSE_MODEL: "current",
    GOOSE_MODE: "smart_approve",
    GOOSE_SEARCH_PATHS: JSON.stringify(gooseAdapterBins(root)),
  });
  const launch = await tools.prepare({ id: "goose", action: "launch", cwd: root });
  expect(launch.args).toContain("GOOSE_PROVIDER=codex-acp");
  expect(launch.args).toContain("GOOSE_MODE=smart_approve");
  expect(launch.args[0]).toContain("goose-acp/codex/node_modules/.bin");
  const acpBin = path.join(root, "tools/goose-acp/codex/node_modules/.bin");
  await writeFile(path.join(acpBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  expect(await tools.resolveCommand("codex")).toBe(path.join(bin, "codex"));
  const status = await new ToolSetup(root, tools).status("goose", false);
  expect(status.actions.map((action) => action.id)).toContain("use-codex");
  expect(status.account).toBe("not-checked");
  const originalProfile = path.join(root, "original-goose-profile.yaml");
  await writeFile(originalProfile, "GOOSE_PROVIDER: original\n");
  const restored = await new ToolSetup(root, tools).prepare({
    id: "goose",
    action: "use-goose-profile",
  });
  expect(restored.settings).toHaveLength(2);
  expect(await gooseProviderEnvironment(root)).toEqual({});
  expect(await readFile(originalProfile, "utf8")).toBe("GOOSE_PROVIDER: original\n");
});
it("continues ACP using a fresh original session, bounded source history and the same shared MCP", async () => {
  const { root } = await fixture();
  const exec = vi.fn<ToolActionContext["exec"]>();
  exec.mockResolvedValueOnce({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      id: "old",
      working_dir: root,
      provider_name: "codex-acp",
      conversation: [{ role: "assistant", content: [{ type: "text", text: "remember me" }] }],
      extension_data: {
        "enabled_extensions.v0": { extensions: [{ name: "familiar_context", cmd: "old" }] },
      },
    }),
  });
  exec.mockResolvedValueOnce({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      metadata: { status: "completed" },
      messages: [{ role: "assistant", content: [{ type: "text", text: "continued" }] }],
    }),
  });
  exec.mockResolvedValueOnce({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify([
      { id: "new", name: `familiar-${path.basename(root)}`, working_dir: root },
    ]),
  });
  const result = await gooseAdapter.execute(
    {
      toolId: "goose",
      action: "resume",
      nativeId: "old",
      sessionId: "logical",
      cwd: root,
      input: "next exact input",
      parameters: {},
    },
    {
      runDirectory: root,
      signal: new AbortController().signal,
      exec,
      request: vi.fn(),
      resolveCommand: async (command) => command,
      nativeContext: async () => ({
        args: ["--with-extension", "familiar_context:original"],
        env: {
          GOOSE_PROVIDER: "codex-acp",
          GOOSE_MODEL: "current",
          GOOSE_MODE: "smart_approve",
          FAMILIAR_SESSION_ID: "logical",
        },
      }),
    },
  );
  expect(result).toMatchObject({ nativeId: "new", text: "continued" });
  const run = exec.mock.calls[1]![0];
  expect(run.args).not.toContain("--resume");
  expect(run.args).toContain("familiar_context:original");
  expect(run.args).not.toContain("--system");
  expect(await readFile(path.join(root, "goose-continuation.txt"), "utf8")).toContain(
    "remember me",
  );
  expect(run.env?.FAMILIAR_SESSION_ID).toBe("logical");
  expect(await readFile(path.join(root, "input.txt"), "utf8")).toBe("next exact input");
});
