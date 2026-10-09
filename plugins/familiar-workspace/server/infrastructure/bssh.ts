import path from "node:path";
import { stat, writeFile } from "node:fs/promises";
import type { ToolActionAdapter, ToolActionContext } from "../tool-actions/contracts.js";
import { binaryParameter, cli, inputText, parameter } from "./common.js";
const common = [
  binaryParameter,
  {
    key: "hosts",
    label: "SSH hosts",
    required: true,
    description:
      "Comma-separated existing SSH aliases or user@host:port entries. Known host keys are required.",
  },
];

/** bssh rejects underscore aliases and misses some Include-based SSH profiles.
 * OpenSSH expands the user's existing profile; bssh still owns every connection. */
async function resolvedHosts(hosts: string[], context: ToolActionContext, binary: string) {
  const ssh = await context.resolveCommand("ssh");
  const algorithms = new Map<string, Set<string>>();
  for (const [key, query] of [
    ["hostkeyalgorithms", "key"],
    ["pubkeyacceptedalgorithms", "key-sig"],
    ["kexalgorithms", "kex"],
    ["ciphers", "cipher"],
    ["macs", "mac"],
  ]) {
    const supported = await context.exec({
      command: binary,
      args: ["-Q", query!],
      timeoutMs: 5_000,
      maxBytes: 16 * 1024,
    });
    if (supported.exitCode !== 0)
      throw new Error("bssh could not report its supported SSH algorithms");
    algorithms.set(key!, new Set(supported.stdout.trim().split(/\s+/u)));
  }
  const blocks: string[] = [];
  const aliases: string[] = [];
  for (const [index, host] of hosts.entries()) {
    const match = /^(.*?)(?::([0-9]+))?$/u.exec(host)!;
    const result = await context.exec({
      command: ssh,
      args: ["-G", ...(match[2] ? ["-p", match[2]] : []), "--", match[1]!],
      timeoutMs: 5_000,
      maxBytes: 128 * 1024,
    });
    if (result.exitCode !== 0) throw new Error(`OpenSSH could not resolve host profile ${host}`);
    const lines = result.stdout
      .split("\n")
      .filter((line) => line.trim() && !/^host\s/iu.test(line))
      .map((line) => {
        const [key, value] = line.split(/\s+/, 2);
        if (key === "connecttimeout") return "connecttimeout 10";
        const supported = algorithms.get(key!);
        if (!supported) return line.replace(/\sfalse$/u, " no").replace(/\strue$/u, " yes");
        const allowed = value!.split(",").filter((name) => supported.has(name));
        if (!allowed.length) throw new Error(`bssh has no ${key} allowed by this SSH profile`);
        return `${key} ${allowed.join(",")}`;
      });
    if (!lines.some((line) => /^hostname\s+\S+/iu.test(line)))
      throw new Error("OpenSSH did not resolve a hostname");
    const alias = `familiar-native-${index + 1}`;
    aliases.push(alias);
    blocks.push(`Host ${alias}\n${lines.map((line) => "  " + line).join("\n")}\n`);
  }
  const file = path.join(context.runDirectory, "bssh-resolved-config");
  await writeFile(file, blocks.join("\n"), { mode: 0o600 });
  return { file, aliases };
}
export const bsshAdapter: ToolActionAdapter = {
  id: "bssh",
  actions: [
    {
      id: "ping",
      mutates: false,
      label: "Check hosts",
      description: "Check every selected host through the original bssh SSH engine.",
      parameters: common,
    },
    {
      id: "exec",
      label: "Run on hosts",
      description:
        "Run the explicit command in parallel; fail if any host fails. Commands are not retried.",
      input: true,
      inputMode: "command",
      parameters: common,
    },
    {
      id: "upload",
      label: "Upload file",
      description: "Use native bssh SFTP to send a local file to each selected host.",
      parameters: [
        ...common,
        { key: "source", label: "Local file", required: true },
        { key: "destination", label: "Remote file or directory", required: true },
      ],
    },
    {
      id: "download",
      label: "Download file",
      description: "Use native bssh SFTP. Downloaded names are prefixed with the host.",
      parameters: [...common, { key: "source", label: "Remote file", required: true }],
    },
  ],
  async execute(request, context) {
    const hosts = parameter(request, "hosts")
      .split(",")
      .map((host) => host.trim());
    if (
      hosts.length > 32 ||
      hosts.some(
        (host) =>
          !/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+(?::[0-9]+)?$/u.test(host) || host.startsWith("-"),
      )
    )
      throw new Error("Choose at most 32 explicit SSH hosts");
    const binary = await context.resolveCommand(parameter(request, "binary", false) || "bssh");
    const resolved = await resolvedHosts(hosts, context, binary);
    const args = [
      "--batch",
      "-o",
      "UpdateHostKeys=no",
      "--strict-host-key-checking",
      "yes",
      "--connect-timeout",
      "10",
      "--timeout",
      "90",
      "--parallel",
      "4",
      "--require-all-success",
      "-F",
      resolved.file,
      "-H",
      resolved.aliases.join(","),
    ];
    if (request.action === "ping") args.push("ping");
    else if (request.action === "exec") args.push("--", inputText(request));
    else if (request.action === "upload") {
      const source = path.resolve(request.cwd, parameter(request, "source"));
      if (!(await stat(source)).isFile()) throw new Error("Upload source must be one regular file");
      args.push("upload", "--", source, parameter(request, "destination"));
    } else if (request.action === "download")
      args.push("download", "--", parameter(request, "source"), context.runDirectory + path.sep);
    else throw new Error("Unknown bssh action");
    const text = await cli(request, context, "bssh", args);
    return {
      state: "completed",
      text,
      ...(request.action === "download"
        ? { artifacts: [{ path: context.runDirectory, label: "Native SFTP downloads" }] }
        : {}),
    };
  },
};
