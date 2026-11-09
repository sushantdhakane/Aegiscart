// Autonomous buyer agent (LLM-assisted when OPENROUTER_API_KEY is set, rules otherwise).
//
// Given a plain-English goal it runs the whole purchase preparation by itself:
//   understand -> search -> rank -> (optional) add approved offers -> quote
//   -> ask the policy engine -> if DENIED, read the machine-readable violations,
//   repair the cart and try again -> stop and hand off to the buyer.
//
// Boundaries (enforced by code, not by this file's good behaviour):
//   * It only uses the same tools an external AI buyer gets: catalog search,
//     quotes, and the policy-gated checkout-intent. Prices come from the catalog.
//   * It never imports the Razorpay client. It cannot create an order or pay;
//     only the buyer's "Approve & Pay" click can.
//   * Every step is written to the append-only audit ledger.
//
// Language understanding and the product choice live in src/agent-brain.js: the LLM
// proposes, code validates, and built-in rules are the fallback for every LLM step.

const crypto = require("crypto");
const { db } = require("./store");
const audit = require("./audit");
const { searchCatalog, suggestPromotions, createQuote, estimateTotal } = require("./quote");
const { createCheckoutIntent, sweepExpiredIntents } = require("./checkout-intents");
const { parseGoal, understandGoal, chooseProduct } = require("./agent-brain");
const llm = require("./llm");

const inr = (p) => `₹${(p / 100).toFixed(2)}`;
const MAX_REPLANS = 4;

function maxQtyWithinBudget(sku, wanted, budgetPaise) {
  const cap = Math.min(wanted, sku.available_stock);
  for (let q = cap; q >= 1; q--) {
    if (!budgetPaise || estimateTotal([{ sku: sku.id, qty: q }]).total <= budgetPaise) return q;
  }
  return 0;
}

