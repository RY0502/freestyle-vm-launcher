export interface UploadedImageInput {
  name: string;
  type: string;
  data: Buffer | Uint8Array;
}

export interface SupabaseStorageConfig {
  supabaseUrl: string;
  supabaseKey: string;
  supabaseBucket: string;
}

export function getSupabaseConfig(): SupabaseStorageConfig {
  const supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const supabaseBucket = (process.env.SUPABASE_STORAGE_BUCKET || "shared").trim();

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Supabase storage is not configured. Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  return { supabaseUrl, supabaseKey, supabaseBucket };
}

/**
 * Clears all existing files in the 'input' directory of the Supabase bucket.
 */
export async function clearExistingInputFiles(
  config?: SupabaseStorageConfig
): Promise<string[]> {
  const { supabaseUrl, supabaseKey, supabaseBucket } = config ?? getSupabaseConfig();

  const listUrl = `${supabaseUrl}/storage/v1/object/list/${encodeURIComponent(supabaseBucket)}`;
  const listResponse = await fetch(listUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      apikey: supabaseKey,
      authorization: `Bearer ${supabaseKey}`,
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify({
      prefix: "input",
      limit: 100,
      sortBy: { column: "name", order: "asc" },
    }),
  });

  if (!listResponse.ok) {
    const errorText = await listResponse.text().catch(() => "");
    throw new Error(
      `Failed to list files in Supabase 'input' directory (HTTP ${listResponse.status}): ${errorText}`
    );
  }

  const items = (await listResponse.json()) as Array<{ name?: string }>;
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const prefixesToDelete: string[] = [];
  for (const item of items) {
    if (item.name && item.name !== ".emptyFolderPlaceholder") {
      const fullPath = item.name.startsWith("input/") ? item.name : `input/${item.name}`;
      prefixesToDelete.push(fullPath);
    }
  }

  if (prefixesToDelete.length === 0) {
    return [];
  }

  const deleteUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseBucket)}`;
  const deleteResponse = await fetch(deleteUrl, {
    method: "DELETE",
    headers: {
      accept: "application/json",
      apikey: supabaseKey,
      authorization: `Bearer ${supabaseKey}`,
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify({ prefixes: prefixesToDelete }),
  });

  if (!deleteResponse.ok) {
    const errorText = await deleteResponse.text().catch(() => "");
    throw new Error(
      `Failed to delete existing files in Supabase 'input' directory (HTTP ${deleteResponse.status}): ${errorText}`
    );
  }

  return prefixesToDelete;
}

/**
 * Uploads up to 5 image files to the 'input' directory in the Supabase bucket.
 * Returns the list of public URLs in upload order.
 */
export async function uploadInputImages(
  images: UploadedImageInput[],
  config?: SupabaseStorageConfig
): Promise<string[]> {
  if (images.length === 0) return [];
  if (images.length > 5) {
    throw new Error("Maximum of 5 images allowed for upload.");
  }

  const { supabaseUrl, supabaseKey, supabaseBucket } = config ?? getSupabaseConfig();
  const publicUrls: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const originalName = image.name || `image_${i + 1}.png`;
    const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const targetFileName = `${i + 1}_${sanitizedName}`;
    const objectKey = `input/${targetFileName}`;

    const uploadUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(
      supabaseBucket
    )}/input/${encodeURIComponent(targetFileName)}`;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(
      supabaseBucket
    )}/input/${encodeURIComponent(targetFileName)}`;

    const contentType = image.type && image.type.startsWith("image/")
      ? image.type
      : "image/png";

    const blob = new Blob([image.data as unknown as BlobPart], {
      type: contentType,
    });

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        apikey: supabaseKey,
        authorization: `Bearer ${supabaseKey}`,
        "cache-control": "3600",
        "content-type": contentType,
        "x-upsert": "true",
      },
      body: blob,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Failed to upload image "${originalName}" to Supabase Storage (HTTP ${response.status}): ${errorText}`
      );
    }

    publicUrls.push(publicUrl);
  }

  return publicUrls;
}

/**
 * Formats image URLs as reference URLs string to append to the prompt.
 * Format:
 * Reference urls: <urls separated by new line>
 */
export function formatReferenceUrls(urls: string[]): string {
  if (urls.length === 0) return "";
  return `Reference urls:\n${urls.join("\n")}`;
}
