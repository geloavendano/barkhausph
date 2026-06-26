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

if (!process.exitCode) {
  console.log("Payment flow regression check passed.");
}
