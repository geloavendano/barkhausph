// cancel-pending-booking
// Called by booking.html when a customer wants to edit after a failed/cancelled payment.
// Cancels the old pending booking so the slot is freed immediately rather than waiting
// for the pg_cron 15-minute auto-cancel.
// Uses service role — bypasses RLS — but only operates on 'pending' bookings.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sha256 } from '../_shared/security.ts';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    const { ref_number, cancellation_token } = await req.json();

    if (!ref_number || !cancellation_token ||
        typeof ref_number !== 'string' || typeof cancellation_token !== 'string') {
      return new Response(JSON.stringify({ error: 'ref_number and cancellation_token are required' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const tokenHash = await sha256(cancellation_token);
    const ref = ref_number.trim().toUpperCase();
    const nowIso = new Date().toISOString();

    // ── Orders (2026-09): one hold per booking, one token on the order ───────────
    // The customer returns with the ORDER ref, and cancelling releases every booking in it.
    const { data: order } = await supabase
      .from('booking_orders')
      .select('id,order_ref')
      .eq('order_ref', ref)
      .eq('cancellation_token_hash', tokenHash)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .maybeSingle();

    if (order) {
      const { data: cancelledBookings, error: orderCancelError } = await supabase
        .from('bookings')
        .update({
          status: 'cancelled',
          cancellation_reason: 'Customer initiated — editing booking after failed payment',
        })
        .eq('order_id', order.id)
        .eq('status', 'pending')
        .select('id');
      if (orderCancelError) throw orderCancelError;

      await supabase.from('pending_bookings').delete().eq('order_ref', order.order_ref);
      await supabase.from('booking_orders')
        .update({ status: 'cancelled', updated_at: nowIso })
        .eq('id', order.id).eq('status', 'pending');

      return new Response(
        JSON.stringify({ cancelled: Array.isArray(cancelledBookings) && cancelledBookings.length > 0,
                         order_ref: order.order_ref,
                         bookings_cancelled: cancelledBookings?.length ?? 0 }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // ── Legacy single hold (and holds created before orders existed) ─────────────
    const { data: pending, error: pendingError } = await supabase
      .from('pending_bookings')
      .select('id,ref_number')
      .eq('ref_number', ref)
      .eq('cancellation_token_hash', tokenHash)
      .gt('expires_at', nowIso)
      .maybeSingle();
    if (pendingError) throw pendingError;
    if (!pending) {
      return new Response(JSON.stringify({ cancelled: false }), {
        status: 403,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Only cancel if still pending — prevents cancelling confirmed/checked-in bookings.
    const { data, error } = await supabase
      .from('bookings')
      .update({
        status: 'cancelled',
        cancellation_reason: 'Customer initiated — editing booking after failed payment',
      })
      .eq('ref_number', pending.ref_number)
      .eq('status', 'pending')
      .select('id');

    if (error) throw error;
    if (Array.isArray(data) && data.length > 0) {
      await supabase.from('pending_bookings').delete().eq('id', pending.id);
    }

    return new Response(
      JSON.stringify({ cancelled: Array.isArray(data) && data.length > 0 }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message ?? 'Unknown error' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
