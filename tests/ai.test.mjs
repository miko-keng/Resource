// Unit tests for the AI client's resilience. The provider is mocked at the
// fetch boundary, so these run offline and fast.
//
// Note: the app itself runs with AI_ENABLED=false. These tests keep the client
// honest so the model path can be switched back on without surprises.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AiUnavailableError, extractJson, generateJSON } from '../lib/ai.mjs';

const ENV_KEYS = ['AI_PROVIDER', 'GEMINI_API_KEY', 'AI_API_KEY', 'AI_MODEL', 'AI_MODEL_FALLBACKS', 'AI_TIMEOUT_MS', 'AI_RETRY_DELAYS_MS', 'AI_RETRY_JITTER_MS', 'AI_BASE_URL'];
let saved;
let originalFetch;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key';
  delete process.env.AI_API_KEY;
  process.env.AI_MODEL = 'model-one';
  process.env.AI_MODEL_FALLBACKS = 'model-two';
  process.env.AI_TIMEOUT_MS = '2000';
  process.env.AI_RETRY_DELAYS_MS = '0,0,0';
  process.env.AI_RETRY_JITTER_MS = '0';
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
});

function geminiReply(text) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
}
function geminiError(status, message) {
  return { ok: false, status, json: async () => ({ error: { message } }) };
}
function modelFromUrl(url) {
  const match = String(url).match(/\/models\/([^:]+):generateContent/);
  return match ? decodeURIComponent(match[1]) : 'unknown';
}

/* -------------------------------------------------------- extractJson */

test('extractJson reads plain, fenced and prose-wrapped JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":1} — hope that helps'), { a: 1 });
});

test('extractJson rejects empty and unusable replies', () => {
  assert.throws(() => extractJson(''), (error) => error.code === 'AI_EMPTY');
  assert.throws(() => extractJson('   '), (error) => error.code === 'AI_EMPTY');
  assert.throws(() => extractJson('no json here at all'), (error) => error.code === 'AI_BAD_JSON');
});

/* ------------------------------------------------------- happy path */

test('generateJSON returns parsed JSON and reports the model used', async () => {
  globalThis.fetch = async (url) => {
    assert.equal(modelFromUrl(url), 'model-one');
    return geminiReply('{"ok":true}');
  };
  const result = await generateJSON({ system: 's', user: 'u' });
  assert.deepEqual(result.json, { ok: true });
  assert.equal(result.model, 'model-one');
  assert.equal(result.attempts, 1);
});

/* ---------------------------------------------------------- retrying */

test('generateJSON retries a transient upstream failure on the same model', async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(modelFromUrl(url), 'model-one');
    calls += 1;
    if (calls < 3) return geminiError(503, 'This model is currently experiencing high demand.');
    return geminiReply('{"ok":true}');
  };
  const result = await generateJSON({ system: 's', user: 'u' });
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.model, 'model-one');
});

test('generateJSON retries a per-minute rate limit', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return geminiError(429, 'Rate limit exceeded, please retry.');
    return geminiReply('{"ok":true}');
  };
  const result = await generateJSON({ system: 's', user: 'u' });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
});

/* ---------------------------------------------- falling through models */

test('generateJSON moves to the next model on 404 without burning retries', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    const model = modelFromUrl(url);
    seen.push(model);
    if (model === 'model-one') return geminiError(404, 'This model is no longer available to new users.');
    return geminiReply('{"ok":true}');
  };
  const result = await generateJSON({ system: 's', user: 'u' });
  assert.equal(result.model, 'model-two');
  // One attempt each: a retired model must not be retried three times.
  assert.deepEqual(seen, ['model-one', 'model-two']);
});

test('generateJSON fails fast to the next model when the plan quota is exhausted', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    const model = modelFromUrl(url);
    seen.push(model);
    if (model === 'model-one') return geminiError(429, 'You exceeded your current quota, please check your plan and billing details.');
    return geminiReply('{"ok":true}');
  };
  const result = await generateJSON({ system: 's', user: 'u' });
  // Retrying an exhausted quota cannot succeed, so it must not be retried.
  assert.deepEqual(seen, ['model-one', 'model-two']);
  assert.equal(result.model, 'model-two');
});

test('generateJSON recovers from a model that returns unparseable text', async () => {
  globalThis.fetch = async (url) => {
    if (modelFromUrl(url) === 'model-one') return geminiReply('I am afraid I cannot do that.');
    return geminiReply('{"ok":true}');
  };
  const result = await generateJSON({ system: 's', user: 'u' });
  assert.equal(result.model, 'model-two');
});

/* ------------------------------------------------------------- failures */

test('generateJSON aborts immediately on an auth failure', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return geminiError(401, 'API key not valid.'); };
  await assert.rejects(
    () => generateJSON({ system: 's', user: 'u' }),
    (error) => error instanceof AiUnavailableError && error.code === 'AI_AUTH',
  );
  assert.equal(calls, 1, 'an auth failure must not be retried across models');
});

test('generateJSON reports upstream unavailability when every model is down', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return geminiError(503, 'high demand'); };
  await assert.rejects(
    () => generateJSON({ system: 's', user: 'u' }),
    (error) => error instanceof AiUnavailableError && error.code === 'AI_UPSTREAM' && error.attempts === calls,
  );
  assert.ok(calls > 1, 'expected multiple attempts before giving up');
});

test('generateJSON names quota exhaustion distinctly from a transient outage', async () => {
  globalThis.fetch = async () => geminiError(429, 'You exceeded your current quota, please check your plan and billing details.');
  await assert.rejects(
    () => generateJSON({ system: 's', user: 'u' }),
    (error) => error.code === 'AI_QUOTA_EXHAUSTED' && /quota/i.test(error.message),
  );
});

test('generateJSON refuses to run with no provider configured', async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_API_KEY;
  process.env.AI_PROVIDER = 'none';
  await assert.rejects(
    () => generateJSON({ system: 's', user: 'u' }),
    (error) => error.code === 'AI_NOT_CONFIGURED',
  );
});

test('generateJSON surfaces a network failure rather than hanging', async () => {
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  await assert.rejects(
    () => generateJSON({ system: 's', user: 'u' }),
    (error) => error instanceof AiUnavailableError && /network/i.test(JSON.stringify(error.detail)),
  );
});
