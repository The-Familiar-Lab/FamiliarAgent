import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareToolSetup } from "../../shared/tool-setup.js";
import { INTEGRATED_INSTALL_DRIVER, integratedInstallPlan } from "./setup-install.js";
import { integratedRecipe } from "./setup-recipes.js";
import { INTEGRATED_TOOL_ADAPTERS } from "./index.js";
import {
  integratedActionDefaults,
  integratedInstallation,
  prepareIntegratedSetup,
  readIntegratedSetup,
  readOpenHarnessSetup,
} from "./setup.js";

let root: string;
const context = {
  resolveCommand: vi.fn(async (value: string) => value),
  exec: vi.fn(async () => ({ stdout: "v24.22.0\n", stderr: "", exitCode: 0 })),
};
const options = (id: string) => ({
  id,
  root,
  cwd: root,
  platform: "darwin",
  arch: "arm64",
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "familiar-setup-test-"));
  vi.clearAllMocks();
  context.exec.mockResolvedValue({
    stdout: "v24.22.0\n",
    stderr: "",
    exitCode: 0,
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function markInstalled(id: string) {
  const recipe = integratedRecipe(id, "darwin", "arm64")!;
  const directory = join(root, "tools/native", `${id}-${recipe.version}`);
  for (const entry of recipe.verify) {
    await mkdir(join(directory, entry, ".."), { recursive: true });
    await writeFile(join(directory, entry), "native entry");
  }
  await writeFile(
    join(directory, ".familiar-install.json"),
    JSON.stringify({ id, version: recipe.version }),
  );
  return directory;
}

describe("native setup boundaries", () => {
  it("saves only settings declared by each original action's actual contract", async () => {
    await markInstalled("codeg");
    const codeg = await prepareIntegratedSetup(
      { ...options("codeg"), action: "configure" },
      context,
    );
    for (const adapter of INTEGRATED_TOOL_ADAPTERS) {
      const settings =
        adapter.id === "codeg"
          ? codeg!.settings!
          : integratedActionDefaults(options(adapter.id), process.execPath);
      for (const entry of settings) {
        const action = adapter.actions.find((item) => item.id === entry.action);
        expect(action, `${adapter.id}/${entry.action} must exist`).toBeDefined();
        const declared = action!.parameters?.map((parameter) => parameter.key) ?? [];
        for (const key of Object.keys(entry.parameters))
          expect(declared, `${adapter.id}/${entry.action} cannot accept ${key}`).toContain(key);
      }
    }
    expect(codeg!.settings!.find((item) => item.action === "list")!.parameters).not.toHaveProperty(
      "agentType",
    );
    expect(
      codeg!.settings!.find((item) => item.action === "prepare-agent")!.parameters.agentType,
    ).toBe("claude_code");
  });
  it("keeps original app installation separate from unprepared canonical adapter files", async () => {
    const result = await readIntegratedSetup(
      { ...options("orca"), existingInstallation: true },
      context,
    );
    expect(result).toMatchObject({
      installation: "installed",
      account: "not-checked",
      actions: [{ id: "install", label: "Install integration files" }],
    });
    expect(await integratedInstallation(root, "toString")).toBe(false);
    expect(integratedRecipe("constructor", "darwin", "arm64")).toBeNull();
  });
  it("does not mistake a selected setup plan or incomplete install for installed", async () => {
    const result = await prepareIntegratedSetup(
      { ...options("agents"), action: "install" },
      context,
    );
    expect(prepareToolSetup.output.parse(result).settings).toHaveLength(2);
    expect(await integratedInstallation(root, "agents")).toBe(false);
    expect(result?.plan.args.join(" ")).not.toContain("work/desktop-harness");
    await markInstalled("agents");
    expect(await integratedInstallation(root, "agents")).toBe(true);
  });
  it("refuses incompatible Node before preparing an unusable native build", async () => {
    context.exec.mockResolvedValue({
      stdout: "v18.20.0\n",
      stderr: "",
      exitCode: 0,
    });
    await expect(
      prepareIntegratedSetup({ ...options("codey"), action: "install" }, context),
    ).rejects.toThrow("20 or newer");
  });
  it("keeps native login interactive and preserves the original account", async () => {
    const result = await prepareIntegratedSetup(
      { ...options("openharness"), action: "login" },
      context,
    );
    expect(result?.plan).toMatchObject({ command: "harness", args: ["login"] });
    expect(await readdir(root)).toEqual([]);
    expect(context.exec).toHaveBeenCalledTimes(1);
  });
  it("returns only sanitized sign-in state, including offline and unresponsive daemon", async () => {
    context.exec.mockResolvedValueOnce({
      stdout: JSON.stringify({
        loggedIn: true,
        offline: true,
        machineId: "private-id",
        accessToken: "must-not-leak",
      }),
      stderr: "",
      exitCode: 0,
    });
    context.exec.mockResolvedValueOnce({
      stdout: "● running · not answering yet",
      stderr: "",
      exitCode: 0,
    });
    const result = await readOpenHarnessSetup(context, root);
    expect(result).toMatchObject({
      installed: true,
      account: "offline",
      runtime: "unknown",
    });
    expect(JSON.stringify(result)).not.toMatch(/private-id|must-not-leak/u);
  });
  it("does not report signed-out Harness as ready just because auth status exits zero", async () => {
    context.exec.mockResolvedValueOnce({
      stdout: '{"loggedIn":false}',
      stderr: "",
      exitCode: 0,
    });
    context.exec.mockResolvedValueOnce({
      stdout: "○ stopped",
      stderr: "",
      exitCode: 0,
    });
    expect(await readIntegratedSetup(options("openharness"), context)).toMatchObject({
      installation: "installed",
      account: "sign-in-required",
    });
  });
  it("prepares private Codeg connection defaults without exposing a token or changing it on retry", async () => {
    await markInstalled("codeg");
    const first = await prepareIntegratedSetup({ ...options("codeg"), action: "start" }, context);
    const tokenFile = first!.settings![0]!.parameters.tokenFile!;
    const token = await readFile(tokenFile, "utf8");
    const second = await prepareIntegratedSetup({ ...options("codeg"), action: "start" }, context);
    expect(await readFile(tokenFile, "utf8")).toBe(token);
    expect(JSON.stringify(first)).not.toContain(token.trim());
    expect((await stat(tokenFile)).mode & 0o077).toBe(0);
    expect(first?.settings).toEqual(second?.settings);
    expect(first?.settings?.map((item) => item.action)).toEqual([
      "prepare-agent",
      "list",
      "create",
      "send",
      "read",
    ]);
  });
  it("reports unsupported release architectures without pretending an install is available", async () => {
    const result = await readIntegratedSetup(
      { ...options("alethe"), platform: "linux", arch: "arm64" },
      context,
    );
    expect(result?.installation).toBe("missing");
    expect(result?.actions).toEqual([]);
    expect(result?.details.join(" ")).toContain("not available");
  });
});

it("verified native archive install is atomic, rejects bad checksums, and preserves an existing folder", async () => {
  const archiveRoot = join(root, "payload");
  await mkdir(archiveRoot);
  await writeFile(join(archiveRoot, "native.txt"), "original bytes");
  const archive = join(root, "original.tar.gz");
  await promisify(execFile)("tar", ["-czf", archive, "-C", archiveRoot, "native.txt"]);
  const bytes = await readFile(archive);
  const server = createServer((_request, response) => response.end(bytes));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server");
    const recipe = {
      id: "test-native",
      version: "1",
      url: `http://127.0.0.1:${address.port}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "tar" as const,
      verify: ["native.txt"],
    };
    const destination = join(root, "native-install");
    const node = join(root, "Electron Helper");
    await writeFile(
      node,
      `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = "1" ] || exit 42\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
      { mode: 0o700 },
    );
    const plan = integratedInstallPlan({
      recipe,
      destination,
      cwd: root,
      node,
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(plan.command!, plan.args, {
      env,
      timeout: 15_000,
    });
    expect(await readFile(join(destination, "native.txt"), "utf8")).toBe("original bytes");
    await expect(
      promisify(execFile)(process.execPath, [
        "-e",
        INTEGRATED_INSTALL_DRIVER,
        JSON.stringify({ ...recipe, sha256: "0".repeat(64) }),
        join(root, "bad-install"),
        process.execPath,
      ]),
    ).rejects.toThrow("SHA-256");
    const existing = join(root, "existing");
    await mkdir(existing);
    await writeFile(join(existing, "keep"), "user data");
    await expect(
      promisify(execFile)(process.execPath, [
        "-e",
        INTEGRATED_INSTALL_DRIVER,
        JSON.stringify(recipe),
        existing,
        process.execPath,
      ]),
    ).rejects.toThrow("will not be overwritten");
    expect(await readFile(join(existing, "keep"), "utf8")).toBe("user data");
    expect((await readdir(root)).filter((name) => name.startsWith(".test-native-install"))).toEqual(
      [],
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});

it("explains missing Linux Hydra build tools before downloading upstream source", async () => {
  context.resolveCommand.mockImplementation(async (command) => {
    if (["make", "c++"].includes(command)) throw new Error("not installed");
    return command;
  });
  try {
    await expect(
      prepareIntegratedSetup(
        {
          ...options("hydra"),
          platform: "linux",
          arch: "x64",
          action: "install",
        },
        context,
      ),
    ).rejects.toThrow("requires make, c++");
    expect(await readdir(root)).toEqual([]);
  } finally {
    context.resolveCommand.mockImplementation(async (command) => command);
  }
});

it("prepares the verified Linux Orca slot with its isolated profile and original pinned Node", async () => {
  const recipe = integratedRecipe("orca", "linux", "x64")!;
  expect(recipe.format).toBe("deb");
  const directory = join(root, "tools/native", `orca-${recipe.version}`);
  for (const file of [...recipe.verify, "familiar-orcad/slot/.runtime-node"]) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(
      join(directory, file),
      file.endsWith(".runtime-node") ? "a".repeat(64) : "original",
    );
  }
  await writeFile(
    join(directory, ".familiar-install.json"),
    JSON.stringify({ id: "orca", version: recipe.version }),
  );
  const prepared = await prepareIntegratedSetup(
    { ...options("orca"), platform: "linux", arch: "x64", action: "start" },
    context,
  );
  expect(prepareToolSetup.output.parse(prepared).plan).toMatchObject({
    mode: "terminal",
    command: "/usr/bin/env",
  });
  expect(prepared!.plan!.args).toContain("127.0.0.1");
  expect(prepared!.plan!.args.join(" ")).toContain("node-" + "a".repeat(64));
  expect(prepared!.plan!.args).toContain(`ORCA_USER_DATA=${join(root, "familiar/native/orca")}`);
  expect(JSON.stringify(prepared)).not.toContain("no-sandbox");
  expect(await readFile(join(root, "familiar/native/orca/orca-cli"), "utf8")).toContain(
    "ORCA_USER_DATA_PATH=",
  );
});
