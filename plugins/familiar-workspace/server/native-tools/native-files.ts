import { spawn } from "node:child_process";
import { nodeToolCommand } from "../integrated-tools/setup-node.js";

export const NATIVE_OUTPUT_LIMIT = 512 * 1024;
const FILE_TIMEOUT_MS = 3000;
const MAX_READERS = 2;
const MAX_RESPONSE_BYTES = NATIVE_OUTPUT_LIMIT * 8;
const RETRY = "Check OS folder permissions and the original file location, then Retry.";
let activeReaders = 0;

const READER = String.raw`
const fs=require('node:fs/promises');
(async()=>{
 let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>1024*1024)throw new Error('Native file request exceeds its limit');}
 const {action,files,limit}=JSON.parse(input);
 if(action==='paths'){
  const paths=[];
  for(const file of files){try{paths.push(await fs.realpath(file));}catch(error){if(error.code==='ENOENT')paths.push(null);else throw error;}}
  process.stdout.write(JSON.stringify({paths}));return;
 }
 const handle=await fs.open(files[0],'r');
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.size>limit)throw new Error('Native artifact is not a regular file below 512 KiB');
  const buffer=Buffer.alloc(limit+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
  if(bytesRead>limit)throw new Error('Native artifact grew beyond 512 KiB');
  process.stdout.write(JSON.stringify({base64:buffer.subarray(0,bytesRead).toString('base64')}));
 }finally{await handle.close();}
})().catch(error=>{process.stdout.write(JSON.stringify({error:{message:error.message,code:error.code}}));process.exitCode=1;});
`;

interface NativeFileResult {
  base64?: string;
  paths?: (string | null)[];
  error?: { message: string; code?: string };
}

/** An OS permission wait must not consume the daemon's shared filesystem workers.
 * Keep timed-out readers counted until close, even when the OS cannot kill them yet. */
async function nativeFiles(
  action: "read" | "paths",
  files: string[],
  signal?: AbortSignal,
): Promise<NativeFileResult> {
  signal?.throwIfAborted();
  if (activeReaders >= MAX_READERS) throw new Error(`Native file readers are still busy. ${RETRY}`);
  const launch = nodeToolCommand(process.execPath, ["-e", READER]);
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  activeReaders++;
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const settle = (error?: Error, value?: NativeFileResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve(value!);
    };
    const aborted = () => settle(new Error(`Native file read cancelled. ${RETRY}`));
    const timer = setTimeout(
      () => settle(new Error(`Native file read timed out. ${RETRY}`)),
      FILE_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", aborted, { once: true });
    child.once("error", () =>
      settle(new Error(`Could not start the native file reader. ${RETRY}`)),
    );
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") settle(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) settle(new Error("Native file response exceeds its limit"));
      else chunks.push(chunk);
    });
    child.once("close", (code) => {
      activeReaders--;
      if (settled) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as NativeFileResult;
        if (value.error) {
          const error = new Error(`${value.error.message}. ${RETRY}`);
          Object.assign(error, { code: value.error.code });
          settle(error);
        } else if (code !== 0) settle(new Error(`Native file reader failed. ${RETRY}`));
        else settle(undefined, value);
      } catch {
        settle(new Error(`Native file reader returned an invalid result. ${RETRY}`));
      }
    });
    child.stdin.end(JSON.stringify({ action, files, limit: NATIVE_OUTPUT_LIMIT }));
    if (signal?.aborted) aborted();
  });
}

export async function readBounded(filename: string, signal?: AbortSignal): Promise<string> {
  const result = await nativeFiles("read", [filename], signal);
  if (typeof result.base64 !== "string") throw new Error("Native file reader returned no content");
  return Buffer.from(result.base64, "base64").toString("utf8");
}

export async function realpathsBounded(
  files: string[],
  signal?: AbortSignal,
): Promise<(string | null)[]> {
  const result = await nativeFiles("paths", files, signal);
  if (!Array.isArray(result.paths) || result.paths.length !== files.length)
    throw new Error("Native file reader returned invalid paths");
  return result.paths;
}
