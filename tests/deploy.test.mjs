// Deployment-mode tests: bind address and the read-only demo guard.
//
// These run entirely in fixture mode, so they need no PayPal stub and no
// credentials — exactly the shape of a hosted demo.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let process_;
let base;
let stateDir;
let log = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/config`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`server did not start\n${log}`);
}

async function api(pathname, options) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

before(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'recourse-readonly-'));
  const port = await freePort();
  // HOST=0.0.0.0 is what a PaaS requires. Reaching it over 127.0.0.1 proves the
  // process bound to all interfaces rather than loopback only.
  process_ = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '0.0.0.0',
      PAYPAL_MODE: 'fixture',
      AI_ENABLED: 'false',
      DEMO_READONLY: 'true',
      RECOURSE_STATE_DIR: stateDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process_.stdout.on('data', (chunk) => { log += chunk; });
  process_.stderr.on('data', (chunk) => { log += chunk; });
  base = `http://127.0.0.1:${port}`;
  await waitForServer();
});

after(async () => {
  if (process_) process_.kill('SIGKILL');
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

test('the server binds where a platform router can reach it', async () => {
  const { status } = await api('/');
  assert.equal(status, 200, `expected the app to be reachable, log was:\n${log}`);
  assert.match(log, /http:\/\/0\.0\.0\.0:\d+/, 'startup log should show the real bind address');
  assert.match(log, /READ-ONLY demo/, 'startup log should announce read-only mode');
});

test('config advertises read-only mode so the UI can adapt', async () => {
  const { status, data } = await api('/api/config');
  assert.equal(status, 200);
  assert.equal(data.readOnly, true);
  assert.equal(data.aiEnabled, false);
});

test('the demo still shows live data — read-only does not mean empty', async () => {
  const { status, data } = await api('/api/cases');
  assert.equal(status, 200);
  assert.ok(data.cases.length >= 1, 'the hosted demo must still present cases');
});

test('filing evidence on a read-only demo is refused before anything reaches PayPal', async () => {
  const { status, data } = await api('/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'PP-D-REC-2048',
      approved: true,
      responseText: 'Attempting to file evidence on the shared demo.',
      evidenceType: 'PROOF_OF_FULFILLMENT',
    }),
  });
  assert.equal(status, 409);
  assert.match(data.error, /read-only/i);

  // The refusal must not leave a "response recorded" trace behind.
  const { data: after } = await api('/api/cases');
  const target = after.cases.find((item) => item.id === 'PP-D-REC-2048');
  assert.equal(target.status, 'WAITING_FOR_SELLER_RESPONSE', 'a refused submission must not change case state');
});

test('read-only is enforced even without approval, so it cannot be bypassed by ordering', async () => {
  const { status, data } = await api('/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'PP-D-REC-2048', approved: false, responseText: '', evidenceType: 'OTHER' }),
  });
  assert.equal(status, 409);
  assert.match(data.error, /read-only/i);
});
