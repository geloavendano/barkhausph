// Authenticated helper for Barkhaus admins to open private booking attachments.
// Signs only vaccine-docs paths already attached to the requested booking.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/security.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

const BUCKET = "vaccine-docs";

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function cleanPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((path) => String(path || "").trim())
      .filter((path) => path && !path.includes("..") && !path.startsWith("/")),
  )).slice(0, 30);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const admin = await requireAdmin(req, supabase);
    const body = await req.json();
    const bookingId = String(body?.bookingId || "").trim();
    const requestedPaths = cleanPaths(body?.paths);
    const expiresIn = Math.max(60, Math.min(Number(body?.expiresIn) || 3600, 3600));

    if (!bookingId || requestedPaths.length === 0) return json({ urls: {} });

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id,branch_id")
      .eq("id", bookingId)
      .maybeSingle();
    if (bookingError) throw new Error(bookingError.message);
    if (!booking) return json({ error: "Booking not found" }, 404);
    if (
      Array.isArray(admin.branch_ids)
      && admin.branch_ids.length > 0
      && !admin.branch_ids.includes(booking.branch_id)
    ) {
      return json({ error: "You do not have access to this booking's branch" }, 403);
    }

    const [vaccines, refs, payments] = await Promise.all([
      supabase.from("vaccine_documents").select("file_path").eq("booking_id", bookingId),
      supabase.from("grooming_reference_images").select("file_path").eq("booking_id", bookingId),
      supabase.from("payments").select("receipt_path").eq("booking_id", bookingId),
    ]);
    for (const result of [vaccines, refs, payments]) {
      if (result.error) throw new Error(result.error.message);
    }

    const allowed = new Set<string>([
      ...((vaccines.data ?? []).map((row: any) => row.file_path).filter(Boolean)),
      ...((refs.data ?? []).map((row: any) => row.file_path).filter(Boolean)),
      ...((payments.data ?? []).map((row: any) => row.receipt_path).filter(Boolean)),
    ]);

    const urls: Record<string, string> = {};
    const denied: string[] = [];
    const missing: string[] = [];
    for (const path of requestedPaths) {
      if (!allowed.has(path)) {
        denied.push(path);
        continue;
      }
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(path, expiresIn);
      if (error) {
        console.error("Admin storage sign failed:", path, error.message);
        missing.push(path);
        continue;
      }
      if (data?.signedUrl) urls[path] = data.signedUrl;
      else missing.push(path);
    }

    return json({ urls, missing, denied });
  } catch (err) {
    console.error("admin-sign-storage-urls error:", err instanceof Error ? err.message : err);
    const message = err instanceof Error ? err.message : "Unexpected error";
    const status = /authentication|session|access|required/i.test(message) ? 401 : 500;
    return json({ error: message }, status);
  }
});
