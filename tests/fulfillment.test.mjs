// Unit tests for fulfillment resolution. Pure logic — no server, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_PRECEDENCE,
  applyFulfillment,
  normalizeFulfillment,
  originForProvider,
  resolveFulfillment,
  validateFulfillment,
} from '../lib/fulfillment.mjs';

test('a merchant assertion outranks a copy of it', () => {
  assert.deepEqual(PROVIDER_PRECEDENCE, ['manual', 'merchant-order', 'paypal-tracker']);
  const resolved = resolveFulfillment({
    providers: [
      { source: 'paypal-tracker', fulfillment: { carrier: 'PayPal says DHL' } },
      { source: 'merchant-order', fulfillment: { carrier: 'Order says USPS' } },
      { source: 'manual', fulfillment: { carrier: 'Manual says FedEx' } },
    ],
  });
  assert.equal(resolved.fulfillment.carrier, 'Manual says FedEx');
  assert.equal(resolved.provenance.carrier, 'manual');
  assert.equal(resolved.primary_source, 'manual');
});

test('a lower-precedence provider still fills fields the higher ones omit', () => {
  const resolved = resolveFulfillment({
    providers: [
      { source: 'manual', fulfillment: { carrier: 'FedEx' } },
      { source: 'paypal-tracker', fulfillment: { tracking_number: 'JJD0099' } },
    ],
  });
  assert.equal(resolved.fulfillment.carrier, 'FedEx');
  assert.equal(resolved.provenance.carrier, 'manual');
  assert.equal(resolved.fulfillment.tracking_number, 'JJD0099');
  assert.equal(resolved.provenance.tracking_number, 'paypal-tracker');
});

test('disagreeing providers are surfaced rather than silently resolved', () => {
  const resolved = resolveFulfillment({
    providers: [
      { source: 'manual', fulfillment: { carrier: 'FedEx', tracking_number: 'AAA' } },
      { source: 'paypal-tracker', fulfillment: { carrier: 'FedEx', tracking_number: 'BBB' } },
    ],
  });
  assert.equal(resolved.conflicts.length, 1);
  const [conflict] = resolved.conflicts;
  assert.equal(conflict.field, 'tracking_number');
  assert.deepEqual(conflict.values.map((entry) => entry.source), ['manual', 'paypal-tracker']);
  // Same value on both sides is not a conflict.
  assert.equal(resolved.conflicts.some((entry) => entry.field === 'carrier'), false);
});

test('nothing is invented when no provider has the answer', () => {
  const resolved = resolveFulfillment({
    providers: [
      { source: 'manual', fulfillment: null },
      { source: 'merchant-order', fulfillment: null },
      { source: 'paypal-tracker', fulfillment: null },
    ],
  });
  assert.equal(resolved.fulfillment.carrier, null);
  assert.equal(resolved.fulfillment.tracking_number, null);
  assert.equal(resolved.primary_source, null);
  assert.deepEqual(resolved.resolved_from, []);
  assert.ok(resolved.gaps.some((gap) => gap.code === 'NO_TRACKING'));
});

test('a provider that returns empty strings is treated as supplying nothing', () => {
  const resolved = resolveFulfillment({
    providers: [{ source: 'merchant-order', fulfillment: { carrier: '   ', tracking_number: '' } }],
  });
  assert.equal(resolved.fulfillment.carrier, null);
  assert.deepEqual(resolved.resolved_from, [], 'a blank record must not count as a source');
});

test('a half-known shipment is reported as partial, not complete', () => {
  const resolved = resolveFulfillment({
    providers: [{ source: 'merchant-order', fulfillment: { carrier: 'USPS' } }],
  });
  assert.ok(resolved.gaps.some((gap) => gap.code === 'PARTIAL_TRACKING'));
  assert.equal(resolved.gaps.some((gap) => gap.code === 'NO_TRACKING'), false);
});

