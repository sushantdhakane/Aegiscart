# AegisCart — Bounded Agentic Checkout for Razorpay

*"We do not give an AI agent a wallet. We give it a
narrowly scoped, expiring, explainable authority to prepare a purchase — and a deterministic
payment system validates every commitment."*

This is a working, runnable implementation of the architecture from the research memos:
Ask → Quote → Consent → Pay → Prove, with a policy engine that gates every money action and an
append-only, hash-chained audit ledger you watch update live.

## Run it (2 minutes, no API keys required)

```bash
npm install
cp .env.example .env
npm start
```

Open **http://localhost:3000**. The app boots in **MOCK MODE**: it simulates Razorpay Orders,
Checkout, and signed webhooks internally, so the entire flow — including the success and failure
demo paths the buildathon asks for — runs with zero external calls or credentials.

### Switch to real Razorpay Test Mode

Drop `rzp_test_...` credentials into `.env`:

```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=<the secret you set on the webhook in the Razorpay Dashboard>
```

Restart the server. No other code changes are needed — `src/razorpay.js` swaps from the mock
implementation to the real `razorpay` SDK automatically, and the frontend loads the real
`checkout.js` and opens actual Razorpay Standard Checkout. You'll then need to point a webhook
at `POST /v1/webhooks/razorpay` (use a tunnel like `ngrok http 3000` for a public URL) and use
the test UPI handles `success@razorpay` / `failure@razorpay` to demo both paths for real.

## The autonomous buyer agent

Type a goal in plain English ("a birthday gift under ₹2000") and the agent does the rest with no manual
selection. `src/buyer-agent.js` runs this loop and `POST /v1/agent/run` exposes it:

1. **Understand**: pull out the item, category, quantity and an all-in budget.
2. **Search** the catalog and **rank** the options that fit the budget after tax and delivery.
3. **Add offers**: merchant-approved cross-sells, only if they fit the budget and policy (the buyer can switch this off).
4. **Quote**, then **ask the policy engine** for a decision.
5. **Self-correct on a DENY**: it reads the machine-readable violations (`MAX_QTY`, `MAX_AMOUNT`, rejected
   promotions, kill switch), repairs the cart one fix at a time, and asks again. "Buy 5 hampers" becomes 3,
   then 2, each step justified by a real policy decision.
6. **Stop and hand off** with a cleared cart. If it cannot find a compliant cart, or nothing fits, it
   escalates instead of guessing.

**Two modes.** With no key the agent runs on built-in rules (pattern matching), which is enough for phrasings
like "under ₹500", "buy 20 almonds" or "a birthday gift". Set `OPENROUTER_API_KEY` and a model
(default `nvidia/nemotron-3-ultra-550b-a55b:free`) takes over two jobs in `src/agent-brain.js`:

1. **Reading the goal** into structured fields (item, category, quantity, budget), so it also handles
   things like "two roasted almonds".
2. **Choosing a product** among the options that code has already checked against the budget, and explaining why.

The model is treated as an untrusted proposer, not a decision-maker:
- The buyer's text is sent as JSON data, never mixed into the instructions.
- Its output must match a strict schema, or it is thrown away.
- Numbers it returns (quantity, budget) must appear in the buyer's own text, so it cannot invent them.
- Its product pick must be one of the options the code offered. Anything else is rejected.
- It never sees or sets prices, stock, policy or payment details, and quotes still come from the catalog.
- Every LLM step falls back to the rules on error, timeout, bad JSON or a rate limit (HTTP 429). After a 429 the
  model is skipped for a minute (`OPENROUTER_COOLDOWN_MS`) so the demo never stalls. The trace and the audit
  ledger show when and why a fallback happened.

Only the buyer's request text and the product options (names, tags, quantities, totals) are sent to the model.
No payment data, keys or personal details leave your server. Reasoning is off by default (it adds latency
for a simple task); set `OPENROUTER_REASONING=true` to enable it. The header badge shows which mode is active.

**What the agent cannot do, by construction:** it never imports the Razorpay client, so it cannot create
an order or pay. It cannot set prices (quotes are computed from the catalog). Every step it takes is
written to the audit ledger. Only the buyer's **Approve & Pay** click can create the Razorpay order.
Starting a new run, or ignoring a cart until its quote expires, releases the stock it was holding.

## Closing Razorpay Checkout without paying

