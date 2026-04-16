#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_APP_PATH = "/Applications/Codex.app";
const DEFAULT_BACKUP_ROOT = path.join(
  os.homedir(),
  ".codex",
  "backups",
  "codex-file-links-open-in-ide",
);

const OLD_TOKEN = "if(d&&m){PX(f,l==null?o:jt(l,o));return}";
const NEW_TOKEN = "if(0&&m){PX(f,l==null?o:jt(l,o));return}";
const UNSAFE_PATCH_ISSUE_URL =
  "https://github.com/EthanSK/codex-file-links-open-in-ide/issues/1";
const AD_HOC_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
`;

function usage() {
  console.log(`Usage: patch-codex-file-links.js [options]

Options:
  --app <path>          Codex.app path. Defaults to /Applications/Codex.app.
  --backup-root <path>  Backup folder. Defaults to ~/.codex/backups/codex-file-links-open-in-ide.
  --dry-run             Inspect only; do not write files or sign the app.
  --resign              Disabled while the ASAR patch crash is unresolved.
  --help                Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    appPath: DEFAULT_APP_PATH,
    backupRoot: DEFAULT_BACKUP_ROOT,
    dryRun: false,
    resign: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--app": {
        const next = argv[index + 1];
        if (!next) {
          throw new Error("--app requires a path");
        }
        args.appPath = next;
        index += 1;
        break;
      }
      case "--backup-root": {
        const next = argv[index + 1];
        if (!next) {
          throw new Error("--backup-root requires a path");
        }
        args.backupRoot = next;
        index += 1;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--resign":
        args.resign = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
}

function runIgnoringFailure(command, args) {
  run(command, args);
}

