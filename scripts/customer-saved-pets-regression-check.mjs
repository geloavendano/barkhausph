import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Missing source boundary: ${start}`);
  return source.slice(first, last);
}
const root = new URL("../", import.meta.url);
const api = readFileSync(new URL("supabase/functions/customer-account/index.ts", root), "utf8");
const tables = {
  owners: [{ id: "owner-1", first_name: "Fixture" }],
  pets: [
    { id: "historical", owner_id: "owner-1", name: "Mochi", customer_updated_at: null, customer_archived_at: null },
    { id: "saved", owner_id: "owner-1", name: "Mochi", customer_updated_at: "2026-10-30", customer_archived_at: null },
    { id: "saved-other", owner_id: "owner-1", name: "Mochi", customer_updated_at: "2026-10-30", customer_archived_at: null },
    { id: "archived", owner_id: "owner-1", name: "Mochi", customer_updated_at: "2026-10-30", customer_archived_at: "2026-10-30" },
    { id: "foreign", owner_id: "owner-2", name: "Mochi", customer_updated_at: "2026-10-30", customer_archived_at: null },
  ],
  pet_profile_vaccines: [
    { pet_id: "saved", vaccine_key: "rabies", confirmed: true, valid_until: "2027-01-01" },
    { pet_id: "historical", vaccine_key: "legacy", confirmed: true },
  ],
  pet_vaccine_documents: [
    { id: "active-doc", pet_id: "saved", active: true },
    { id: "inactive-doc", pet_id: "saved", active: false },
    { id: "legacy-doc", pet_id: "historical", active: true },
  ],
};
let petLookupError = false;
const db = { from(table) {
  let rows = tables[table].slice();
  const query = {
    select() { return this; },
    eq(key, value) { rows = rows.filter(row => row[key] === value); return this; },
    is(key, value) { rows = rows.filter(row => (row[key] ?? null) === value); return this; },
    not(key, operator, value) { assert.equal(operator, "is"); assert.equal(value, null); rows = rows.filter(row => row[key] != null); return this; },
    in(key, values) { rows = rows.filter(row => values.includes(row[key])); return this; },
    order() { return this; },
    single() { return this.result(true); },
    maybeSingle() { return this.result(true); },
    result(single = false) { return { data: single ? rows[0] || null : rows, error: table === "pets" && petLookupError ? { message: "fixture failure" } : null }; },
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); },
  };
  return query;
} };
let account = { owner_id: "owner-1" };
const context = vm.createContext({
  Error, Date,
  accountForUser: async () => account,
  authProvider: () => "email",
});
vm.runInContext(stripTypeScriptTypes([
  between(api, "class ApiError extends Error", "function allowedOrigin("),
  between(api, "async function requireOwnedPet(", "async function saveOwner("),
].join("\n")), context);

const profile = await context.loadProfile(db, { id: "user-1" });
assert.equal(profile.petListScope, "customer_saved");
assert.deepEqual(Array.from(profile.pets, pet => pet.id), ["saved", "saved-other"]);
assert.equal(profile.pets[0].vaccines.rabies, true);
assert.deepEqual(Array.from(profile.pets[0].vaccineDocuments, doc => doc.id), ["active-doc"]);
assert.equal(profile.pets[0].birthYear, ""); // Legacy age-only saved profiles remain selectable.
assert.equal((await context.requireOwnedPet(db, "owner-1", "saved")).id, "saved");
for (const id of ["historical", "archived", "foreign"]) {
  await assert.rejects(context.requireOwnedPet(db, "owner-1", id), error => error.status === 404);
}
account = null;
assert.equal(await context.loadProfile(db, { id: "unlinked-user" }), null);
account = { owner_id: "owner-1" };
petLookupError = true;
await assert.rejects(context.loadProfile(db, { id: "user-1" }), /fixture failure/);

// Both cache consumers hide old unscoped pet lists while retaining contact details.
const client = readFileSync(new URL("customer-account.js", root), "utf8");
const booking = readFileSync(new URL("booking.js", root), "utf8");
const cacheSource = between(client, "  function readCache()", "  function writeCache(");
const bookingSource = between(booking, "  function customer()", "  function cart()");
let cachedProfile = { firstName: "Fixture", pets: [{ id: "historical" }] };
const storage = { getItem: () => JSON.stringify(cachedProfile) };
const cacheContext = vm.createContext({ localStorage: storage, CACHE_KEY: "cache", LEGACY_CACHE_KEY: "legacy", CUSTOMER_KEY: "legacy",
  readJson: (target, key) => JSON.parse(target.getItem(key)) });
vm.runInContext(cacheSource + bookingSource, cacheContext);
for (const read of [cacheContext.readCache, cacheContext.customer]) {
  assert.equal(read().firstName, "Fixture");
  assert.equal(read().pets.length, 0);
}
cachedProfile = JSON.parse(JSON.stringify(profile));
for (const read of [cacheContext.readCache, cacheContext.customer]) assert.equal(read().pets.length, 2);
console.log("Customer saved pets regression check passed (visibility, ownership, vaccines/docs, old caches, errors).");
