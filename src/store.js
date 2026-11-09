// In-memory store for the buildathon MVP.
// The data model mirrors the production schema (quote, checkout_intent,
// razorpay_order, payment, audit_event, policy_version, webhook_inbox) —
// see README "Production path" for what swaps in for Postgres/Redis.

const fs = require("fs");
const path = require("path");

const catalogData = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "catalog.json"), "utf-8")
);

const db = {
  catalog: catalogData,
  quotes: new Map(),
  checkoutIntents: new Map(),
  orders: new Map(),
  payments: new Map(),
  auditLog: [],
  webhookInbox: new Set(), // dedupe by event id
  reservations: new Map(), // sku -> reserved qty (in addition to catalog.stock consumed)
};

// ---- Policy (versioned) -----------------------------------------------
// A merchant-configured, human-editable policy. Any change bumps the
// version; every quote/decision records which version it was evaluated
// against so decisions stay explainable after the fact.
db.policyVersion = "policy_17";
db.policy = {
  allowed_action: "CREATE_ORDER",
  currency: "INR",
  max_order_amount_paise: 500000, // ₹5,000
  max_quantity_per_sku: 3,
  approved_promotions: ["bundle-mug-v2", "gift-wrap-v1", "bundle-protein-v1"],
  max_discount_percent: 20,
  quote_ttl_minutes: 10,
  require_verified_buyer: false, // demo default; flip on for a real deployment
  require_human_approval_above_paise: 300000, // ₹3,000
  deny_if_catalog_stale_minutes: 60 * 24 * 365, // relaxed for a static demo catalog
  paused: false, // emergency kill switch
};

module.exports = { db };
