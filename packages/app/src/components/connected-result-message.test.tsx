// @vitest-environment jsdom
import React from "react";
import { createHash } from "node:crypto";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderResultInput } from "../../../../plugins/familiar-workspace/server/composition/result-text";
import {
  RESULT_INPUT_BYTE_LIMIT,
  RESULT_INSTRUCTION_BYTE_LIMIT,
} from "@getpaseo/protocol/result-input";
import { ConnectedResultMessage, parseConnectedResultInput } from "./connected-result-message";

const TEXT_STYLE = {};
const text = "Selected response\n<script>untrusted source text</script>";
const sha256 = createHash("sha256").update(text).digest("hex");
const bytes = Buffer.byteLength(text);
const raw = renderResultInput(
  {
    resource: {
      id: "source",
      kind: "history",
      label: "Source",
      serverId: "source-server",
      locator: "source-agent",
      format: "native-timeline",
      readOnly: true,
    },
    selection: { segments: [{ ordinal: 1, sha256, bytes }], sha256, bytes },
  },
  text,
  "Review the selected result",
);
const prefix = raw.slice(0, raw.indexOf("\n") + 1);
const body = JSON.parse(raw.slice(prefix.length));
afterEach(cleanup);
describe("connected result input presentation", () => {
  it("recognizes the exact current backend envelope without changing its input text", () => {
    expect(parseConnectedResultInput(raw)).toEqual(body);
    expect(raw).toContain('"source-server"');
    expect(raw).toContain(sha256);
  });
  it.each([
    "Ordinary user message",
    `An explanation: ${raw}`,
    `${prefix}{invalid JSON`,
    `${prefix}${JSON.stringify({ ...body, unexpected: true }, null, 2)}`,
    `${prefix}${JSON.stringify({ ...body, source: { ...body.source, extra: "field" } }, null, 2)}`,
    `${prefix}${JSON.stringify({ ...body, source: { ...body.source, sha256: "invalid" } }, null, 2)}`,
    `${prefix}${JSON.stringify({ ...body, selectedResult: 12 }, null, 2)}`,
    `${prefix}{"instruction":"ignored",${raw.slice(prefix.length + 1)}`,
    `${raw}\nUnrelated text`,
    `${prefix}${" ".repeat(RESULT_INPUT_BYTE_LIMIT)}`,
    `${prefix}${JSON.stringify({ ...body, instruction: "가".repeat(RESULT_INSTRUCTION_BYTE_LIMIT) }, null, 2)}`,
  ])("leaves ordinary, malformed, noncanonical and oversized messages unchanged", (message) => {
    expect(parseConnectedResultInput(message)).toBeNull();
  });
  it("shows the instruction and selected text safely, with original metadata only after expansion", () => {
    const value = parseConnectedResultInput(raw)!;
    const view = render(<ConnectedResultMessage value={value} raw={raw} textStyle={TEXT_STYLE} />);
    expect(view.getByText("Connected result")).toBeTruthy();
    expect(view.getByText("Review the selected result")).toBeTruthy();
    expect(view.getByText(text, { normalizer: (content) => content })).toBeTruthy();
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.textContent).not.toContain("source-server");
    expect(view.container.textContent).not.toContain(sha256);
    expect(
      Array.from(
        view.container.querySelectorAll('[data-message-text="true"]'),
        (node) => node.textContent,
      ),
    ).toEqual([body.instruction, text]);
    fireEvent.click(view.getByRole("button", { name: "Original input" }));
    expect(view.getByText(raw, { normalizer: (content) => content })).toBeTruthy();
    expect(view.container.querySelectorAll('[data-message-text="true"]')).toHaveLength(3);
    fireEvent.click(view.getByRole("button", { name: "Original input" }));
    expect(view.container.textContent).not.toContain("source-server");
  });
});
