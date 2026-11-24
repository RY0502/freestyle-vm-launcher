import { spawnSync } from "node:child_process";

export type SupportedImageFormat = "jpeg" | "png" | "webp";
export type DetectedImageFormat =
  | SupportedImageFormat
  | "gif"
  | "bmp"
  | "tiff"
  | "avif"
  | "heic"
  | "mpo"
  | "unknown";

export interface ImageProcessingOptions {
  ffmpegPath?: string;
}

/**
 * Detects the image format using magic bytes first, falling back to the filename extension.
 */
export function detectImageFormat(
  buffer: Buffer,
  filename?: string,
): DetectedImageFormat {
  if (buffer && buffer.length >= 4) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return "png";
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "jpeg";
    }

    // WebP: RIFF....WEBP
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "webp";
    }

    // GIF: GIF87a or GIF89a
    if (
      buffer.length >= 6 &&
      (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
        buffer.subarray(0, 6).toString("ascii") === "GIF89a")
    ) {
      return "gif";
    }

    // BMP: BM (42 4D)
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return "bmp";
    }

    // TIFF: II*\0 (little-endian) or MM\0* (big-endian)
    if (
      (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
    ) {
      return "tiff";
    }

    // ISO base media file format boxes (AVIF / HEIC / HEIF)
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
      const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
      if (brand.startsWith("avif") || brand.startsWith("avis")) {
        return "avif";
      }
      if (
        brand.startsWith("heic") ||
        brand.startsWith("heix") ||
        brand.startsWith("mif1") ||
        brand.startsWith("msf1")
      ) {
        return "heic";
      }
    }
  }

  // Fallback to filename extension
  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "png":
        return "png";
      case "jpg":
      case "jpeg":
        return "jpeg";
      case "webp":
        return "webp";
      case "gif":
        return "gif";
      case "bmp":
        return "bmp";
      case "tif":
      case "tiff":
        return "tiff";
      case "avif":
        return "avif";
      case "heic":
      case "heif":
        return "heic";
      case "mpo":
        return "mpo";
    }
  }

  return "unknown";
}

/**
 * Returns true if the image format is supported directly by video generation APIs
 * (JPEG, PNG, WebP are used as-is).
 */
export function isSupportedAsIs(format: DetectedImageFormat): boolean {
  return format === "jpeg" || format === "png" || format === "webp";
}

/**
 * Losslessly converts an image buffer to 24-bit/32-bit PNG using FFmpeg.
 * - For animated or multi-frame formats (like GIF), extracts the first frame losslessly (-vframes 1).
 * - Never quantizes colors or reduces palette (avoids quality loss from 256-color palette dithering).
 * - Full original resolution and color depth are preserved.
 */
export function convertToLosslessPng(
  buffer: Buffer,
  options?: ImageProcessingOptions,
): Buffer {
  const ffmpegPath = options?.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";

  try {
    const result = spawnSync(
      /*turbopackIgnore: true*/ ffmpegPath,
      [
        "-y",
        "-i", "pipe:0",
        "-vframes", "1",
        "-c:v", "png",
        "-f", "image2",
        "pipe:1",
      ],
      {
        input: buffer,
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true,
      },
    );

    if (
      result.status === 0 &&
      result.stdout &&
      result.stdout.length > 0
    ) {
      return result.stdout;
    }

    const stderr = result.stderr ? result.stderr.toString() : "";
    console.warn(`[imageCompressor] Lossless PNG conversion failed (code ${result.status}): ${stderr}`);
  } catch (err) {
    console.warn(`[imageCompressor] Lossless PNG conversion error: ${(err as Error).message}`);
  }

  return buffer;
}

export interface EnsureSupportedImageResult {
  buffer: Buffer;
  contentType: string;
  extension: string;
  converted: boolean;
  detectedFormat: DetectedImageFormat;
}

/**
 * Ensures that an image buffer is in a format accepted by downstream video agents (JPEG, PNG, WebP).
 *
 * Rules:
 * 1. JPEG, PNG, and WebP are used AS-IS without re-encoding to prevent any quality loss.
 * 2. Unsupported formats (GIF, AVIF, HEIC, HEIF, BMP, TIFF, MPO, etc.) are converted to lossless PNG.
 * 3. File extension and MIME type are updated accordingly.
 */
export function ensureSupportedImage(
  buffer: Buffer,
  filename?: string,
  options?: ImageProcessingOptions,
): EnsureSupportedImageResult {
  const detectedFormat = detectImageFormat(buffer, filename);

  if (isSupportedAsIs(detectedFormat)) {
    const contentType =
      detectedFormat === "jpeg"
        ? "image/jpeg"
        : detectedFormat === "png"
        ? "image/png"
        : "image/webp";
    const extension = detectedFormat === "jpeg" ? "jpg" : detectedFormat;

    return {
      buffer,
      contentType,
      extension,
      converted: false,
      detectedFormat,
    };
  }

  // Format is unsupported by downstream video agents (e.g. GIF, AVIF, HEIC, BMP, TIFF)
  // Convert losslessly to PNG
  const convertedBuffer = convertToLosslessPng(buffer, options);
  const conversionSucceeded =
    convertedBuffer !== buffer &&
    convertedBuffer.length >= 8 &&
    convertedBuffer[0] === 0x89 &&
    convertedBuffer[1] === 0x50;

  if (conversionSucceeded) {
    return {
      buffer: convertedBuffer,
      contentType: "image/png",
      extension: "png",
      converted: true,
      detectedFormat,
    };
  }

  // Fallback: if conversion failed, retain original buffer
  return {
    buffer,
    contentType: "image/png",
    extension: "png",
    converted: false,
    detectedFormat,
  };
}

export interface CompressImageOptions extends ImageProcessingOptions {
  maxDimension?: number;
  maxBytesThreshold?: number;
}

/**
 * Backward compatibility wrapper.
 * Ensures the image is in a supported format without lossy 256-color palette degradation.
 */
export function compressImage(
  buffer: Buffer,
  options?: CompressImageOptions,
): Buffer {
  if (!buffer || buffer.length === 0) {
    return buffer;
  }
  const result = ensureSupportedImage(buffer, undefined, options);
  return result.buffer;
}

/** Alias for compatibility with content-generator-video */
export const compressPortraitImage = compressImage;
