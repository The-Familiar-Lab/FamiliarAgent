import { expect, it, vi } from "vitest";
import { forkContextToHost } from "./fork.js";
const input = {
  sourceId: "source",
  sourceHost: "ssh://first",
  targetHost: "ssh://second",
  cwd: "/target/project",
  prompt: "Continue this work",
  operationId: "stable-retry-id",
};
function clients() {
  return {
    source: {
      fetchAgent: vi.fn().mockResolvedValue({
        agent: { provider: "codex", title: "Project", cwd: "/source/project" },
      }),
      buildAgentForkContext: vi.fn().mockResolvedValue({
        attachment: {
          type: "text",
          mimeType: "text/plain",
          contextKind: "chat_history",
          text: "Earlier work",
        },
        error: null,
      }),
    },
    target: {
      createWorkspace: vi.fn().mockResolvedValue({
        workspace: { id: "new-workspace" },
        agent: { id: "new-agent", provider: "claude" },
        error: null,
      }),
    },
  };
}
it("reuses native history on another host/provider with stable retry identity and provenance", async () => {
  const { source, target } = clients();
  const result = await forkContextToHost(source, target, { ...input, provider: "claude" });
  expect(result).toMatchObject({
    mode: "portable-context",
    operationId: input.operationId,
    agentId: "new-agent",
  });
  expect(target.createWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      source: { kind: "directory", path: "/target/project" },
      idempotencyKey: "familiar-fork:stable-retry-id",
      agent: expect.objectContaining({
        config: { provider: "claude", cwd: "/target/project" },
        clientMessageId: "familiar-fork:stable-retry-id",
        attachments: expect.arrayContaining([
          expect.objectContaining({ contextKind: "chat_history", text: "Earlier work" }),
        ]),
      }),
    }),
  );
});
it("never starts a target when source context is unavailable or exceeds its budget", async () => {
  const { source, target } = clients();
  source.buildAgentForkContext.mockResolvedValueOnce({
    attachment: null,
    error: "Source disconnected",
  });
  await expect(forkContextToHost(source, target, input)).rejects.toThrow("Source disconnected");
  await expect(forkContextToHost(source, target, { ...input, maxContextBytes: 2 })).rejects.toThrow(
    "limit",
  );
  expect(target.createWorkspace).not.toHaveBeenCalled();
});
it("surfaces an uncertain target outcome without automatically retrying", async () => {
  const { source, target } = clients();
  target.createWorkspace.mockRejectedValueOnce(new Error("Acknowledgement lost"));
  await expect(forkContextToHost(source, target, input)).rejects.toThrow("Acknowledgement lost");
  expect(target.createWorkspace).toHaveBeenCalledTimes(1);
});
