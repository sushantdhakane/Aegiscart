const crypto = require("crypto");
const { db } = require("./store");
const audit = require("./audit");
const policyEngine = require("./policy");
const { isExpired, reserveInventory, releaseInventory } = require("./quote");

/**
 * The policy gate. Evaluates a quote, records the decision, and only on ALLOW
 * reserves stock and creates a pending checkout intent. Used by the HTTP API
 * (external AI buyers) and by the built-in buyer agent, so both go through
 * exactly the same non-bypassable check.
 */
function createCheckoutIntent(quote) {
  if (isExpired(quote)) {
    audit.appendEvent({
      type: "checkout_intent.denied",
      actor: "policy_engine",
      correlationId: quote.id,
      data: { quote_id: quote.id },
      reasons: ["quote expired: a fresh quote is required"],
    });
    return { status: 409, body: { error: "quote_expired" } };
  }

  const decision = policyEngine.evaluateQuote(quote);
  audit.appendEvent({
    type: "policy.decision",
    actor: "policy_engine",
    correlationId: quote.id,
    data: { quote_id: quote.id, decision: decision.decision, policy_version: decision.policy_version, requires_human_approval: decision.requires_human_approval },
    reasons: decision.reasons,
  });

  if (decision.decision !== "ALLOW") {
    return { status: 403, body: { decision, quote_id: quote.id } };
  }

  const intentId = `ci_${crypto.randomBytes(8).toString("hex")}`;
  reserveInventory(quote);
  const intent = {
    id: intentId,
    quote_id: quote.id,
    quote_snapshot: quote,
    status: "PENDING_CONFIRMATION",
    policy_decision: decision,
    created_at: new Date().toISOString(),
  };
  db.checkoutIntents.set(intentId, intent);

  audit.appendEvent({
    type: "inventory.reserved",
    actor: "system",
    correlationId: quote.id,
    data: { checkout_intent_id: intentId, lines: quote.lines.map((l) => ({ sku: l.sku, qty: l.qty })) },
    reasons: ["stock reserved pending buyer approval or quote expiry"],
  });

  return { status: 200, body: { checkout_intent_id: intentId, status: intent.status, decision, quote } };
}

// How long an order stays payable after it is created. After this the order is
// expired and its stock released, so abandoned checkouts cannot hold stock forever.
const PAY_WINDOW_MS = Number(process.env.ORDER_PAY_WINDOW_MS || 15 * 60 * 1000);

function expireOrder(intent, order) {
  order.status = "expired";
  intent.status = "EXPIRED";
  releaseInventory(order.quote_snapshot);
  audit.appendEvent({
    type: "order.expired",
    actor: "system",
    correlationId: order.quote_snapshot.id,
    data: { checkout_intent_id: intent.id, razorpay_order_id: order.id },
    reasons: ["payment window passed with no payment; stock reservation released", "a payment arriving later would be flagged for review, not fulfilled"],
  });
}

/** Finds an order that was created but not paid, or explains why there is none. */
function getOpenOrder(intentId) {
  const intent = db.checkoutIntents.get(intentId);
  if (!intent) return { error: { status: 404, body: { error: "checkout intent not found" } } };
  const order = intent.razorpay_order_id && db.orders.get(intent.razorpay_order_id);
  if (intent.status !== "ORDER_CREATED" || !order) {
    return { error: { status: 409, body: { error: `intent is ${intent.status}, no open order` } } };
  }
  if (order.status !== "created") {
    return { error: { status: 409, body: { error: `order is ${order.status}`, order_status: order.status } } };
  }
  if (Date.now() - Date.parse(order.created_at) >= PAY_WINDOW_MS) {
    expireOrder(intent, order);
    return { error: { status: 409, body: { error: "payment_window_expired", order_status: "expired" } } };
  }
  return { intent, order };
}

/** Buyer closed Razorpay Checkout without paying. The order stays open and can be resumed. */
function dismissCheckout(intentId) {
  const r = getOpenOrder(intentId);
  if (r.error) return r.error;
  const resumableUntil = new Date(Date.parse(r.order.created_at) + PAY_WINDOW_MS).toISOString();
  audit.appendEvent({
    type: "checkout.dismissed",
    actor: "buyer",
    correlationId: r.order.quote_snapshot.id,
    data: { checkout_intent_id: intentId, razorpay_order_id: r.order.id, resumable_until: resumableUntil },
    reasons: ["buyer closed Razorpay Checkout without paying", "no payment was attempted; the order stays open and the stock stays held until the payment window ends"],
  });
  return { status: 200, body: { resumable: true, resumable_until: resumableUntil } };
}

/** Buyer closed checkout and chose not to pay: cancel the unpaid order and release the stock. */
function abandonOrder(intentId) {
  const r = getOpenOrder(intentId);
  if (r.error) return r.error;
  r.order.status = "cancelled";
  r.intent.status = "CANCELLED";
  releaseInventory(r.order.quote_snapshot);
  audit.appendEvent({
    type: "order.cancelled_by_buyer",
    actor: "buyer",
    correlationId: r.order.quote_snapshot.id,
    data: { checkout_intent_id: intentId, razorpay_order_id: r.order.id },
    reasons: ["buyer chose not to pay; stock reservation released", "if a payment still arrives for this order it is flagged for review instead of fulfilled"],
  });
  return { status: 200, body: { status: "cancelled" } };
}

/** Buyer walks away from a pending intent: release the held stock. */
function cancelIntent(intentId) {
  const intent = db.checkoutIntents.get(intentId);
  if (!intent) return { status: 404, body: { error: "checkout intent not found" } };
  if (intent.status !== "PENDING_CONFIRMATION") {
    return { status: 409, body: { error: `intent is ${intent.status}, cannot cancel` } };
  }
  intent.status = "CANCELLED";
  releaseInventory(intent.quote_snapshot);
  audit.appendEvent({
    type: "checkout_intent.cancelled",
    actor: "buyer",
    correlationId: intent.quote_id,
    data: { checkout_intent_id: intentId },
    reasons: ["buyer did not approve; stock reservation released"],
  });
  return { status: 200, body: { status: intent.status } };
}

/** Release stock held by intents whose quote expired without approval. */
function sweepExpiredIntents() {
  let released = 0;
  for (const intent of db.checkoutIntents.values()) {
    if (intent.status === "PENDING_CONFIRMATION" && isExpired(intent.quote_snapshot)) {
      intent.status = "EXPIRED";
      releaseInventory(intent.quote_snapshot);
      audit.appendEvent({
        type: "inventory.released",
        actor: "system",
        correlationId: intent.quote_id,
        data: { checkout_intent_id: intent.id },
        reasons: ["quote expired without buyer approval; stock reservation released"],
      });
      released++;
    }
  }
  for (const intent of db.checkoutIntents.values()) {
    if (intent.status !== "ORDER_CREATED") continue;
    const order = db.orders.get(intent.razorpay_order_id);
    if (order && order.status === "created" && Date.now() - Date.parse(order.created_at) >= PAY_WINDOW_MS) {
      expireOrder(intent, order);
      released++;
    }
  }
  return released;
}

module.exports = { createCheckoutIntent, cancelIntent, sweepExpiredIntents, getOpenOrder, dismissCheckout, abandonOrder, PAY_WINDOW_MS };
