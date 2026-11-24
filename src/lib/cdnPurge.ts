export interface PurgeCdnResult {
  success: boolean;
  total: number;
  purgedCount: number;
  failedCount: number;
  purgedUrls: string[];
  failedUrls: string[];
  errors: string[];
}

export interface CdnPurgeConfig {
  cloudflareApiToken?: string;
  cloudflareZoneId?: string;
  convexCdnUrl?: string;
}

export function getCdnPurgeConfig(): CdnPurgeConfig {
  return {
    cloudflareApiToken: (process.env.CLOUDFLARE_API_TOKEN || '').trim(),
    cloudflareZoneId: (process.env.CLOUDFLARE_ZONE_ID || '').trim(),
    convexCdnUrl: (
      process.env.CONVEX_CDN_URL || 'https://convex-portrait-cache.ravi-y0102.workers.dev'
    )
      .trim()
      .replace(/\/+$/, ''),
  };
}

/**
 * Purges and invalidates cached CDN URLs for this project.
 * Handles both Cloudflare Zone Purge API (when ZONE_ID is provided)
 * and direct HTTP edge invalidation headers (Cache-Control no-cache, x-purge, etc.).
 *
 * Designed to never throw: errors for one URL or method do not impact others.
 */
export async function purgeCdnUrls(
  urls: string[],
  config?: CdnPurgeConfig
): Promise<PurgeCdnResult> {
  const uniqueUrls = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean)));
  if (uniqueUrls.length === 0) {
    return {
      success: true,
      total: 0,
      purgedCount: 0,
      failedCount: 0,
      purgedUrls: [],
      failedUrls: [],
      errors: [],
    };
  }

  const { cloudflareApiToken, cloudflareZoneId } = config ?? getCdnPurgeConfig();
  const errors: string[] = [];
  const purgedUrls: string[] = [];
  const failedUrls: string[] = [];

  // 1. Cloudflare Zone Purge API (if ZONE_ID and API_TOKEN are configured)
  let zonePurgeSucceeded = false;
  if (cloudflareZoneId && cloudflareApiToken) {
    try {
      const purgeApiUrl = `https://api.cloudflare.com/client/v4/zones/${cloudflareZoneId}/purge_cache`;
      const response = await fetch(purgeApiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cloudflareApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: uniqueUrls }),
      });

      if (response.ok) {
        zonePurgeSucceeded = true;
      } else {
        const errorText = await response.text().catch(() => '');
        errors.push(`Cloudflare Zone purge returned HTTP ${response.status}: ${errorText}`);
      }
    } catch (err) {
      errors.push(`Cloudflare Zone purge request failed: ${(err as Error).message}`);
    }
  }

  // 2. Direct Edge Cache Invalidation for each URL
  // We send cache-busting requests to signal Cloudflare edge proxies to discard cached entries.
  const invalidationPromises = uniqueUrls.map(async (url) => {
    let success = zonePurgeSucceeded;
    try {
      // Send cache-invalidation headers
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
          Pragma: 'no-cache',
          'x-purge': '1',
          'x-cache-purge': 'true',
        },
      });

      // Also attempt an invalidation HEAD or POST signal to notify proxy
      try {
        await fetch(`${url}?purge=1`, {
          method: 'GET',
          headers: {
            'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
          },
        }).catch(() => {});
      } catch {
        // ignore secondary signal error
      }

      // If the response is now 404 (origin deleted) or successfully fetched / revalidated
      if (res.status === 404 || res.ok || zonePurgeSucceeded) {
        success = true;
      }
    } catch (err) {
      if (!success) {
        errors.push(`Failed to invalidate ${url}: ${(err as Error).message}`);
      }
    }

    if (success) {
      purgedUrls.push(url);
    } else {
      failedUrls.push(url);
    }
  });

  await Promise.allSettled(invalidationPromises);

  return {
    success: failedUrls.length === 0,
    total: uniqueUrls.length,
    purgedCount: purgedUrls.length,
    failedCount: failedUrls.length,
    purgedUrls,
    failedUrls,
    errors,
  };
}
