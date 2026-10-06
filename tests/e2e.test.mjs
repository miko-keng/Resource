// End-to-end tests.
//
// Boots the real server against a local stub PayPal so the tests can assert
// precisely which PayPal calls happen and which do not. The sandbox host guard
// stays strict in production; PAYPAL_TEST_MODE is the only thing that relaxes it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasAction } from '../lib/disputes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const stubState = {
  requests: [],
  disputeStatus: 'WAITING_FOR_SELLER_RESPONSE',
  provideEvidence: true,
  verifyStatus: 'SUCCESS',
  captureStatus: 'PENDING',
  listPages: 1,
  reportingStatus: 404,
};

let stubServer;
let stubBase;
let appProcess;
let appBase;
let stateDir;
let appLog = '';

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

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
  });
}

function disputeFixture(id, overrides = {}) {
  return {
    dispute_id: id,
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status: stubState.disputeStatus,
    dispute_life_cycle_stage: 'INQUIRY',
    dispute_amount: { currency_code: 'MYR', value: '10.00' },
    create_time: '2026-10-01T00:00:00Z',
    seller_response_due_date: '2026-10-24T12:40:06Z',
    buyer: { name: 'Test Buyer' },
    disputed_transactions: [{ seller_transaction_id: 'TXN-1', invoice_number: 'RC-10482' }],
    evidences: [{ source: 'REQUESTED_FROM_SELLER', evidence_type: 'PROOF_OF_FULFILLMENT' }],
    links: (() => {
      const links = [{ rel: 'self', href: `${stubBase}/v1/customer/disputes/${id}`, method: 'GET' }];
      if (stubState.provideEvidence) {
        // Underscore, exactly as the live sandbox returns it.
        links.push({ rel: 'provide_evidence', href: `${stubBase}/v1/customer/disputes/${id}/provide-evidence`, method: 'POST' });
      }
      return links;
    })(),
    ...overrides,
  };
}

function startStub() {
  return new Promise((resolve) => {
    stubServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, stubBase || 'http://127.0.0.1');
      const body = await readBody(req);
      stubState.requests.push({ method: req.method, path: url.pathname, search: url.search, body });

      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === '/v1/oauth2/token') return json(200, { access_token: 'stub-token', token_type: 'Bearer' });

      if (url.pathname === '/v1/reporting/transactions') {
        if (stubState.reportingStatus !== 200) return json(stubState.reportingStatus, { name: 'INVALID_RESOURCE_ID' });
        return json(200, { transaction_details: [{ transaction_info: { transaction_id: 'TXN-1', transaction_status: 'PENDING' } }] });
      }

      if (url.pathname.startsWith('/v2/payments/captures/')) {
        return json(200, {
          id: path.basename(url.pathname),
          status: stubState.captureStatus,
          amount: { currency_code: 'MYR', value: '10.00' },
          create_time: '2026-10-01T00:00:00Z',
        });
      }

      if (url.pathname.startsWith('/v2/checkout/orders/')) return json(404, { name: 'INVALID_RESOURCE_ID' });

      if (url.pathname === '/v1/notifications/verify-webhook-signature') {
        return json(200, { verification_status: stubState.verifyStatus });
      }

      if (url.pathname === '/v1/customer/disputes') {
        const page = url.searchParams.get('page');
        if (stubState.listPages > 1 && page !== '2') {
          return json(200, {
            items: [disputeFixture('PP-T-1')],
            links: [{ rel: 'next', href: `${stubBase}/v1/customer/disputes?page=2` }],
          });
        }
        if (stubState.listPages > 1 && page === '2') {
          return json(200, { items: [disputeFixture('PP-T-2', { reason: 'CREDIT_NOT_PROCESSED', evidences: [] })], links: [] });
        }
        return json(200, { items: [disputeFixture('PP-T-1')], links: [] });
      }

      const provide = url.pathname.match(/^\/v1\/customer\/disputes\/([^/]+)\/provide-evidence$/);
      if (provide && req.method === 'POST') {
        stubState.disputeStatus = 'UNDER_REVIEW';
        return json(200, { links: [{ rel: 'self', href: `${stubBase}${url.pathname}` }] });
      }

      const detail = url.pathname.match(/^\/v1\/customer\/disputes\/([^/]+)$/);
      if (detail) {
        const id = decodeURIComponent(detail[1]);
        if (id === 'PP-T-2') return json(200, disputeFixture('PP-T-2', { reason: 'CREDIT_NOT_PROCESSED', evidences: [], disputed_transactions: [] }));
        return json(200, disputeFixture(id));
      }

      return json(404, { name: 'INVALID_RESOURCE_PATH', message: `Stub has no route for ${url.pathname}` });
    });

    stubServer.listen(0, '127.0.0.1', () => {
      stubBase = `http://127.0.0.1:${stubServer.address().port}`;
      resolve();
    });
  });
}

