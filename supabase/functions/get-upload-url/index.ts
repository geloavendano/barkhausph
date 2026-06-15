// get-upload-url
// Called by the booking form before submit-booking is invoked.
// The client generates a random uploadId (UUID), uploads files here,
// then passes the resulting paths to submit-booking, which inserts
// vaccine_documents rows and, for manual transfer receipts, a payments row.
//
// Request body:
//   { uploadId: string, fileName: string, contentType: string, vaccineKey?: string }
//
// Response:
//   { uploadUrl: string, path: string, token: string }
//
// The client uploads via:
//   fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': contentType } })
// Then includes `path` in the submit-booking payload as either:
//   vaccineDocuments: { [vaccineKey]: path }
//   manualPayment.receiptPath

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "vaccine-docs";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg":      "jpg",
  "image/jpg":       "jpg",
  "image/png":       "png",
  "image/webp":      "webp",
  "image/heic":      "heic",
  "image/heif":      "heif",
  "application/pdf": "pdf",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { uploadId, fileName, contentType, vaccineKey } = await req.json();

    // ── Validate inputs ──
    if (!uploadId || !fileName || !contentType) {
      return new Response(
        JSON.stringify({ error: "uploadId, fileName and contentType are required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const ext = ALLOWED_TYPES[contentType.toLowerCase()];
    if (!ext) {
      return new Response(
        JSON.stringify({ error: "File type not allowed. Accepted: JPEG, PNG, WEBP, HEIC, PDF." }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // ── Build storage path ──
    // uploads/{uploadId}/{vaccineKey}-{timestamp}.{ext}
    // submit-booking uses these paths when inserting vaccine/payment rows.
    const safeKey  = (vaccineKey ?? "vaccine").replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const path     = `uploads/${uploadId}/${safeKey}-${Date.now()}.${ext}`;

    // ── Create signed upload URL (expires in 5 minutes) ──
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);

    if (error || !data) {
      throw new Error(`Storage error: ${error?.message ?? "no data returned"}`);
    }

    console.log("Signed upload URL created:", path);

    return new Response(
      JSON.stringify({ uploadUrl: data.signedUrl, path, token: data.token }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("get-upload-url error:", err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
