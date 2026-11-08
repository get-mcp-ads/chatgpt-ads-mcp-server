/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bounded image metadata inspection. Pixels are never decoded.
 */
export type Dimensions = { width: number; height: number };

const valid = (width: number, height: number): Dimensions | undefined =>
  Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : undefined;

function exifOrientation(bytes: Uint8Array): number | undefined {
  if (bytes.length < 14 || String.fromCharCode(...bytes.subarray(0, 6)) !== "Exif\x00\x00") return;
  const data = bytes.subarray(6), v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const little = data[0] === 73 && data[1] === 73;
  if (!little && !(data[0] === 77 && data[1] === 77)) return;
  try {
    if (v.getUint16(2, little) !== 42) return;
    const offset = v.getUint32(4, little), count = v.getUint16(offset, little);
    if (count > 1024 || offset + 2 + 12 * count > data.length) return;
    for (let i = 0; i < count; i++) {
      const pos = offset + 2 + 12 * i;
      if (v.getUint16(pos, little) === 0x112 && v.getUint16(pos + 2, little) === 3 && v.getUint32(pos + 4, little) === 1) {
        const orientation = v.getUint16(pos + 8, little);
        return orientation >= 1 && orientation <= 8 ? orientation : undefined;
      }
    }
  } catch { return; }
}

/** Width and height read from PNG, WebP or JPEG headers, or undefined when the bytes do not match the MIME type. */
export function imageDimensions(bytes: Uint8Array, mime: string): Dimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = (offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size));
  try {
    if (mime === "image/png" && text(12, 4) === "IHDR") return valid(view.getUint32(16), view.getUint32(20));
    if (mime === "image/webp" && text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
      const n24 = (i: number) => bytes[i] + bytes[i + 1] * 256 + bytes[i + 2] * 65536;
      if (text(12, 4) === "VP8X") return valid(1 + n24(24), 1 + n24(27));
      if (text(12, 4) === "VP8 " && text(23, 3) === "\x9d\x01\x2a") return valid(view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383);
      if (text(12, 4) === "VP8L" && bytes[20] === 47) { const n = view.getUint32(21, true); return valid((n & 16383) + 1, ((n >>> 14) & 16383) + 1); }
    }
    if (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
      let orientation: number | undefined;
      for (let i = 2; i + 4 <= bytes.length;) {
        if (bytes[i++] !== 255) return;
        while (bytes[i] === 255) i++;
        const marker = bytes[i++];
        if (marker === 0xd9 || marker === 0xda) return;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
        const size = view.getUint16(i);
        if (size < 2 || i + size > bytes.length) return;
        if (marker === 0xe1) orientation = exifOrientation(bytes.subarray(i + 2, i + size)) ?? orientation;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          const width = view.getUint16(i + 5), height = view.getUint16(i + 3);
          return orientation && orientation >= 5 ? valid(height, width) : valid(width, height);
        }
        i += size;
      }
    }
  } catch { return; }
}
