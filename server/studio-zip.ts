import { SITE_EXPORT_MAX_BYTES } from "../shared/studio-export";
export const EXPORT_FILE_NAMES = [
  ".node-version",
  "README.md",
  "index.html",
  "manifest.json",
  "package-lock.json",
  "package.json",
  "scripts/serve.mjs",
  "scripts/verify.mjs",
  "styles.css",
] as const;
export const MAX_EXPORT_FILE_BYTES = 1024 * 1024;
export function validateExportName(name: string) {
  if (
    !EXPORT_FILE_NAMES.includes(name as (typeof EXPORT_FILE_NAMES)[number]) ||
    name.includes("\\") ||
    name.includes("..") ||
    name.startsWith("/")
  )
    throw new Error("Invalid controlled export filename");
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
// Minimal ZIP STORE writer: fixed UTC-independent DOS date, ASCII allowlist,
// no compression, extras, comments, symlinks, executable bits or input ZIPs.
export function createSiteZip(
  files: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  if (
    files.size !== EXPORT_FILE_NAMES.length ||
    EXPORT_FILE_NAMES.some((name) => !files.has(name))
  )
    throw new Error("Incomplete controlled export");
  const encoder = new TextEncoder(),
    entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let size = 22;
  for (const [name, data] of entries) {
    validateExportName(name);
    if (data.byteLength > MAX_EXPORT_FILE_BYTES)
      throw new Error("Export file limit");
    size += 76 + 2 * encoder.encode(name).length + data.byteLength;
  }
  if (size > SITE_EXPORT_MAX_BYTES) throw new Error("Export archive limit");
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer),
    central: {
      name: Uint8Array;
      data: Uint8Array;
      crc: number;
      offset: number;
    }[] = [];
  let offset = 0;
  const u16 = (n: number) => {
    view.setUint16(offset, n, true);
    offset += 2;
  };
  const u32 = (n: number) => {
    view.setUint32(offset, n >>> 0, true);
    offset += 4;
  };
  for (const [path, data] of entries) {
    const name = encoder.encode(path),
      crc = crc32(data);
    central.push({ name, data, crc, offset });
    u32(0x04034b50);
    u16(20);
    u16(0x800);
    u16(0);
    u16(0);
    u16(0x21);
    u32(crc);
    u32(data.length);
    u32(data.length);
    u16(name.length);
    u16(0);
    bytes.set(name, offset);
    offset += name.length;
    bytes.set(data, offset);
    offset += data.length;
  }
  const centralOffset = offset;
  for (const e of central) {
    u32(0x02014b50);
    u16(0x0314);
    u16(20);
    u16(0x800);
    u16(0);
    u16(0);
    u16(0x21);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(0o100644 * 65536);
    u32(e.offset);
    bytes.set(e.name, offset);
    offset += e.name.length;
  }
  const centralLength = offset - centralOffset;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(central.length);
  u16(central.length);
  u32(centralLength);
  u32(centralOffset);
  u16(0);
  if (offset !== size) throw new Error("Archive length mismatch");
  return bytes;
}
