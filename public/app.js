const $ = (selector) => document.querySelector(selector);
const state = { config: { mode: 'fixture', aiConfigured: false }, activeId: null, caseData: null, analysis: null, busy: false, cases: [], orders: [], caseFilter: 'all', showAllActivity: false };

function showToast(message, error = false) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('error', error); toast.classList.add('visible');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3800);
}
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function date(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) { return value ? new Intl.DateTimeFormat('en-US', options).format(new Date(value)) : '—'; }
function relative(value) {
  if (!value) return 'Date not provided';
  const elapsed = Date.now() - new Date(value).getTime();
  const hours = Math.max(1, Math.round(elapsed / 3600000));
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
function reasonName(reason = '') { return ({ MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received', MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Significantly not as described', CREDIT_NOT_PROCESSED: 'Credit not processed', UNAUTHORISED: 'Unauthorized transaction' })[reason] || reason.replaceAll('_', ' ').toLowerCase().replace(/^./, x => x.toUpperCase()); }
function money(amount) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: amount?.currency_code || 'USD' }).format(Number(amount?.value || 0)); }
// PayPal returns action names with underscores in the live sandbox and with
// hyphens elsewhere; compare on a normalised name or the action goes unseen.
function normalizeRel(rel = '') { return String(rel).trim().toLowerCase().replace(/[_\s]+/g, '-'); }
function hasAction(links = [], action) { const wanted = normalizeRel(action); return (links || []).some(link => normalizeRel(link.rel) === wanted); }
function evidenceIcon(title = '') { return /carrier|tracking|delivery/i.test(title) ? '↗' : '✉'; }
function originTag(origin = 'local') {
  // 'manual' is a merchant assertion made in Recourse, distinct from their
  // order system and from anything PayPal returned.
  const label = { paypal: 'PAYPAL', local: 'MERCHANT', buyer: 'BUYER', manual: 'MANUAL' }[origin] || 'MERCHANT';
  return `<span class="origin-tag origin-${escapeHtml(origin)}">${label}</span>`;
}
function renderAnalysisStatus(result) {
  // Surface whether a model actually ran, and whether its output was verified.
  const ai = result.ai || {};
  const grounding = result.grounding || {};
  const chip = $('#ai-status');
  if (chip) {
    const fellBack = ai.used && ai.fellBack ? ` (fallback from ${ai.requestedModel || 'primary'})` : '';
    // AI is currently switched off; say so plainly rather than implying a model ran.
    chip.textContent = ai.used
      ? `AI · ${ai.model}${fellBack}`
      : ai.enabled === false
        ? 'Deterministic engine · AI off'
        : ai.configured
          ? 'AI unavailable — rules-based draft'
          : 'No AI configured';
    chip.className = `ai-chip ${ai.used ? 'ai-on' : 'ai-off'}`;
  }
  const note = $('#grounding-note');
  if (note) {
    if (!grounding.checked) {
      note.textContent = '';
      note.className = 'grounding-note hidden';
    } else if (grounding.status === 'verified') {
      note.textContent = `✓ ${grounding.checked} checkable claim${grounding.checked === 1 ? '' : 's'} in this draft traced back to the linked source records.`;
      note.className = 'grounding-note verified';
    } else {
      const list = (grounding.unsupported || []).map(claim => claim.text).join(', ');
      note.textContent = `⚠ ${grounding.unsupported.length} claim${grounding.unsupported.length === 1 ? '' : 's'} could not be traced to a source record: ${list}`;
      note.className = 'grounding-note unverified';
    }
  }
  // Findings carry a direction: risks weaken the position, supports defend it.
  const findings = result.findings || null;
  const risks = findings?.risks || [];
  const supports = findings?.supports || [];

  const riskBox = $('#contradiction-note');
  if (riskBox) {
    if (!risks.length) riskBox.classList.add('hidden');
    else {
      riskBox.classList.remove('hidden');
      $('#contradiction-text').textContent = risks
        .map(risk => risk.detail || CONTRADICTION_TEXT[risk.code] || risk.code.replaceAll('_', ' '))
        .join(' ');
    }
  }

  const supportBox = $('#support-note');
  if (supportBox) {
    if (!supports.length) supportBox.classList.add('hidden');
    else {
      supportBox.classList.remove('hidden');
      $('#support-text').textContent = supports
        .map(support => support.detail || support.code.replaceAll('_', ' '))
        .join(' ');
    }
  }
}
const CONTRADICTION_TEXT = {
  delivery_before_shipment: 'The recorded delivery date precedes the shipment date.',
  delivery_status_conflict: 'The carrier status conflicts with another fulfilment record.',
  missing_address: 'The delivery address is missing from the available records.',
  missing_recipient: 'The recipient identity or signature is missing from the available records.',
  missing_refund: 'No refund transaction id is linked to the order.',
};