async function runAgent({ goal, allowOffers = true }) {
  sweepExpiredIntents();
  const runId = `run_${crypto.randomBytes(5).toString("hex")}`;
  const trace = [];
  const adjustments = [];

  const step = (kind, tone, title, detail, data = {}) => {
    trace.push({ n: trace.length + 1, kind, tone, title, detail });
    audit.appendEvent({
      type: `agent.${kind}`,
      actor: "buyer_agent",
      correlationId: runId,
      data: { title, ...data },
      reasons: detail ? [detail] : [],
    });
  };
  const brain = { llm_configured: llm.isConfigured, model: llm.isConfigured ? llm.model : null, understand: "rules", choose: "rules" };
  const finish = (status, extra = {}) => ({ run_id: runId, status, goal, trace, adjustments, brain, ...extra });
  const noteFallback = (what, r) =>
    step("llm_fallback", "info", "AI model unavailable for this step",
      `${what}: ${r.fallbackReason}${r.error ? " (" + r.error + ")" : ""}. Using the built-in rules instead.`,
      { reason: r.fallbackReason });

  step("goal", "info", "Received goal", goal);

  if (db.policy.paused) {
    step("blocked", "deny", "Merchant kill switch is engaged", "No new purchases can be prepared until the merchant resumes checkouts.");
    return finish("blocked", { message: "The merchant has paused checkouts." });
  }

  const understanding = await understandGoal(goal);
  const intent = understanding.intent;
  brain.understand = understanding.source;
  if (understanding.fallbackReason) noteFallback("Reading the request", understanding);
  const understood = [
    intent.query && `item "${intent.query}"`,
    intent.category && `category ${intent.category}`,
    `quantity ${intent.qty}`,
    intent.budgetPaise ? `budget ${inr(intent.budgetPaise)} all-in` : "no budget stated",
  ].filter(Boolean).join(", ");
  step("understand", "info", "Understood the request",
    `${understood}. ${understanding.source === "llm" ? `Read by ${llm.model} in ${(understanding.ms / 1000).toFixed(1)}s, then checked by code.` : "Read by the built-in rules."}`,
    { parsed: intent, source: understanding.source });

  if (!intent.category && !intent.query) {
    step("no_match", "deny", "Could not map the goal to this catalog", "Try naming a product or a category such as a snack or a gift. Stopping rather than guessing.");
    return finish("no_match", { message: "I could not tell what you want to buy from this merchant." });
  }

  // ---- Search ----
  const candidates = searchCatalog({ query: intent.query, category: intent.category });
  if (candidates.length === 0) {
    step("no_match", "deny", "No matching products in stock", "The catalog search returned nothing for this request.");
    return finish("no_match", { message: "Nothing in stock matches that request." });
  }
  step("search", "info", `Searched the catalog: ${candidates.length} match${candidates.length === 1 ? "" : "es"}`,
    candidates.map((c) => `${c.title} ${inr(c.price_paise)}`).join("; "));

  // ---- Rank & choose ----
  const fitting = candidates
    .map((c) => ({ sku: c, qty: maxQtyWithinBudget(c, intent.qty, intent.budgetPaise) }))
    .filter((x) => x.qty >= 1);

  if (fitting.length === 0) {
    const cheapest = candidates.slice().sort((a, b) => a.price_paise - b.price_paise)[0];
    step("escalate", "deny", `Nothing fits ${inr(intent.budgetPaise)}`,
      `Even the cheapest match (${cheapest.title}) costs ${inr(estimateTotal([{ sku: cheapest.id, qty: 1 }]).total)} with tax and delivery. Handing back to the buyer.`);
    return finish("no_fit", { message: "No matching product fits that budget once tax and delivery are included." });
  }

  const protein = (x) => (intent.wantsProtein && x.sku.tags.includes("high-protein") ? 1 : 0);
  fitting.sort((a, b) =>
    protein(b) - protein(a) || (intent.budgetPaise ? b.sku.price_paise - a.sku.price_paise : a.sku.price_paise - b.sku.price_paise));
  const rule = intent.budgetPaise
    ? "the best-priced item that fits the budget after tax and delivery"
    : "the lowest-priced match, since no budget was given";
  const choice = await chooseProduct({
    goal,
    intent,
    options: fitting.map((f) => ({ sku: f.sku, qty: f.qty, estTotal: estimateTotal([{ sku: f.sku.id, qty: f.qty }]).total })),
  });
  brain.choose = choice.source;
  if (choice.fallbackReason) noteFallback("Choosing a product", choice);
  const chosen = fitting.find((f) => f.sku.id === choice.skuId) || fitting[0];
  const why =
    choice.source === "llm"
      ? `${fitting.length} of ${candidates.length} fit the budget. ${llm.model} picked this one: ${choice.reason}`
      : choice.source === "only_option"
        ? `Only one option fits the budget, so there was nothing to compare.`
        : `${fitting.length} of ${candidates.length} fit; picked ${rule}.`;
  step("rank", "ok", `Chose ${chosen.sku.title}`, why, { sku: chosen.sku.id, source: choice.source });

  let qty = chosen.qty;
  if (qty < intent.qty) {
    const note = `Reduced quantity from ${intent.qty} to ${qty} to fit stock and budget.`;
    adjustments.push(note);
    step("replan", "warn", "Adjusted quantity", note);
  }
  let lines = [{ sku: chosen.sku.id, qty }];

  // ---- Offers (merchant-approved cross-sell / upsell) ----
  let promoIds = [];
  if (allowOffers) {
    const suggestions = suggestPromotions(lines).filter((p) => !lines.some((l) => l.sku === p.offer_sku));
    const added = [], skipped = [];
    for (const p of suggestions) {
      const est = estimateTotal(lines, [...promoIds, p.id]).total;
      const withinBudget = !intent.budgetPaise || est <= intent.budgetPaise;
      const approved = db.policy.approved_promotions.includes(p.id) && p.discount_percent <= db.policy.max_discount_percent;
      if (withinBudget && approved && est <= db.policy.max_order_amount_paise) {
        promoIds.push(p.id);
        added.push(p.pitch);
      } else {
        skipped.push(`${p.offer_title} (would take the total to ${inr(est)})`);
      }
    }
    if (added.length || skipped.length) {
      step("offers", added.length ? "ok" : "info",
        added.length ? "Added merchant-approved offers" : "Offers considered, none fit",
        [added.length && `Added: ${added.join("; ")}.`, skipped.length && `Skipped: ${skipped.join("; ")}.`].filter(Boolean).join(" "),
        { added: promoIds });
    }
  } else {
    step("offers", "info", "Offers disabled by the buyer", "The buyer asked the agent not to add cross-sells.");
  }

  // ---- Quote -> policy -> repair loop ----
  let attempt = 0;
  let accepted = null;
  while (attempt <= MAX_REPLANS) {
    const qr = createQuote({ lines, acceptedPromotionIds: promoIds });
    if (!qr.ok) {
      step("escalate", "deny", "Could not create a quote", qr.errors.join("; "));
      return finish("failed", { message: qr.errors.join("; ") });
    }
    const quote = qr.quote;
    audit.appendEvent({
      type: "quote.issued", actor: "quote_service", correlationId: quote.id,
      data: { quote_id: quote.id, catalog_version: quote.catalog_version, total_paise: quote.total_paise, quote_hash: quote.quote_hash, agent_run: runId },
      reasons: ["price, tax and delivery computed server-side from the catalog"],
    });
    step("quote", "info", `Requested quote ${quote.id}`,
      `${quote.lines.map((l) => `${l.title} x${l.qty}`).join(", ")}. Total ${inr(quote.total_paise)} including GST and delivery.`);

    const result = createCheckoutIntent(quote);
    if (result.status === 200) {
      const d = result.body.decision;
      step("policy", "ok", "Policy engine: ALLOW",
        `Policy ${d.policy_version}. ${d.requires_human_approval ? "Total is above the human-approval threshold, so only an explicit buyer approval can release it." : "Within all merchant limits."}`);
      accepted = result.body;
      break;
    }
    if (result.status !== 403) {
      step("escalate", "deny", "Checkout could not be prepared", JSON.stringify(result.body));
      return finish("failed", { message: "Checkout could not be prepared." });
    }

    // DENIED: read the violations and repair the cart (one fix per round).
    const decision = result.body.decision;
    const denials = decision.reasons.filter((r) => /exceed|not merchant|kill switch|not verified/i.test(r));
    step("policy", "deny", "Policy engine: DENY", denials.join("; "));

    const v = decision.violations || [];
    const has = (code) => v.find((x) => x.code === code);
    let note = null;

    if (has("KILL_SWITCH")) {
      step("blocked", "deny", "Merchant kill switch engaged", "Stopping.");
      return finish("blocked", { message: "The merchant paused checkouts." });
    } else if (has("PROMO_NOT_APPROVED") || has("PROMO_DISCOUNT")) {
      promoIds = [];
      note = "Removed the offers the policy rejected.";
    } else if (has("MAX_QTY")) {
      const limit = has("MAX_QTY").limit;
      qty = Math.min(qty, limit);
      lines = [{ sku: lines[0].sku, qty }];
      note = `Reduced quantity to ${qty}, the merchant's per-item limit.`;
    } else if (has("MAX_AMOUNT")) {
      const limit = has("MAX_AMOUNT").limit_paise;
      if (promoIds.length) {
        promoIds = [];
        note = "Dropped the add-on offers to get under the order limit.";
      } else {
        let q = qty - 1;
        while (q >= 1 && estimateTotal([{ sku: lines[0].sku, qty: q }]).total > limit) q--;
        if (q >= 1) {
          qty = q;
          lines = [{ sku: lines[0].sku, qty }];
          note = `Reduced quantity to ${qty} to get under the ${inr(limit)} order limit.`;
        }
      }
    }

    if (!note) {
      step("escalate", "deny", "Could not repair the cart within policy", "Handing back to the buyer and the merchant.");
      return finish("needs_human", { message: "The agent could not find a compliant cart and stopped." });
    }
    adjustments.push(note);
    step("replan", "warn", "Replanning after the policy decision", note);
    attempt++;
  }

  if (!accepted) {
    step("escalate", "deny", "Gave up after repeated denials", `Tried ${MAX_REPLANS} repairs. Handing back to a human.`);
    return finish("needs_human", { message: "The agent could not find a compliant cart and stopped." });
  }

  step("handoff", "handoff", "Stopped before payment: waiting for buyer approval",
    "The agent has no payment access. Only the buyer's Approve & Pay click can create the Razorpay order.",
    { checkout_intent_id: accepted.checkout_intent_id, quote_id: accepted.quote.id });

  return finish("awaiting_approval", {
    checkout_intent_id: accepted.checkout_intent_id,
    quote: accepted.quote,
    decision: accepted.decision,
    message: "Cart prepared and cleared by policy. Review and approve to pay.",
  });
}

module.exports = { runAgent, parseGoal };
