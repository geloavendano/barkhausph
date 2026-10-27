# Return handoff: release preparation, 27 Oct 2026

## OUTCOME: RELEASED 27 Oct 2026 (Claude Code). Read this first; everything below is history.

Accounts, orders (multi-service cart) and the Cloudflare hosting move are **live on production**.
Do not re-run the runbook. Only the open items at the end of this section remain.

**What happened, in order (times PHT):**

- 04:51: dotPH nameservers switched to Cloudflare (`donald`/`harlee`); zone Active. Records kept grey
  until Pages was attached. MX/mail A/TXT records unchanged and not proxied.
- 19:09: **PR #77 was merged by mistake before runbook step B** (GitHub Pages deployed it at once, so
  the new booking page ran against the old functions). Gelo chose to roll forward rather than revert:
  - both migrations applied in the dashboard SQL Editor (`20260920130000_booking_orders.sql`, then
    `20260920140000_payments_reference_unique_per_booking.sql`); psql to production still fails;
  - `MAX_ORDER_ITEMS=1`; 6 functions deployed 19:13:39–19:13:52 in runbook order
    (webhook + reconcile `--no-verify-jwt`; checkout last). Verified from outside: per-booking
    payments index present, old unique rules gone, JWT gates as intended, simulate-payment and
    staging-signin absent (404).
  - An unpushed revert of the merge exists on local branch `hotfix/revert-pr77` (restores `pre-orders`
    exactly). Not needed; delete when convenient.
- 19:56: **Gate B/D passed with a real customer booking** `BH-25691C` (grooming, ₱850 + ₱20 fee):
  order paid with 1 item, booking confirmed and paid, one payment row `recorded_by = maya_webhook`,
  one correct confirmation email (checked by Gelo in Resend).
