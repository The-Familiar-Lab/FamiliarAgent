#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    host: { type: "string" },
    workspace: { type: "string", default: "familiar-validation" },
  },
});
if (!values.cli || !path.isAbsolute(values.cli) || !values.host)
  throw new Error(
    "Use --cli <absolute FamiliarAgent CLI path> --host <SSH URI or local endpoint> [--workspace <dedicated test workspace>]",
  );
const execute = promisify(execFile);
const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-smoke-"));
let sequence = 0;
async function rpc(method, input) {
  const file = path.join(directory, `${sequence++}.json`);
  await writeFile(file, JSON.stringify(input), { mode: 0o600 });
  const { stdout } = await execute(
    values.cli,
    [
      "plugin",
      "call",
      "familiar-workspace",
      method,
      "--input-file",
      file,
      "--host",
      values.host,
      "--json",
    ],
    { timeout: 45000, maxBuffer: 1024 * 1024 },
  );
  const response = JSON.parse(stdout);
  assert.ok(Object.hasOwn(response, "result"));
  return response.result;
}
const started = performance.now();
try {
  const original = await rpc("space.read", { id: values.workspace });
  const saved = await rpc("space.save", {
    ...original,
    notes: "FamiliarAgent transport validation: 한글 ✓",
  });
  assert.equal(saved.revision, original.revision + 1);
  assert.deepEqual(await rpc("space.read", { id: values.workspace }), saved);
  await assert.rejects(rpc("space.save", original), /Revision conflict/);
  // Restore contents using the latest revision. This dedicated validation record remains visible.
  await rpc("space.save", { ...saved, notes: original.notes });
  const bytes = Buffer.from("FamiliarAgent transport fixture\n");
  const input = {
    name: "familiar-validation.txt",
    base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const artifact = await rpc("artifact.put", input);
  assert.equal(artifact.sha256, input.sha256);
  assert.equal(artifact.size, bytes.length);
  assert.deepEqual(await rpc("artifact.put", input), artifact);
  console.log(
    JSON.stringify(
      {
        passed: true,
        host: values.host,
        workspace: values.workspace,
        checks: [
          "native CLI / SSH RPC",
          "shared state round trip",
          "stale write rejection",
          "SHA-256 file transfer",
          "idempotent artifact upload",
        ],
        seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
