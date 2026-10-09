import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";

export const discordSourceSchema = z
  .object({
    sshEndpoint: z
      .string()
      .max(4096)
      .refine((value) => {
        try {
          parseSshTransportUri(value);
          return true;
        } catch {
          return false;
        }
      }, "Choose an SSH server."),
    configPath: z
      .string()
      .max(4096)
      .refine(path.posix.isAbsolute, "Choose an absolute original configuration path."),
  })
  .strict();
export type DiscordSource = z.infer<typeof discordSourceSchema>;
export const discordSourceInventorySchema = z.object({
  guild: z.object({ id: z.string(), name: z.string() }),
  allowedRoleIds: z.array(z.string()),
  channels: z.array(z.object({ id: z.string(), name: z.string(), type: z.number() })),
  createdChannelId: z.string().optional(),
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function discordSourceSshArgs(source: DiscordSource): string[] {
  const target = parseSshTransportUri(source.sshEndpoint);
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
    ...(target.sshPort ? ["-p", String(target.sshPort)] : []),
    target.host,
  ];
}
const ROOT = '"$HOME/.local/share/familiaragent/discord/source-runtime"';
const NODE =
  'node_command=""; for candidate in "$HOME"/.local/share/familiaragent/runtime/node-*/bin/node; do if [ -x "$candidate" ]; then node_command="$candidate"; break; fi; done; if [ -z "$node_command" ]; then node_command=$(command -v node) || exit 1; fi;';
async function shortRequest(
  source: DiscordSource,
  command: string,
  input?: Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...discordSourceSshArgs(source), command], {
      stdio: "pipe",
      windowsHide: true,
    });
    let output = "",
      bytes = 0,
      failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("Discord server setup timed out. Check the SSH connection.");
      child.kill("SIGKILL");
    }, 30000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        failure = new Error("Discord setup response is too large.");
        child.kill("SIGKILL");
      } else output += chunk.toString();
    });
    child.stderr.resume();
    child.stdin.on("error", () => {
      /* The close event reports a bounded setup failure. */
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("SSH could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code)
        reject(
          new Error(
            "Discord server setup failed. Check the original private configuration, SSH access and bot permissions.",
          ),
        );
      else resolve(output);
    });
    child.stdin.end(input);
  });
}
export async function deployDiscordSource(
  source: DiscordSource,
  entryPath: string,
): Promise<string> {
  const bytes = await readFile(entryPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const command = `set -eu; umask 077; root=${ROOT}; mkdir -p "$root"; chmod 700 "$root"; temporary=$(mktemp "$root/.upload.XXXXXX"); trap 'rm -f "$temporary"' EXIT HUP INT TERM; cat > "$temporary"; ${NODE} "$node_command" -e 'const f=require("node:fs"),c=require("node:crypto"); if(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex")!==process.argv[2])process.exit(1)' "$temporary" ${digest}; mv "$temporary" "$root/${digest}.cjs"`;
  await shortRequest(source, command, bytes);
  return digest;
}
export function discordSourceCommand(
  source: DiscordSource,
  digest: string,
  mode: "inspect" | "create" | "connect",
  config?: unknown,
): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid connector bundle digest.");
  const encoded =
    config === undefined ? [] : [Buffer.from(JSON.stringify(config)).toString("base64")];
  return `set -eu; ${NODE} exec "$node_command" ${ROOT}/${digest}.cjs ${quote(`--source-${mode}`)} ${quote(source.configPath)} ${encoded.map(quote).join(" ")}`;
}
export async function inspectDiscordSource(
  source: DiscordSource,
  entryPath: string,
  createChannel: boolean,
) {
  const digest = await deployDiscordSource(source, entryPath);
  return discordSourceInventorySchema.parse(
    JSON.parse(
      await shortRequest(
        source,
        discordSourceCommand(source, digest, createChannel ? "create" : "inspect"),
      ),
    ),
  );
}
export async function spawnDiscordSource(
  source: DiscordSource,
  entryPath: string,
  config: unknown,
): Promise<ChildProcessWithoutNullStreams> {
  const digest = await deployDiscordSource(source, entryPath);
  return spawn(
    "ssh",
    [...discordSourceSshArgs(source), discordSourceCommand(source, digest, "connect", config)],
    { stdio: "pipe", windowsHide: true },
  );
}
