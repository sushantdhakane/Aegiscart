const crypto = require("crypto");
const { db } = require("./store");

function findSku(skuId) {
  return db.catalog.skus.find((s) => s.id === skuId);
}

function reservedQty(skuId) {
  return db.reservations.get(skuId) || 0;
}

function availableStock(sku) {
  return sku.stock - reservedQty(sku.id);
}

/**
 * Search the catalog with typed filters only — this is the ONLY tool an
 * LLM planner may call to discover products. It never receives or
 * invents price/stock; it reads the authoritative catalog.
 */
function searchCatalog({ query = "", budgetPaise = null, category = null } = {}) {
  const q = query.toLowerCase();
  return db.catalog.skus
    .filter((s) => availableStock(s) > 0)
    .filter((s) => (category ? s.category === category : true))
    .filter((s) => (budgetPaise ? s.price_paise <= budgetPaise : true))
    .filter((s) =>
      q
        ? s.title.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q)) ||
          s.category.toLowerCase().includes(q)
        : true
    )
    .map((s) => ({ ...s, available_stock: availableStock(s) }));
}

/** Pure price estimate (no quote stored, no stock touched). Mirrors createQuote's math exactly. */
function estimateTotal(lines, promoIds = []) {
  let subtotal = 0;
  for (const l of lines) subtotal += findSku(l.sku).price_paise * l.qty;
  for (const id of promoIds) {
    const promo = db.catalog.promotions.find((p) => p.id === id);
    const offerSku = promo && findSku(promo.offer_sku);
    if (offerSku) subtotal += Math.round(offerSku.price_paise * (1 - promo.discount_percent / 100));
  }
  const gst = Math.round((subtotal * db.catalog.tax.gst_percent) / 100);
  const delivery = subtotal >= db.catalog.free_delivery_threshold_paise ? 0 : db.catalog.delivery_fee_paise;
  return { subtotal, gst, delivery, total: subtotal + gst + delivery };
}

/** Suggest merchant-preconfigured cross-sell/upsell offers for a cart. */
function suggestPromotions(lines) {
  const categoriesInCart = new Set(lines.map((l) => findSku(l.sku)?.category));
  const suggestions = [];
  for (const promo of db.catalog.promotions) {
    if (categoriesInCart.has(promo.trigger_category)) {
      const offerSku = findSku(promo.offer_sku);
      if (offerSku && availableStock(offerSku) > 0) {
        suggestions.push({ ...promo, offer_title: offerSku.title, offer_price_paise: offerSku.price_paise });
      }
    }
  }
  return suggestions;
}

/**
 * Build a fixed, signed quote. Amounts are always computed server-side
 * from the authoritative catalog — never trust a price passed by the
 * client or the model. Applying a promotion is opt-in (the buyer must
 * request it), so the LLM can pitch it but never silently add it.
 */
function createQuote({ lines, acceptedPromotionIds = [] }) {
  const catalogVersion = db.catalog.catalog_version;
  const errors = [];
  const resolvedLines = [];

  for (const { sku: skuId, qty } of lines) {
    const sku = findSku(skuId);
    if (!sku) {
      errors.push(`unknown SKU ${skuId}`);
      continue;
    }
    if (qty < 1) {
      errors.push(`invalid quantity for ${skuId}`);
      continue;
    }
    if (availableStock(sku) < qty) {
      errors.push(`insufficient stock for ${skuId}: requested ${qty}, available ${availableStock(sku)}`);
      continue;
    }
    resolvedLines.push({
      sku: sku.id,
      title: sku.title,
      qty,
      unit_price_paise: sku.price_paise,
      line_total_paise: sku.price_paise * qty,
    });
  }

  if (errors.length) {
    return { ok: false, errors };
  }

  const appliedPromotions = [];
  for (const promoId of acceptedPromotionIds) {
    const promo = db.catalog.promotions.find((p) => p.id === promoId);
    if (!promo) {
      errors.push(`unknown promotion ${promoId}`);
      continue;
    }
    const offerSku = findSku(promo.offer_sku);
    if (!offerSku || availableStock(offerSku) < 1) {
      errors.push(`promotion ${promoId} offer SKU unavailable`);
      continue;
    }
    const discounted = Math.round(offerSku.price_paise * (1 - promo.discount_percent / 100));
    resolvedLines.push({
      sku: offerSku.id,
      title: `${offerSku.title} (promo: ${promoId})`,
      qty: 1,
      unit_price_paise: discounted,
      line_total_paise: discounted,
      promo_id: promoId,
    });
    appliedPromotions.push({ id: promo.id, discount_percent: promo.discount_percent });
  }

  if (errors.length) {
    return { ok: false, errors };
  }

  const subtotalPaise = resolvedLines.reduce((sum, l) => sum + l.line_total_paise, 0);
  const gstPaise = Math.round((subtotalPaise * db.catalog.tax.gst_percent) / 100);
  const deliveryFeePaise = subtotalPaise >= db.catalog.free_delivery_threshold_paise ? 0 : db.catalog.delivery_fee_paise;
  const totalPaise = subtotalPaise + gstPaise + deliveryFeePaise;

  const quoteId = `q_${crypto.randomBytes(6).toString("hex")}`;
  const createdAt = new Date();
  const ttlMinutes = db.policy.quote_ttl_minutes;
  const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60 * 1000);

  const hashInput = JSON.stringify({ quoteId, resolvedLines, subtotalPaise, gstPaise, deliveryFeePaise, totalPaise, catalogVersion });
  const quoteHash = crypto.createHash("sha256").update(hashInput).digest("hex");

  const quote = {
    id: quoteId,
    merchant_id: db.catalog.merchant.id,
    catalog_version: catalogVersion,
    lines: resolvedLines,
    applied_promotions: appliedPromotions,
    subtotal_paise: subtotalPaise,
    gst_paise: gstPaise,
    delivery_fee_paise: deliveryFeePaise,
    total_paise: totalPaise,
    currency: "INR",
    quote_hash: quoteHash,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    return_policy: db.catalog.merchant.return_policy,
    delivery_promise_days: db.catalog.merchant.delivery_promise_days,
  };

  db.quotes.set(quoteId, quote);
  return { ok: true, quote };
}

function getQuote(quoteId) {
  return db.quotes.get(quoteId);
}

function isExpired(quote) {
  return new Date(quote.expires_at).getTime() < Date.now();
}

function reserveInventory(quote) {
  for (const line of quote.lines) {
    db.reservations.set(line.sku, reservedQty(line.sku) + line.qty);
  }
}

function releaseInventory(quote) {
  for (const line of quote.lines) {
    const remaining = Math.max(0, reservedQty(line.sku) - line.qty);
    db.reservations.set(line.sku, remaining);
  }
}

module.exports = {
  findSku,
  availableStock,
  searchCatalog,
  suggestPromotions,
  estimateTotal,
  createQuote,
  getQuote,
  isExpired,
  reserveInventory,
  releaseInventory,
};
