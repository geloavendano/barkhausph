import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webhookPath = resolve(root, "supabase/functions/handle-payment-webhook/index.ts");
const source = readFileSync(webhookPath, "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(`Payment flow regression check failed: ${message}`);
    process.exitCode = 1;
  }
}

const nonSuccessBlockMatch = source.match(/if\s*\(\s*isMaya\s*&&\s*!paidEvent\s*\)\s*\{([\s\S]*?)\n\s{4}\}/);
assert(nonSuccessBlockMatch, "Could not find Maya non-success event block.");

const nonSuccessBlock = nonSuccessBlockMatch?.[1] ?? "";
assert(
  nonSuccessBlock.includes('eventType === "PAYMENT_EXPIRED"'),
  "Only PAYMENT_EXPIRED should be treated as final/destructive.",
);
assert(
  !/PAYMENT_CANCELLED|PAYMENT_FAILED/.test(nonSuccessBlock),
  "PAYMENT_CANCELLED and PAYMENT_FAILED must not cancel/delete the pending booking.",
);
assert(
  /sendPaymentFailureAlert/.test(nonSuccessBlock),
  "Maya non-success events should still send operational alerts.",
);

const destructiveStatements = [
  /\.from\("bookings"\)\.update\(\{\s*status:\s*"cancelled"/,
  /\.from\("pending_bookings"\)\.delete\(\)/,
];
for (const pattern of destructiveStatements) {
  const index = nonSuccessBlock.search(pattern);
  if (index === -1) continue;
  const prefix = nonSuccessBlock.slice(0, index);
  const lastExpiredGuard = prefix.lastIndexOf('eventType === "PAYMENT_EXPIRED"');
  const lastCancelGuard = prefix.lastIndexOf("PAYMENT_CANCELLED");
  const lastFailedGuard = prefix.lastIndexOf("PAYMENT_FAILED");
  assert(
    lastExpiredGuard > lastCancelGuard && lastExpiredGuard > lastFailedGuard,
    "Destructive Maya non-success handling must stay guarded by PAYMENT_EXPIRED only.",
  );
}


// ── Orders (2026-09): one payment covers several bookings ────────────────────────
const orderLookupAt = source.indexOf("const order = await findOrder(");
const legacyIdempotencyAt = source.indexOf("Idempotency: bail if this provider payment ID is already recorded");
assert(orderLookupAt > 0, "The handler must look up an order (findOrder) for every event.");
assert(
  orderLookupAt > 0 && legacyIdempotencyAt > orderLookupAt,
  "Order handling must run BEFORE the payment-ID idempotency check (bookings in an order share one payment ID).",
);

const orderFnMatch = source.match(/async function handleOrderEvent\([\s\S]*?\n\}\n/);
assert(orderFnMatch, "Could not find handleOrderEvent().");
const orderFn = orderFnMatch?.[0] ?? "";
const orderNonSuccess = orderFn.match(/if\s*\(\s*ev\.isMaya\s*&&\s*!ev\.paidEvent\s*\)\s*\{([\s\S]*?)\n\s{2}\}/)?.[1] ?? "";
assert(orderNonSuccess, "Could not find the order's Maya non-success block.");
assert(orderNonSuccess.includes('ev.eventType === "PAYMENT_EXPIRED"'), "Orders: only PAYMENT_EXPIRED may cancel bookings.");
assert(!/PAYMENT_CANCELLED|PAYMENT_FAILED/.test(orderNonSuccess), "Orders: PAYMENT_CANCELLED/FAILED must not cancel the order's bookings.");
assert(/sendPaymentFailureAlert/.test(orderNonSuccess), "Orders: non-success events must still alert.");
assert(/ev\.paidAmount\s*!==\s*Number\(order\.amount\)/.test(orderFn), "Orders: the paid amount must be checked against the ORDER total.");
assert(/paymentAmount:\s*Number\(pending\.amount\)/.test(orderFn), "Orders: each booking's payments row must record that booking's share, not the whole payment.");
assert(/\.eq\("status",\s*"pending"\)\.select\("id"\)\.maybeSingle\(\)/.test(orderFn), "Orders: the order must be claimed atomically (status pending → paid).");
assert(/if\s*\(\s*claimed\s*&&\s*details\.length\s*\)/.test(orderFn), "Orders: only the event that claimed the order may send the confirmation email.");

// ── reconcile-maya-bookings: never look an order's booking up by its own ref ─────
const reconcile = readFileSync(resolve(root, "supabase/functions/reconcile-maya-bookings/index.ts"), "utf8");
assert(/order_ref/.test(reconcile), "Reconcile must read pending_bookings.order_ref.");
assert(
  /expectedTotal = Number\(order\.amount\)/.test(reconcile),
  "Reconcile phase 1 must compare Maya's payment against the ORDER total for order holds.",
);
assert(
  /const expectedTotal = Number\(order \? order\.amount : group\.bookings\[0\]\.total\)/.test(reconcile),
  "Reconcile phase 2 (recovery) must use the order total for bookings that belong to an order.",
);
assert(
  /\.eq\("reference_number", payment\.id\)\.eq\("booking_id", booking\.id\)/.test(reconcile),
  "Reconcile's duplicate-payment check must be per (payment, booking): an order's bookings share one payment ID.",
);
assert(
  /reason: "maya_unreachable"/.test(reconcile),
  "Reconcile must still skip (never cancel) when Maya is unreachable.",
);

if (!process.exitCode) {
  console.log("Payment flow regression check passed.");
}
