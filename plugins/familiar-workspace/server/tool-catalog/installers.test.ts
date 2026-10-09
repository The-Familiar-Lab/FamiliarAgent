import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { prepareNativeInstaller } from "./installers.js";
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function install(script: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-installer-proof-"));
  directories.push(root);
  const plan = await prepareNativeInstaller({
    id: "claude-squad",
    root,
    cwd: root,
    searchPath: process.env.PATH!,
    executable: async (name) => (name === "bash" ? "/bin/bash" : "/bin/true"),
  });
  const server = createServer((_request, response) => response.end(script));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const args = [...plan.args];
  const driver = args.indexOf("-e");
  args[driver + 2] = `http://127.0.0.1:${address.port}/install.sh`;
  args[driver + 3] = createHash("sha256").update(script).digest("hex");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    await execute(plan.command!, args, { env: environment, timeout: 15000 });
    return { root, plan };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
it("runs the literal installer plan with Node mode carried in argv and verifies its executable", async () => {
  const { root, plan } = await install(
    '#!/bin/bash\nset -eu\nmkdir -p "$BIN_DIR"\nprintf "#!/bin/sh\\nprintf ORIGINAL_NATIVE_OK" > "$BIN_DIR/cs"\nchmod +x "$BIN_DIR/cs"\n',
  );
  expect(plan.command).toBe("/usr/bin/env");
  expect(plan.args.slice(0, 2)).toEqual(["ELECTRON_RUN_AS_NODE=1", process.execPath]);
  expect(await readFile(path.join(root, "tools/bin/cs"), "utf8")).toContain("ORIGINAL_NATIVE_OK");
});
it("does not report successful installation when the original script exits zero without an executable", async () => {
  await expect(install("#!/bin/bash\nexit 0\n")).rejects.toThrow("without creating its executable");
});
