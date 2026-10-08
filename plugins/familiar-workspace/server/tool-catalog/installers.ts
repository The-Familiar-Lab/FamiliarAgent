import path from "node:path";
import type { ToolPlan } from "../../shared/tool-catalog.js";

/** Execute the original pinned installer only after verifying the audited bytes.
 * Arguments are data, never interpolated into this program. */
const INSTALL_DRIVER = String.raw`
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
(async () => {
  const [url, sha256, root, bash, encodedEnv] = process.argv.slice(1);
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
    process.exitCode = code;
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
  },
  "claude-squad": {
    url: "https://raw.githubusercontent.com/smtg-ai/claude-squad/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/install.sh",
    sha256: "dc10fa73cd96d36f6ce9691b122e52c3aa6ba6b612ab4a5a2446b7112f58a6d6",
    env: { VERSION: "1.0.20" },
    required: ["bash", "curl", "tar", "tmux", "gh"] as string[],
    binVariable: "BIN_DIR",
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
    [recipe.binVariable]: path.join(options.root, "tools", "bin"),
    PATH: options.searchPath,
  };
  return {
    toolId: options.id,
    action: "install",
    mode: "terminal",
    cwd: options.cwd,
    command: process.execPath,
    args: [
      "-e",
      INSTALL_DRIVER,
      recipe.url,
      recipe.sha256,
      options.root,
      bash!,
      JSON.stringify(env),
    ],
    notes: [
      "Runs the original version-pinned installer after SHA-256 verification, in FamiliarAgent's private tools folder. Existing native installations and login credentials remain in place.",
    ],
  };
}