async function loadCase(id = state.activeId, shouldAnalyze = true) {
  if (!id || id === 'undefined' || id === 'null') return;
  state.activeId = id;
  document.querySelectorAll('.case-row').forEach(row => row.classList.toggle('selected', row.dataset.case === id));
  try {
    const result = await api(`/api/cases/${encodeURIComponent(id)}`);
    state.caseData = result;
    renderCase(result);
    if (shouldAnalyze) await runAnalysis();
  } catch (error) { showToast(error.message, true); }
}
function renderCase({ dispute, order, activity, source, paypalTransaction, deadline, packet, evidence: caseEvidence }) {
  const detail = dispute;
  $('#case-id').textContent = detail.id || detail.dispute_id || 'Unknown dispute';
  $('#detail-reason').textContent = reasonName(detail.reason);
  const merchantName = detail.buyer?.name || 'Buyer identity not returned by PayPal';
  const invoice = detail.disputed_transactions?.[0]?.invoice_number || order?.invoice_number || '—';
  $('#detail-sub').innerHTML = `${escapeHtml(merchantName)} <span>·</span> Order #${escapeHtml(invoice)} <span>·</span> Opened ${date(detail.create_time, { month: 'short', day: 'numeric' })}`;
  $('#amount').innerHTML = `${money(detail.dispute_amount)} <small>${escapeHtml(detail.dispute_amount?.currency_code || '')}</small>`;
  $('#case-status').textContent = detail.status === 'WAITING_FOR_SELLER_RESPONSE' ? 'Needs response' : (detail.status || 'Status unavailable').replaceAll('_', ' ').toLowerCase().replace(/^./, x => x.toUpperCase());
  $('#paypal-source').textContent = source === 'PayPal Sandbox' ? 'PayPal Sandbox case' : 'Fixture case';
  const transaction = detail.disputed_transactions?.[0]?.seller_transaction_id || detail.disputed_transactions?.[0]?.transaction_id || detail.disputed_transactions?.[0]?.buyer_transaction_id;
  // Show both halves of the linkage: the merchant's local record and PayPal's own view of the transaction.
  const parts = [];
  parts.push(order ? `Local order ${order.order_id} matched by ${transaction ? `transaction ${transaction}` : `invoice ${order.invoice_number}`}` : 'No local order matched to this case');
  if (paypalTransaction) {
    parts.push(`PayPal reports ${paypalTransaction.transaction_id} as ${paypalTransaction.status || 'status unknown'}${paypalTransaction.amount ? ` · ${money(paypalTransaction.amount)}` : ''}`);
  } else if (transaction) {
    parts.push('PayPal did not return details for this transaction');
  }
  if (packet?.preparedAt) parts.push(`triaged automatically ${relative(packet.preparedAt)}`);
  $('#link-source').textContent = parts.join(' · ');
  if (deadline && $('.deadline-text')) {
    $('.deadline-text').classList.toggle('deadline-urgent', ['urgent', 'overdue'].includes(deadline.urgency));
  }
  const readOnly = Boolean(state.config.readOnly);
  const canSubmit = hasAction(detail.links, 'provide-evidence');
  $('#submit-response').disabled = false;
  $('#submit-response').innerHTML = canSubmit ? 'Review &amp; submit response <span>→</span>' : 'Continue in PayPal <span>↗</span>';
  // A shared demo keeps the PayPal data live but never lets a visitor file evidence.
  $('.submit-caption').textContent = readOnly
    ? 'Read-only demo — evidence submission is disabled to protect the demo PayPal case.'
    : canSubmit
      ? 'Nothing is sent without your approval'
      : 'PayPal has not exposed evidence submission through its API for this case stage.';
  const due = detail.seller_response_due_date;
  $('.deadline-text').innerHTML = `${date(due)} <small>${due ? `${Math.max(0, Math.ceil((new Date(due) - Date.now()) / 86400000))} days left` : 'PayPal deadline'}</small>`;
  $('.stage-pill').textContent = (detail.dispute_life_cycle_stage || 'Stage unavailable').replaceAll('_', ' ').replace(/^./, x => x.toUpperCase()).toLowerCase().replace(/^./, x => x.toUpperCase());
  $('#analysis-label').textContent = source.toUpperCase();
  $('#missing-note').classList.add('hidden');
  // Prefer the server's evidence set, which already tags PayPal, local and buyer
  // sources. Only fall back to local records if the server returned none, so the
  // list is never misleadingly labelled "all local" before analysis runs.
  if (caseEvidence?.length) {
    renderEvidence(caseEvidence);
    $('#metric-sources').textContent = String(caseEvidence.length).padStart(2, '0');
  } else if (order) {
    const fulfilledAt = order.fulfillment?.delivered_at;
    const fallback = [
      ...(order.fulfillment ? [{ title: `Carrier scan: ${order.fulfillment?.delivery_status || 'Status unavailable'}`, source: `Local tracking record · ${order.order_id}`, at: fulfilledAt, relevance: 'Delivery information recorded in the merchant’s local carrier record.', origin: 'local' }] : []),
      ...(order.communications || []).map(m => ({ title: m.summary, source: `Local ${m.channel} record · ${order.order_id}`, at: m.at, relevance: 'Communication record stored by the merchant for this order.', origin: 'local' })),
    ];
    renderEvidence(fallback);
    $('#metric-sources').textContent = String(fallback.length).padStart(2, '0');
  } else renderEvidence([]);
  renderActivity(activity, source);
  renderAgent({ packet });
  renderOverview();
}
function renderEvidence(items = []) {
  $('#evidence-count').textContent = String(items.length);
  $('#evidence-list').innerHTML = items.map(item => `<article class="evidence-item"><span class="evidence-icon ${evidenceIcon(item.title) === '↗' ? 'parcel' : ''}">${evidenceIcon(item.title)}</span><div class="evidence-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source)} <span>·</span> ${date(item.at, { month: 'short', day: 'numeric' })}</small></div>${originTag(item.origin)}<span class="evidence-check">✓</span></article>`).join('') || '<p class="empty-evidence">No evidence was linked to this case yet.</p>';
}
function renderAgent(caseData) {
  const card = $('#agent-card');
  if (!card) return;
  const investigation = caseData?.packet?.investigation;
  if (!investigation || !(investigation.transcript || []).length) return card.classList.add('hidden');
  card.classList.remove('hidden');
  $('#agent-note').textContent =
    `${investigation.planner} planner · ${investigation.steps} step${investigation.steps === 1 ? '' : 's'} · stopped: ${String(investigation.stoppedReason).replaceAll('_', ' ')}`;
  $('#agent-transcript').innerHTML = investigation.transcript.map(entry => {
    const failed = Boolean(entry.error) || Boolean(entry.blocked);
    const detail = entry.error ? `Failed: ${entry.error}` : entry.blocked ? entry.blocked : summariseToolResult(entry.result);
    return `<div class="workspace-row event-row"><span class="urgency-dot ${failed ? 'overdue' : 'ok'}"></span><div><strong>${escapeHtml(entry.tool || 'unknown')}</strong><small>${escapeHtml(entry.why || '')}</small>${detail ? `<p class="event-error">${escapeHtml(detail)}</p>` : ''}</div></div>`;
  }).join('');
}
function summariseToolResult(result) {
  if (result === null || result === undefined) return 'Nothing found.';
  if (typeof result !== 'object') return String(result).slice(0, 140);
  const parts = [];
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined || value === '') continue;
    const text = Array.isArray(value) ? (value.length ? value.join(', ') : '') : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (text) parts.push(`${key}: ${text}`);
    if (parts.join(' · ').length > 150) break;
  }
  return parts.length ? parts.join(' · ').slice(0, 180) : 'Nothing found.';
}
function renderActivity(items = [], source = 'Fixture demo') {
  const activity = [...items];
  if (!activity.length) activity.push({ event: source === 'PayPal Sandbox' ? 'Dispute details retrieved' : 'Fixture case loaded', detail: source, at: state.caseData?.dispute?.create_time });
  $('#activity-list').innerHTML = activity.slice(0, state.showAllActivity ? activity.length : 5).map(item => `<div class="activity-row"><span class="activity-marker ${/submitted/i.test(item.event) ? 'purple' : ''}"></span><div><strong>${escapeHtml(item.event)}</strong><p>${escapeHtml(item.detail || '')}</p></div><time>${relative(item.at)}</time></div>`).join('');
}
function setPage(page) {
  document.querySelectorAll('.workspace-page').forEach(node => node.classList.toggle('hidden', node.id !== `${page}-page`));
  document.querySelectorAll('.nav-item').forEach(node => node.classList.toggle('active', node.id === `nav-${page}`));
  document.querySelector('.breadcrumb strong').textContent = ({ overview: 'Overview', disputes: 'Dispute desk', orders: 'Orders', evidence: 'Evidence library', webhooks: 'Webhooks' })[page] || 'Dispute desk';
  window.location.hash = page;
}
function renderOverview() {
  const cases = state.cases;
  $('#overview-case-note').textContent = `${cases.length} live PayPal dispute${cases.length === 1 ? '' : 's'} in this workspace`;
  $('#overview-case-list').innerHTML = cases.length ? cases.map(item => `<div class="workspace-row"><span class="case-symbol shipping">↗</span><div><strong>${escapeHtml(reasonName(item.reason))}</strong><small>${escapeHtml(item.buyer?.name || 'PayPal buyer')} · ${escapeHtml(money(item.dispute_amount))} · ${escapeHtml(item.id)}</small></div><button class="quiet-button open-case" data-case="${escapeHtml(item.id)}">Open workspace</button></div>`).join('') : '<p class="empty-evidence">No live PayPal disputes were returned.</p>';
  const order = state.caseData?.order;
  const sourceCount = state.analysis?.evidence?.length || (order ? 1 + order.communications.length : 0);
  $('#overview-readiness').innerHTML = `<div class="readiness-item"><strong>${sourceCount} linked source${sourceCount === 1 ? '' : 's'}</strong>${order ? `Order ${escapeHtml(order.order_id)} is matched to the selected case.` : 'No local order has been matched to the selected case.'}</div><div class="readiness-item"><strong>${state.config.aiConfigured ? 'AI drafting enabled' : 'AI drafting not configured'}</strong>${state.config.aiConfigured ? 'Drafts are checked for source citations before they are shown.' : 'The current draft uses deterministic local rules.'}</div>`;
  document.querySelectorAll('.open-case').forEach(button => button.addEventListener('click', () => { setPage('disputes'); loadCase(button.dataset.case); }));
}
function renderOrders() {
  $('#orders-count').textContent = `${state.orders.length} local order record${state.orders.length === 1 ? '' : 's'}`;
  $('#orders-list').innerHTML = state.orders.map(order => {
    const linked = state.cases.find(item => item.disputed_transactions?.some(tx => tx.invoice_number === order.invoice_number || tx.seller_transaction_id === order.paypal_transaction_id || tx.transaction_id === order.paypal_transaction_id));
    return `<div class="workspace-row"><span class="case-symbol shipping">↗</span><div><strong>${escapeHtml(order.item)} · ${escapeHtml(order.order_id)}</strong><small>Local record · ${escapeHtml(order.customer)} · ${escapeHtml(order.currency)} ${escapeHtml(order.amount)} · ${escapeHtml(order.fulfillment.delivery_status)}</small></div>${linked ? `<button class="quiet-button open-case" data-case="${escapeHtml(linked.id)}">Open case</button>` : '<small>Not linked to a live PayPal dispute</small>'}</div>`;
  }).join('');
  document.querySelectorAll('#orders-list .open-case').forEach(button => button.addEventListener('click', () => { setPage('disputes'); loadCase(button.dataset.case); }));
}
function renderEvidenceLibrary() {
  const records = state.orders.flatMap(order => [{ title: `Carrier scan: ${order.fulfillment.delivery_status}`, detail: `${order.order_id} · ${order.fulfillment.carrier} · ${order.fulfillment.tracking_number}` }, ...order.communications.map(message => ({ title: message.summary, detail: `${order.order_id} · ${message.channel}` }))]);
  $('#evidence-library-count').textContent = `${records.length} local evidence record${records.length === 1 ? '' : 's'}`;
  $('#evidence-library-list').innerHTML = records.map(record => `<div class="workspace-row"><span class="evidence-icon">↗</span><div><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.detail)}</small></div></div>`).join('');
}
function filterCases(cases) {
  if (state.caseFilter === 'review') return cases.filter(item => item.status === 'WAITING_FOR_SELLER_RESPONSE');
  if (state.caseFilter === 'due') return cases.filter(item => item.seller_response_due_date);
  return cases;
}
function renderCaseList(cases = []) {
  const list = $('#case-list');
  const visibleCases = filterCases(cases);
  $('#active-count').textContent = String(visibleCases.length).padStart(2, '0');
  $('#metric-open').textContent = String(cases.length).padStart(2, '0');
  $('#metric-review').textContent = String(cases.filter(item => item.status === 'WAITING_FOR_SELLER_RESPONSE').length).padStart(2, '0');
  const earliest = cases.filter(item => item.seller_response_due_date).sort((a, b) => new Date(a.seller_response_due_date) - new Date(b.seller_response_due_date))[0];
  $('#metric-risk').textContent = earliest ? money(earliest.dispute_amount) : '$—';
  $('#metric-risk-note').textContent = earliest ? 'Next case deadline' : 'No deadline provided';
  $('#metric-due').textContent = earliest ? date(earliest.seller_response_due_date, { month: 'short', day: 'numeric' }).toUpperCase() : '—';
  const sourceCount = state.caseData?.order?.communications?.length;
  $('#metric-sources').textContent = sourceCount === undefined ? '—' : String(sourceCount + 1).padStart(2, '0');
  if (!visibleCases.length) {
    list.innerHTML = '<div class="empty-cases">No disputes were returned by this PayPal Sandbox app yet.<br><br>Connect a Sandbox buyer and business transaction, create a dispute, then refresh.</div>';
    state.activeId = null;
    return;
  }
  list.innerHTML = visibleCases.map(item => {
    const reason = reasonName(item.reason);
    const invoice = item.disputed_transactions?.[0]?.invoice_number || item.id;
    const buyer = item.buyer?.name || item.dispute_amount?.currency_code || 'PayPal buyer';
    const due = item.seller_response_due_date ? Math.max(0, Math.ceil((new Date(item.seller_response_due_date) - Date.now()) / 86400000)) : null;
    return `<button class="case-row ${item.id === state.activeId ? 'selected' : ''}" data-case="${escapeHtml(item.id)}"><span class="case-symbol shipping">↗</span><span class="case-copy"><strong>${escapeHtml(reason)}</strong><small>${escapeHtml(buyer)} · #${escapeHtml(invoice)}</small></span><span class="case-amount">${escapeHtml(money(item.dispute_amount))}<small>${due === null ? escapeHtml((item.status || '').replaceAll('_', ' ')) : `${due} days left`}</small></span><span class="row-arrow">›</span></button>`;
  }).join('');
  document.querySelectorAll('.case-row').forEach(row => row.addEventListener('click', () => loadCase(row.dataset.case)));
}
async function loadCases() {
  const result = await api('/api/cases');
  const cases = result.cases || [];
  state.cases = cases;
  $('.nav-count').textContent = String(cases.length);
  renderCaseList(cases);
  renderOverview();
  if (!cases.length) {
    $('#detail-reason').textContent = 'No Sandbox disputes yet';
    $('#detail-sub').textContent = 'Create an eligible buyer transaction and dispute to begin.';
    $('#submit-response').disabled = true;
    return;
  }
  $('#submit-response').disabled = false;
  if (!cases.some(item => item.id === state.activeId)) state.activeId = cases[0].id;
  await loadCase(state.activeId);
}
async function loadOrders() {
  const result = await api('/api/orders');
  state.orders = result.orders || [];
  renderOrders();
  renderEvidenceLibrary();
}
async function runAnalysis() {
  if (!state.caseData) return;
  $('#regenerate').disabled = true; $('#regenerate').textContent = '◌ Preparing…';
  try {
    const result = await api('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state.caseData) });
    state.analysis = result;
    $('#analysis-label').textContent = result.provenance.toUpperCase();
    $('#summary').textContent = result.summary || 'No summary returned.';
    $('#confidence').textContent = `${result.confidence || 'Unrated'} confidence`;
    renderEvidence(result.evidence || []);
    renderActivity(result.activity || [], state.caseData.source);
    const missing = result.missing || [];
    $('#missing-note').classList.toggle('hidden', missing.length === 0);
    $('#missing-text').textContent = missing.join(' ');
    $('#draft').value = result.draft || '';
    updateCount();
    const count = result.evidence?.length || 0;
    renderAnalysisStatus(result);
    if (result.contradictions?.length) showToast(`AI flagged ${result.contradictions.length} record contradiction${result.contradictions.length === 1 ? '' : 's'} for review.`);
    if (result.ai && result.ai.used === false && result.ai.configured) showToast(result.ai.message || 'The AI model was unavailable; a rules-based draft was prepared.', true);
    const linked = result.sourcesLinked || {};
    $('#draft-provenance').textContent = `Draft from ${count} linked source${count === 1 ? '' : 's'} · ${linked.paypal || 0} from PayPal, ${linked.local || 0} local${linked.buyer ? `, ${linked.buyer} from the buyer` : ''}`;
  } catch (error) { showToast(error.message, true); }
  finally { $('#regenerate').disabled = false; $('#regenerate').innerHTML = '↻ Re-draft'; }
}
function updateCount() { $('#char-count').textContent = `${$('#draft').value.length.toLocaleString()} / 2,000`; }
function openApproval() {
  if (state.config.readOnly) return showToast('This hosted demo is read-only, so evidence cannot be filed here. Run Recourse locally to submit.', true);
  if (!hasAction(state.caseData?.dispute?.links, 'provide-evidence')) {
    if (state.config.mode === 'sandbox' && state.activeId) window.open(`https://www.sandbox.paypal.com/resolutioncenter/${encodeURIComponent(state.activeId)}`, '_blank', 'noopener');
    else showToast('This fixture case no longer accepts a response.', true);
    return;
  }
  if (!$('#draft').value.trim()) return showToast('Add a response before submitting.', true);
  // PayPal only accepts certain evidence types per dispute reason, and only the
  // ones it has actually requested. Use the server's plan rather than guessing.
  const plan = state.caseData?.plan;
  const allowed = plan?.allowed || ['PROOF_OF_REFUND', 'OTHER'];
  const requested = plan?.preferred && allowed.includes(plan.preferred) ? plan.preferred : allowed[0];
  const option = plan?.options?.find(item => item.type === requested);
  if (option && option.available === false) {
    return showToast(`${requested.replaceAll('_', ' ').toLowerCase()} cannot be submitted yet: ${option.note}`, true);
  }
  if (option?.degraded) showToast(option.note);
  $('#approval-preview').textContent = $('#draft').value;
  $('#dialog-mode').textContent = `${state.config.mode === 'fixture' ? 'DEMO MODE — no response will be sent to PayPal' : 'PAYPAL SANDBOX — this will submit to your Sandbox dispute'} · evidence: ${requested.replaceAll('_', ' ').toLowerCase()}`;
  $('#dialog-mode').className = `dialog-mode ${state.config.mode === 'fixture' ? 'fixture-mode' : 'sandbox-mode'}`;
  $('#confirm-submit').dataset.evidenceType = requested;
  $('#approval-dialog').showModal();
}
async function submitApproved() {
  const button = $('#confirm-submit'); button.disabled = true; button.textContent = 'Sending…';
  try {
    $('#approval-dialog').close();
    const result = await api('/api/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: state.activeId, approved: true, responseText: $('#draft').value, evidenceType: button.dataset.evidenceType }) });
    if (state.caseData) state.caseData.dispute = result.dispute;
    $('#case-status').textContent = result.mode === 'fixture' ? 'Fixture recorded · under review' : result.dispute?.status || 'Response submitted';
    $('#submit-response').disabled = true;
    renderActivity(result.activity || [], result.mode === 'fixture' ? 'Fixture demo' : 'PayPal Sandbox');
    const refreshed = await api('/api/cases');
    renderCaseList(refreshed.cases || []);
    showToast(result.mode === 'fixture' ? 'Demo response recorded. Nothing was sent to PayPal.' : 'Your approved response was submitted to PayPal Sandbox.');
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; button.innerHTML = 'Confirm &amp; submit <span>→</span>'; }
}

document.querySelectorAll('.case-row').forEach(row => row.addEventListener('click', () => loadCase(row.dataset.case)));
$('#refresh').addEventListener('click', () => loadCases().catch(error => showToast(error.message, true)));
$('#regenerate').addEventListener('click', runAnalysis);
$('#draft').addEventListener('input', updateCount);
$('#submit-response').addEventListener('click', openApproval);
$('#confirm-submit').addEventListener('click', event => { event.preventDefault(); submitApproved(); });
$('#setup-link').addEventListener('click', event => { event.preventDefault(); $('#setup-dialog').showModal(); });
document.querySelector('.help-card a').addEventListener('click', event => { event.preventDefault(); $('#setup-dialog').showModal(); });
$('#case-filter').addEventListener('change', event => { state.caseFilter = event.target.value; renderCaseList(state.cases); });
$('#view-all-cases').addEventListener('click', () => { state.caseFilter = 'all'; $('#case-filter').value = 'all'; renderCaseList(state.cases); $('#case-list').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('#metric-open-card').addEventListener('click', () => { state.caseFilter = 'all'; $('#case-filter').value = 'all'; renderCaseList(state.cases); });
$('#metric-review-card').addEventListener('click', () => { state.caseFilter = 'review'; $('#case-filter').value = 'review'; renderCaseList(state.cases); });
$('#metric-risk-card').addEventListener('click', () => { const due = state.cases.filter(item => item.seller_response_due_date).sort((a,b) => new Date(a.seller_response_due_date)-new Date(b.seller_response_due_date))[0]; if (due) loadCase(due.id); });
$('#metric-sources-card').addEventListener('click', () => $('#detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }));
$('#nav-overview').addEventListener('click', event => { event.preventDefault(); setPage('overview'); renderOverview(); });
$('#nav-disputes').addEventListener('click', event => { event.preventDefault(); setPage('disputes'); });
$('#nav-orders').addEventListener('click', event => { event.preventDefault(); setPage('orders'); renderOrders(); });
$('#nav-evidence').addEventListener('click', event => { event.preventDefault(); setPage('evidence'); renderEvidenceLibrary(); });
$('#nav-webhooks').addEventListener('click', event => { event.preventDefault(); setPage('webhooks'); loadEvents(); loadWatchdog(); loadAttempts(); });
$('#overview-open-case').addEventListener('click', () => { if (!state.activeId) return showToast('Select a live case first.', true); setPage('disputes'); loadCase(state.activeId); });
$('#see-order').addEventListener('click', () => setPage('orders'));
$('#full-history').addEventListener('click', () => { state.showAllActivity = !state.showAllActivity; $('#full-history').innerHTML = state.showAllActivity ? 'Show recent <span>→</span>' : 'Full history <span>→</span>'; renderActivity(state.caseData?.activity || [], state.caseData?.source); });
$('#today').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
$('#today-full').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase();
$('#check-access').addEventListener('click', async () => {
  const button = $('#check-access'); button.disabled = true; button.textContent = 'Checking…'; $('#access-result').textContent = '';
  try { const result = await api('/api/paypal-check'); $('#access-result').textContent = `${result.message} Disputes in list: ${result.itemsFound}.`; $('#access-result').className = 'access-result success'; }
  catch (error) { $('#access-result').textContent = error.message; $('#access-result').className = 'access-result failure'; }
  finally { button.disabled = false; button.textContent = 'Check Sandbox API access'; }
});

$('#check-ai').addEventListener('click', async () => {
  const button = $('#check-ai'); button.disabled = true; button.textContent = 'Checking…'; $('#ai-result').textContent = '';
  try {
    const result = await api('/api/ai-check');
    if (result.ok) {
      $('#ai-result').textContent = `${result.message} (${result.latencyMs} ms, ${result.attempts} attempt${result.attempts === 1 ? '' : 's'})`;
      $('#ai-result').className = 'access-result success';
    } else {
      $('#ai-result').textContent = `${result.message}${result.detail?.length ? ` Tried: ${result.detail.join('; ')}` : ''}`;
      $('#ai-result').className = 'access-result failure';
    }
  } catch (error) { $('#ai-result').textContent = error.message; $('#ai-result').className = 'access-result failure'; }
  finally { button.disabled = false; button.textContent = 'Check AI model'; }
});

try { state.config = await api('/api/config'); } catch { /* Local fixture default */ }
if (state.config.mode === 'fixture') document.body.classList.add('fixture');
if (state.config.mode === 'sandbox') $('#check-access').classList.remove('hidden');
if (state.config.aiEnabled && state.config.aiConfigured) $('#check-ai').classList.remove('hidden');
try { await Promise.all([loadCases(), loadOrders()]); } catch (error) { showToast(error.message, true); }
const initialPage = window.location.hash.slice(1);
setPage(['overview', 'disputes', 'orders', 'evidence', 'webhooks'].includes(initialPage) ? initialPage : 'disputes');

/* ---------------------------------------------------------------- *
 * Webhooks: live event feed, deadline watchdog, lifecycle simulator
 * ---------------------------------------------------------------- */

function renderEvents(rows = []) {
  const list = $('#events-list');
  if ($('#event-count')) $('#event-count').textContent = String(rows.length);
  if ($('#events-note')) {
    $('#events-note').textContent = rows.length
      ? `${rows.length} event${rows.length === 1 ? '' : 's'} received · newest first`
      : 'No events received yet. Use the simulator to drive the lifecycle.';
  }
  if (!list) return;
  list.innerHTML = rows.length ? rows.map(row => {
    const tags = [row.simulated ? 'SIMULATED' : 'SIGNED', row.verified ? 'verified' : 'unverified', row.triaged ? 'triaged' : (row.processed ? 'processed' : 'pending')]
      .map(tag => `<span class="event-tag ${/SIMULATED|unverified/.test(tag) ? 'warn' : ''}">${escapeHtml(tag)}</span>`).join(' ');
    const dispute = row.disputeId ? `<button class="quiet-button open-case" data-case="${escapeHtml(row.disputeId)}">Open case</button>` : '';
    const error = row.error ? `<p class="event-error">${escapeHtml(row.error)}</p>` : '';
    return `<div class="workspace-row event-row"><span class="case-symbol">⇄</span><div><strong>${escapeHtml(row.label || row.eventType)}</strong><small>${escapeHtml(row.eventType)}${row.disputeId ? ` · ${escapeHtml(row.disputeId)}` : ''} · ${relative(row.receivedAt)}</small><div class="event-tags">${tags}</div>${error}</div>${dispute}</div>`;
  }).join('') : '<p class="empty-evidence">No webhook events recorded yet.</p>';
  document.querySelectorAll('#events-list .open-case').forEach(button => button.addEventListener('click', () => { setPage('disputes'); loadCase(button.dataset.case); }));
}

async function loadEvents() {
  try {
    const result = await api('/api/events');
    renderEvents(result.events || []);
  } catch (error) { showToast(error.message, true); }
}

function renderWatchdog(cases = []) {
  const list = $('#watchdog-list');
  if (!list) return;
  list.innerHTML = cases.length ? cases.map(item => {
    const due = item.due ? date(item.due, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No deadline returned';
    return `<div class="workspace-row"><span class="urgency-dot ${escapeHtml(item.urgency)}"></span><div><strong>${escapeHtml(item.reasonLabel)}</strong><small>${escapeHtml(due)} · ${escapeHtml(item.label)}${item.needsResponse ? ' · awaiting your response' : ''}</small></div><button class="quiet-button open-case" data-case="${escapeHtml(item.disputeId)}">Open case</button></div>`;
  }).join('') : '<p class="empty-evidence">No cases are being watched.</p>';
  document.querySelectorAll('#watchdog-list .open-case').forEach(button => button.addEventListener('click', () => { setPage('disputes'); loadCase(button.dataset.case); }));
}

async function loadWatchdog() {
  try {
    const result = await api('/api/watchdog');
    renderWatchdog(result.cases || []);
  } catch (error) { showToast(error.message, true); }
}

function renderAttempts(rows = []) {
  const list = $('#attempts-list');
  if (!list) return;
  if ($('#attempts-note')) {
    $('#attempts-note').textContent = rows.length
      ? `${rows.length} delivery attempt${rows.length === 1 ? '' : 's'} seen, including rejected ones`
      : 'No delivery attempts seen yet. If PayPal reports a send, one should appear here.';
  }
  const tone = { accepted: 'ok', duplicate: 'ok', 'accepted-fixture': 'warn', duplicate_warn: 'warn' };
  list.innerHTML = rows.length ? rows.map(row => {
    const bad = ['signature-rejected', 'not-configured', 'missing-headers', 'bad-json'].includes(row.outcome);
    return `<div class="workspace-row event-row"><span class="urgency-dot ${bad ? 'overdue' : 'ok'}"></span><div><strong>${escapeHtml(row.outcome)}</strong><small>${escapeHtml(row.eventType || 'unknown event')}${row.eventId ? ` · ${escapeHtml(row.eventId)}` : ''} · ${relative(row.at)}</small>${row.detail ? `<p class="event-error">${escapeHtml(row.detail)}</p>` : ''}</div></div>`;
  }).join('') : '<p class="empty-evidence">Nothing has been delivered to the webhook endpoint yet.</p>';
}

async function loadAttempts() {
  try {
    const result = await api('/api/webhooks/attempts');
    renderAttempts(result.attempts || []);
  } catch (error) { showToast(error.message, true); }
}

function setStreamState(text, ok) {
  const node = $('#stream-state');
  if (!node) return;
  node.textContent = text;
  node.className = `live-pill ${ok ? 'live-on' : 'live-off'}`;
}

function connectEventStream() {
  if (typeof EventSource === 'undefined') return setStreamState('live updates unavailable', false);
  const source = new EventSource('/api/events/stream');
  source.addEventListener('open', () => setStreamState('● live', true));
  source.addEventListener('error', () => setStreamState('reconnecting…', false));
  source.addEventListener('webhook', event => {
    const payload = JSON.parse(event.data || '{}');
    showToast(payload.simulated ? `Simulated ${payload.label || 'event'} received.` : `${payload.label || 'Dispute event'} received from PayPal.`);
    loadEvents();
    if (payload.disputeId) loadCases().catch(() => {});
  });
  source.addEventListener('triage', event => {
    const payload = JSON.parse(event.data || '{}');
    showToast(`Case ${payload.disputeId} triaged automatically (${payload.trigger}).`);
    loadCases().catch(() => {});
    loadWatchdog().catch(() => {});
  });
  source.addEventListener('case-updated', () => { loadCases().catch(() => {}); });
  source.addEventListener('webhook-attempt', () => { loadAttempts().catch(() => {}); });
  return source;
}

if ($('#simulate-lifecycle')) {
  $('#simulate-lifecycle').addEventListener('click', async () => {
    const disputeId = state.activeId || state.cases[0]?.id || null;
    if (!disputeId) return showToast('No case is loaded to attach the lifecycle to.', true);
    try {
      const result = await api('/api/webhooks/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sequence: true, disputeId }),
      });
      showToast(`Fired ${result.sequence.length} simulated lifecycle events for ${disputeId}.`);
      setTimeout(() => { loadEvents(); loadWatchdog(); loadCases().catch(() => {}); }, 400);
    } catch (error) { showToast(error.message, true); }
  });
}
if ($('#refresh-watchdog')) $('#refresh-watchdog').addEventListener('click', () => loadWatchdog());
if ($('#refresh-attempts')) $('#refresh-attempts').addEventListener('click', () => loadAttempts());
if ($('#event-count')) loadEvents();
if ($('#attempts-list')) loadAttempts();
connectEventStream();
