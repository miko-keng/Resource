import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiConfig, aiConfigured, aiHealthCheck, generateJSON } from './lib/ai.mjs';
import {
  allowedEvidenceTypes,
  buildEvidence,
  buildEvidenceEntry,
  deadlineInfo,
  deterministicDraft,
  deterministicMissing,
  evidencePlan,
  findAction,
  hasAction,
  moneyLabel,
  normalizeRel,
  reasonLabel,
  stripCitations,
  verifyClaims,
} from './lib/disputes.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const PORT = Number(process.env.PORT || 3000);
const MODE = (process.env.PAYPAL_MODE || 'fixture').toLowerCase();
const API_BASE = (process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
const AI_PROVIDER_LABEL = (process.env.AI_PROVIDER || 'none').toLowerCase();

/**
 * AI is switched off for now. The deterministic path is the product: PayPal
 * dispute connectivity, evidence planning, and the approval gate. The model
 * code is deliberately kept in place (see `analyzeWithModel`) but is not
 * reachable while this flag is false, so the app makes no AI calls at all.
 * Flip AI_ENABLED=true to reinstate it — nothing else needs to change.
 */
const AI_ENABLED = String(process.env.AI_ENABLED || 'false').toLowerCase() === 'true';

/**
 * Bind address. Local development stays on loopback; a container or PaaS must
 * bind 0.0.0.0 or the platform router has nothing to forward to.
 */
const HOST = process.env.HOST || '127.0.0.1';

/**
 * Read-only mode for a publicly reachable demo. PayPal data, triage and the
 * webhook feed all stay live, but the one irreversible action — filing
 * evidence — is refused, so a visitor cannot consume the demo dispute.
 */
const DEMO_READONLY = String(process.env.DEMO_READONLY || 'false').toLowerCase() === 'true';

/** Test-only seam so the E2E suite can point the PayPal client at a local stub. */
const IS_TEST = process.env.PAYPAL_TEST_MODE === 'true';

if (MODE === 'sandbox' && !IS_TEST && new URL(API_BASE).hostname !== 'api-m.sandbox.paypal.com') {
  throw new Error('Sandbox mode is restricted to api-m.sandbox.paypal.com.');
}

// State directory is overridable so the test suite never touches demo history.
const LOCAL = process.env.RECOURSE_STATE_DIR ? path.resolve(process.env.RECOURSE_STATE_DIR) : path.join(ROOT, '.local');
const ACTIVITY_FILE = path.join(LOCAL, 'activity.json');
const EVENTS_FILE = path.join(LOCAL, 'events.json');
const PACKETS_FILE = path.join(LOCAL, 'packets.json');
const detailCache = new Map();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15_000);
const MAX_LIST_PAGES = Number(process.env.MAX_LIST_PAGES || 5);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

/* ---------------------------------------------------------------- stores */

async function jsonFile(name) { return JSON.parse(await readFile(path.join(ROOT, name), 'utf8')); }

async function readStore(file) {
  await mkdir(LOCAL, { recursive: true });
  if (!existsSync(file)) await writeFile(file, '[]');
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return []; }
}
async function writeStore(file, rows) {
  await mkdir(LOCAL, { recursive: true });
  await writeFile(file, JSON.stringify(rows, null, 2));
}

const activities = () => readStore(ACTIVITY_FILE);
const events = () => readStore(EVENTS_FILE);
const packets = () => readStore(PACKETS_FILE);

async function logActivity(caseId, event, detail) {
  const rows = await activities();
  rows.unshift({ id: crypto.randomUUID(), caseId, event, detail, at: new Date().toISOString() });
  await writeStore(ACTIVITY_FILE, rows.slice(0, 500));
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function rawBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return raw;
}
async function body(req) {
  const raw = await rawBody(req);
  return raw ? JSON.parse(raw) : {};
}

/* ------------------------------------------------------------------ SSE */

const sseClients = new Set();

function sseBroadcast(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of [...sseClients]) {
    try { client.write(frame); } catch { sseClients.delete(client); }
  }
}

/* --------------------------------------------------------------- PayPal */

async function accessToken() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    throw Object.assign(new Error('PayPal credentials are not configured. Add them to your local .env file.'), { status: 503 });
  }
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error('PayPal OAuth request failed.'), { status: response.status, paypal: data });
  return data.access_token;
}

async function paypal(pathname, options = {}) {
  const token = await accessToken();
  const target = new URL(pathname, `${API_BASE}/`);
  if (target.origin !== new URL(API_BASE).origin) {
    throw Object.assign(new Error('PayPal returned an action outside the configured Sandbox API origin.'), { status: 502 });
  }
  const response = await fetch(target, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 400) }; }
  if (!response.ok) {
    throw Object.assign(new Error(data.message || data.name || `PayPal returned ${response.status}.`), { status: response.status, paypal: data });
  }
  return data;
}

function invalidateDispute(id) { detailCache.delete(id); }

async function fetchDisputeFresh(id) {
  const dispute = await paypal(`/v1/customer/disputes/${encodeURIComponent(id)}`);
  dispute.id = dispute.id || dispute.dispute_id || id;
  detailCache.set(id, { value: dispute, expiresAt: Date.now() + CACHE_TTL_MS });
  return dispute;
}

