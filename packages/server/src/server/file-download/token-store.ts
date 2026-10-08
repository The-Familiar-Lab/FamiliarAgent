import { randomUUID } from "node:crypto";

export interface DownloadTokenEntry {
  token: string;
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
  expiresAt: number;
}

interface DownloadTokenStoreOptions {
  ttlMs: number;
  now?: () => number;
  previewTtlMs?: number;
  maxTokens?: number;
}

export class DownloadTokenStore {
  private readonly ttlMs: number;
  private readonly previewTtlMs: number;
  private readonly maxTokens: number;
  private readonly now: () => number;
  private readonly previewLeases = new Set<string>();
  private readonly tokens = new Map<string, DownloadTokenEntry>();

  constructor(options: DownloadTokenStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.previewTtlMs = options.previewTtlMs ?? 30 * 60 * 1000;
    this.maxTokens = options.maxTokens ?? 1024;
    for (const value of [this.ttlMs, this.previewTtlMs, this.maxTokens])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Download limits must be positive integers");
    this.now = options.now ?? (() => Date.now());
  }

  issueToken(input: Omit<DownloadTokenEntry, "token" | "expiresAt">): DownloadTokenEntry {
    this.pruneExpired();
    if (this.tokens.size >= this.maxTokens)
      throw new Error(
        "Too many active downloads. Close previews or wait for their leases to expire.",
      );
    const token = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    const entry: DownloadTokenEntry = {
      ...input,
      token,
      expiresAt,
    };
    this.tokens.set(token, entry);
    return entry;
  }

  peekToken(token: string): DownloadTokenEntry | null {
    this.pruneExpired();
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (!this.previewLeases.has(token)) {
      entry.expiresAt = this.now() + this.previewTtlMs;
      this.previewLeases.add(token);
    }
    return entry;
  }

  consumeToken(token: string): DownloadTokenEntry | null {
    const entry = this.tokens.get(token);
    if (!entry) {
      return null;
    }

    this.tokens.delete(token);
    this.previewLeases.delete(token);

    if (entry.expiresAt <= this.now()) {
      return null;
    }

    return entry;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(token);
        this.previewLeases.delete(token);
      }
    }
  }
}
