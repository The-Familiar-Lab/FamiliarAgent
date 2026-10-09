import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PaseoAgentHandle, PaseoAgentTimelineEvent } from "@getpaseo/client";
import {
  observeAdvisor,
  sendAdvisorQuestion,
  type AdvisorSnapshot,
} from "./advisor-conversation.js";
vi.mock("../fleet.js", () => ({ operationId: () => "owned-message" }));
function fixture() {
  let listener: (event: PaseoAgentTimelineEvent) => void = () => {};
  const release = Object.assign(vi.fn(), { ready: Promise.resolve() });
  const page = {
    epoch: "one",
    entries: [{ seqEnd: 1, item: { type: "assistant_message", text: "Answer" } }],
    hasOlder: false,
    agent: { id: "advisor", status: "idle", pendingPermissions: [] },
  };
  const refetch = vi.fn().mockResolvedValue(page);
  const agent = {
    current: () => page.agent,
    timeline: {
      refetch,
      subscribe: (handler: typeof listener) => {
        listener = handler;
        return release;
      },
    },
  } as unknown as PaseoAgentHandle;
  const updates: AdvisorSnapshot[] = [];
  const stop = observeAdvisor(agent, (value) => updates.push(value));
  return {
    agent,
    page,
    refetch,
    release,
    updates,
    stop,
    event: (type: string) =>
      listener({ agentId: "advisor", event: { type } } as PaseoAgentTimelineEvent),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("reads only after subscription readiness and coalesces bursts without idle polling", async () => {
  const value = fixture();
  await vi.advanceTimersByTimeAsync(0);
  expect(value.refetch).toHaveBeenCalledWith({
    direction: "tail",
    projection: "canonical",
    limit: 24,
  });
  for (let index = 0; index < 100; index++) value.event("timeline");
  await vi.advanceTimersByTimeAsync(399);
  expect(value.refetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(value.refetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000);
  expect(value.refetch).toHaveBeenCalledTimes(2);
  value.stop();
  expect(value.release).toHaveBeenCalledOnce();
});
it("bounds recent text and preserves native approval state", async () => {
  const value = fixture();
  value.page.entries = [
    { seqEnd: 1, item: { type: "assistant_message", text: "old" } },
    { seqEnd: 2, item: { type: "assistant_message", text: "x".repeat(20000) } },
  ];
  value.page.agent.pendingPermissions = [{ id: "approval" }] as never;
  await vi.advanceTimersByTimeAsync(0);
  expect(value.updates.at(-1)?.messages).toHaveLength(1);
  expect(value.updates.at(-1)?.messages[0]?.text).toHaveLength(16000);
  expect(value.updates.at(-1)?.truncated).toBe(true);
  expect(value.updates.at(-1)?.agent?.pendingPermissions).toEqual([{ id: "approval" }]);
  value.stop();
});
it("discards a replaced epoch's late snapshot and serializes the recovery read", async () => {
  const value = fixture();
  let resolve!: (value: unknown) => void;
  value.refetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(0);
  value.event("replacement");
  await vi.advanceTimersByTimeAsync(1000);
  expect(value.refetch).toHaveBeenCalledTimes(1);
  resolve({
    ...value.page,
    entries: [{ seqEnd: 9, item: { type: "assistant_message", text: "Stale" } }],
  });
  await vi.advanceTimersByTimeAsync(400);
  expect(value.refetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(value.updates)).not.toContain("Stale");
  expect(value.updates.at(-1)?.messages[0]?.text).toBe("Answer");
  value.stop();
});
it("releases and suppresses outstanding reads and scheduled refreshes on unmount", async () => {
  const value = fixture();
  let resolve!: (value: unknown) => void;
  value.refetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(0);
  value.event("timeline");
  value.stop();
  resolve(value.page);
  await vi.advanceTimersByTimeAsync(60000);
  expect(value.updates).toEqual([]);
  expect(value.refetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("fails closed on source errors and never retries an uncertain send", async () => {
  const value = fixture();
  value.refetch.mockResolvedValue({ ...value.page, gap: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(value.updates.at(-1)?.error).toContain("Conversation changed");
  const send = vi.fn().mockRejectedValue(new Error("Lost reply"));
  expect(await sendAdvisorQuestion({ send }, "Question")).toMatchObject({
    state: "unknown",
    messageId: "owned-message",
    text: "Question",
  });
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith("Question", {
    messageId: "owned-message",
    activeTurnBehavior: "reject",
  });
  value.stop();
});
it("keeps a terminal subscription failure visible when an older read completes afterward", async () => {
  let listener: (event: PaseoAgentTimelineEvent) => void = () => {};
  let resolve!: (value: unknown) => void;
  const refetch = vi.fn().mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const release = Object.assign(vi.fn(), { ready: Promise.resolve() });
  const agent = {
    current: () => null,
    timeline: {
      refetch,
      subscribe: (handler: typeof listener) => {
        listener = handler;
        return release;
      },
    },
  } as unknown as PaseoAgentHandle;
  const update = vi.fn();
  const stop = observeAdvisor(agent, update);
  await vi.advanceTimersByTimeAsync(0);
  listener({ agentId: "advisor", event: { type: "error", error: "Subscription disconnected" } });
  resolve({ entries: [], epoch: "old", agent: { id: "advisor", status: "idle" } });
  await vi.advanceTimersByTimeAsync(10000);
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]![0].error).toBe("Subscription disconnected");
  expect(refetch).toHaveBeenCalledOnce();
  stop();
});
