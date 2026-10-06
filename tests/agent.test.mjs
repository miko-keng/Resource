// Unit tests for the agent loop and tool registry. No server, no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_STEPS, investigate, llmPlanner, procedurePlanner, scriptedPlanner } from '../lib/agent.mjs';
import { RISK, buildCatalog, defineTool, describeCatalog, irreversibleToolNames } from '../lib/agent-tools.mjs';

function readTool(name, run = async () => 'ok') {
  return defineTool({ name, description: `${name} does a thing`, risk: RISK.READ, run });
}

function catalogOf(...tools) {
  return buildCatalog(tools);
}

/* ------------------------------------------------------ tool registry */

test('a tool must declare a name, description, valid risk and a run function', () => {
  assert.throws(() => defineTool({ description: 'x', risk: RISK.READ, run: async () => {} }), /needs a name/);
  assert.throws(() => defineTool({ name: 'a', risk: RISK.READ, run: async () => {} }), /needs a description/);
  assert.throws(() => defineTool({ name: 'a', description: 'x', risk: 'dangerous', run: async () => {} }), /invalid risk/);
  assert.throws(() => defineTool({ name: 'a', description: 'x', risk: RISK.READ }), /needs a run function/);
});

test('duplicate tool names are rejected at build time', () => {
  assert.throws(() => catalogOf(readTool('dup'), readTool('dup')), /Duplicate tool name/);
});

test('the planner never sees irreversible tools', () => {
  const catalog = catalogOf(
    readTool('safe'),
    defineTool({ name: 'file_evidence', description: 'irreversible', risk: RISK.IRREVERSIBLE, run: async () => {} }),
  );
  const visible = describeCatalog(catalog).map((tool) => tool.name);
  assert.deepEqual(visible, ['safe']);
  assert.deepEqual(irreversibleToolNames(catalog), ['file_evidence']);
});

/* --------------------------------------------------------- the loop */

test('the loop runs the planner to completion and records a transcript', async () => {
  const calls = [];
  const catalog = catalogOf(
    readTool('first', async () => { calls.push('first'); return { found: 1 }; }),
    readTool('second', async () => { calls.push('second'); return { found: 2 }; }),
  );
  const result = await investigate({
    goal: 'gather',
    catalog,
    planner: scriptedPlanner([
      { thought: 'start here', tool: 'first', args: {} },
      { thought: 'then here', tool: 'second', args: { x: 1 } },
      { thought: 'done', done: true, reason: 'enough' },
    ]),
  });

  assert.equal(result.stoppedReason, 'enough');
  assert.equal(result.steps, 2);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(result.transcript[0].why, 'start here');
  assert.deepEqual(result.transcript[1].result, { found: 2 });
  assert.deepEqual(result.transcript[1].args, { x: 1 });
});

test('an irreversible tool is refused even when the planner names it', async () => {
  let ran = false;
  const catalog = catalogOf(
    readTool('safe'),
    defineTool({ name: 'file_evidence', description: 'irreversible', risk: RISK.IRREVERSIBLE, run: async () => { ran = true; return 'filed'; } }),
  );
  const result = await investigate({
    goal: 'try to file',
    catalog,
    planner: scriptedPlanner([{ thought: 'file it', tool: 'file_evidence', args: {} }]),
  });

  assert.equal(ran, false, 'the irreversible tool must never execute');
  assert.equal(result.stoppedReason, 'blocked_irreversible');
  assert.equal(result.transcript.at(-1).blocked.includes('irreversible'), true);
});

test('the loop stops at the step budget', async () => {
  const catalog = catalogOf(readTool('spin', async () => 'again'));
  let n = 0;
  const result = await investigate({
    goal: 'spin forever',
    catalog,
    planner: async () => { n += 1; return { thought: 'again', tool: 'spin', args: {} }; },
    budget: { maxSteps: 3 },
  });

  assert.equal(result.stoppedReason, 'budget_exhausted');
  assert.equal(result.steps, 3);
  assert.equal(n, 3);
});

test('the default budget is bounded', async () => {
  const catalog = catalogOf(readTool('spin', async () => 'again'));
  const result = await investigate({ goal: 'spin', catalog, planner: async () => ({ tool: 'spin', args: {} }) });
  assert.equal(result.steps, DEFAULT_MAX_STEPS);
});

