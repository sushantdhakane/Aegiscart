const express = require("express");
const { db } = require("../store");
const audit = require("../audit");

const router = express.Router();

router.get("/policy", (req, res) => {
  res.json({ policy_version: db.policyVersion, policy: db.policy });
});

/**
 * Emergency kill switch. The policy engine checks this flag first, so it takes
 * effect on the very next request. In-flight orders are unaffected; only NEW
 * checkout approvals are blocked. (Demo has no auth; production would sit
 * behind merchant RBAC.)
 */
router.post("/pause", (req, res) => {
  db.policy.paused = Boolean((req.body || {}).paused);
  audit.appendEvent({
    type: db.policy.paused ? "merchant.kill_switch_engaged" : "merchant.kill_switch_released",
    actor: "merchant_admin",
    correlationId: "admin",
    data: { paused: db.policy.paused },
    reasons: [db.policy.paused ? "merchant halted all new checkouts" : "merchant re-enabled checkouts"],
  });
  res.json({ paused: db.policy.paused });
});

module.exports = router;