async function cachedDispute(id) {
  const cached = detailCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return fetchDisputeFresh(id);
}

/** Follow PayPal's own `next` links rather than silently capping at one page. */
async function listDisputesPaged() {
  const items = [];
  const seen = new Set();
  let nextPath = '/v1/customer/disputes?page_size=20';
  let pages = 0;
  while (nextPath && pages < MAX_LIST_PAGES) {
    const data = await paypal(nextPath);
    for (const item of data.items || []) items.push({ ...item, id: item.id || item.dispute_id });
    pages += 1;
    const next = (data.links || []).find((link) => link.rel === 'next' && link.href);
    if (!next || seen.has(next.href)) { nextPath = null; break; }
    seen.add(next.href);
    nextPath = next.href;
  }
  return { items, pages, truncated: Boolean(nextPath) };
}

/** Hydrate list rows with detail; preserves input order so sorting stays honest. */
async function hydrateDisputes(items, limit = 3) {
  const output = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (!item.id) { output[index] = { ...item }; continue; }
      try { output[index] = { ...item, ...await cachedDispute(item.id), id: item.id }; }
      catch (error) { output[index] = { ...item, detail_error: error.status || 'unavailable' }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return output;
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return output;
}

function safeError(error) {
  if (error.paypal) {
    const message = error.status === 401
      ? 'PayPal rejected the Sandbox credentials or the token expired.'
      : error.status === 403
        ? 'This PayPal app is not permitted to perform the requested Sandbox action.'
        : error.status === 400
          ? 'PayPal rejected the request. Check the dispute state and evidence fields.'
          : `PayPal Sandbox returned an error (${error.status || 'unknown'}).`;
    return { error: message, ...(error.paypal.name ? { paypal_code: error.paypal.name } : {}) };
  }
  return { error: error.message || 'Request failed.' };
}

/* ------------------------------------------- real order data from PayPal */

function normalizeTransaction(source, pathUsed) {
  const info = source.transaction_info || source;
  const payer = source.payer_info || source.payer || {};
  const given = payer.payer_name?.given_name || payer.name?.given_name || '';
  const surname = payer.payer_name?.surname || payer.name?.surname || '';
  const fullName = payer.payer_name?.alternate_full_name || payer.name?.full_name || [given, surname].filter(Boolean).join(' ');
  const purchaseUnit = source.purchase_units?.[0] || {};
  const amount = info.transaction_amount || source.amount || purchaseUnit.amount || null;
  return {
    resolved_via: pathUsed,
    transaction_id: info.transaction_id || source.id || null,
    status: info.transaction_status || source.status || null,
    event_code: info.transaction_event_code || null,
    amount,
    fee_amount: info.fee_amount || null,
    invoice_number: info.invoice_id || source.invoice_id || purchaseUnit.invoice_id || null,
    created_at: info.transaction_initiation_date || source.create_time || null,
    updated_at: info.transaction_updated_date || source.update_time || null,
    payer_name: fullName || null,
    payer_email: payer.email_address || null,
    item_names: (source.cart_info?.item_details || []).map((item) => item.item_name).filter(Boolean),
  };
}

async function fetchPayPalTransaction(transactionId) {
  if (!transactionId || MODE !== 'sandbox') return null;
  const candidates = [
    { path: `/v1/reporting/transactions?transaction_id=${encodeURIComponent(transactionId)}&fields=all`, pick: (data) => data.transaction_details?.[0] },
    { path: `/v2/payments/captures/${encodeURIComponent(transactionId)}`, pick: (data) => data },
    { path: `/v2/checkout/orders/${encodeURIComponent(transactionId)}`, pick: (data) => data },
  ];
  for (const candidate of candidates) {
    const key = `txn:${candidate.path}`;
    try {
      const hit = detailCache.get(key);
      let data;
      if (hit && hit.expiresAt > Date.now()) data = hit.value;
      else {
        data = await paypal(candidate.path);
        detailCache.set(key, { value: data, expiresAt: Date.now() + 60_000 });
      }
      const picked = candidate.pick(data);
      if (picked) return normalizeTransaction(picked, candidate.path.split('?')[0]);
    } catch { /* try the next representation */ }
  }
  return null;
}

function disputeTransactionId(dispute) {
  const transaction = dispute?.disputed_transactions?.[0] || {};
  return transaction.seller_transaction_id || transaction.transaction_id || transaction.buyer_transaction_id || null;
}

async function matchingOrder(dispute) {
  const orders = await jsonFile('data/orders.json');
  const invoice = dispute.disputed_transactions?.[0]?.invoice_number;
  const txn = disputeTransactionId(dispute);
  // Match on transaction id first: invoice numbers are merchant-chosen and can repeat.
  if (txn) {
    const byTxn = orders.find((order) => order.paypal_transaction_id === txn);
    if (byTxn) return byTxn;
  }
  return orders.find((order) => order.invoice_number === invoice) || null;
}

/* -------------------------------------------------------- case assembly */

async function assembleCase(dispute, order) {
  const paypalTransaction = await fetchPayPalTransaction(disputeTransactionId(dispute));
  const evidence = buildEvidence(dispute, order, paypalTransaction);
  const plan = evidencePlan({ dispute, order });
  const deadline = deadlineInfo(dispute.seller_response_due_date);
  return { paypalTransaction, evidence, plan, deadline };
}

/**
 * Prepare a case without being asked: fetch the dispute, resolve its real
 * transaction, assemble the evidence set and store the packet. This is what
 * makes a dispute arrive already triaged instead of waiting for a click.
 */
async function triageCase(disputeId, { trigger = 'manual' } = {}) {
  const dispute = MODE === 'sandbox'
    ? await fetchDisputeFresh(disputeId)
    : (await jsonFile('data/demo-cases.json')).find((item) => item.id === disputeId);
  if (!dispute) throw Object.assign(new Error('That case was not found.'), { status: 404 });

  const order = await matchingOrder(dispute);
  const { paypalTransaction, evidence, plan, deadline } = await assembleCase(dispute, order);
  const draft = deterministicDraft(dispute, order, evidence);

  const packet = {
    disputeId: dispute.id,
    preparedAt: new Date().toISOString(),
    trigger,
    reason: dispute.reason,
    reasonLabel: reasonLabel(dispute.reason),
    status: dispute.status || null,
    stage: dispute.dispute_life_cycle_stage || null,
    amount: dispute.dispute_amount || null,
    deadline,
    evidenceCount: evidence.length,
    sourcesLinked: {
      paypal: evidence.filter((item) => item.origin === 'paypal').length,
      local: evidence.filter((item) => item.origin === 'local').length,
      buyer: evidence.filter((item) => item.origin === 'buyer').length,
    },
    plan,
    draft,
    missing: deterministicMissing(dispute, order),
    grounding: verifyClaims(draft, evidence),
    transaction: paypalTransaction ? { transaction_id: paypalTransaction.transaction_id, status: paypalTransaction.status, amount: paypalTransaction.amount } : null,
    engine: 'deterministic',
  };

  const rows = await packets();
  const filtered = rows.filter((row) => row.disputeId !== dispute.id);
  filtered.unshift(packet);
  await writeStore(PACKETS_FILE, filtered.slice(0, 200));

  await logActivity(dispute.id, `Case triaged (${trigger})`, `${evidence.length} source records linked · ${plan.allowed.length} evidence option(s) available · deadline ${deadline.label}`);
  sseBroadcast('triage', { disputeId: dispute.id, trigger, deadline, evidenceCount: evidence.length, at: packet.preparedAt });
  return packet;
}

async function getPacket(disputeId) {
  return (await packets()).find((row) => row.disputeId === disputeId) || null;
}

/* ------------------------------------------------------------- webhooks */

const WEBHOOK_LIFECYCLE = {
  'CUSTOMER.DISPUTE.CREATED': { label: 'Dispute created', triage: true },
  'CUSTOMER.DISPUTE.UPDATED': { label: 'Dispute updated', triage: true },
  'CUSTOMER.DISPUTE.RESOLVED': { label: 'Dispute resolved', triage: true },
  'PAYMENT.CAPTURE.DENIED': { label: 'Capture denied', triage: false },
  'PAYMENT.CAPTURE.REVERSED': { label: 'Capture reversed', triage: false },
  'PAYMENT.CAPTURE.REFUNDED': { label: 'Capture refunded', triage: false },
  'PAYMENT.CAPTURE.COMPLETED': { label: 'Capture completed', triage: false },
};

async function verifyWebhookSignature(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    throw Object.assign(new Error('PAYPAL_WEBHOOK_ID is not configured, so webhook signatures cannot be verified.'), { status: 503 });
  }
  const transmissionId = headers['paypal-transmission-id'];
  if (!transmissionId) throw Object.assign(new Error('The request is missing PayPal transmission headers.'), { status: 400 });

  const result = await paypal('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transmission_id: transmissionId,
      transmission_time: headers['paypal-transmission-time'],
      cert_url: headers['paypal-cert-url'],
      auth_algo: headers['paypal-auth-algo'],
      transmission_sig: headers['paypal-transmission-sig'],
      webhook_id: webhookId,
      webhook_event: event,
    }),
  });
  return result.verification_status === 'SUCCESS';
}

