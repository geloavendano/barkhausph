// Authenticated customer account API.
//
// Customer authorization is intentionally separate from Barkhaus admin access.
// This function verifies the public-site Supabase Auth session, maps it to a
// customer_accounts row, and performs owner/pet/document operations with the
// service role so owners and pets never need broad browser RLS policies.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = "vaccine-docs";
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(req: Request): string {
  const origin = req.headers.get("origin") || "";
  if (
    /^https:\/\/(?:www\.)?barkhaus\.ph$/i.test(origin)
    || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)
  ) return origin;
  return "https://barkhaus.ph";
}

function cors(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(req),
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function nullableText(value: unknown, max = 500): string | null {
  const cleaned = cleanText(value, max);
  return cleaned || null;
}

function cleanDate(value: unknown): string | null {
  const date = cleanText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function cleanVaccineKey(value: unknown): string | null {
  const key = cleanText(value, 100);
  if (!key) return null;
  if (!/^[A-Za-z0-9_]+$/.test(key)) throw new ApiError("Invalid vaccine record type.");
  return key;
}

function cleanEmail(value: unknown): string {
  return cleanText(value, 320).toLowerCase();
}

function authProvider(user: any): string | null {
  return cleanText(user?.app_metadata?.provider || user?.app_metadata?.providers?.[0], 40) || null;
}

function normalizedPetName(value: unknown): string {
  return cleanText(value, 200).replace(/\s+/g, " ").toLowerCase();
}

function dateHasPassed(value: unknown): boolean {
  const date = cleanDate(value);
  return !!date && new Date(`${date}T23:59:59+08:00`) < new Date();
}

async function validateMembership(supabase: any, codeValue: unknown, petNameValue: unknown): Promise<Record<string, unknown> | null> {
  const code = cleanText(codeValue, 100).toUpperCase();
  if (!code) return null;
  if (code.length < 4) throw new ApiError("Enter the complete Barkhaus membership code.");

  const petName = normalizedPetName(petNameValue);
  if (!petName) throw new ApiError("Enter the pet name before validating the membership code.");

  const { data, error } = await supabase.rpc("validate_member", { p_code: code });
  if (error) throw new Error(`Membership validation failed: ${error.message}`);
  const member: Record<string, any> | null = data && typeof data === "object"
    ? data as Record<string, any>
    : null;
  if (!member?.member_code) throw new ApiError("This Barkhaus membership code was not found.");
  if (member.active === false) throw new ApiError("This Barkhaus membership is inactive.");
  if (dateHasPassed(member.valid_until)) {
    throw new ApiError(`This Barkhaus membership expired on ${member.valid_until}.`);
  }

  const registeredNames = Array.isArray(member.pet_names)
    ? member.pet_names.map(normalizedPetName)
    : [normalizedPetName(member.pet_name)].filter(Boolean);
  if (!registeredNames.includes(petName)) {
    throw new ApiError("The pet name does not match this Barkhaus membership.");
  }

  return {
    code: cleanText(member.member_code, 100).toUpperCase(),
    tier: nullableText(member.tier, 40),
    membershipType: nullableText(member.membership_type, 40) || "standard",
    validUntil: cleanDate(member.valid_until),
  };
}

function fileNameOnly(value: unknown): string {
  const name = cleanText(value, 180).replace(/[\\/]/g, "_");
  return name || "vaccine-document";
}

async function requireUser(req: Request, supabase: any): Promise<any> {
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new ApiError("Please sign in to continue.", 401);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id || !data.user.email) {
    throw new ApiError("Your session is invalid or has expired. Please sign in again.", 401);
  }
  return data.user;
}

async function accountForUser(supabase: any, userId: string): Promise<any | null> {
  const { data, error } = await supabase
    .from("customer_accounts")
    .select("auth_user_id,owner_id,email,auth_provider,created_at,updated_at")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Customer account lookup failed: ${error.message}`);
  return data ?? null;
}

async function requireAccount(supabase: any, userId: string): Promise<any> {
  const account = await accountForUser(supabase, userId);
  if (!account) throw new ApiError("Complete your owner details before adding a pet.", 409);
  return account;
}

async function requireOwnedPet(supabase: any, ownerId: string, petId: string): Promise<any> {
  const { data, error } = await supabase
    .from("pets")
    .select("id,owner_id,name")
    .eq("id", petId)
    .eq("owner_id", ownerId)
    .is("customer_archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`Pet lookup failed: ${error.message}`);
  if (!data) throw new ApiError("Pet not found.", 404);
  return data;
}

async function loadProfile(supabase: any, user: any): Promise<Record<string, unknown> | null> {
  const account = await accountForUser(supabase, user.id);
  if (!account) return null;

  const { data: owner, error: ownerError } = await supabase
    .from("owners")
    .select("id,first_name,last_name,email,mobile,referral_source")
    .eq("id", account.owner_id)
    .single();
  if (ownerError) throw new Error(`Owner profile lookup failed: ${ownerError.message}`);

  const { data: pets, error: petsError } = await supabase
    .from("pets")
    .select("id,name,animal_type,gender,breed,age_value,age_unit,size,medical_notes,temperament,feeding_instructions,medications,vet_clinic,vet_contact,vet_address,emergency_name,emergency_phone,membership_code,vaccine_valid_until,bring_vaccine_records")
    .eq("owner_id", account.owner_id)
    .is("customer_archived_at", null)
    .order("name", { ascending: true });
  if (petsError) throw new Error(`Pet profile lookup failed: ${petsError.message}`);

  const petIds = (pets ?? []).map((pet: any) => pet.id);
  let vaccines: any[] = [];
  let documents: any[] = [];
  if (petIds.length) {
    const [vaccinesResult, documentsResult] = await Promise.all([
      supabase.from("pet_profile_vaccines")
        .select("pet_id,vaccine_key,confirmed,valid_until")
        .in("pet_id", petIds),
      supabase.from("pet_vaccine_documents")
        .select("id,pet_id,vaccine_key,file_name,content_type,file_size_bytes,valid_until,created_at")
        .in("pet_id", petIds)
        .eq("active", true)
        .order("created_at", { ascending: false }),
    ]);
    if (vaccinesResult.error) throw new Error(`Vaccine profile lookup failed: ${vaccinesResult.error.message}`);
    if (documentsResult.error) throw new Error(`Vaccine document lookup failed: ${documentsResult.error.message}`);
    vaccines = vaccinesResult.data ?? [];
    documents = documentsResult.data ?? [];
  }

  const mappedPets = (pets ?? []).map((pet: any) => {
    const vaccineMap: Record<string, boolean> = {};
    const vaccineValidity: Record<string, string> = {};
    vaccines.filter((row: any) => row.pet_id === pet.id).forEach((row: any) => {
      vaccineMap[row.vaccine_key] = row.confirmed === true;
      vaccineValidity[row.vaccine_key] = row.valid_until || pet.vaccine_valid_until || "";
    });
    return {
      id: pet.id,
      name: pet.name || "",
      animal: pet.animal_type || "dog",
      gender: pet.gender || "",
      breed: pet.breed || "",
      age: pet.age_value == null ? "" : String(pet.age_value),
      ageUnit: pet.age_unit || "years",
      size: pet.size || "",
      medical: pet.medical_notes || "",
      temperament: pet.temperament || "",
      feeding: pet.feeding_instructions || "",
      medications: pet.medications || "",
      vetClinic: pet.vet_clinic || "",
      vetContact: pet.vet_contact || "",
      vetAddress: pet.vet_address || "",
      emergencyName: pet.emergency_name || "",
      emergencyPhone: pet.emergency_phone || "",
      membershipId: pet.membership_code || "",
      bringRecords: pet.bring_vaccine_records === true,
      vaccines: vaccineMap,
      vaccineValidity,
      vaccineDocuments: documents.filter((row: any) => row.pet_id === pet.id).map((row: any) => ({
        id: row.id,
        vaccineKey: row.vaccine_key,
        name: row.file_name,
        contentType: row.content_type,
        size: row.file_size_bytes,
        validUntil: row.valid_until,
        createdAt: row.created_at,
      })),
    };
  });

  return {
    authUserId: user.id,
    provider: account.auth_provider || authProvider(user),
    firstName: owner.first_name || "",
    lastName: owner.last_name || "",
    email: owner.email || user.email || "",
    phone: owner.mobile || "",
    source: owner.referral_source || "",
    pets: mappedPets,
  };
}

async function saveOwner(supabase: any, user: any, body: any): Promise<void> {
  const firstName = cleanText(body?.owner?.firstName, 100);
  const lastName = cleanText(body?.owner?.lastName, 100);
  const mobile = cleanText(body?.owner?.phone, 40);
  const referralSource = nullableText(body?.owner?.source, 160);
  const email = cleanEmail(user.email);
  if (!firstName || !lastName || !mobile || !email) {
    throw new ApiError("First name, last name, mobile number, and verified email are required.");
  }

  const existingAccount = await accountForUser(supabase, user.id);
  let ownerId = existingAccount?.owner_id || null;
  if (!ownerId) {
    const { data: matchingOwners, error: lookupError } = await supabase
      .from("owners")
      .select("id")
      .ilike("email", email)
      .limit(1);
    if (lookupError) throw new Error(`Owner lookup failed: ${lookupError.message}`);
    ownerId = matchingOwners?.[0]?.id || null;
  }

  if (ownerId) {
    const { error } = await supabase.from("owners").update({
      first_name: firstName,
      last_name: lastName,
      email,
      mobile,
      referral_source: referralSource,
    }).eq("id", ownerId);
    if (error) throw new Error(`Owner update failed: ${error.message}`);
  } else {
    const { data, error } = await supabase.from("owners").insert({
      first_name: firstName,
      last_name: lastName,
      email,
      mobile,
      referral_source: referralSource,
    }).select("id").single();
    if (error || !data?.id) throw new Error(`Owner creation failed: ${error?.message || "no owner returned"}`);
    ownerId = data.id;
  }

  const now = new Date().toISOString();
  const { error: accountError } = await supabase.from("customer_accounts").upsert({
    auth_user_id: user.id,
    owner_id: ownerId,
    email,
    auth_provider: authProvider(user),
    updated_at: now,
  }, { onConflict: "auth_user_id" });
  if (accountError) throw new Error(`Customer account save failed: ${accountError.message}`);
}

async function savePet(supabase: any, user: any, body: any): Promise<string> {
  const account = await requireAccount(supabase, user.id);
  const pet = body?.pet || {};
  const name = cleanText(pet.name, 100);
  const animal = cleanText(pet.animal, 20).toLowerCase();
  const breed = cleanText(pet.breed, 120);
  const ageRaw = cleanText(pet.age, 3);
  const ageValue = ageRaw === "" ? null : Number.parseInt(ageRaw, 10);
  if (!name || !["dog", "cat"].includes(animal) || !breed || ageValue == null || !Number.isFinite(ageValue) || ageValue < 0 || ageValue > 99) {
    throw new ApiError("Complete the required pet name, animal, breed, and age fields.");
  }
  const validatedMembership = await validateMembership(supabase, pet.membershipId, name);
  const vaccineEntries = pet.vaccines && typeof pet.vaccines === "object"
    ? Object.entries(pet.vaccines).slice(0, 20)
    : [];
  const vaccineValidity = pet.vaccineValidity && typeof pet.vaccineValidity === "object"
    ? pet.vaccineValidity
    : {};
  const vaccineRows = vaccineEntries.map(([key, confirmed]) => {
    const validUntil = cleanDate(vaccineValidity[key]);
    if (confirmed === true && !validUntil) {
      throw new ApiError("Add a valid-until date for every vaccine marked as current.");
    }
    if (confirmed === true && dateHasPassed(validUntil)) {
      throw new ApiError("A vaccine marked as current has already expired. Update its valid-until date.");
    }
    return {
      vaccine_key: cleanText(key, 100),
      confirmed: confirmed === true,
      valid_until: confirmed === true ? validUntil : null,
      updated_at: new Date().toISOString(),
    };
  }).filter((row) => row.vaccine_key);

  const petRow = {
    owner_id: account.owner_id,
    name,
    animal_type: animal,
    gender: nullableText(pet.gender, 20),
    breed,
    age_value: ageValue,
    age_unit: nullableText(pet.ageUnit, 20) || "years",
    size: nullableText(animal === "cat" ? "cat" : pet.size, 40),
    medical_notes: nullableText(pet.medical, 3000),
    temperament: nullableText(pet.temperament, 80),
    feeding_instructions: nullableText(pet.feeding, 3000),
    medications: nullableText(pet.medications, 3000),
    vet_clinic: nullableText(pet.vetClinic, 200),
    vet_contact: nullableText(pet.vetContact, 80),
    vet_address: nullableText(pet.vetAddress, 500),
    emergency_name: nullableText(pet.emergencyName, 200),
    emergency_phone: nullableText(pet.emergencyPhone, 80),
    membership_code: validatedMembership ? validatedMembership.code : null,
    vaccine_valid_until: null,
    bring_vaccine_records: pet.bringRecords === true,
    customer_archived_at: null,
    customer_updated_at: new Date().toISOString(),
  };

  let petId = cleanText(pet.id, 80);
  if (petId) {
    await requireOwnedPet(supabase, account.owner_id, petId);
    const { error } = await supabase.from("pets").update(petRow).eq("id", petId);
    if (error) throw new Error(`Pet update failed: ${error.message}`);
  } else {
    const { data, error } = await supabase.from("pets").insert(petRow).select("id").single();
    if (error || !data?.id) throw new Error(`Pet creation failed: ${error?.message || "no pet returned"}`);
    petId = data.id;
  }

  const { error: clearError } = await supabase.from("pet_profile_vaccines").delete().eq("pet_id", petId);
  if (clearError) throw new Error(`Vaccine profile reset failed: ${clearError.message}`);
  if (vaccineRows.length) {
    const rowsWithPet = vaccineRows.map((row) => ({ ...row, pet_id: petId }));
    if (rowsWithPet.length) {
      const { error } = await supabase.from("pet_profile_vaccines").insert(rowsWithPet);
      if (error) throw new Error(`Vaccine profile save failed: ${error.message}`);
    }
  }
  return petId;
}

async function createDocumentUpload(supabase: any, user: any, body: any): Promise<Record<string, unknown>> {
  const account = await requireAccount(supabase, user.id);
  const petId = cleanText(body?.petId, 80);
  await requireOwnedPet(supabase, account.owner_id, petId);
  const vaccineKey = cleanVaccineKey(body?.vaccineKey);
  if (!vaccineKey) throw new ApiError("Choose which vaccine this document belongs to.");

  const contentType = cleanText(body?.contentType, 100).toLowerCase();
  const declaredSize = Number(body?.fileSize);
  const extension = ALLOWED_TYPES[contentType];
  if (!extension || !Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > MAX_DOCUMENT_BYTES) {
    throw new ApiError("Use a JPG, PNG, WEBP, HEIC, or PDF file up to 10 MB.");
  }

  const { count, error: countError } = await supabase
    .from("pet_vaccine_documents")
    .select("id", { count: "exact", head: true })
    .eq("pet_id", petId)
    .eq("active", true);
  if (countError) throw new Error(`Document quota check failed: ${countError.message}`);
  if ((count ?? 0) >= 20) throw new ApiError("This pet already has the maximum of 20 active vaccine documents.");

  const uploadId = crypto.randomUUID();
  const path = `uploads/vaccine_document/accounts/${user.id}/${petId}/${uploadId}/record.${extension}`;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data?.signedUrl) throw new Error(`Upload authorization failed: ${error?.message || "no signed URL returned"}`);
  return {
    uploadUrl: data.signedUrl,
    path,
    vaccineKey,
    fileName: fileNameOnly(body?.fileName),
    contentType,
    maxSize: MAX_DOCUMENT_BYTES,
  };
}

async function registerDocument(supabase: any, user: any, body: any): Promise<void> {
  const account = await requireAccount(supabase, user.id);
  const petId = cleanText(body?.petId, 80);
  await requireOwnedPet(supabase, account.owner_id, petId);
  const vaccineKey = cleanVaccineKey(body?.vaccineKey);
  if (!vaccineKey) throw new ApiError("Choose which vaccine this document belongs to.");
  const path = cleanText(body?.path, 700);
  const expectedPrefix = `uploads/vaccine_document/accounts/${user.id}/${petId}/`;
  if (!path.startsWith(expectedPrefix) || path.includes("..")) throw new ApiError("Invalid vaccine document path.");

  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash);
  const objectName = path.slice(slash + 1);
  const { data: objects, error: storageError } = await supabase.storage.from(BUCKET)
    .list(folder, { search: objectName, limit: 5 });
  if (storageError) throw new Error(`Uploaded document verification failed: ${storageError.message}`);
  const object = (objects ?? []).find((item: any) => item.name === objectName);
  const actualSize = Number(object?.metadata?.size || 0);
  if (!object || actualSize <= 0 || actualSize > MAX_DOCUMENT_BYTES) {
    throw new ApiError("The uploaded vaccine document could not be verified.");
  }

  const { error } = await supabase.from("pet_vaccine_documents").upsert({
    pet_id: petId,
    vaccine_key: vaccineKey,
    file_path: path,
    file_name: fileNameOnly(body?.fileName),
    content_type: nullableText(body?.contentType, 100),
    file_size_bytes: actualSize,
    valid_until: cleanDate(body?.validUntil),
    active: true,
    archived_at: null,
    uploaded_by_auth_user_id: user.id,
  }, { onConflict: "file_path" });
  if (error) throw new Error(`Vaccine document save failed: ${error.message}`);
}

async function archiveDocument(supabase: any, user: any, body: any): Promise<void> {
  const account = await requireAccount(supabase, user.id);
  const documentId = cleanText(body?.documentId, 80);
  const { data: document, error } = await supabase.from("pet_vaccine_documents")
    .select("id,pet_id")
    .eq("id", documentId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(`Vaccine document lookup failed: ${error.message}`);
  if (!document) throw new ApiError("Vaccine document not found.", 404);
  await requireOwnedPet(supabase, account.owner_id, document.pet_id);
  const { error: updateError } = await supabase.from("pet_vaccine_documents").update({
    active: false,
    archived_at: new Date().toISOString(),
  }).eq("id", documentId);
  if (updateError) throw new Error(`Vaccine document archive failed: ${updateError.message}`);
}

async function archivePet(supabase: any, user: any, body: any): Promise<void> {
  const account = await requireAccount(supabase, user.id);
  const petId = cleanText(body?.petId, 80);
  await requireOwnedPet(supabase, account.owner_id, petId);
  const { error } = await supabase.from("pets").update({
    customer_archived_at: new Date().toISOString(),
    customer_updated_at: new Date().toISOString(),
  }).eq("id", petId);
  if (error) throw new Error(`Pet archive failed: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const user = await requireUser(req, supabase);
    const body = await req.json().catch(() => ({}));
    const action = cleanText(body?.action, 60);

    if (action === "get_profile") {
      return json(req, { profile: await loadProfile(supabase, user) });
    }
    if (action === "save_owner") {
      await saveOwner(supabase, user, body);
      return json(req, { profile: await loadProfile(supabase, user) });
    }
    if (action === "validate_membership") {
      return json(req, { membership: await validateMembership(supabase, body?.code, body?.petName) });
    }
    if (action === "save_pet") {
      const petId = await savePet(supabase, user, body);
      return json(req, { petId, profile: await loadProfile(supabase, user) });
    }
    if (action === "create_document_upload") {
      return json(req, await createDocumentUpload(supabase, user, body));
    }
    if (action === "register_document") {
      await registerDocument(supabase, user, body);
      return json(req, { profile: await loadProfile(supabase, user) });
    }
    if (action === "archive_document") {
      await archiveDocument(supabase, user, body);
      return json(req, { profile: await loadProfile(supabase, user) });
    }
    if (action === "archive_pet") {
      await archivePet(supabase, user, body);
      return json(req, { profile: await loadProfile(supabase, user) });
    }
    throw new ApiError("Unknown customer account action.", 404);
  } catch (error) {
    console.error("customer-account error:", error instanceof Error ? error.message : error);
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError
      ? error.message
      : "We could not update your account. Please try again.";
    return json(req, { error: message }, status);
  }
});
