import { createHash } from "node:crypto";
import path from "node:path";
import { writeJson, writeText } from "./files.js";

interface ChildConfiguration {
  provider: "claude" | "codex" | "tmux";
  command: string;
  args: string[];
  environment: Record<string, string>;
}

/** This function is serialized into a private standalone CommonJS launcher.
 * Keep it self-contained: daemon bundle imports must not leak into child tools. */
function runContextChild() {
  const fs = process.getBuiltinModule("node:fs");
  const util = process.getBuiltinModule("node:util");
  const childProcess = process.getBuiltinModule("node:child_process");
  const config = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as ChildConfiguration;
  const original = process.argv.slice(3);
  const args = [...original];
  const divider = args.indexOf("--");
  const end = divider < 0 ? args.length : divider;
  const flags = args.slice(0, end);
  const utilities = new Set([
    "help",
    "login",
    "logout",
    "mcp",
    "completion",
    "completions",
    "update",
    "upgrade",
    "install",
    "doctor",
    "auth",
  ]);
  const utility =
    flags.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg)) ||
    utilities.has(args[0] ?? "");
  if (config.provider === "tmux") {
    if (args[0] === "new-session") {
      args.splice(
        1,
        0,
        ...Object.entries(config.environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      );
    }
  } else if (!utility && config.provider === "claude") injectClaude();
  else if (!utility && config.provider === "codex") injectCodex();
  function readMcp(value: string) {
    if (value.trimStart().startsWith("{")) return JSON.parse(value).mcpServers ?? {};
    if (fs.statSync(value).size > 2 * 1024 * 1024)
      throw new Error("MCP configuration exceeds 2 MiB");
    return JSON.parse(fs.readFileSync(value, "utf8")).mcpServers ?? {};
  }
  function checkMcp(values: string[], shared: Record<string, unknown>) {
    for (const value of values) {
      const configured = readMcp(value);
      for (const [id, definition] of Object.entries(shared)) {
        if (configured[id] && !util.isDeepStrictEqual(configured[id], definition))
          throw new Error(`MCP '${id}' conflicts with this FamiliarAgent session`);
      }
    }
  }
  function injectClaude() {
    const sharedFile = config.args[1]!;
    const shared = readMcp(sharedFile);
    let insertion = -1;
    for (let index = 0; index < end; index++) {
      const arg = args[index]!;
      if (arg !== "--mcp-config" && !arg.startsWith("--mcp-config=")) continue;
      const values: string[] = arg.startsWith("--mcp-config=") ? [arg.slice(13)] : [];
      let cursor = index + 1;
      while (cursor < end && !args[cursor]!.startsWith("-")) values.push(args[cursor++]!);
      if (!values.length) throw new Error("--mcp-config requires a configuration");
      checkMcp(values, shared);
      insertion = cursor;
      index = cursor - 1;
    }
    if (insertion >= 0) args.splice(insertion, 0, sharedFile);
    else args.splice(end, 0, ...config.args);
  }
  function injectCodex() {
    const reserved = new Set(
      config.args.flatMap((arg) => /^mcp_servers\.([a-z0-9_-]+)\./u.exec(arg)?.[1] ?? []),
    );
    for (let index = 0; index < end; index++) {
      const arg = args[index]!;
      let value: string | undefined;
      if (arg === "-c" || arg === "--config") value = args[++index];
      else if (arg.startsWith("--config=")) value = arg.slice(9);
      else if (arg.startsWith("-c")) value = arg.slice(2);
      const key = value?.split("=", 1)[0]?.replaceAll(/[\s"']/g, "");
      if (
        key === "mcp_servers" ||
        (key?.startsWith("mcp_servers.") && reserved.has(key.split(".")[1]!))
      )
        throw new Error("MCP configuration conflicts with this FamiliarAgent session");
    }
    args.splice(0, 0, ...config.args);
  }
  const env = { ...process.env, ...config.environment };
  if (typeof process.execve === "function")
    process.execve(config.command, [config.command, ...args], env as Record<string, string>);
  // Older host runtimes retain one small supervisor so terminal signals still reach the native child.
  const child = childProcess.spawn(config.command, args, { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("error", () => {
    process.stderr.write("The native tool could not be started.\n");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

export async function prepareContextShims(input: {
  root: string;
  sessionId: string;
  contextPath?: string;
  searchPath: string;
  executables: Partial<Record<ChildConfiguration["provider"], string>>;
  claudeArgs: string[];
  codexArgs: string[];
}): Promise<string> {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const folder = path.join(input.root, "familiar", "context-launchers", digest);
  const bin = path.join(folder, "bin");
  const driver = path.join(folder, "launch.cjs");
  const environment = {
    PATH: `${bin}${path.delimiter}${input.searchPath}`,
    FAMILIAR_SESSION_ID: input.sessionId,
    ...(input.contextPath ? { FAMILIAR_CONTEXT_FILE: input.contextPath } : {}),
  };
  await writeText(driver, `(${runContextChild.toString()})();\n`);
  for (const [provider, command] of Object.entries(input.executables)) {
    if (!command) continue;
    const file = path.join(folder, `${provider}.json`);
    await writeJson(file, {
      provider: provider as ChildConfiguration["provider"],
      command,
      args: { claude: input.claudeArgs, codex: input.codexArgs, tmux: [] }[
        provider as ChildConfiguration["provider"]
      ],
      environment,
    } satisfies ChildConfiguration);
    const shim = path.join(bin, provider);
    await writeText(
      shim,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(driver)} ${quote(file)} "$@"\n`,
      0o700,
    );
  }
  return bin;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
