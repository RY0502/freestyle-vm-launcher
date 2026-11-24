import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeImageFileName,
  extractFileNameFromConvexPath,
  formatReferenceUrls,
  ensureSupportedImage,
  convertToLosslessPng,
} from "../src/lib/convexStorage";
import {
  detectImageFormat,
  isSupportedAsIs,
} from "../src/lib/imageCompressor";

test("sanitizeImageFileName converts underscores to hyphens", () => {
  assert.equal(sanitizeImageFileName("my_image_name.png"), "my-image-name.png");
  assert.equal(sanitizeImageFileName("IMG_2026_01_01_123456.jpg"), "img-2026-01-01-123456.jpg");
  assert.equal(sanitizeImageFileName("scene_1_character_portrait.webp"), "scene-1-character-portrait.webp");
});

test("sanitizeImageFileName collapses multiple consecutive underscores and hyphens", () => {
  assert.equal(sanitizeImageFileName("my___image____file.png"), "my-image-file.png");
  assert.equal(sanitizeImageFileName("my--image__mixed---file.png"), "my-image-mixed-file.png");
});

test("sanitizeImageFileName trims leading and trailing underscores and hyphens", () => {
  assert.equal(sanitizeImageFileName("_my_image_.png"), "my-image.png");
  assert.equal(sanitizeImageFileName("---my_image---.jpg"), "my-image.jpg");
  assert.equal(sanitizeImageFileName("___photo___.png"), "photo.png");
});

test("sanitizeImageFileName converts spaces and special characters to hyphens", () => {
  assert.equal(sanitizeImageFileName("my image (1) #final.PNG"), "my-image-1-final.png");
  assert.equal(sanitizeImageFileName("cat & dog [approved]!.jpg"), "cat-dog-approved.jpg");
  assert.equal(sanitizeImageFileName("character @ 2x version = 3.webp"), "character-2x-version-3.webp");
});

test("sanitizeImageFileName converts dots in the stem to hyphens", () => {
  assert.equal(sanitizeImageFileName("my.photo.v1.0.png"), "my-photo-v1-0.png");
  assert.equal(sanitizeImageFileName("version.2.5.final.jpg"), "version-2-5-final.jpg");
});

test("sanitizeImageFileName converts uppercase to lowercase", () => {
  assert.equal(sanitizeImageFileName("MY_PHOTO.JPEG"), "my-photo.jpeg");
  assert.equal(sanitizeImageFileName("SCREENSHOT_FINAL.PNG"), "screenshot-final.png");
  assert.equal(sanitizeImageFileName("AVATAR.WEBP"), "avatar.webp");
});

test("sanitizeImageFileName normalizes unicode accents / diacritics", () => {
  assert.equal(sanitizeImageFileName("Café_Mélodie_1.png"), "cafe-melodie-1.png");
  assert.equal(sanitizeImageFileName("über_schön.jpg"), "uber-schon.jpg");
});

test("sanitizeImageFileName handles edge cases and fallbacks", () => {
  assert.equal(sanitizeImageFileName("", 1), "image-1.png");
  assert.equal(sanitizeImageFileName("   ", 2), "image-2.png");
  assert.equal(sanitizeImageFileName("___", 3), "image-3.png");
  assert.equal(sanitizeImageFileName("...", 4), "image-4.png");
  assert.equal(sanitizeImageFileName(".png", 5), "image-5.png");
  assert.equal(sanitizeImageFileName("no_extension", 1), "no-extension.png");
  assert.equal(sanitizeImageFileName("unsupported.exe", 1), "unsupported.png");
});

test("sanitizeImageFileName supports all common image extensions", () => {
  assert.equal(sanitizeImageFileName("photo.png"), "photo.png");
  assert.equal(sanitizeImageFileName("photo.jpg"), "photo.jpg");
  assert.equal(sanitizeImageFileName("photo.jpeg"), "photo.jpeg");
  assert.equal(sanitizeImageFileName("photo.webp"), "photo.webp");
  assert.equal(sanitizeImageFileName("photo.gif"), "photo.gif");
  assert.equal(sanitizeImageFileName("photo.bmp"), "photo.bmp");
  assert.equal(sanitizeImageFileName("photo.avif"), "photo.avif");
  assert.equal(sanitizeImageFileName("photo.heic"), "photo.heic");
  assert.equal(sanitizeImageFileName("photo.heif"), "photo.heif");
});

test("extractFileNameFromConvexPath extracts clean name from path with index prefix", () => {
  assert.equal(extractFileNameFromConvexPath("input/1_my-image.png"), "my-image.png");
  assert.equal(extractFileNameFromConvexPath("input/5_photo-2026.jpg"), "photo-2026.jpg");
  assert.equal(extractFileNameFromConvexPath("shared/input/12_scene-bg.webp"), "scene-bg.webp");
  assert.equal(extractFileNameFromConvexPath("1_simple.png"), "simple.png");
  assert.equal(extractFileNameFromConvexPath("no-prefix.png"), "no-prefix.png");
});

