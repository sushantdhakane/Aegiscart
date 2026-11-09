const express = require("express");
const crypto = require("crypto");
const { db } = require("../store");
const audit = require("../audit");
const policyEngine = require("../policy");
const rzp = require("../razorpay");
const { runAgent } = require("../buyer-agent");
const { createCheckoutIntent, cancelIntent, getOpenOrder, dismissCheckout, abandonOrder } = require("../checkout-intents");
const {
  searchCatalog,
  suggestPromotions,
  createQuote,
  getQuote,
  isExpired,
  reserveInventory,
  findSku,
} = require("../quote");

const router = express.Router();

/** What the browser needs to open (or reopen) Razorpay Checkout for an order. */
function checkoutPayload(intentId, orderId, amountPaise) {
  return {
    checkout_intent_id: intentId,
    razorpay_order_id: orderId,
    amount_paise: amountPaise,
    currency: "INR",
    key_id: rzp.keyId,
    live_mode: rzp.isLive,
    merchant_name: db.catalog.merchant.name,
  };
}

// ---- Discovery ------------------------------------------------------------

router.get("/catalog", (req, res) => {
  const { query = "", budget, category } = req.query;
  const budgetPaise = budget ? Math.round(Number(budget) * 100) : null;
  const results = searchCatalog({ query, budgetPaise, category: category || null });
  res.json({
    catalog_version: db.catalog.catalog_version,
    merchant: db.catalog.merchant,
    count: results.length,
    skus: results,
  });
});

/**
 * Autonomous buyer agent. Give it a goal in plain English; it searches, picks,
 * adds approved offers, quotes, asks the policy engine, repairs the cart if
 * denied, and stops at a pending checkout intent. It cannot pay.
 */
router.post("/run", async (req, res) => {
  const { goal, allow_offers } = req.body || {};
  if (typeof goal !== "string" || !goal.trim()) return res.status(400).json({ error: "goal is required" });
  if (goal.length > 300) return res.status(400).json({ error: "goal too long (max 300 characters)" });
  try {
    res.json(await runAgent({ goal: goal.trim(), allowOffers: allow_offers !== false }));
  } catch (err) {
    console.error("agent run failed:", err);
    res.status(500).json({ error: "agent_failed" });
  }
});

// ---- Quoting ----------------------------------------------------------------

router.post("/quotes", (req, res) => {
  const { lines, accepted_promotion_ids = [] } = req.body || {};
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "lines[] required, e.g. [{sku:'SKU-...', qty:1}]" });
  }

  const result = createQuote({ lines, acceptedPromotionIds: accepted_promotion_ids });
  if (!result.ok) {
    return res.status(422).json({ error: "quote_failed", details: result.errors });
  }

  const quote = result.quote;
  const promotions = suggestPromotions(quote.lines);

  audit.appendEvent({
    type: "quote.issued",
    actor: "quote_service",
    correlationId: quote.id,
    data: { quote_id: quote.id, catalog_version: quote.catalog_version, total_paise: quote.total_paise, quote_hash: quote.quote_hash },
    reasons: [`catalog v${quote.catalog_version} retrieved`, "price/tax/delivery computed server-side, not by the model"],
  });

  res.json({ quote, suggested_promotions: promotions.filter((p) => !quote.applied_promotions.some((ap) => ap.id === p.id)) });
});

router.get("/quotes/:id", (req, res) => {
  const quote = getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: "quote not found" });
  res.json({ quote, expired: isExpired(quote) });
});

// ---- Checkout intents (policy gate) ------------------------------------------

router.post("/checkout-intents", (req, res) => {
  const quote = getQuote((req.body || {}).quote_id);
  if (!quote) return res.status(404).json({ error: "quote not found" });
  const result = createCheckoutIntent(quote);
  res.status(result.status).json(result.body);
});

router.post("/checkout-intents/:id/cancel", (req, res) => {
  const result = cancelIntent(req.params.id);
  res.status(result.status).json(result.body);
});

/**
 * The buyer's explicit "Approve & Pay" click. This is a meaningful gate:
 * the policy is rechecked, and only THEN does the checkout executor
 * (never the LLM, never the browser) create the Razorpay Order.
 */
