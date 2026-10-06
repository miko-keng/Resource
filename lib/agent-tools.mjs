// Tool registry for the investigation agent.
//
// A tool is a named, typed capability with an explicit risk level. The agent
// planner may only ever see tools it is allowed to call: `describeCatalog`
// deliberately hides irreversible tools, and `investigate` refuses them again
// at the point of execution. Two independent guards, because "the model will
// behave" is not a safety property.
//
// Pure: no I/O, no module state.

export const RISK = {
  READ: 'read',
  WRITE: 'write',
  IRREVERSIBLE: 'irreversible',
};

const VALID_RISK = new Set(Object.values(RISK));

export function defineTool({ name, description, risk, args = null, run }) {
  if (!name || typeof name !== 'string') throw new Error('A tool needs a name.');
  if (!description || typeof description !== 'string') throw new Error(`Tool "${name}" needs a description.`);
  if (!VALID_RISK.has(risk)) throw new Error(`Tool "${name}" has an invalid risk level: ${risk}`);
  if (typeof run !== 'function') throw new Error(`Tool "${name}" needs a run function.`);
  return { name, description, risk, args, run };
}

export function buildCatalog(definitions = []) {
  const catalog = new Map();
  for (const definition of definitions) {
    if (!definition) continue;
    if (catalog.has(definition.name)) throw new Error(`Duplicate tool name: ${definition.name}`);
    catalog.set(definition.name, definition);
  }
  return catalog;
}

/**
 * What the planner is allowed to see. Irreversible tools are excluded outright,
 * so the planner cannot name what it is not permitted to call.
 */
export function describeCatalog(catalog) {
  return [...catalog.values()]
    .filter((tool) => tool.risk !== RISK.IRREVERSIBLE)
    .map((tool) => ({ name: tool.name, description: tool.description, risk: tool.risk, args: tool.args }));
}

export function irreversibleToolNames(catalog) {
  return [...catalog.values()].filter((tool) => tool.risk === RISK.IRREVERSIBLE).map((tool) => tool.name);
}
