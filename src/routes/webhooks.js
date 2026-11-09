const express = require("express");
const { db } = require("../store");
const audit = require("../audit");
const rzp = require("../razorpay");
const { releaseInventory, reserveInventory } = require("../quote");

const router = express.Router();

/**
 * Core processing logic, factored out so both the real HTTP route (raw
 * body from Razorpay) and the mock simulator (constructed-but-still-
 * signed body, for demo purposes without live credentials) exercise the
 * identical verification + state-machine code path.
 */
function processWebhook(rawBody, signatureHeader, eventIdOverride) {
  const signatureOk = rzp.verifyWebhookSignature(rawBody, signatureHeader);
  if (!signatureOk) {
    return { httpStatus: 400, body: { error: "invalid webhook signature" } };
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, body: { error: "malformed webhook body" } };
  }

  const eventId = eventIdOverride || event.id || `${event.event}_${event.payload?.payment?.entity?.id}`;

  // Dedupe: Razorpay may redeliver the same event; retries can occur up
  // to 24 times over 24h, and delivery order isn't guaranteed.
  if (db.webhookInbox.has(eventId)) {
    return { httpStatus: 200, body: { status: "duplicate_ignored", event_id: eventId } };
  }
  db.webhookInbox.add(eventId);

  const payment = event.payload?.payment?.entity;
  if (!payment) {
    return { httpStatus: 200, body: { status: "ignored_unhandled_event_type" } };
  }

  const orderId = payment.order_id;
  const order = db.orders.get(orderId);
  if (!order) {
    return { httpStatus: 200, body: { status: "ignored_unknown_order" } };
  }

  const correlationId = order.checkout_intent_id;

  if (event.event === "payment.captured" || (event.event === "payment.authorized" && payment.captured)) {
    // The buyer closed or abandoned this order, yet money arrived. Never fulfil it
    // automatically; flag it for a human (refund or manual fulfilment).
    if (["cancelled", "expired", "needs_review"].includes(order.status)) {
      const wasStatus = order.status;
      order.status = "needs_review";
      order.payment_id = payment.id;
      db.payments.set(payment.id, { id: payment.id, order_id: orderId, status: "captured", amount: payment.amount });
      audit.appendEvent({
        type: "webhook.payment_captured_after_close",
        actor: "razorpay_webhook",
        correlationId,
        data: { order_id: orderId, payment_id: payment.id, event_id: eventId, amount_paise: payment.amount, previous_status: wasStatus },
        reasons: [`payment captured for an order that was ${wasStatus}`, "fulfilment NOT queued", "needs operator review: refund or manual fulfilment (no autonomous refund in MVP)"],
      });
      return { httpStatus: 200, body: { status: "flagged_for_review", event_id: eventId } };
    }

    // Monotonic transition: only move forward from a verified state.
    if (order.status !== "captured") {
      // A retry inside Checkout can succeed after an earlier failed attempt released the stock.
      // Take the stock back so fulfilment is backed by a reservation.
      const wasFailed = order.status === "failed";
      if (wasFailed) reserveInventory(order.quote_snapshot);
      order.status = "captured";
      order.payment_id = payment.id;
      db.payments.set(payment.id, { id: payment.id, order_id: orderId, status: "captured", amount: payment.amount });
      audit.appendEvent({
        type: "webhook.payment_captured",
        actor: "razorpay_webhook",
        correlationId,
        data: { order_id: orderId, payment_id: payment.id, event_id: eventId, amount_paise: payment.amount },
        reasons: wasFailed
          ? ["signature verified", "payment succeeded on a retry after an earlier failed attempt", "stock re-reserved for fulfilment (check availability if it was sold out meanwhile)"]
          : ["signature verified", "event id not previously seen", "order found and pending"],
      });
      audit.appendEvent({
        type: "fulfilment.queued",
        actor: "system",
        correlationId,
        data: { order_id: orderId },
        reasons: ["payment.captured confirmed by verified webhook — fulfilment authorized"],
      });
    }
  } else if (event.event === "payment.failed") {
    // Further failed attempts on an order that is already closed must not release stock a second time.
    if (["captured", "cancelled", "expired", "failed", "needs_review"].includes(order.status)) {
      audit.appendEvent({
        type: "webhook.payment_failed_ignored",
        actor: "razorpay_webhook",
        correlationId,
        data: { order_id: orderId, payment_id: payment.id, event_id: eventId, order_status: order.status },
        reasons: [`failed attempt on an order that is already ${order.status}`, "no state change and no second stock release"],
      });
    } else {
      order.status = "failed";
      order.payment_id = payment.id;
      releaseInventory(order.quote_snapshot);
      audit.appendEvent({
        type: "webhook.payment_failed",
        actor: "razorpay_webhook",
        correlationId,
        data: { order_id: orderId, payment_id: payment.id, event_id: eventId, reason: event.payload?.payment?.entity?.error_description || "payment failed at bank/PSP (simulated)" },
        reasons: ["signature verified", "no fulfilment will occur", "inventory reservation released", "buyer may retry with a fresh checkout"],
      });
    }
  }

  return { httpStatus: 200, body: { status: "processed", event_id: eventId } };
}

// Razorpay requires the RAW body for signature verification, so this
// route uses express.raw() rather than the global json() parser.
router.post("/razorpay", express.raw({ type: "*/*" }), (req, res) => {
  const rawBody = req.body.toString("utf-8");
  const signatureHeader = req.header("X-Razorpay-Signature");
  const result = processWebhook(rawBody, signatureHeader);
  // Always ack fast; Razorpay expects HTTP 200 within 5s and retries on
  // non-2xx. All heavier processing above is already synchronous/cheap
  // for this demo; in production this line is where you'd enqueue.
  res.status(result.httpStatus).json(result.body);
});

module.exports = { router, processWebhook };
