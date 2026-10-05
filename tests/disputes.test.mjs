// Unit tests for the pure dispute logic. No server, no network, no PayPal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EVIDENCE_TYPES,
  allowedEvidenceTypes,
  buildEvidenceEntry,
  deadlineInfo,
  deterministicDraft,
  evidencePlan,
  fmtDate,
  findAction,
  hasAction,
  moneyLabel,
  normalizeRel,
  reasonLabel,
  stripCitations,
  verifyClaims,
} from '../lib/disputes.mjs';

/* ------------------------------------------------------------ reasons */

test('allowedEvidenceTypes follows PayPal per-reason rules', () => {
  assert.deepEqual(allowedEvidenceTypes('MERCHANDISE_OR_SERVICE_NOT_RECEIVED'), ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND']);
  assert.deepEqual(allowedEvidenceTypes('UNAUTHORISED'), ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER']);
  assert.deepEqual(allowedEvidenceTypes('CREDIT_NOT_PROCESSED'), ['PROOF_OF_REFUND', 'OTHER']);
  // An unknown reason must not silently widen what we are willing to submit.
  assert.deepEqual(allowedEvidenceTypes('SOME_FUTURE_REASON'), DEFAULT_EVIDENCE_TYPES);
  assert.deepEqual(allowedEvidenceTypes(undefined), DEFAULT_EVIDENCE_TYPES);
});

test('reasonLabel is human readable and tolerates unknown reasons', () => {
  assert.equal(reasonLabel('MERCHANDISE_OR_SERVICE_NOT_RECEIVED'), 'Item not received');
  assert.equal(reasonLabel('UNAUTHORISED'), 'Unauthorized transaction');
  assert.equal(reasonLabel('BRAND_NEW_REASON'), 'brand new reason');
  assert.equal(reasonLabel(''), 'Unknown reason');
});

/* --------------------------------------------------------- formatting */

test('fmtDate renders in UTC so a record cannot shift a day between views', () => {
  // 16:20Z is 00:20 the *next* day at UTC+8. Local-time rendering produced
  // "September 20" here while the raw PayPal record said the 19th.
  assert.equal(fmtDate('2026-09-19T16:20:00Z'), 'September 19, 2026');
  assert.equal(fmtDate('2026-01-01T00:00:00Z'), 'January 1, 2026');
  assert.equal(fmtDate(undefined), '');
  assert.equal(fmtDate('not-a-date'), 'not-a-date');
});

test('moneyLabel formats both PayPal amount shapes', () => {
  assert.equal(moneyLabel({ currency_code: 'MYR', value: '10.00' }), 'MYR 10.00');
  assert.equal(moneyLabel({ currency: 'USD', amount: '5.00' }), 'USD 5.00');
  assert.equal(moneyLabel(null), '');
});

test('stripCitations removes every provenance marker and tidies spacing', () => {
  assert.equal(stripCitations('Shipped on time [source:fulfillment].'), 'Shipped on time.');
  assert.equal(stripCitations('A [source:x] B [source:y] C'), 'A B C');
  assert.equal(stripCitations('Done [source:a] .'), 'Done.');
  assert.equal(stripCitations(''), '');
  assert.equal(stripCitations(null), '');
});

/* ------------------------------------------------ evidence submission */

test('PROOF_OF_FULFILLMENT prefers carrier and tracking', () => {
  const entry = buildEvidenceEntry({
    evidenceType: 'PROOF_OF_FULFILLMENT',
    notes: 'Shipped promptly.',
    order: { fulfillment: { carrier: 'USPS', tracking_number: '9400111899223856921048' } },
  });
  assert.equal(entry.evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.deepEqual(entry.evidence_info.tracking_info, [
    { carrier_name: 'USPS', tracking_number: '9400111899223856921048' },
  ]);
  assert.equal(entry.notes, 'Shipped promptly.');
});

test('PROOF_OF_FULFILLMENT falls back to notes when no tracking exists', () => {
  const entry = buildEvidenceEntry({ evidenceType: 'PROOF_OF_FULFILLMENT', notes: 'Hand delivered.', order: null });
  assert.equal(entry.evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.equal(entry.evidence_info, undefined);
  assert.equal(entry.notes, 'Hand delivered.');
});

test('PROOF_OF_FULFILLMENT with neither tracking nor notes is rejected', () => {
  assert.throws(
    () => buildEvidenceEntry({ evidenceType: 'PROOF_OF_FULFILLMENT', notes: '', order: null }),
    (error) => error.status === 422,
  );
});

test('PROOF_OF_REFUND requires a refund id and uses refund_ids', () => {
  const entry = buildEvidenceEntry({ evidenceType: 'PROOF_OF_REFUND', notes: 'Refunded.', refundId: 'REF-1' });
  assert.deepEqual(entry.evidence_info.refund_ids, ['REF-1']);
  assert.throws(
    () => buildEvidenceEntry({ evidenceType: 'PROOF_OF_REFUND', notes: 'x', order: null }),
    (error) => error.status === 422,
  );
});

test('PROOF_OF_REFUND reads the refund id from the order when not passed', () => {
  const entry = buildEvidenceEntry({ evidenceType: 'PROOF_OF_REFUND', order: { refund_id: 'REF-9' } });
  assert.deepEqual(entry.evidence_info.refund_ids, ['REF-9']);
});

test('OTHER requires notes and an unknown type is rejected', () => {
  assert.equal(buildEvidenceEntry({ evidenceType: 'OTHER', notes: 'Our position.' }).notes, 'Our position.');
  assert.throws(() => buildEvidenceEntry({ evidenceType: 'OTHER', notes: '' }), (error) => error.status === 422);
  assert.throws(() => buildEvidenceEntry({ evidenceType: 'PROOF_OF_DELIVERY', notes: 'x' }), (error) => error.status === 422);
});

test('submitted evidence never carries citation markers', () => {
  const entry = buildEvidenceEntry({ evidenceType: 'OTHER', notes: 'We shipped it [source:fulfillment].' });
  assert.equal(entry.notes, 'We shipped it.');
});

/* -------------------------------------------------------- evidence plan */

test('evidencePlan reports what PayPal accepts and what is actually producible', () => {
  const plan = evidencePlan({
    dispute: {
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      evidences: [{ source: 'REQUESTED_FROM_SELLER', evidence_type: 'PROOF_OF_FULFILLMENT' }],
    },
    order: { fulfillment: { carrier: 'USPS', tracking_number: 'T1' } },
  });
  assert.deepEqual(plan.allowed, ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND']);
  assert.deepEqual(plan.requested, ['PROOF_OF_FULFILLMENT']);
  assert.equal(plan.preferred, 'PROOF_OF_FULFILLMENT');
  assert.equal(plan.options.find((o) => o.type === 'PROOF_OF_REFUND').available, false);
});

test('evidencePlan marks fulfillment as degraded without tracking', () => {
  const plan = evidencePlan({ dispute: { reason: 'UNAUTHORISED' }, order: { fulfillment: {} } });
  const option = plan.options.find((o) => o.type === 'PROOF_OF_FULFILLMENT');
  assert.equal(option.available, true);
  assert.equal(option.degraded, true);
});

/* ---------------------------------------------------- deadline watchdog */

test('deadlineInfo classifies urgency against a fixed clock', () => {
  const now = Date.parse('2026-10-04T00:00:00Z');
  // Boundaries are inclusive: >120h ok, <=120h soon, <=48h urgent, past overdue.
  assert.equal(deadlineInfo('2026-10-10T00:00:00Z', now).urgency, 'ok');      // 144h
  assert.equal(deadlineInfo('2026-10-09T00:00:00Z', now).urgency, 'soon');    // 120h boundary
  assert.equal(deadlineInfo('2026-10-07T00:00:00Z', now).urgency, 'soon');    // 72h
  assert.equal(deadlineInfo('2026-10-06T00:00:00Z', now).urgency, 'urgent');  // 48h boundary
  assert.equal(deadlineInfo('2026-10-05T00:00:00Z', now).urgency, 'urgent');  // 24h
  assert.equal(deadlineInfo('2026-10-01T00:00:00Z', now).urgency, 'overdue');
  assert.equal(deadlineInfo(null, now).urgency, 'unknown');
  assert.equal(deadlineInfo('rubbish', now).urgency, 'unknown');
});

test('deadlineInfo does not report negative days remaining', () => {
  const now = Date.parse('2026-10-04T00:00:00Z');
  const info = deadlineInfo('2026-10-01T00:00:00Z', now);
  assert.ok(info.daysRemaining < 0);
  assert.match(info.label, /^Overdue/);
});

/* ------------------------------------------------------------ grounding */

test('verifyClaims accepts a fully grounded draft', () => {
  const evidence = [
    { id: 'fulfillment', title: 'Carrier scan: Delivered', fact: 'Order ORD-10482 shipped via USPS on September 19, 2026 with tracking 9400111899223856921048.', source: 'Local tracking' },
  ];
  const result = verifyClaims('Order ORD-10482 shipped via USPS on September 19, 2026 with tracking 9400111899223856921048.', evidence);
  assert.equal(result.status, 'verified');
  assert.equal(result.unsupported.length, 0);
});

test('verifyClaims flags an invented amount, date and reference', () => {
  const evidence = [{ id: 'x', title: 'Carrier scan', fact: 'Order ORD-10482 shipped on September 19, 2026.', source: 'Local' }];
  const result = verifyClaims('Order ORD-10482 shipped on September 19, 2026 for MYR 999.00 with tracking 99999999999999999999.', evidence);
  assert.equal(result.status, 'review');
  const invented = result.unsupported.map((claim) => claim.text);
  assert.ok(invented.includes('MYR 999.00'), `expected invented amount, got ${JSON.stringify(invented)}`);
  assert.ok(invented.includes('99999999999999999999'), `expected invented reference, got ${JSON.stringify(invented)}`);
});

test('verifyClaims reports no_quantitative_claims for prose with nothing checkable', () => {
  const result = verifyClaims('We shipped the item and are happy to help.', []);
  assert.equal(result.status, 'no_quantitative_claims');
  assert.equal(result.checked, 0);
});

/* -------------------------------------------------------------- drafts */

test('deterministicDraft uses source facts and never invents one', () => {
  const evidence = [
    { id: 'fulfillment', fact: 'Shipped via USPS.' },
    { id: 'communication-1', fact: 'Buyer emailed on September 25.' },
  ];
  const draft = deterministicDraft({}, null, evidence);
  assert.match(draft, /Shipped via USPS\./);
  assert.match(draft, /Buyer emailed on September 25\./);
});

test('deterministicDraft admits when records are missing instead of guessing', () => {
  const draft = deterministicDraft({}, null, []);
  assert.match(draft, /not complete|gathering/i);
});

/* --------------------------------------------------- HATEOAS rel matching */

test('hasAction and findAction treat underscore and hyphen action names the same', () => {
  // The live sandbox returns `provide_evidence`; the docs say `provide-evidence`.
  const underscore = [{ rel: 'provide_evidence', href: 'https://example/p', method: 'POST' }];
  const hyphen = [{ rel: 'provide-evidence', href: 'https://example/p', method: 'POST' }];

  assert.equal(hasAction(underscore, 'provide-evidence'), true);
  assert.equal(hasAction(hyphen, 'provide-evidence'), true);
  assert.equal(hasAction(underscore, 'provide_evidence'), true);
  assert.equal(findAction(underscore, 'provide-evidence').href, 'https://example/p');
});

test('hasAction is not fooled by unrelated or missing actions', () => {
  const links = [{ rel: 'self' }, { rel: 'accept_claim' }];
  assert.equal(hasAction(links, 'provide-evidence'), false);
  assert.equal(hasAction([], 'provide-evidence'), false);
  assert.equal(hasAction(undefined, 'provide-evidence'), false);
  assert.equal(findAction(links, 'provide-evidence'), null);
});

test('normalizeRel folds case, underscores and whitespace', () => {
  assert.equal(normalizeRel('Provide_Evidence'), 'provide-evidence');
  assert.equal(normalizeRel('provide evidence'), 'provide-evidence');
  assert.equal(normalizeRel(''), '');
});
