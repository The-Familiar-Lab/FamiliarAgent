import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { ToolPlan } from "../../shared/tool-catalog.js";
import { nodeToolCommand } from "./setup-node.js";

export async function privateProfile(folder: string) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await lstat(folder);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    info.mode & 0o077
  )
    throw new Error("Native setup requires a private folder owned by this user.");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  if (!address || typeof address === "string")
    throw new Error("Could not select a local native server port.");
  return address.port;
}

const CODEG_LAUNCHER = String.raw`
const fs=require('node:fs'); const {spawn}=require('node:child_process');
const [binary,profile,config,tokenFile]=process.argv.slice(2);
const settings=JSON.parse(fs.readFileSync(config,'utf8'));
const token=fs.readFileSync(tokenFile,'utf8').trim();
if(!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid private Codeg token.');
const child=spawn(binary,[],{cwd:require('node:path').dirname(binary),stdio:'inherit',env:{...process.env,PATH:require('node:path').dirname(process.execPath)+require('node:path').delimiter+(process.env.PATH||''),CODEG_HOST:'127.0.0.1',CODEG_PORT:String(settings.port),CODEG_DATA_DIR:profile,CODEG_TOKEN:token}});
let stopped=false, pending, retry;
function stopProbe(){stopped=true;pending?.abort();clearTimeout(retry);}
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{stopProbe();child.kill(signal);});
child.once('error',error=>{stopProbe();console.error(error.message);process.exitCode=1;});
child.once('exit',(code)=>{stopProbe();process.exitCode=code??1;});
(async()=>{
 const url='http://127.0.0.1:'+settings.port;const deadline=Date.now()+15000;
 while(!stopped&&Date.now()<deadline){
  pending=new AbortController();const timeout=setTimeout(()=>pending.abort(),1000);
  try{
   const response=await fetch(url+'/api/health',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:'{}',signal:pending.signal});
   if(response.status!==200){await response.body?.cancel();throw new Error('Not ready');}
   const reader=response.body.getReader();let bytes=0;const chunks=[];
   while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>4096){await reader.cancel();throw new Error('Invalid health response');}chunks.push(Buffer.from(item.value));}
   if(JSON.parse(Buffer.concat(chunks).toString('utf8')).status==='ok'&&!stopped&&child.exitCode===null&&child.signalCode===null){console.log('Codeg view: '+url);return;}
  }catch{/* Original runtime remains authoritative; never report an unverified URL. */}
  finally{clearTimeout(timeout);}
  if(!stopped)await new Promise(resolve=>{retry=setTimeout(resolve,250);retry.unref();});
 }
 if(!stopped)console.error('Codeg readiness was not confirmed. Check the original server, then open its view again.');
})().catch(()=>{if(!stopped)console.error('Codeg readiness could not be checked.');});
`;

export async function prepareCodegRuntime(options: {
  directory: string;
  profile: string;
  executable: string;
  node: string;
  cwd: string;
  platform?: string;
}) {
  await privateProfile(options.profile);
  const configuration = join(options.profile, "familiar-server.json");
  const tokenFile = join(options.profile, "familiar-token");
  try {
    await writeFile(configuration, JSON.stringify({ port: await availablePort() }) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    await writeFile(tokenFile, randomBytes(32).toString("hex") + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const path of [configuration, tokenFile]) {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Codeg setup files must be private regular files owned by this user.");
  }
  const { port } = JSON.parse(await readFile(configuration, "utf8"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid saved Codeg server port.");
  const launcher = join(options.profile, "familiar-server.cjs");
  await writeFile(launcher, CODEG_LAUNCHER, { mode: 0o600 });
  const plan: ToolPlan = {
    toolId: "codeg",
    action: "launch",
    mode: "terminal",
    cwd: options.cwd,
    ...nodeToolCommand(
      options.node,
      [launcher, options.executable, options.profile, configuration, tokenFile],
      options.platform,
    ),
    notes: [
      "Starts the original Codeg server on loopback with a dedicated profile. The private token is read from a file and never placed in a URL or saved action parameters. Keep the terminal open while using Run actions.",
      "Use original Agent Settings to install and sign in to a provider. Installation does not imply authentication.",
    ],
  };
  const connection = { url: `http://127.0.0.1:${port}`, tokenFile };
  return {
    plan,
    settings: ["prepare-agent", "list", "create", "send", "read"].map((action) => ({
      action,
      parameters: ["prepare-agent", "create"].includes(action)
        ? { ...connection, agentType: "claude_code" }
        : connection,
    })),
  };
}

export async function prepareOrcaCli(
  node: string,
  entry: string,
  wrapper: string,
  profile?: string,
) {
  await privateProfile(dirname(wrapper));
  const launch = nodeToolCommand(node, [entry], "darwin");
  await writeFile(
    wrapper,
    `#!/bin/sh\n${profile ? `export ORCA_USER_DATA_PATH=${shellQuote(profile)}\n` : ""}exec ${[launch.command, ...launch.args].map(shellQuote).join(" ")} "$@"\n`,
    {
      mode: 0o700,
    },
  );
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
