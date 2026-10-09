import path from "node:path";
import os from "node:os";
import type { ToolPlan } from "../../shared/tool-catalog.js";
import { nodeToolCommand } from "../integrated-tools/setup-node.js";

/** Execute the original pinned installer only after verifying the audited bytes.
 * Arguments are data, never interpolated into this program. */
const INSTALL_DRIVER = String.raw`
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
(async () => {
  const [url, sha256, root, bash, encodedEnv, expectedBinary] = process.argv.slice(1);
  const parent = path.join(root, 'installers');
  await fs.mkdir(parent, {recursive:true, mode:0o700});
  const temporary = await fs.mkdtemp(path.join(parent, 'native-'));
  try {
    const response = await fetch(url, {signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('Installer download failed: HTTP ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 1024*1024 || createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Installer integrity check failed');
    const file = path.join(temporary, 'install.sh');
    await fs.writeFile(file, bytes, {mode:0o700, flag:'wx'});
    const env = {...process.env, ...JSON.parse(encodedEnv)};
    const code = await new Promise((resolve,reject) => {
      const child = spawn(bash, [file], {cwd:temporary, env, stdio:'inherit', shell:false});
      child.once('error', reject);
      child.once('exit', (code, signal) => signal ? reject(new Error('Installer ended with ' + signal)) : resolve(code ?? 1));
    });
    if (code !== 0) { process.exitCode = code; return; }
    const installed = await fs.stat(expectedBinary).catch(() => null);
    if (!installed?.isFile()) throw new Error('Native installer exited without creating its executable. Check the original installer output.');
    await fs.access(expectedBinary, require('node:fs').constants.X_OK);
  } finally { await fs.rm(temporary, {recursive:true, force:true}); }
})().catch(error => {console.error(error.message); process.exitCode=1;});
`;

const RECIPES = {
  goose: {
    url: "https://raw.githubusercontent.com/aaif-goose/goose/9560429ff982bbfecec5094963e5f34696b63a1c/download_cli.sh",
    sha256: "710f208cf0225ac330f71cc1540d36b10a6be7a850334b5ec4770fe96fbc57c4",
    env: { GOOSE_VERSION: "v1.54.0", CONFIGURE: "false" },
    required: ["bash", "curl", "tar", "bzip2"] as string[],
    binVariable: "GOOSE_BIN_DIR",
    binary: "goose",
  },
  "claude-squad": {
    url: "https://raw.githubusercontent.com/smtg-ai/claude-squad/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/install.sh",
    sha256: "dc10fa73cd96d36f6ce9691b122e52c3aa6ba6b612ab4a5a2446b7112f58a6d6",
    env: { VERSION: "1.0.20" },
    required: ["bash", "curl", "tar", "tmux", "gh"] as string[],
    binVariable: "BIN_DIR",
    binary: "cs",
  },
  cursor: {
    url: "https://cursor.com/install",
    sha256: "dd6677f33cb7efa34809557b1c6df3a11e389b76ce4e56ce5751db13dd7260e6",
    env: {},
    required: ["bash", "curl", "tar"] as string[],
    binary: "cursor-agent",
  },
  antigravity: {
    url: "https://antigravity.google/cli/install.sh",
    sha256: "62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042",
    env: {},
    required: ["bash", "curl", "tar"] as string[],
    binary: "agy",
  },
} as const;

export async function prepareNativeInstaller(options: {
  id: keyof typeof RECIPES;
  root: string;
  cwd: string;
  searchPath: string;
  executable: (name: string) => Promise<string | undefined>;
}): Promise<ToolPlan> {
  const recipe = RECIPES[options.id];
  for (const name of recipe.required)
    if (!(await options.executable(name)))
      throw new Error(`${name} is required for the ${options.id} native installer on this server.`);
  const bash = await options.executable("bash");
  const env = {
    ...recipe.env,
    ...("binVariable" in recipe
      ? { [recipe.binVariable]: path.join(options.root, "tools", "bin") }
      : {}),
    PATH: options.searchPath,
  };
  const executable =
    "binVariable" in recipe
      ? path.join(options.root, "tools", "bin", recipe.binary)
      : path.join(os.homedir(), ".local", "bin", recipe.binary);
  return {
    toolId: options.id,
    action: "install",
    mode: "terminal",
    cwd: options.cwd,
    ...nodeToolCommand(process.execPath, [
      "-e",
      INSTALL_DRIVER,
      recipe.url,
      recipe.sha256,
      options.root,
      bash!,
      JSON.stringify(env),
      executable,
    ]),
    notes: [
      "Runs the reviewed original installer after SHA-256 verification and checks that its executable exists. Login remains in the original tool.",
      "binVariable" in recipe
        ? "Installs into FamiliarAgent's private tools folder."
        : "The vendor installer uses its original user-scoped CLI folders and update path. It does not copy an account from another server.",
    ],
  };
}
