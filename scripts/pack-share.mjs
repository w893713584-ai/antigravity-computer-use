#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { isMainModule } from "../src/constants.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const UTF8_FLAG = 0x0800; // PKZIP Bit 11: EFS UTF-8 filename & comment encoding
const VERSION_MADE_BY_UNIX = (3 << 8) | 20;
const VERSION_NEEDED = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === "function") {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return { dosDate: dosDate & 0xffff, dosTime: dosTime & 0xffff };
}

function collectTreeEntries(rootParentDir, folderName) {
  const entries = [];
  function walk(relPosix) {
    const absPath = path.join(rootParentDir, ...relPosix.split("/"));
    const st = statSync(absPath);
    if (st.isDirectory()) {
      entries.push({ relPosix: `${relPosix}/`, absPath, isDir: true, st });
      const children = readdirSync(absPath).sort();
      for (const child of children) {
        if (child === ".DS_Store") continue;
        walk(`${relPosix}/${child}`);
      }
    } else if (st.isFile()) {
      entries.push({ relPosix, absPath, isDir: false, st });
    }
  }
  walk(folderName);
  return entries;
}

function createUtf8UnixZipBuffer(rootParentDir, folderName) {
  const entries = collectTreeEntries(rootParentDir, folderName);
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.relPosix, "utf8");
    const { dosDate, dosTime } = toDosDateTime(entry.st.mtime);

    let rawData = Buffer.alloc(0);
    let compData = Buffer.alloc(0);
    let method = 0;
    let crc = 0;
    let externalAttr = 0;

    if (entry.isDir) {
      externalAttr = (((0o040755 & 0xffff) << 16) | 0x10) >>> 0;
    } else {
      rawData = readFileSync(entry.absPath);
      crc = crc32(rawData);
      if (rawData.length > 0) {
        const deflated = zlib.deflateRawSync(rawData, { level: 9 });
        if (deflated.length < rawData.length) {
          compData = deflated;
          method = 8;
        } else {
          compData = rawData;
          method = 0;
        }
      }
      const perm = entry.st.mode & 0o777;
      const unixFileMode = 0o100000 | (perm & 0o111 ? 0o755 : 0o644);
      externalAttr = ((unixFileMode & 0xffff) << 16) >>> 0;
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    centralHeader.writeUInt16LE(VERSION_NEEDED, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compData.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(externalAttr, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(centralHeader, nameBuf);
    localOffset += localHeader.length + nameBuf.length + compData.length;
  }

  const centralDirSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export function buildShareZip({
  sourceRoot = projectRoot,
  outZip = path.join(sourceRoot, "dist", "Codex风格ComputerUse一键安装包.zip"),
} = {}) {
  const folderName = "Codex风格ComputerUse一键安装包";
  const tempBase = mkdtempSync(path.join(tmpdir(), "codex-cua-pack-"));
  const bundleFolder = path.join(tempBase, folderName);

  const INCLUDE_PATHS = [
    "双击安装.command",
    "双击卸载.command",
    "使用说明.txt",
    "README.md",
    "README.en.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "src",
    "scripts",
    "test",
    "native-payloads",
  ];

  const buildNativeScript = path.join(sourceRoot, "scripts", "build-native.mjs");
  const sourceManifestPath = path.join(sourceRoot, "native-payloads", "manifest.json");
  if (process.platform === "darwin" && !existsSync(sourceManifestPath) && existsSync(buildNativeScript)) {
    execFileSync(process.execPath, [buildNativeScript, "--if-missing"], {
      cwd: sourceRoot,
      stdio: "inherit",
    });
  }

  let portablePayloadsDir = null;
  if (process.platform === "darwin" && existsSync(sourceManifestPath) && existsSync(buildNativeScript)) {
    try {
      const manifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
      if (manifest?.signingMode === "local_cert") {
        // Never ship machine-local self-signed bundles in share ZIPs; build portable ad-hoc payloads in temp dir.
        portablePayloadsDir = path.join(tempBase, "portable-payloads");
        const portableRuntimeDir = path.join(tempBase, "portable-runtime");
        execFileSync(
          process.execPath,
          [
            buildNativeScript,
            "--force",
            "--identity",
            "-",
            "--runtime-dir",
            portableRuntimeDir,
            "--payloads-dir",
            portablePayloadsDir,
            "--skip-self-check",
          ],
          {
            cwd: sourceRoot,
            env: { ...process.env, AGY_CUA_ALLOW_AUTO_LOCAL_CERT: "0" },
            stdio: "inherit",
          }
        );
      }
    } catch {}
  }

  try {
    mkdirSync(bundleFolder, { recursive: true });
    for (const rel of INCLUDE_PATHS) {
      const src =
        rel === "native-payloads" && portablePayloadsDir
          ? portablePayloadsDir
          : path.join(sourceRoot, rel);
      if (!existsSync(src)) continue;
      cpSync(src, path.join(bundleFolder, rel), { recursive: true });
    }

    chmodSync(path.join(bundleFolder, "双击安装.command"), 0o755);
    chmodSync(path.join(bundleFolder, "双击卸载.command"), 0o755);

    mkdirSync(path.dirname(outZip), { recursive: true });
    rmSync(outZip, { force: true });

    const zipBuf = createUtf8UnixZipBuffer(tempBase, folderName);
    writeFileSync(outZip, zipBuf);
    return { outZip, bytes: zipBuf.length };
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const { outZip, bytes } = buildShareZip();
  console.log(`[打包完成] ${outZip} (${(bytes / 1024).toFixed(1)} KB)`);
}
