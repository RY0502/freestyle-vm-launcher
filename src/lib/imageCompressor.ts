import { spawnSync } from "node:child_process";

export interface CompressImageOptions {
  maxDimension?: number;
  maxBytesThreshold?: number;
  ffmpegPath?: string;
}

/**
 * Compresses an image buffer using FFmpeg to reduce storage egress and upload size.
 * Matches the compression mechanism used in content-generator-video:
 * - Resizes to maxDimension (default: 1024x1024, keeping aspect ratio).
 * - Generates an adaptive 256-color palette with dithering to output an optimized PNG.
 * - If input is already small (< maxBytesThreshold, default 300KB) or non-image, returns original buffer.
 * - Gracefully falls back to original buffer on any error or if compressed size is larger.
 */
export function compressImage(
  buffer: Buffer,
  options?: CompressImageOptions,
): Buffer {
  const maxBytesThreshold = options?.maxBytesThreshold ?? 300 * 1024;
  if (!buffer || buffer.length <= maxBytesThreshold) {
    return buffer;
  }

  const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
  const isJpg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;
  const isWebp =
    buffer.length > 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50;

  if (!isPng && !isJpg && !isWebp) {
    return buffer;
  }

  const maxDim = options?.maxDimension ?? 1024;
  const ffmpegPath = options?.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";

  try {
    const scaleFilter = `scale=w='min(${maxDim},iw)':h='min(${maxDim},ih)':force_original_aspect_ratio=decrease`;
    const filter = `${scaleFilter},split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=floyd_steinberg`;

    const inputFormat = isPng ? "png_pipe" : isJpg ? "mjpeg" : "webp_pipe";

    const result = spawnSync(
      ffmpegPath,
      [
        "-y",
        "-f", inputFormat,
        "-i", "pipe:0",
        "-vf", filter,
        "-f", "image2",
        "-c:v", "png",
        "pipe:1",
      ],
      {
        input: buffer,
        maxBuffer: 25 * 1024 * 1024,
        windowsHide: true,
      },
    );

    if (
      result.status === 0 &&
      result.stdout &&
      result.stdout.length > 0 &&
      result.stdout.length < buffer.length
    ) {
      return result.stdout;
    }
  } catch (err) {
    console.warn(`[imageCompressor] Image compression skipped: ${(err as Error).message}`);
  }

  return buffer;
}

/** Alias for compatibility with content-generator-video */
export const compressPortraitImage = compressImage;
