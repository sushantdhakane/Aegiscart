const express = require("express");
const audit = require("../audit");

const router = express.Router();

router.get("/", (req, res) => {
  const { correlation_id } = req.query;
  const events = correlation_id ? audit.getTrail(correlation_id) : audit.getAll();
  res.json({ count: events.length, chain: audit.verifyChain(), events });
});

module.exports = router;
