# Discord shared sessions

FamiliarAgent reuses AI Agent Discord Connector for optional phone access. A channel can follow a Familiar Hub logical session as its active agent or native tool changes, including changes of server.

## Use an existing connector without moving its token

1. Open **Settings → Integrations → Discord · AI Agent Discord Connector**.
2. Select **Use existing connector on a server**, choose its connected SSH server, and enter the absolute path to its existing private `.connect/config.json`.
3. Select **Load Discord channels**. FamiliarAgent reads the bot identity and allowed roles on that server. It does not copy the token or edit the original configuration.
4. Choose a separate channel, or select **Create familiaragent-test channel**. The created channel is visible only to the original allowed roles and the bot, subject to Discord administrator privileges. Creating it requires the bot's **Manage Channels** permission. Original configured main and Claude channels are excluded.
5. Choose **Follow a Familiar Hub session**, then **Add channel binding → Save Discord settings → Connect Discord**.

The original bot remains running. The additional Gateway connection handles only the selected channels and uses exactly the original allowed roles. Do not bind another independently managed channel: the picker excludes the original main/Claude bindings, but cannot discover every external bot integration.

The token is read in place on its original server. Authorized requests and results travel through a bounded SSH connection to the desktop's existing Familiar CLI, so the desktop's server routes retain their meaning. The process exits after a lost desktop connection; reconnect from Settings. FamiliarAgent must remain open and connected. The original connector continues operating independently when FamiliarAgent is closed.

A separate bot token remains supported through **Use a separate bot token**. That token is stored with OS credential encryption; select explicit allowed Discord user IDs.

## In the bound channel

Send an ordinary message to continue the active native agent. Replies, files and native permission requests use the same session as the desktop.

- `!fa help` — available commands and file limits.
- `!fa status`, `!fa context` — native progress and shared context.
- `!fa allow <request-id>`, `!fa deny <request-id>`, `!fa stop` — native controls.
- `!fa file <workspace-relative-path>` — a file from the active native agent's workspace.
- `!fa tools` — available native tool actions on the active server.
- `!fa run <tool> <action> <input>` — run an original tool action using its saved FamiliarAgent settings. Start input with `@<native-id>` when an action needs an existing native item.
- `!fa actions`, `!fa action <run-id>`, `!fa cancel <run-id>` — inspect or cancel a native action belonging to the bound shared session.

Replies use the exact native client message ID. If a provider reload loses that ID, recovery requires a complete bounded history window and exactly one user input validated against the completed native delivery receipt. Partial histories, repeated matching prompts and unknown delivery stay unlinked; the connector directs you to the original session instead of choosing an older answer.

Attachments are limited to 4 MiB per file and 16 MiB per message. Discord delivery IDs are persisted before dispatch; ambiguous deliveries are not automatically retried. Closing the connector cancels its local CLI wait processes, not the underlying native agent session.

## Verification boundary

Automated checks cover source-file permissions, original channel/role isolation, source discovery without credential output, restricted CLI relay requests, temporary input cleanup, dropped-connection cancellation, duplicate-message receipts and concurrent request limits. The actual dedicated-channel setup verifies Discord REST access and a real Gateway ready event. A marked message sent through the signed-in Discord UI also completed Gateway → authorized handler → Mac CLI relay → Ubuntu Codex → Discord, with its durable receipt marked delivered. That first live response exposed a JSON envelope; response formatting now selects assistant text by the exact native client message ID, with a status fallback when attribution is unavailable. Final installed UI validation of the improved formatting remains separate. A bot-authored setup message does not count as a human test.
