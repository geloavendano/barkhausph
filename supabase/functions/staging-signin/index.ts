// Barkhaus — staging-signin edge function (STAGING ONLY)
//
// Staging cannot send email (the branch inherits the SMTP settings but not the password), and a made-up
// one-time code is not something Supabase will accept. So on staging the tester types an email and is
// signed in straight away: this function makes sure the account exists, then asks Supabase for a
// single-use token — the same token a magic-link email would have carried — and hands it back. The page
// completes sign-in with the normal verifyOtp() call, so the rest of the flow is the real one.
//
// It refuses to run against the production database. The check is the project's own id, not a setting:
// production can never satisfy it, and even if this function were deployed there it answers 404.
// See docs/decisions/2026-09-20-accounts-orders-release.md

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PRODUCTION_PROJECT_REF = "dxttnbtfhpanyiyduevn";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function isProductionProject(): boolean {
  return (Deno.env.get("SUPABASE_URL") || "").includes(PRODUCTION_PROJECT_REF);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (isProductionProject()) return json({ error: "Not found" }, 404);

  try {
    const { email } = await req.json();
    const address = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return json({ error: "Enter a valid email address" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // magiclink works for an existing account, signup creates one. Either way the reply carries the
    // token the email would have contained; nothing is sent.
    let link = await supabase.auth.admin.generateLink({ type: "magiclink", email: address });
    if (link.error && /user not found/i.test(link.error.message || "")) {
      link = await supabase.auth.admin.generateLink({ type: "signup", email: address, password: crypto.randomUUID() });
    }
    if (link.error) return json({ error: link.error.message }, 500);

    const tokenHash = (link.data?.properties as Record<string, string> | undefined)?.hashed_token;
    if (!tokenHash) return json({ error: "Supabase did not return a sign-in token" }, 500);

    return json({ staging: true, email: address, token_hash: tokenHash });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