function startApp(port) {
  return new Promise((resolve, reject) => {
    appProcess = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        PAYPAL_MODE: 'sandbox',
        PAYPAL_TEST_MODE: 'true',
        PAYPAL_API_BASE: stubBase,
        PAYPAL_CLIENT_ID: 'stub-client-id',
        PAYPAL_CLIENT_SECRET: 'stub-client-secret',
        PAYPAL_WEBHOOK_ID: 'WH-TEST-1',
        AI_ENABLED: 'false',
        RECOURSE_STATE_DIR: stateDir,
        CACHE_TTL_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    appProcess.stdout.on('data', (chunk) => { appLog += chunk; });
    appProcess.stderr.on('data', (chunk) => { appLog += chunk; });
    appProcess.on('error', reject);
    appProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`server exited ${code}\n${appLog}`));
    });
    appBase = `http://127.0.0.1:${port}`;
    resolve();
  });
}

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${appBase}/api/config`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`server did not start\n${appLog}`);
}

async function api(pathname, options) {
  const response = await fetch(`${appBase}${pathname}`, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

const postJson = (pathname, payload) => api(pathname, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

const evidenceCalls = () => stubState.requests.filter((r) => r.path.endsWith('/provide-evidence'));

async function waitForTriage(eventId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api('/api/events');
    const row = (data.events || []).find((event) => event.id === eventId);
    if (row && (row.triaged || row.processed)) return row;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

before(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'recourse-test-'));
  await startStub();
  const port = await freePort();
  await startApp(port);
  await waitForServer();
});

after(async () => {
  if (appProcess) appProcess.kill('SIGKILL');
  if (stubServer) await new Promise((resolve) => stubServer.close(resolve));
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

/* ------------------------------------------------------- configuration */

test('config reports sandbox mode with the AI engine switched off', async () => {
  const { status, data } = await api('/api/config');
  assert.equal(status, 200);
  assert.equal(data.mode, 'sandbox');
  assert.equal(data.aiEnabled, false, 'AI must be disabled for this run');
  assert.equal(data.aiProvider, 'disabled');
  assert.equal(data.aiModel, null);
  assert.equal(data.webhookConfigured, true);
  assert.ok(data.lifecycleEvents.includes('CUSTOMER.DISPUTE.CREATED'));
  assert.ok(data.lifecycleEvents.includes('CUSTOMER.DISPUTE.RESOLVED'));
});

test('ai-check reports the model as deliberately disabled, not broken', async () => {
  const { status, data } = await api('/api/ai-check');
  assert.equal(status, 200);
  assert.equal(data.ok, false);
  assert.equal(data.code, 'AI_DISABLED');
  assert.equal(data.enabled, false);
});

/* ---------------------------------------------------------------- cases */

test('case list is hydrated with detail fields the list endpoint omits', async () => {
  const { status, data } = await api('/api/cases');
  assert.equal(status, 200);
  assert.equal(data.cases.length, 1);
  const [item] = data.cases;
  assert.equal(item.id, 'PP-T-1');
  assert.equal(item.seller_response_due_date, '2026-10-24T12:40:06Z');
  assert.equal(item.buyer.name, 'Test Buyer');
  // The sandbox really does return the underscore form, and the app must still
  // recognise the action — this is the bug that hid the submit flow.
  assert.ok(item.links.some((link) => link.rel === 'provide_evidence'));
  assert.ok(hasAction(item.links, 'provide-evidence'), 'underscore action name must be recognised');
  assert.ok(!item.detail_error, 'hydration must not have failed');
});

test('case detail resolves the real PayPal transaction and plans the evidence', async () => {
  const { status, data } = await api('/api/cases/PP-T-1');
  assert.equal(status, 200);
  assert.equal(data.source, 'PayPal Sandbox');
  // The reporting API is forced to 404, so this proves the capture fallback ran.
  assert.equal(data.paypalTransaction.status, 'PENDING');
  assert.equal(data.paypalTransaction.resolved_via, '/v2/payments/captures/TXN-1');
  assert.deepEqual(data.plan.allowed, ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND']);
  assert.equal(data.plan.preferred, 'PROOF_OF_FULFILLMENT');
  assert.equal(data.deadline.urgency, 'ok');
  const origins = new Set(data.evidence.map((item) => item.origin));
  assert.ok(origins.has('paypal'), 'evidence must include PayPal-sourced facts');
  assert.ok(origins.has('local'), 'evidence must include the merchant’s own records');
});

/* ------------------------------------------------- approval gate gates */

test('submission without explicit approval is refused and never reaches PayPal', async () => {
  const before = evidenceCalls().length;
  const { status, data } = await postJson('/api/respond', {
    id: 'PP-T-1',
    approved: false,
    responseText: 'Please accept this evidence.',
    evidenceType: 'PROOF_OF_FULFILLMENT',
  });
  assert.equal(status, 400);
  assert.match(data.error, /approval is required/i);
  assert.equal(evidenceCalls().length, before, 'no PayPal call may happen without approval');
});

test('an evidence type PayPal does not accept for the reason is refused', async () => {
  const before = evidenceCalls().length;
  // OTHER is not an accepted type for MERCHANDISE_OR_SERVICE_NOT_RECEIVED.
  const { status, data } = await postJson('/api/respond', {
    id: 'PP-T-1',
    approved: true,
    responseText: 'Our position.',
    evidenceType: 'OTHER',
  });
  assert.equal(status, 409);
  assert.match(data.error, /does not accept OTHER/i);
  assert.equal(evidenceCalls().length, before);
});

test('an evidence type PayPal did not request is refused', async () => {
  const before = evidenceCalls().length;
  const { status, data } = await postJson('/api/respond', {
    id: 'PP-T-1',
    approved: true,
    responseText: 'Refund id REF-1.',
    evidenceType: 'PROOF_OF_REFUND',
    refundId: 'REF-1',
  });
  assert.equal(status, 409);
  assert.match(data.error, /currently requests/i);
  assert.equal(evidenceCalls().length, before);
});

test('an over-length response is refused', async () => {
  const before = evidenceCalls().length;
  const { status, data } = await postJson('/api/respond', {
    id: 'PP-T-1',
    approved: true,
    responseText: 'x'.repeat(2001),
    evidenceType: 'PROOF_OF_FULFILLMENT',
  });
  assert.equal(status, 400);
  assert.match(data.error, /2,000 characters/i);
  assert.equal(evidenceCalls().length, before);
});

test('submission is refused when PayPal exposes no provide-evidence action', async () => {
  stubState.provideEvidence = false;
  const before = evidenceCalls().length;
  const { status, data } = await postJson('/api/respond', {
    id: 'PP-T-1',
    approved: true,
    responseText: 'Evidence.',
    evidenceType: 'PROOF_OF_FULFILLMENT',
  });
  assert.equal(status, 409);
  assert.match(data.error, /does not offer evidence submission/i);
  assert.equal(evidenceCalls().length, before);
  stubState.provideEvidence = true;
});

/* ----------------------------------------------------- real submission */

test('an approved submission reaches PayPal exactly once with the right evidence shape', async () => {
  const before = evidenceCalls().length;
  const { status, data } = await postJson('/api/respond', {
    id: 'PP-T-1',
    approved: true,
    responseText: 'Order ORD-10482 shipped via USPS with tracking 9400111899223856921048.',
    evidenceType: 'PROOF_OF_FULFILLMENT',
  });

  assert.equal(status, 200, JSON.stringify(data));
  const calls = evidenceCalls();
  assert.equal(calls.length, before + 1, 'exactly one PayPal evidence call expected');

  const sent = calls.at(-1).body;
  assert.match(sent, /"evidence_type":"PROOF_OF_FULFILLMENT"/);
  assert.match(sent, /"carrier_name":"USPS"/);
  assert.match(sent, /9400111899223856921048/);
  assert.ok(!sent.includes('[source:'), 'citation markers must never be submitted to PayPal');
  assert.equal(data.dispute.status, 'UNDER_REVIEW');
});

test('a second submission on the same case is refused because the stage moved on', async () => {
  const before = evidenceCalls().length;
  const { status, data } = await postJson('/api/respond', {
    id: 'PP-T-1',
    approved: true,
    responseText: 'Trying again.',
    evidenceType: 'PROOF_OF_FULFILLMENT',
  });
  assert.equal(status, 409);
  assert.equal(evidenceCalls().length, before);
});

/* ------------------------------------------------------------ webhooks */

test('a signed dispute webhook is accepted, stored and auto-triaged', async () => {
  const event = {
    id: 'EVT-TRIAGE-1',
    event_type: 'CUSTOMER.DISPUTE.CREATED',
    create_time: '2026-10-04T00:00:00Z',
    resource: { dispute_id: 'PP-T-1' },
  };
  const response = await fetch(`${appBase}/api/webhooks/paypal`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'paypal-transmission-id': 'tx-1',
      'paypal-transmission-time': '2026-10-04T00:00:00Z',
      'paypal-cert-url': `${stubBase}/cert.pem`,
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig',
    },
    body: JSON.stringify(event),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.verified, true);
  assert.equal(payload.duplicate, false);

  const row = await waitForTriage('EVT-TRIAGE-1');
  assert.ok(row, 'event should have been processed');
  assert.equal(row.triaged, true, `expected triage, event row was ${JSON.stringify(row)}`);
  assert.equal(row.simulated, false, 'a signed event must not be labelled simulated');

  const { data } = await api('/api/packets');
  const packet = data.packets.find((item) => item.disputeId === 'PP-T-1');
  assert.ok(packet, 'triage should have produced a prepared packet');
  assert.equal(packet.trigger, 'webhook:CUSTOMER.DISPUTE.CREATED');
  assert.equal(packet.engine, 'deterministic');
  assert.ok(packet.draft.length > 0);
  assert.equal(packet.grounding.status !== 'review', true, 'prepared draft must be grounded');
});

test('a replayed webhook is idempotent and does not re-triage', async () => {
  const packetsBefore = (await api('/api/packets')).data.packets;
  const before = packetsBefore.find((item) => item.disputeId === 'PP-T-1').preparedAt;

  const event = {
    id: 'EVT-TRIAGE-1',
    event_type: 'CUSTOMER.DISPUTE.CREATED',
    create_time: '2026-10-04T00:00:00Z',
    resource: { dispute_id: 'PP-T-1' },
  };
  const response = await fetch(`${appBase}/api/webhooks/paypal`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'paypal-transmission-id': 'tx-1',
      'paypal-transmission-time': '2026-10-04T00:00:00Z',
      'paypal-cert-url': `${stubBase}/cert.pem`,
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig',
    },
    body: JSON.stringify(event),
  });
  const payload = await response.json();
  assert.equal(payload.duplicate, true, 'PayPal retries delivery; the second must be inert');

  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = (await api('/api/packets')).data.packets.find((item) => item.disputeId === 'PP-T-1').preparedAt;
  assert.equal(after, before, 'a duplicate must not trigger a second triage');
});

test('a webhook whose signature PayPal rejects is discarded', async () => {
  stubState.verifyStatus = 'FAILURE';
  const event = { id: 'EVT-BAD-SIG', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-T-1' } };
  const response = await fetch(`${appBase}/api/webhooks/paypal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'paypal-transmission-id': 'tx-bad' },
    body: JSON.stringify(event),
  });
  assert.equal(response.status, 400);
  const { data } = await api('/api/events');
  assert.ok(!data.events.some((row) => row.id === 'EVT-BAD-SIG'), 'an unverified event must not be stored');
  stubState.verifyStatus = 'SUCCESS';
});

