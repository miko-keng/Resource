// The bounded investigation loop.
//
// A planner chooses a tool and arguments; the loop runs it, records what
// happened, and asks again until the planner says it is done or the step budget
// is spent. The planner is swappable, which is the point:
//
//   llmPlanner            a model decides what to consult, within the budget
//   deterministicPlanner  a fixed decision procedure, no model involved
//
// Both produce the same transcript shape, so the rest of the system does not
// care which one ran, and the deterministic one doubles as the test harness.
//
// The loop is where agency lives, and also where it must stop: an irreversible
// tool is refused outright, whatever the planner asks for.

import { RISK, describeCatalog } from './agent-tools.mjs';

export const DEFAULT_MAX_STEPS = 8;

/**
 * Run one bounded investigation.
 *
 * @param {object}   input
 * @param {string}   input.goal      plain-language objective, shown to the planner
 * @param {Map}      input.catalog   built by buildCatalog()
 * @param {Function} input.planner   async ({goal, tools, transcript, step}) => decision
 * @param {object}  [input.budget]   { maxSteps }
 */
export async function investigate({ goal, catalog, planner, budget = {} }) {
  const maxSteps = Number.isFinite(budget.maxSteps) && budget.maxSteps > 0
    ? Math.floor(budget.maxSteps)
    : DEFAULT_MAX_STEPS;

  const transcript = [];
  const startedAt = Date.now();
  let stoppedReason = 'budget_exhausted';

  for (let step = 0; step < maxSteps; step += 1) {
    let decision;
    try {
      decision = await planner({ goal, tools: describeCatalog(catalog), transcript, step });
    } catch (error) {
      stoppedReason = `planner_error: ${error.message || 'unknown'}`;
      break;
    }

    if (!decision || typeof decision !== 'object') {
      stoppedReason = 'planner_gave_no_decision';
      break;
    }
    if (decision.done) {
      stoppedReason = decision.reason || 'planner_finished';
      break;
    }

    const entry = { step, tool: decision.tool ?? null, args: decision.args ?? {}, why: decision.thought ?? null };
    const tool = catalog.get(decision.tool);

    if (!tool) {
      transcript.push({ ...entry, error: `Unknown tool "${decision.tool}".` });
      continue;
    }
    // Second guard: the planner never sees irreversible tools, and cannot call
    // one even if it somehow names it.
    if (tool.risk === RISK.IRREVERSIBLE) {
      transcript.push({ ...entry, blocked: 'An irreversible action was refused. The agent investigates; a human approves.' });
      stoppedReason = 'blocked_irreversible';
      break;
    }

    try {
      const result = await tool.run(entry.args);
      transcript.push({ ...entry, result });
    } catch (error) {
      transcript.push({ ...entry, error: error.message || 'tool failed' });
    }
  }

  return {
    goal,
    stoppedReason,
    steps: transcript.length,
    ms: Date.now() - startedAt,
    transcript,
  };
}

/**
 * A planner driven by a fixed list of decisions. Useful as the deterministic
 * fallback and as the test harness — no model, fully reproducible.
 */
export function scriptedPlanner(steps = []) {
  let index = 0;
  return async () => {
    if (index >= steps.length) return { done: true, reason: 'script_exhausted', thought: 'No further steps were scripted.' };
    const next = steps[index];
    index += 1;
    return next;
  };
}

/**
 * A planner that repeats one decision procedure until it reports completion.
 * Used when no model is available, and as the fallback when one fails.
 */
export function procedurePlanner(decide) {
  return async (context) => decide(context);
}

/**
 * A model-backed planner. Reads the tool catalog and the transcript so far and
 * returns the next call. Arguments travel as a JSON string so the response
 * schema stays simple and provider-portable.
 */
export function llmPlanner({ generate, maxSteps = DEFAULT_MAX_STEPS }) {
  const schema = {
    type: 'object',
    properties: {
      thought: { type: 'string' },
      tool: { type: 'string' },
      args_json: { type: 'string' },
      done: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['thought'],
  };

  return async ({ goal, tools, transcript, step }) => {
    const system = [
      'You investigate a merchant payment dispute by calling the tools you are given.',
      'You cannot take irreversible actions; they are not offered to you.',
      'Never invent data. If a tool returns nothing, that is a fact: record it and move on.',
      'Call the fewest tools needed to gather evidence, then stop.',
      'Reply with JSON only.',
    ].join(' ');

    const user = JSON.stringify({
      goal,
      step,
      max_steps: maxSteps,
      tools,
      transcript_so_far: transcript.map((entry) => ({
        tool: entry.tool,
        args: entry.args,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.result !== undefined ? { result: entry.result } : {}),
      })),
      instruction: 'Return {thought, tool, args_json} to call a tool, or {thought, done:true, reason} to stop.',
    });

    const { json } = await generate({ system, user, schema, temperature: 0.1 });

    if (json.done) return { done: true, reason: json.reason || 'planner_finished', thought: json.thought };
    let args = {};
    if (typeof json.args_json === 'string' && json.args_json.trim()) {
      try { args = JSON.parse(json.args_json); } catch { args = {}; }
    }
    return { thought: json.thought, tool: json.tool, args };
  };
}