/**
 * Record an event exactly once. PayPal retries delivery, so the same event id
 * must never be processed twice; the second delivery reports `duplicate: true`
 * and does no further work.
 */
async function recordEvent(event, { simulated = false, verified = true } = {}) {
  const rows = await events();
  const eventId = event.id || `no-id-${crypto.randomUUID()}`;
  if (rows.some((row) => row.id === eventId)) return { duplicate: true, row: rows.find((row) => row.id === eventId) };

  const disputeId = event.resource?.dispute_id || event.resource?.id || null;
  const type = event.event_type || 'UNKNOWN';
  const row = {
    id: eventId,
    eventType: type,
    label: WEBHOOK_LIFECYCLE[type]?.label || type,
    disputeId,
    summary: event.summary || '',
    receivedAt: new Date().toISOString(),
    eventCreatedAt: event.create_time || null,
    simulated,
    verified,
    processed: false,
    triaged: false,
    error: null,
  };
  rows.unshift(row);
  await writeStore(EVENTS_FILE, rows.slice(0, 500));
  if (disputeId) invalidateDispute(disputeId);
  sseBroadcast('webhook', { id: row.id, eventType: type, label: row.label, disputeId, simulated, verified, receivedAt: row.receivedAt });
  return { duplicate: false, row };
}

