import { expect, test } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDaemonTestContext } from "../test-utils/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { forkContextToHost } from "../../../../cli/src/commands/agent/fork.js";

test("forks native context between isolated daemons/providers and deduplicates an explicit retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-fork-"));
  const sourceCwd = path.join(directory, "source");
  const targetCwd = path.join(directory, "target");
  await mkdir(sourceCwd);
  await mkdir(targetCwd);
  const source = await createDaemonTestContext();
  const prompts: unknown[] = [];
  const target = await createDaemonTestContext({
    agentClients: createTestAgentClients({ onStartTurn: (prompt) => prompts.push(prompt) }),
  });
  try {
    const agent = await source.client.createAgent({
      provider: "codex",
      cwd: sourceCwd,
      initialPrompt: "Remember FORK_CONTEXT_MARKER_42",
      clientMessageId: "source-initial-message",
      title: "Source conversation",
    });
    await expect
      .poll(async () => (await source.client.fetchAgent(agent.id))?.agent.status)
      .toBe("idle");
    const input = {
      sourceId: agent.id,
      sourceHost: "source-host",
      targetHost: "target-host",
      cwd: targetCwd,
      prompt: "Continue from the shared conversation",
      provider: "claude",
      operationId: "stable-cross-host-operation",
    };
    const fork = await forkContextToHost(source.client, target.client, input);
    expect(fork.provider).toBe("claude");
    await expect.poll(() => prompts.length).toBe(1);
    expect(JSON.stringify(prompts[0])).toContain("FORK_CONTEXT_MARKER_42");
    expect(JSON.stringify(prompts[0])).toContain("source-host");
    expect((await target.client.fetchAgent(fork.agentId))?.agent.cwd).toBe(targetCwd);
    const retry = await forkContextToHost(source.client, target.client, input);
    expect(retry.agentId).toBe(fork.agentId);
    expect(prompts).toEqual([prompts[0]]);
    expect((await source.client.fetchAgent(agent.id))?.agent.cwd).toBe(sourceCwd);
  } finally {
    await Promise.all([source.cleanup(), target.cleanup()]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
