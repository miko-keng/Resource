// Pure dispute logic: evidence planning, formatting, and grounding verification.
//
// Deliberately free of I/O and of any module-level mutable state so every rule
// here can be unit-tested without a server, a network, or a PayPal account.
//
// Evidence rules follow PayPal's "Dispute reasons and evidence" reference:
// https://developer.paypal.com/disputes/reasons-evidence.md
// The accepted evidence types depend on the dispute *reason*, not on what the
// merchant happens to have to hand.

export const EVIDENCE_TYPES = ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'];

/** Evidence types PayPal accepts for each dispute reason. */
export const REASON_EVIDENCE = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND'],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: ['OTHER', 'PROOF_OF_REFUND'],
  UNAUTHORISED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'],
  UNAUTHORIZED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'],
  CREDIT_NOT_PROCESSED: ['PROOF_OF_REFUND', 'OTHER'],
  DUPLICATE_TRANSACTION: ['PROOF_OF_REFUND', 'OTHER'],
  INCORRECT_AMOUNT: ['PROOF_OF_REFUND', 'OTHER'],
  PAYMENT_BY_OTHER_MEANS: ['PROOF_OF_REFUND', 'OTHER'],
  CANCELED_RECURRING_BILLING: ['PROOF_OF_REFUND', 'OTHER'],
  OTHER: ['PROOF_OF_REFUND', 'OTHER'],
};

/** Conservative fallback: only the types PayPal documents for every reason. */
export const DEFAULT_EVIDENCE_TYPES = ['PROOF_OF_REFUND', 'OTHER'];

export function allowedEvidenceTypes(reason) {
  return REASON_EVIDENCE[reason] || DEFAULT_EVIDENCE_TYPES;
}

const REASON_LABELS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Item not as described',
  CREDIT_NOT_PROCESSED: 'Credit not processed',
  UNAUTHORISED: 'Unauthorized transaction',
  UNAUTHORIZED: 'Unauthorized transaction',
  DUPLICATE_TRANSACTION: 'Duplicate transaction',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Payment by other means',
  CANCELED_RECURRING_BILLING: 'Canceled recurring billing',
  OTHER: 'Other reason',
};

export function reasonLabel(reason = '') {
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  const text = String(reason || '').replaceAll('_', ' ').trim().toLowerCase();
  return text || 'Unknown reason';
}

/**
 * Render a date in UTC.
 *
 * PayPal returns dispute, transaction and deadline timestamps in UTC. Rendering
 * them in the host's local timezone made the same record display as a different
 * day in the evidence list than in the raw API response (a UTC+8 machine turned
 * a 2026-09-19T16:20Z shipment into "September 20"). A single explicit timezone
 * keeps the record, the draft and the grounding check telling the same story,
 * and makes the output deterministic under test.
 */
export function fmtDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function moneyLabel(amount) {
  if (!amount) return '';
  const currency = amount.currency_code || amount.currency || '';
  const value = amount.value ?? amount.amount ?? '';
  return `${currency} ${value}`.trim();
}

/**
 * Inline provenance markers are for the merchant's eyes only — never for PayPal.
 * Any residual `[source:id]` marker must be removed before submission.
 */
