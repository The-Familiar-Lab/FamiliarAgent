import { startFamiliarBot } from "./familiarBridge.js";
const configPath = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (input.length > 4096) { process.stderr.write("Invalid bot credential input\n"); process.exit(2); }
});
process.stdin.on("end", () => {
  const token = input.trim(); input = "";
  if (!configPath || !token) { process.stderr.write("Discord configuration and token are required\n"); process.exit(2); }
  void startFamiliarBot(token, configPath).then(() => {
    process.stdout.write('FAMILIAR_DISCORD_READY\n');
  }).catch(() => { process.stderr.write("Discord login failed. Check the token and Message Content Intent in the Discord developer portal.\n"); process.exit(1); });
});
