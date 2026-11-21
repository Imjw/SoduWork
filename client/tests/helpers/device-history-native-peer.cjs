'use strict';

// Each invocation is a fresh process using only the supplied synthetic root.
const fs = require('node:fs'), path = require('node:path');
async function main() {
  const [root, endpoint, phase] = process.argv.slice(2), accountPhase = phase.startsWith('account-');
  const cwd = path.join(root, phase === 'source' || accountPhase ? 'workspace' : 'recovered-workspace');
  const agentDir = path.join(root, 'pi-agent'), app = { getPath: () => root };
  const identity = require('./platform-session-fixture.cjs').identity(phase.startsWith('account-b') ? 'two' : 'one');
  require('../../main/conversation/requirement-context').cachedIdentity = () => identity;
  fs.mkdirSync(cwd, { recursive: true });
  if (phase === 'source') fs.writeFileSync(path.join(cwd, 'checkpoint.txt'), 'TOOL-RECEIPT-BETA-482: completed validation, preserve this result.');
  fs.mkdirSync(path.join(agentDir, 'sessions', 'fixture'), { recursive: true });
  const sdk = await import('../../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const model = { id: 'fixture', baseUrl: endpoint, key: 'synthetic-provider-' + (phase.startsWith('account-b') ? 'two' : 'one'), contextWindow: 32000 };
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(root, 'auth.json'),
    modelsStorePath: path.join(root, 'models.db') });
  runtime.registerProvider('soduwork', require('../../main/conversation/model-selection').piProvider(model));
  require('../../main/pi-session/model-config').prepare = async (_app, selectedIdentity) => {
    const { scope } = require('../../main/platform-connections/runtime.cjs');
    require('node:assert/strict').equal(scope(selectedIdentity), scope(identity),
      'The production native opener must resolve model credentials for the current execution account');
    return { ok: true, agentDir, provider: 'soduwork', model };
  };
  let toolExecutions = 0;
  require('../../main/pi-session/sdk-loader').load = async () => ({ ...sdk, ModelRuntime: { create: async () => runtime },
    createAgentSession: args => sdk.createAgentSession({ ...args,
      customTools: (args.customTools || []).map(tool => tool.name !== 'read' ? tool : { ...tool,
        execute(...values) { toolExecutions++; return tool.execute.apply(this, values); } }),
      sessionManager: args.sessionManager || sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions', 'fixture')) }) });
  const resources = require('../../main/pi-session/session-resources'), loadResources = resources.sessionResources;
  resources.sessionResources = async (...args) => {
    const value = await loadResources(...args);
    value.settingsManager.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: ['read'] });
    return value;
  };
  const driver = require('../../main/pi-session/session');
  const bridge = require('../../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app, sessionModule: driver, runnerAdapters: [] });
  const store = require('../../main/conversation/replica-store.cjs').create(path.join(root, 'history.sqlite'));
  const history = require('../../main/conversation/shared-history.cjs').create({ app, session: bridge, store, identityOf: () => identity });
  bridge.setReplicaHistory(history);
  const options = { app, identity, cwd, ref: phase + '-window', noExtensions: true,
    accessPolicy: require('../../main/access-control/policy').create('readonly', cwd) };
  let handle, result;
  try {
    if (phase === 'source') {
      const opened = await bridge.open(options);
      if (!opened.ok) throw Error(opened.reason);
      handle = opened.session;
      require('../../main/conversation/session-memory').bind(app, handle.sessionId, identity, [], true);
      history.observe(handle, identity);
      const sent = await handle.submit('Remember the synthetic recovery phrase ALPHA-DEVICE-731. Read checkpoint.txt once and retain its completed validation result.').completion;
      if (!sent.ok) throw Error(sent.reason);
      await history.capture(handle, identity);
      await history.backfill(handle.sessionId);
      const nativePath = handle.resumeLocation();
      result = { id: handle.sessionId, nativeId: handle.sessionId, nativePath };
      fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(result));
    } else {
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'receipt.json'), 'utf8'));
      const view = await history.open(saved.id);
      const restoredText = view.snapshot().messages.map(message => message.text).join('\n'); await view.close();
      const row = await history.resolve(saved.id);
      const continuation = require('../../main/conversation/device-local-continuation.cjs');
      const grant = accountPhase ? continuation.grant(app, row, identity) : null;
      const recovery = grant ? { recovery: await continuation.prepare(grant, history, identity, bridge) }
        : await require('../../main/conversation/native-history-opening.cjs').resolve({ app, session: bridge, history, row });
      const opened = await bridge.open({ ...options, ...(grant ? { deviceContinuationGrant: grant } : {}),
        ...((phase === 'reopen' || grant && !recovery.recovery) ? { runtimeConversationId: saved.id }
          : { deviceHistoryRecovery: recovery.recovery }) });
      if (!opened.ok) throw Error(opened.reason);
      handle = opened.session;
      history.observe(handle, identity);
      const sent = await handle.submit('Continue from the saved validation result without reading the old file again. Which synthetic phrase did we retain?' +
        (accountPhase ? ' Account follow-up ' + phase + '.' : '')).completion;
      if (!sent.ok) throw Error(sent.reason);
      result = { id: handle.sessionId, restoredText,
        nativeId: require('../../main/conversation/runtime-segments').read(app, saved.id).active.sessionId,
        historyRecovery: handle.snapshot().historyRecovery };
      if (grant) {
        const record = require('../../main/conversation/runtime-segments').read(app, saved.id);
        result.owner = record.owner; result.executionOwner = record.executionOwner;
        result.creator = (await history.resolve(saved.id)).creator;
        result.bindings = fs.readdirSync(path.join(root, 'session-memory-bindings')).length;
        require('node:assert/strict').throws(() => handle.bindTask('private-task'), /私有资料/);
      }
    }
  } finally {
    if (handle) await handle.close();
    await history.close(); await bridge.dispose();
  }
  process.stdout.write('DEVICE_HISTORY_RESULT ' + JSON.stringify({ ...result, toolExecutions, cwd }) + '\n');
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
