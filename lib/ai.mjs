// Provider-agnostic JSON-mode AI client.
//
// Design goals, in order:
//   1. Never let a transient provider failure empty out the merchant's screen.
//   2. Retry the failures that are worth retrying (429 / 5xx / timeout / network).
//   3. Fall through a chain of models when one is capacity-constrained.
//   4. Return structured JSON the caller can verify, never free-form prose.
//
// Recourse treats the model as a drafting and reasoning aid. It never receives
// PayPal credentials and never authorizes a payment action.

/** Retry backoff. Overridable so the test suite doesn't have to wait 8 seconds. */
function retryDelays() {
  const raw = process.env.AI_RETRY_DELAYS_MS;
  if (!raw) return [800, 2200, 5000];
  const parsed = raw.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : [800, 2200, 5000];
}
const DEFAULT_TIMEOUT_MS = 30_000;

// Verified reachable with the project's key. Avoid models retired for new
// accounts (404) or currently out of quota (429) — see AI_MODEL_FALLBACKS.
const GEMINI_DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-flash-lite-latest'];
const OPENAI_DEFAULT_MODELS = ['gpt-4.1-mini', 'gpt-4o-mini'];

export class AiUnavailableError extends Error {
  constructor(message, { code = 'AI_UNAVAILABLE', attempts = 0, detail = null } = {}) {
    super(message);
    this.name = 'AiUnavailableError';
    this.code = code;
    this.attempts = attempts;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

/**
 * Resolve the active provider, key, base URL and model from the environment.
 * Accepts both this project's older names (AI_API_KEY / AI_BASE_URL) and the
 * provider-specific names used in .env (GEMINI_API_KEY / AI_PROVIDER).
 */
export function aiConfig() {
  let provider = (firstEnv('AI_PROVIDER') || '').toLowerCase();
  const geminiKey = firstEnv('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY');
  const openaiKey = firstEnv('AI_API_KEY', 'OPENAI_API_KEY');
  const baseUrlOverride = firstEnv('AI_BASE_URL');

  if (provider === 'google' || provider === 'googleai' || provider === 'gemini-api') provider = 'gemini';
  if (provider === 'openai-compatible' || provider === 'openai_compatible') provider = 'openai';
  if (!provider) provider = geminiKey ? 'gemini' : openaiKey ? 'openai' : 'none';
  if (provider === 'gemini' && !geminiKey && openaiKey) provider = 'openai';
  if (provider === 'openai' && !openaiKey && geminiKey) provider = 'gemini';

  const apiKey = provider === 'gemini' ? geminiKey : openaiKey;
  if (!apiKey) provider = 'none';

  const model =
    firstEnv('AI_MODEL') || (provider === 'gemini' ? GEMINI_DEFAULT_MODELS[0] : OPENAI_DEFAULT_MODELS[0]);
  const fallbacks = firstEnv('AI_MODEL_FALLBACKS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    provider,
    model,
    fallbacks,
    apiKey,
    baseUrl:
      provider === 'gemini'
        ? baseUrlOverride || 'https://generativelanguage.googleapis.com/v1beta'
        : baseUrlOverride || 'https://api.openai.com/v1',
    timeoutMs: Number(firstEnv('AI_TIMEOUT_MS')) || DEFAULT_TIMEOUT_MS,
  };
}

export function aiConfigured() {
  return aiConfig().provider !== 'none';
}

function modelChain(config) {
  const defaults = config.provider === 'gemini' ? GEMINI_DEFAULT_MODELS : OPENAI_DEFAULT_MODELS;
  return [...new Set([config.model, ...config.fallbacks, ...defaults].filter(Boolean))];
}

/** Pull a JSON object out of a model reply that may be fenced or prefixed with prose. */
export function extractJson(text) {
  if (!text || !String(text).trim()) {
    throw new AiUnavailableError('The model returned an empty response.', { code: 'AI_EMPTY' });
  }
  let value = String(text).trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) value = fenced[1].trim();
  try {
    return JSON.parse(value);
  } catch {
    /* fall through to brace extraction */
  }
  const start = value.search(/[{[]/);
  if (start >= 0) {
    const open = value[start];
    const close = open === '{' ? '}' : ']';
    const end = value.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(value.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new AiUnavailableError('The model returned text that was not valid JSON.', { code: 'AI_BAD_JSON' });
}

function classifyStatus(status, message = '') {
  // 429 covers two very different situations: a per-minute rate limit, which is
  // worth waiting out, and an exhausted plan quota, which is not. Retrying the
  // latter just burns the merchant's time before moving to the next model.
  if (status === 429) {
    const quotaExhausted = /exceeded your current quota|check your plan and billing|quota exceeded/i.test(message);
    return quotaExhausted
      ? { retryable: false, nextModel: true, code: 'AI_QUOTA_EXHAUSTED' }
      : { retryable: true, code: 'AI_RATE_LIMITED' };
  }
  if (status >= 500) return { retryable: true, code: 'AI_UPSTREAM' };
  if (status === 401 || status === 403) return { retryable: false, code: 'AI_AUTH' };
  if (status === 404) return { retryable: false, nextModel: true, code: 'AI_MODEL_NOT_FOUND' };
  if (status === 400 || status === 422) return { retryable: false, code: 'AI_BAD_REQUEST' };
  return { retryable: false, code: 'AI_ERROR' };
}

async function withTimeout(run, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(config, model, { system, user, schema, temperature }, signal) {
  const url = `${config.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
        ...(schema ? { responseSchema: schema } : {}),
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: data?.error?.message || `The Gemini API returned ${response.status}.`,
      body: data,
    };
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
  const finishReason = data.candidates?.[0]?.finishReason;
  if (!text && finishReason && finishReason !== 'STOP') {
    return {
      ok: false,
      status: 502,
      message: `The model stopped before returning content (${finishReason}).`,
      body: data,
    };
  }
  return { ok: true, text };
}

async function callOpenAiCompatible(config, model, { system, user, schema, temperature }, signal) {
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: schema ? `${user}\n\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}` : user },
  ];
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: data?.error?.message || `The AI provider returned ${response.status}.`,
      body: data,
    };
  }
  return { ok: true, text: data.choices?.[0]?.message?.content || '' };
}

/**
 * Ask the provider for a single JSON object, retrying transient failures and
 * falling through the model chain. Resolves to { json, model, provider, attempts }.
 * Throws AiUnavailableError when every option is exhausted.
 */
export async function generateJSON({ system, user, schema, temperature = 0.2 } = {}) {
  const config = aiConfig();
  if (config.provider === 'none') {
    throw new AiUnavailableError(
      'No AI provider is configured. Add GEMINI_API_KEY (or AI_API_KEY) to your .env file.',
      { code: 'AI_NOT_CONFIGURED' },
    );
  }

  const models = modelChain(config);
  const delays = retryDelays();
  const jitter = Number.isFinite(Number(process.env.AI_RETRY_JITTER_MS)) ? Number(process.env.AI_RETRY_JITTER_MS) : 400;
  const notes = [];
  let attempts = 0;

  for (const model of models) {
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      attempts += 1;
      const run = config.provider === 'gemini' ? callGemini : callOpenAiCompatible;
      try {
        const outcome = await withTimeout(
          (signal) => run(config, model, { system, user, schema, temperature }, signal),
          config.timeoutMs,
        );

        if (outcome.ok) {
          // An unreadable reply is a normal provider failure, not a reason to
          // abandon the whole chain: try again, then fall through to the next
          // model, exactly as we would for a 5xx.
          try {
            const json = extractJson(outcome.text);
            return { json, model, provider: config.provider, attempts, notes };
          } catch (parseError) {
            notes.push(`${model}: ${parseError.code || 'AI_BAD_JSON'}`);
            if (attempt < delays.length - 1) await sleep(delays[attempt] + Math.random() * jitter);
            continue;
          }
        }

        const { retryable, nextModel, code } = classifyStatus(outcome.status, outcome.message);
        notes.push(`${model}: ${outcome.status} ${code}`);
        if (code === 'AI_AUTH') {
          throw new AiUnavailableError(
            'The AI provider rejected the API key. Check the key in your .env file.',
            { code, attempts, detail: notes },
          );
        }
        // Retired models and exhausted quotas will not recover inside this run.
        if (nextModel) break;
        if (!retryable) break;
        if (attempt < delays.length - 1) await sleep(delays[attempt] + Math.random() * jitter);
      } catch (error) {
        if (error instanceof AiUnavailableError) throw error;
        const reason = error?.name === 'AbortError' ? 'timed out' : error?.message || 'network error';
        // Tag the note so a transport failure is reported as an upstream outage.
        notes.push(`${model}: network ${reason}`);
        if (attempt < delays.length - 1) await sleep(delays[attempt] + Math.random() * jitter);
      }
    }
  }

  const quota = notes.some((note) => note.includes('AI_QUOTA_EXHAUSTED'));
  const upstream = notes.some((note) => /5\d\d|timed out|network/.test(note));
  const message = quota && !upstream
    ? `The AI key has exhausted its quota on every configured model (${models.join(', ')}). Enable billing or supply another key.`
    : upstream
      ? `The AI provider was temporarily unavailable after ${attempts} attempt(s) across ${models.length} model(s).`
      : `The AI provider did not return a usable response after ${attempts} attempt(s).`;
  throw new AiUnavailableError(message, {
    code: quota && !upstream ? 'AI_QUOTA_EXHAUSTED' : upstream ? 'AI_UPSTREAM' : 'AI_UNAVAILABLE',
    attempts,
    detail: notes,
  });
}

/** Is the provider reachable and is the configured model actually usable? */
export async function aiHealthCheck() {
  const config = aiConfig();
  if (config.provider === 'none') {
    return { ok: false, provider: 'none', model: null, code: 'AI_NOT_CONFIGURED', message: 'No AI key is configured.' };
  }
  const startedAt = Date.now();
  try {
    const result = await generateJSON({
      system: 'Reply with JSON only.',
      user: 'Return {"ok":true}',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      temperature: 0,
    });
    return {
      ok: true,
      provider: result.provider,
      model: result.model,
      attempts: result.attempts,
      latencyMs: Date.now() - startedAt,
      message: `${result.provider} answered using ${result.model}.`,
    };
  } catch (error) {
    return {
      ok: false,
      provider: config.provider,
      model: config.model,
      code: error.code || 'AI_ERROR',
      message: error.message,
      detail: error.detail || null,
      latencyMs: Date.now() - startedAt,
    };
  }
}
