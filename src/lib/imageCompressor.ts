import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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
 * Converts an image buffer to the target format (JPEG or PNG) using FFmpeg with a temporary seekable file.
 * A temporary seekable file is essential because container formats such as HEIC and AVIF cannot be decoded from streams/pipes.
 */
export function convertImageViaFfmpeg(
  buffer: Buffer,
  targetFormat: "jpeg" | "png",
  options?: ImageProcessingOptions,
): Buffer | null {
  const ffmpegPath = options?.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const inPath = path.join(tmpDir, `in_${id}.bin`);
  const outExt = targetFormat === "jpeg" ? "jpg" : "png";
  const outPath = path.join(tmpDir, `out_${id}.${outExt}`);

  try {
    fs.writeFileSync(inPath, buffer);
    const args = [
      "-y",
      "-i", inPath,
      "-vframes", "1",
      ...(targetFormat === "jpeg"
        ? ["-q:v", "1", "-qscale:v", "1"] // Maximum 100% quality JPEG (visually lossless)
        : ["-c:v", "png"]),             // Lossless 24/32-bit PNG
      "-update", "1",
      outPath,
    ];

    const result = spawnSync(/*turbopackIgnore: true*/ ffmpegPath, args, {
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    });

    if (result.status === 0 && fs.existsSync(outPath)) {
      const outBuf = fs.readFileSync(outPath);
      if (outBuf.length > 0) {
        return outBuf;
      }
    }

    const stderr = result.stderr ? result.stderr.toString() : "";
    console.warn(`[imageCompressor] FFmpeg conversion to ${targetFormat} failed (code ${result.status}): ${stderr}`);
    return null;
  } catch (err) {
    console.warn(`[imageCompressor] FFmpeg conversion error: ${(err as Error).message}`);
    return null;
  } finally {
    try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch {}
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
  }
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
  const converted = convertImageViaFfmpeg(buffer, "png", options);
  return converted ?? buffer;
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
 * 2. Camera photo formats (HEIC, HEIF, TIFF, BMP, MPO) are converted to maximum-quality JPEG (100% visual fidelity).
 *    This avoids 25-50MB uncompressed PNG sizes that exceed video API ingestion limits.
 * 3. Formats like GIF (which may contain transparency or animation) are converted to lossless PNG.
 * 4. File extension and MIME type are strictly updated to match the resulting bytes.
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

  // Determine optimal target format:
  // Upstream video APIs specify: "BMP, TIFF, HEIC, HEIF and MPO are converted to JPEG, and GIF is not supported"
  const preferJpeg =
    detectedFormat === "heic" ||
    detectedFormat === "tiff" ||
    detectedFormat === "bmp" ||
    detectedFormat === "mpo";

  const primaryTarget: "jpeg" | "png" = preferJpeg ? "jpeg" : "png";
  const fallbackTarget: "jpeg" | "png" = preferJpeg ? "png" : "jpeg";

  let convertedBuffer = convertImageViaFfmpeg(buffer, primaryTarget, options);
  let finalTarget = primaryTarget;

  if (!convertedBuffer) {
    convertedBuffer = convertImageViaFfmpeg(buffer, fallbackTarget, options);
    finalTarget = fallbackTarget;
  }

  if (convertedBuffer && convertedBuffer.length > 0) {
    const isJpeg = finalTarget === "jpeg";
    return {
      buffer: convertedBuffer,
      contentType: isJpeg ? "image/jpeg" : "image/png",
      extension: isJpeg ? "jpg" : "png",
      converted: true,
      detectedFormat,
    };
  }

  throw new Error(
    `Unsupported image format (${detectedFormat}) for "${filename || "uploaded image"}". Failed to convert to JPEG/PNG for video generation.`
  );
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
