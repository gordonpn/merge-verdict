import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractZipEntryText } from "../../src/collector/zip.js";

function createZipArchive(
  entryName: string,
  content: Buffer,
  options: {
    readonly compressionMethod?: number;
    readonly declaredSize?: number;
    readonly flags?: number;
  } = {},
): Buffer {
  const method = options.compressionMethod ?? 8;
  const flags = options.flags ?? 0;
  const payload = method === 8 ? deflateRawSync(content) : content;
  const nameBytes = Buffer.from(entryName, "utf8");
  const declaredUncompressed = options.declaredSize ?? content.length;

  const localHeader = Buffer.alloc(30 + nameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(flags, 6);
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(payload.length, 18);
  localHeader.writeUInt32LE(declaredUncompressed, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);
  nameBytes.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + nameBytes.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(flags, 8);
  centralHeader.writeUInt16LE(method, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(payload.length, 20);
  centralHeader.writeUInt32LE(declaredUncompressed, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  nameBytes.copy(centralHeader, 46);

  const centralOffset = localHeader.length + payload.length;
  const endOfCentral = Buffer.alloc(22);
  endOfCentral.writeUInt32LE(0x06054b50, 0);
  endOfCentral.writeUInt16LE(0, 4);
  endOfCentral.writeUInt16LE(0, 6);
  endOfCentral.writeUInt16LE(1, 8);
  endOfCentral.writeUInt16LE(1, 10);
  endOfCentral.writeUInt32LE(centralHeader.length, 12);
  endOfCentral.writeUInt32LE(centralOffset, 16);
  endOfCentral.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, payload, centralHeader, endOfCentral]);
}

describe("extractZipEntryText", () => {
  it.each([0, 8] as const)("reads stored and deflated UTF-8 entries (method %s)", (method) => {
    const zip = createZipArchive("pr-agent-provenance.json", Buffer.from('{"ok":true}\n', "utf8"), {
      compressionMethod: method,
    });

    expect(extractZipEntryText(zip, "pr-agent-provenance.json", 4096)).toBe('{"ok":true}\n');
  });

  it("returns null when the requested entry is absent or archive is invalid", () => {
    const zip = createZipArchive("other.json", Buffer.from("{}", "utf8"));

    expect(extractZipEntryText(zip, "pr-agent-provenance.json", 4096)).toBeNull();
    expect(
      extractZipEntryText(Buffer.from("not-a-zip"), "pr-agent-provenance.json", 4096),
    ).toBeNull();
  });

  it("rejects entries exceeding the uncompressed size limit", () => {
    const payload = Buffer.from("a".repeat(256), "utf8");
    const zip = createZipArchive("pr-agent-provenance.json", payload, { compressionMethod: 8 });

    expect(extractZipEntryText(zip, "pr-agent-provenance.json", 64)).toBeNull();
  });

  it("rejects invalid limits, encrypted entries, and unsupported compression methods", () => {
    const valid = createZipArchive("pr-agent-provenance.json", Buffer.from("{}", "utf8"));
    const encrypted = createZipArchive("pr-agent-provenance.json", Buffer.from("{}", "utf8"), {
      flags: 0x0001,
    });
    const unsupported = createZipArchive("pr-agent-provenance.json", Buffer.from("{}", "utf8"), {
      compressionMethod: 14,
    });

    expect(extractZipEntryText(valid, "pr-agent-provenance.json", 0)).toBeNull();
    expect(extractZipEntryText(encrypted, "pr-agent-provenance.json", 4096)).toBeNull();
    expect(extractZipEntryText(unsupported, "pr-agent-provenance.json", 4096)).toBeNull();
  });
});
