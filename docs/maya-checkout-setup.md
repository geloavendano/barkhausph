# Maya Checkout setup

The integration is prepared but dormant. `PAYMENT_GATEWAY_PROVIDER` in
`booking.js` must remain `manual` during data migration.

## 1. Apply the database migration

Run `supabase/migrations/2026-06-18_payment_gateway_providers.sql` in the
Supabase SQL editor. It adds provider-neutral correlation fields to
`pending_bookings` and reloads the PostgREST schema cache.

## 2. Create Supabase secrets

Do not put credential values in this repository. Add them in Supabase Dashboard
under Edge Functions > Secrets, or run:

```sh
supabase secrets set MAYA_PUBLIC_KEY="<sandbox-public-key>"
supabase secrets set MAYA_SECRET_KEY="<sandbox-secret-key>"
supabase secrets set MAYA_ENVIRONMENT="sandbox"
supabase secrets set SITE_URL="https://barkhaus.ph"
```

Use the matching sandbox key pair. When launching, replace both keys together
and set `MAYA_ENVIRONMENT=production`.

## 3. Deploy functions

```sh
supabase functions deploy create-maya-checkout
supabase functions deploy get-payment-status
supabase functions deploy handle-payment-webhook --no-verify-jwt
```

The webhook must allow requests without a Supabase JWT because Maya calls it
server-to-server. `create-maya-checkout` and `get-payment-status` remain JWT
protected and are called with the site's Supabase anon token.

## 4. Register Maya webhooks

Register these current event names in Maya Manager:

- `PAYMENT_SUCCESS`
- `PAYMENT_FAILED`
- `PAYMENT_EXPIRED`
- `PAYMENT_CANCELLED`

Callback URL:

```text
https://dxttnbtfhpanyiyduevn.supabase.co/functions/v1/handle-payment-webhook
```

The handler retrieves every Maya event from Maya's Payments API using the
secret key, then verifies payment ID, status, booking reference, and amount
before confirming a Barkhaus booking. It retains PayMongo signature handling.

## 5. Sandbox acceptance checks

Keep the public provider set to `manual` while testing the Maya function
directly. Before launch, verify:

- the pending-booking cron runs `select public.expire_pending_bookings();` from
  the migration; Maya holds are written with a one-hour expiry, so disable the
  older fixed 15-minute age job before Maya is enabled;

- successful card payment confirms one booking and creates one payment row;
- duplicate/replayed success webhooks remain idempotent;
- failed, expired, and cancelled checkouts cancel the pending booking;
- a mismatched amount or reference is rejected;
- success redirect waits for webhook confirmation;
- confirmation email is sent once;
- hotel room, grooming slot, daycare, and studio availability are released on failure.

## 6. Enable Maya later

After sandbox sign-off and production credentials are installed, change:

```js
var PAYMENT_GATEWAY_PROVIDER = 'manual';
```

to:

```js
var PAYMENT_GATEWAY_PROVIDER = 'maya';
```

PayMongo remains available as the dormant `paymongo` option.
