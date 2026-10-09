import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const script = fileURLToPath(new URL("../../../assets/familiar/apply-runtime.sh", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function executable(file: string, body: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
}
function fixture(firstInstall = false) {
  const root = mkdtempSync(path.join(tmpdir(), "familiar-runtime-transaction-"));
  temporary.push(root);
  const nodeDirectory = path.join(
    root,
    `runtime/node-v22.20.0-${process.platform}-${process.arch}`,
  );
  executable(path.join(nodeDirectory, "bin/node"), `exec ${quote(process.execPath)} "$@"`);
  mkdirSync(path.join(root, "state"));
  writeFileSync(path.join(root, "state/config.json"), '{"ownedUserState":true}');
  writeFileSync(path.join(root, "agents.json"), '[{"status":"idle"}]');
  const tools = path.join(root, "runtime/tools");
  if (!firstInstall) {
    mkdirSync(tools);
    writeFileSync(path.join(tools, "marker"), "old");
    writeFileSync(path.join(root, "runtime/build.sha256"), "old-digest\n");
  }
  executable(
    path.join(root, "bin/familiar"),
    `
root="$FAMILIAR_INSTALL_ROOT"
marker=none
[ ! -f "$root/runtime/tools/marker" ] || marker="$(cat "$root/runtime/tools/marker")"
printf '%s:%s:%s\\n' "$1" "\${2:-}" "$marker" >> "$root/events"
case "$1 \${2:-}" in
  'ls --json') cat "$root/agents.json";;
  'daemon start') [ "\${FAMILIAR_TEST_FAIL_START:-}" != "$marker" ];;
  'daemon stop') if [ "\${FAMILIAR_TEST_STOP_SIGNAL:-}" = 1 ]; then kill -TERM "$PPID"; fi; exit 0;;
  'plugin call') [ "\${FAMILIAR_TEST_FAIL_RPC:-}" != 1 ]; echo '{}';;
  *) exit 9;;
esac`,
  );
  executable(
    path.join(nodeDirectory, "bin/npm"),
    `
root="$FAMILIAR_INSTALL_ROOT"
marker=none
[ ! -f "$root/runtime/tools/marker" ] || marker="$(cat "$root/runtime/tools/marker")"
printf 'npm:%s\\n' "$marker" >> "$root/events"
[ "\${FAMILIAR_TEST_FAIL_INSTALL:-}" != 1 ] || exit 8
while [ "$1" != '--prefix' ]; do shift; done
shift
candidate="$1"
mkdir -p "$candidate/node_modules/@getpaseo/server/dist" "$candidate/node_modules/@getpaseo/cli/dist" "$candidate/node_modules/.bin"
printf new > "$candidate/marker"
printf '{"ws":"8.22.0"}' > "$candidate/dependencies.json"
printf '#!/bin/sh\\n[ "\${FAMILIAR_TEST_FAIL_SMOKE:-}" != 1 ]\\n' > "$candidate/node_modules/.bin/paseo"
chmod 700 "$candidate/node_modules/.bin/paseo"
if [ "\${FAMILIAR_TEST_START_WORK:-}" = 1 ]; then printf '[{"status":"running"}]' > "$root/agents.json"; fi`,
  );
  const payload = path.join(root, "payload");
  mkdirSync(path.join(payload, "workspace-packages"), { recursive: true });
  const dependencies = {
    "@getpaseo/cli": "file:workspace-packages/cli.tgz",
    "@getpaseo/server": "file:workspace-packages/server.tgz",
  };
  writeFileSync(
    path.join(payload, "package.json"),
    JSON.stringify({ familiarRuntime: { schemaVersion: 1 }, dependencies }),
  );
  writeFileSync(
    path.join(payload, "package-lock.json"),
    JSON.stringify({
      packages: Object.fromEntries(
        Object.entries(dependencies).map(([name, resolved]) => [
          `node_modules/${name}`,
          { resolved, integrity: "sha512-fixture" },
        ]),
      ),
    }),
  );
  for (const name of ["cli", "server"])
    writeFileSync(path.join(payload, `workspace-packages/${name}.tgz`), "owned fixture");
  const archivePath = path.join(root, "runtime.tgz");
  const archive = () => {
    execFileSync("tar", [
      "-czf",
      archivePath,
      "-C",
      payload,
      "package.json",
      "package-lock.json",
      "workspace-packages",
    ]);
    return readFileSync(archivePath);
  };
  const run = (env: Record<string, string> = {}, digest?: string) => {
    const input = archive();
    const hash = digest ?? createHash("sha256").update(input).digest("hex");
    const result = spawnSync("sh", [script, hash], {
      input,
      env: { ...process.env, ...env, FAMILIAR_INSTALL_ROOT: root },
      timeout: 10_000,
    });
    return {
      status: result.status,
      output: result.stdout.toString() + result.stderr.toString(),
      hash,
    };
  };
  return { root, tools, payload, nodeDirectory, archive, run };
}
function unchanged(root: string) {
  expect(readFileSync(path.join(root, "runtime/tools/marker"), "utf8")).toBe("old");
  expect(readFileSync(path.join(root, "runtime/build.sha256"), "utf8")).toBe("old-digest\n");
  expect(readFileSync(path.join(root, "state/config.json"), "utf8")).toBe(
    '{"ownedUserState":true}',
  );
  expect(existsSync(path.join(root, "setup.lock"))).toBe(false);
  expect(existsSync(path.join(root, "runtime/tools.rollback"))).toBe(false);
  expect(readdirSync(path.join(root, "runtime")).some((name) => name.startsWith(".install."))).toBe(
    false,
  );
}

it("stages locked dependencies before stopping and replaces the complete tools tree", () => {
  const { root, tools, run } = fixture();
  const result = run();
  expect(result.status, result.output).toBe(0);
  expect(readFileSync(path.join(tools, "dependencies.json"), "utf8")).toBe('{"ws":"8.22.0"}');
  expect(readFileSync(path.join(root, "events"), "utf8").trim().split("\n")).toEqual([
    "ls:--json:old",
    "npm:old",
    "ls:--json:old",
    "daemon:stop:old",
    "daemon:start:new",
    "plugin:call:new",
  ]);
  expect(readFileSync(path.join(root, "runtime/build.sha256"), "utf8").trim()).toBe(result.hash);
  expect(existsSync(path.join(root, "runtime/tools.rollback"))).toBe(false);
});
it.each(["INSTALL", "SMOKE", "START", "RPC"])(
  "restores code, dependencies and digest after %s failure",
  (failure) => {
    const { root, run } = fixture();
    const result = run({ [`FAMILIAR_TEST_FAIL_${failure}`]: failure === "START" ? "new" : "1" });
    expect(result.status, result.output).not.toBe(0);
    unchanged(root);
    if (["START", "RPC"].includes(failure))
      expect(readFileSync(path.join(root, "events"), "utf8")).toContain("daemon:start:old");
  },
);
it.each([false, true])(
  "defers work that is active before or during dependency installation: %s",
  (during) => {
    const { root, run } = fixture();
    if (!during) writeFileSync(path.join(root, "agents.json"), '[{"status":"running"}]');
    const result = run(during ? { FAMILIAR_TEST_START_WORK: "1" } : {});
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("FAMILIAR_UPDATE_DEFERRED:");
    expect(readFileSync(path.join(root, "events"), "utf8")).not.toContain("daemon:stop");
    unchanged(root);
  },
);
it("installs a fresh server and removes a failed first runtime without touching user state", () => {
  const success = fixture(true);
  expect(success.run().status).toBe(0);
  expect(readFileSync(path.join(success.tools, "marker"), "utf8")).toBe("new");
  const failure = fixture(true);
  expect(failure.run({ FAMILIAR_TEST_FAIL_RPC: "1" }).status).not.toBe(0);
  expect(existsSync(failure.tools)).toBe(false);
  expect(existsSync(path.join(failure.root, "runtime/build.sha256"))).toBe(false);
  expect(readFileSync(path.join(failure.root, "state/config.json"), "utf8")).toBe(
    '{"ownedUserState":true}',
  );
});
it("rejects corrupted bundles and nonlocal internal dependencies before npm or daemon changes", () => {
  const badHash = fixture();
  expect(badHash.run({}, "0".repeat(64)).status).toBe(4);
  unchanged(badHash.root);
  const badLock = fixture();
  writeFileSync(path.join(badLock.payload, "package-lock.json"), JSON.stringify({ packages: {} }));
  expect(badLock.run().status).not.toBe(0);
  expect(readFileSync(path.join(badLock.root, "events"), "utf8")).not.toContain("npm:");
  unchanged(badLock.root);
});
it("accepts the same verified hash offline without npm or daemon calls", () => {
  const { root, nodeDirectory, archive, run } = fixture();
  const hash = createHash("sha256").update(archive()).digest("hex");
  writeFileSync(path.join(root, "runtime/build.sha256"), hash);
  rmSync(nodeDirectory, { recursive: true });
  const result = run({}, hash);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("already current");
  expect(existsSync(path.join(root, "events"))).toBe(false);
});
it("bootstrap preserves an existing launcher and daemon configuration without stopping work", () => {
  const { root } = fixture();
  const launcher = readFileSync(path.join(root, "bin/familiar"), "utf8");
  const bootstrap = fileURLToPath(
    new URL("../../../assets/familiar/remote-bootstrap.sh", import.meta.url),
  );
  const result = spawnSync("sh", [bootstrap, "6787", "22.20.0", "0.11.1"], {
    env: { ...process.env, FAMILIAR_INSTALL_ROOT: root },
    timeout: 10_000,
  });
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(readFileSync(path.join(root, "bin/familiar"), "utf8")).toBe(launcher);
  expect(existsSync(path.join(root, "events"))).toBe(false);
  unchanged(root);
});

it.each(["failure", "signal"])(
  "restores the original tree across the backup rename %s boundary",
  (mode) => {
    const { root, nodeDirectory, run } = fixture();
    executable(
      path.join(nodeDirectory, "bin/mv"),
      `
if [ "$1" = "$FAMILIAR_INSTALL_ROOT/runtime/tools" ]; then
  if [ "$FAMILIAR_TEST_RENAME_MODE" = failure ]; then exit 7; fi
  /bin/mv "$@"
  kill -TERM "$PPID"
  exit 0
fi
exec /bin/mv "$@"`,
    );
    const result = run({ FAMILIAR_TEST_RENAME_MODE: mode });
    expect(result.status, result.output).not.toBe(0);
    unchanged(root);
    expect(readFileSync(path.join(root, "events"), "utf8")).toContain("daemon:start:old");
  },
);

it("releases its setup lock if allocating a staging directory fails", () => {
  const { root, run } = fixture();
  const faultBin = path.join(root, "faults");
  executable(path.join(faultBin, "mktemp"), "exit 7");
  const result = run({ PATH: `${faultBin}:${process.env.PATH}` });
  expect(result.status).toBe(7);
  unchanged(root);
});

it("restarts the original daemon if interrupted immediately after stopping it", () => {
  const { root, run } = fixture();
  const result = run({ FAMILIAR_TEST_STOP_SIGNAL: "1" });
  expect(result.status, result.output).not.toBe(0);
  unchanged(root);
  expect(readFileSync(path.join(root, "events"), "utf8")).toContain("daemon:start:old");
});

it("bootstrap releases its setup lock when staging allocation fails", () => {
  const { root } = fixture();
  const faultBin = path.join(root, "faults");
  executable(path.join(faultBin, "mktemp"), "exit 7");
  const bootstrap = fileURLToPath(
    new URL("../../../assets/familiar/remote-bootstrap.sh", import.meta.url),
  );
  const result = spawnSync("sh", [bootstrap, "6787", "22.20.0", "0.11.1"], {
    env: { ...process.env, PATH: `${faultBin}:${process.env.PATH}`, FAMILIAR_INSTALL_ROOT: root },
    timeout: 10_000,
  });
  expect(result.status).toBe(7);
  unchanged(root);
});

it("rejects a different configured port before changing an existing installation", () => {
  const { root } = fixture();
  const configPath = path.join(root, "state/config.json");
  const config = '{"daemon":{"listen":"127.0.0.1:6787"}}';
  writeFileSync(configPath, config);
  const bootstrap = fileURLToPath(
    new URL("../../../assets/familiar/remote-bootstrap.sh", import.meta.url),
  );
  const result = spawnSync("sh", [bootstrap, "6788", "22.20.0", "0.11.1"], {
    env: { ...process.env, FAMILIAR_INSTALL_ROOT: root },
    timeout: 10_000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr.toString()).toContain("Connect using its existing port");
  expect(readFileSync(configPath, "utf8")).toBe(config);
  expect(existsSync(path.join(root, "events"))).toBe(false);
  expect(existsSync(path.join(root, "setup.lock"))).toBe(false);
});