router.post("/checkout-intents/:id/confirm", async (req, res) => {
  const intent = db.checkoutIntents.get(req.params.id);
  if (!intent) return res.status(404).json({ error: "checkout intent not found" });
  if (intent.status !== "PENDING_CONFIRMATION") {
    return res.status(409).json({ error: `intent is ${intent.status}, cannot confirm` });
  }

  const quote = intent.quote_snapshot;
  if (isExpired(quote)) {
    return res.status(409).json({ error: "quote_expired" });
  }

  // Recheck policy immediately before spending money — mandate can be
  // invalidated by anything material changing between intent and confirm.
  const recheck = policyEngine.evaluateQuote(quote);
  audit.appendEvent({
    type: "policy.recheck_at_confirm",
    actor: "policy_engine",
    correlationId: quote.id,
    data: { checkout_intent_id: intent.id, decision: recheck.decision },
    reasons: recheck.reasons,
  });
  if (recheck.decision !== "ALLOW") {
    intent.status = "DENIED";
    return res.status(403).json({ decision: recheck });
  }

  audit.appendEvent({
    type: "buyer.approved",
    actor: "buyer",
    correlationId: quote.id,
    data: { checkout_intent_id: intent.id, quote_hash: quote.quote_hash, total_paise: quote.total_paise },
    reasons: ["explicit buyer click on Approve & Pay — this is the payment authorization, not a cosmetic confirmation"],
  });

  // receipt doubles as an external idempotency anchor tied 1:1 to this intent
  const receipt = `aegis_${intent.id}`.slice(0, 40);
  const order = await rzp.createOrder({ amountPaise: quote.total_paise, receipt, notes: { checkout_intent_id: intent.id, merchant_id: quote.merchant_id } });

  db.orders.set(order.id, {
    id: order.id,
    checkout_intent_id: intent.id,
    quote_snapshot: quote,
    amount_paise: quote.total_paise,
    receipt,
    status: "created",
    created_at: new Date().toISOString(),
  });
  intent.status = "ORDER_CREATED";
  intent.razorpay_order_id = order.id;

  audit.appendEvent({
    type: "razorpay.order_created",
    actor: "checkout_executor",
    correlationId: quote.id,
    data: { checkout_intent_id: intent.id, razorpay_order_id: order.id, amount_paise: quote.total_paise, receipt, live_mode: rzp.isLive },
    reasons: ["policy ALLOW recorded immediately prior", "unique receipt derived from checkout intent (idempotency anchor)"],
  });

  res.json(checkoutPayload(intent.id, order.id, quote.total_paise));
});

/**
 * Called by the browser after Razorpay Checkout completes (real mode)
 * with the three fields Checkout hands back. This is treated as
 * PROVISIONAL — order is not marked captured here. That only happens
 * once the signed webhook arrives, which is the authoritative source.
 */
router.post("/checkout-intents/:id/checkout-callback", (req, res) => {
  const intent = db.checkoutIntents.get(req.params.id);
  if (!intent) return res.status(404).json({ error: "checkout intent not found" });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  const order = db.orders.get(razorpay_order_id);
  if (!order || order.checkout_intent_id !== intent.id) {
    return res.status(400).json({ error: "order/intent mismatch" });
  }

  if (["cancelled", "expired", "needs_review"].includes(order.status)) {
    return res.status(409).json({ error: "order_closed", order_status: order.status });
  }

  const sigOk = rzp.verifyCheckoutSignature({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature });

  audit.appendEvent({
    type: sigOk ? "checkout.signature_verified" : "checkout.signature_invalid",
    actor: "checkout_executor",
    correlationId: order.quote_snapshot.id,
    data: { razorpay_order_id, razorpay_payment_id },
    reasons: [sigOk ? "HMAC(order_id|payment_id) matches — provisional success, awaiting authoritative webhook" : "signature mismatch — payment NOT trusted from browser callback alone"],
  });

  if (!sigOk) {
    return res.status(400).json({ error: "signature_invalid" });
  }

  // The webhook may already have arrived and marked the order captured: never move backwards.
  if (order.status === "created") order.status = "signature_verified";
  res.json({ status: order.status === "captured" ? "captured" : "signature_verified", awaiting_webhook: order.status !== "captured" });
});

/**
 * The buyer closed Razorpay Checkout without paying (Checkout's ondismiss).
 * Recorded in the audit ledger; the order stays open and can be resumed or cancelled.
 */
router.post("/checkout-intents/:id/dismiss", (req, res) => {
  const result = dismissCheckout(req.params.id);
  res.status(result.status).json(result.body);
});

/** Reopen payment for the same unpaid order (no new order, so no duplicate charge risk). */
router.post("/checkout-intents/:id/resume", (req, res) => {
  const r = getOpenOrder(req.params.id);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  audit.appendEvent({
    type: "checkout.resumed",
    actor: "buyer",
    correlationId: r.order.quote_snapshot.id,
    data: { checkout_intent_id: r.intent.id, razorpay_order_id: r.order.id },
    reasons: ["buyer reopened payment for the same open order; no new order was created"],
  });
  res.json(checkoutPayload(r.intent.id, r.order.id, r.order.amount_paise));
});

/** Cancel an unpaid order and release its stock. */
router.post("/checkout-intents/:id/abandon", (req, res) => {
  const result = abandonOrder(req.params.id);
  res.status(result.status).json(result.body);
});

// ---- Orders / status ----------------------------------------------------------

router.get("/orders/:id", (req, res) => {
  const order = db.orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "order not found" });
  res.json(order);
});

router.get("/policy", (req, res) => {
  res.json({ policy_version: db.policyVersion, policy: db.policy });
});

router.get("/well-known", (req, res) => {
  res.json({
    protocol: "aegiscart-agent-commerce/0.1",
    merchant: db.catalog.merchant,
    catalog_version: db.catalog.catalog_version,
    endpoints: {
      catalog: "/v1/agent/catalog",
      run: "/v1/agent/run",
      quotes: "/v1/agent/quotes",
      checkout_intents: "/v1/agent/checkout-intents",
      orders: "/v1/agent/orders/{id}",
    },
    rules: [
      "Agents may only call search_catalog and create_quote — never set price, discount, or stock.",
      "Every money action requires a policy-engine ALLOW decision recorded against the exact quote hash.",
      "Payment credentials are never exposed to the agent or the browser origin outside Razorpay Checkout.",
      "Fulfilment occurs only after a signature-verified, webhook-confirmed captured payment.",
    ],
  });
});

module.exports = router;