async function updateEvent(id, patch) {
  const rows = await events();
  const index = rows.findIndex((row) => row.id === id);
  if (index === -1) return null;
  rows[index] = { ...rows[index], ...patch };
  await writeStore(EVENTS_FILE, rows);
  return rows[index];
}

/**
 * Build a packet from the webhook payload alone, for when the follow-up dispute
 * read cannot succeed. Keeps the audit trail honest: the packet is marked
 * partial and says where its facts came from.
 */
async function triageFromEvent(event, row, cause) {
  const resource = event.resource || {};
  const disputeId = row.disputeId || resource.dispute_id || resource.id || 'unknown';
  const packet = {
    disputeId,
    preparedAt: new Date().toISOString(),
    trigger: `webhook:${row.eventType}`,
    reason: resource.reason || null,
    reasonLabel: resource.reason ? reasonLabel(resource.reason) : 'Reason not supplied by the event',
    status: resource.dispute_state || resource.status || null,
    stage: resource.dispute_life_cycle_stage || null,
    amount: resource.dispute_amount || null,
    deadline: deadlineInfo(resource.seller_response_due_date || null),
    evidenceCount: 0,
    sourcesLinked: { paypal: 0, local: 0, buyer: 0 },
    plan: evidencePlan({ dispute: { reason: resource.reason, evidences: [] }, order: null }),
    draft: '',
    missing: [`PayPal did not return this dispute (${cause?.message || 'unknown reason'}), so this packet was built from the webhook payload alone.`],
    grounding: { checked: 0, unsupported: [], status: 'no_quantitative_claims' },
    transaction: null,
    engine: 'deterministic',
    partial: true,
    note: 'Built from the webhook payload because the dispute detail was unavailable.',
  };

  const rows = await packets();
  const filtered = rows.filter((item) => item.disputeId !== disputeId);
  filtered.unshift(packet);
  await writeStore(PACKETS_FILE, filtered.slice(0, 200));
  await logActivity(disputeId, `Case triaged from event (${row.eventType})`, packet.note);
  sseBroadcast('triage', { disputeId, trigger: packet.trigger, partial: true, at: packet.preparedAt });
  return packet;
}

/**
 * Follow-up work for a received event. Runs after the HTTP 200 so PayPal is
 * never left waiting — it retries delivery if it doesn't see a 200 within 30s.
 */
async function processEvent(event, row) {
  const disputeId = row.disputeId;
  try {
    if (disputeId) {
      await logActivity(disputeId, `PayPal webhook · ${row.eventType}`, `${row.simulated ? 'Simulated event' : 'Signature verified'} · event ${row.id}`);
    }
    const shouldTriage = WEBHOOK_LIFECYCLE[row.eventType]?.triage && disputeId && MODE === 'sandbox';
    if (shouldTriage) {
      let packet;
      try {
        packet = await triageCase(disputeId, { trigger: `webhook:${row.eventType}` });
      } catch (triageError) {
        // A sample id from PayPal's simulator, or a delivery that arrives before
        // the dispute is readable, must still leave an auditable record rather
        // than an error state.
        packet = await triageFromEvent(event, row, triageError);
      }
      await updateEvent(row.id, { processed: true, triaged: true, triage_source: packet.partial ? 'event' : 'paypal' });
      sseBroadcast('case-updated', { disputeId, reason: row.eventType, preparedAt: packet.preparedAt });
      return;
    }
    await updateEvent(row.id, { processed: true });
    sseBroadcast('case-updated', { disputeId, reason: row.eventType });
  } catch (error) {
    await updateEvent(row.id, { processed: true, error: error.message || 'Processing failed' });
    if (disputeId) await logActivity(disputeId, 'Webhook processing failed', error.message || 'Unknown error');
    sseBroadcast('case-updated', { disputeId, reason: row.eventType, error: error.message });
  }
}

/* ------------------------------------------------------------- analysis */

/**
 * Deterministic analysis. This is the active path while AI_ENABLED is false.
 * Every fact is drawn from PayPal or the merchant's own records; nothing is
 * generated by a model.
 */
async function analyzeDeterministic(dispute, order, { engineReason }) {
  const { paypalTransaction, evidence, plan, deadline } = await assembleCase(dispute, order);
  const draft = deterministicDraft(dispute, order, evidence);
  const grounding = verifyClaims(draft, evidence);

  await logActivity(dispute.id, 'Deterministic analysis prepared', `${engineReason} · ${evidence.length} source record(s) linked`);

  return {
    classification: reasonLabel(dispute.reason),
    id: dispute.id,
    engine: 'deterministic',
    provenance: engineReason,
    summary: `The buyer opened a dispute for ${reasonLabel(dispute.reason).toLowerCase()}${order?.item ? ` involving ${order.item}` : ''}. Recourse linked ${evidence.length} source record${evidence.length === 1 ? '' : 's'} and found ${plan.allowed.length} evidence option${plan.allowed.length === 1 ? '' : 's'} PayPal accepts for this reason.`,
    evidence,
    missing: deterministicMissing(dispute, order),
    contradictions: [],
    draft,
    confidence: order?.fulfillment?.delivery_status === 'Delivered' ? 'Moderate' : 'Low',
    explanation: 'This draft is assembled directly from the linked source records. Every checkable claim is matched back to them.',
    grounding,
    paypalTransaction,
    plan,
    deadline,
    sourcesLinked: {
      paypal: evidence.filter((item) => item.origin === 'paypal').length,
      local: evidence.filter((item) => item.origin === 'local').length,
      buyer: evidence.filter((item) => item.origin === 'buyer').length,
    },
    ai: { used: false, enabled: AI_ENABLED, configured: aiConfigured(), code: AI_ENABLED ? 'AI_NOT_CONFIGURED' : 'AI_DISABLED' },
    order,
  };
}

