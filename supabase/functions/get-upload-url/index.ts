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
import { randomToken, sha256 } from "../_shared/security.ts";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "vaccine-docs";
const PURPOSE_LIMITS: Record<string, number> = {
  vaccine_document: 10 * 1024 * 1024,
  grooming_reference: 10 * 1024 * 1024,
  manual_payment_receipt: 10 * 1024 * 1024,
};

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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const now = new Date().toISOString();
    const { data: expiredUploads } = await supabase.from("pending_uploads")
      .select("id,bucket_id,object_path")
      .lt("expires_at", now)
      .is("consumed_at", null)
      .limit(50);
    for (const upload of expiredUploads ?? []) {
      await supabase.storage.from(upload.bucket_id).remove([upload.object_path]);
    }
    if (expiredUploads?.length) {
      await supabase.from("pending_uploads")
        .delete()
        .in("id", expiredUploads.map((upload: any) => upload.id));
    }

    const { uploadId, fileName, contentType, fileSize, purpose, vaccineKey } = await req.json();

    // ── Validate inputs ──
    if (!uploadId || !fileName || !contentType || !purpose || !Number.isFinite(Number(fileSize))) {
      return new Response(
        JSON.stringify({ error: "uploadId, fileName, contentType, fileSize and purpose are required" }),
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
    const maxSize = PURPOSE_LIMITS[purpose];
    if (!maxSize || Number(fileSize) <= 0 || Number(fileSize) > maxSize) {
      return new Response(
        JSON.stringify({ error: "File size or upload purpose is not allowed" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const forwarded = req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") || "unknown";
    const fingerprintHash = await sha256(forwarded);
    const { data: rateLimitReason, error: rateLimitError } = await supabase
      .rpc("authorize_upload_request", {
        p_fingerprint_hash: fingerprintHash,
        p_purpose: purpose,
        p_declared_size_bytes: Number(fileSize),
      });
    if (rateLimitError) throw new Error(`Upload quota check failed: ${rateLimitError.message}`);
    if (rateLimitReason) {
      return new Response(JSON.stringify({ error: rateLimitReason }), {
        status: 429,
        headers: { ...CORS, "Content-Type": "application/json", "Retry-After": "600" },
      });
    }

    // ── Build storage path ──
    // uploads/{uploadId}/{vaccineKey}-{timestamp}.{ext}
    // submit-booking uses these paths when inserting vaccine/payment rows.
    const safeUploadId = String(uploadId).replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
    const safeKey  = (vaccineKey ?? "vaccine").replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const path     = `uploads/${purpose}/${safeUploadId}/${safeKey}-${Date.now()}.${ext}`;

    // ── Create signed upload URL (expires in 5 minutes) ──
    const authorizationToken = randomToken();
    const tokenHash = await sha256(authorizationToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const { error: authorizationError } = await supabase.from("pending_uploads").insert({
      token_hash: tokenHash,
      bucket_id: BUCKET,
      object_path: path,
      purpose,
      content_type: contentType.toLowerCase(),
      max_size_bytes: maxSize,
      expires_at: expiresAt,
      fingerprint_hash: fingerprintHash,
    });
    if (authorizationError) throw new Error(`Upload authorization error: ${authorizationError.message}`);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);

    if (error || !data) {
      await supabase.from("pending_uploads").delete().eq("token_hash", tokenHash);
      throw new Error(`Storage error: ${error?.message ?? "no data returned"}`);
    }

    console.log("Signed upload URL created:", path);

    return new Response(
      JSON.stringify({
        uploadUrl: data.signedUrl,
        path,
        token: data.token,
        authorizationToken,
        expiresAt,
      }),
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
