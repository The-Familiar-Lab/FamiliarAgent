#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { finished } from "node:stream/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = new Set(process.argv.slice(2));
const scopes = ["desktop", "workspace", "server", "app", "discord", "cli"];
const selected = scopes.filter((scope) => options.has(`--${scope}`));
const active = new Set(selected.length ? selected : scopes);
const allowed = new Set([...scopes.map((scope) => `--${scope}`), "--integration", "--help"]);
for (const option of options)
  if (!allowed.has(option)) throw new Error(`Unknown option: ${option}`);
if (options.has("--help")) {
  console.log(
    "verify:familiar [--desktop --workspace --server --app --discord --cli] [--integration]\nDefault: bounded parallel lint, relevant typechecks and focused tests. No Electron, packaging, model calls or Discord login.\n--integration: also exercise real HTTP/WebSocket daemon file transfers using isolated temporary data.",
  );
  process.exit(0);
}
const logs = path.resolve(root, "../work/familiar-verification");
await mkdir(logs, { recursive: true });
const tasks = [];
function add(name, binary, args, cwd = root) {
  tasks.push({
    name,
    command: path.join(root, "node_modules/.bin", binary),
    args,
    cwd,
  });
}
add("lint", "oxlint", []);
const typecheckProjects = {
  desktop: "packages/desktop/tsconfig.json",
  workspace: "plugins/tsconfig.json",
  app: "packages/app/tsconfig.json",
  server: "packages/server/tsconfig.server.typecheck.json",
  cli: "packages/cli/tsconfig.json",
};
for (const [scope, project] of Object.entries(typecheckProjects)) {
  if (active.has(scope)) add(`${scope}-types`, "tsgo", ["--noEmit", "-p", project]);
}
const tests = [];
if (active.has("desktop"))
  tests.push(
    "packages/desktop/src/features/familiar",
    "packages/desktop/src/daemon/desktop-packaging.test.ts",
    "packages/desktop/src/daemon/quit-lifecycle.test.ts",
  );
// Directory discovery includes native/integrated/infrastructure adapters, tool-action
// transport/store/service/result graphs and Hub UI regressions. Do not duplicate
// individual suite paths here: new plugin tests must remain part of the fast run.
if (active.has("workspace")) tests.push("plugins/familiar-workspace");
if (active.has("server"))
  tests.push(
    "packages/server/src/server/file-download/token-store.test.ts",
    "packages/server/src/server/project-root-watch-worker.test.ts",
    "packages/server/src/utils/project-icon-discovery.test.ts",
    "packages/server/src/utils/project-custom-icon.test.ts",
    "packages/server/src/utils/project-icon.test.ts",
    "packages/server/src/server/workspace-reconciliation-service.test.ts",
    "packages/server/src/server/workspace-reconciliation-observation.test.ts",
    "packages/server/src/server/agent/providers/claude/agent.initialization.test.ts",
    "packages/server/src/server/agent/providers/codex-executable.test.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.test.ts",
    "packages/server/src/server/agent/agent-manager.test.ts",
    "packages/server/src/server/agent/provider-registry.test.ts",
    "packages/server/src/server/agent/chat-search/index.test.ts",
    "packages/server/src/server/agent/agent-prompt.test.ts",
    "packages/server/src/server/message-receipts/index.test.ts",
    "packages/server/src/server/plugins/lifecycle/handlers.test.ts",
    "packages/server/src/server/session/owned-subscriptions/replies.test.ts",
    "packages/server/src/server/session/owned-subscriptions/index.test.ts",
  );
if (active.has("app"))
  tests.push(
    "packages/app/src/screens/new-workspace-fork-context.test.ts",
    "packages/app/src/provider-selection",
    "packages/app/src/runtime/daemon-start-service.test.ts",
    "packages/app/src/file-pane/desktop-stream.test.ts",
    "packages/protocol/src/terminal-profiles.test.ts",
    "packages/protocol/src/messages.active-turn-behavior.test.ts",
    "packages/app/src/components/familiar-provider-setup-action.test.ts",
  );
if (active.has("app"))
  add(
    "app-plugin-tests",
    "vitest",
    [
      "run",
      "src/plugins/hosts/index.test.ts",
      "src/plugins/evaluate.test.ts",
      "src/plugins/host-navigation.test.ts",
      "src/plugins/host-navigation.test.tsx",
      "src/navigation/host-runtime-bootstrap.test.ts",
      "src/components/directory-browser.test.tsx",
      "src/add-project-flow/model.test.ts",
      "src/screens/workspace/project-views.test.ts",
      "src/screens/workspace/project-views-bar.test.tsx",
      "src/screens/workspace/project-view-drag.test.tsx",
      "src/screens/workspace/project-view-drop-target.test.tsx",
      "src/screens/workspace/project-view-layout.test.ts",
      "src/stores/project-view-store.test.ts",
      "src/components/resize-handle.test.tsx",
      "src/screens/workspace/workspace-deck.test.tsx",
      "src/screens/workspace/workspace-deck-retention.test.ts",
      "src/screens/new-workspace-terminal.test.ts",
      "src/panels/shared-session-banner.test.tsx",
      "src/panels/use-agent-detail-lookup.test.tsx",
      "src/workspace-tabs/launcher/launcher.test.tsx",
      "src/workspace-tabs/launcher/internal/familiar-context.test.ts",
      "src/workspace-tabs/launcher/internal/familiar-tools.test.ts",
      "src/workspace-tabs/launcher/internal/familiar-profile.test.ts",
      "src/components/familiar-tool-help.test.tsx",
      "src/terminal/runtime/terminal-stream-controller.test.ts",
      "src/agent-stream/result-selection.test.ts",
      "src/components/connected-result-message.test.tsx",
      "src/composer/actions.test.ts",
      "src/composer/input/state.test.ts",
      "src/hooks/use-settings/storage.test.ts",
      "src/utils/markdown-parser.test.ts",
      "src/utils/assistant-markdown-parser.test.ts",
      "src/utils/__tests__/split-markdown-blocks.test.ts",
      "--maxWorkers=2",
    ],
    path.join(root, "packages/app"),
  );
