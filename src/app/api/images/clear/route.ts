import { NextResponse } from "next/server";
import { clearExistingInputFiles, listProjectConvexFiles } from "@/lib/convexStorage";
import { purgeCdnUrls } from "@/lib/cdnPurge";
import { getTrackedCdnUrls, removeTrackedCdnUrls } from "@/lib/cdnTracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ConvexDeleteStatus {
  success: boolean;
  deletedCount: number;
  deletedPaths: string[];
  error?: string;
}

export interface CdnPurgeStatus {
  success: boolean;
  purgedCount: number;
  failedCount: number;
  purgedUrls: string[];
  error?: string;
}

export interface ClearImagesResponse {
  success: boolean;
  message: string;
  convex: ConvexDeleteStatus;
  cdn: CdnPurgeStatus;
}

export async function POST(): Promise<NextResponse<ClearImagesResponse>> {
  // 1. Gather all project CDN URLs to purge:
  // First, query active project files from Convex (bucket: 'shared', prefix: 'input/')
  const currentProjectFiles = await listProjectConvexFiles().catch((err) => {
    console.warn("[clearApi] Could not pre-list Convex project files:", err);
    return [];
  });
  const currentConvexUrls = currentProjectFiles.map((f) => f.url).filter(Boolean);

  // Second, retrieve historically tracked project CDN URLs (including files deleted previously from Convex)
  const trackedHistoricalUrls = await getTrackedCdnUrls().catch((err) => {
    console.warn("[clearApi] Could not read tracked historical CDN URLs:", err);
    return [];
  });

  // Combine and deduplicate all CDN URLs belonging to this project
  const allProjectCdnUrls = Array.from(
    new Set([...currentConvexUrls, ...trackedHistoricalUrls])
  );

  // 2. Step 1: Delete assets from Convex (this project only, bucket: 'shared', prefix: 'input/')
  // Wrapped in try/catch so a failure in Convex deletion does not block CDN purge
  let convexStatus: ConvexDeleteStatus = {
    success: false,
    deletedCount: 0,
    deletedPaths: [],
  };

  try {
    const deletedPaths = await clearExistingInputFiles();
    convexStatus = {
      success: true,
      deletedCount: deletedPaths.length,
      deletedPaths,
    };
  } catch (err) {
    console.error("[clearApi] Error deleting files from Convex:", err);
    convexStatus = {
      success: false,
      deletedCount: 0,
      deletedPaths: [],
      error: (err as Error).message || "Failed to delete files from Convex",
    };
  }

  // 3. Step 2: Purge/invalidate cached project assets from Cloudflare CDN
  // Wrapped in try/catch so a failure in CDN purge does not compromise Convex deletion status
  let cdnStatus: CdnPurgeStatus = {
    success: false,
    purgedCount: 0,
    failedCount: 0,
    purgedUrls: [],
  };

  try {
    const purgeResult = await purgeCdnUrls(allProjectCdnUrls);
    cdnStatus = {
      success: purgeResult.success,
      purgedCount: purgeResult.purgedCount,
      failedCount: purgeResult.failedCount,
      purgedUrls: purgeResult.purgedUrls,
      error:
        purgeResult.errors.length > 0 ? purgeResult.errors.join("; ") : undefined,
    };

    // Prune successfully purged URLs from persistent tracking
    if (purgeResult.purgedUrls.length > 0) {
      await removeTrackedCdnUrls(purgeResult.purgedUrls).catch((e) => {
        console.warn("[clearApi] Could not prune tracked URLs:", e);
      });
    }
  } catch (err) {
    console.error("[clearApi] Error purging CDN URLs:", err);
    cdnStatus = {
      success: false,
      purgedCount: 0,
      failedCount: allProjectCdnUrls.length,
      purgedUrls: [],
      error: (err as Error).message || "Failed to purge files from Cloudflare CDN",
    };
  }

  // 4. Construct informative composite user message
  const parts: string[] = [];

  if (convexStatus.success) {
    if (convexStatus.deletedCount > 0) {
      parts.push(
        `Deleted ${convexStatus.deletedCount} image${convexStatus.deletedCount === 1 ? "" : "s"} from Convex`
      );
    } else {
      parts.push("Convex had no active images");
    }
  } else {
    parts.push(`Convex deletion encountered an issue (${convexStatus.error})`);
  }

  if (cdnStatus.success || cdnStatus.purgedCount > 0) {
    if (cdnStatus.purgedCount > 0) {
      parts.push(
        `purged ${cdnStatus.purgedCount} cached file${cdnStatus.purgedCount === 1 ? "" : "s"} from Cloudflare CDN`
      );
    } else {
      parts.push("Cloudflare CDN cache was clean");
    }
  } else if (cdnStatus.error) {
    parts.push(`CDN purge encountered an issue (${cdnStatus.error})`);
  }

  const overallSuccess =
    (convexStatus.success && (cdnStatus.success || allProjectCdnUrls.length === 0)) ||
    (convexStatus.success && !cdnStatus.error) ||
    (cdnStatus.success && !convexStatus.error);

  const message = `${parts.join(" and ")}.`;
  const statusCode = !convexStatus.success && !cdnStatus.success ? 500 : 200;

  return NextResponse.json(
    {
      success: overallSuccess,
      message,
      convex: convexStatus,
      cdn: cdnStatus,
    },
    { status: statusCode }
  );
}

export async function DELETE(): Promise<NextResponse<ClearImagesResponse>> {
  return POST();
}
