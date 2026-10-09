import type { ToolPlan } from "../../shared/tool-catalog.js";
import { nodeToolCommand } from "./setup-node.js";

export interface IntegratedInstallRecipe {
  id: string;
  version: string;
  repository?: string;
  commit?: string;
  url?: string;
  sha256?: string;
  format?: "tar" | "zip" | "deb" | "script";
  commands?: { command: string; args: string[]; cwd?: string }[];
  verify: string[];
  runtime?: { url: string; sha256: string; directory: string };
}

/** Runs only the selected, pinned upstream build. The staging directory is never used as a profile. */
export const INTEGRATED_INSTALL_DRIVER = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawn} = require('node:child_process');
(async () => {
  const [encoded, destination, node] = process.argv.slice(1);
  let runtimeNode = node;
  const recipe = JSON.parse(encoded);
  const parent = path.dirname(destination);
  await fs.mkdir(parent, {recursive:true, mode:0o700});
  let reuseDirectory = false;
  try {
    const record = JSON.parse(await fs.readFile(path.join(destination,'.familiar-install.json'),'utf8'));
    if(record.id !== recipe.id || record.version !== recipe.version) throw new Error('Existing installation belongs to another version. Select a new installation folder.');
    for(const file of recipe.verify) await fs.access(path.join(destination,file));
    if(recipe.format==='script') reuseDirectory=true;
    else {console.log('This original version is already installed.'); return;}
  } catch(error) { if(error.code !== 'ENOENT') throw error; }
  try {if(!reuseDirectory) {await fs.lstat(destination); throw new Error('The destination already exists without a verified installation. It will not be overwritten.');}}
  catch(error) {if(error.code !== 'ENOENT') throw error;}
  const stage = await fs.mkdtemp(path.join(parent,'.'+recipe.id+'-install-'));
  const run = (command,args,cwd=stage) => new Promise((resolve,reject) => {
    const child=spawn(command,args,{cwd,env:{...process.env,PATH:path.dirname(runtimeNode)+path.delimiter+(process.env.PATH||'')},shell:false,stdio:'inherit'});
    child.once('error',reject); child.once('exit',(code,signal)=>code===0?resolve():reject(new Error('Original installer failed: '+command+' ('+(signal||code)+')')));
  });
  try {
    if(recipe.repository) {
      await run('git',['init',stage]);
      await run('git',['remote','add','origin',recipe.repository]);
      await run('git',['fetch','--depth=1','origin',recipe.commit]);
      await run('git',['checkout','--detach','FETCH_HEAD']);
      const actual=(await fs.readFile(path.join(stage,'.git','HEAD'),'utf8')).trim();
      if(actual!==recipe.commit) throw new Error('Original source revision did not match.');
    } else {
      const response=await fetch(recipe.url,{signal:AbortSignal.timeout(300000)});
      if(!response.ok) throw new Error('Original download failed: HTTP '+response.status);
      const archive=path.join(stage,'download');
      const handle=await fs.open(archive,'wx',0o600); const hash=createHash('sha256'); let size=0;
      try {for await(const chunk of response.body){size+=chunk.length; if(size>1024*1024*1024) throw new Error('Original download exceeds 1 GiB.'); hash.update(chunk); await handle.writeFile(chunk);}}
      finally {await handle.close();}
      if(hash.digest('hex')!==recipe.sha256) throw new Error('Original download failed its SHA-256 check.');
      if(recipe.format==='tar') await run('tar',['-xzf',archive,'-C',stage]);
      else if(recipe.format==='zip') await run('unzip',['-q',archive,'-d',stage]);
      else if(recipe.format==='deb') {
        await run('ar',['x',archive]);
        const data=(await fs.readdir(stage)).find(x=>/^data\.tar\.(xz|gz|zst)$/.test(x));
        if(!data) throw new Error('No native package payload found.');
        await run('tar',['-xf',path.join(stage,data),'-C',stage]);
      } else if(recipe.format==='script') await run('bash',[archive]);
      await fs.unlink(archive);
    }
    if(recipe.runtime) {
      const directory=path.join(stage,'.familiar-runtime'); await fs.mkdir(directory,{mode:0o700});
      const archive=path.join(directory,'node.tar.gz');
      const response=await fetch(recipe.runtime.url,{signal:AbortSignal.timeout(120000)});
      if(!response.ok) throw new Error('Native Node runtime download failed: HTTP '+response.status);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length>128*1024*1024||createHash('sha256').update(bytes).digest('hex')!==recipe.runtime.sha256) throw new Error('Native Node runtime integrity check failed.');
      await fs.writeFile(archive,bytes,{mode:0o600,flag:'wx'}); await run('tar',['-xzf',archive,'-C',directory]); await fs.unlink(archive);
      runtimeNode=path.join(directory,recipe.runtime.directory,'bin','node');
      await run(runtimeNode,['--version']);
    }
    for(const item of recipe.commands||[]) await run(item.command==='$NODE'?runtimeNode:item.command,item.args,path.join(stage,item.cwd||''));
    for(const file of recipe.verify) await fs.access(path.join(stage,file));
    await fs.writeFile(path.join(stage,'.familiar-install.json'),JSON.stringify({id:recipe.id,version:recipe.version,commit:recipe.commit,sha256:recipe.sha256})+'\n',{mode:0o600,flag:'wx'});
    if(reuseDirectory) await fs.copyFile(path.join(stage,'.familiar-install.json'),path.join(destination,'.familiar-install.json'));
    else await fs.rename(stage,destination);
    console.log('Original '+recipe.id+' installed at '+destination+'. Use Check setup to continue.');
  } finally {await fs.rm(stage,{recursive:true,force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
`;

export function integratedInstallPlan(options: {
  recipe: IntegratedInstallRecipe;
  destination: string;
  cwd: string;
  node: string;
  platform?: string;
}): ToolPlan {
  return {
    toolId: options.recipe.id,
    action: "install",
    mode: "terminal",
    cwd: options.cwd,
    ...nodeToolCommand(
      options.node,
      [
        "-e",
        INTEGRATED_INSTALL_DRIVER,
        JSON.stringify(options.recipe),
        options.destination,
        options.node,
      ],
      options.platform,
    ),
    notes: [
      "Downloads a pinned original release or source revision and verifies it before use. Source builds run upstream dependency and build scripts in a new private folder.",
      "Existing projects, original profiles and sign-in credentials are preserved. Installation does not claim that an agent account is ready.",
    ],
  };
}