/**
 * Model-assisted analysis. NOT REACHABLE while AI_ENABLED is false.
 * Kept intact so the AI path can be reinstated with a single env change.
 */
async function analyzeWithModel(dispute, order) {
  const { paypalTransaction, evidence, plan, deadline } = await assembleCase(dispute, order);

  const schema = {
    type: 'object',
    properties: {
      relevant_source_ids: { type: 'array', items: { type: 'string' } },
      draft: { type: 'string' },
      confidence: { type: 'string', enum: ['Low', 'Moderate', 'High'] },
      contradiction_codes: { type: 'array', items: { type: 'string', enum: ['delivery_before_shipment', 'delivery_status_conflict', 'missing_address', 'missing_recipient', 'missing_refund'] } },
    },
    required: ['relevant_source_ids', 'draft', 'confidence', 'contradiction_codes'],
  };

  const result = await generateJSON({
    system: 'You assist a merchant reviewing a payment dispute. Decision support only: do not decide liability or recommend a refund. Use only the supplied sources. Return JSON only.',
    user: JSON.stringify({
      dispute: { reason: dispute.reason, amount: dispute.dispute_amount, stage: dispute.dispute_life_cycle_stage },
      evidence: evidence.map(({ id, origin, fact }) => ({ id, origin, fact })),
    }),
    schema,
    temperature: 0.1,
  });

  const output = result.json;
  const validIds = new Set(evidence.map((item) => item.id));
  const cited = typeof output.draft === 'string' && output.draft.trim() ? output.draft.trim() : '';
  const sentences = cited.split(/(?<=[.!?])\s+/).filter(Boolean);
  const citationOk = sentences.length > 0 && sentences.every((sentence) => [...sentence.matchAll(/\[source:([a-z0-9-]+)\]/gi)].some((m) => validIds.has(m[1])));
  const accepted = citationOk ? cited : evidence.map((item) => `${item.fact} [source:${item.id}]`).join(' ');
  const draft = stripCitations(accepted);
  const grounding = verifyClaims(draft, evidence);
  grounding.citations = { status: citationOk ? 'verified' : 'rebuilt_from_sources', model: result.model };

  await logActivity(dispute.id, 'AI analysis prepared', `Model: ${result.model}; ${result.attempts} attempt(s)`);

  return {
    classification: reasonLabel(dispute.reason),
    id: dispute.id,
    engine: 'ai',
    provenance: `AI model · ${result.provider} · ${result.model} · grounded draft`,
    summary: `The buyer opened a dispute for ${reasonLabel(dispute.reason).toLowerCase()}. Recourse linked ${evidence.length} source records.`,
    evidence,
    missing: deterministicMissing(dispute, order),
    contradictions: Array.isArray(output.contradiction_codes) ? output.contradiction_codes : [],
    draft,
    confidence: ['Low', 'Moderate', 'High'].includes(output.confidence) ? output.confidence : 'Moderate',
    explanation: 'The draft is composed from the linked source records and every checkable claim was matched back to them.',
    grounding,
    paypalTransaction,
    plan,
    deadline,
    sourcesLinked: {
      paypal: evidence.filter((item) => item.origin === 'paypal').length,
      local: evidence.filter((item) => item.origin === 'local').length,
      buyer: evidence.filter((item) => item.origin === 'buyer').length,
    },
    ai: { used: true, enabled: true, configured: true, provider: result.provider, model: result.model, attempts: result.attempts },
    order,
  };
}

async function analyze(payload) {
  const posted = payload?.dispute;
  let id = posted?.id || posted?.dispute_id || payload?.id;
  let dispute = posted;

  if (MODE === 'sandbox' && id) {
    try { dispute = await cachedDispute(id); } catch { /* fall back to the posted snapshot */ }
  }
  if (!dispute) throw Object.assign(new Error('That case was not found.'), { status: 404 });
  id = dispute.id || dispute.dispute_id || id;
  dispute.id = id;

  const order = (await matchingOrder(dispute)) || payload?.order || null;

  const analysis = AI_ENABLED && aiConfigured()
    ? await analyzeWithModel(dispute, order)
    : await analyzeDeterministic(dispute, order, {
      engineReason: AI_ENABLED ? 'Rules-based analysis · no AI provider configured' : 'Rules-based analysis · AI disabled',
    });

  await triageCase(id, { trigger: 'analyze' }).catch(() => {});
  return analysis;
}