- ~21:00: Pages custom domains attached (apex, then `www`); both Active. The apex returned **522 for
  about 3 minutes** until 21:03:53 while Pages activated it. A Cloudflare Redirect Rule ("WWW to
  root" template, 301, query string kept) sends `www` to `barkhaus.ph`. Verified: Pages serves
  `main`; `/booking.html?payment=…&ref=…` → `/booking?…` (params kept); `AGENTS.md`, `CLAUDE.md`,
  function source and `admin-src` return 404; `/admin/` has `x-robots-tag: noindex`; Let's Encrypt
  cert for apex + `*.`, valid to 24 Jan 2027; `www` has its own cert.
- `MAX_ORDER_ITEMS=20` (Gelo: no customer-visible limit; 20 is only an abuse ceiling).
- **The cart is ON for everyone** (PR #79, `MULTI_SERVICE_ENABLED = true`). Gelo's call: the
  real-money 2-item test (runbook step E) was **skipped**; 2-item orders were only proven on
  staging with simulated payments.
- PR #78 merged: signed-in customers get "＋ A different pet" next to saved pets. No new saving
  code: `create-maya-checkout` files the booking under the account's email and finds-or-creates the
  pet by name, so the new pet joins their saved pets (that was already production behaviour).
- Also merged with #77: leaving account setup keeps "Continue as a guest" (`260ae9a`).

**Kill switches:** `supabase secrets set MAX_ORDER_ITEMS=1 --project-ref dxttnbtfhpanyiyduevn`
refuses multi-item checkouts immediately (no deploy; singles keep working). To hide the cart,
set `MULTI_SERVICE_ENABLED = false` in `booking.js` and bump its `?v=` in `booking.html`.
Rollback of everything: tag `pre-orders` (`1dd0569`) and the runbook's Rollback section.

**Read-only production checks** (no psql): import `query()` from `scripts/export-production-data.py`
(CLI login via Keychain, Management API). Print statuses/counts only, never customer rows.
Monitor online bookings only: staff (`booking_source = 'admin'`) bookings never create orders and
are usually marked paid without a payment row (695 of 712 in the last 60 days), which is normal.

**Open items:**

1. **Watch the first real multi-item orders** (none yet at handoff): order `paid` with
   `item_count > 1`; every child booking confirmed + paid; one payment row per booking sharing one
   Maya payment ID, `recorded_by = maya_webhook`; reconcile must not cancel them later; one combined
   email. Also check that no `pending_bookings` created since 19:13 stay stuck.
2. Make 20 the code default for `MAX_ORDER_ITEMS` in `create-maya-checkout` (today unset means 5),
   then Gelo redeploys it (JWT verification ON).
3. Remove `simulate-payment.html` (and `email-preview.html` if not wanted) from the
   `scripts/build-site.sh` allowlist; the page is public on production, harmless (its function is 404).
4. Confirmation email shows "Daily 10AM-10PM · Daily 10AM-10PM" when weekday and weekend hours match
   (pre-existing; a task was spawned). Needs a webhook redeploy with `--no-verify-jwt`.
5. Update the AGENTS.md "Deployment model" section (Cloudflare Pages is now live, GitHub Pages is not
   serving) and add tonight's gotchas to `docs/technical-doc.html` §12: Pages domain activation
   gives a few minutes of 522; the Redirect Rule dashboard warns that `www` isn't proxied (false:
   the Pages-managed record is proxied, so deploy anyway and don't create a second record);
   `?v=` must change with every `booking.js` behaviour change; two `var`s with one name in the
   same block are one variable (a duplicate success-screen wrapper caused infinite recursion).
6. In about two weeks: disable GitHub Pages and delete `CNAME`. Later: fix the malformed SPF record;
   consider making the repo private; delete the old `vercel.json`/`.vercelignore` (ask Gelo).
7. Staging leftovers from tonight's tests (staging DB only): accounts `setup-exit-test@example.com`
   and `new-pet-test@example.com` (pets Bruno, Mochi), paid hotel order `BH-59F2F7`.

---

Gelo asked Codex to hand this release back to the other agent. Read this checkpoint before the
original `.agents/HANDOFF-release.md` and the updated release-night runbook. Do not restart prep.
Work in `/Users/gelo/Projects/barkhaus-hosting`, branch `release/accounts-orders`; leave the other
checkout `/Users/gelo/Projects/barkhaus` alone. Gelo executes remote writes/deploys/DNS/Maya steps.
Read-only Supabase MCP diagnostics were authorized during this session.

## Update 27 Oct (Claude Code): resume steps 1–3 below are DONE

- Branch pushed (incl. `03f4bf9`, `9231be7`, Codex prep checkpoint `f5184a9`, and fix `f8b2854`).
- Browser run on the release preview (staging `jsvqukuiegdrojmdbqgi`, `?orders=on`, fictional
  owner release-test@example.invalid, pets Release Cart Gamma/Delta, Eastwood Small Cage 1 + 2,
  31 Oct–1 Nov, total ₱2,620 = 1,300 + 1,300 + one ₱20 fee):
  - Two rooms in one order checked out (lock fix OK). `BH-1C0D91` → "Payment fails" → return
    screen showed both bookings `-A/-B`, one fee, Retry + Edit (return fix OK; took ~20–35 s of
    "Checking your payment…" before it settled).
  - Retry → new order `BH-B87D47`, same items, ₱2,620; old order's holds released.
  - Fail again → Edit → review restored (cart item kept, current item restored) → pay →
    `BH-60F2D7` paid: success screen `-A/-B`, ₱2,620, ONE combined outbox email.
  - Final state via get-payment-status: 1C0D91 and B87D47 cancelled/unpaid, 60F2D7 confirmed/paid.
- **Bug found and fixed (`f8b2854`):** Edit didn't restore "I will bring vaccine records" (and the
  step-5 liability box); the email recorded "Vaccine records: Not provided" for the edited item.
  Same gap existed in production's single-booking Edit. Regression check now asserts it. The fix was
  verified by the check (fails without it) but **not re-run end to end in the browser**.
- Cosmetic, not fixed: after Edit, the review screen still shows "Payment is still being verified…".
- Still open from below: step 4 (Better Stack, dotPH inventory, re-export + preflight near cutover).
  New: set the 4 GitHub apex A records + `www` CNAME in the Cloudflare zone to **DNS only** (grey)
  before the NS switch; they're imported as proxied, and Flexible SSL in front of GitHub Pages'
  enforced HTTPS loops. Check SSL/TLS mode.

## Resume here (HISTORY: superseded by the Outcome section above)

**Do not change nameservers, deploy release functions to production, or merge PR #77 yet.**
The last instruction to Gelo was:

```bash
cd ~/Projects/barkhaus-hosting
git push origin release/accounts-orders
```

They have NOT confirmed running it. A read-only remote check at handoff found release head
`8484737`; local fixes `03f4bf9` and `9231be7` are unpushed. Check again before acting.
Production main remains `1dd0569` (also `pre-orders`). No PR merge or production feature deploy
has happened. No registrar nameserver change or Pages custom-domain attachment is confirmed.
The only production DB change in this session was Gelo's view RLS fix described below.

1. Have Gelo push the release branch and wait for its Cloudflare preview rebuild. Verify the
   served booking.js contains the cart `bk_snapshot` fix before browser testing.
2. Test a NEW two-item checkout on the release preview. Old cart checkouts lack the newly saved
   return snapshot and cannot validate this fix. Return/cancel/expiry must show both bookings and
   usable Retry Payment / Edit booking details controls, rather than a permanent checking screen.
3. Exercise retry: same two payloads, new order/child refs and cancellation credential, correct
   one-fee total; payment success must display the new refs and produce one combined email.
   Exercise edit: cancel both holds, restore current item and its declarations, retain earlier cart item.
4. Confirm Better Stack website monitors and payment monitors, and obtain full dotPH panel record
   inventory confirmation. Re-export production recovery data and run preflight near the cutover.
5. Only then continue the updated runbook's DNS step, backend gate B, frontend, and real payment tests.

## Two release bugs found and fixed

- `03f4bf9 fix: reuse inventory locks within an order`: checkout's second hotel item tried to acquire
  the same branch-wide mutex with a new token, conflicting with its own first item. Now acquire
  each key once per order, validate inventory/blocks for EVERY item, retain locks through order write.
  **Gelo deployed this to staging** `jsvqukuiegdrojmdbqgi`, create-maya-checkout version 22,
  JWT verification ON. MCP metadata/source marker and actual two-room checkout verified it.
  No further backend deploy needed for the frontend fix; production checkout is still old.
- `9231be7 fix: preserve cart checkout state for payment returns`: cart flow saved only
  `barkhaus_order_result`, not `bk_snapshot`. Expired/cancelled cart returned to a checking screen
  although backend cleanup succeeded. Now snapshot includes full retry payload, current edit
  state/declarations, order details and cancellation token; unpaid return renders combined details;
  retry refreshes order/child refs and token. **Local tests pass; preview/browser verification pending.**

Local checks passed:

```bash
node scripts/order-inventory-regression-check.mjs   # Node 24+; executes real TS lock block
node scripts/order-return-regression-check.mjs      # executes real JS checkout/render/retry/edit blocks
node scripts/payment-flow-regression-check.mjs
node --check booking.js
git diff --check
```

The inventory test reproduced the old source's self-conflict before the fix. Coverage includes
shared keys, separate checkout contention, per-item duplicate/block checks, cleanup and RPC failure.
The return test verifies snapshot, both return items, one fee, full retry payload, replaced refs/token,
and current-item waiver restoration. No remote DB writes from the agent for these fixes.

## Staging evidence already obtained

Correct preview: https://release-accounts-orders.barkhausph.pages.dev/booking
(the separate staging.barkhausph.pages.dev preview is older). Preview uses staging ref
`jsvqukuiegdrojmdbqgi`; never point it at production. Existing staging branch is ACTIVE_HEALTHY;
`staging.sh up barkhaus` reports already exists. **Do NOT run down/recreate it.** Historical
MIGRATIONS_FAILED branch status reflects snapshot-built schema; orders/outbox/pricing exist.

- Default cart button hidden; `?orders=on` reveals it. Additional item locks branch and skips owner.
- Single-item BH-26E614: simulator checkout, return then Edit booking details; cancelled + zero holds.
- Two-item BH-2AEB79 (after mutex fix): two different Eastwood hotel rooms, Oct28–29, synthetic pets
  Release Cart Alpha/Beta, fictional owner release-test@example.invalid. Total PHP 2420 = 1200 +
  1200 + one 20 fee. Both children confirmed/paid, refs -A/-B; two payment rows 1220 and 1200 share
  one SIM payment ID; zero holds; ONE outbox email contains both pets and total, rendered in viewer.
  Repeating simulated success left two payment rows and one email (no duplicates).
- Two-item BH-782B7E, Oct29–30: two pending holds observed, simulator Customer abandons it
  sends PAYMENT_EXPIRED; order and both children cancelled/unpaid, zero holds, zero payment rows.
  **Then found the frontend return bug above. Backend cleanup pass is not a full UI pass.**
- Simulator sends no real payment or email. Paid fixture remains in STAGING only; do not mistake
  it for production/test payments to refund. Email viewer open at
  https://release-accounts-orders.barkhausph.pages.dev/email-preview?ref=BH-2AEB79
- Staging grooming schedules end Oct23, no future slots; daycare walk-in-only and studio contact-only.
  Use hotel for browser tests. Minor existing display issues noticed: owner step says Step 51;
  email drop-off time displayed as bare 10. Not changed in this session.

**Clarified abandonment semantics:** merely returning from Maya retains a retryable hold. Edit/retry
explicitly cancels the old hold, or expiry releases it. Simulator abandonment tests expiry separately.
Runbook wording was corrected; verify actual edit/retry in browser after the preview rebuild.

**Gelo explicitly chose to keep -A/-B child booking references** when a handoff/code mismatch was
found. Trigger is BEFORE INSERT only; checkout's later UPDATEs stick. Handoff/design docs corrected.

## Backups: accepted fallback verified, not pg_dump

- PITR OFF; Gelo saw add-on option. Dashboard daily backup reported 25 Oct 2026 20:15 UTC
  (26 Oct 04:15 PHT). Preserve it as full restore baseline; freshness should be rechecked.
- pg_dump/psql failed password auth even after password reset. Direct DB host is IPv6-only and
  Mac lacked IPv6 route. libpq 18.6 installed at `/opt/homebrew/opt/libpq/bin` (not default PATH).
  Do not keep resetting password or claim failed/empty dump files are valid backups.
- Gelo explicitly accepted daily backup + current table exports as fallback. New stdlib Python
  `scripts/export-production-data.py` uses CLI login (macOS Keychain) and Management API read-only
  SQL; all public/auth/storage base tables exported outside repo. No credential/data content printed.
- Verified folder `/Users/gelo/Backups/barkhaus/20261027-024128-dcf9f3f2-table-recovery`:
  02:41:28–02:41:56 PHT; 78 tables, all present; 80 data/metadata files and SHA256SUMS verified;
  private folder/files. Counts: bookings3946, payments1667, owners2476, pets2833, auth users14,
  identities14, storage objects760. Preflight: expected unique payments_reference_number_unique,
  zero duplicate payment groups, zero active checkouts, is_admin/ref trigger present, orders absent.
- This is per-table transactions, NOT one consistent snapshot, standalone schema backup, or a
  restore-tested dump. Storage contains metadata, not uploaded bytes. Restore requires dashboard
  baseline plus careful reconciliation of updates/deletes/FKs/Auth. Re-export before cutover.
- Initial `/Users/gelo/Backups/barkhaus/20261027-0212-pre-release` contains verified repo.bundle,
  deployed function sources/secrets names+digests/checksums; DB dumps failed. All 13 functions
  match pre-orders except customer-account, which exactly matches old git d14b296. No dashboard-only
  custom code was found. Keep release's birthdate work. For rollback use the actual saved
  customer-account source, not tag's version; exact cp command is in updated runbook.
- Backup script now fails its gate on function download errors and checksum failure.

## Production security/Auth prep completed by Gelo

Read-only diagnostics found public.bookings_needs_action bypassing table RLS, accessible to anon.
Prepared migration `supabase/migrations/20261026182733_secure_bookings_needs_action_view.sql`.
Gelo ran ALTER VIEW ... SET (security_invoker=true) + NOTIFY pgrst reload schema in production.
Verified reloption true, anon HEAD count0, ordinary authenticated role count0, admin role57 equals
privileged baseline, security advisor finding cleared. Only counts read, no customer rows retrieved.
**This fix is already live**; don't describe production as completely untouched or apply it blindly.
Other advisor findings left out of scope. Gelo also added/saved both account Auth redirect URLs:
https://barkhaus.ph/account/ and https://www.barkhaus.ph/account/ (existing URLs preserved).

## Cloudflare/DNS preparation

- Free barkhaus.ph zone exists, pending/invalid nameservers. Assigned:
  donald.ns.cloudflare.com and harlee.ns.cloudflare.com. Registrar still dotPH at last check;
  no published DS record then. Recheck before changes.
- Imported 16 records: 6A, 2CNAME, 2MX, 6TXT. Gelo set mail/webmail A192.250.235.76 DNS-only;
  MX/TXT DNS-only; Cloudflare export TTL1 = Auto. All 16 rdata compared with current authoritative
  dotPH DNS, including both full concatenated DKIM values, SPF, DMARC, Google, send MX/SPF,
  staging CNAME. Preserve malformed SPF exactly during migration; fix separately later.
- Export `/Users/gelo/Downloads/barkhaus.ph.txt` copied to
  `/Users/gelo/Backups/barkhaus/20261027-cloudflare-zone-before-move.txt`; known authoritative
  record snapshot at `/Users/gelo/Backups/barkhaus/20261027-dns-before-move.txt`.
  Still need full dotPH panel inventory confirmation (DNS enumeration cannot find unknown records).
- **Ordering correction to old guide:** Pages apex cannot attach until zone is Active. Finish
  prep/tests/monitors, switch NS while imported GitHub web records remain intact, wait Active,
  THEN attach apex/www to Pages, allow only those web records to be replaced, check cert/site/mail,
  and only then do backend/frontend gates. Keep dotPH records for rollback.
- Pages Begin DNS transfer opens generic Add a site. Don't create another zone/registrar transfer;
  use existing Domains -> barkhaus.ph -> Overview for activation/nameserver instructions.
- Production Pages https://barkhausph.pages.dev/ serves current main; env-staging.js empty.
  Python default UA got403; browser UA Mozilla/5.0 succeeds. GitHub Pages still serves public domain.
- Better Stack monitors remain unconfirmed. Real Maya/production email/account smoke tests remain
  untested. Never deploy simulate-payment or staging-signin to production. Preserve JWT flags:
  webhook+reconcile --no-verify-jwt, checkout/status/cancel/account verification ON.

## Local ownership and handoff hygiene

All dirty tracked release-worktree files and the new export script/view migration were authored
by Codex in this session. They contain the recovery instructions, DNS ordering, RLS record and gotchas.
Leave untracked `supabase/.temp/` alone; don't commit CLI runtime files. No other checkout was edited.
Two code-fix commits are ready locally; handoff/prep files may be committed as a separate coherent
commit after checking status. Do not overwrite/revert these session changes as unrelated work.