test("targetFileName with sanitized name contains exactly one underscore for prefix", () => {
  const originalNames = [
    "my_image_1.png",
    "photo_v2_final.jpg",
    "cat_dog_mouse_bird.webp",
    "IMG_2026_01_01_999999.JPG",
  ];

  originalNames.forEach((orig, idx) => {
    const sanitized = sanitizeImageFileName(orig, idx + 1);
    const targetFileName = `${idx + 1}_${sanitized}`;

    // Splitting by '_' should cleanly yield [index, sanitizedName] with no extra splits
    const parts = targetFileName.split('_');
    assert.equal(parts.length, 2, `targetFileName "${targetFileName}" should have exactly 2 parts when split on '_'`);
    assert.equal(parts[0], String(idx + 1));
    assert.equal(parts[1], sanitized);
    assert.match(parts[1], /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?|mpo)$/);
  });
});

test("formatReferenceUrls formats URLs correctly", () => {
  assert.equal(formatReferenceUrls([]), "");
  assert.equal(
    formatReferenceUrls(["https://example.com/1.png", "https://example.com/2.png"]),
    "Reference urls:\nhttps://example.com/1.png\nhttps://example.com/2.png",
  );
});

test("detectImageFormat accurately detects formats from magic bytes", () => {
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const webpBuf = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
  ]);
  const gifBuf = Buffer.from("GIF89a\x01\x00\x01\x00");
  const bmpBuf = Buffer.from([0x42, 0x4d, 0x00, 0x00]);
  const tiffBuf = Buffer.from([0x49, 0x49, 0x2a, 0x00]);

  assert.equal(detectImageFormat(pngBuf), "png");
  assert.equal(detectImageFormat(jpegBuf), "jpeg");
  assert.equal(detectImageFormat(webpBuf), "webp");
  assert.equal(detectImageFormat(gifBuf), "gif");
  assert.equal(detectImageFormat(bmpBuf), "bmp");
  assert.equal(detectImageFormat(tiffBuf), "tiff");
});

test("isSupportedAsIs validates JPEG, PNG, and WebP", () => {
  assert.equal(isSupportedAsIs("jpeg"), true);
  assert.equal(isSupportedAsIs("png"), true);
  assert.equal(isSupportedAsIs("webp"), true);
  assert.equal(isSupportedAsIs("gif"), false);
  assert.equal(isSupportedAsIs("bmp"), false);
  assert.equal(isSupportedAsIs("tiff"), false);
  assert.equal(isSupportedAsIs("avif"), false);
  assert.equal(isSupportedAsIs("heic"), false);
  assert.equal(isSupportedAsIs("unknown"), false);
});

test("ensureSupportedImage retains supported formats as-is with zero quality loss", () => {
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const pngRes = ensureSupportedImage(png1x1, "test.png");
  assert.equal(pngRes.converted, false);
  assert.equal(pngRes.contentType, "image/png");
  assert.equal(pngRes.extension, "png");
  assert.equal(pngRes.buffer, png1x1); // Exact same buffer, no re-encoding

  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const jpegRes = ensureSupportedImage(fakeJpeg, "test.jpg");
  assert.equal(jpegRes.converted, false);
  assert.equal(jpegRes.contentType, "image/jpeg");
  assert.equal(jpegRes.extension, "jpg");
  assert.equal(jpegRes.buffer, fakeJpeg); // Exact same buffer, zero quality loss
});

test("ensureSupportedImage converts GIF and BMP to lossless PNG", () => {
  const gif1x1 = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64"
  );
  const gifRes = ensureSupportedImage(gif1x1, "animation.gif");
  assert.equal(gifRes.converted, true);
  assert.equal(gifRes.contentType, "image/png");
  assert.equal(gifRes.extension, "png");
  // Converted buffer must be valid PNG
  assert.equal(gifRes.buffer[0], 0x89);
  assert.equal(gifRes.buffer[1], 0x50);
  assert.equal(gifRes.buffer[2], 0x4e);
  assert.equal(gifRes.buffer[3], 0x47);

  const bmp1x1 = Buffer.from(
    "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABACAAAAAAAAYAAAASCwAAEgsAAAAAAAAAAAAAAP///wA=",
    "base64"
  );
  const bmpRes = ensureSupportedImage(bmp1x1, "graphic.bmp");
  assert.equal(bmpRes.converted, true);
  assert.equal(bmpRes.contentType, "image/png");
  assert.equal(bmpRes.extension, "png");
  assert.equal(bmpRes.buffer[0], 0x89);
  assert.equal(bmpRes.buffer[1], 0x50);
  assert.equal(bmpRes.buffer[2], 0x4e);
  assert.equal(bmpRes.buffer[3], 0x47);
});