function readPlistValue(plistPath, keyPath) {
  const result = run("/usr/libexec/PlistBuddy", ["-c", `Print ${keyPath}`, plistPath]);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function setPlistValue(plistPath, keyPath, value) {
  const result = run("/usr/libexec/PlistBuddy", ["-c", `Set ${keyPath} ${value}`, plistPath]);
  if (result.status !== 0) {
    throw new Error(`Failed to update ${keyPath} in Info.plist: ${result.stderr}`);
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function getAsarHeaderInfo(buffer) {
  if (buffer.length < 16) {
    throw new Error("ASAR is too small to contain a header");
  }

  const jsonSize = buffer.readUInt32LE(12);
  const start = 16;
  const end = start + jsonSize;
  if (jsonSize <= 0 || end > buffer.length) {
    throw new Error(`Invalid ASAR header JSON size: ${jsonSize}`);
  }

  const text = buffer.subarray(start, end).toString("utf8");
  return {
    end,
    header: JSON.parse(text),
    jsonSize,
    start,
    text,
  };
}

function getAsarHeaderHash(buffer) {
  const headerInfo = getAsarHeaderInfo(buffer);
  return sha256(buffer.subarray(headerInfo.start, headerInfo.end));
}

function countToken(buffer, token) {
  const tokenBuffer = Buffer.from(token);
  let count = 0;
  let offset = 0;

  for (;;) {
    const foundAt = buffer.indexOf(tokenBuffer, offset);
    if (foundAt === -1) {
      return count;
    }
    count += 1;
    offset = foundAt + tokenBuffer.length;
  }
}

function replaceToken(buffer, oldToken, newToken) {
  if (Buffer.byteLength(oldToken) !== Buffer.byteLength(newToken)) {
    throw new Error("Patch tokens must have identical byte length");
  }

  const oldBuffer = Buffer.from(oldToken);
  const newBuffer = Buffer.from(newToken);
  const foundAt = buffer.indexOf(oldBuffer);
  if (foundAt === -1) {
    return null;
  }

  newBuffer.copy(buffer, foundAt);
  return foundAt;
}

function findAsarFileForOffset(headerInfo, absoluteOffset) {
  const contentBase = headerInfo.end;

  function walk(node, parts) {
    if (!node.files) {
      return null;
    }

    for (const [name, entry] of Object.entries(node.files)) {
      const nextParts = [...parts, name];
      if (entry.files) {
        const nested = walk(entry, nextParts);
        if (nested) {
          return nested;
        }
        continue;
      }

      if (entry.offset == null || entry.size == null) {
        continue;
      }

      const contentStart = contentBase + Number(entry.offset);
      const contentEnd = contentStart + entry.size;
      if (absoluteOffset >= contentStart && absoluteOffset < contentEnd) {
        return {
          contentEnd,
          contentStart,
          entry,
          path: nextParts.join("/"),
        };
      }
    }

    return null;
  }

  return walk(headerInfo.header, []);
}

function computeFileIntegrity(buffer, target) {
  const existing = target.entry.integrity;
  if (!existing) {
    return null;
  }
  if (existing.algorithm !== "SHA256") {
    throw new Error(`Unsupported ASAR file integrity algorithm: ${existing.algorithm}`);
  }

  const file = buffer.subarray(target.contentStart, target.contentEnd);
  const blockSize = existing.blockSize ?? file.length;
  const blocks = [];
  for (let offset = 0; offset < file.length; offset += blockSize) {
    blocks.push(sha256(file.subarray(offset, Math.min(offset + blockSize, file.length))));
  }

  return {
    algorithm: "SHA256",
    blockSize,
    blocks,
    hash: sha256(file),
  };
}

function updateAsarFileIntegrity(buffer, patchOffset) {
  const headerInfo = getAsarHeaderInfo(buffer);
  const target = findAsarFileForOffset(headerInfo, patchOffset);
  if (!target) {
    throw new Error("Could not map patch offset back to an ASAR file entry");
  }

  const integrity = computeFileIntegrity(buffer, target);
  if (!integrity) {
    return { headerHash: getAsarHeaderHash(buffer), targetPath: target.path, updated: false };
  }

  target.entry.integrity = integrity;
  const nextHeaderText = JSON.stringify(headerInfo.header);
  if (Buffer.byteLength(nextHeaderText) !== headerInfo.jsonSize) {
    throw new Error(
      `ASAR header size changed while updating integrity for ${target.path}; aborting`,
    );
  }

  Buffer.from(nextHeaderText, "utf8").copy(buffer, headerInfo.start);
  return {
    headerHash: sha256(buffer.subarray(headerInfo.start, headerInfo.end)),
    targetPath: target.path,
    updated: true,
  };
}

function getVersion(infoPlistPath) {
  return readPlistValue(infoPlistPath, ":CFBundleShortVersionString") ?? "unknown";
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function makeBackup({ appPath, asarPath, backupRoot, infoPlistPath }) {
  const version = getVersion(infoPlistPath);
  const backupDir = path.join(backupRoot, `${timestamp()}-v${version}`);
  fs.mkdirSync(backupDir, { recursive: true });
  copyFile(asarPath, path.join(backupDir, "app.asar"));
  copyFile(infoPlistPath, path.join(backupDir, "Info.plist"));
  fs.writeFileSync(
    path.join(backupDir, "metadata.json"),
    JSON.stringify(
      {
        appPath,
        version,
        createdAt: new Date().toISOString(),
        patch: "codex-file-links-open-in-ide",
        oldToken: OLD_TOKEN,
        newToken: NEW_TOKEN,
      },
      null,
      2,
    ),
    "utf8",
  );
  return backupDir;
}

function verifyCodeSignature(appPath) {
  return run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

function collectNestedCodePaths(appPath) {
  const frameworksPath = path.join(appPath, "Contents", "Frameworks");
  if (!fs.existsSync(frameworksPath)) {
    return [];
  }

  const matches = [];
  const stack = [frameworksPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }

      const fullPath = path.join(current, entry.name);
      if (
        entry.name.endsWith(".app") ||
        entry.name.endsWith(".framework") ||
        entry.name.endsWith(".xpc")
      ) {
        matches.push(fullPath);
      }
      stack.push(fullPath);
    }
  }

  return matches.sort((left, right) => right.length - left.length);
}

function writeEntitlementsFile() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-file-links-"));
  const entitlementsPath = path.join(tempDir, "entitlements.plist");
  fs.writeFileSync(entitlementsPath, AD_HOC_ENTITLEMENTS, "utf8");
  return { entitlementsPath, tempDir };
}

function shouldUseEntitlements(codePath, appPath) {
  return codePath === appPath || codePath.endsWith(".app") || codePath.endsWith(".xpc");
}

function signPath(codePath, { appPath, entitlementsPath }) {
  const args = ["--force", "--deep", "--sign", "-", "--timestamp=none", "--options", "runtime"];
  if (shouldUseEntitlements(codePath, appPath)) {
    // Electron needs these after ad-hoc signing or macOS rejects Electron Framework at launch.
    args.push("--entitlements", entitlementsPath);
  }
  args.push(codePath);
  return run(
    "codesign",
    args,
    { stdio: "inherit" },
  );
}

function signApp(appPath) {
  const { entitlementsPath, tempDir } = writeEntitlementsFile();
  try {
    for (const nestedPath of collectNestedCodePaths(appPath)) {
      const result = signPath(nestedPath, { appPath, entitlementsPath });
      if (result.status !== 0) {
        return result;
      }
    }

    return signPath(appPath, { appPath, entitlementsPath });
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function clearProvenanceMetadata(appPath) {
  runIgnoringFailure("xattr", ["-dr", "com.apple.provenance", appPath]);
  runIgnoringFailure("xattr", ["-rsd", "com.apple.provenance", appPath]);
  runIgnoringFailure("xattr", ["-d", "com.apple.macl", appPath]);
}

function ensureMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("This patch is only for the macOS Codex desktop app");
  }
}

function validatePaths({ appPath, asarPath, infoPlistPath }) {
  if (!fs.existsSync(appPath)) {
    throw new Error(`Codex app not found: ${appPath}`);
  }
  if (!fs.existsSync(asarPath)) {
    throw new Error(`ASAR not found: ${asarPath}`);
  }
  if (!fs.existsSync(infoPlistPath)) {
    throw new Error(`Info.plist not found: ${infoPlistPath}`);
  }
}

function printInspection({ appPath, before, infoPlistPath }) {
  const oldCount = countToken(before, OLD_TOKEN);
  const newCount = countToken(before, NEW_TOKEN);
  const headerHash = getAsarHeaderHash(before);
  const expectedHeaderHash = readPlistValue(
    infoPlistPath,
    ":ElectronAsarIntegrity:Resources/app.asar:hash",
  );

  console.log(`Codex app: ${appPath}`);
  console.log(`Version: ${getVersion(infoPlistPath)}`);
  console.log(`Old token matches: ${oldCount}`);
  console.log(`Patched token matches: ${newCount}`);
  console.log(`ASAR header hash: ${headerHash}`);
  console.log(`Info.plist ASAR header hash: ${expectedHeaderHash ?? "not present"}`);

  if (expectedHeaderHash && expectedHeaderHash !== headerHash) {
    throw new Error("ASAR header hash does not match Info.plist before patching");
  }

  return { expectedHeaderHash, oldCount, newCount };
}

function signAndVerify(appPath) {
  const signResult = signApp(appPath);
  if (signResult.status !== 0) {
    throw new Error(`codesign failed with status ${signResult.status}`);
  }
  clearProvenanceMetadata(appPath);
  const verifyAfterSign = verifyCodeSignature(appPath);
  if (verifyAfterSign.status !== 0) {
    throw new Error(`codesign verification failed after resigning: ${verifyAfterSign.stderr}`);
  }
  console.log("Code signature: ad-hoc signed with Electron entitlements and verified");
  console.log("Provenance metadata: cleared from Codex.app");
}

function main() {
  ensureMacOS();

  const args = parseArgs(process.argv.slice(2));
  const appPath = path.resolve(args.appPath);
  const backupRoot = path.resolve(args.backupRoot);
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");

  validatePaths({ appPath, asarPath, infoPlistPath });

  const before = fs.readFileSync(asarPath);
  const inspection = printInspection({ appPath, before, infoPlistPath });

  if (inspection.oldCount === 0 && inspection.newCount > 0) {
    console.log("Status: already patched");
    console.log(`Warning: this patch is known to crash current Codex builds. See ${UNSAFE_PATCH_ISSUE_URL}`);
    if (!args.dryRun) {
      throw new Error("Refusing to re-sign an already patched app while the crash issue is unresolved");
    }
    return;
  }

  if (inspection.oldCount !== 1) {
    throw new Error(
      `Expected exactly one unpatched click-handler token, found ${inspection.oldCount}. Codex likely changed; inspect the renderer bundle before patching.`,
    );
  }

  if (args.dryRun) {
    console.log("Status: patchable, but patch application is disabled because it currently crashes Codex");
    console.log(`Issue: ${UNSAFE_PATCH_ISSUE_URL}`);
    return;
  }

  throw new Error(
    `Patch application is disabled because the patched ASAR still crashes Codex. See ${UNSAFE_PATCH_ISSUE_URL}`,
  );

  const backupDir = makeBackup({ appPath, asarPath, backupRoot, infoPlistPath });
  const patched = Buffer.from(before);
  const patchOffset = replaceToken(patched, OLD_TOKEN, NEW_TOKEN);
  if (patchOffset == null) {
    throw new Error("Patch token disappeared before write");
  }

  const integrityUpdate = updateAsarFileIntegrity(patched, patchOffset);

  try {
    fs.writeFileSync(asarPath, patched);
    if (inspection.expectedHeaderHash) {
      setPlistValue(
        infoPlistPath,
        ":ElectronAsarIntegrity:Resources/app.asar:hash",
        integrityUpdate.headerHash,
      );
    }
  } catch (error) {
    copyFile(path.join(backupDir, "app.asar"), asarPath);
    copyFile(path.join(backupDir, "Info.plist"), infoPlistPath);
    throw error;
  }

  console.log(`ASAR target: ${integrityUpdate.targetPath}`);
  console.log(`ASAR file integrity: ${integrityUpdate.updated ? "updated" : "not present"}`);
  console.log(`Info.plist ASAR header hash: ${integrityUpdate.headerHash}`);
  console.log(`Backup: ${backupDir}`);
  console.log("Status: patched");

  signAndVerify(appPath);
  console.log("Next step: restart Codex");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
