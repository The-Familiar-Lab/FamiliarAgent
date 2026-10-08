import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

function query(initializationResult: () => Promise<unknown>): Query {
  return {
    initializationResult,
    supportedCommands: vi.fn(async () => []),
    close: vi.fn(),
    return: vi.fn(async () => ({ done: true })),
  } as unknown as Query;
}

function client(queryFactory: () => Query, initializationTimeoutMs = 100) {
  return new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude",
    queryFactory,
    initializationTimeoutMs,
  });
}

const config = { provider: "claude" as const, cwd: process.cwd() };

describe("Claude initialization", () => {
  test("bounds an unresponsive launch, closes it, and allows a fresh retry", async () => {
    const blocked = query(() => new Promise(() => {}));
    const ready = query(async () => ({}));
    const factory = vi.fn().mockReturnValueOnce(blocked).mockReturnValue(ready);
    const session = await client(factory, 20).createSession(config);
    await expect(session.listCommands!()).rejects.toThrow("folder access permissions");
    expect(blocked.close).toHaveBeenCalledOnce();
    await expect(session.listCommands!()).resolves.toBeInstanceOf(Array);
    expect(factory).toHaveBeenCalledTimes(2);
    await session.close();
  });

  test("concurrent control requests share initialization without escaping it early", async () => {
    let release!: () => void;
    const ready = query(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const factory = vi.fn(() => ready);
    const session = await client(factory).createSession(config);
    const first = session.listCommands!();
    const second = session.listCommands!();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    expect(ready.supportedCommands).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(factory).toHaveBeenCalledOnce();
    await session.close();
  });

  test("rejects invalid startup budgets", () => {
    const unusedQuery = query(async () => ({}));
    const factory = () => unusedQuery;
    for (const budget of [0, -1, Infinity, NaN]) {
      expect(() => client(factory, budget)).toThrow("positive and finite");
    }
  });
});
