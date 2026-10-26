import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../booking.js", import.meta.url), "utf8");
function between(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Missing source boundary: ${start}`);
  return source.slice(first, last);
}
const values = new Map();
const sessionStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", disabled: false,
    classList: { add() {}, remove() {} } });
  return elements.get(id);
}
const saved = { service: "hotel", petName: "Alpha", total: 1200, payload: { petName: "Alpha", waiverHouseRules: true } };
const current = { service: "hotel", petName: "Beta", total: 1200 };
const captured = { payload: { petName: "Beta", waiverHouseRules: true, waiverGeneral: true, bringVaccines: true } };
const posted = [];
const cancelled = [];
let checkoutNumber = 0;
const context = vm.createContext({
  console, JSON, Number, String, Object, Array, Error,
  sessionStorage,
  document: { getElementById: element },
  window: { location: {} },
  SUPABASE_ANON_KEY: "fixture-public-key",
  ORDER_RESULT_KEY: "barkhaus_order_result",
  _redirectingToPayment: false,
  booking: { location: "eastwood", service: "hotel", petName: "Beta" },
  currentReviewSnapshot: current,
  cart: () => [saved],
  productionSubmitBooking: async () => captured,
  orderAmounts: () => ({ fee: 20, total: 2420 }),
  locationLabel: () => "Eastwood",
  serviceLabel: () => "Pet Hotel",
  escapeHtml: value => String(value),
  hostedPaymentEndpoint: () => "https://fixture.invalid/checkout",
  storePaymentRef: ref => sessionStorage.setItem("bk_pending_ref", ref),
  showToast: message => { throw new Error(message); },
  showPayReturnScreen(snap) { context.window._payReturnSnap = snap; },
  getHostedPaymentState: async () => ({ confirmed: false }),
  cancelPendingBooking: async (ref, token) => { cancelled.push({ ref, token }); return true; },
  fetch: async (_url, options) => {
    posted.push(JSON.parse(options.body));
    const ref = `BH-TEST${++checkoutNumber}`;
    return { ok: true, json: async () => ({ ref_number: ref, cancellation_token: `cancel-${checkoutNumber}`,
      booking_refs: [`${ref}-A`, `${ref}-B`], checkout_url: `https://fixture.invalid/pay/${ref}` }) };
  },
});
vm.runInContext([
  between("  async function proceedToPayment()", "  function restoreAdditionalContext()"),
  between("  function renderOrderSuccess(", "  // Staging only: read the confirmation email"),
  between("async function retryPayment()", "// Cancel a pending booking via Edge Function"),
].join("\n"), context);

await context.proceedToPayment();
const snapshot = JSON.parse(sessionStorage.getItem("bk_snapshot"));
assert(snapshot, "Cart checkout must save a return snapshot before redirecting");
assert.equal(snapshot.refNumber, "BH-TEST1");
assert.equal(snapshot.cancellationToken, "cancel-1");
assert.equal(snapshot.total, 2420);
assert.deepEqual(snapshot.rawPayload.items.map(item => item.petName), ["Alpha", "Beta"]);
assert.deepEqual(snapshot.editPayload, captured.payload);
assert.equal(snapshot.bookingState.petName, "Beta");
assert.equal(context.window.location.href, "https://fixture.invalid/pay/BH-TEST1");

context.showPayReturnScreen(snapshot, snapshot.refNumber);
assert(element("payReturnDetails").innerHTML.includes("Alpha"));
assert(element("payReturnDetails").innerHTML.includes("Beta"));
assert(element("payReturnPriceBreakdown").innerHTML.includes("Order total"));
assert(!element("payReturnPriceBreakdown").innerHTML.includes("Total paid"));
assert.equal((element("payReturnPriceBreakdown").innerHTML.match(/Convenience fee/g) || []).length, 1);

await context.retryPayment();
assert.deepEqual(cancelled, [{ ref: "BH-TEST1", token: "cancel-1" }]);
assert.deepEqual(posted[1].items.map(item => item.petName), ["Alpha", "Beta"]);
const retried = JSON.parse(sessionStorage.getItem("bk_snapshot"));
const result = JSON.parse(sessionStorage.getItem("barkhaus_order_result"));
assert.equal(retried.refNumber, "BH-TEST2");
assert.equal(retried.cancellationToken, "cancel-2");
assert.equal(result.orderRef, "BH-TEST2");
assert.deepEqual(result.items.map(item => item.refNumber), ["BH-TEST2-A", "BH-TEST2-B"]);
assert.equal(sessionStorage.getItem("bk_pending_ref"), "BH-TEST2");

// Edit uses the current item's declarations, rather than the cart's {items: [...]} envelope.
const checked = new Set();
context.snap = snapshot;
context.document.getElementById = id => ({ classList: {
  add: () => checked.add(id), remove: () => checked.delete(id),
} });
vm.runInContext(between("  var _rp = snap.editPayload", "  // Hide payReturnScreen; restore normal UI chrome"), context);
assert(checked.has("waiverHouseRules"));
assert(checked.has("waiverGeneralHotel"));
assert(!checked.has("waiverMedia"));
// Step-5 boxes: losing bringVaccines here recorded "Not provided" after Edit (2026-10-27).
assert(checked.has("bringVaccines"));
assert(checked.has("vaccineWaiver"));
console.log("Order return regression check passed (snapshot, combined return screen, retry credentials/refs, edit declarations).");
