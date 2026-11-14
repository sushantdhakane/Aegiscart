import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  VStack,
  HStack,
  Text,
  Button,
  Badge,
  Switch,
  Card,
  Divider,
  EmptyState,
  StatusDot,
  TextInput,
} from '@astryxdesign/core';
import {
  Check,
  Sparkles,
  ShieldCheck,
  PauseCircle,
  PlayCircle,
  ScrollText,
} from 'lucide-react';
import { post, get } from './api';

const inr = (p) => `₹${(p / 100).toFixed(2)}`;
const TONE_ICON = { info: '•', ok: '✓', warn: '↻', deny: '✕', handoff: '◆' };
const ICONS_FORBIDDEN = /[[\]{}<>]/g;
const clean = (s) => String(s ?? '').replace(ICONS_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim();

/* ---------------------------------- atoms ---------------------------------- */

function Stamp({ ok, children }) {
  return (
    <Badge variant={ok ? 'success' : 'error'} label={children} />
  );
}

function TraceStep({ step }) {
  return (
    <li className="trace-step" data-tone={step.tone} data-icon={TONE_ICON[step.tone]}>
      <div style={{ fontWeight: 600, fontSize: 13, color: 'inherit' }}>{clean(step.title)}</div>
      {step.detail && (
        <div className="trace-detail">{clean(step.detail)}</div>
      )}
    </li>
  );
}

function TraceList({ steps }) {
  if (!steps.length) return null;
  return (
    <ol className="trace" aria-label="Agent trace">
      {steps.map((s) => (
        <TraceStep key={s.n} step={s} />
      ))}
    </ol>
  );
}

function LedgerEvent({ event }) {
  return (
    <article className="ledger-event" aria-label={`Audit event ${event.type}`}>
      <div className="ledger-event-head">
        <span className="ledger-event-type">{event.type}</span>
        <span className="ledger-event-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="ledger-event-actor">{event.actor}</div>
      <ul style={{ margin: 0, paddingLeft: 15, fontSize: 11.5, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
        {event.reasons.slice(0, 4).map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      <div className="ledger-hash">
        {`hash ${event.event_hash.slice(0, 16)}… ← prev ${
          event.previous_event_hash === 'genesis' ? 'genesis' : event.previous_event_hash.slice(0, 10) + '…'
        }`}
      </div>
    </article>
  );
}

/* --------------------------------- receipt --------------------------------- */

function Receipt({ outcome, onApprove, busy, live, approved }) {
  const quote = outcome.quote;
  if (!quote) return null;
  return (
    <div className="receipt" role="region" aria-label="Quote receipt">
      <div className="receipt-sub">
        quote {quote.id} · catalog {quote.catalog_version} · expires{' '}
        {new Date(quote.expires_at).toLocaleTimeString()}
      </div>
      {quote.lines.map((l) => (
        <HStack key={`${l.sku}-${l.title}`} className="receipt-row" justify="between">
          <span>
            {l.title} × {l.qty}
          </span>
          <span>{inr(l.line_total_paise)}</span>
        </HStack>
      ))}
      <HStack className="receipt-row" justify="between">
        <span>GST</span>
        <span>{inr(quote.gst_paise)}</span>
      </HStack>
      <HStack className="receipt-row" justify="between">
        <span>Delivery</span>
        <span>{quote.delivery_fee_paise ? inr(quote.delivery_fee_paise) : 'Free'}</span>
      </HStack>
      <HStack className="receipt-row total" justify="between">
        <span>Total</span>
        <span className="receipt-total-amount">{inr(quote.total_paise)}</span>
      </HStack>

      <div style={{ marginTop: 14 }}>
        <Stamp ok={outcome.decision?.decision === 'ALLOW'}>
          {outcome.decision?.decision === 'ALLOW'
            ? `Cleared by policy ${outcome.decision?.policy_version ?? ''}`.trim()
            : 'Blocked by policy'}
        </Stamp>
        {outcome.decision?.requires_human_approval && (
          <div style={{ marginTop: 8 }}>
            <Text size="sm" color="secondary">
              Total is above the human-approval threshold — your click is the authorization.
            </Text>
          </div>
        )}
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
          {(outcome.decision?.reasons ?? []).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        {outcome.adjustments?.length > 0 && (
          <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#b45309' }}>
            {outcome.adjustments.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        )}
        <div style={{ marginTop: 14 }}>
          {approved ? (
            <Badge variant="success" label="Order placed — complete payment below" />
          ) : (
            <Button
              variant="primary"
              size="lg"
              label={`Approve & Pay ${inr(quote.total_paise)}`}
              onClick={onApprove}
              isLoading={busy}
              icon={<ShieldCheck size={16} />}
            />
          )}
          <div style={{ marginTop: 8 }}>
            <Text size="supporting" color="secondary">
              {approved
                ? 'Only the payment below can capture this order.'
                : live
                  ? 'Real money moves only after you click. Card/UPI credentials never touch AegisCart.'
                  : 'Mock mode — no real payment will be charged.'}
            </Text>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- payment --------------------------------- */

function PaymentControls({ live, intentId, orderId, onSimulate, onClose, onResume, onAbandon, orderStatus, busy }) {
  if (live) {
    return (
      <div className="order-status order-status--pending" role="status">
        {orderStatus?.state === 'captured'
          ? `✓ Payment captured. Order ${orderId} fulfilled.`
          : 'Razorpay Checkout handles payment. Webhook confirmation marks fulfilment.'}
      </div>
    );
  }
  return (
    <VStack gap="2">
      <div className="order-status order-status--pending" role="status">
        {orderStatus?.state === 'captured'
          ? `✓ Payment captured. Order ${orderId} fulfilled.`
          : orderStatus?.state === 'failed'
          ? '✕ Payment failed. Stock released; ask the agent again to retry.'
          : 'Mock mode: simulate what Razorpay Checkout would return.'}
      </div>
      {orderStatus?.state !== 'captured' && (
        <HStack gap="2" wrap="wrap">
          <Button variant="secondary" size="sm" label="Simulate success" onClick={() => onSimulate('success')} isDisabled={busy} />
          <Button variant="destructive" size="sm" label="Simulate failure" onClick={() => onSimulate('failure')} isDisabled={busy} />
          <Button variant="ghost" size="sm" label="Close without paying" onClick={onClose} isDisabled={busy} />
        </HStack>
      )}
      {orderStatus?.state === 'failed' && (
        <HStack gap="2" wrap="wrap">
          <Button variant="secondary" size="sm" label="Resume payment" onClick={onResume} isDisabled={busy} />
          <Button variant="ghost" size="sm" label="Cancel purchase" onClick={onAbandon} isDisabled={busy} />
        </HStack>
      )}
    </VStack>
  );
}

/* ---------------------------------- app ----------------------------------- */

export default function App() {
  const [health, setHealth] = useState(null);
  const [paused, setPaused] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [merchant, setMerchant] = useState('…');
  const [catalogSkus, setCatalogSkus] = useState([]);
  const [goal, setGoal] = useState('a high-protein snack under ₹500');
  const [allowOffers, setAllowOffers] = useState(true);
  const [running, setRunning] = useState(false);
  const [trace, setTrace] = useState([]);
  const [outcome, setOutcome] = useState(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [pendingIntentId, setPendingIntentId] = useState(null);
  const [openOrderIntentId, setOpenOrderIntentId] = useState(null);
  const [orderId, setOrderId] = useState(null);
  const [orderState, setOrderState] = useState(null);
  const [ledger, setLedger] = useState({ events: [], chain: null });
  const orderPoll = useRef(null);

  const healthBadge = health?.llm_configured
    ? `LLM · ${String(health.llm_model ?? '').split('/').pop().split(':')[0]}`
    : 'Rules agent';

  /* boot */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [h, cat, pol] = await Promise.all([get('/v1/health'), get('/v1/agent/catalog'), get('/v1/admin/policy')]);
      if (cancelled) return;
      setHealth(h.body);
      setMerchant(cat.body?.merchant?.name ?? 'Merchant');
      setCatalogSkus(cat.body?.skus ?? []);
      setPaused(Boolean(pol.body?.policy?.paused));
    })();
    return () => { cancelled = true; };
  }, []);

  /* live audit ledger */
  useEffect(() => {
    const tick = async () => {
      const { body } = await get('/v1/audit');
      if (body) setLedger({ events: body.events ?? [], chain: body.chain ?? null });
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => clearInterval(t);
  }, []);

  /* poll order status until terminal */
  useEffect(() => {
    if (!orderId) return undefined;
    const tick = async () => {
      const { body } = await get(`/v1/agent/orders/${orderId}`);
      if (!body) return;
      setOrderState((prev) => {
        if (!prev) return { state: body.status };
        if (prev.state === 'captured' || prev.state === 'failed') return prev;
        return { state: body.status };
      });
      if (body.status === 'captured' || body.status === 'failed') {
        clearInterval(orderPoll.current);
        setOpenOrderIntentId(null);
      }
    };
    tick();
    orderPoll.current = setInterval(tick, 800);
    return () => clearInterval(orderPoll.current);
  }, [orderId]);

  const togglePause = useCallback(async () => {
    setPauseBusy(true);
    const { body } = await post('/v1/admin/pause', { paused: !paused });
    setPaused(Boolean(body?.paused ?? !paused));
    setPauseBusy(false);
  }, [paused]);

  const releasePreviousSession = useCallback(async () => {
    const pending = pendingIntentId;
    const open = openOrderIntentId;
    setPendingIntentId(null);
    setOpenOrderIntentId(null);
    setOrderId(null);
    setOrderState(null);
    if (pending) await post(`/v1/agent/checkout-intents/${pending}/cancel`);
    if (open) await post(`/v1/agent/checkout-intents/${open}/abandon`);
  }, [pendingIntentId, openOrderIntentId]);

  const runAgent = useCallback(async () => {
    const trimmed = goal.trim();
    if (!trimmed || running) return;
    setRunning(true);
    await releasePreviousSession();
    const { body } = await post('/v1/agent/run', { goal: trimmed, allow_offers: allowOffers });
    if (body) {
      setTrace(body.trace ?? []);
      setOutcome(body);
      if (body.status === 'awaiting_approval' && body.checkout_intent_id) {
        setPendingIntentId(body.checkout_intent_id);
      }
    }
    setRunning(false);
  }, [goal, running, releasePreviousSession, allowOffers]);

  const confirmAndPay = useCallback(async () => {
    if (!pendingIntentId || checkoutBusy) return;
    setCheckoutBusy(true);
    const { status, body } = await post(`/v1/agent/checkout-intents/${pendingIntentId}/confirm`);
    if (status === 409) {
      setOutcome({ status: 'denied', message: 'Checkout denied on final policy recheck.', decision: body?.decision });
      setPendingIntentId(null);
      setCheckoutBusy(false);
      return;
    }
    // An order exists; intent becomes payable
    setPendingIntentId(null);
    setOpenOrderIntentId(pendingIntentId);
    setOrderId(body?.razorpay_order_id ?? null);
    setOrderState({ state: 'created' });
    setCheckoutBusy(false);
  }, [pendingIntentId, checkoutBusy]);

  const simulate = useCallback(
    async (outcomeKind) => {
      if (!openOrderIntentId) return;
      setCheckoutBusy(true);
      await post('/v1/mock/simulate-payment', { checkout_intent_id: openOrderIntentId, outcome: outcomeKind });
      setOrderState({ state: outcomeKind === 'success' ? 'captured' : 'failed' });
      if (outcomeKind === 'success') setOpenOrderIntentId(null);
      setCheckoutBusy(false);
    },
    [openOrderIntentId]
  );

  const closeCheckout = useCallback(async () => {
    if (!openOrderIntentId) return;
    setCheckoutBusy(true);
    await post(`/v1/agent/checkout-intents/${openOrderIntentId}/dismiss`);
    setOrderState({ state: 'dismissed' });
    setCheckoutBusy(false);
  }, [openOrderIntentId]);

  const resumeCheckout = useCallback(async () => {
    if (!openOrderIntentId) return;
    setCheckoutBusy(true);
    const { body } = await post(`/v1/agent/checkout-intents/${openOrderIntentId}/resume`);
    if (body?.razorpay_order_id) setOrderId(body.razorpay_order_id);
    setOrderState({ state: 'created' });
    setCheckoutBusy(false);
  }, [openOrderIntentId]);

  const abandonCheckout = useCallback(async () => {
    if (!openOrderIntentId) return;
    setCheckoutBusy(true);
    await post(`/v1/agent/checkout-intents/${openOrderIntentId}/abandon`);
    setOrderState({ state: 'cancelled' });
    setOpenOrderIntentId(null);
    setOrderId(null);
    setCheckoutBusy(false);
  }, [openOrderIntentId]);

  const chain = ledger.chain;
  const chainOk = chain ? chain.ok : null;
  const events = ledger.events.slice(-60);

  return (
    <div className="app">
      <div className="aurora" aria-hidden="true" />

      {/* top bar */}
      <header className="topbar">
        <div className="wordmark">
          <span className="wordmark-tick" aria-hidden="true">◆</span>AegisCart
        </div>
        <div className="topbar-right">
          <Text size="sm" color="secondary" className="merchant-name">
            {merchant}
          </Text>
          <Badge variant={health?.llm_configured ? 'info' : 'neutral'} label={healthBadge} />
          <Badge
            variant={health?.live_mode ? 'success' : 'warning'}
            label={health?.live_mode ? 'Live test mode' : 'Mock mode'}
          />
          <Button
            variant="secondary"
            size="sm"
            label={paused ? 'Resume checkouts' : 'Pause checkouts'}
            onClick={togglePause}
            isLoading={pauseBusy}
            icon={paused ? <PlayCircle size={14} /> : <PauseCircle size={14} />}
          />
        </div>
      </header>

      {paused && (
        <div className="paused-banner" role="status">
          MERCHANT KILL SWITCH ENGAGED — all new checkout approvals are blocked
        </div>
      )}

      <main className="stage">
        {/* ------------------------- buyer pane ------------------------- */}
        <section className="pane" aria-label="Buyer checkout">
          <VStack gap="3">
            <span className="eyebrow">Autonomous agent · you approve nothing until it clears policy</span>
            <h1 style={{ margin: 0, fontSize: 'clamp(1.5rem, 1.1rem + 2vw, 2.1rem)', letterSpacing: '-0.035em', lineHeight: 1.08 }}>
              Tell the agent what to buy
            </h1>

            <HStack gap="2" className="ask-row" style={{ width: '100%' }}>
              <div style={{ flex: 1 }}>
                <TextInput
                  isLabelHidden
                  label="Shopping goal"
                  placeholder="e.g. a high-protein snack under ₹500"
                  value={goal}
                  onChange={(v) => setGoal(v)}
                  onEnter={runAgent}
                  size="lg"
                  width="100%"
                  autoComplete="off"
                />
              </div>
              <Button
                variant="primary"
                size="lg"
                label="Run agent"
                onClick={runAgent}
                isLoading={running}
                icon={<Sparkles size={15} />}
              />
            </HStack>

            <div className="chip-row" role="group" aria-label="Example goals">
              {[
                'a high-protein snack under ₹500',
                'a birthday gift under ₹2000',
                'buy 20 roasted almonds',
                'buy 5 festive hampers',
                'a gift under ₹100',
              ].map((g) => (
                <Button
                  key={g}
                  size="sm"
                  variant="ghost"
                  label={g}
                  onClick={() => {
                    setGoal(g);
                    setTimeout(runAgent, 0);
                  }}
                  isDisabled={running}
                />
              ))}
            </div>

            <Switch
              label="Let the agent add merchant-approved offers when they fit the budget"
              value={allowOffers}
              onChange={(v) => setAllowOffers(Boolean(v))}
            />
            <Text size="sm" color="secondary">
              The agent prepares everything — it cannot pay. Your Approve &amp; Pay click is the only payment authorization.
            </Text>

            {running && (
              <Text size="sm" color="secondary" as="p">
                Agent is working…
              </Text>
            )}
            {trace.length > 0 && (
              <>
                <div className="trace-note">Steps replay at a readable pace; every one is in the ledger.</div>
                <TraceList steps={trace} />
              </>
            )}

            {outcome?.status === 'awaiting_approval' && (
              <Receipt
                outcome={outcome}
                onApprove={confirmAndPay}
                busy={checkoutBusy}
                live={Boolean(health?.live_mode)}
                approved={Boolean(orderId)}
              />
            )}
            {outcome && outcome.status !== 'awaiting_approval' && (
              <Card variant="muted" padding={3}>
                <VStack gap="2">
                  <Badge variant="error" label={`Agent stopped: ${String(outcome.status).replaceAll('_', ' ')}`} />
                  <Text size="sm" color="secondary">
                    {clean(outcome.message || 'The agent stopped and handed control back to you.')}
                  </Text>
                </VStack>
              </Card>
            )}

            {orderId && <Divider />}
            {orderId && (
              <VStack gap="2">
                <div className="trace-note">Payment (mock or live Checkout)</div>
                <PaymentControls
                  live={Boolean(health?.live_mode)}
                  intentId={openOrderIntentId}
                  orderId={orderId}
                  onSimulate={simulate}
                  onClose={closeCheckout}
                  onResume={resumeCheckout}
                  onAbandon={abandonCheckout}
                  orderStatus={orderState}
                  busy={checkoutBusy}
                />
              </VStack>
            )}

            <Divider />

            <details>
              <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
                What the agent can see: the catalog
              </summary>
              <div style={{ marginTop: 10 }} className="catalog-grid">
                {catalogSkus.map((s) => (
                  <div key={s.id} className="sku-card">
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{s.title}</div>
                    <div style={{ fontFamily: 'var(--font-family-code)', fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      {s.id} · stock {s.available_stock ?? s.stock}
                    </div>
                    <div style={{ fontWeight: 700, marginTop: 6, fontSize: 15 }}>{inr(s.price_paise)}</div>
                  </div>
                ))}
              </div>
            </details>
          </VStack>
        </section>

        {/* ------------------------- ledger pane ------------------------ */}
        <aside className="pane pane-ledger" aria-label="Audit ledger">
          <span className="eyebrow eyebrow-accent">The audit ledger · every step, hashed</span>
          <h2 style={{ margin: 0, fontSize: 'clamp(1.4rem, 1.1rem + 1.6vw, 1.9rem)', letterSpacing: '-0.03em', lineHeight: 1.1 }}>
            Every action, recorded
          </h2>

          <HStack gap="2" align="center">
            <StatusDot
              variant={chainOk === false ? 'error' : 'success'}
              isPulsing={chainOk !== false}
              label={chainOk === false ? 'Chain broken' : 'Chain verified'}
            />
            <Text size="sm" color="secondary">
              {chainOk === false
                ? `hash chain broken at ${chain?.brokenAt ?? 'unknown'}`
                : `chain verified · ${chain?.length ?? 0} events`}
            </Text>
          </HStack>

          <div className="ledger">
            {events.length === 0 ? (
              <EmptyState
                title="No events yet"
                description="Run the agent on the left and watch the chain build, one sha256 at a time."
                icon={<ScrollText size={20} />}
                isCompact
              />
            ) : (
              events.map((event, i) => <LedgerEvent key={`${event.id}-${i}`} event={event} />)
            )}
          </div>
        </aside>
      </main>

      <footer style={{ display: 'flex', justifyContent: 'center', padding: '4px 0 10px' }}>
        <Text size="supporting" color="secondary">
          <Check size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
          The agent never holds payment authority. Only your Approve &amp; Pay click can release funds.
        </Text>
      </footer>
    </div>
  );
}
