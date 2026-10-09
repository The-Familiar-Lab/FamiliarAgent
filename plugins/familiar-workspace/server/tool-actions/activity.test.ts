import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ToolRunStore } from "./store.js";

test("activity metadata preserves submitted/unknown semantics without loading result bodies or request settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tool-activity-"));
  const store = new ToolRunStore(directory, "mac");
  try {
    for (const state of ["running", "completed", "submitted", "failed", "unknown"] as const) {
      store.create(
        state,
        {
          sessionId: "logical",
          toolId: "agents",
          action: "run",
          cwd: "/project",
          input: "PRIVATE_INPUT",
          nativeId: "PRIVATE_NATIVE_ID",
          parameters: { address: "PRIVATE_SETTING" },
        },
        false,
      );
      if (state !== "running")
        store.finish(
          state === "completed" ? "completed" : state,
          state,
          state === "completed" || state === "submitted"
            ? { state, text: `PRIVATE_OUTPUT ${"x".repeat(80 * 1024)}` }
            : null,
          state === "failed" ? "PRIVATE_ERROR" : null,
        );
    }
    store.create(
      "other",
      {
        sessionId: "other-session",
        toolId: "agents",
        action: "run",
        cwd: "/elsewhere",
        input: "",
        parameters: {},
      },
      false,
    );
    const listed = store.listActivity("logical", 0, 50);
    expect(listed.total).toBe(5);
    expect(listed.runs.map((row) => row.state).sort()).toEqual([
      "completed",
      "failed",
      "running",
      "submitted",
      "unknown",
    ]);
    expect(listed.runs.find((row) => row.state === "submitted")).toMatchObject({
      hasResult: true,
      cwd: "/project",
    });
    expect(listed.runs.find((row) => row.state === "unknown")?.hasResult).toBe(false);
    expect(JSON.stringify(listed)).not.toContain("PRIVATE_");
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(2000);
    expect(store.listActivity("logical", 1, 2)).toEqual({
      runs: listed.runs.slice(1, 3),
      total: 5,
    });
    expect(store.listActivity("missing", 0, 20)).toEqual({ runs: [], total: 0 });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
