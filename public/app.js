const state = {
  liveMode: false,
  paused: false,
  running: false,
  pendingIntentId: null,
  openOrderIntentId: null, // an order was created and not yet paid, failed or cancelled
  paymentHandled: false,
  currentOrderId: null,
  orderPollTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const paise = (p) => `₹${(p / 100).toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const postJson = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  try {
    const health = await fetch("/v1/health").then((r) => r.json());
    state.liveMode = health.live_mode;
    const badge = $("#modeBadge");
    badge.textContent = health.live_mode ? "LIVE TEST MODE" : "MOCK MODE";
    badge.classList.toggle("live", health.live_mode);
    const agentBadge = $("#agentBadge");
    const shortModel = health.llm_model ? health.llm_model.split("/").pop().split(":")[0] : "";
    agentBadge.style.display = "inline-block";
    agentBadge.textContent = health.llm_configured ? `LLM AGENT · ${shortModel}` : "RULES AGENT";
    agentBadge.classList.toggle("live", Boolean(health.llm_configured));
  } catch (e) {
    $("#modeBadge").textContent = "offline";
  }

  const cat = await fetch("/v1/agent/catalog").then((r) => r.json());
  $("#merchantName").textContent = cat.merchant.name;
  renderCatalog(cat.skus);

  $("#runBtn").addEventListener("click", () => runAgent($("#goalInput").value));
  $("#goalInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runAgent($("#goalInput").value); });
  document.querySelectorAll(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      $("#goalInput").value = chip.dataset.goal;
      runAgent(chip.dataset.goal);
    })
  );
  $("#killSwitchBtn").addEventListener("click", toggleKillSwitch);

  await refreshPolicyState();
  pollLedger();
  setInterval(pollLedger, 1500);
}

// ---------------------------------------------------------------------------
// Merchant kill switch
// ---------------------------------------------------------------------------

async function refreshPolicyState() {
  const res = await fetch("/v1/admin/policy").then((r) => r.json());
  state.paused = Boolean(res.policy.paused);
  renderKillSwitch();
}

function renderKillSwitch() {
  const btn = $("#killSwitchBtn");
  btn.textContent = state.paused ? "⏻ Resume checkouts" : "⏻ Pause checkouts";
  btn.style.borderColor = state.paused ? "var(--deny)" : "#7e9d95";
  btn.style.color = state.paused ? "var(--deny)" : "#d7ebe3";
  let banner = document.getElementById("pausedBanner");
  if (state.paused && !banner) {
    banner = document.createElement("div");
    banner.id = "pausedBanner";
    banner.className = "paused-banner";
    banner.textContent = "⚠ MERCHANT KILL SWITCH ENGAGED: all new checkouts are blocked";
    document.querySelector(".app").prepend(banner);
  } else if (!state.paused && banner) {
    banner.remove();
  }
}

async function toggleKillSwitch() {
  const res = await postJson("/v1/admin/pause", { paused: !state.paused }).then((r) => r.json());
  state.paused = res.paused;
  renderKillSwitch();
}

// ---------------------------------------------------------------------------
// Catalog (read-only: this is what the agent can see)
// ---------------------------------------------------------------------------

function renderCatalog(skus) {
  const grid = $("#catalogGrid");
  grid.innerHTML = skus
    .map(
      (s) => `
    <div class="sku-card">
      <div class="sku-title">${esc(s.title)}</div>
      <div class="sku-meta">${esc(s.id)} · stock ${s.available_stock ?? s.stock}</div>
      <div class="sku-price">${paise(s.price_paise)}</div>
    </div>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// The agent run: one goal in, a prepared cart out
// ---------------------------------------------------------------------------

const ICONS = { info: "•", ok: "✓", warn: "↻", deny: "✕", handoff: "◆" };

function setRunning(on) {
  state.running = on;
  $("#runBtn").disabled = on;
  document.querySelectorAll(".chip").forEach((c) => (c.disabled = on));
}

async function runAgent(goal) {
  goal = (goal || "").trim();
  if (!goal || state.running) return;
  setRunning(true);
  clearInterval(state.orderPollTimer);
  $("#mandateArea").innerHTML = "";

  // A new run supersedes any cart the buyer never approved: release its stock.
  if (state.pendingIntentId) {
    postJson(`/v1/agent/checkout-intents/${state.pendingIntentId}/cancel`).catch(() => {});
    state.pendingIntentId = null;
  }

  // A new run supersedes an unpaid order the buyer walked away from: release its stock.
  if (state.openOrderIntentId) {
    postJson(`/v1/agent/checkout-intents/${state.openOrderIntentId}/abandon`).catch(() => {});
    state.openOrderIntentId = null;
  }

  $("#traceArea").innerHTML = `<p class="trace-head">Agent working</p><ol class="trace" id="traceList"></ol>`;
  $("#traceList").innerHTML = '<li class="info" data-icon="…"><div class="trace-title">Agent is thinking…</div></li>';

  let res;
  try {
    const r = await postJson("/v1/agent/run", { goal, allow_offers: $("#allowOffers").checked });
    res = await r.json();
    if (!r.ok) throw new Error(res.error || "request failed");
  } catch (e) {
    $("#traceArea").innerHTML = `<div class="order-status failed">The agent could not run: ${esc(e.message)}</div>`;
    setRunning(false);
    return;
  }

  $("#traceList").innerHTML = "";
  for (const s of res.trace) {
    const li = document.createElement("li");
    li.className = s.tone;
    li.dataset.icon = ICONS[s.tone] || "•";
    li.innerHTML = `<div class="trace-title">${esc(s.title)}</div>${s.detail ? `<div class="trace-detail">${esc(s.detail)}</div>` : ""}`;
    $("#traceList").appendChild(li);
    await sleep(550);
  }
  $("#traceArea").insertAdjacentHTML(
    "beforeend",
    `<p class="trace-note">Steps are replayed at a readable pace. The agent itself finished in milliseconds, and every step is in the ledger.</p>`
  );

  renderOutcome(res);
  setRunning(false);
}

function renderOutcome(res) {
  const area = $("#mandateArea");
  if (res.status !== "awaiting_approval") {
    area.innerHTML = `
      <div class="receipt">
        <span class="stamp deny">✕ Agent stopped: ${esc(res.status.replace("_", " "))}</span>
        <p style="margin:0;font-size:13.5px">${esc(res.message || "")}</p>
      </div>`;
    return;
  }

  const q = res.quote;
  state.pendingIntentId = res.checkout_intent_id;
  const lines = q.lines
    .map((l) => `<div class="receipt-row"><span>${esc(l.title)} × ${l.qty}</span><span>${paise(l.line_total_paise)}</span></div>`)
    .join("");
  const adj = res.adjustments.length
    ? `<ul class="adjust-list">${res.adjustments.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`
    : "";
  const reasons = res.decision.reasons.map((r) => `<li>${esc(r)}</li>`).join("");

  area.innerHTML = `
    <div class="receipt">
      <div class="receipt-sub">quote ${esc(q.id)} · catalog ${esc(q.catalog_version)} · expires ${new Date(q.expires_at).toLocaleTimeString()}</div>
      ${lines}
      <div class="receipt-row"><span>GST</span><span>${paise(q.gst_paise)}</span></div>
      <div class="receipt-row"><span>Delivery</span><span>${q.delivery_fee_paise ? paise(q.delivery_fee_paise) : "Free"}</span></div>
      <div class="receipt-row total"><span>Total</span><span>${paise(q.total_paise)}</span></div>
    </div>
    <div class="receipt">
      <span class="stamp allow">✓ Cleared by policy ${esc(res.decision.policy_version)}</span>
      ${adj}
      <ul class="reasons-list">${reasons}</ul>
      <div class="pay-actions">
        <button class="btn seal" id="approveAndPayBtn">Approve &amp; Pay ${paise(q.total_paise)}</button>
      </div>
      <div id="paymentArea"></div>
    </div>`;

  $("#approveAndPayBtn").addEventListener("click", () => confirmAndPay(res.checkout_intent_id));
}

// ---------------------------------------------------------------------------
// Human approval and payment
// ---------------------------------------------------------------------------

async function confirmAndPay(intentId) {
  $("#approveAndPayBtn").disabled = true;
  const res = await postJson(`/v1/agent/checkout-intents/${intentId}/confirm`);
  const data = await res.json();
  if (!res.ok) {
    $("#approveAndPayBtn").disabled = false;
    $("#paymentArea").innerHTML = `<div class="order-status failed">Checkout denied on recheck: ${esc(JSON.stringify(data.decision?.reasons || data.error))}</div>`;
    return;
  }

  state.pendingIntentId = null; // an order exists now; the intent is no longer just pending
  state.openOrderIntentId = intentId;
  state.currentOrderId = data.razorpay_order_id;
  showPayment(data, intentId);
}

/** Show the payment step for an open order: real Razorpay Checkout, or mock controls. */
function showPayment(orderData, intentId) {
  state.paymentHandled = false;
  if (orderData.live_mode) return openRazorpayCheckout(orderData, intentId);

  $("#paymentArea").innerHTML = `
    <p class="suggestion-note">Mock mode: simulate what Razorpay Checkout would return, to exercise the real signature and webhook code path.</p>
    <div class="pay-actions">
      <button class="btn" id="simSuccessBtn">Simulate success (UPI)</button>
      <button class="btn deny-demo" id="simFailBtn">Simulate failure</button>
      <button class="btn secondary" id="simCloseBtn">Close without paying</button>
    </div>
    <div id="orderStatusBox"></div>`;
  $("#simSuccessBtn").addEventListener("click", () => simulatePayment(intentId, "success"));
  $("#simFailBtn").addEventListener("click", () => simulatePayment(intentId, "failure"));
  $("#simCloseBtn").addEventListener("click", () => onCheckoutClosed(orderData, intentId));
}

function openRazorpayCheckout(orderData, intentId) {
  $("#paymentArea").innerHTML = `<div id="orderStatusBox" class="order-status">Opening Razorpay Checkout…</div>`;

  const start = () => {
    const rzp = new Razorpay({
      key: orderData.key_id,
      amount: orderData.amount_paise,
      currency: orderData.currency,
      order_id: orderData.razorpay_order_id,
      name: orderData.merchant_name,
      description: "AegisCart checkout",
      handler: async function (response) {
        state.paymentHandled = true; // payment went through: closing the modal is not an abandonment
        await postJson(`/v1/agent/checkout-intents/${intentId}/checkout-callback`, response);
        pollOrder(orderData.razorpay_order_id);
      },
      // Fires when the buyer closes the Checkout window without completing payment.
      modal: { ondismiss: () => onCheckoutClosed(orderData, intentId) },
      theme: { color: "#c08a2e" },
    });
    // A failed attempt: Checkout stays open so the buyer can retry or pick another method.
    rzp.on("payment.failed", (resp) => {
      const reason = resp && resp.error && resp.error.description ? resp.error.description : "the payment did not go through";
      const box = document.getElementById("orderStatusBox");
      if (box) {
        box.className = "order-status failed";
        box.textContent = `Payment attempt failed: ${reason}. Retry in the checkout window, or close it.`;
      }
    });
    rzp.open();
    const box = document.getElementById("orderStatusBox");
    if (box) box.textContent = "Razorpay Checkout is open. Complete the payment in the window.";
  };

  if (window.Razorpay) return start();
  const script = document.createElement("script");
  script.src = "https://checkout.razorpay.com/v1/checkout.js";
  script.onload = start;
  script.onerror = () => {
    $("#paymentArea").innerHTML = `
      <div id="orderStatusBox" class="order-status failed">Could not load Razorpay Checkout (network problem or a blocker?). No payment was made.</div>
      <div class="pay-actions" style="margin-top:12px"><button class="btn seal" id="retryLoadBtn">Try again</button></div>`;
    $("#retryLoadBtn").addEventListener("click", () => showPayment(orderData, intentId));
  };
  document.body.appendChild(script);
}

/** The buyer closed checkout without paying: tell the server, then offer Resume or Cancel. */
async function onCheckoutClosed(orderData, intentId) {
  if (state.paymentHandled) return;
  const res = await postJson(`/v1/agent/checkout-intents/${intentId}/dismiss`);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Not resumable: a payment may be in flight, or the order already finished or expired.
    if (["signature_verified", "captured", "failed"].includes(data.order_status)) {
      $("#paymentArea").innerHTML = `<div id="orderStatusBox" class="order-status">Checking your payment…</div>`;
      pollOrder(orderData.razorpay_order_id);
    } else {
      showClosedOrder(data);
    }
    return;
  }

  const until = new Date(data.resumable_until).toLocaleTimeString();
  $("#paymentArea").innerHTML = `
    <div id="orderStatusBox" class="order-status">Checkout closed. No payment was made. Your cart is held until ${until}.</div>
    <div class="pay-actions" style="margin-top:12px">
      <button class="btn seal" id="resumeBtn">Resume payment</button>
      <button class="btn secondary" id="cancelOrderBtn">Cancel purchase</button>
    </div>`;

  $("#resumeBtn").addEventListener("click", async () => {
    $("#resumeBtn").disabled = $("#cancelOrderBtn").disabled = true;
    const r = await postJson(`/v1/agent/checkout-intents/${intentId}/resume`);
    const body = await r.json().catch(() => ({}));
    if (r.ok) showPayment(body, intentId);
    else showClosedOrder(body);
  });
  $("#cancelOrderBtn").addEventListener("click", async () => {
    $("#resumeBtn").disabled = $("#cancelOrderBtn").disabled = true;
    const r = await postJson(`/v1/agent/checkout-intents/${intentId}/abandon`);
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      state.openOrderIntentId = null;
      $("#paymentArea").innerHTML = `<div id="orderStatusBox" class="order-status">Purchase cancelled. Nothing was charged and the stock was released. Ask the agent again whenever you like.</div>`;
    } else {
      showClosedOrder(body);
    }
  });
}

