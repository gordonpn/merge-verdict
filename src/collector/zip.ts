import { inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;
const MAX_EOCD_SEARCH_BYTES = 65_557;
const MAX_CENTRAL_DIR_ENTRIES = 128;

function findEndOfCentralDirectory(archive: Buffer): number {
  const minOffset = Math.max(0, archive.length - MAX_EOCD_SEARCH_BYTES);
  for (let offset = archive.length - 22; offset >= minOffset; offset--) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIR_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/**
 * Extracts a named UTF-8 text entry from a ZIP archive with strict size bounds.
 *
 * @param data Raw ZIP archive bytes.
 * @param entryName Exact entry path to extract.
 * @param maxOutputBytes Maximum allowed uncompressed output size in bytes.
 * @returns Entry text when found and valid, or null otherwise.
 */
export function extractZipEntryText(
  data: Uint8Array,
  entryName: string,
  maxOutputBytes: number,
): string | null {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return null;
  }
  const archive = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (archive.length < 22) {
    return null;
  }

  const eocdOffset = findEndOfCentralDirectory(archive);
  if (eocdOffset < 0) {
    return null;
  }

  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = archive.readUInt32LE(eocdOffset + 16);
  if (totalEntries > MAX_CENTRAL_DIR_ENTRIES || centralDirOffset >= eocdOffset) {
    return null;
  }

  let cursor = centralDirOffset;
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > eocdOffset || archive.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
      return null;
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);

    const nameStart = cursor + 46;
    const nextCursor = nameStart + fileNameLength + extraLength + commentLength;
    if (nextCursor > eocdOffset) {
      return null;
    }

    const currentName = archive.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    cursor = nextCursor;

    if (currentName !== entryName) {
      continue;
    }
    if ((flags & 0x0009) !== 0 || uncompressedSize > maxOutputBytes) {
      return null;
    }
    if (
      localHeaderOffset + 30 > centralDirOffset ||
      archive.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE
    ) {
      return null;
    }

    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralDirOffset) {
      return null;
    }

    const compressed = archive.subarray(dataStart, dataEnd);
    if (method === 0) {
      return compressed.length > maxOutputBytes ? null : compressed.toString("utf8");
    }
    if (method === 8) {
      try {
        const inflated = inflateRawSync(compressed, { maxOutputLength: maxOutputBytes });
        return inflated.length > maxOutputBytes ? null : inflated.toString("utf8");
      } catch {
        return null;
      }
    }
    return null;
  }

  return null;
}
