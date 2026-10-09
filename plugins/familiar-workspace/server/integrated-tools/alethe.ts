import type { ToolActionAdapter, ToolActionRequest } from "../tool-actions/contracts.js";
import { endpoint, integer, jsonRequest, parameter, record, result, tokenFile } from "./common.js";

const connection = [
  {
    key: "url",
    label: "Alethe MCP URL",
    required: true,
    description: "The original running app's /mcp URL.",
  },
  { key: "tokenFile", label: "Alethe token file", required: true },
  { key: "planner", label: "Native planner ID", required: true },
];

function delegation(request: ToolActionRequest) {
  if (request.parameters.readOnly && !["true", "false"].includes(request.parameters.readOnly))
    throw new Error("Read only must be true or false.");
  return {
    tasks: [request.input],
    cwd: request.cwd,
    agent: "codex",
    ...(request.parameters.readOnly ? { readOnly: request.parameters.readOnly === "true" } : {}),
    timeoutSeconds: integer(request.parameters.timeoutSeconds, 120, 900),
    ...(request.parameters.model ? { model: request.parameters.model } : {}),
  };
}

export const aletheAdapter: ToolActionAdapter = {
  id: "alethe",
  actions: [
    {
      id: "status",
      mutates: false,
      label: "Read Alethe status",
      description: "Read workers and roles from Alethe's original MCP server.",
      parameters: connection,
    },
    {
      id: "delegate",
      label: "Delegate to Alethe",
      description:
        "Submit one task to the native Codex worker queue. Native permission settings apply; the app retains orchestration.",
      input: true,
      inputMode: "prompt",
      parameters: [
        ...connection,
        { key: "readOnly", label: "Read only (optional true/false)" },
        { key: "model", label: "Codex model" },
        { key: "timeoutSeconds", label: "Worker time limit (seconds)" },
      ],
    },
    {
      id: "check",
      label: "Read Alethe results",
      description:
        "Read native deliveries using Alethe's delivery semantics; older versions consume delivered items.",
      parameters: connection,
    },
    {
      id: "run",
      label: "Run standalone Alethe",
      description:
        "Run the original standalone MCP binary and collect its bounded Codex worker result. This separate native process does not join the desktop app's queue.",
      input: true,
      inputMode: "prompt",
      parameters: [
        { key: "command", label: "Alethe MCP executable", required: true },
        { key: "codexCommand", label: "Codex executable", required: true },
        { key: "model", label: "Codex model" },
        { key: "readOnly", label: "Read only (optional true/false)" },
      ],
    },
  ],
  async execute(request, context) {
    if (request.action === "run") {
      const command = await context.resolveCommand(parameter(request, "command"));
      const codex = await context.resolveCommand(parameter(request, "codexCommand"));
      const schemaResponse = await context.exec({
        command,
        args: [],
        cwd: request.cwd,
        env: { ALETHE_CODEX: codex },
        stdin: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }) + "\n",
      });
      if (schemaResponse.exitCode !== 0)
        throw new Error("Cannot read Alethe's native tool schema.");
      const schema = record(JSON.parse(schemaResponse.stdout));
      verifyDelegationSchema(schema, request);
      const bodies = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "alethe_delegate",
            arguments: { ...delegation(request), timeoutSeconds: 120 },
          },
        },
        ...[2, 3, 4, 5].map((id) => ({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "alethe_check",
            arguments: { wait: true, untilAllSettled: true, timeoutMs: 45000 },
          },
        })),
      ];
      const response = await context.exec({
        command,
        args: [],
        cwd: request.cwd,
        env: { ALETHE_CODEX: codex },
        stdin: `${bodies.map((body) => JSON.stringify(body)).join("\n")}\n`,
        timeoutMs: 190000,
      });
      if (response.exitCode !== 0)
        throw new Error(`Alethe exited with ${response.exitCode}: ${response.stderr}`);
      const replies = response.stdout
        .trim()
        .split("\n")
        .map((line) => record(JSON.parse(line)));
      if (
        replies.length !== bodies.length ||
        replies.some((reply) => reply.error || record(reply.result).isError === true)
      )
        throw new Error(`Alethe did not complete the requested native calls: ${response.stdout}`);
      const payloads = replies.flatMap((reply) => {
        const content = record(reply.result).content;
        return Array.isArray(content)
          ? content
              .filter((part) => part.type === "text")
              .map((part) => record(JSON.parse(part.text)))
          : [];
      });
      const deliveries = payloads.flatMap((payload) =>
        Array.isArray(payload.deliveries) ? payload.deliveries : [],
      );
      const completed = deliveries.find((delivery) => delivery.type === "worker_done");
      if (!completed || completed.outcome !== "succeeded")
        throw new Error(
          "Alethe's native worker did not report success. " + JSON.stringify(deliveries),
        );
      return result(replies);
    }
    const names: Record<string, string> = {
      status: "alethe_status",
      delegate: "alethe_delegate",
      check: "alethe_check",
    };
    const name = names[request.action];
    if (!name) throw new Error("Unknown Alethe action.");
    const url = endpoint(parameter(request, "url"), "").replace(/\/$/, "");
    const headers = {
      "X-Alethe-Token": await tokenFile(parameter(request, "tokenFile")),
      "X-Alethe-Planner": parameter(request, "planner"),
    };
    if (request.action === "delegate")
      verifyDelegationSchema(
        record(
          await jsonRequest(context, {
            url,
            method: "POST",
            headers,
            body: { jsonrpc: "2.0", id: 0, method: "tools/list" },
          }),
        ),
        request,
      );
    const response = record(
      await jsonRequest(context, {
        url,
        method: "POST",
        headers,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: request.action === "delegate" ? delegation(request) : { wait: false },
          },
        },
      }),
    );
    if (response.error || record(response.result).isError === true)
      throw new Error(`Alethe rejected the call: ${JSON.stringify(response)}`);
    return result(response.result, request.action === "delegate" ? "submitted" : "completed");
  },
};

function verifyDelegationSchema(response: Record<string, unknown>, request: ToolActionRequest) {
  const tools = record(response.result).tools;
  if (!Array.isArray(tools)) throw new Error("Alethe returned no native tool catalog.");
  const delegate = tools.map(record).find((tool) => tool.name === "alethe_delegate");
  if (!delegate) throw new Error("This Alethe runtime cannot delegate.");
  const properties = record(record(delegate.inputSchema).properties);
  for (const field of ["readOnly", "model"])
    if (request.parameters[field] && !Object.hasOwn(properties, field))
      throw new Error(
        `This installed Alethe version does not support ${field}. Update the original runtime or leave that option unset.`,
      );
}
