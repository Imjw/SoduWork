'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
let cached;
function certificates() {
  if (cached) return cached;
  const backend = path.resolve(__dirname, '../../../hub-backend');
  const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) throw Error('Set SODUWORK_TEST_PYTHON to the isolated backend test interpreter');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-peer-certs-'));
  try {
    const file = path.join(root, 'certificates.json');
    const result = spawnSync(python, ['-m', 'tests.device_peer_fixture', file], { cwd: backend, encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw Error('Peer fixture failed: ' + (result.error?.message || result.stderr));
    return cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { certificates };
