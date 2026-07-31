const ATTACHMENT_BUCKET = "vaccine-docs";

export type AttachmentEntry = {
  key: string;
  path: string;
  fileName: string;
  rawPath?: string;
};

export type VerifiedAttachments = {
  valid: AttachmentEntry[];
  missing: AttachmentEntry[];
};

function safePath(value: unknown): string {
  const path = String(value ?? "").trim();
  if (!path || path.includes("..") || path.startsWith("/") || path.endsWith("/")) return "";
  return path;
}

export function attachmentEntries(paths: unknown, fileNames: unknown): AttachmentEntry[] {
  if (!paths || typeof paths !== "object") return [];
  const names = fileNames && typeof fileNames === "object"
    ? fileNames as Record<string, unknown>
    : {};

  return Object.entries(paths as Record<string, unknown>)
    .map(([key, rawPath]) => {
      const raw = String(rawPath ?? "").trim();
      const path = safePath(rawPath);
      return {
        key,
        path,
        rawPath: raw,
        fileName: String(names[key] || raw.split("/").pop() || key),
      };
    });
}

async function storageObjectExists(supabase: any, path: string): Promise<boolean> {
  const slash = path.lastIndexOf("/");
  const folder = slash >= 0 ? path.slice(0, slash) : "";
  const fileName = slash >= 0 ? path.slice(slash + 1) : path;
  if (!folder || !fileName) return false;

  const { data, error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .list(folder, { search: fileName, limit: 10 });
  if (error) throw new Error(`Could not verify uploaded file: ${error.message}`);

  const object = (data ?? []).find((file: any) => file.name === fileName);
  const size = Number(object?.metadata?.size ?? 0);
  return !!object && size > 0;
}

export async function verifyAttachments(
  supabase: any,
  entries: AttachmentEntry[],
): Promise<VerifiedAttachments> {
  const valid: AttachmentEntry[] = [];
  const missing: AttachmentEntry[] = [];

  for (const entry of entries) {
    if (await storageObjectExists(supabase, entry.path)) valid.push(entry);
    else missing.push(entry);
  }

  return { valid, missing };
}

export async function assertAttachmentsExist(
  supabase: any,
  entries: AttachmentEntry[],
): Promise<void> {
  const { missing } = await verifyAttachments(supabase, entries);
  if (!missing.length) return;
  const names = missing.map((entry) => entry.fileName).join(", ");
  throw new Error(`Uploaded file could not be verified: ${names}`);
}
