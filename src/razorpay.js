const crypto = require("crypto");

const KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "aegiscart_mock_webhook_secret";

const isLive = Boolean(KEY_ID && KEY_SECRET && KEY_ID.startsWith("rzp_"));

/**
 * Real client: the actual Razorpay Node SDK, only ever instantiated
 * with a server-side secret. The checkout executor is the ONLY module
 * in this codebase that imports this file. Neither the LLM planner nor
 * any browser-facing route touches KEY_SECRET.
 */
let liveClient = null;
if (isLive) {
  const Razorpay = require("razorpay");
  liveClient = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
}

// ---- Mock implementation ------------------------------------------------
// Mirrors the real SDK/API surface closely enough to exercise the exact
// same signature-verification and webhook code paths without needing
// live credentials. Swap to real rzp_test_ keys in .env with zero code
// changes elsewhere in the app.
const mockOrders = new Map();

function mockCreateOrder({ amount, currency, receipt, notes }) {
  const id = `order_MOCK${crypto.randomBytes(7).toString("hex")}`;
  const order = { id, entity: "order", amount, amount_paid: 0, amount_due: amount, currency, receipt, status: "created", notes, created_at: Math.floor(Date.now() / 1000) };
  mockOrders.set(id, order);
  return order;
}

function mockSignPayload(orderId, paymentId) {
  return crypto.createHmac("sha256", KEY_SECRET || WEBHOOK_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
}

/** Simulates what Razorpay Checkout hands back to the browser on success. */
function mockSimulateCheckoutSuccess(orderId) {
  const order = mockOrders.get(orderId);
  if (!order) throw new Error("unknown mock order");
  const paymentId = `pay_MOCK${crypto.randomBytes(7).toString("hex")}`;
  order.status = "paid";
  order.amount_paid = order.amount;
  order.amount_due = 0;
  const signature = mockSignPayload(orderId, paymentId);
  return { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature };
}

function mockSimulateCheckoutFailure(orderId) {
  const order = mockOrders.get(orderId);
  if (!order) throw new Error("unknown mock order");
  const paymentId = `pay_MOCKFAIL${crypto.randomBytes(6).toString("hex")}`;
  return { razorpay_order_id: orderId, razorpay_payment_id: paymentId, error: { code: "BAD_REQUEST_ERROR", description: "Payment failed at bank (simulated: insufficient funds).", reason: "payment_failed" } };
}

/** Builds a signed webhook body the same way Razorpay would sign one. */
function mockBuildWebhookEvent({ event, orderId, paymentId, amount, status }) {
  const body = {
    entity: "event",
    account_id: "acc_MOCKACCOUNT",
    event,
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: "payment",
          amount,
          currency: "INR",
          status,
          order_id: orderId,
          method: "upi",
          captured: status === "captured",
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };
  const rawBody = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  const eventId = `evt_mock_${crypto.randomBytes(8).toString("hex")}`;
  return { rawBody, signature, eventId };
}

// ---- Unified interface ---------------------------------------------------

async function createOrder({ amountPaise, receipt, notes }) {
  if (isLive) {
    return liveClient.orders.create({ amount: amountPaise, currency: "INR", receipt, notes, payment_capture: 1 });
  }
  return mockCreateOrder({ amount: amountPaise, currency: "INR", receipt, notes });
}

/** Verify the signature the browser hands back after Checkout completes. */
function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const secret = isLive ? KEY_SECRET : (KEY_SECRET || WEBHOOK_SECRET);
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || "", "utf-8").length === expected.length ? Buffer.from(signature) : Buffer.alloc(expected.length));
}

/** Verify an inbound webhook's raw-body HMAC signature. */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader || ""));
  } catch {
    return false;
  }
}

module.exports = {
  isLive,
  createOrder,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  mock: {
    simulateCheckoutSuccess: mockSimulateCheckoutSuccess,
    simulateCheckoutFailure: mockSimulateCheckoutFailure,
    buildWebhookEvent: mockBuildWebhookEvent,
  },
  keyId: KEY_ID || "rzp_test_MOCKMODE (no real key configured)",
};