/* ------------------------------------------------- evidence submission */

/**
 * The single path that moves anything at PayPal. Deterministic, approval-gated,
 * and re-validated against PayPal immediately before it runs.
 */
async function submitEvidence(payload) {
  const { id, approved, responseText, evidenceType, refundId = null } = payload;

  // A shared demo must never let a visitor burn the one demoable dispute.
  if (DEMO_READONLY) {
    throw Object.assign(new Error('This hosted demo is read-only. Live evidence submission is disabled to protect the demo PayPal case; run Recourse locally with DEMO_READONLY=false to submit.'), { status: 409 });
  }

  if (approved !== true) throw Object.assign(new Error('Merchant approval is required before submission.'), { status: 400 });

  const text = stripCitations(responseText);
  if (!String(responseText || '').trim()) throw Object.assign(new Error('Add a response before submitting.'), { status: 400 });
  if (text.length > 2000) throw Object.assign(new Error('PayPal evidence notes must be 2,000 characters or fewer.'), { status: 400 });

  // Deliberately bypasses every cache: this decision must reflect PayPal now.
  const current = MODE === 'sandbox'
    ? await paypal(`/v1/customer/disputes/${encodeURIComponent(id)}`)
    : (await jsonFile('data/demo-cases.json')).find((item) => item.id === id);
  if (!current) throw Object.assign(new Error('That case was not found.'), { status: 404 });

  const actions = current.links || [];
  // PayPal returns this action with an underscore in the live sandbox.
  const action = findAction(actions, 'provide-evidence');
  if (!action) {
    throw Object.assign(new Error(`PayPal does not offer evidence submission for the current stage (${current.status || 'unknown'}). Available actions: ${actions.map((link) => link.rel).filter(Boolean).join(', ') || 'none'}.`), { status: 409 });
  }
  if (MODE === 'sandbox' && current.status !== 'WAITING_FOR_SELLER_RESPONSE') {
    throw Object.assign(new Error(`This case is ${current.status || 'not ready'}; PayPal currently only allows seller evidence while waiting for a seller response.`), { status: 409 });
  }

  const allowed = allowedEvidenceTypes(current.reason);
  if (!allowed.includes(evidenceType)) {
    throw Object.assign(new Error(`PayPal does not accept ${evidenceType} for a ${reasonLabel(current.reason)} dispute. Accepted types: ${allowed.join(', ')}.`), { status: 409 });
  }

  const requested = (current.evidences || []).filter((item) => item.source === 'REQUESTED_FROM_SELLER').map((item) => item.evidence_type);
  if (requested.length && !requested.includes(evidenceType)) {
    throw Object.assign(new Error(`PayPal currently requests ${requested.join(', ')}. Refresh the dispute and select a requested evidence type.`), { status: 409 });
  }

  await logActivity(id, 'Merchant approved response', `Evidence type: ${evidenceType}; approval recorded before any PayPal action.`);

  const order = await matchingOrder(current);
  let result;
  if (MODE === 'sandbox') {
    try {
      const evidence = buildEvidenceEntry({ evidenceType, notes: text, order, refundId });
      if (action.method && action.method.toUpperCase() !== 'POST') {
        throw Object.assign(new Error(`PayPal returned ${action.method} for evidence submission; this app only supports POST.`), { status: 409 });
      }
      const form = new FormData();
      form.set('input', new Blob([JSON.stringify({ evidences: [evidence] })], { type: 'application/json' }), 'input.json');
      result = await paypal(action.href, { method: 'POST', body: form });
    } catch (error) {
      await logActivity(id, 'PayPal submission failed', `No successful PayPal response; HTTP ${error.status || 'network error'}${error.paypal?.name ? ` (${error.paypal.name})` : ''}.`);
      throw error;
    }
  } else {
    result = { mode: 'fixture', message: 'Demo response recorded. No request was sent to PayPal.' };
  }

  invalidateDispute(id);
  await logActivity(id, MODE === 'sandbox' ? 'PayPal response submitted' : 'Fixture response recorded', MODE === 'sandbox' ? `Evidence type: ${evidenceType}; PayPal accepted the submission.` : `Evidence type: ${evidenceType}; no PayPal request was sent.`);

  const refreshed = MODE === 'sandbox'
    ? await paypal(`/v1/customer/disputes/${encodeURIComponent(id)}`)
    : null;
  if (refreshed) detailCache.set(id, { value: refreshed, expiresAt: Date.now() + CACHE_TTL_MS });

  sseBroadcast('case-updated', { disputeId: id, reason: 'evidence-submitted' });

  return {
    result,
    mode: MODE,
    submittedAt: new Date().toISOString(),
    dispute: refreshed || { ...current, status: 'UNDER_REVIEW', links: current.links.filter((link) => normalizeRel(link.rel) !== 'provide-evidence') },
    activity: (await activities()).filter((row) => row.caseId === id),
  };
}

/* ---------------------------------------------------------------- cases */