export function stripCitations(text) {
  return String(text || '')
    .replace(/\s*\[source:[a-z0-9-]+\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Evidence submission construction
 * ------------------------------------------------------------------ */

/**
 * Build the single `evidences[]` entry PayPal expects, for the given type.
 * @throws {Error & {status:number}} when the data that type requires is absent.
 */
export function buildEvidenceEntry({ evidenceType, notes = '', order = null, refundId = null }) {
  const text = stripCitations(notes);
  const fulfillment = order?.fulfillment || {};
  const hasTracking = Boolean(fulfillment.carrier) && Boolean(fulfillment.tracking_number);
  const linkedRefund = refundId || order?.refund_id || null;

  if (!EVIDENCE_TYPES.includes(evidenceType)) {
    throw Object.assign(new Error(`${evidenceType} is not an evidence type PayPal accepts. Supported types: ${EVIDENCE_TYPES.join(', ')}.`), { status: 422 });
  }

  if (evidenceType === 'PROOF_OF_FULFILLMENT') {
    // PayPal accepts carrier + tracking, or notes/documents. Prefer tracking.
    if (hasTracking) {
      return {
        evidence_type: 'PROOF_OF_FULFILLMENT',
        evidence_info: {
          tracking_info: [{ carrier_name: fulfillment.carrier, tracking_number: fulfillment.tracking_number }],
        },
        ...(text ? { notes: text } : {}),
      };
    }
    if (text) return { evidence_type: 'PROOF_OF_FULFILLMENT', notes: text };
    throw Object.assign(new Error('Proof of fulfillment needs either a carrier and tracking number, or notes describing the fulfillment.'), { status: 422 });
  }

  if (evidenceType === 'PROOF_OF_REFUND') {
    if (!linkedRefund) {
      throw Object.assign(new Error('Proof of refund needs a PayPal refund transaction id. None is linked to this order.'), { status: 422 });
    }
    return {
      evidence_type: 'PROOF_OF_REFUND',
      evidence_info: { refund_ids: [linkedRefund] },
      ...(text ? { notes: text } : {}),
    };
  }

  // OTHER
  if (!text) throw Object.assign(new Error('The OTHER evidence type requires notes describing the merchant’s position.'), { status: 422 });
  return { evidence_type: 'OTHER', notes: text };
}

/**
 * Describe every evidence option for a case: what PayPal will accept, what the
 * dispute has explicitly requested, and whether the merchant can actually
 * produce it right now. The UI uses this to disable options that would fail.
 */
export function evidencePlan({ dispute = {}, order = null } = {}) {
  const allowed = allowedEvidenceTypes(dispute.reason);
  const requested = (dispute.evidences || [])
    .filter((item) => item.source === 'REQUESTED_FROM_SELLER')
    .map((item) => item.evidence_type)
    .filter(Boolean);

  const options = allowed.map((type) => {
    const fulfillment = order?.fulfillment || {};
    const hasTracking = Boolean(fulfillment.carrier) && Boolean(fulfillment.tracking_number);
    const linkedRefund = order?.refund_id || null;
    if (type === 'PROOF_OF_FULFILLMENT' && !hasTracking) {
      return { type, available: true, degraded: true, note: 'No carrier and tracking number linked — this would be submitted as notes only.' };
    }
    if (type === 'PROOF_OF_REFUND' && !linkedRefund) {
      return { type, available: false, degraded: false, note: 'No PayPal refund transaction id is linked to this order.' };
    }
    return { type, available: true, degraded: false, note: '' };
  });

  // PayPal's own requested types win if they contradict our table.
  const preferred = requested.find((type) => allowed.includes(type)) || requested[0] || allowed[0];

  return { allowed, requested, options, preferred };
}

/* ------------------------------------------------------------------ *
 * Deadline watchdog
 * ------------------------------------------------------------------ */

/**
 * Turn a seller response deadline into an urgency signal.
 * Thresholds are deliberately conservative: a dispute that needs evidence
 * should be visibly urgent before the window closes, not after.
 */
export function deadlineInfo(dueDate, now = Date.now()) {
  if (!dueDate) return { due: null, hoursRemaining: null, daysRemaining: null, urgency: 'unknown', label: 'No PayPal deadline provided' };
  const target = new Date(dueDate).getTime();
  if (Number.isNaN(target)) return { due: dueDate, hoursRemaining: null, daysRemaining: null, urgency: 'unknown', label: 'Deadline could not be read' };

  const ms = target - now;
  const hours = Math.round(ms / 3_600_000);
  const days = Math.floor(ms / 86_400_000);

  let urgency = 'ok';
  if (ms < 0) urgency = 'overdue';
  else if (hours <= 48) urgency = 'urgent';
  else if (hours <= 120) urgency = 'soon';

  const label = urgency === 'overdue'
    ? `Overdue by ${Math.abs(hours)} hour${Math.abs(hours) === 1 ? '' : 's'}`
    : `${Math.max(0, days)} day${days === 1 ? '' : 's'} left`;

  return { due: dueDate, hoursRemaining: hours, daysRemaining: days, urgency, label };
}

/* ------------------------------------------------------------------ *
 * Grounding verification
 * ------------------------------------------------------------------ */

const CLAIM_PATTERNS = [
  { kind: 'amount', re: /\b(?:myr|usd|rm|\$|€|£)\s?\d[\d,]*(?:\.\d{1,2})?\b|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:myr|usd)\b/gi },
  { kind: 'reference', re: /\b[A-Z0-9]{10,}\b/g },
  { kind: 'date', re: /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?\b/gi },
  { kind: 'order', re: /\b(?:ord|rc|pp)[-\s]?\d{3,}\b/gi },
];

/**
 * Independent grounding pass: extract every checkable claim from the drafted
 * prose and confirm it actually appears in the linked source records, so an
 * invented amount, date or tracking number is surfaced rather than sent.
 */
export function verifyClaims(text, evidence = []) {
  const haystack = evidence
    .map((item) => `${item.title || ''} ${item.fact || ''} ${item.source || ''}`)
    .join(' ')
    .toLowerCase()
    .replace(/[\s,]/g, '');

  const seen = new Set();
  const claims = [];

  for (const { kind, re } of CLAIM_PATTERNS) {
    for (const match of String(text || '').matchAll(re)) {
      const raw = match[0].trim();
      const needle = raw.toLowerCase().replace(/[\s,]/g, '');
      const key = `${kind}:${needle}`;
      if (!needle || seen.has(key)) continue;
      seen.add(key);
      claims.push({ kind, text: raw, supported: haystack.includes(needle) });
    }
  }

  const unsupported = claims.filter((claim) => !claim.supported);
  return {
    checked: claims.length,
    unsupported,
    status: unsupported.length ? 'review' : claims.length ? 'verified' : 'no_quantitative_claims',
  };
}

/** Deterministic draft assembled only from source records. No model involved. */
export function deterministicDraft(dispute, order, evidence = []) {
  const fulfillment = evidence.find((item) => item.id === 'fulfillment');
  const messages = evidence.filter((item) => item.id.startsWith('communication-'));
  const parts = [];
  if (fulfillment) parts.push(fulfillment.fact);
  for (const message of messages) parts.push(message.fact);
  if (!parts.length) {
    const transaction = evidence.find((item) => item.id === 'paypal-transaction');
    parts.push(transaction
      ? `${transaction.fact} Our fulfilment records for this order are not available to this workspace.`
      : 'Our records for this case are not complete and we are still gathering the documentation.');
  }
  parts.push('We are providing the records we hold so PayPal can review the full picture.');
  return parts.join(' ');
}

/** Missing-fact observations a reviewer should see before filing. */
export function deterministicMissing(dispute, order) {
  const missing = [];
  if (!order?.fulfillment?.tracking_number) missing.push('No tracking number is stored against this order.');
  // No unconditional signature/address claim: this data model never collects
  // either, so asserting their absence would be unfounded. The cross-check
  // reports what is actually unknown.
  if (/CREDIT_NOT_PROCESSED/.test(dispute?.reason || '') && !order?.refund_id) {
    missing.push('No PayPal refund transaction id is linked to this local order.');
  }
  if ((order?.communications || []).some((m) => /return label/i.test(m.summary || '')) && !order?.return_tracking) {
    missing.push('A return label was offered, but no return tracking scan is recorded.');
  }
  return missing;
}

/* ------------------------------------------------------------------ *
 * Evidence sources
 * ------------------------------------------------------------------ */

/**
 * Assemble every fact the app is allowed to rely on, tagged with where it came
 * from, so synthetic merchant records can never be presented as PayPal facts.
 * `origin`: paypal | local | buyer
 */
export function buildEvidence(dispute, order, paypalTransaction) {
  const evidence = [];

  if (dispute) {
    evidence.push({
      id: 'paypal-dispute',
      origin: 'paypal',
      fact: `PayPal records dispute ${dispute.id || dispute.dispute_id} as ${reasonLabel(dispute.reason).toLowerCase()} for ${moneyLabel(dispute.dispute_amount) || 'an undisclosed amount'}${dispute.dispute_life_cycle_stage ? `, at the ${String(dispute.dispute_life_cycle_stage).toLowerCase()} stage` : ''}${dispute.status ? `, with status ${String(dispute.status).replaceAll('_', ' ').toLowerCase()}` : ''}${dispute.seller_response_due_date ? `, and a seller response due ${fmtDate(dispute.seller_response_due_date)}` : ''}.`,
      title: `PayPal dispute · ${reasonLabel(dispute.reason)}`,
      source: 'PayPal Disputes API',
      at: dispute.create_time,
      relevance: 'The authoritative case record returned by PayPal.',
    });

    if (dispute.buyer?.name || dispute.buyer?.email_address) {
      evidence.push({
        id: 'paypal-buyer',
        origin: 'paypal',
        fact: `PayPal identifies the buyer as ${[dispute.buyer?.name, dispute.buyer?.email_address].filter(Boolean).join(', ')}.`,
        title: 'Buyer identity from PayPal',
        source: 'PayPal Disputes API',
        at: dispute.create_time,
        relevance: 'Buyer identity as returned by PayPal rather than asserted locally.',
      });
    }

    for (const [index, item] of (dispute.evidences || []).filter((e) => e.source === 'REQUESTED_FROM_SELLER').entries()) {
      evidence.push({
        id: `paypal-requested-${index + 1}`,
        origin: 'paypal',
        fact: `PayPal has asked the seller to provide ${String(item.evidence_type || 'evidence').replaceAll('_', ' ').toLowerCase()} for this case.`,
        title: `PayPal requested ${String(item.evidence_type || 'evidence').replaceAll('_', ' ').toLowerCase()}`,
        source: 'PayPal Disputes API',
        at: dispute.update_time || dispute.create_time,
        relevance: 'Defines what PayPal will actually accept from the seller.',
      });
    }

    for (const [index, message] of (dispute.messages || []).entries()) {
      const postedBy = String(message.posted_by || 'PAYPAL').toLowerCase();
      evidence.push({
        id: `paypal-message-${index + 1}`,
        origin: postedBy === 'buyer' ? 'buyer' : 'paypal',
        fact: `${fmtDate(message.time_posted)} (${postedBy}): ${message.content || ''}`.trim(),
        title: `${postedBy === 'buyer' ? 'Buyer' : postedBy === 'seller' ? 'Merchant' : 'PayPal'} message in the case thread`,
        source: 'PayPal dispute messages',
        at: message.time_posted,
        relevance: 'Communication exchanged inside the PayPal case itself.',
      });
    }
  }

  if (paypalTransaction) {
    evidence.push({
      id: 'paypal-transaction',
      origin: 'paypal',
      fact: `PayPal reports transaction ${paypalTransaction.transaction_id || 'unknown'} as ${paypalTransaction.status || 'unknown'}${paypalTransaction.amount ? ` for ${moneyLabel(paypalTransaction.amount)}` : ''}${paypalTransaction.created_at ? `, initiated ${fmtDate(paypalTransaction.created_at)}` : ''}${paypalTransaction.payer_email ? `, paid by ${paypalTransaction.payer_email}` : ''}.`,
      title: `PayPal transaction ${paypalTransaction.transaction_id || ''}`.trim(),
      source: 'PayPal Reporting / Payments API',
      at: paypalTransaction.created_at,
      relevance: 'The underlying payment record this dispute is attached to.',
    });
  }

  if (order?.fulfillment && (order.fulfillment.carrier || order.fulfillment.tracking_number)) {
    const fulfillment = order.fulfillment;
    // Label the fact by the provider that actually supplied it, so a value read
    // from PayPal is never presented as the merchant system\'s word (or vice versa).
    const providerLabels = {
      'paypal-tracker': { origin: 'paypal', source: 'PayPal Shipment Tracking API', relevance: 'Tracking registered with PayPal against this transaction.' },
      manual: { origin: 'manual', source: 'Merchant-entered tracking', relevance: 'Tracking recorded in Recourse by the merchant for this case.' },
      'merchant-order': { origin: 'local', source: `Local tracking record · ${order.order_id || 'unknown order'}`, relevance: 'Carrier fulfilment details recorded in the merchant’s order system.' },
    };
    const label = providerLabels[order.fulfillment_source] || providerLabels['merchant-order'];
    const status = fulfillment.delivery_status || fulfillment.status;
    const reference = order.order_id ? `Order ${order.order_id}` : 'This order';
    evidence.push({
      id: 'fulfillment',
      origin: order.fulfillment_origin || label.origin,
      fact: `${reference} was shipped via ${fulfillment.carrier} on ${fmtDate(fulfillment.shipped_at)}, with tracking ${fulfillment.tracking_number}.${status ? ` The carrier marked it ${String(status).toLowerCase()} on ${fmtDate(fulfillment.delivered_at)}.` : ''}`,
      title: `Carrier scan: ${status || 'status unknown'}`,
      source: label.source,
      at: fulfillment.delivered_at,
      relevance: label.relevance,
    });
  }

  for (const [index, message] of (order?.communications || []).entries()) {
    evidence.push({
      id: `communication-${index + 1}`,
      origin: 'local',
      fact: `${fmtDate(message.at)} (${message.channel}): ${message.summary}`,
      title: message.summary,
      source: `Local ${message.channel} record · ${order.order_id}`,
      at: message.at,
      relevance: 'Communication record stored by the merchant for this order.',
    });
  }

  if (order?.refund_id) {
    evidence.push({
      id: 'local-refund',
      origin: 'local',
      fact: `The merchant system records refund ${order.refund_id} against order ${order.order_id}.`,
      title: 'Refund recorded locally',
      source: `Local refund record · ${order.order_id}`,
      at: order.updated_at || order.ordered_at,
      relevance: 'Shows a refund was issued, which PayPal must also be able to see.',
    });
  }

  return evidence;
}

/* ------------------------------------------------------------------ *
 * HATEOAS action matching
 *
 * PayPal's live sandbox returns dispute action names with underscores
 * (`provide_evidence`, `accept_claim`) while its documentation and other
 * API versions use hyphens (`provide-evidence`). Matching on an exact
 * string therefore silently hides actions that PayPal has actually
 * offered — which is how the submit flow can appear unavailable on a case
 * that is genuinely ready for evidence. Compare on a normalised name.
 * ------------------------------------------------------------------ */

export function normalizeRel(rel = '') {
  return String(rel).trim().toLowerCase().replace(/[_\s]+/g, '-');
}

export function findAction(links = [], action) {
  const wanted = normalizeRel(action);
  return (links || []).find((link) => normalizeRel(link.rel) === wanted) || null;
}

export function hasAction(links = [], action) {
  return Boolean(findAction(links, action));
}

/* ------------------------------------------------------------------ *
 * Cross-check: compare the records against each other
 *
 * The evidence builders assemble facts and the grounding check proves the
 * draft matches them. Neither asks whether the records agree with one
 * another. That is this function.
 *
 * Findings carry a direction rather than being a flat list of "errors":
 *   risks    — records that conflict, or that weaken the position
 *   supports — facts that actively help the merchant
 *   gaps     — what simply is not known
 *
 * Two rules are absolute:
 *   1. No check may fire on missing data. Absence is a gap, never a risk.
 *   2. Every finding cites the source ids it came from. A finding without
 *      sources is an assertion, not evidence.
 * ------------------------------------------------------------------ */

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function crossCheck({ dispute = {}, order = null, fulfillment = null, capture = null } = {}) {
  const risks = [];
  const supports = [];
  const gaps = [];

  const facts = fulfillment?.fulfillment || order?.fulfillment || {};
  const status = facts.delivery_status || facts.status || null;
  const deliveredAt = timestamp(facts.delivered_at);
  const shippedAt = timestamp(facts.shipped_at);
  const disputedAt = timestamp(dispute.create_time);
  const disputeAmount = numeric(dispute.dispute_amount?.value);
  const captureAmount = numeric(capture?.amount?.value);
  const disputeCurrency = dispute.dispute_amount?.currency_code || null;
  const captureCurrency = capture?.amount?.currency_code || null;

  /* ------------------------------ risks ------------------------------ */

  // A buyer may legitimately dispute part of a payment, so a difference is a
  // review item, not necessarily an error — but the merchant must know which.
  if (disputeAmount !== null && captureAmount !== null) {
    const sameCurrency = disputeCurrency === captureCurrency;
    if (!sameCurrency || disputeAmount !== captureAmount) {
      const partial = sameCurrency && disputeAmount < captureAmount;
      risks.push({
        code: partial ? 'PARTIAL_DISPUTE' : 'AMOUNT_MISMATCH',
        severity: 'review',
        detail: partial
          ? `The dispute covers ${disputeCurrency} ${disputeAmount} of a ${captureCurrency} ${captureAmount} payment. Confirm the buyer is disputing part of the transaction rather than all of it.`
          : `The dispute amount (${disputeCurrency || '?'} ${disputeAmount}) does not match the payment amount (${captureCurrency || '?'} ${captureAmount}). Check this dispute is attached to the expected transaction.`,
        source_ids: ['paypal-dispute', 'paypal-transaction'],
      });
    }
  }

  if (shippedAt !== null && deliveredAt !== null && deliveredAt < shippedAt) {
    risks.push({
      code: 'DELIVERY_BEFORE_SHIPMENT',
      severity: 'high',
      detail: `The delivery date (${fmtDate(facts.delivered_at)}) precedes the shipment date (${fmtDate(facts.shipped_at)}). These records contradict each other and would be challenged.`,
      source_ids: ['fulfillment'],
    });
  }

  if (deliveredAt !== null && disputedAt !== null && deliveredAt > disputedAt) {
    risks.push({
      code: 'DELIVERY_AFTER_DISPUTE',
      severity: 'high',
      detail: `The carrier reports delivery on ${fmtDate(facts.delivered_at)}, after the dispute was opened on ${fmtDate(dispute.create_time)}. The buyer may have been correct at the time they filed.`,
      source_ids: ['fulfillment', 'paypal-dispute'],
    });
  }

  // Matched by invoice rather than by transaction id: the order may not be the
  // one actually disputed.
  const disputeTxn = (dispute.disputed_transactions || [])[0]?.seller_transaction_id
    || (dispute.disputed_transactions || [])[0]?.transaction_id
    || null;
  if (order?.paypal_transaction_id && disputeTxn && order.paypal_transaction_id !== disputeTxn) {
    risks.push({
      code: 'TRANSACTION_MISMATCH',
      severity: 'high',
      detail: `The matched order references transaction ${order.paypal_transaction_id} but the dispute is against ${disputeTxn}. Recourse may be assembling evidence for the wrong order.`,
      source_ids: ['paypal-dispute', 'fulfillment'],
    });
  }

  const refundDiscussed = (order?.communications || []).some((m) => /refund|credit/i.test(m.summary || ''))
    || /CREDIT_NOT_PROCESSED/.test(dispute.reason || '');
  if (refundDiscussed && !order?.refund_id) {
    risks.push({
      code: 'REFUND_MENTIONED_NO_ID',
      severity: 'medium',
      detail: 'A refund or credit is discussed in this case, but no PayPal refund transaction id is linked to the order.',
      source_ids: ['paypal-dispute'],
    });
  }

  for (const conflict of fulfillment?.conflicts || []) {
    const values = conflict.values.map((entry) => `${entry.source} says "${entry.value}"`).join(', ');
    risks.push({
      code: 'FULFILLMENT_CONFLICT',
      severity: 'medium',
      detail: `Sources disagree about the ${conflict.field.replaceAll('_', ' ')}: ${values}.`,
      source_ids: ['fulfillment'],
    });
  }

  /* ---------------------------- supports ----------------------------- */

  if (/NOT_RECEIVED/.test(dispute.reason || '') && /delivered/i.test(status || '')) {
    const before = deliveredAt !== null && disputedAt !== null && deliveredAt <= disputedAt;
    supports.push({
      code: 'CLAIM_VS_DELIVERED',
      severity: 'high',
      detail: before
        ? `The buyer claims non-receipt, but the carrier recorded delivery on ${fmtDate(facts.delivered_at)} — before the dispute was opened on ${fmtDate(dispute.create_time)}. This is the central fact of the response.`
        : `The buyer claims non-receipt, and the carrier record shows "${status}". This supports the response.`,
      source_ids: ['fulfillment', 'paypal-dispute'],
    });
  }

  const protection = capture?.seller_protection;
  if (protection?.status === 'ELIGIBLE') {
    supports.push({
      code: 'SELLER_PROTECTION_ELIGIBLE',
      severity: 'medium',
      detail: `PayPal marks this payment eligible for seller protection${(protection.dispute_categories || []).length ? ` for ${protection.dispute_categories.join(', ').toLowerCase()}` : ''}.`,
      source_ids: ['paypal-transaction'],
    });
  }

  /* ------------------------------ gaps ------------------------------- */

  for (const gap of fulfillment?.gaps || []) gaps.push({ code: gap.code, detail: gap.detail, source_ids: [] });

  // Deliberately no "missing signature"/"missing address" claim: this data model
  // never collects either, so asserting their absence would be unfounded. That
  // limitation belongs in the README, not in a per-case finding.
  // The resolver already reports NO_TRACKING / PARTIAL_TRACKING for this; do not duplicate it.

  return { risks, supports, gaps };
}
