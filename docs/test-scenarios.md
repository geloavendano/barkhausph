# Barkhaus — Flows & Test Scenario Matrix

> Working enumeration of every flow + scenario, to later drive automated test scripts.
> Grounded in the actual codebase (booking.js, admin-src, supabase/functions).
> ⚠️ = behaves differently than commonly assumed, or a current gap.

## Reference dimensions

| Dimension | Values |
|---|---|
| **Source** | Public booking page (`booking.js` → `create-payment` → PayMongo → `handle-payment-webhook`); Admin **Add Booking** (`AddBookingPanel` mode `admin` → `submit-booking`); Admin **Walk-in** (`AddBookingPanel` mode `walkin` → `submit-booking`) |
| **Service** | grooming, hotel, daycare, **studio** (studio: include in tests but **not** as a complete/paid booking flow — partial coverage only) |
| **Branch** | Estancia, Eastwood (hours differ: Estancia Mon–Thu 11:00–21:00, Fri–Sun 10:00–22:00; Eastwood 10:00–22:00) |
| **Pet type** | dog, cat |
| **Pet size** | small_dog, medium_dog, large_dog, giant_dog, cat |
| **Hotel rate key** | Driven by **cage type** (not pet size) **× day type (weekday/weekend)**: cage→rate-key small_cage→small_dog, medium_cage→medium_dog, large_cage→large_dog, single_cabin→cat_single_cabin, villa→cat_villa; each key has weekday & weekend rates (Fri/Sat/Sun = weekend) |
| **Resource type** | Room/cage (hotel), Groomer (grooming), Studio (studio); daycare has no per-resource assignment |
| **Membership** | none; Standard (branch-scoped); Passport (all branches); states: valid, inactive, expired, wrong-branch |
| **Payment status** | unpaid, partially_paid, paid, refunded |
| **Booking status** | pending, confirmed, checked_in, completed, cancelled, rejected |

---

## 1. Create-Booking Scenarios

### 1A. Source × Service grid (the core matrix)
For each **source** × **service** combination, a full happy-path create:

| | grooming | hotel | daycare | studio |
|---|---|---|---|---|
| **Public booking page** | ✅ pay online | ✅ | ✅ | ✅ |
| **Admin – Add Booking** | ✅ | ✅ | ✅ | ✅ (only if studios exist for branch) |
| **Admin – Walk-in** | ✅ | ✅ | ✅ | ✅ |

→ 12 baseline happy-path scenarios (studio admin paths gated on branch having studios).

### 1B. Membership
- No member code → no discount.
- Valid Standard code, **same** branch → discount applied (per-service %).
- Valid Standard code, **different** branch → rejected ("belongs to another branch").
- Valid Passport code, any branch → discount applied.
- Inactive code → rejected.
- Expired code (`valid_until` past) → rejected.
- Unknown code → rejected.
- Discount math: applied on full subtotal (base + addons + late), consistent public vs admin.

### 1C. Pet type / size
- Dog small/medium/large/giant → grooming price by size; hotel price by cage; daycare by size.
- Cat → grooming (cat price), hotel (cat_single_cabin vs cat_villa by cage), daycare (cat).
- Cat hotel: villa shows "second cat" option (public) ⚠️ — verify admin parity.
- Size restricts room availability (small_dog can use small/medium/large; large_dog only large; giant only large).

### 1D. Resource availability & type
- **Grooming – specific groomer**: slot free → allowed.
- **Grooming – specific groomer**: groomer booked at slot → slot hidden.
- **Grooming – specific groomer**: would receive overflow from unassigned "Any" booking → slot hidden ⚠️.
- **Grooming – Any available**: at least one groomer free → slot shown; all booked (incl. unassigned overflow) → hidden.
- **Grooming**: groomer recurring break (schedule_restrictions) → slot blocked.
- **Grooming**: one-off blocked_schedule on groomer → slot blocked.
- **Grooming**: service_date vs booking_date — availability keyed on `service_date` ⚠️.
- **Hotel – room**: room available across full check-in→check-out span → selectable; capacity exhausted → hidden/disabled.
- **Hotel**: room locked (`is_locked`) → excluded.
- **Studio**: slot taken / studio unavailable / blocked_schedule → disabled.
- **Daycare**: no per-resource booking (capacity only) — confirm no resource gating.
- Drop-off / pick-up times constrained to **branch operating hours** for the relevant date ⚠️.

### 1E. Vaccine availability (declaration)
- Dog vaccines: Anti-rabies, 5/6/8-in-1, Kennel Cough/Bordetella, Tick & flea.
- Cat vaccines: Anti-rabies, All-in-1, Anti-parasitic.
- Each: Yes / No / unset.
- Admin and public store names in different formats ⚠️ — edit pre-population must normalise (verified fixed).

