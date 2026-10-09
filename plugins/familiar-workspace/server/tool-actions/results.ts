import type { ResultAnchor } from "../../shared/results.js";
import type { ResourceReader } from "../composition/store.js";
import { textDigest } from "../composition/result-text.js";
import type { ToolRunStore } from "./store.js";

export function captureToolResult(
  store: ToolRunStore,
  id: string,
): { anchor: ResultAnchor; text: string } {
  const run = store.read(id);
  if (!run.result || run.state !== "completed" || !run.result.text.trim())
    throw new Error(
      "Select a completed native result. A submission receipt is not a completed result.",
    );
  const digest = textDigest(run.result.text);
  if (digest.sha256 !== run.resultSha256)
    throw new Error("Stored native result failed its integrity check");
  return {
    text: run.result.text,
    anchor: {
      resource: {
        id: `tool-${run.id}`,
        kind: "history",
        label: `${run.request.toolId}: ${run.request.action}`,
        serverId: run.serverId,
        format: "tool-result",
        locator: run.id,
        readOnly: true,
        boundary: {
          kind: "tool",
          toolId: run.request.toolId,
          cwd: run.request.cwd,
          sessionId: run.request.sessionId,
          sha256: digest.sha256,
        },
      },
      selection: { ...digest, segments: [{ ...digest, ordinal: 0 }] },
    },
  };
}
export function toolResultReader(store: ToolRunStore): ResourceReader {
  return async (resource, input) => {
    const captured = captureToolResult(store, resource.locator);
    const expected = captured.anchor.resource;
    if (
      resource.serverId !== expected.serverId ||
      resource.format !== "tool-result" ||
      resource.boundary?.kind !== "tool" ||
      expected.boundary?.kind !== "tool" ||
      resource.boundary.toolId !== expected.boundary.toolId ||
      resource.boundary.cwd !== expected.boundary.cwd ||
      resource.boundary.sessionId !== expected.boundary.sessionId ||
      resource.boundary.sha256 !== expected.boundary.sha256
    )
      throw new Error("Native tool result reference no longer matches its source");
    if (
      input.selection &&
      (input.selection.segments.length !== 1 || input.selection.segments[0]!.ordinal !== 0)
    )
      throw new Error("Native tool result selection is invalid");
    return {
      messages: input.offset ? [] : [{ role: "assistant", text: captured.text }],
      nextOffset: null,
      boundary: expected.boundary,
    };
  };
}
