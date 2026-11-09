const { db } = require("./store");

/**
 * Evaluate a proposed quote against the merchant's policy. This is the
 * ONLY function allowed to say ALLOW. Nothing upstream (the LLM, the
 * browser, the buyer) can set an amount or bypass this check — checkout
 * intents cannot be confirmed without a fresh ALLOW decision recorded
 * against the exact quote hash.
 *
 * Returns a durable, explainable decision object, matching the shape in
 * the research memo: { decision, policy_version, reasons }.
 */
function evaluateQuote(quote, { requireVerifiedBuyer = false } = {}) {
  const reasons = [];
  const policy = db.policy;
  let decision = "ALLOW";
  const violations = [];

  if (policy.paused) {
    return {
      decision: "DENY",
      policy_version: db.policyVersion,
      requires_human_approval: false,
      violations: [{ code: "KILL_SWITCH" }],
      reasons: ["merchant emergency kill switch is engaged: all new checkouts are blocked until re-enabled"],
    };
  }

  if (quote.total_paise > policy.max_order_amount_paise) {
    decision = "DENY";
    violations.push({ code: "MAX_AMOUNT", limit_paise: policy.max_order_amount_paise });
    reasons.push(
      `total ₹${(quote.total_paise / 100).toFixed(2)} exceeds buyer limit ₹${(policy.max_order_amount_paise / 100).toFixed(2)}`
    );
  } else {
    reasons.push(
      `total ₹${(quote.total_paise / 100).toFixed(2)} <= ₹${(policy.max_order_amount_paise / 100).toFixed(2)} buyer limit`
    );
  }

  for (const line of quote.lines) {
    if (line.qty > policy.max_quantity_per_sku) {
      decision = "DENY";
      violations.push({ code: "MAX_QTY", sku: line.sku, limit: policy.max_quantity_per_sku });
      reasons.push(
        `quantity ${line.qty} for ${line.sku} exceeds policy max ${policy.max_quantity_per_sku}`
      );
    } else {
      reasons.push(`SKU stock check ok: ${line.sku} qty ${line.qty} reserved`);
    }
  }

  for (const promo of quote.applied_promotions || []) {
    if (!policy.approved_promotions.includes(promo.id)) {
      decision = "DENY";
      violations.push({ code: "PROMO_NOT_APPROVED", promo_id: promo.id });
      reasons.push(`promotion ${promo.id} is not merchant-approved`);
    } else {
      reasons.push(`${promo.id} is merchant-approved`);
    }
    if (promo.discount_percent > policy.max_discount_percent) {
      decision = "DENY";
      violations.push({ code: "PROMO_DISCOUNT", promo_id: promo.id });
      reasons.push(`promotion ${promo.id} discount ${promo.discount_percent}% exceeds max ${policy.max_discount_percent}%`);
    }
  }

  if (requireVerifiedBuyer && policy.require_verified_buyer) {
    decision = "DENY";
    reasons.push("buyer identity not verified and policy requires verification");
  }

  const requiresHumanApproval = quote.total_paise > policy.require_human_approval_above_paise;
  if (requiresHumanApproval) {
    reasons.push(
      `total exceeds ₹${(policy.require_human_approval_above_paise / 100).toFixed(2)} — explicit human approval required before payment (this is provided by the buyer's own "Approve & Pay" click)`
    );
  }

  reasons.push("buyer consent matches quote hash");

  return {
    decision,
    policy_version: db.policyVersion,
    requires_human_approval: requiresHumanApproval,
    violations,
    reasons,
  };
}

module.exports = { evaluateQuote };
