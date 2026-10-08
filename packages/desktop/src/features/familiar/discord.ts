import { once } from "node:events";
import { app, safeStorage } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createNodeEntrypointInvocation } from "../../daemon/runtime-paths.js";
import { getBundledCliShimPath } from "../../integrations/cli-install/index.js";
import { familiarPaths } from "./paths.js";
import { existsSync } from "node:fs";
const bindingSchema = z
  .object({
    channelId: z.string().regex(/^\d+$/u),
    host: z.string().min(1).max(4096),
    agentId: z.string().min(1).max(160).optional(),
    sessionId: z.string().min(1).max(160).optional(),
    allowedUserIds: z.array(z.string().regex(/^\d+$/u)).min(1),
    sharedWorkspace: z.string().min(1).max(100).default("main"),
  })
  .strict()
  .refine(
    (value) => Boolean(value.agentId) !== Boolean(value.sessionId),
    "Choose a native agent or a logical session",
  );
const settingsSchema = z
  .object({
    bindings: z.array(bindingSchema).max(32),
    servers: z.record(z.string().min(1), z.string().min(1).max(4096)).default({}),
  })
  .strict();
const inputSchema = settingsSchema.extend({ token: z.string().max(4096).optional() });
type Settings = z.infer<typeof settingsSchema>;
const READY_TIMEOUT_MS = 30_000;

/** The connector is opt-in and owns no model loop; the app owns only its process and credentials. */
export class DiscordConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private error: string | null = null;
  private starting: Promise<void> | null = null;
  constructor(private readonly configuredDirectory?: string) {}
  private get directory(): string {
    if (this.configuredDirectory) return this.configuredDirectory;
    const legacy = path.join(app.getPath("userData"), "discord");
    return existsSync(legacy) ? legacy : familiarPaths().discord;
  }
  private async settings(): Promise<Settings> {
    try {
      return settingsSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, "settings.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bindings: [], servers: {} };
      throw error;
    }
  }
  async status() {
    const settings = await this.settings();
    const tokenSet = await readFile(path.join(this.directory, "token.enc"))
      .then(() => true)
      .catch((error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    let state = this.child ? "connecting" : "stopped";
    if (this.ready) state = "connected";
    return { ...settings, tokenSet, state, error: this.error };
  }
  async save(input: unknown) {
    if (this.child || this.starting)
      throw new Error("Disconnect Discord before editing its bindings.");
    const { token, ...settings } = inputSchema.parse(input);
    if (new Set(settings.bindings.map((item) => item.channelId)).size !== settings.bindings.length)
      throw new Error("Each channel can be bound once.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (token) {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("OS credential encryption is unavailable.");
      await writeFile(
        path.join(this.directory, "token.enc.tmp"),
        safeStorage.encryptString(token),
        { mode: 0o600 },
      );
      await rename(
        path.join(this.directory, "token.enc.tmp"),
        path.join(this.directory, "token.enc"),
      );
    }
    await writeFile(path.join(this.directory, "settings.json.tmp"), JSON.stringify(settings), {
      mode: 0o600,
    });
    await rename(
      path.join(this.directory, "settings.json.tmp"),
      path.join(this.directory, "settings.json"),
    );
    return this.status();
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private async launch(): Promise<void> {
    const settings = await this.settings();
    if (!settings.bindings.length) throw new Error("Add an authorized Discord channel first.");
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("OS credential encryption is unavailable.");
    const token = safeStorage.decryptString(await readFile(path.join(this.directory, "token.enc")));
    const configPath = path.join(this.directory, "runtime.json");
    const channels = Object.fromEntries(
      settings.bindings.map(({ channelId, ...binding }) => [channelId, binding]),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        cliPath: getBundledCliShimPath(),
        stateDirectory: path.join(this.directory, "state"),
        channels,
        servers: settings.servers,
      }),
      { mode: 0o600 },
    );
    const entryPath = app.isPackaged
      ? path.join(process.resourcesPath, "familiar", "discord.cjs")
      : path.join(app.getAppPath(), "assets", "familiar", "discord.cjs");
    const invocation = createNodeEntrypointInvocation({
      entrypoint: { entryPath, execArgv: [] },
      argvMode: "node-script",
      args: [configPath],
      baseEnv: process.env,
    });
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.ready = false;
    this.error = null;
    await new Promise<void>((resolve, reject) => {
      let settled = false,
        output = "";
      const timer = setTimeout(
        () => fail("Discord connection timed out. Check network access and bot settings."),
        READY_TIMEOUT_MS,
      );
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          child.kill("SIGTERM");
          reject(error);
        } else {
          this.ready = true;
          resolve();
        }
      };
      const fail = (message: string) => {
        this.error = message;
        finish(new Error(message));
      };
      child.once("error", () => fail("Discord Connector could not start."));
      child.stdin.on("error", () => fail("Discord Connector could not receive its credentials."));
      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-1024);
        if (!settled && output.includes("FAMILIAR_DISCORD_READY")) {
          finish();
        }
      });
      child.stderr.on("data", () => {
        /* Provider output can contain credentials; expose a bounded generic diagnostic only. */
      });
      child.once("close", (code) => {
        this.child = null;
        this.ready = false;
        if (!settled)
          fail(
            "Discord login failed. Check the bot token, network access and Message Content Intent.",
          );
        else if (code)
          this.error =
            "Discord Connector stopped unexpectedly. Reconnect after checking its settings.";
      });
      child.stdin.end(token);
    });
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const closed = once(child, "close");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.kill("SIGTERM");
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
}
export const discordConnection = new DiscordConnection();