Razorpay Checkout tells the page when the buyer closes it (`ondismiss`). AegisCart handles that instead
of leaving the screen on "Opening Razorpay Checkout…":

- The page shows "Checkout closed. No payment was made" with **Resume payment** and **Cancel purchase**.
- **Resume** reopens Checkout for the *same* order (no new order, so no duplicate-charge risk).
  **Cancel** marks the order cancelled and releases the held stock. Both are in the audit ledger
  (`checkout.dismissed`, `checkout.resumed`, `order.cancelled_by_buyer`).
- An unpaid order stays payable for `ORDER_PAY_WINDOW_MS` (default 15 minutes), then it expires and its
  stock is released (`order.expired`), so abandoned checkouts cannot hold stock forever. Starting a new
  agent run also cancels a cart the buyer walked away from.
- If a payment still arrives for an order that was cancelled or expired, the webhook flags it
  (`webhook.payment_captured_after_close`, status `needs_review`) instead of fulfilling it. There is no
  automatic refund in this MVP; an operator decides.
- A failed attempt inside Checkout is explained on the page while the window stays open for a retry. If the
  retry then succeeds, the stock released by the earlier failure is taken back. A second failed attempt never
  releases stock twice, and a late browser callback can never move a captured order backwards.
- If Razorpay's script cannot load, the page says so and offers **Try again** (no payment was made).
- In mock mode the **Close without paying** button lets you demo this without a real Checkout window.
- If the webhook confirmation takes more than 45 seconds, the page hints that the webhook URL may not be
  set up. Orders are only marked paid by Razorpay's signed webhook, never by the browser alone.

## Merchant kill switch

The header's **Pause checkouts** button (`POST /v1/admin/pause`) makes the policy engine deny every
new checkout immediately and logs the change to the audit ledger. In-flight orders are unaffected.
The demo has no auth on this route; production would put it behind merchant RBAC.

## Tests

`npm test` boots its own server in mock mode and checks 60 properties: the demo scenarios, the LLM path against a fake OpenRouter that returns bad picks, invented numbers and 429s, closing/resuming/cancelling checkout, late and repeated payment events, order expiry, the agent's budget, offer and self-repair behaviour, that it can never create an order,
forged webhook and checkout signatures rejected, browser callback alone never captures, double-confirm
rejected, unknown SKUs rejected, kill switch, and audit hash-chain integrity.

## What it demonstrates

**Left panel (paper/receipt side)**: the buyer-facing flow:
1. Give the agent a goal (or click an example chip). Watch it search, choose, add offers, quote and ask
   the policy engine, step by step.
2. If the policy denies something, watch the agent repair the cart on its own.
3. Review the cleared cart. **Approve & Pay** is a real gate: it's the buyer's payment authorization.
4. The Razorpay Order is created only now. Payment is collected via Checkout. Fulfilment only happens
   after a **signature-verified, webhook-confirmed** capture.

**Right panel (terminal/ledger side)** — the audit trail, live:
Every step above emits an append-only event with a SHA-256 hash chained to the previous event
(`previous_event_hash` / `event_hash`), so tampering is detectable. A "chain verified" badge
recomputes the chain on every poll.

### Demo scenarios

| Scenario | Click this chip | What you'll see |
|---|---|---|
| **Fully autonomous purchase** | *Birthday gift under ₹2000* | Agent picks the hamper, adds gift wrap, skips the mug that would break the budget, gets ALLOW. Approve, then *Simulate success*: `razorpay.order_created` → `checkout.signature_verified` → `webhook.payment_captured` → `fulfilment.queued` |
| **Bounded and gated, with self-correction** | *Buy 5 festive hampers* | Policy DENY (quantity and amount limits) → agent cuts to 3 → DENY again → cuts to 2 → ALLOW. Flagged as above the human-approval threshold |
| **Graceful payment failure** | Any chip, approve, then *Simulate failure* | `webhook.payment_failed` → stock released → no fulfilment → clear message |
| **Agent knows when to stop** | *Gift under ₹100* | Nothing fits the budget: the agent escalates to the buyer instead of picking something anyway |

The same flow also works through the HTTP API for external AI buyers: `/v1/agent/catalog`, `/quotes`,
`/checkout-intents`, `/checkout-intents/:id/confirm`.

## Why this design (from the research)

