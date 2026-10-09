import { expect, test } from "vitest";
import { isReply } from "./replies.js";

test.each(["send_agent_message_request", "send_agent_message_if_idle_request"] as const)(
  "%s receives its shared send acknowledgement only for the matching request",
  (type) => {
    const request = {
      type,
      requestId: "request",
      agentId: "agent",
      text: "result",
      activeTurnBehavior: "reject" as const,
    };
    const response = {
      type: "send_agent_message_response" as const,
      payload: { requestId: "request", agentId: "agent", accepted: true, error: null },
    };
    expect(isReply(request, response)).toBe(true);
    expect(
      isReply(request, { ...response, payload: { ...response.payload, requestId: "another" } }),
    ).toBe(false);
    expect(
      isReply({ type: "fetch_agent_request", requestId: "request", agentId: "agent" }, response),
    ).toBe(false);
  },
);

test("receipt lookup receives its read-only response, never a send acknowledgement", () => {
  const request = {
    type: "agent.message_receipt.request" as const,
    requestId: "receipt",
    agentId: "agent",
    messageId: "input",
    text: "result",
    activeTurnBehavior: "reject" as const,
  };
  expect(
    isReply(request, {
      type: "agent.message_receipt.response",
      payload: {
        requestId: "receipt",
        agentId: "agent",
        messageId: "input",
        receipt: { state: "pending", error: null, code: null },
        error: null,
      },
    }),
  ).toBe(true);
  expect(
    isReply(request, {
      type: "send_agent_message_response",
      payload: { requestId: "receipt", agentId: "agent", accepted: true, error: null },
    }),
  ).toBe(false);
});
