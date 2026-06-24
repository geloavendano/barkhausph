import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function requireAdmin(req: Request, serviceClient: any): Promise<Record<string, any>> {
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!token || token === anonKey) throw new Error("Admin authentication required");

  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    anonKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  const email = userData?.user?.email?.trim().toLowerCase();
  if (userError || !email) throw new Error("Invalid admin session");

  const { data: admin, error: adminError } = await serviceClient
    .from("admin_users")
    .select("id,email,branch_ids")
    .ilike("email", email)
    .maybeSingle();
  if (adminError || !admin) throw new Error("Admin access required");
  return { ...admin, auth_user_id: userData.user.id };
}
