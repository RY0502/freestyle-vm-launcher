import crypto from 'node:crypto';

export interface UploadedImageInput {
  name: string;
  type: string;
  data: Buffer | Uint8Array;
}

export interface ConvexStorageConfig {
  convexUrl: string;
  convexBucket: string;
  convexDeployKey?: string;
}

function formatAuthHeader(key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith('Convex ') || trimmed.startsWith('Bearer ')) {
    return trimmed;
  }
  if (trimmed.startsWith('DeployKey ')) {
    return `Convex ${trimmed.slice('DeployKey '.length).trim()}`;
  }
  // If key is a 3-part dot-separated JWT, format as Bearer token
  if (trimmed.split('.').length === 3) {
    return `Bearer ${trimmed}`;
  }
  // Deploy keys (prod:..., dev:...) require the 'Convex ' prefix
  return `Convex ${trimmed}`;
}

export function getConvexConfig(): ConvexStorageConfig {
  const convexUrl = (process.env.CONVEX_URL || '').trim().replace(/\/+$/, '');
  const convexBucket = (process.env.CONVEX_STORAGE_BUCKET || 'shared').trim();
  const convexDeployKey = (process.env.CONVEX_DEPLOY_KEY || '').trim();

  if (!convexUrl) {
    throw new Error(
      'Convex storage is not configured. Missing CONVEX_URL in environment variables.'
    );
  }

  return { convexUrl, convexBucket, convexDeployKey };
}

/**
 * Clears all existing files in the 'input/' prefix of the Convex bucket.
 * Calls the Convex mutation files:deleteFilesByPrefix to delete both storage objects and database records.
 */
export async function clearExistingInputFiles(
  config?: ConvexStorageConfig
): Promise<string[]> {
  const { convexUrl, convexBucket, convexDeployKey } = config ?? getConvexConfig();
  const mutationUrl = `${convexUrl}/api/mutation`;
  const authHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (convexDeployKey) {
    authHeaders.authorization = formatAuthHeader(convexDeployKey);
  }

  const response = await fetch(mutationUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      path: 'files:deleteFilesByPrefix',
      args: {
        bucket: convexBucket,
        prefix: 'input/',
      },
      format: 'json',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Failed to clear Convex 'input' directory (HTTP ${response.status}): ${errorText}`
    );
  }

  const result = (await response.json()) as {
    status?: string;
    value?: { deletedPaths?: string[]; deletedCount?: number };
    errorMessage?: string;
  };

  if (result.status === 'error') {
    throw new Error(
      `Failed to clear Convex 'input' directory: ${result.errorMessage || 'Unknown error'}`
    );
  }

  return result.value?.deletedPaths || [];
}

/**
 * Uploads up to 5 image files to the 'input/' virtual directory in the Convex storage bucket.
 * Returns the list of public URLs in upload order.
 */
export async function uploadInputImages(
  images: UploadedImageInput[],
  config?: ConvexStorageConfig
): Promise<string[]> {
  if (images.length === 0) return [];
  if (images.length > 5) {
    throw new Error('Maximum of 5 images allowed for upload.');
  }

  const { convexUrl, convexBucket, convexDeployKey } = config ?? getConvexConfig();
  const mutationUrl = `${convexUrl}/api/mutation`;
  const authHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (convexDeployKey) {
    authHeaders.authorization = formatAuthHeader(convexDeployKey);
  }

  const publicUrls: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const originalName = image.name || `image_${i + 1}.png`;
    const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const targetFileName = `${i + 1}_${sanitizedName}`;
    const objectKey = `input/${targetFileName}`;
    const contentType = image.type && image.type.startsWith('image/')
      ? image.type
      : 'image/png';

    // 1. Generate upload URL via mutation files:generateUploadUrl
    const genUrlResponse = await fetch(mutationUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        path: 'files:generateUploadUrl',
        args: {},
        format: 'json',
      }),
    });

    if (!genUrlResponse.ok) {
      const errorText = await genUrlResponse.text().catch(() => '');
      throw new Error(
        `Failed to generate Convex upload URL for "${originalName}" (HTTP ${genUrlResponse.status}): ${errorText}`
      );
    }

    const genUrlResult = (await genUrlResponse.json()) as {
      status?: string;
      value?: string;
      errorMessage?: string;
    };
    if (genUrlResult.status === 'error' || !genUrlResult.value) {
      throw new Error(
        `Failed to generate Convex upload URL for "${originalName}": ${genUrlResult.errorMessage || 'No upload URL returned'}`
      );
    }
    const uploadUrl = genUrlResult.value;

    // 2. Upload file bytes to the upload URL
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'content-type': contentType,
      },
      body: new Uint8Array(image.data),
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text().catch(() => '');
      throw new Error(
        `Failed to upload image "${originalName}" to Convex Storage (HTTP ${uploadResponse.status}): ${errorText}`
      );
    }

    const uploadResult = (await uploadResponse.json()) as { storageId?: string };
    const storageId = uploadResult.storageId;
    if (!storageId) {
      throw new Error(`Convex upload succeeded for "${originalName}" but returned no storageId.`);
    }

    // 3. Save file metadata in storedFiles table
    const sha256 = crypto.createHash('sha256').update(Buffer.from(image.data)).digest('hex');
    const saveResponse = await fetch(mutationUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        path: 'files:saveFile',
        args: {
          storageId,
          bucket: convexBucket,
          path: objectKey,
          fileName: sanitizedName,
          contentType,
          size: image.data.length,
          sha256,
        },
        format: 'json',
      }),
    });

    if (!saveResponse.ok) {
      const errorText = await saveResponse.text().catch(() => '');
      throw new Error(
        `Failed to save metadata in Convex for "${originalName}" (HTTP ${saveResponse.status}): ${errorText}`
      );
    }

    const saveResult = (await saveResponse.json()) as {
      status?: string;
      value?: { url?: string; storageId?: string };
      errorMessage?: string;
    };

    if (saveResult.status === 'error') {
      throw new Error(
        `Failed to save metadata in Convex for "${originalName}": ${saveResult.errorMessage || 'Unknown error'}`
      );
    }

    const publicUrl = saveResult.value?.url || `${convexUrl}/api/storage/${storageId}`;
    publicUrls.push(publicUrl);
  }

  return publicUrls;
}

/**
 * Formats image URLs as reference URLs string to append to the prompt.
 * Format:
 * Reference urls:
 * <urls separated by new line>
 */
export function formatReferenceUrls(urls: string[]): string {
  if (urls.length === 0) return '';
  return `Reference urls:\n${urls.join('\n')}`;
}
