import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { ORCA_SLOT_INSTALL } from "./orca-runtime.js";

it("assembles only upstream-verified artifacts in upstream order and rejects mutation or traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "familiar-orca-slot-"));
  const resources = join(root, "resources"),
    template = join(resources, "orcad-template");
  const module = join(resources, "app.asar.unpacked/out/shared/orcad-artifacts.js");
  const runtimeHash = createHash("sha256");
  for await (const bytes of createReadStream(process.execPath)) runtimeHash.update(bytes);
  const sha = runtimeHash.digest("hex");
  const originalMode = (await stat(process.execPath)).mode;
  const files = { "orcad.js": "original runtime", ".runtime-node": sha + "\n" };
  const manifest = {
    schemaVersion: 3,
    commonSha256: {
      "orcad.js": createHash("sha256").update(files["orcad.js"]).digest("hex"),
    },
    targets: {
      "linux-x64-glibc": {
        files: {
          ".runtime-node": createHash("sha256").update(files[".runtime-node"]).digest("hex"),
        },
      },
    },
  };
  await mkdir(join(module, ".."), { recursive: true });
  await mkdir(join(template, "targets/linux-x64-glibc"), { recursive: true });
  await writeFile(
    module,
    "module.exports={ORCAD_VERSION:'0.1.0',orcadArtifactFilenames:()=>['orcad.js','.runtime-node'],orcadTemplateTargetFilenames:()=>['.runtime-node']}",
  );
  await writeFile(join(template, "orcad-template.json"), JSON.stringify(manifest));
  await writeFile(join(template, "orcad.js"), files["orcad.js"]);
  await writeFile(join(template, "targets/linux-x64-glibc/.runtime-node"), files[".runtime-node"]);
  const run = () =>
    promisify(execFile)(process.execPath, ["-e", ORCA_SLOT_INSTALL, resources, "linux-x64-glibc"], {
      cwd: root,
      timeout: 10_000,
    });
  try {
    await run();
    expect(await readFile(join(root, "familiar-orcad/slot/.version"), "utf8")).toBe(
      "0.1.0+" +
        createHash("sha256")
          .update(files["orcad.js"])
          .update(files[".runtime-node"])
          .digest("hex")
          .slice(0, 12) +
        "\n",
    );
    expect((await stat(process.execPath)).mode).toBe(originalMode);
    await rm(join(root, "familiar-orcad"), { recursive: true });
    await writeFile(join(template, "orcad.js"), "changed upstream artifact");
    await expect(run()).rejects.toThrow("SHA-256");
    await writeFile(
      module,
      "module.exports={orcadArtifactFilenames:()=>['../outside'],orcadTemplateTargetFilenames:()=>[]}",
    );
    await expect(run()).rejects.toThrow("Invalid Orca artifact path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