test('a webhook with no transmission headers is refused', async () => {
  const response = await fetch(`${appBase}/api/webhooks/paypal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'EVT-NO-HEADERS', event_type: 'CUSTOMER.DISPUTE.CREATED' }),
  });
  assert.equal(response.status, 400);
});

test('the simulator fires a clearly labelled lifecycle sequence', async () => {
  const { status, data } = await postJson('/api/webhooks/simulate', { sequence: true, disputeId: 'PP-T-1' });
  assert.equal(status, 200);
  assert.equal(data.sequence.length, 3);
  assert.deepEqual(data.sequence.map((step) => step.eventType), [
    'CUSTOMER.DISPUTE.CREATED',
    'CUSTOMER.DISPUTE.UPDATED',
    'CUSTOMER.DISPUTE.RESOLVED',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const { data: events } = await api('/api/events');
  const simulated = events.events.filter((row) => row.id.startsWith('SIM-'));
  assert.ok(simulated.length >= 3);
  assert.ok(simulated.every((row) => row.simulated === true && row.verified === false), 'simulated events must never claim verification');
});

/* ----------------------------------------------------- watchdog + stream */

test('the watchdog reports deadlines with urgency', async () => {
  const { status, data } = await api('/api/watchdog');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.cases));
  assert.ok(data.cases.length >= 1);
  const [first] = data.cases;
  assert.ok(['ok', 'soon', 'urgent', 'overdue', 'unknown'].includes(first.urgency));
  assert.equal(first.disputeId, 'PP-T-1');
});

test('the SSE stream opens and sends an immediate frame', async () => {
  const controller = new AbortController();
  const response = await fetch(`${appBase}/api/events/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !received.includes('event: hello')) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assert.match(received, /event: hello/);
  assert.match(received, /retry: 3000/);
});