async function listFixtureCases() {
  const cases = await jsonFile('data/demo-cases.json');
  const log = await activities();
  const submitted = new Set(log.filter((row) => row.event === 'Fixture response recorded').map((row) => row.caseId));
  return cases.map((item) => submitted.has(item.id)
    ? { ...item, status: 'UNDER_REVIEW', links: item.links.filter((link) => normalizeRel(link.rel) !== 'provide-evidence') }
    : item);
}

async function listSandboxCases() {
  const { items, truncated, pages } = await listDisputesPaged();
  const cases = await hydrateDisputes(items);
  return { cases, truncated, pages };
}

async function getCase(id) {
  const dispute = MODE === 'sandbox'
    ? await cachedDispute(id)
    : (await jsonFile('data/demo-cases.json')).find((item) => item.id === id);
  if (!dispute) throw Object.assign(new Error('That case was not found.'), { status: 404 });
  dispute.id = dispute.id || dispute.dispute_id || id;

  const log = (await activities()).filter((row) => row.caseId === id);
  if (MODE === 'fixture' && log.some((row) => row.event === 'Fixture response recorded')) {
    dispute.status = 'UNDER_REVIEW';
    dispute.links = dispute.links.filter((link) => normalizeRel(link.rel) !== 'provide-evidence');
  }

  const retrievalEvent = MODE === 'fixture' ? 'Fixture case retrieved' : 'PayPal Sandbox dispute retrieved';
  if (!log.some((row) => row.event === retrievalEvent)) {
    await logActivity(id, retrievalEvent, MODE === 'fixture' ? 'Synthetic case details loaded; no PayPal request was sent.' : 'Fresh dispute details retrieved from the PayPal Sandbox API.');
  }

  const order = await matchingOrder(dispute);
  const { paypalTransaction, evidence, plan, deadline } = await assembleCase(dispute, order);

  return {
    dispute,
    order,
    paypalTransaction,
    evidence,
    plan,
    deadline,
    packet: await getPacket(id),
    events: (await events()).filter((row) => row.disputeId === id),
    activity: (await activities()).filter((row) => row.caseId === id),
    source: MODE === 'sandbox' ? 'PayPal Sandbox' : 'Fixture demo',
    mode: MODE,
  };
}

