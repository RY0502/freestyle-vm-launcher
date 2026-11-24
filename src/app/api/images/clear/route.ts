import { NextResponse } from "next/server";
import { clearExistingInputFiles } from "@/lib/convexStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const deletedPaths = await clearExistingInputFiles();
    return NextResponse.json({
      success: true,
      message:
        deletedPaths.length > 0
          ? `Successfully deleted ${deletedPaths.length} image${deletedPaths.length === 1 ? "" : "s"} from Convex storage.`
          : "Convex storage is already clean. No images found in input directory.",
      deletedCount: deletedPaths.length,
      deletedPaths,
    });
  } catch (error) {
    console.error("Failed to clear Convex images:", error);
    const message =
      error instanceof Error ? error.message : "Failed to clear Convex images.";
    return NextResponse.json(
      {
        success: false,
        message,
      },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  return POST();
}
