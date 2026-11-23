// Image fixtures for the admin integration tests, built here (no binary is committed; sharp is the uploads package's).
import { crc32, deflateSync } from "node:zlib";

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

/** A solid-colour RGB PNG of `width` x `height`. */
export function solidPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x40)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The pixel size of a WebP (lossy VP8, lossless VP8L or extended VP8X), read from its header. */
export function webpSize(bytes: Uint8Array): { readonly width: number; readonly height: number } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.subarray(0, 4).toString("latin1") !== "RIFF" || b.subarray(8, 12).toString("latin1") !== "WEBP") throw new Error("not a WebP");
  switch (b.subarray(12, 16).toString("latin1")) {
    case "VP8 ":
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    case "VP8L": {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    default:
      throw new Error("unknown WebP chunk");
  }
}