/* ------------------------------------------------------------ the rest */

test('the dispute list follows PayPal next-page links', async () => {
  stubState.listPages = 2;
  const { data } = await api('/api/cases');
  const ids = data.cases.map((item) => item.id).sort();
  assert.deepEqual(ids, ['PP-T-1', 'PP-T-2']);
  assert.equal(data.truncated, false);
  assert.equal(data.pages, 2);
  stubState.listPages = 1;
});

test('analysis runs on the deterministic engine and reports AI as off', async () => {
  const { status, data } = await postJson('/api/analyze', { dispute: { id: 'PP-T-1' } });
  assert.equal(status, 200);
  assert.equal(data.engine, 'deterministic');
  assert.equal(data.ai.used, false);
  assert.equal(data.ai.enabled, false);
  assert.equal(data.ai.code, 'AI_DISABLED');
  assert.ok(data.draft.length > 0);
  assert.ok(!data.draft.includes('[source:'), 'drafts must never leak citation markers');
});

test('static file serving refuses path traversal and 404s missing assets', async () => {
  // Encoded so the WHATWG URL parser cannot collapse the dot-segment before the
  // request is sent, which is what a raw client (curl) can actually do. This
  // payload genuinely reaches the server's own path guard.
  const traversal = await fetch(`${appBase}/..%2fserver.mjs`);
  assert.equal(traversal.status, 403, 'traversal must be refused with 403');

  const missing = await fetch(`${appBase}/no-such-asset.css`);
  assert.equal(missing.status, 404, 'a missing asset must be 404, not a server fault');
});

