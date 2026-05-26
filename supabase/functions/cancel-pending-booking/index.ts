// cancel-pending-booking
// Called by booking.html when a customer wants to edit after a failed/cancelled payment.
// Cancels the old pending booking so the slot is freed immediately rather than waiting
// for the pg_cron 15-minute auto-cancel.
// Uses service role — bypasses RLS — but only operates on 'pending' bookings.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    const { booking_id } = await req.json();

    if (!booking_id || typeof booking_id !== 'string') {
      return new Response(JSON.stringify({ error: 'booking_id is required' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Only cancel if still pending — prevents cancelling confirmed/checked-in bookings
    const { data, error } = await supabase
      .from('bookings')
      .update({
        status: 'cancelled',
        cancellation_reason: 'Customer initiated — editing booking after failed payment',
      })
      .eq('id', booking_id)
      .eq('status', 'pending')
      .select('id');

    if (error) throw error;

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
