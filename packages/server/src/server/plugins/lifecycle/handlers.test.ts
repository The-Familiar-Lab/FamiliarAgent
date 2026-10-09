import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.before("workspace.create", () => {
    return;
  });
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "before", "workspace.create", input, paseo)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", async (_input, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Hook aborted"));
        },
        { once: true },
      );
    });
  });
  const invocation = hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual({ events: [], before: [] });
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.session_open",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
      },
      paseo,
    ),
  ).rejects.toThrow("agent.session_open hooks can only change env");
});

test("agent creation labels survive legacy transforms and remain caller-owned across hooks", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const labels = { familiarAdvisor: "true", source: "original" };
  hooks.before("agent.create", ({ request }) => {
    expect(request.labels).toEqual(labels);
    return { config: { ...request.config, title: "Transformed" }, env: request.env };
  });
  hooks.before("agent.create", ({ request }) => {
    expect(request.labels).toEqual(labels);
    return { ...request, labels: { source: "original", familiarAdvisor: "true" } };
  });
  expect(
    await hooks.invoke(
      "metadata",
      "before",
      "agent.create",
      { config: { provider: "codex", cwd: "/project" }, labels },
      paseo,
    ),
  ).toMatchObject({ config: { title: "Transformed" }, labels });
  expect(labels).toEqual({ familiarAdvisor: "true", source: "original" });
});

test.each([{}, { familiarAdvisor: "true" }, { owner: "changed" }])(
  "agent creation hooks reject changed labels %j before later hooks run",
  async (changed) => {
    const hooks = new PluginHookHandlers(() => {});
    let laterRan = false;
    hooks.before("agent.create", ({ request }) => ({ ...request, labels: changed }));
    hooks.before("agent.create", () => {
      laterRan = true;
    });
    await expect(
      hooks.invoke(
        "changed-metadata",
        "before",
        "agent.create",
        { config: { provider: "codex", cwd: "/project" }, labels: { owner: "original" } },
        paseo,
      ),
    ).rejects.toThrow("cannot change caller labels");
    expect(laterRan).toBe(false);
  },
);