test('unknown API routes return a JSON 404', async () => {
  const { status, data } = await api('/api/does-not-exist');
  assert.equal(status, 404);
  assert.match(data.error, /not found/i);
});

test('the delivery attempt log records what PayPal sent, including rejections', async () => {
  const { status, data } = await api('/api/webhooks/attempts');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.attempts));
  assert.ok(data.max > 0, 'the log must be bounded');
  assert.ok(data.attempts.length > 0, 'at least one delivery should have been recorded');

  const outcomes = data.attempts.map((row) => row.outcome);
  assert.ok(outcomes.includes('accepted'), `expected an accepted delivery, saw ${JSON.stringify(outcomes)}`);
  // Both a rejected signature and a missing-headers delivery were exercised above.
  assert.ok(
    outcomes.includes('signature-rejected') || outcomes.includes('missing-headers'),
    `a refused delivery must be visible, saw ${JSON.stringify(outcomes)}`,
  );
  // Only genuinely bad outcomes may claim to be unverified. A duplicate is a
  // correctly signed event that happened to be a replay, so it stays verified.
  const badOutcomes = ['signature-rejected', 'missing-headers', 'not-configured', 'bad-json'];
  for (const row of data.attempts) {
    if (badOutcomes.includes(row.outcome)) {
      assert.equal(row.verified, false, `${row.outcome} must not claim verification`);
    }
    if (row.outcome === 'accepted' || row.outcome === 'duplicate') {
      assert.equal(row.verified, true, `${row.outcome} should be recorded as signed`);
    }
  }
});

