'use strict';

const SETTLED_TOOLS = new Set(['done', 'completed', 'error', 'failed', 'cancelled', 'canceled']);
const unresolvedTools = snapshot => (snapshot?.tools || []).filter(tool => tool.phase !== 'preparing' && !SETTLED_TOOLS.has(tool.state))
  .map(tool => ({ id: tool.id, callId: tool.callId || tool.id, name: tool.name || '', reason: 'missing-terminal-receipt' }));

module.exports = { unresolvedTools };