### 1F. Vaccine upload
- Public: file upload → `get-upload-url` → storage → path passed to `create-payment` → webhook inserts `vaccine_documents`. Scenarios: no file, 1 file, multiple files, "will bring later".
- Admin ⚠️: **no file upload** — only Yes/No declarations. (Gap to note for parity testing.)

### 1G. Notes
- Grooming special requests; daycare notes; hotel feeding instructions + medications/special care; admin internal notes (`b.notes`).
- Empty vs filled; long text; special characters.

### 1H. Waiver requirements
- General terms, Health declaration, Media consent — all services.
- Studio usage agreement — studio only.
- Senior / medical waiver — conditional (senior/medical pet).
- Play park consent — hotel only (dogs; cats N/A). "No consent → keep in room only" warning surfaces in drawer.
- Public: waivers must be accepted to proceed. Admin: toggles, pre-filled true.

### 1I. Referral source ("how did you hear about us")
- Instagram, Facebook, TikTok, Google search, Friend/family referral, Walk-in/saw the branch, (empty).
- Stored on owner; reused when existing owner selected.

### 1J. Email received
- Public booking: confirmation email via Resend on `payment.paid` (webhook). ⚠️ Not sent until payment succeeds.
- Admin Add Booking & Walk-in: confirmation email via Resend in `submit-booking` when `adminCreated=true` and email present.
- No email when owner email blank.
- Scenarios: email content correctness per service (grooming/hotel/daycare/studio), membership line, addons, branch footer.

### 1K. Payment scenarios
- **Public – success**: PayMongo checkout paid → webhook → booking confirmed + paid, detail rows inserted, email sent.
- **Public – failure/cancel**: booking stays `pending`; no detail rows; customer can retry or edit (`cancel-pending-booking` cancels the pending row).
- **Public – abandoned**: pg_cron auto-cancels `pending` after 15 min ⚠️.
- **Public – duplicate webhook**: both `payment.paid` and `checkout_session.payment.paid` fire — idempotency must prevent double-processing ⚠️.
- **Admin create**: status/payment set by admin (default confirmed/unpaid); no PayMongo. Optional manual payment recorded at creation if not unpaid.
- **convenience_fee**: online only (PayMongo); not added for admin/walk-in.
- `booking_charges` insert: requires admin RLS policy ⚠️ — currently soft-fails (booking still created). DB policy fix pending.

---

## 2. Manage-Booking Scenarios

### 2A. Accept manual payment (`PaymentPanel`)
- Types: downpayment, balance, refund. Methods: cash, gcash/qrph, card, bank transfer.
- Record downpayment on unpaid → payment_status partially_paid (manual).
- Record balance → paid.
- Amount validation (empty/zero/non-numeric rejected).
- Reference number optional.
- Multiple payments accumulate; drawer lists them.

### 2B. Check-in process (with check-in notes)
- Check-In page lists due bookings (today): Awaiting check-in / In progress / Due for checkout.
- Status transition pending/confirmed → checked_in (requires resource assigned: groomer for grooming, room for hotel) ⚠️.
- Check-in notes form differs by service: hotel (physical inspection, personal items, addon purchases); daycare (remarks, addons); grooming (remarks + Y/N health checks: vaccination, skin/coat, ears/nose/eyes, nails, joints).
- Save creates/updates `checkin_notes` row.

### 2C. Additional fees upon check-in
- Grooming: dematting / deshedding (assessment-priced) added at check-in.
- Hotel: medication / special care surcharges.
- Mechanism: addon purchases recorded; `booking_charges` / `booking_addons` updated; total recalculated.
- ⚠️ Verify how check-in-time fees flow into total + balance due.

### 2D. Additional fees upon checkout
- Daycare: pick-up beyond first 3 hours → extra hourly rate per size (open-time = base only).
- Hotel: late pick-up beyond paid pick-up hour → late fee per hour after 14:00; >6h past standard checkout = +1 night.
- Hotel: failure to pick up by 8 PM → charged as additional night.
- Recalc on checkout; collect balance via manual payment.

