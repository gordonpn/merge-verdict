import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractZipEntryText } from "../../src/collector/zip.js";

function createZipArchive(
  entries: readonly {
    readonly name: string;
    readonly content: Buffer;
    readonly compressionMethod?: number;
    readonly declaredSize?: number;
    readonly flags?: number;
  }[],
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.compressionMethod ?? 8;
    const flags = entry.flags ?? 0;
    const payload = method === 8 ? deflateRawSync(entry.content) : entry.content;
    const nameBytes = Buffer.from(entry.name, "utf8");
    const declaredUncompressed = entry.declaredSize ?? entry.content.length;

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(declaredUncompressed, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(declaredUncompressed, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    nameBytes.copy(centralHeader, 46);

    localParts.push(localHeader, payload);
    centralParts.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const endOfCentral = Buffer.alloc(22);
  endOfCentral.writeUInt32LE(0x06054b50, 0);
  endOfCentral.writeUInt16LE(entries.length, 8);
  endOfCentral.writeUInt16LE(entries.length, 10);
  endOfCentral.writeUInt32LE(centralDir.length, 12);
  endOfCentral.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDir, endOfCentral]);
}

function createSingleEntryZip(
  entryName: string,
  content: Buffer,
  options: {
    readonly compressionMethod?: number;
    readonly declaredSize?: number;
    readonly flags?: number;
  } = {},
): Buffer {
  return createZipArchive([{ name: entryName, content, ...options }]);
}

describe("extractZipEntryText", () => {
  it.each([0, 8] as const)("reads stored and deflated UTF-8 entries (method %s)", (method) => {
    const zip = createSingleEntryZip(
      "pr-agent-provenance.json",
      Buffer.from('{"ok":true}\n', "utf8"),
      { compressionMethod: method },
    );

    expect(extractZipEntryText(zip, "pr-agent-provenance.json", 4096)).toBe('{"ok":true}\n');
  });

  it("finds the target entry in multi-entry archives and rejects truncated headers", () => {
    const multi = createZipArchive([
      { name: "first.txt", content: Buffer.from("skip", "utf8") },
      { name: "pr-agent-provenance.json", content: Buffer.from('{"multi":true}', "utf8") },
    ]);
    expect(extractZipEntryText(multi, "pr-agent-provenance.json", 4096)).toBe('{"multi":true}');

    const badLocal = createSingleEntryZip("pr-agent-provenance.json", Buffer.from("{}", "utf8"));
    badLocal.writeUInt32LE(0x11111111, 0);
    expect(extractZipEntryText(badLocal, "pr-agent-provenance.json", 4096)).toBeNull();

    const badCentralDirOffset = createSingleEntryZip(
      "pr-agent-provenance.json",
      Buffer.from("{}", "utf8"),
    );
    const eocdOffset = badCentralDirOffset.length - 22;
    badCentralDirOffset.writeUInt32LE(eocdOffset + 5, eocdOffset + 16);
    expect(extractZipEntryText(badCentralDirOffset, "pr-agent-provenance.json", 4096)).toBeNull();

    const truncatedCentral = createSingleEntryZip(
      "pr-agent-provenance.json",
      Buffer.from("{}", "utf8"),
    );
    truncatedCentral.writeUInt32LE(0x22222222, truncatedCentral.length - 22 - (46 + 24));
    expect(extractZipEntryText(truncatedCentral, "pr-agent-provenance.json", 4096)).toBeNull();

    const badDataEnd = createSingleEntryZip("pr-agent-provenance.json", Buffer.from("{}", "utf8"), {
      compressionMethod: 0,
    });
    const cdOffset = badDataEnd.readUInt32LE(badDataEnd.length - 22 + 16);
    badDataEnd.writeUInt32LE(10_000, cdOffset + 20);
    expect(extractZipEntryText(badDataEnd, "pr-agent-provenance.json", 4096)).toBeNull();
  });

  it("returns null when the requested entry is absent or archive is invalid", () => {
    const zip = createSingleEntryZip("other.json", Buffer.from("{}", "utf8"));

    expect(extractZipEntryText(zip, "pr-agent-provenance.json", 4096)).toBeNull();
    expect(
      extractZipEntryText(Buffer.from("not-a-zip"), "pr-agent-provenance.json", 4096),
    ).toBeNull();
  });

  it("rejects entries exceeding the uncompressed size limit", () => {
    const payload = Buffer.from("a".repeat(256), "utf8");
    const zip = createSingleEntryZip("pr-agent-provenance.json", payload, {
      compressionMethod: 8,
    });

    expect(extractZipEntryText(zip, "pr-agent-provenance.json", 64)).toBeNull();
  });

  it("rejects invalid limits, encrypted entries, corrupt deflate payloads, and unsupported methods", () => {
    const valid = createSingleEntryZip("pr-agent-provenance.json", Buffer.from("{}", "utf8"));
    const encrypted = createSingleEntryZip("pr-agent-provenance.json", Buffer.from("{}", "utf8"), {
      flags: 0x0001,
    });
    const unsupported = createSingleEntryZip(
      "pr-agent-provenance.json",
      Buffer.from("{}", "utf8"),
      {
        compressionMethod: 14,
      },
    );
    const largeWithoutEocd = Buffer.alloc(40);
    const corruptedDeflate = createSingleEntryZip(
      "pr-agent-provenance.json",
      Buffer.from("invalid".repeat(20), "utf8"),
    );
    const payloadOffset =
      corruptedDeflate.indexOf("pr-agent-provenance.json") + "pr-agent-provenance.json".length;
    corruptedDeflate.fill(0xff, payloadOffset, payloadOffset + 4);

    expect(extractZipEntryText(valid, "pr-agent-provenance.json", 0)).toBeNull();
    expect(extractZipEntryText(largeWithoutEocd, "pr-agent-provenance.json", 4096)).toBeNull();
    expect(extractZipEntryText(encrypted, "pr-agent-provenance.json", 4096)).toBeNull();
    expect(extractZipEntryText(unsupported, "pr-agent-provenance.json", 4096)).toBeNull();
    expect(extractZipEntryText(corruptedDeflate, "pr-agent-provenance.json", 4096)).toBeNull();
  });
});