test('a restart resumes an event that was recorded but never processed', async () => {
  // Mirrors a crash — or a platform spinning an idle instance down — between
  // "store the event" and "finish triaging it". Deterministic: the pending row
  // is seeded, so nothing has to be killed mid-flight.
  const dir = mkdtempSync(path.join(tmpdir(), 'recourse-resume-'));
  const payload = {
    id: 'EVT-RESUME-1',
    event_type: 'CUSTOMER.DISPUTE.CREATED',
    create_time: new Date().toISOString(),
    resource: { dispute_id: 'PP-T-1' },
  };
  writeFileSync(path.join(dir, 'events.json'), JSON.stringify([{
    id: payload.id,
    eventType: payload.event_type,
    label: 'Dispute created',
    disputeId: 'PP-T-1',
    receivedAt: new Date().toISOString(),
    simulated: true,
    verified: false,
    processed: false,
    triaged: false,
    error: null,
    payload,
  }]));
  writeFileSync(path.join(dir, 'packets.json'), '[]');

  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PAYPAL_MODE: 'sandbox',
      PAYPAL_TEST_MODE: 'true',
      PAYPAL_API_BASE: stubBase,
      PAYPAL_CLIENT_ID: 'resume-client',
      PAYPAL_CLIENT_SECRET: 'resume-secret',
      AI_ENABLED: 'false',
      RECOURSE_STATE_DIR: dir,
      CACHE_TTL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const resumeBase = `http://127.0.0.1:${port}`;

  try {
    const bootDeadline = Date.now() + 15_000;
    while (Date.now() < bootDeadline) {
      try {
        const response = await fetch(`${resumeBase}/api/config`);
        if (response.ok) break;
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    let packet = null;
    const packetDeadline = Date.now() + 10_000;
    while (Date.now() < packetDeadline && !packet) {
      const data = await fetch(`${resumeBase}/api/packets`).then((r) => r.json()).catch(() => ({ packets: [] }));
      packet = (data.packets || []).find((item) => item.disputeId === 'PP-T-1');
      if (!packet) await new Promise((resolve) => setTimeout(resolve, 150));
    }

    assert.ok(packet, 'a stranded event must be triaged after restart, not left pending forever');
    assert.equal(packet.partial, undefined, 'the resume should reach PayPal, not fall back to the event payload');
    assert.ok(packet.draft.length > 0, 'the packet should carry a real draft');
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
