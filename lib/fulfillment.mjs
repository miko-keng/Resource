// Fulfillment resolution.
//
// Carrier, tracking and delivery facts are sourced from a chain of providers
// rather than a single hardcoded fixture, because for a real dispute they can
// live in several places — and sometimes nowhere:
//
//   manual          the merchant asserted it directly in the app
//   merchant-order  their order system (today a local fixture, in production a
//                   platform integration)
//   paypal-tracker  GET /v1/shipping/trackers?transaction_id=… — real, but only
//                   populated if someone registered tracking with PayPal
//
// Note what is deliberately NOT a provider: a PayPal capture. It carries amount,
// status and seller_protection and has no shipping field at all, so treating it
// as a fulfillment source would mean inventing data.
//
// Nothing here invents a value. A field no provider supplies stays null and is
// reported as a gap. When providers disagree, the disagreement is surfaced
// rather than silently resolved.
//
// Pure: no I/O, no module state, so every rule is unit-testable.

export const FULFILLMENT_FIELDS = ['carrier', 'tracking_number', 'status', 'shipped_at', 'delivered_at'];

/** Highest precedence first. A merchant's own assertion outranks a copy of it. */
export const PROVIDER_PRECEDENCE = ['manual', 'merchant-order', 'paypal-tracker'];

const ORIGIN_BY_PROVIDER = {
  manual: 'manual',
  'merchant-order': 'local',
  'paypal-tracker': 'paypal',
};

/** How a provider's fact should be labelled in the UI. */
export function originForProvider(source) {
  return ORIGIN_BY_PROVIDER[source] || 'local';
}

function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/** Keep only the known fields, with empty strings normalised to null. */
export function normalizeFulfillment(input = {}) {
  const out = {};
  for (const field of FULFILLMENT_FIELDS) out[field] = clean(input[field]);
  return out;
}

/**
 * Validate a merchant-supplied fulfillment record before storing it.
 * Returns { ok, errors, fulfillment } — never throws.
 */
export function validateFulfillment(input = {}) {
  const fulfillment = normalizeFulfillment(input);
  const errors = [];
  if (!fulfillment.carrier) errors.push('carrier is required');
  if (!fulfillment.tracking_number) errors.push('tracking_number is required');

  for (const field of ['shipped_at', 'delivered_at']) {
    if (fulfillment[field] && Number.isNaN(new Date(fulfillment[field]).getTime())) {
      errors.push(`${field} is not a valid date`);
    }
  }
  if (fulfillment.shipped_at && fulfillment.delivered_at) {
    const shipped = new Date(fulfillment.shipped_at).getTime();
    const delivered = new Date(fulfillment.delivered_at).getTime();
    if (!Number.isNaN(shipped) && !Number.isNaN(delivered) && delivered < shipped) {
      errors.push('delivered_at cannot precede shipped_at');
    }
  }
  return { ok: errors.length === 0, errors, fulfillment };
}

function precedenceRank(source) {
  const index = PROVIDER_PRECEDENCE.indexOf(source);
  return index === -1 ? PROVIDER_PRECEDENCE.length : index;
}

/**
 * Resolve fulfillment facts across providers.
 * @param {{ providers?: Array<{source: string, fulfillment: object}> }} input
 */
export function resolveFulfillment({ providers = [] } = {}) {
  const consulted = providers.map((provider) => provider?.source).filter(Boolean);

  const supplying = providers
    .filter((provider) => provider && provider.fulfillment)
    .map((provider) => ({ source: provider.source, fulfillment: normalizeFulfillment(provider.fulfillment) }))
    .filter((provider) => FULFILLMENT_FIELDS.some((field) => provider.fulfillment[field]))
    .sort((a, b) => precedenceRank(a.source) - precedenceRank(b.source));

  const fulfillment = {};
  const provenance = {};
  const conflicts = [];

  for (const field of FULFILLMENT_FIELDS) {
    const candidates = supplying.filter((provider) => provider.fulfillment[field]);
    fulfillment[field] = null;
    provenance[field] = null;
    if (!candidates.length) continue;

    fulfillment[field] = candidates[0].fulfillment[field];
    provenance[field] = candidates[0].source;

    // Surface disagreement instead of silently preferring one source.
    const distinct = new Set(candidates.map((provider) => String(provider.fulfillment[field]).toLowerCase()));
    if (distinct.size > 1) {
      conflicts.push({
        field,
        values: candidates.map((provider) => ({ value: provider.fulfillment[field], source: provider.source })),
      });
    }
  }

  const gaps = [];
  const hasCarrier = Boolean(fulfillment.carrier);
  const hasTracking = Boolean(fulfillment.tracking_number);
  if (!hasCarrier && !hasTracking) {
    gaps.push({ code: 'NO_TRACKING', detail: 'No carrier or tracking number was available from any source.' });
  } else if (!hasCarrier || !hasTracking) {
    gaps.push({
      code: 'PARTIAL_TRACKING',
      detail: `Only the ${hasCarrier ? 'carrier' : 'tracking number'} is known; PayPal needs both to accept tracking as evidence.`,
    });
  }
  if ((hasCarrier || hasTracking) && !fulfillment.delivered_at) {
    gaps.push({ code: 'NO_DELIVERY_DATE', detail: 'No delivery date is known, so delivery cannot be compared against the dispute timeline.' });
  }

  return {
    fulfillment,
    provenance,
    conflicts,
    gaps,
    consulted,
    resolved_from: supplying.map((provider) => provider.source),
    /** The provider that supplied the carrier or tracking number, for labelling. */
    primary_source: provenance.tracking_number || provenance.carrier || null,
  };
}

/**
 * Fold resolved fulfillment into an order-shaped record so the existing
 * evidence and evidence-plan builders keep working unchanged.
 */
export function applyFulfillment(order, resolved) {
  if (!resolved) return order;
  const supplied = Object.fromEntries(
    Object.entries(resolved.fulfillment).filter(([, value]) => value !== null && value !== undefined),
  );
  const source = resolved.primary_source;
  const origin = source ? originForProvider(source) : (order?.fulfillment_origin || 'local');

  if (!order) {
    if (!supplied.carrier && !supplied.tracking_number) return null;
    return {
      order_id: null,
      invoice_number: null,
      fulfillment: supplied,
      fulfillment_source: source,
      fulfillment_origin: origin,
      communications: [],
      resolved_only: true,
    };
  }
  return {
    ...order,
    fulfillment: { ...(order.fulfillment || {}), ...supplied },
    fulfillment_source: source || order.fulfillment_source || null,
    fulfillment_origin: order.fulfillment_origin || origin,
  };
}