if (active.has("cli"))
  tests.push(
    "packages/cli/src/commands/agent/fork.test.ts",
    "packages/cli/src/commands/context/mcp.test.ts",
    "packages/client/src/connection/owned.test.ts",
    "packages/client/src/index.test.ts",
  );
if (active.has("server"))
  tests.push(
    "packages/server/src/terminal/terminal-exit-diagnostics.test.ts",
    "packages/server/src/terminal/terminal-session-controller.test.ts",
  );
if (tests.length) add("focused-tests", "vitest", ["run", "--maxWorkers=2", ...tests]);
if (active.has("discord")) {
  const cwd = path.join(root, "integrations/discord-connector");
  add("discord-types", "tsc", ["--noEmit", "-p", path.join(cwd, "tsconfig.json")], cwd);
  tasks.push({
    name: "discord-tests",
    command: path.join(cwd, "node_modules/.bin/vitest"),
    args: [
      "run",
      "apps/discord-bot/src/familiarBridge.test.ts",
      "apps/discord-bot/src/familiarSource.test.ts",
      "apps/discord-bot/src/familiarRelay.test.ts",
      "--maxWorkers=2",
    ],
    cwd,
  });
}
if (options.has("--integration"))
  add("daemon-transfer-tests", "vitest", [
    "run",
    "--config",
    "packages/server/vitest.config.ts",
    "packages/server/src/server/daemon-e2e/file-download.e2e.test.ts",
    "packages/server/src/server/daemon-e2e/terminal-launch.e2e.test.ts",
    "packages/server/src/server/daemon-e2e/familiar-workspace.e2e.test.ts",
    "packages/server/src/server/daemon-e2e/project-icon-isolation.e2e.test.ts",
    "packages/server/src/server/daemon-e2e/familiar-advisor.e2e.test.ts",
    "packages/server/src/server/daemon-e2e/familiar-fork.e2e.test.ts",
    "packages/server/src/server/daemon-e2e/familiar-composition.e2e.test.ts",
    "packages/server/src/server/daemon-e2e/familiar-result-input.e2e.test.ts",
    "packages/server/src/server/daemon-e2e/familiar-tool-result-bridge.e2e.test.ts",
    "--maxWorkers=1",
  ]);
const running = new Set();
function stop(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
process.once("SIGINT", () => {
  for (const child of running) stop(child, "SIGTERM");
  process.exitCode = 130;
});
const started = performance.now();
const results = [];
async function run(task) {
  const taskStarted = performance.now();
  const log = path.join(logs, `${task.name}.log`);
  const stream = createWriteStream(log);
  console.log(`START ${task.name}`);
  const child = spawn(task.command, task.args, {
    cwd: task.cwd,
    env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: undefined },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  running.add(child);
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  let error;
  let code = 1;
  let killTimer;
  const timer = setTimeout(() => {
    error = "Timed out after 4 minutes";
    stop(child, "SIGTERM");
    killTimer = setTimeout(() => stop(child, "SIGKILL"), 2000);
  }, 240_000);
  try {
    [code] = await once(child, "close");
  } catch (failure) {
    error = failure.message;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    running.delete(child);
  }
  const result = {
    name: task.name,
    code: code ?? 1,
    error,
    seconds: Number(((performance.now() - taskStarted) / 1000).toFixed(2)),
    log,
  };
  stream.end();
  await finished(stream);
  results.push(result);
  console.log(`${result.code === 0 ? "PASS" : "FAIL"} ${task.name} (${result.seconds}s)`);
  if (result.code !== 0) console.log((await readFile(log, "utf8")).slice(-5000));
}
// Two jobs cap compiler memory and leave the machine responsive during editing.
await Promise.all(
  Array.from({ length: Math.min(2, tasks.length) }, async () => {
    while (tasks.length && process.exitCode !== 130) await run(tasks.shift());
  }),
);
const report = {
  date: new Date().toISOString(),
  scopes: [...active],
  integration: options.has("--integration"),
  seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
  results,
};
await writeFile(path.join(logs, "latest.json"), JSON.stringify(report, null, 2));
console.log(`Finished in ${report.seconds}s. Report: ${path.join(logs, "latest.json")}`);
if (results.some((result) => result.code !== 0)) process.exitCode = 1;
