import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, readlink, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { prepareInfrastructureInstaller } from "./installers.js";
import { INFRASTRUCTURE_INSTALLER } from "./installer-program.js";
const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "infra-install-"));
  directories.push(root);
  const archive = path.join(root, "native.zip");
  await exec("python3", [
    "-c",
    "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('pkg/native','#!/bin/sh\\nprintf NATIVE_EXEC_OK'); z.close()",
    archive,
  ]);
  const bytes = await readFile(archive);
  const spec = {
    root,
    id: "native",
    version: "1.0",
    assets: [
      {
        binary: "native",
        url: pathToFileURL(archive).href,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  return {
    root,
    spec,
    run: () =>
      exec("python3", ["-c", INFRASTRUCTURE_INSTALLER, JSON.stringify(spec)], { timeout: 10000 }),
  };
}
it("installs verified regular members and preserves idempotent canonical executable paths", async () => {
  const f = await fixture();
  await f.run();
  const binary = path.join(f.root, "tools/bin/native");
  expect((await exec(binary)).stdout).toBe("NATIVE_EXEC_OK");
  const target = await readlink(binary);
  await f.run();
  expect(await readlink(binary)).toBe(target);
});
it("uses Python 3.8-compatible path checks and preserves links outside its owned directory", async () => {
  // Check our API usage without removing methods used internally by newer pathlib versions.
  await exec("python3", [
    "-c",
    "import ast,sys; tree=ast.parse(sys.argv[1]); assert not any(isinstance(node,ast.Attribute) and node.attr == 'is_relative_to' for node in ast.walk(tree)), 'is_relative_to requires Python 3.9'",
    INFRASTRUCTURE_INSTALLER,
  ]);
  const f = await fixture();
  await f.run();
  await f.run();
  const entry = path.join(f.root, "tools/bin/native");
  expect((await exec(entry)).stdout).toBe("NATIVE_EXEC_OK");
  const external = path.join(f.root, "tools/native/native-other/original");
  await mkdir(path.dirname(external), { recursive: true });
  await writeFile(external, "original");
  await rm(entry);
  await symlink(external, entry);
  await expect(f.run()).rejects.toThrow("not owned");
  expect(await readlink(entry)).toBe(external);
  expect(await readFile(external, "utf8")).toBe("original");
});
it("rejects checksum mismatch and preserves executables outside its native version directory", async () => {
  const f = await fixture();
  const correct = f.spec.assets[0]!.sha256;
  f.spec.assets[0]!.sha256 = "0".repeat(64);
  await expect(f.run()).rejects.toThrow("integrity check");
  f.spec.assets[0]!.sha256 = correct;
  await mkdir(path.join(f.root, "tools/bin"), { recursive: true });
  await writeFile(path.join(f.root, "tools/bin/native"), "original");
  await expect(f.run()).rejects.toThrow("not owned");
  expect(await readFile(path.join(f.root, "tools/bin/native"), "utf8")).toBe("original");
});
it("does not present an unsupported Mac control plane as an installed local Firetower server", async () => {
  const base = {
    root: "/private/state",
    cwd: "/private/project",
    executable: async () => "/usr/bin/python3",
  };
  await expect(
    prepareInfrastructureInstaller({ ...base, id: "firetower", platform: "darwin", arch: "arm64" }),
  ).rejects.toThrow("connected Linux server");
  expect(
    await prepareInfrastructureInstaller({ ...base, id: "__proto__", platform: "darwin" }),
  ).toBeNull();
  const plan = await prepareInfrastructureInstaller({
    ...base,
    id: "coder",
    platform: "darwin",
    arch: "arm64",
  });
  expect(plan?.command).toBe("/usr/bin/python3");
  expect(plan?.args.join(" ")).toContain("coder_2.36.7_darwin_arm64.zip");
});
