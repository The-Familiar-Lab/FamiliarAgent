import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolPlan } from "../../shared/tool-catalog.js";

/** Assemble the upstream slot using its own file order, hashes and runtime identity. */
export const ORCA_SLOT_INSTALL = String.raw`
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{
 const [resources,target]=process.argv.slice(1),base=path.resolve(resources);
 const original=require(path.join(base,'app.asar.unpacked/out/shared/orcad-artifacts.js'));
 const template=path.join(base,'orcad-template');
 const manifest=JSON.parse(await fs.readFile(path.join(template,'orcad-template.json'),'utf8'));
 if(manifest.schemaVersion!==3||!manifest.targets[target]) throw new Error('This original Orca release has no compatible native server slot.');
 const files=original.orcadArtifactFilenames(target),targetFiles=new Set(original.orcadTemplateTargetFilenames(target));
 if(!Array.isArray(files)||files.length>512) throw new Error('Invalid original Orca artifact list.');
 const slot=path.resolve('familiar-orcad/slot');await fs.mkdir(slot,{recursive:true,mode:0o700});
 const identity=crypto.createHash('sha256');
 for(const file of files){
  if(typeof file!=='string'||path.isAbsolute(file)||file.split(/[\\/]/).includes('..')) throw new Error('Invalid Orca artifact path.');
  const specific=targetFiles.has(file),source=path.join(template,...(specific?['targets',target]:[]),file);
  const expected=(specific?manifest.targets[target].files:manifest.commonSha256)[file];
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Missing Orca artifact hash.');
  const bytes=await fs.readFile(source);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected) throw new Error('Original Orca artifact failed its SHA-256 check.');
  identity.update(bytes);const dest=path.join(slot,file);await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});
  await fs.writeFile(dest,bytes,{flag:'wx',mode:/(?:^|\/)(?:rg|spawn-helper)$/.test(file)?0o700:0o600});
 }
 const sha=(await fs.readFile(path.join(slot,'.runtime-node'),'utf8')).trim();
 if(!/^[a-f0-9]{64}$/.test(sha)||await (async()=>{const hash=crypto.createHash('sha256');for await(const chunk of require('node:fs').createReadStream(process.execPath))hash.update(chunk);return hash.digest('hex');})()!==sha) throw new Error('The installed Node runtime does not match Orca’s pinned runtime.');
 const runtime=path.resolve('familiar-orcad/runtimes','node-'+sha,'bin/node');await fs.mkdir(path.dirname(runtime),{recursive:true,mode:0o700});
 try{await fs.link(process.execPath,runtime);}catch{await fs.copyFile(process.execPath,runtime);await fs.chmod(runtime,0o700);}
 await fs.writeFile(path.join(slot,'.version'),original.ORCAD_VERSION+'+'+identity.digest('hex').slice(0,12)+'\n',{mode:0o600,flag:'wx'});
})().catch(error=>{console.error(error.message);process.exitCode=1;});
`;

export async function prepareOrcaServer(options: {
  directory: string;
  profile: string;
  cwd: string;
}): Promise<ToolPlan> {
  const slot = join(options.directory, "familiar-orcad/slot");
  const sha = (await readFile(join(slot, ".runtime-node"), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(sha)) throw new Error("Invalid original Orca runtime identity.");
  return {
    toolId: "orca",
    action: "launch",
    mode: "terminal",
    cwd: options.cwd,
    command: "/usr/bin/env",
    args: [
      `ORCA_USER_DATA=${options.profile}`,
      join(options.directory, "familiar-orcad/runtimes", `node-${sha}`, "bin/node"),
      join(slot, "orcad.js"),
      "--bind",
      "127.0.0.1",
      "--port",
      "0",
      "--json",
    ],
    notes: [
      "Starts Orca's original Node server on loopback in its private Familiar profile. Keep this terminal open while using Orca actions; no display server or system sandbox changes are required.",
      "The original server prints its local browser/pairing details. Register a project with its CLI before creating a terminal.",
    ],
  };
}
