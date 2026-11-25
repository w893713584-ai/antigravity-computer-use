#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "../src/constants.mjs";
import {
  DEFAULT_LOCAL_CODESIGN_IDENTITY,
  parseCodesignIdentities,
} from "../src/native-distribution.mjs";

export function buildLocalCertOpensslConfig(certName = DEFAULT_LOCAL_CODESIGN_IDENTITY) {
  const safeCn = String(certName || DEFAULT_LOCAL_CODESIGN_IDENTITY)
    .replace(/[\r\n]/gu, " ")
    .trim();
  return `[req]
distinguished_name = req_distinguished_name
x509_extensions = codesign_ext
prompt = no

[req_distinguished_name]
CN = ${safeCn}

[codesign_ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
`;
}

export function generateLocalCodesignArtifacts({
  certName = DEFAULT_LOCAL_CODESIGN_IDENTITY,
  workDir,
  passphrase,
  execFileSyncFn = execFileSync,
} = {}) {
  if (!workDir) throw new Error("workDir is required");
  if (!passphrase) throw new Error("passphrase is required");

  const configPath = path.join(workDir, "openssl.cnf");
  const keyPath = path.join(workDir, "key.pem");
  const certPath = path.join(workDir, "cert.pem");
  const p12Path = path.join(workDir, "cert.p12");

  writeFileSync(configPath, buildLocalCertOpensslConfig(certName), { mode: 0o600 });

  execFileSyncFn(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "3650",
      "-sha256",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-config",
      configPath,
    ],
    { stdio: "pipe", timeout: 15_000 }
  );
  chmodSync(keyPath, 0o600);

  execFileSyncFn(
    "/usr/bin/openssl",
    [
      "pkcs12",
      "-export",
      "-inkey",
      keyPath,
      "-in",
      certPath,
      "-out",
      p12Path,
      "-name",
      certName,
      "-passout",
      "env:CUA_P12_PASS",
    ],
    {
      env: { ...process.env, CUA_P12_PASS: passphrase },
      stdio: "pipe",
      timeout: 15_000,
    }
  );
  chmodSync(p12Path, 0o600);

  return { configPath, keyPath, certPath, p12Path };
}

export function setupLocalCodesignCertificate({
  certName = DEFAULT_LOCAL_CODESIGN_IDENTITY,
  force = false,
  keychainPath = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
  execFileSyncFn = execFileSync,
  platform = process.platform,
  log = console.log,
} = {}) {
  if (platform !== "darwin") {
    throw new Error("本机代码签名证书配置仅支持 macOS。");
  }
  const normalizedName = String(certName || "").trim() || DEFAULT_LOCAL_CODESIGN_IDENTITY;

  const listIdentities = () => {
    try {
      const raw = execFileSyncFn("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      });
      return parseCodesignIdentities(raw);
    } catch {
      return [];
    }
  };

  if (!force) {
    const existing = listIdentities().find((item) => item.name === normalizedName);
    if (existing) {
      log(`[setup-local-cert] 已检测到可用的本机签名证书 "${existing.name}" (${existing.hash})，无需重复创建。`);
      return {
        ok: true,
        alreadyExists: true,
        identity: existing.name,
        certHash: existing.hash,
      };
    }
  }

  const workDir = mkdtempSync(path.join(os.tmpdir(), "cua-local-cert-"));
  chmodSync(workDir, 0o700);
  try {
    const passphrase = crypto.randomBytes(24).toString("hex");
    log(`[setup-local-cert] 正在生成自签名代码签名证书 "${normalizedName}"...`);
    const { certPath, p12Path } = generateLocalCodesignArtifacts({
      certName: normalizedName,
      workDir,
      passphrase,
      execFileSyncFn,
    });

    log(`[setup-local-cert] 正在导入证书到钥匙串: ${keychainPath}`);
    execFileSyncFn(
      "/usr/bin/security",
      [
        "import",
        p12Path,
        "-f",
        "pkcs12",
        "-k",
        keychainPath,
        "-P",
        passphrase,
        "-T",
        "/usr/bin/codesign",
        "-T",
        "/usr/bin/security",
      ],
      { stdio: "inherit", timeout: 15_000 }
    );

    log("[setup-local-cert] 正在设置代码签名信任（macOS 将弹出一次钥匙串/触控 ID 确认）...");
    execFileSyncFn(
      "/usr/bin/security",
      ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychainPath, certPath],
      { stdio: "inherit", timeout: 30_000 }
    );

    const created = listIdentities().find((item) => item.name === normalizedName);
    if (!created) {
      throw new Error(
        `证书 "${normalizedName}" 导入后未在 \`security find-identity -v -p codesigning\` 中生效，请检查钥匙串信任设置。`
      );
    }

    log(`[setup-local-cert] 配置成功！证书 "${created.name}" (${created.hash}) 已可用于固定签名。`);
    return {
      ok: true,
      alreadyExists: false,
      identity: created.name,
      certHash: created.hash,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function parseCliArgs(argv) {
  let certName = DEFAULT_LOCAL_CODESIGN_IDENTITY;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--name" && i + 1 < argv.length) {
      certName = argv[++i];
    }
  }
  return { certName, force };
}

if (isMainModule(import.meta.url)) {
  try {
    const { certName, force } = parseCliArgs(process.argv.slice(2));
    const res = setupLocalCodesignCertificate({ certName, force });
    console.log(
      `\n[下一步] 运行以下命令即可使用固定证书 "${res.identity}" 重签并安装（以后改 Swift 源码也不易掉 TCC 授权）：\n` +
        `  npm run build:native && npm run install-agy\n`
    );
  } catch (err) {
    console.error(`[setup-local-cert] 失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
