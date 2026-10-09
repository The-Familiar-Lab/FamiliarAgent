import { expect, it, vi } from "vitest";
import { resolveAgentReply, selectAgentReply } from "./agent-reply.js";
const user = (id: string) => ({
  item: { type: "user_message", clientMessageId: id, text: "owned prompt" },
});
const answer = (text: string) => ({ item: { type: "assistant_message", text } });
it("selects assistant segments for the exact native client message, excluding prompts and later turns", () => {
  expect(
    selectAgentReply(
      [
        user("before"),
        answer("old answer"),
        user("discord-owned"),
        answer("first"),
        { item: { type: "tool_call" } },
        answer("second"),
        user("later"),
        answer("unrelated"),
      ],
      "discord-owned",
    ),
  ).toEqual({ text: "first\n\nsecond", truncated: false });
});
it("refuses missing, ambiguous or unanswered native message identities", () => {
  expect(selectAgentReply([user("old"), answer("wrong answer")], "missing")).toBeNull();
  expect(selectAgentReply([user("same"), user("same"), answer("ambiguous")], "same")).toBeNull();
  expect(selectAgentReply([user("owned"), user("other"), answer("later")], "owned")).toBeNull();
});
it("marks bounded long assistant responses explicitly", () => {
  const result = selectAgentReply(
    [user("owned"), answer("x".repeat(100000)), answer("tail")],
    "owned",
  );
  expect(result?.text).toHaveLength(64 * 1024);
  expect(result?.truncated).toBe(true);
});

const restored = {
  entries: [
    { item: { type: "user_message", messageId: "provider-native", text: "owned prompt" } },
    answer("restored answer"),
  ],
  hasOlder: false,
  hasNewer: false,
};
it("recovers a restored native ID only through the matching completed durable receipt", async () => {
  const agent = { messageReceipt: vi.fn(async () => ({ state: "completed" })) };
  expect(await resolveAgentReply(agent, restored, "discord-owned")).toEqual({
    text: "restored answer",
    truncated: false,
  });
  expect(agent.messageReceipt).toHaveBeenCalledWith("discord-owned", {
    text: "owned prompt",
    activeTurnBehavior: "steer",
  });
});
it("does not recover repeated prompts, partial histories or absent/ambiguous deliveries", async () => {
  const agent = { messageReceipt: vi.fn(async () => ({ state: "completed" })) };
  expect(
    await resolveAgentReply(agent, { ...restored, hasOlder: true }, "discord-owned"),
  ).toBeNull();
  expect(agent.messageReceipt).not.toHaveBeenCalled();
  expect(
    await resolveAgentReply(
      agent,
      { ...restored, entries: [...restored.entries, ...restored.entries] },
      "discord-owned",
    ),
  ).toBeNull();
  for (const state of ["absent", "pending", "rejected"]) {
    expect(
      await resolveAgentReply(
        { messageReceipt: async () => ({ state }) },
        restored,
        "discord-owned",
      ),
    ).toBeNull();
  }
  expect(
    await resolveAgentReply(
      {
        messageReceipt: async () => {
          throw new Error("agent_request_key_conflict");
        },
      },
      restored,
      "discord-owned",
    ),
  ).toBeNull();
  await expect(
    resolveAgentReply(
      {
        messageReceipt: async () => {
          throw new Error("connection failed");
        },
      },
      restored,
      "discord-owned",
    ),
  ).rejects.toThrow("connection failed");
});
