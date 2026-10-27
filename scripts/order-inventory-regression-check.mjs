// Exercise the actual checkout lock/check block without a remote database or Deno.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const checkout = readFileSync(new URL("supabase/functions/create-maya-checkout/index.ts", root), "utf8");
const inventory = readFileSync(new URL("supabase/functions/_shared/inventory.ts", root), "utf8");
function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Missing source boundary: ${start}`);
  return source.slice(first, last);
}
const keyFunction = between(inventory, "export function inventoryLockKey(", "export async function assertHostedInventory(").replace("export ", "");
const releaseFunction = between(checkout, "async function releaseMutexes(", "// Undo everything this request created");
const lockBlock = between(checkout, "  const mutexKey = inventoryLockKey(", "  // ── 3. Upsert pet");
const errorClass = between(checkout, "class CheckoutError extends Error", "async function releaseMutexes(");
let token = 0;
const locks = new Map();
const calls = [];
const checks = [];
const blocks = [];
const heldRooms = new Set();
let acquisitionError = null;
const supabase = {
  async rpc(name, args) {
    calls.push({ name, ...args });
    if (name === "acquire_inventory_mutex") {
      if (acquisitionError) return { data: null, error: { message: acquisitionError } };
      if (locks.has(args.p_lock_key)) return { data: false, error: null };
      locks.set(args.p_lock_key, args.p_lock_token);
      return { data: true, error: null };
    }
    assert.equal(name, "release_inventory_mutex");
    assert.equal(locks.get(args.p_lock_key), args.p_lock_token);
    locks.delete(args.p_lock_key);
    return { data: true, error: null };
  },
};
const context = vm.createContext({
  Error,
  randomToken: () => `token-${++token}`,
  async assertHostedInventory(_db, branch, body) {
    checks.push(body);
    assert(locks.has(`${branch}:${body.service}${body.service === "hotel" ? "" : `:${body.groomDate || body.studioDate}`}`));
    if (body.service === "hotel" && heldRooms.has(body.hotelRoomId)) throw new Error("Room already held");
  },
  async assertHotelRoomNotBlocked(_db, _branch, body) {
    blocks.push(body);
    if (body.hotelRoomId === "blocked") throw new Error("Room is blocked");
  },
});
const testSource = `${keyFunction}\n${errorClass}\n${releaseFunction}\nasync function check(supabase, created, branch, body) {\n${lockBlock}\n}\nglobalThis.subject = { check, releaseMutexes };`;
vm.runInContext(stripTypeScriptTypes(testSource, { mode: "transform" }), context, { filename: fileURLToPath(new URL("supabase/functions/create-maya-checkout/index.ts", root)) });
const { check, releaseMutexes } = context.subject;
const created = () => ({ mutexes: [] });
const branch = { id: "eastwood" };
const hotel = room => ({ service: "hotel", hotelRoomId: room, hotelCheckin: "2026-10-28", hotelCheckout: "2026-10-29" });
const acquisitions = () => calls.filter(call => call.name === "acquire_inventory_mutex").length;

// The original bug: two different rooms share the branch-wide hotel mutex.
const cart = created();
await check(supabase, cart, branch, hotel("room-1"));
heldRooms.add("room-1"); // createHold writes this item's hold before processing the next.
await check(supabase, cart, branch, hotel("room-2"));
assert.equal(acquisitions(), 1);
assert.equal(cart.mutexes.length, 1);
assert.equal(checks.length, 2);
assert.equal(blocks.length, 2);

// Reusing a mutex must still reject duplicate inventory and blocked rooms.
await assert.rejects(check(supabase, cart, branch, hotel("room-1")), /Room already held/);
await assert.rejects(check(supabase, cart, branch, hotel("blocked")), /Room is blocked/);
assert.equal(acquisitions(), 1);

// A separate checkout must not inherit another checkout's ownership.
const otherCart = created();
const checksBeforeConflict = checks.length;
await assert.rejects(check(supabase, otherCart, branch, hotel("room-3")), /reserved by another customer/);
assert.equal(otherCart.mutexes.length, 0);
assert.equal(checks.length, checksBeforeConflict);

// Distinct lock keys are each acquired; repeated same-day service keys are reused.
const grooming = { service: "grooming", groomDate: "2026-10-28" };
await check(supabase, cart, branch, grooming);
await check(supabase, cart, branch, grooming);
await check(supabase, cart, branch, { ...grooming, groomDate: "2026-10-29" });
await check(supabase, cart, branch, { service: "studio", studioDate: "2026-10-28" });
assert.equal(cart.mutexes.length, 4);
assert.equal(acquisitions(), 5); // four owned keys + the rejected competing request.
const checksBeforeDaycare = checks.length;
await check(supabase, cart, branch, { service: "daycare" });
assert.equal(checks.length, checksBeforeDaycare);

// Release every owned key once, including after an item fails validation.
await releaseMutexes(supabase, cart);
await releaseMutexes(supabase, cart);
assert.equal(calls.filter(call => call.name === "release_inventory_mutex").length, 4);
assert.equal(locks.size, 0);
assert.equal(cart.mutexes.length, 0);

// Database errors fail closed, and never record an unacquired token for cleanup.
acquisitionError = "database unavailable";
await assert.rejects(check(supabase, otherCart, branch, hotel("room-3")), error => error.status === 500 && /database unavailable/.test(error.message));
assert.equal(otherCart.mutexes.length, 0);
console.log("Order inventory regression check passed (shared locks, per-item validation, contention, cleanup, RPC errors).");
