import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type { ToolCommand, ToolHttpRequest } from "./contracts.js";

export const DEFAULT_TRANSPORT_LIMITS = {
  timeoutMs: 120_000,
  maxBytes: 1024 * 1024,
  killGraceMs: 1000,
};
export type TransportLimits = typeof DEFAULT_TRANSPORT_LIMITS;
function limits(input: { timeoutMs?: number; maxBytes?: number }, defaults: TransportLimits) {
  const timeoutMs = input.timeoutMs ?? defaults.timeoutMs;
  const maxBytes = input.maxBytes ?? defaults.maxBytes;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3_600_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 16 * 1024 * 1024
  )
    throw new Error("Invalid native transport limits");
  return { timeoutMs, maxBytes };
}
export function executeCommand(
  input: ToolCommand,
  signal: AbortSignal,
  defaults = DEFAULT_TRANSPORT_LIMITS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { timeoutMs, maxBytes } = limits(input, defaults);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finishFailedClose: (() => void) | undefined;
    const kill = (kind: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(kind);
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        killTimer = undefined;
        finishFailedClose?.();
      }, defaults.killGraceMs);
    };
    const aborted = () =>
      stop(new Error("Native action was cancelled; verify its original state before retrying"));
    signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(
      () => stop(new Error("Native action timed out; verify its original state before retrying")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", aborted);
    };
    const collect = (target: Buffer[], value: Buffer) => {
      bytes += value.length;
      if (bytes > maxBytes)
        stop(new Error("Native output exceeded its size limit; no partial result was accepted"));
      else target.push(value);
    };
    child.stdout.on("data", (value: Buffer) => collect(stdout, value));
    child.stderr.on("data", (value: Buffer) => collect(stderr, value));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    child.on("error", () => {
      cleanup();
      reject(
        new Error(
          "Could not start the native command. Check its installation and executable path.",
        ),
      );
    });
    child.on("close", (code, exitSignal) => {
      if (failure && killTimer) {
        // A parent can exit before its same-group descendants. Finish only after escalation.
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        finishFailedClose = () => {
          cleanup();
          reject(failure);
        };
        return;
      }
      cleanup();
      if (failure) reject(failure);
      else if (exitSignal) reject(new Error(`Native process ended with signal ${exitSignal}`));
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1,
        });
    });
    child.stdin.end(input.stdin);
    if (signal.aborted) aborted();
  });
}
export function requestHttp(
  input: ToolHttpRequest,
  signal: AbortSignal,
  defaults = DEFAULT_TRANSPORT_LIMITS,
): Promise<{ status: number; body: string }> {
  const { timeoutMs, maxBytes } = limits(input, defaults);
  const url = new URL(input.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Native API requires an HTTP(S) URL without embedded credentials");
  signal.throwIfAborted();
  let body: string | undefined;
  if (typeof input.body === "string") body = input.body;
  else if (input.body !== undefined) body = JSON.stringify(input.body);
  if (body && Buffer.byteLength(body) > maxBytes)
    throw new Error("Native request exceeds its size limit");
  return new Promise((resolve, reject) => {
    const headers = {
      ...(body !== undefined && typeof input.body !== "string"
        ? { "content-type": "application/json" }
        : {}),
      ...input.headers,
    };
    let responseExceeded = false;
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      { method: input.method ?? "GET", headers, socketPath: input.socketPath, signal },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (value: Buffer) => {
          bytes += value.length;
          if (bytes > maxBytes) {
            responseExceeded = true;
            response.destroy(new Error("Native API response exceeded its size limit"));
          } else chunks.push(value);
        });
        response.on("error", () => {
          clearTimeout(timer);
          reject(
            new Error(
              bytes > maxBytes
                ? "Native API response exceeded its size limit"
                : "Native API response was interrupted; check its original state",
            ),
          );
        });
        response.on("end", () => {
          clearTimeout(timer);
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    const timer = setTimeout(() => request.destroy(new Error("timeout")), timeoutMs);
    request.on("error", () => {
      clearTimeout(timer);
      let message =
        "Native API request failed or timed out; check its address, authentication and original state";
      if (responseExceeded) message = "Native API response exceeded its size limit";
      else if (signal.aborted) message = "Native API request cancelled; check its original state";
      reject(new Error(message));
    });
    request.end(body);
  });
}
