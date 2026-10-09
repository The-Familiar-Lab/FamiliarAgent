import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts } from "./index.js";
import { AgentMessageRejectedError } from "../agent/message-rejection.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new MessageReceipts(directory) };
}

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new MessageReceipts(directory).send(input);
  expect(deliveries).toBe(1);
  await expect(new MessageReceipts(directory).lookup(input)).resolves.toEqual({
    state: "completed",
    error: null,
    code: null,
  });
  await expect(requests.lookup({ ...input, request: { text: "different" } })).rejects.toThrow(
    "agent_request_key_conflict",
  );
  await expect(requests.send({ ...input, request: { text: "different" } })).rejects.toThrow(
    "agent_request_key_conflict",
  );
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  await expect(new MessageReceipts(directory).lookup(input)).resolves.toEqual({
    state: "pending",
    error: null,
    code: null,
  });
  expect(deliveries).toBe(1);
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  await expect(requests.lookup(input)).resolves.toEqual({
    state: "absent",
    error: null,
    code: null,
  });
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test("a proven pre-dispatch rejection survives restart without becoming an ambiguous retry", async () => {
  const { requests, directory } = await fixture();
  let attempts = 0;
  const input = {
    agentId: "busy-agent",
    messageId: "result-edge",
    request: { prompt: "result", activeTurnBehavior: "reject" },
    send: async () => {
      attempts++;
      throw new AgentMessageRejectedError("agent_busy", "Agent already has an active run");
    },
  };
  await expect(requests.send(input)).rejects.toMatchObject({ code: "agent_busy" });
  const restored = new MessageReceipts(directory);
  await expect(restored.lookup(input)).resolves.toEqual({
    state: "rejected",
    error: "Agent already has an active run",
    code: "agent_busy",
  });
  await expect(restored.send(input)).rejects.toMatchObject({ code: "agent_busy" });
  expect(attempts).toBe(1);
});

test("receipt lookup observes pending delivery without waiting for or repeating it", async () => {
  const { requests } = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: { b: 2, a: 1 },
    send: async () => {
      sends++;
      entered();
      await blocked;
    },
  };
  const send = requests.send(input);
  await ready;
  try {
    await expect(requests.lookup({ ...input, request: { a: 1, b: 2 } })).resolves.toEqual({
      state: "pending",
      error: null,
      code: null,
    });
    expect(sends).toBe(1);
  } finally {
    release();
    await send;
  }
});
