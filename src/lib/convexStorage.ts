import crypto from 'node:crypto';
import { ensureSupportedImage, compressImage } from './imageCompressor';
import { recordTrackedCdnUrls } from './cdnTracker';

export interface UploadedImageInput {
  name: string;
  type: string;
  data: Buffer | Uint8Array;
}

/**
 * Sanitizes an uploaded image filename so it is safe across all platforms (web, Windows, Linux, Convex).
 * Handles character cases:
 * - Replaces underscores (`_`), spaces, and non-alphanumeric characters with hyphens (`-`) so underscores
 *   are reserved exclusively for the index prefix (`${index}_${sanitizedName}`).
 * - Replaces dots in the base name with hyphens so there is only a single extension dot.
 * - Converts to lowercase for consistent case sensitivity across OSes and URL handlers.
 * - Collapses consecutive hyphens and trims leading/trailing hyphens from the stem.
 * - Preserves valid image extensions or defaults to 'png'.
 */
export function sanitizeImageFileName(name: string, fallbackIndex = 1): string {
  const fallback = `image-${fallbackIndex}.png`;
  if (!name || typeof name !== 'string') {
    return fallback;
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return fallback;
  }

  const lastDotIndex = trimmed.lastIndexOf('.');
  const hasDot = lastDotIndex !== -1;
  const rawStem = hasDot && lastDotIndex > 0 ? trimmed.slice(0, lastDotIndex) : (hasDot ? '' : trimmed);
  const rawExt = hasDot ? trimmed.slice(lastDotIndex + 1) : '';

  let cleanStem = rawStem
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[_.\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!cleanStem) {
    cleanStem = `image-${fallbackIndex}`;
  }

  let cleanExt = rawExt
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (!cleanExt || !/^(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?|mpo)$/i.test(cleanExt)) {
    cleanExt = 'png';
  }

  return `${cleanStem}.${cleanExt}`;
}

/**
 * Extracts the clean file name from a Convex virtual path (e.g., 'input/1_my-image.png' -> 'my-image.png').
 * Robust against any index prefix format or underscore delimiters.
 */
export function extractFileNameFromConvexPath(path: string): string {
  const base = path.replace(/^.*[\\/]/, '');
  const prefixMatch = base.match(/^\d+[_-](.+)$/);
  if (prefixMatch && prefixMatch[1]) {
    return prefixMatch[1];
  }
  return base;
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
    let imageBuffer = Buffer.isBuffer(image.data)
      ? image.data
      : Buffer.from(image.data);
    const originalName = image.name || `image-${i + 1}.png`;
    let sanitizedName = sanitizeImageFileName(originalName, i + 1);
    let contentType = image.type && image.type.startsWith('image/')
      ? image.type
      : 'image/png';

    // Ensure image format is supported downstream (JPEG, PNG, WebP are used as-is;
    // Camera formats like HEIC, BMP, TIFF, MPO are converted to 100% quality JPEG; GIF to PNG).
    const processed = ensureSupportedImage(imageBuffer, originalName);
    imageBuffer = processed.buffer;
    if (processed.converted) {
      console.log(
        `[convexStorage] Converted "${originalName}" (${processed.detectedFormat}) to ${processed.extension.toUpperCase()} for video agent compatibility.`
      );
      contentType = processed.contentType;
      sanitizedName = sanitizedName.replace(/\.[^/.]+$/, '') + `.${processed.extension}`;
    } else if (processed.contentType) {
      contentType = processed.contentType;
    }

    const targetFileName = `${i + 1}_${sanitizedName}`;
    const objectKey = `input/${targetFileName}`;

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
      body: new Uint8Array(imageBuffer),
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
    const sha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');
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
          size: imageBuffer.length,
          sha256,
          metadata: {
            originalName,
            sanitizedName,
            index: i + 1,
          },
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

  if (publicUrls.length > 0) {
    try {
      await recordTrackedCdnUrls(publicUrls);
    } catch (trackerErr) {
      console.warn('[convexStorage] Failed to record tracked CDN URLs:', trackerErr);
    }
  }

  return publicUrls;
}

export interface ProjectConvexFile {
  path: string;
  storageId: string;
  url: string;
}

/**
 * Lists all files currently in Convex for this project (bucket: 'shared', prefix: 'input/').
 */
export async function listProjectConvexFiles(
  config?: ConvexStorageConfig
): Promise<ProjectConvexFile[]> {
  const { convexUrl, convexBucket, convexDeployKey } = config ?? getConvexConfig();
  const queryUrl = `${convexUrl}/api/query`;
  const authHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (convexDeployKey) {
    authHeaders.authorization = formatAuthHeader(convexDeployKey);
  }

  const response = await fetch(queryUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      path: 'files:listFiles',
      args: {
        bucket: convexBucket,
      },
      format: 'json',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Failed to list Convex files (HTTP ${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    status?: string;
    value?: Array<{
      path?: string;
      storageId?: string;
      url?: string;
    }>;
    errorMessage?: string;
  };

  if (result.status === 'error') {
    throw new Error(`Failed to list Convex files: ${result.errorMessage || 'Unknown error'}`);
  }

  const allFiles = result.value || [];
  return allFiles
    .filter((f) => f.path && f.path.startsWith('input/'))
    .map((f) => ({
      path: f.path!,
      storageId: f.storageId || '',
      url: f.url || (f.storageId ? `${convexUrl}/api/storage/${f.storageId}` : ''),
    }));
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

export {
  ensureSupportedImage,
  convertToLosslessPng,
  compressImage,
  compressPortraitImage,
} from './imageCompressor';
