import fs from 'node:fs/promises';
import path from 'node:path';

const TRACKER_FILE_PATH = path.join(process.cwd(), 'data', 'trackedCdnUrls.json');

const INITIAL_SEEDED_URLS: string[] = [
  'https://convex-portrait-cache.ravi-y0102.workers.dev/api/storage/914b6929-ba8a-453f-9422-a39b25943f15',
  'https://convex-portrait-cache.ravi-y0102.workers.dev/api/storage/b248fd14-8cbc-43c8-9e15-b73246252288',
  'https://convex-portrait-cache.ravi-y0102.workers.dev/api/storage/6e782456-84a9-4278-babb-291fa18a7111',
];

/**
 * Normalizes a URL by trimming trailing slashes and whitespace.
 */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Retrieves all currently tracked CDN URLs for this project.
 * If the tracker file doesn't exist yet, it initializes it with the initial seed.
 */
export async function getTrackedCdnUrls(): Promise<string[]> {
  try {
    const raw = await fs.readFile(TRACKER_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return Array.from(new Set(parsed.filter((u): u is string => typeof u === 'string').map(normalizeUrl)));
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      await saveTrackedCdnUrls(INITIAL_SEEDED_URLS);
      return [...INITIAL_SEEDED_URLS];
    }
    console.warn('[cdnTracker] Failed to read tracked CDN URLs:', err);
  }
  return [...INITIAL_SEEDED_URLS];
}

/**
 * Persists the given URLs list to the tracker JSON file.
 */
async function saveTrackedCdnUrls(urls: string[]): Promise<void> {
  const dir = path.dirname(TRACKER_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
  const uniqueUrls = Array.from(new Set(urls.map(normalizeUrl)));
  await fs.writeFile(TRACKER_FILE_PATH, JSON.stringify(uniqueUrls, null, 2), 'utf-8');
}

/**
 * Records newly uploaded CDN URLs into the tracker file.
 */
export async function recordTrackedCdnUrls(newUrls: string[]): Promise<string[]> {
  if (newUrls.length === 0) return await getTrackedCdnUrls();

  const current = await getTrackedCdnUrls();
  const merged = Array.from(new Set([...current, ...newUrls.map(normalizeUrl)]));
  await saveTrackedCdnUrls(merged);
  return merged;
}

/**
 * Removes specified URLs from the tracker file.
 */
export async function removeTrackedCdnUrls(urlsToRemove: string[]): Promise<string[]> {
  if (urlsToRemove.length === 0) return await getTrackedCdnUrls();

  const removeSet = new Set(urlsToRemove.map(normalizeUrl));
  const current = await getTrackedCdnUrls();
  const remaining = current.filter((u) => !removeSet.has(normalizeUrl(u)));
  await saveTrackedCdnUrls(remaining);
  return remaining;
}

/**
 * Clears all tracked URLs from the file.
 */
export async function clearTrackedCdnUrls(): Promise<void> {
  await saveTrackedCdnUrls([]);
}