function showClosedOrder(data) {
  state.openOrderIntentId = null;
  const why = {
    payment_window_expired: "This checkout expired, so the cart was released. Nothing was charged.",
    failed: "The payment failed, so nothing was charged and the stock was released.",
    expired: "This checkout expired, so the cart was released. Nothing was charged.",
    cancelled: "This purchase was already cancelled.",
  }[data.error] || { failed: "The payment failed, so nothing was charged.", expired: "This checkout expired.", cancelled: "This purchase was cancelled." }[data.order_status];
  $("#paymentArea").innerHTML = `<div id="orderStatusBox" class="order-status failed">${esc(why || "This checkout can no longer be resumed.")} Ask the agent again to start a fresh cart.</div>`;
}

async function simulatePayment(intentId, outcome) {
  document.querySelectorAll("#simSuccessBtn, #simFailBtn, #simCloseBtn").forEach((b) => (b.disabled = true));
  state.paymentHandled = true;
  await postJson("/v1/mock/simulate-payment", { checkout_intent_id: intentId, outcome });
  pollOrder(state.currentOrderId);
}

function pollOrder(orderId) {
  clearInterval(state.orderPollTimer);
  const waitStarted = Date.now();
  state.orderPollTimer = setInterval(async () => {
    const order = await fetch(`/v1/agent/orders/${orderId}`).then((r) => r.json());
    const el = document.getElementById("orderStatusBox");
    if (!el) return;
    if (order.status === "captured") {
      el.className = "order-status captured";
      el.textContent = `✓ Payment captured: order ${orderId} fulfilled. Payment ${order.payment_id}.`;
      state.openOrderIntentId = null;
      clearInterval(state.orderPollTimer);
    } else if (order.status === "failed") {
      el.className = "order-status failed";
      el.textContent = "✕ Payment failed: no fulfilment, inventory released. Ask the agent again to retry with a fresh cart.";
      state.openOrderIntentId = null;
      clearInterval(state.orderPollTimer);
    } else {
      el.className = "order-status";
      el.textContent = `Status: ${order.status}. Waiting for signed webhook confirmation…`;
      if (Date.now() - waitStarted > 45000) {
        el.textContent += " This is taking longer than expected. Payments are confirmed by Razorpay's webhook, so check that your webhook URL is set up and reachable.";
      }
    }
  }, 800);
}