- **The agent never gets payment authority.** It plans and prepares, but cannot pay. Only
  `src/razorpay.js`, imported solely by the checkout-intent confirm route, ever sees
  `RAZORPAY_KEY_SECRET`, and that route requires the buyer's approval.
- **Deterministic, non-bypassable policy gate** (`src/policy.js`): re-evaluated once when the
  checkout intent is created and again immediately before the Razorpay Order is created, against
  the merchant's versioned policy (`max_order_amount`, `max_quantity_per_sku`,
  `approved_promotions`, `require_human_approval_above`, etc. — same schema as the memo).
- **Provisional vs. authoritative state**: the browser's post-Checkout callback only marks a
  signature as verified; the order is only marked `captured` — and fulfilment only queued — once
  the signed `payment.captured` **webhook** arrives. This matches Razorpay's own guidance and the
  memo's "never fulfil from a browser callback alone" rule.
- **Idempotency**: each checkout intent gets one unique Razorpay `receipt`, used as the
  idempotency anchor; webhook events are deduped by `event_id` since Razorpay may redeliver.
- **Money math**: all amounts are integer paise end-to-end, never floating point.
- **Explainability**: every policy decision returns machine- and human-readable `reasons`, and
  every state transition is written to the append-only audit ledger before anything else happens.

## What's deliberately out of scope for this build (and why)

Per the research memos, these are explicitly **not** claimed or implemented, because the public
specs/access don't yet support them for a hackathon-scope build:

- **NPCI UAP** — reported/proposed only, no public spec.
- **UPI Reserve Pay / SBMD delegated debits** — real and documented, but partner-onboarding
  gated; the architecture has a `Payment router` seam (see `src/razorpay.js`) where a Reserve Pay
  adapter would slot in later without touching the policy engine or audit ledger.
- **ACP / AP2 / UCP / x402** — the agent-facing REST surface
  (`/v1/agent/catalog`, `/v1/agent/quotes`, `/v1/agent/checkout-intents`, `.well-known/agent-commerce.json`)
  is intentionally shaped so an ACP- or AP2-style adapter can be layered on top later; none of
  these protocols are claimed as supported today.
- Autonomous payment without a human's final approval, agent-set prices/discounts/refunds, and
  storage of card/UPI credentials are all explicitly excluded — the buyer's "Approve & Pay" click
  is the only thing that authorizes spend.

## Project layout

```
server.js                     Express app, mounts routes, serves the frontend
data/catalog.json             Demo merchant: 10 SKUs, 3 merchant-configured promotions
src/store.js                  In-memory store (catalog, quotes, orders, audit log, policy)
src/policy.js                 The non-bypassable policy/consent gate
src/quote.js                  Catalog search, quote pricing + hashing, inventory reservation
src/audit.js                  Append-only, hash-chained audit ledger
src/razorpay.js               Real Razorpay SDK (live test mode) OR mock, same interface
src/buyer-agent.js            The autonomous agent: plan, quote, policy check, self-repair, hand off
src/agent-brain.js            Understanding and product choice: LLM proposes, code validates, rules fall back
src/llm.js                    OpenRouter client (retry, 429 cooldown, JSON extraction)
src/checkout-intents.js       The policy-gated checkout intent (shared by the API and the agent)
src/routes/agent.js           Commerce API (catalog, run, quotes, checkout-intents, orders)
src/routes/admin.js           Policy view and the merchant kill switch
src/routes/webhooks.js        Raw-body signature verification + payment state machine
src/routes/mock.js            Mock-mode payment simulator (exercises the real webhook code path)
src/routes/audit.js           Read endpoint for the live audit dashboard
public/                       Demo UI: goal input and live agent trace (paper side) + audit ledger (terminal side)
```

## Path to production (from the research memo, unchanged)

1. **Pilot hardening**: swap the in-memory store for Postgres + a durable outbox/queue, move to
   Razorpay Technology Partner OAuth instead of raw API keys, add RBAC and an immutable audit
   export, load/chaos tests, security review (prompt injection in catalog text, replayed consent
   tokens).
2. **Controlled live pilot**: real KYC'd merchant(s), small caps, human-approval thresholds,
   canary rollout, India-region data residency for payment-adjacent data.
3. **Scale**: Shopify/WooCommerce connectors, ACP/AP2 protocol adapters once counterparties
   support them, UPI Reserve Pay for bounded repeat purchases, NPCI UAP once it's a real spec.
