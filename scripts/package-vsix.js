"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");
const outFile = path.join(dist, `${manifest.name}-${manifest.version}.vsix`);

// code-server가 읽을 수 있는 VSIX 메타데이터를 package.json에서 생성합니다.
const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(manifest.name)}" Version="${escapeXml(manifest.version)}" Publisher="${escapeXml(manifest.publisher)}" />
    <DisplayName>${escapeXml(manifest.displayName || manifest.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(manifest.description || "")}</Description>
    <Tags>${escapeXml((manifest.categories || []).join(","))}</Tags>
    <Categories>${escapeXml((manifest.categories || []).join(","))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="xml" ContentType="text/xml" />
</Types>
`;

// VSIX 내부에서는 확장 파일들이 extension/ 디렉터리 아래에 들어갑니다.
const files = [
  ["[Content_Types].xml", Buffer.from(contentTypesXml)],
  ["extension.vsixmanifest", Buffer.from(manifestXml)],
  ["extension/package.json", fs.readFileSync(path.join(root, "package.json"))],
  ["extension/extension.js", fs.readFileSync(path.join(root, "extension.js"))],
  ["extension/README.md", fs.readFileSync(path.join(root, "README.md"))],
  ["extension/.vscodeignore", fs.readFileSync(path.join(root, ".vscodeignore"))]
];

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(outFile, createZip(files));
console.log(`Created ${path.relative(root, outFile)}`);

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, data] of entries) {
    // Node 표준 라이브러리만으로 설치 가능한 VSIX(zip) 파일을 만듭니다.
    const nameBuffer = Buffer.from(name.replace(/\\/g, "/"));
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const { dosDate, dosTime } = toDosDateTime(new Date());

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localFiles = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localFiles.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localFiles, centralDirectory, end]);
}

function crc32(buffer) {
  // ZIP 헤더에는 각 파일의 CRC32가 필요합니다.
  const table = getCrcTable();
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function getCrcTable() {
  if (!getCrcTable.cache) {
    getCrcTable.cache = Array.from({ length: 256 }, (_, index) => {
      let value = index;

      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }

      return value >>> 0;
    });
  }

  return getCrcTable.cache;
}

function toDosDateTime(date) {
  // ZIP 포맷은 수정 시간을 DOS date/time 비트 필드로 저장합니다.
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function escapeXml(value) {
  // package.json 값이 XML을 깨뜨리지 않도록 특수문자를 이스케이프합니다.
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
