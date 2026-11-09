const express = require("express");
const { db } = require("../store");
const audit = require("../audit");
const rzp = require("../razorpay");
const { processWebhook } = require("./webhooks");

const router = express.Router();

router.post("/simulate-payment", (req, res) => {
  if (rzp.isLive) {
    return res.status(400).json({ error: "live Razorpay keys are configured — use real Checkout, not the mock simulator" });
  }

  const { checkout_intent_id, outcome } = req.body || {};
  const intent = db.checkoutIntents.get(checkout_intent_id);
  if (!intent || !intent.razorpay_order_id) {
    return res.status(404).json({ error: "checkout intent (with an order) not found" });
  }
  const order = db.orders.get(intent.razorpay_order_id);
  if (!order) return res.status(404).json({ error: "order not found" });
  if (["cancelled", "expired", "captured", "needs_review"].includes(order.status)) {
    return res.status(409).json({ error: `order is ${order.status}` });
  }

  if (outcome === "success") {
    const cb = rzp.mock.simulateCheckoutSuccess(order.id);
    const sigOk = rzp.verifyCheckoutSignature({ orderId: cb.razorpay_order_id, paymentId: cb.razorpay_payment_id, signature: cb.razorpay_signature });

    audit.appendEvent({
      type: "checkout.signature_verified",
      actor: "checkout_executor",
      correlationId: order.quote_snapshot.id,
      data: { razorpay_order_id: cb.razorpay_order_id, razorpay_payment_id: cb.razorpay_payment_id, simulated: true },
      reasons: [sigOk ? "HMAC(order_id|payment_id) matches — provisional success, awaiting authoritative webhook" : "signature mismatch"],
    });
    order.status = "signature_verified";

    const { rawBody, signature, eventId } = rzp.mock.buildWebhookEvent({
      event: "payment.captured",
      orderId: order.id,
      paymentId: cb.razorpay_payment_id,
      amount: order.amount_paise,
      status: "captured",
    });
    const result = processWebhook(rawBody, signature, eventId);
    return res.json({ outcome: "success", checkout_callback: cb, webhook_result: result.body });
  }

  if (outcome === "failure") {
    const cb = rzp.mock.simulateCheckoutFailure(order.id);

    audit.appendEvent({
      type: "checkout.failed_at_gateway",
      actor: "razorpay_checkout",
      correlationId: order.quote_snapshot.id,
      data: { razorpay_order_id: order.id, razorpay_payment_id: cb.razorpay_payment_id, error: cb.error, simulated: true },
      reasons: [`gateway declined: ${cb.error.description}`],
    });

    const { rawBody, signature, eventId } = rzp.mock.buildWebhookEvent({
      event: "payment.failed",
      orderId: order.id,
      paymentId: cb.razorpay_payment_id,
      amount: order.amount_paise,
      status: "failed",
    });
    const result = processWebhook(rawBody, signature, eventId);
    return res.json({ outcome: "failure", checkout_callback: cb, webhook_result: result.body });
  }

  return res.status(400).json({ error: "outcome must be 'success' or 'failure'" });
});

module.exports = router;
