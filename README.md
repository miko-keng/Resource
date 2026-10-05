# Recourse

Recourse helps small merchants review PayPal disputes with their order and fulfillment records in one place. It surfaces relevant evidence, missing facts, and an editable response draft. The merchant stays in control: a response is sent only after a separate approval step.

> **Current build status:** fixture and PayPal Sandbox modes are available. Sandbox OAuth and real dispute retrieval have been verified with dispute `PP-R-LEL-10190268` in the local development environment. The first linked order uses synthetic fulfillment records for demo purposes; those records are labeled and are not presented as PayPal evidence of delivery.

## Start here

Requirements: Node.js 20 or newer. No package install is needed.

```sh
cd outputs/recourse
cp .env.example .env
npm run dev
```

Open <http://localhost:3000>. The demo contains three synthetic disputes and local order records. Review the item-not-received case, edit the draft, click **Review & submit response**, then confirm. The app records this as a fixture action; it does not contact PayPal.

The case source banner and the confirmation dialog identify fixture mode. All names, tracking data, amounts, and communications in `data/` are synthetic.

## Enable PayPal Sandbox

1. Create a PayPal Developer account and a Sandbox REST app with the Disputes API access needed to list and manage merchant disputes.
2. Create Sandbox personal (buyer) and business accounts. Make a test transaction from the buyer to the business; use a credit card if you plan to test a chargeback.
3. Create an item-not-received dispute for that transaction in the buyer Resolution Center, or use PayPal's sandbox-only dispute creation endpoint. API-based buyer dispute creation requires the `DISPUTE_CREATE` scope to be enabled by PayPal, buyer consent, and a PayPal-Auth-Assertion JWT. This permission can take time; don't build the timeline around it being granted immediately.
4. Put the Sandbox REST app Client ID and Secret into your local `.env` file. Keep them server-side and do not paste them into the browser or commit `.env`.
5. Set `PAYPAL_MODE=sandbox` and leave `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`.
6. Restart the app and open **Setup & demo notes → Check Sandbox API access**. This checks OAuth and attempts to retrieve the dispute list. Then refresh the cases.
7. Open the dispute and confirm PayPal's stage, status, due date, requested evidence, and returned action links. The response button is enabled only when the current dispute has a `provide-evidence` action; the server re-fetches the dispute and checks status, requested evidence type, and merchant approval immediately before submission.

The first local order is now linked to the Sandbox transaction created for this walkthrough (`4B653331N90046216`) through `paypal_transaction_id`. For another Sandbox transaction, replace that value in `data/orders.json` or add a separate order record. Keep fulfillment and communication values clearly synthetic unless you have a real merchant order source.

PayPal's test guide says seller evidence submission is supported when the case is `WAITING_FOR_SELLER_RESPONSE` and the returned HATEOAS links permit `provide-evidence`. Item-not-received evidence can include a `PROOF_OF_FULFILLMENT` tracking record. This adapter currently submits tracking evidence and notes, or `OTHER` notes. It intentionally does not implement accepting a claim, refunding, or deciding liability.

### Optional PayPal AI Toolkit for development

PayPal's [AI-Toolkit](https://github.com/paypal/AI-Toolkit) is a plugin for coding agents. It adds PayPal integration guidance and a Sandbox MCP connector; it is not a dependency for this web app. The local inspection copy is kept out of the application source; use the upstream repository for Codex setup. The MCP server can directly list and act on Sandbox resources, so Recourse keeps its customer-facing PayPal calls in its own narrow server adapter with the merchant approval gate. Do not put its broad action tools in the response-drafting model path.

