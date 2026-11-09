const crypto = require("crypto");
const { db } = require("./store");

/**
 * Append an event to the audit ledger. Each event's hash is derived from
 * its own payload plus the previous event's hash, so the ledger forms a
 * tamper-evident chain — the same pattern the research memo specifies
 * (previous_event_hash / event_hash / correlation ID / actor / evidence).
 */
function appendEvent({ type, actor, correlationId, data, reasons }) {
  const previousEventHash =
    db.auditLog.length > 0 ? db.auditLog[db.auditLog.length - 1].event_hash : "genesis";

  const timestamp = new Date().toISOString();
  const bodyForHash = JSON.stringify({ type, actor, correlationId, data, reasons, timestamp, previousEventHash });
  const eventHash = crypto.createHash("sha256").update(bodyForHash).digest("hex");

  const event = {
    id: `evt_${db.auditLog.length + 1}_${eventHash.slice(0, 8)}`,
    type,
    actor,
    correlation_id: correlationId,
    data,
    reasons: reasons || [],
    timestamp,
    previous_event_hash: previousEventHash,
    event_hash: eventHash,
  };

  db.auditLog.push(event);
  return event;
}

function getTrail(correlationId) {
  return db.auditLog.filter((e) => e.correlation_id === correlationId);
}

function getAll() {
  return db.auditLog;
}

/** Verify the hash chain hasn't been tampered with (demo-grade check). */
function verifyChain() {
  let prev = "genesis";
  for (const e of db.auditLog) {
    if (e.previous_event_hash !== prev) return { ok: false, brokenAt: e.id };
    prev = e.event_hash;
  }
  return { ok: true, length: db.auditLog.length };
}

module.exports = { appendEvent, getTrail, getAll, verifyChain };