test('a known shipment without a delivery date is flagged separately', () => {
  const resolved = resolveFulfillment({
    providers: [{ source: 'merchant-order', fulfillment: { carrier: 'USPS', tracking_number: 'T1' } }],
  });
  assert.ok(resolved.gaps.some((gap) => gap.code === 'NO_DELIVERY_DATE'));
});

test('every consulted provider is reported, even the empty ones', () => {
  const resolved = resolveFulfillment({
    providers: [
      { source: 'manual', fulfillment: null },
      { source: 'merchant-order', fulfillment: { carrier: 'USPS', tracking_number: 'T1' } },
      { source: 'paypal-tracker', fulfillment: null },
    ],
  });
  assert.deepEqual(resolved.consulted, ['manual', 'merchant-order', 'paypal-tracker']);
  assert.deepEqual(resolved.resolved_from, ['merchant-order']);
});

test('provider origins map to UI labels', () => {
  assert.equal(originForProvider('paypal-tracker'), 'paypal');
  assert.equal(originForProvider('merchant-order'), 'local');
  assert.equal(originForProvider('manual'), 'manual');
  assert.equal(originForProvider('something-new'), 'local');
});

test('normalizeFulfillment keeps only known fields', () => {
  const normalized = normalizeFulfillment({ carrier: 'USPS', tracking_number: 'T1', evil: 'nope', status: '' });
  assert.deepEqual(Object.keys(normalized).sort(), ['carrier', 'delivered_at', 'shipped_at', 'status', 'tracking_number']);
  assert.equal(normalized.evil, undefined);
  assert.equal(normalized.status, null);
});

test('validation requires a carrier and a tracking number', () => {
  assert.equal(validateFulfillment({ carrier: 'USPS', tracking_number: 'T1' }).ok, true);
  const missing = validateFulfillment({ carrier: 'USPS' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => /tracking_number is required/.test(error)));
  assert.equal(validateFulfillment({}).ok, false);
});

test('validation rejects delivery before shipment and unparseable dates', () => {
  const inverted = validateFulfillment({
    carrier: 'USPS',
    tracking_number: 'T1',
    shipped_at: '2026-10-05T00:00:00Z',
    delivered_at: '2026-10-01T00:00:00Z',
  });
  assert.equal(inverted.ok, false);
  assert.ok(inverted.errors.some((error) => /cannot precede/.test(error)));

  assert.equal(validateFulfillment({ carrier: 'U', tracking_number: 'T', delivered_at: 'not-a-date' }).ok, false);
});

test('applyFulfillment folds resolved facts into an order record', () => {
  const resolved = resolveFulfillment({
    providers: [{ source: 'manual', fulfillment: { carrier: 'FedEx', tracking_number: 'JJD1' } }],
  });
  const order = applyFulfillment({ order_id: 'ORD-1', fulfillment: { delivery_status: 'Delivered' }, communications: [] }, resolved);
  assert.equal(order.fulfillment.carrier, 'FedEx');
  assert.equal(order.fulfillment.tracking_number, 'JJD1');
  assert.equal(order.fulfillment.delivery_status, 'Delivered', 'existing fields must survive');
  assert.equal(order.fulfillment_source, 'manual');
  assert.equal(order.fulfillment_origin, 'manual');
});

test('applyFulfillment synthesises an order when only a provider has the facts', () => {
  const resolved = resolveFulfillment({
    providers: [{ source: 'paypal-tracker', fulfillment: { carrier: 'DHL', tracking_number: 'X1' } }],
  });
  const order = applyFulfillment(null, resolved);
  assert.equal(order.order_id, null);
  assert.equal(order.resolved_only, true);
  assert.equal(order.fulfillment_origin, 'paypal');
});

test('applyFulfillment returns null when there is nothing at all to record', () => {
  const resolved = resolveFulfillment({ providers: [] });
  assert.equal(applyFulfillment(null, resolved), null);
});
