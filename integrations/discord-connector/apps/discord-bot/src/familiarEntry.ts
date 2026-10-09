import { homedir } from "node:os";
import path from "node:path";
import { familiarConfigSchema, startConfiguredFamiliarBot, startFamiliarBot } from "./familiarBridge.js";
import { applyFamiliarSource, createFamiliarChannel, inspectFamiliarSource, readFamiliarSource, validateFamiliarChannels } from "./familiarSource.js";
import { createFamiliarRelayRunner, serveFamiliarRelay } from "./familiarRelay.js";
async function main(): Promise<void> {
  const [mode, target, encoded] = process.argv.slice(2);
  if (mode === "--relay-cli") {
    if (!target) throw new Error("CLI path is required.");
    const stop = () => { process.stdin.destroy(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    try { await serveFamiliarRelay(target, process.stdin, process.stdout); }
    finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
    return;
  }
  if (mode === "--source-inspect" || mode === "--source-create" || mode === "--source-connect") {
    if (!target) throw new Error("Original configuration path is required.");
    const source = await readFamiliarSource(target);
    if (mode !== "--source-connect") { process.stdout.write(`${JSON.stringify(mode === "--source-create" ? await createFamiliarChannel(source) : await inspectFamiliarSource(source))}\n`); return; }
    if (!encoded || encoded.length > 256 * 1024) throw new Error("Discord bindings are invalid.");
    const config = applyFamiliarSource(familiarConfigSchema.parse({ ...JSON.parse(Buffer.from(encoded, "base64").toString("utf8")), cliPath: "/unused-relayed-cli", stateDirectory: path.join(homedir(), ".local/share/familiaragent/discord/source-state") }), source);
    await validateFamiliarChannels(source, Object.keys(config.channels));
    const runner = createFamiliarRelayRunner(process.stdin, process.stdout, () => process.exit(0));
    await startConfiguredFamiliarBot(source.discord.token, config, runner);
    process.stdout.write("FAMILIAR_DISCORD_READY\n"); return;
  }
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 4096) throw new Error("Invalid bot credential input."); }
  const token = input.trim(); input = "";
  if (!mode || !token) throw new Error("Discord configuration and token are required.");
  await startFamiliarBot(token, mode);
  process.stdout.write("FAMILIAR_DISCORD_READY\n");
}
void main().catch(error => {
  // Never serialize provider errors or the original credential object.
  const safe = error instanceof Error && /^(Choose |The original |Discord setup |A familiaragent-test |Existing connector bindings |A selected channel |Choose a separate channel)/.test(error.message);
  process.stderr.write(safe ? `${error.message}\n` : "Discord connection failed. Check network access, configuration permissions, bot access and Message Content Intent.\n");
  process.exit(1);
});