// ---------------------------------------------------------------------------
// Audit ledger (right pane)
// ---------------------------------------------------------------------------

async function pollLedger() {
  try {
    const res = await fetch("/v1/audit").then((r) => r.json());
    renderChainBadge(res.chain);
    renderLedger(res.events);
  } catch (e) {
    // server not reachable yet; next interval retries
  }
}

function renderChainBadge(chain) {
  const badge = $("#chainBadge");
  badge.innerHTML = chain.ok
    ? `<span class="dot"></span> chain verified · ${chain.length} events`
    : `<span class="dot" style="background:var(--deny)"></span> chain broken at ${esc(chain.brokenAt)}`;
}

function renderLedger(events) {
  const tape = $("#ledgerTape");
  if (!events.length) {
    tape.innerHTML = `<p class="empty-state">No events yet. Run the agent on the left to begin.</p>`;
    return;
  }
  const scroller = document.querySelector(".terminal-side");
  const wasAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;

  tape.innerHTML = events
    .slice(-60)
    .map(
      (e, i) => `
      ${i > 0 ? '<div class="ledger-connector"></div>' : ""}
      <div class="ledger-event">
        <div class="ledger-event-head">
          <span class="ledger-event-type">${esc(e.type)}</span>
          <span class="ledger-event-time">${new Date(e.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="ledger-event-actor">${esc(e.actor)}</div>
        <ul class="ledger-reasons">${e.reasons.slice(0, 4).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        <div class="ledger-hash">hash ${e.event_hash.slice(0, 16)}… ← prev ${e.previous_event_hash === "genesis" ? "genesis" : e.previous_event_hash.slice(0, 10) + "…"}</div>
      </div>`
    )
    .join("");

  if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
}

init();
