require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const agentRoutes = require("./src/routes/agent");
const { router: webhookRoutes } = require("./src/routes/webhooks");
const mockRoutes = require("./src/routes/mock");
const auditRoutes = require("./src/routes/audit");
const adminRoutes = require("./src/routes/admin");
const rzp = require("./src/razorpay");
const llm = require("./src/llm");
const { sweepExpiredIntents } = require("./src/checkout-intents");

const app = express();

app.use(cors());

// Webhook route needs the RAW body for signature verification, so it is
// mounted before the global json() body parser touches the stream.
app.use("/v1/webhooks", webhookRoutes);

app.use(express.json());

app.get("/.well-known/agent-commerce.json", (req, res) => {
  res.redirect(302, "/v1/agent/well-known");
});

app.use("/v1/agent", agentRoutes);
app.use("/v1/mock", mockRoutes);
app.use("/v1/audit", auditRoutes);
app.use("/v1/admin", adminRoutes);

app.get("/v1/health", (req, res) => {
  res.json({ status: "ok", llm_configured: llm.isConfigured, llm_model: llm.isConfigured ? llm.model : null, live_mode: rzp.isLive, mode: rzp.isLive ? "LIVE TEST MODE (real Razorpay test keys)" : "MOCK MODE (no Razorpay keys configured)" });
});

app.use(express.static(path.join(__dirname, "public")));

// Release stock held by checkouts the buyer never approved.
setInterval(sweepExpiredIntents, 30000).unref();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nAegisCart running at http://localhost:${PORT}`);
  console.log(`Mode: ${rzp.isLive ? "LIVE TEST MODE — using real Razorpay test-mode keys" : "MOCK MODE — no Razorpay keys found, simulating Orders/Checkout/Webhooks"}`);
  console.log(`Agent brain: ${llm.isConfigured ? `LLM (${llm.model}) with built-in rules as fallback` : "built-in rules only (set OPENROUTER_API_KEY to enable the LLM)"}`);
  console.log(`Open the URL above to try the buyer flow and watch the audit trail.\n`);
});
