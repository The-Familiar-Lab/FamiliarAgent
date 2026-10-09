import { basename } from "node:path";
import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import {
  endpoint,
  integer,
  jsonRequest,
  nativeId,
  parameter,
  record,
  result,
  tokenFile,
} from "./common.js";

const connection = [
  { key: "url", label: "Codeg server URL", required: true },
  {
    key: "tokenFile",
    label: "Server token file",
    required: true,
    description: "Private text file on this server; the token is read only when calling Codeg.",
  },
];

export const codegAdapter: ToolActionAdapter = {
  id: "codeg",
  actions: [
    {
      id: "list",
      mutates: false,
      label: "List Codeg conversations",
      description: "Read the original server's conversation catalog.",
      parameters: connection,
    },
    {
      id: "create",
      label: "Create Codeg conversation",
      description:
        "Register this existing folder and create a native conversation without starting a model.",
      parameters: [...connection, { key: "agentType", label: "Codeg agent type", required: true }],
    },
    {
      id: "read",
      mutates: false,
      label: "Read Codeg conversation",
      description: "Read the last bounded turns from Codeg's original conversation.",
      nativeId: true,
      parameters: [...connection, { key: "turns", label: "Recent turns" }],
    },
    {
      id: "send",
      label: "Send input to Codeg",
      description:
        "Resume or connect this native conversation using Codeg ACP, then send once. Install and sign in to its agent in Codeg first.",
      input: true,
      inputMode: "prompt",
      nativeId: true,
      parameters: connection,
    },
  ],
  async execute(request, context) {
    const url = parameter(request, "url");
    const token = await tokenFile(parameter(request, "tokenFile"));
    const call = (path: string, body: unknown) =>
      jsonRequest(context, {
        url: endpoint(url, `/api${path}`),
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
    if (request.action === "list")
      return result(await call("/list_all_conversations", { includeChildren: true }));
    if (request.action === "create") {
      const folder = record(await call("/open_folder", { path: request.cwd }));
      if (!Number.isInteger(folder.id)) throw new Error("Codeg did not return a folder ID.");
      const id = await call("/create_conversation", {
        folderId: folder.id,
        agentType: parameter(request, "agentType"),
        title: basename(request.cwd),
      });
      if (!Number.isInteger(id)) throw new Error("Codeg did not return a conversation ID.");
      return result({ conversationId: id, folderId: folder.id }, "completed", String(id));
    }
    const id = integer(nativeId(request), 0, Number.MAX_SAFE_INTEGER);
    if (request.action === "read")
      return result(
        await call("/get_folder_conversation", {
          conversationId: id,
          tailTurns: integer(request.parameters.turns, 10, 100),
        }),
        "completed",
        String(id),
      );
    if (request.action === "send") {
      const conversation = record(
        await call("/get_folder_conversation", { conversationId: id, tailTurns: 1 }),
      );
      const summary = record(conversation.summary);
      if (!Number.isInteger(summary.folder_id) || typeof summary.agent_type !== "string")
        throw new Error("Codeg conversation has no native folder or agent type.");
      const existing = await call("/acp_find_connection_for_conversation", {
        conversationId: id,
        agentType: summary.agent_type,
        sessionId: typeof summary.external_id === "string" ? summary.external_id : null,
      });
      let connectionId: unknown = existing ? record(existing).connection_id : null;
      if (!connectionId) {
        const folder = record(await call("/get_folder", { folderId: summary.folder_id }));
        if (typeof folder.path !== "string") throw new Error("Codeg folder path is unavailable.");
        connectionId = await call("/acp_connect", {
          agentType: summary.agent_type,
          workingDir: folder.path,
          sessionId: typeof summary.external_id === "string" ? summary.external_id : null,
        });
      }
      if (typeof connectionId !== "string")
        throw new Error("Codeg did not return an ACP connection.");
      await call("/acp_prompt", {
        connectionId,
        folderId: summary.folder_id,
        conversationId: id,
        blocks: [{ type: "text", text: request.input }],
      });
      return result(
        "Codeg accepted the prompt request. Read the conversation to check the native agent's progress; this acknowledgement is not completion.",
        "submitted",
        String(id),
      );
    }
    throw new Error("Unknown Codeg action.");
  },
};
