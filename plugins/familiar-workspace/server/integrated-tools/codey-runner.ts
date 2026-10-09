/** This bridge calls Codey's original public gateway methods; it contains no agent loop. */
export const CODEY_RUNNER = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const { Codey } = require(path.join(request.moduleRoot, 'packages/gateway/dist/gateway.js'));
  const { ConfigManager } = require(path.join(request.moduleRoot, 'packages/gateway/dist/config.js'));
  const config = new ConfigManager(path.join(request.dataRoot, 'gateway.json'));
  const value = config.get();
  const gateway = new Codey({port: 0, defaultAgent: request.agent, agents: value.agents, models: value.models, fallback: value.fallback, channels: {}, automationRole: 'embedded'}, undefined, path.join(request.dataRoot, 'workspaces'), config);
  try {
    let output;
    if (request.action === 'list') {
      output = (await gateway.listChats()).map(({id,title,workspaceName,agent,model}) => ({id,title,workspaceName,agent,model}));
    } else if (request.action === 'read') {
      const chat = await gateway.getChat(request.nativeId);
      output = {...chat, messages: chat.messages.slice(-request.limit)};
    } else {
      await gateway.getWorkspaceManager().load();
      const workspaceName = await gateway.getWorkspaceManager().findOrCreateByDir(request.cwd);
      const chat = request.nativeId ? await gateway.getChat(request.nativeId) : await gateway.createChat({workspaceName, title: 'FamiliarAgent input', agent: request.agent, model: request.model});
      if (chat.workspaceName !== workspaceName) throw Error('The Codey chat belongs to a different project folder.');
      output = await gateway.sendToChat(chat.id, request.input, () => {});
    }
    process.stdout.write('\nFAMILIAR_CODEY_RESULT=' + JSON.stringify(output) + '\n');
  } finally {
    await gateway.stop();
    config.stop();
  }
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
`;