### 2E. Edit booking — price affected
- Change service package, size→(grooming price), addons, hotel dates/cage, daycare hours, pick-up hour, membership code.
- Recalc subtotal/discount/total; refresh `booking_charges` (preserve convenience_fee).
- Service type locked in edit ⚠️ (can't convert hotel→grooming).
- Pre-population parity: all fields restored (vaccines, addons, waivers, notes, member code, times, room name) — regression-prone area.

### 2F. Edit booking — inventory / resource affected
- Reassign groomer (grooming) / room (hotel) via drawer "Assign" or via edit.
- Reassign to unavailable/blocked resource → should warn/prevent ⚠️ (verify).
- Reassignment updates detail table; calendar reflects new column/color.

### 2G. Cancel booking
- Admin: set status → cancelled (drawer status select); optional cancellation_reason.
- Cancelled bookings excluded from calendar/check-in, shown struck-through in list.
- Public pending cancel via `cancel-pending-booking` (only `status=pending`).
- ⚠️ No dedicated "cancel + refund" combined action.

### 2H. Refund customer
- ⚠️ No automated PayMongo refund. Refund = manual `payments` row, type `refund`; set payment_status → refunded manually.
- Scenarios: full refund, partial refund, refund after partial payment.

---

## 3. Admin-Management Scenarios

### 3A. Create members ⚠️
- No single-member create form. Done via **CSV upload** (`MembersPage` → `sbUpsert`).
- CSV columns: Membership ID, Pet name, Valid until date, Branch.
- Scenarios: new codes added; batch upload; missing/blank columns; unknown branch name; tier (passport vs standard) — note CSV doesn't set tier explicitly (verify default).

### 3B. Update members ⚠️
- Also CSV: re-upload existing member_code → upsert updates (counts as "updated").
- No per-field edit UI; no deactivate UI (active toggled only via DB/CSV?). Flag gap.
- Validate card: lookup by code → shows tier, coverage branch, validity, pet name; states valid/inactive/expired/no-branch.

### 3C. Create inventory (`ResourcesPage`)
- Rooms: name, color, room_type (cage type), pet_type, allowed_sizes.
- Groomers: name, color.
- Studios: name, color.
- `sbPost` to respective table, branch-scoped, sort_order.
- Validation: name required; color from allowed CHECK set.

### 3D. Update inventory
- Edit existing room/groomer/studio (name, color, type, sizes).
- Room: is_locked + lock_reason. Groomer/Studio: is_unavailable + unavailable_reason.
- Soft delete: `active=false` (PATCH) — removed from lists/dropdowns; existing bookings keep reference.
- ⚠️ Inactive resources excluded from all booking dropdowns (verified) — test that historical bookings still render the name.

### 3E. Block schedule (`BlockSchedulePanel`)
- Resource types: Hotel Room, Groomer, Studio.
- Pick resource + one or more dates + start/end time + reason.
- Creates `blocked_schedules` row (dates array).
- Reflected on calendar (hatched block, side-by-side with bookings) and removes affected slots from public + admin availability.
- Scenarios: single date, multi-date, full-day vs partial, block before branch open (clipped to visible range ⚠️).

### 3F. Edit blocked schedule ⚠️
- **Not implemented.** BlockDrawer has only Delete + Done. To change a block you delete and recreate.
- (Candidate feature / test gap.)

### 3G. Cancel blocked schedule
- BlockDrawer → Delete Block → `active=false` (soft delete); confirm dialog.
- Slot/time freed on calendar + availability.

### 3H. Filter bookings (Calendar)
- Service tabs: All / Hotel / Grooming / Daycare / (Studio).
- Resource filter: by room / groomer / studio (sidebar desktop, bottom-sheet mobile).
- Default view: All, current day.
- Active filter narrows cards; counts per resource.

### 3I. Search bookings (Bookings + Check-In)
- Query ≥2 chars; debounced.
- Match on: ref_number, owner first/last name, owner email, pet name.
- Branch-scoped; merged unique; newest first; capped 50/query.
- ⚠️ Full-name ("First Last") not matched — only first OR last OR email substring.
- Empty / no-match / clearing states.

---

## Cross-cutting / non-functional

- **Auth**: admin gate (admin_users table); sign-out; session refresh; token cache.
- **Live updates**: realtime + 60s poll + visibilitychange on Calendar & Bookings.
- **Pagination**: Bookings row-based offset; load-more loading + end states.
- **Timezones**: created_at UTC vs local date grouping; service_date handling.
- **Mobile**: top bar fit, bottom nav (4 + More), FAB position, drawers/sheets.
- **Keyboard**: Esc closes overlays; R refreshes (when no field focused / no overlay).
- **RLS**: booking_charges admin insert policy (pending DB fix).

---

## Decisions (reviewed)

- **Studio** — test partial flows only, not a complete/paid booking. ✅ decided.
- **Hotel pricing** — cage type × weekday/weekend rate. ✅ confirmed.
- **Confirmation emails** — correct as-is. ✅ confirmed.
- **Create/update members** — CSV upload only (by design). ✅ confirmed.
- **Refund customer** — manual `payments` row, type `refund`. ✅ confirmed (no automated refund).
- **Admin vaccine upload** — declarations only, no file upload. ✅ confirmed.

### Won't do / out of scope
- **Edit blocked schedule** — excluded; delete + recreate is acceptable.

### Still open
- **booking_charges RLS policy** — SQL written at
  `supabase/migrations/2026-06-11_booking_charges_rls.sql`; **needs to be run
  against the database** (app currently soft-fails the charge write so bookings
  still succeed).
- **Combined cancel+refund action** — not built (cancel and refund are separate
  steps today). Decide if needed.
