import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
let context: DaemonTestContext | undefined;
let other: DaemonClient | undefined;
let root: string | undefined;
afterEach(async () => {
  await other?.close();
  await context?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
test("two real clients share plugin state, reject stale writes and transfer verified bytes", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "familiar-rpc-"));
  vi.stubEnv("PASEO_HOME", path.join(root, ".paseo"));
  context = await createDaemonTestContext({
    paseoHomeRoot: root,
    daemonVersion: "0.11.1",
    pluginsEnabled: true,
    builtinPlugins: new BuiltinPluginLoader(
      path.resolve(import.meta.dirname, "../../../../../plugins"),
      ["familiar-workspace"],
    ),
  });
  other = new DaemonClient({ url: `ws://127.0.0.1:${context.daemon.port}/ws` });
  await other.connect();
  const first = await context.client.invokePluginRpc("familiar-workspace", "space.read", {
    id: "rpc-test",
  });
  expect(first).toMatchObject({ revision: 0, notes: "" });
  const saved = await context.client.invokePluginRpc("familiar-workspace", "space.save", {
    ...(first as object),
    notes: "Shared between two native clients",
  });
  expect(saved).toMatchObject({ revision: 1 });
  expect(
    await other.invokePluginRpc("familiar-workspace", "space.read", { id: "rpc-test" }),
  ).toEqual(saved);
  await expect(other.invokePluginRpc("familiar-workspace", "space.save", first)).rejects.toThrow(
    "Revision conflict",
  );
  const bytes = Buffer.from("artifact 한글\n");
  const input = {
    name: "test.txt",
    base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  expect(await other.invokePluginRpc("familiar-workspace", "artifact.put", input)).toMatchObject({
    size: bytes.length,
    sha256: input.sha256,
  });
  await expect(
    other.invokePluginRpc("familiar-workspace", "artifact.put", {
      ...input,
      sha256: "0".repeat(64),
    }),
  ).rejects.toThrow("checksum");
  const recipe = await other.invokePluginRpc("familiar-workspace", "provider.setup", {
    provider: "codex",
  });
  expect(recipe).toMatchObject({
    command: "/bin/sh",
    cwd: path.join(root, ".paseo/familiar/provider-setup"),
  });
  await expect(
    other.invokePluginRpc("familiar-workspace", "provider.setup", { provider: "codex; evil" }),
  ).rejects.toThrow();
}, 30000);