The official [hackathon resources page](https://paypalaihackathon.devpost.com/resources) also links PayPal's agent toolkit and MCP quickstarts, API documentation, Sandbox getting-started guide, and upcoming webinars. We can consider PayPal's application Agent Toolkit later if its dispute-specific capabilities fit the approval model.

If Sandbox access is denied or the buyer setup is blocked, keep `PAYPAL_MODE=fixture`, use the seeded demo, and describe the limitation honestly. Fixture records and fixture submissions are separate from PayPal data and responses.

## Analysis engine and the AI switch

**AI is currently switched off.** `AI_ENABLED=false` in `.env` makes the model path unreachable, so the app makes no AI calls at all and every verdict comes from the deterministic engine in `lib/disputes.mjs`. The model code is kept intact in `server.mjs` (`analyzeWithModel`) and is reinstated by setting `AI_ENABLED=true` — nothing else changes. `GET /api/ai-check` reports this explicitly as `AI_DISABLED` rather than pretending the model is broken.

What the deterministic engine does, with no model involved:

- builds the evidence set from PayPal and the merchant records, every fact tagged `paypal` / `local` / `buyer`;
- works out which evidence types PayPal accepts **for this dispute reason** (`PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND`, `OTHER`) and which ones PayPal has actually requested;
- drafts the response by composing the linked source records verbatim;
- verifies every amount, date, tracking reference and order id in that draft against those sources;
- computes deadline urgency for the watchdog.

When AI is re-enabled the model drafts the prose, and the same deterministic verification still runs over its output. Provider resilience and grounding behaviour are covered by `tests/ai.test.mjs`.

```dotenv
AI_ENABLED=true
AI_PROVIDER=gemini
GEMINI_API_KEY=your-private-key
AI_MODEL=gemini-3.5-flash
AI_MODEL_FALLBACKS=gemini-3.5-flash-lite,gemini-3-flash-preview,gemini-flash-lite-latest
```

The model is never given PayPal credentials and cannot reach the action path. Submission is a separate, approval-gated server-side call.

### Models that actually work

| Model | Status |
| --- | --- |
| `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3-flash-preview`, `gemini-flash-lite-latest`, `gemini-3.1-flash-lite` | reachable |
| `gemini-2.5-flash`, `gemini-2.5-pro` | retired for new accounts (404) |
| `gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.1-pro-preview` | plan quota exhausted (429) |

An exhausted quota is detected and skipped rather than retried, because it cannot recover inside a single request.

## Structure

```text
outputs/recourse/
├── data/                 # Synthetic dispute and order fixtures
├── lib/
│   ├── ai.mjs            # Provider client: retry, timeout, model fallback, quota detection
│   └── disputes.mjs      # Pure dispute logic: evidence plan, grounding, deadline watchdog
├── public/               # Merchant UI (live webhook feed, dispute desk, evidence library)
├── tests/                # node:test unit + end-to-end suites (no dependencies)
├── .env.example          # Local-only configuration template
├── server.mjs            # HTTP API, PayPal adapter, webhook receiver, approval checks
├── package.json
└── README.md
```

The `.local/` directory stores the activity log and is ignored by Git. Secrets stay in the ignored `.env` file. The browser never receives PayPal or AI credentials.

## Current limits and next steps

- **Phase 1 feasibility:** Sandbox OAuth, real dispute retrieval, and the returned HATEOAS actions are verified against dispute `PP-R-LEL-10190268`. A successful approved evidence submission and PayPal's returned post-submission status still need to be captured for the final demo.
- **Sandbox evidence mapping:** the first real dispute is linked to synthetic local fulfillment records through `paypal_transaction_id`. The PayPal side of that order is read live from the Payments API (`/v2/payments/captures/{id}`, falling back to the Reporting and Orders APIs) and is labelled `PAYPAL` in the UI; fulfilment and message records are labelled `LOCAL` and are never presented as PayPal evidence.
- **Metrics hydration:** Sandbox case summaries are hydrated with detail responses for due dates, requested evidence, buyer context, and HATEOAS actions. Details are cached briefly to keep refreshes bounded.
- **Webhooks:** `POST /api/webhooks/paypal` accepts dispute events, verifies the signature through `/v1/notifications/verify-webhook-signature`, records each event id once so PayPal's retries cannot double-process it, and invalidates the cached dispute. Set `PAYPAL_WEBHOOK_ID` to enable it; without that value the endpoint refuses unverified events rather than trusting them. `POST /api/webhooks/simulate` drives the same path, clearly labelled as simulated, so the demo works without a public URL.
- A local JSON order file matches demo invoices. A real merchant integration needs an authenticated, tenant-scoped order-data source.
- The activity log is local JSON for this prototype, not a production database.
- There is no hosted demo or GitHub remote configured yet.

## Deploy a hosted demo

The app is a stateful Node server holding secrets, so it needs a host that runs a long-lived process. [Render](https://render.com/docs/free) fits, sets `PORT` for you, and needs no build step. `render.yaml` in the repository root is a ready blueprint; secrets go in the host dashboard, never in the repository.

```sh
HOST=0.0.0.0 PORT=3000 PAYPAL_MODE=sandbox DEMO_READONLY=true node server.mjs
```

Two environment flags exist purely for deployment:

| Variable | Default | Why it matters |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local development stays on loopback. A container or PaaS **must** set `0.0.0.0`, otherwise the service starts, reports healthy, and 502s every request. |
| `DEMO_READONLY` | `false` | On a public URL this refuses evidence submission with a clear 409, so a visitor cannot consume the one demoable dispute. It is reported in `GET /api/config`, and the UI disables the action and explains why. |

Two platform behaviours to plan around:

- **Cold starts.** Free instances spin down after inactivity, and a cold start can take far longer than PayPal’s 30-second webhook timeout. A delivery that hits a sleeping instance can look like a failure when it is not. Keep the service warm with a periodic ping during judging, or use a paid instance for the demo window.
- **Ephemeral state.** The container filesystem is not durable, so `.local/activity.json`, `events.json` and `packets.json` are lost on restart or redeploy and the event feed looks empty on a fresh instance. Accept it, attach a persistent disk, or seed a few events on boot.

Registering the webhook needs a public HTTPS URL, so localhost is not eligible. Point PayPal at `https://<your-app>/api/webhooks/paypal`, subscribe explicitly to the events listed above, and put the generated webhook id in `PAYPAL_WEBHOOK_ID` — verification is validated against that id, so a stale value makes every delivery fail. For local work a tunnel (`cloudflared tunnel --url http://localhost:3000`) is enough, but quick tunnels rotate their URL and the webhook has to be re-registered each time.

## Tests

No dependencies and no install step; Node’s built-in runner only.

```sh
npm test              # everything
npm run test:unit     # pure logic + AI client (fetch mocked, offline)
npm run test:e2e      # boots the real server against a stub PayPal
```

The end-to-end suite starts the server with `PAYPAL_TEST_MODE=true` and `PAYPAL_API_BASE` pointed at a local stub, then asserts on the exact PayPal calls made. It covers: the approval gate (no approval → no PayPal call), the per-reason evidence rules, the requested-evidence rule, the HATEOAS action gate, the 2,000-character limit, a real submission reaching PayPal exactly once with the right evidence shape, replay-safe webhooks, signature rejection, lifecycle simulation, pagination, SSE, the watchdog, and path-traversal refusal. State is isolated via `RECOURSE_STATE_DIR`, so tests never touch demo history.

The sandbox host guard stays strict in production; `PAYPAL_TEST_MODE` is the only thing that relaxes it.

### A bug worth knowing about

PayPal’s live sandbox returns dispute action names with **underscores** (`provide_evidence`, `accept_claim`), while its documentation uses hyphens (`provide-evidence`). Matching on the exact string silently hides an action PayPal has actually offered, which is exactly how the submit flow can look unavailable on a case that is ready for evidence. `hasAction` / `findAction` in `lib/disputes.mjs` normalise both forms, and the test stub returns the underscore form so it cannot regress.

## PayPal AI Hackathon checklist

Verified on the live Devpost page on October 4, 2026. The displayed deadline is **November 12, 2026 at 12:00 p.m. PST**. The live page says projects must meaningfully use PayPal and AI, demonstrate a working prototype, and be sufficiently documented. Submission requires:

- Project text description explaining features and functionality.
- Functional demo: hosted URL or complete instructions to run a working build (static mockups do not qualify).
- Tools used and how each is used.
- Public GitHub repository containing all source, assets, and instructions, open source with a top-level license.
- Public YouTube video under 3 minutes, showing the project functioning on its target device; include its link on Devpost. Avoid unauthorized third-party marks and copyrighted music/material.
- Final check against the live rules and schedule before submission.

Judging criteria shown on Devpost: technological implementation, design, potential impact, innovation/idea, and presentation. Re-check the live page before submitting in case its rules or deadline change.

## Privacy and safety

Use Sandbox data only for the demo. Never commit secrets or real customer information. AI output is decision support, not a dispute decision. The merchant reviews evidence and the final editable text, and must approve a PayPal action explicitly.
