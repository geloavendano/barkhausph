# Decision: releasing customer accounts + multi-service booking (orders)

Status: **Approved plan** · 2026-09-20. Replaces the earlier "Vercel move + blue-green release" plan.
Schedule: **DNS move Monday 21 Sep (night)**, **features Tuesday 22 Sep (night)**.
Related: `2026-09-20-hosting-and-previews.md` (Cloudflare), `2026-09-20-dns-move-checklist.md`.

## 1. The request

Put the two features staged under `/staging/` live: **customer accounts** and **multi-service booking**
(several services paid in one checkout). Accounts have a working backend; multi-service booking does not.
The staged "Proceed to payment" sends only one booking to Maya, and the payment code assumes one booking
per payment, so a cart would be under-charged, and a paid second booking could be **cancelled by the
reconcile job** (same failure as BH-E0D9B8).

**Out of scope:** changing prices, the admin calendar, or the payment provider.

## 2. What changed since the Vercel plan

| Area | Was | Now |
|---|---|---|
| Hosting | Vercel (A records at dotPH) | **Cloudflare Pages**, DNS moved to Cloudflare (Monday). Project `barkhausph`, allowlist build to `dist/`, `env.js` decides production vs staging by address. |
| Green for functional tests | `green.barkhaus.ph` on production data | **`staging.barkhausph.pages.dev` on the staging database** (`staging.sh up`), with a **payment simulator** |
| Green for the one real-money test | same | **None.** Decided 2026-09-20: traffic is low, so the real-payment test runs on barkhaus.ph right after release, in a quiet window, with multi-service still switched off until it passes. |
| Backend deploys | straight to production | **staging branch first** (`supabase functions deploy <fn> --project-ref <staging ref>`), then production in the same order |
| Redirects | `vercel.json` | `_redirects` (Cloudflare format) |
| Frontend rollback | Vercel Instant Rollback | Cloudflare Pages **Rollback** (dashboard, seconds); DNS is on Cloudflare by Tuesday |
| payment-health | every 20 min | GitHub backup hourly; **Better Stack stays the primary monitor** |
| `20260801113000_pet_birthdate_parts` | not confirmed | **Applied** on staging and production (2026-09-20). Verified backward-compatible: optional columns, rules only apply to filled-in dates, no existing writer touches them; tested on staging. |

## 3. Data model: every hosted checkout is an order (unchanged from the Vercel plan)

- New `booking_orders` (id, `order_ref` unique, owner_id, branch_id, amount, convenience_fee, status
  `pending|paid|cancelled`, gateway_checkout_id, gateway_payment_id, cancellation_token_hash, expires_at,
  created_at). RLS: admin read and service role.
- `bookings.order_id` (nullable), `pending_bookings.order_ref` (nullable) + index. Each booking keeps its own
  `pending_bookings` row, so admin, the expiry job and payment-health keep working per booking.
- Refs: the `generate_ref_number()` trigger always sets `bookings.ref_number` (`BH-` + 6 chars from the
  booking id) and today's checkout reads it back. **The order ref is the first booking's generated ref**,
  so a 1-item order looks exactly like today; other items keep their own refs and are listed under the
  order in the email and on the confirmation page. The trigger is not changed. (Replaces the `-A/-B`
  suffix idea, which the trigger would overwrite.)
- One Maya checkout per order; all its `payments` rows share the Maya payment ID. One order fee, added to the
  first booking's total, so booking totals sum to the order amount.

## 4. Guiding principle: the shared backend never breaks the current site

Supabase is shared by production and every frontend version, so the backend ships first and must stay
**backward-compatible**:

- `create-maya-checkout` accepts both today's single-booking body and `{ items: [...] }`
  (`items = body.items ?? [body]`). Today's site keeps working unchanged, as 1-item orders.
- Webhook, reconcile, status and cancel resolve ref → order → bookings, with a **legacy fallback** for
  holds created before the deploy.
- The webhook's duplicate check becomes **per (payment ID, booking)**. Reconcile never cancels a booking
  without checking its **order** in Maya.