test('an unknown tool is recorded and the loop continues', async () => {
  const catalog = catalogOf(readTool('real'));
  const result = await investigate({
    goal: 'g',
    catalog,
    planner: scriptedPlanner([
      { thought: 'invent one', tool: 'does_not_exist', args: {} },
      { thought: 'use the real one', tool: 'real', args: {} },
      { done: true, reason: 'ok' },
    ]),
  });

  assert.equal(result.transcript[0].error.includes('Unknown tool'), true);
  assert.equal(result.transcript[1].tool, 'real');
  assert.equal(result.stoppedReason, 'ok');
});

test('a tool that throws is recorded, not fatal', async () => {
  const catalog = catalogOf(readTool('boom', async () => { throw new Error('tracker unavailable'); }));
  const result = await investigate({
    goal: 'g',
    catalog,
    planner: scriptedPlanner([{ thought: 'try it', tool: 'boom', args: {} }, { done: true, reason: 'gave up' }]),
  });

  assert.equal(result.transcript[0].error, 'tracker unavailable');
  assert.equal(result.stoppedReason, 'gave up');
});

test('a planner that throws stops the loop with a reason', async () => {
  const catalog = catalogOf(readTool('any'));
  const result = await investigate({ goal: 'g', catalog, planner: async () => { throw new Error('model offline'); } });
  assert.match(result.stoppedReason, /^planner_error: model offline$/);
  assert.equal(result.steps, 0);
});

test('a planner returning nothing usable stops cleanly', async () => {
  const catalog = catalogOf(readTool('any'));
  const result = await investigate({ goal: 'g', catalog, planner: async () => null });
  assert.equal(result.stoppedReason, 'planner_gave_no_decision');
});

test('the loop never invents data — a null result is recorded as null', async () => {
  const catalog = catalogOf(readTool('empty', async () => null));
  const result = await investigate({ goal: 'g', catalog, planner: scriptedPlanner([{ tool: 'empty', args: {} }, { done: true, reason: 'ok' }]) });
  assert.equal(result.transcript[0].result, null);
});

/* ------------------------------------------------------- planners */

test('procedurePlanner repeats one decision procedure', async () => {
  let state = 0;
  const planner = procedurePlanner(async () => {
    state += 1;
    if (state < 3) return { thought: 'more', tool: 'step', args: {} };
    return { done: true, reason: 'finished', thought: 'stop' };
  });
  const catalog = catalogOf(readTool('step', async () => `state ${state}`));
  const result = await investigate({ goal: 'g', catalog, planner });
  assert.equal(result.steps, 2);
  assert.equal(result.stoppedReason, 'finished');
});

test('llmPlanner reads a tool call and parses its JSON arguments', async () => {
  const planner = llmPlanner({
    generate: async () => ({ json: { thought: 'need the dispute', tool: 'get_dispute', args_json: '{"id":"PP-1"}' } }),
  });
  const decision = await planner({ goal: 'g', tools: [], transcript: [], step: 0 });
  assert.equal(decision.tool, 'get_dispute');
  assert.deepEqual(decision.args, { id: 'PP-1' });
  assert.equal(decision.thought, 'need the dispute');
});

test('llmPlanner surfaces completion and tolerates unparseable arguments', async () => {
  const done = llmPlanner({ generate: async () => ({ json: { thought: 'enough', done: true, reason: 'have it all' } }) });
  assert.equal((await done({ goal: 'g', tools: [], transcript: [], step: 1 })).done, true);

  const broken = llmPlanner({ generate: async () => ({ json: { thought: 'x', tool: 'get_dispute', args_json: 'not json' } }) });
  assert.deepEqual((await broken({ goal: 'g', tools: [], transcript: [], step: 0 })).args, {});
});

test('llmPlanner tells the model which tools exist and what already happened', async () => {
  let seen = null;
  const planner = llmPlanner({
    generate: async ({ user }) => { seen = JSON.parse(user); return { json: { thought: 'ok', done: true, reason: 'done' } }; },
  });
  await planner({
    goal: 'assemble a packet',
    tools: [{ name: 'get_dispute', description: 'loads it', risk: 'read' }],
    transcript: [{ tool: 'get_dispute', args: {}, result: { reason: 'X' } }],
    step: 1,
  });

  assert.equal(seen.goal, 'assemble a packet');
  assert.equal(seen.tools[0].name, 'get_dispute');
  assert.equal(seen.transcript_so_far[0].tool, 'get_dispute');
  assert.equal(seen.step, 1);
});