/* --------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const config = aiConfig();
      return send(res, 200, {
        mode: MODE,
        aiEnabled: AI_ENABLED,
        aiConfigured: aiConfigured(),
        aiProvider: AI_ENABLED ? AI_PROVIDER_LABEL : 'disabled',
        aiModel: AI_ENABLED ? config.model : null,
        readOnly: DEMO_READONLY,
        webhookConfigured: Boolean(process.env.PAYPAL_WEBHOOK_ID),
        lifecycleEvents: Object.keys(WEBHOOK_LIFECYCLE),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/ai-check') {
      if (!AI_ENABLED) {
        return send(res, 200, { ok: false, enabled: false, code: 'AI_DISABLED', message: 'The AI model is switched off (AI_ENABLED=false). The deterministic evidence path is active.' });
      }
      if (!aiConfigured()) {
        return send(res, 200, { ok: false, enabled: true, code: 'AI_NOT_CONFIGURED', message: 'AI is enabled but no provider key is configured.' });
      }
      return send(res, 200, await aiHealthCheck());
    }

    if (req.method === 'GET' && url.pathname === '/api/paypal-check') {
      if (MODE !== 'sandbox') throw Object.assign(new Error('Set PAYPAL_MODE=sandbox in your local .env file first.'), { status: 409 });
      const data = await paypal('/v1/customer/disputes?page_size=1');
      return send(res, 200, { ok: true, message: 'Sandbox authentication succeeded and PayPal returned the dispute list.', itemsFound: (data.items || []).length });
    }

    if (req.method === 'GET' && url.pathname === '/api/cases') {
      if (MODE === 'fixture') return send(res, 200, { mode: MODE, cases: await listFixtureCases() });
      const { cases, truncated, pages } = await listSandboxCases();
      return send(res, 200, { mode: MODE, cases, truncated, pages });
    }

    if (req.method === 'GET' && url.pathname === '/api/orders') {
      const orders = await jsonFile('data/orders.json');
      const enriched = await mapLimit(orders, 3, async (order) => ({
        ...order,
        paypal: await fetchPayPalTransaction(order.paypal_transaction_id),
      }));
      return send(res, 200, { orders: enriched });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const rows = await events();
      return send(res, 200, { events: rows, webhookConfigured: Boolean(process.env.PAYPAL_WEBHOOK_ID) });
    }

    if (req.method === 'GET' && url.pathname === '/api/events/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString(), mode: MODE })}\n\n`);
      sseClients.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* closed */ }
      }, 25_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
      return undefined;
    }

    if (req.method === 'GET' && url.pathname === '/api/watchdog') {
      const disputes = MODE === 'sandbox' ? (await listSandboxCases()).cases : await listFixtureCases();
      const watching = disputes
        .map((dispute) => ({
          disputeId: dispute.id,
          reason: dispute.reason,
          reasonLabel: reasonLabel(dispute.reason),
          status: dispute.status || null,
          amount: dispute.dispute_amount || null,
          needsResponse: hasAction(dispute.links, 'provide-evidence'),
          ...deadlineInfo(dispute.seller_response_due_date),
        }))
        .sort((a, b) => (a.hoursRemaining ?? Number.MAX_SAFE_INTEGER) - (b.hoursRemaining ?? Number.MAX_SAFE_INTEGER));
      return send(res, 200, { cases: watching, atRisk: watching.filter((item) => ['urgent', 'overdue'].includes(item.urgency)) });
    }

    if (req.method === 'GET' && url.pathname === '/api/packets') {
      return send(res, 200, { packets: await packets() });
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/paypal') {
      const raw = await rawBody(req);
      let event;
      try { event = JSON.parse(raw); } catch { return send(res, 400, { error: 'Webhook body was not valid JSON.' }); }

      if (MODE !== 'sandbox') {
        const recorded = await recordEvent(event, { simulated: true, verified: false });
        if (!recorded.duplicate) setImmediate(() => processEvent(event, recorded.row).catch(() => {}));
        return send(res, 200, { received: true, verified: false, duplicate: recorded.duplicate, note: 'Fixture mode: stored without PayPal signature verification.' });
      }

      const verified = await verifyWebhookSignature(req.headers, event);
      if (!verified) return send(res, 400, { error: 'PayPal webhook signature verification failed. The event was not processed.' });

      const recorded = await recordEvent(event, { simulated: false, verified: true });
      // Acknowledge immediately; PayPal retries if it doesn't see 200 within 30s.
      if (!recorded.duplicate) setImmediate(() => processEvent(event, recorded.row).catch(() => {}));
      return send(res, 200, { received: true, verified: true, duplicate: recorded.duplicate, eventId: recorded.row?.id });
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/simulate') {
      const payload = await body(req);
      const { eventType = 'CUSTOMER.DISPUTE.CREATED', disputeId = null, sequence = false } = payload;

      if (sequence) {
        const steps = ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'];
        const created = [];
        for (const step of steps) {
          const event = {
            id: `SIM-${step}-${crypto.randomUUID()}`,
            event_type: step,
            create_time: new Date().toISOString(),
            resource: { dispute_id: disputeId },
          };
          const recorded = await recordEvent(event, { simulated: true, verified: false });
          if (!recorded.duplicate) setImmediate(() => processEvent(event, recorded.row).catch(() => {}));
          created.push({ id: event.id, eventType: step, duplicate: recorded.duplicate });
        }
        return send(res, 200, { received: true, simulated: true, verified: false, sequence: created });
      }

      const event = {
        id: `SIM-${crypto.randomUUID()}`,
        event_type: eventType,
        create_time: new Date().toISOString(),
        resource: { dispute_id: disputeId },
      };
      const recorded = await recordEvent(event, { simulated: true, verified: false });
      if (!recorded.duplicate) setImmediate(() => processEvent(event, recorded.row).catch(() => {}));
      return send(res, 200, { received: true, simulated: true, verified: false, duplicate: recorded.duplicate, event });
    }

    const triageRoute = url.pathname.match(/^\/api\/triage\/([^/]+)$/);
    if (req.method === 'POST' && triageRoute) {
      const packet = await triageCase(decodeURIComponent(triageRoute[1]), { trigger: 'manual' });
      return send(res, 200, { packet });
    }

    const caseRoute = url.pathname.match(/^\/api\/cases\/([^/]+)$/);
    if (req.method === 'GET' && caseRoute) return send(res, 200, await getCase(decodeURIComponent(caseRoute[1])));

    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const payload = await body(req);
      const result = await analyze(payload);
      const caseId = payload?.dispute?.id || payload?.dispute?.dispute_id || payload?.id || result.id;
      result.activity = (await activities()).filter((row) => row.caseId === caseId);
      return send(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/respond') return send(res, 200, await submitEvidence(await body(req)));

    if (req.method === 'GET' && url.pathname.startsWith('/api/')) return send(res, 404, { error: 'API route not found.' });

    const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(ROOT, 'public', `.${requested}`);
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return send(res, 403, { error: 'Forbidden.' });
    let content;
    try {
      content = await readFile(file);
    } catch (error) {
      // A missing asset is a 404, not a server fault.
      if (error.code === 'ENOENT' || error.code === 'EISDIR') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      throw error;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(content);
  } catch (error) {
    if (error.paypal) console.error(`[recourse] ${req.method} ${url.pathname}: PayPal status ${error.status || 'unknown'} (${error.paypal.name || 'unclassified'})`);
    else console.error(`[recourse] ${req.method} ${url.pathname}:`, error.message);
    if (url.pathname.startsWith('/api/')) return send(res, error.status || 500, safeError(error));
    res.writeHead(500);
    res.end('Something went wrong.');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Recourse is running at http://${HOST}:${PORT} · mode=${MODE}${DEMO_READONLY ? ' · READ-ONLY demo' : ''}`);
  console.log(`Engine: deterministic evidence + approval gate · AI: ${AI_ENABLED ? `enabled (${AI_PROVIDER_LABEL})` : 'DISABLED (AI_ENABLED=false)'}`);
  console.log(`Webhooks: ${process.env.PAYPAL_WEBHOOK_ID ? 'signature verification enabled' : 'PAYPAL_WEBHOOK_ID not set (simulation only)'} · lifecycle events: ${Object.keys(WEBHOOK_LIFECYCLE).length}`);
});
