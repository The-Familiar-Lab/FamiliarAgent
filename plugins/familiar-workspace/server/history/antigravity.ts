// Read-only local RPC discovery informed by Antigravity-Mobility-CLI (MIT).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { array, object, string, timestamp, contentText } from "./parsers.js";
import type { HistoryMessage } from "../../shared/history.js";
import type { ScanSink } from "./readers.js";
const exec = promisify(execFile);
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export function parseSteps(steps: unknown[]): HistoryMessage[] {
  return steps.flatMap((raw) => {
    const step = object(raw),
      metadata = object(step.metadata);
    const user = object(step.userInput),
      response = object(step.plannerResponse);
    const text =
      contentText(user.items) ||
      string(user.userResponse) ||
      string(response.modifiedResponse) ||
      string(response.response) ||
      string(object(step.notifyUser).message);
    if (!text.trim()) return [];
    return [
      {
        role: step.userInput ? ("user" as const) : ("assistant" as const),
        text,
        timestamp: timestamp(metadata.createdAt),
      },
    ];
  });
}
async function encryptedFiles(home: string) {
  const files = new Map<string, string>();
  for (const name of ["antigravity", "antigravity-ide", "antigravity-cli"]) {
    const dir = path.join(home, ".gemini", name, "conversations");
    try {
      for (const file of await readdir(dir))
        if (/^[\w-]+\.pb$/.test(file)) files.set(file.slice(0, -3), path.join(dir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}
export async function scanAntigravity(home: string, sink: ScanSink, nativeId?: string) {
  const files = await encryptedFiles(home);
  if (!files.size && !nativeId) return;
  if (process.platform === "win32") {
    sink.error(
      "Antigravity: encrypted history requires the local IDE reader on macOS/Linux or a transcript export.",
    );
    return;
  }
  const { stdout } = await exec(
    "ps",
    ["-U", String(process.getuid?.() ?? ""), "-o", "pid=,args="],
    { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
  );
  let reachable = false;
  for (const line of stdout.split("\n")) {
    if (!/language_server/.test(line) || !/antigravity/i.test(line)) continue;
    const pid = line.match(/^\s*(\d+)/)?.[1],
      csrf = line.match(/--csrf_token[=\s]+(\S+)/)?.[1];
    if (!pid || !csrf) continue;
    let ports: string[];
    try {
      const sockets = await exec(
        "lsof",
        ["-a", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"],
        { timeout: TIMEOUT_MS },
      );
      ports = [...sockets.stdout.matchAll(/^n(?:127\.0\.0\.1|\[::1\]):(\d+)$/gm)].map(
        (match) => match[1]!,
      );
    } catch {
      continue;
    }
    for (const port of ports) {
      if (await scanPort(port, csrf, files, sink, home, nativeId)) {
        reachable = true;
        break;
      }
    }
  }
  if (!reachable)
    sink.error(
      "Antigravity: open the original IDE and Scan history again. Its encrypted records need a running local reader (HTTP loopback support required).",
    );
}

async function localCall(
  port: string,
  csrf: string,
  method: "GetAllCascadeTrajectories" | "GetCascadeTrajectory",
  body: object,
) {
  // Only plaintext loopback endpoints owned by the discovered local process.
  // Never disable TLS verification or send this token off-machine.
  const response = await fetch(
    `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`,
    {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "x-codeium-csrf-token": csrf },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Local reader HTTP ${response.status}`);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body)
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error("Antigravity conversation exceeds the import size limit");
      chunks.push(chunk);
    }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
async function scanPort(
  port: string,
  csrf: string,
  files: Map<string, string>,
  sink: ScanSink,
  home: string,
  nativeId?: string,
): Promise<boolean> {
  let summaries;
  try {
    summaries = object(
      (await localCall(port, csrf, "GetAllCascadeTrajectories", {})).trajectorySummaries,
    );
  } catch {
    return false;
  }
  for (const id of nativeId ? [nativeId] : new Set([...files.keys(), ...Object.keys(summaries)])) {
    try {
      const result = await localCall(port, csrf, "GetCascadeTrajectory", { cascadeId: id });
      const trajectory = object(result.trajectory),
        steps = array(trajectory.steps);
      if (typeof result.numTotalSteps === "number" && result.numTotalSteps > steps.length)
        throw new Error(
          "Local reader returned an incomplete trajectory; open it in Antigravity and scan again",
        );
      const messages = parseSteps(steps),
        summary = object(summaries[id]);
      if (!messages.length) continue;
      const sourceFile = files.get(id);
      await sink.accept({
        nativeId: id,
        source: "Antigravity",
        reference: { kind: "antigravity-reader", home },
        title:
          string(summary.summary) ||
          string(summary.title) ||
          messages.find((item) => item.role === "user")?.text.slice(0, 160) ||
          id,
        origin: sourceFile || "Antigravity local reader",
        workspace: string(summary.workspaceUri),
        updatedAt: sourceFile
          ? (await stat(sourceFile)).mtime.toISOString()
          : timestamp(summary.lastModifiedTime),
        messages,
        notes: [
          "Visible messages are read through the running Antigravity IDE. Open the IDE to read this conversation; tool internals, media and checkpoints remain there.",
        ],
      });
    } catch {
      sink.error(
        `Antigravity ${id}: local reader could not load the complete conversation. Open it in Antigravity and scan again.`,
      );
    }
  }

  return true;
}