- Tag current function sources `pre-orders` before deploying (Supabase has no function rollback).
- Kill-switches: `MULTI_SERVICE_ENABLED` (frontend, hides "Add another") and `MAX_ORDER_ITEMS` (Supabase
  env; `1` refuses carts server-side, single bookings still work).
- **Payment simulator** (staging only): `simulate-payment` calls the same finalize code as the webhook
  (`finalizePending`, extracted by this work), refuses to run unless its database is not production
  (checked by project ID), and staging emails go to a staging-only outbox table that only `staging.sh up`
  creates (never a migration). The staging booking flow shows a scenario screen (paid / failed / abandoned)
  instead of Maya, and the confirmation screen links to the rendered email.

## 5. Plan and schedule

```
Sun 20 – Mon 21   B. Backend, on STAGING
                     orders migration → webhook (finalizePending + order path + one combined email)
                     → reconcile → get-payment-status → cancel-pending-booking → customer-account CORS
                     → create-maya-checkout last (MAX_ORDER_ITEMS=1) → simulate-payment
                     tests: regression script, simulator (paid / failed / abandoned, 1- and 2-item)
Mon 21 (day)         B'. Backend to PRODUCTION (Gelo, same order), tag pre-orders first
                     gate: one real single-booking checkout on the live site → 1-item order, paid, one email
Mon 21 (night)    A. DNS move to Cloudflare (content unchanged), per the DNS checklist
Tue 22 (day)      C. Frontend on release/accounts-orders → merged into `staging`
                     promote /staging/ pages to the root, remove STAGING_PREVIEW / fetch guard / hard-coded
                     ORDER_REF, items[] checkout, _redirects /staging/* → /*, sitemap
                     test on staging.barkhausph.pages.dev with the simulator
Tue 22 (night)    D. Quiet hour. Merge to main with MAX_ORDER_ITEMS=1 → barkhaus.ph (accounts live,
                     carts refused server-side). Smoke test + one real 1-item booking.
                     Then MAX_ORDER_ITEMS=5 → one real 2-item order → admin shows both paid, 2 payment
                     rows, one combined email → refund in Maya, cancel in admin.
                     Any failure: MAX_ORDER_ITEMS=1 (seconds, carts off) or Cloudflare Rollback (frontend).
```

A (DNS) and B (backend) are independent. C needs B on staging; D needs B' in production.

## 6. Fallbacks

- Backend tests on staging not clean by **Tuesday afternoon** → release **accounts only**
  (`MULTI_SERVICE_ENABLED=false`, `MAX_ORDER_ITEMS=1`). Built in, not a re-plan.
- Single-booking checkout regresses after the production deploy → redeploy the `pre-orders` functions;
  the new columns are nullable and simply go unused.
- Frontend problem after release → Cloudflare Rollback (seconds).
- DNS problem Monday night → restore dotPH nameservers (checklist "Undo").

## 7. Learn-by-doing (Gelo)

`orderStatusFromChildren(children)` in `get-payment-status`: what the return page shows when an order's
bookings are in mixed states (all paid / some pending / any cancelled).

## 8. Open

- [ ] Gelo: confirm the Better Stack monitors and add the website monitor (section 9).

## 9. Monitoring

Better Stack stays the primary monitor; nothing about the Cloudflare move changes the health checks,
because they call Supabase directly, not barkhaus.ph. The GitHub canary is an hourly backup.

| Monitor (Better Stack) | Checks | Status |
|---|---|---|
| `payment-health` | `GET …/functions/v1/payment-health` with header `x-health-token: <BETTERSTACK_HEALTH_TOKEN>`, alert unless the body contains `"ok":true` | Gelo to confirm it exists and alerts |
| `maya-health` | `GET …/functions/v1/maya-health`, same header | Gelo to confirm |
| **Website** (add) | `https://barkhaus.ph/` and `/booking` return 200 and contain "Barkhaus" | Add before the DNS move, to watch the switch |
| **Staging** | none; staging is switched off most of the time | deliberately not monitored |

After the orders release, `payment-health` keeps working unchanged: each booking still has its own
`pending_bookings` row, which is what it counts.
