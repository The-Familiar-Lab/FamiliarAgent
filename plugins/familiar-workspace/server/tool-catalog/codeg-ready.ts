import http from "node:http";
import { readBounded } from "../native-tools/native-files.js";

const PROBE_TIMEOUT_MS = 2000;
const PROBE_MAX_BYTES = 4096;
const UNVERIFIED =
  "The original Codeg service could not be verified. Check its existing terminal and setup before retrying; no second service was started.";

/** The private managed token authenticates the existing service, never its browser URL. */
export async function codegReady(url: string, tokenFile: string): Promise<boolean> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port)
    throw new Error("The managed Codeg service must use its configured loopback address.");
  const token = (await readBounded(tokenFile)).trim();
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error("Invalid private Codeg token.");
  endpoint.pathname = "/api/health";
  return new Promise((resolve, reject) => {
    const request = http.request(
      endpoint,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > PROBE_MAX_BYTES) response.destroy(new Error(UNVERIFIED));
          else chunks.push(chunk);
        });
        response.once("error", () => {
          clearTimeout(timer);
          reject(new Error(UNVERIFIED));
        });
        response.once("end", () => {
          clearTimeout(timer);
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (
              response.statusCode !== 200 ||
              !body ||
              typeof body !== "object" ||
              !("status" in body) ||
              body.status !== "ok"
            )
              throw new Error(UNVERIFIED);
            resolve(true);
          } catch {
            reject(new Error(UNVERIFIED));
          }
        });
      },
    );
    const timer = setTimeout(() => request.destroy(new Error(UNVERIFIED)), PROBE_TIMEOUT_MS);
    request.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(new Error(UNVERIFIED));
    });
    request.end("{}");
  });
}
