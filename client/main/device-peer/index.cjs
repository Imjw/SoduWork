'use strict';
function install(options) {
  let transport;
  const identity = require('./identity.cjs').create({ ...options,
    onChange: () => { transport?.refreshCredentials(); options.onChange?.(); } });
  transport = require('./transport.cjs').create({ ...options, identityOf: identity.identityOf,
    trustedPeers: identity.trustedPeers, rememberPeer: identity.rememberPeer });
  return { ...transport, dispose: async () => { identity.dispose(); await transport.dispose(); } };
}
module.exports = { install, create: require('./transport.cjs').create };
