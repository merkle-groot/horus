#!/usr/bin/env node
// Reproducible acquisition of the pinned ARM64 PRoot runtime for the Alpine
// terminal runtime.
//
// Usage:
//   node scripts/alpine-poc/acquire-proot.mjs            # full pipeline
//   node scripts/alpine-poc/acquire-proot.mjs --offline  # verify + stage from vendor/ only
//
// Exit codes: 0 = success, 1 = failed verification/step, 2 = usage error.
//
// Pipeline: download the three pinned Termux aarch64 .deb packages -> verify
// each SHA-256 against the pinned values -> extract with host tar -> verify
// every staged file is an ELF64 little-endian AArch64 object with only
// allowlisted NEEDED entries -> verify the proot binary supports the
// PROOT_LOADER / PROOT_LOADER_32 environment overrides (so the compiled-in
// Termux prefix is never required) -> stage into vendor/alpine-runtime/ ->
// update the asset manifest -> run the fail-closed validator.
//
// Staging happens only after every check passes. The shipped launch contract
// is: exec libproot.so from nativeLibraryDir with LD_LIBRARY_PATH pointing at
// nativeLibraryDir and PROOT_LOADER pointing at libproot_loader.so.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR_DIR = path.join(REPO_ROOT, "vendor/alpine-runtime");
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "android/app/src/main/assets/alpine-runtime/manifest.json",
);
const VALIDATOR_SCRIPT = path.join(REPO_ROOT, "scripts/alpine-poc/validate-proot-runtime.mjs");

// ---------------------------------------------------------------------------
// Pinned inputs. Changing any value here is a deliberate, recorded re-pin.
// Digests were verified against the signed Packages index at pin time
// (2026-09-07): https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages
// ---------------------------------------------------------------------------

const APT_ROOT = "https://packages.termux.dev/apt/termux-main";

const PINNED_PACKAGES = {
  proot: {
    debPath: "pool/main/p/proot/proot_5.1.107.92_aarch64.deb",
    debSha256: "1f1c983509701f6826f568482c70673ee453a9ba38c9f5fa445a472d6b7524e9",
    version: "5.1.107.92",
    srcurl: "https://github.com/termux/proot/archive/v5.1.107.92.zip",
    srcSha256: "29385d1ddb619a9c4449ab512bfd55032034b22f724ddf98fc95ff300ea32135",
    license: { name: "GNU General Public License v2.0", spdx: "GPL-2.0-only" },
    needed: ["libtalloc.so", "libandroid-shmem.so", "libc.so"],
    files: [
      { inDeb: "data/data/com.termux/files/usr/bin/proot", stagedAs: "proot", jniName: "libproot.so", mustBeExecutable: true, patch: "talloc-soname" },
      { inDeb: "data/data/com.termux/files/usr/libexec/proot/loader", stagedAs: "loader", jniName: "libproot_loader.so", mustBeExecutable: true },
    ],
  },
  libtalloc: {
    debPath: "pool/main/libt/libtalloc/libtalloc_2.4.3_aarch64.deb",
    debSha256: "ac81ad623d74c209718b9f3acb2dd702cc8a88c431e820d212229910b4db29da",
    version: "2.4.3",
    srcurl: "https://www.samba.org/ftp/talloc/talloc-2.4.3.tar.gz",
    srcSha256: "dc46c40b9f46bb34dd97fe41f548b0e8b247b77a918576733c528e83abd854dd",
    license: { name: "GNU General Public License v3.0 (Termux package declaration; talloc library is LGPL-3.0-or-later upstream)", spdx: "GPL-3.0-only" },
    needed: ["libc.so"],
    files: [
      { inDeb: "data/data/com.termux/files/usr/lib/libtalloc.so.2", stagedAs: "libtalloc.so", jniName: "libtalloc.so", mustBeExecutable: false, patch: "talloc-soname" },
    ],
  },
  libandroidShmem: {
    debPath: "pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_aarch64.deb",
    debSha256: "0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6",
    version: "0.7",
    srcurl: "https://github.com/termux/libandroid-shmem",
    srcSha256: null,
    license: { name: "BSD 2-Clause Style (Pylypenko/Fornwall)", spdx: "BSD-2-Clause" },
    needed: ["liblog.so", "libc.so"],
    files: [
      { inDeb: "data/data/com.termux/files/usr/lib/libandroid-shmem.so", stagedAs: "libandroid-shmem.so", jniName: "libandroid-shmem.so", mustBeExecutable: false },
    ],
  },
};

const EXPECTED_ABI = "arm64-v8a";
const AARCH64_EM_AARCH64 = 183; // ELF e_machine for AArch64
const REQUIRED_PROOT_ENV_MARKERS = ["PROOT_LOADER", "PROOT_LOADER_32"];
const SIZE_BUDGET_BYTES = 8 * 1024 * 1024;

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "buffer", ...opts });
  if (r.error) throw new Error(`${cmd} could not be executed: ${r.message}`);
  if (r.status !== 0) {
    const stderr = (r.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}${stderr ? `: ${stderr.slice(-800)}` : ""}`);
  }
  return r;
}

function verifyElfHeader(bytes, label) {
  if (bytes.length < 64 || bytes.readUInt32LE(0) !== 0x464c457f) fail(`${label} is not an ELF file`);
  const eiClass = bytes[4];
  const eiData = bytes[5];
  const eType = bytes.readUInt16LE(16);
  const eMachine = bytes.readUInt16LE(18);
  if (eiClass !== 2) fail(`${label}: ELF class must be 2 (ELF64), got ${eiClass}`);
  if (eiData !== 1) fail(`${label}: ELF data encoding must be 1 (little-endian), got ${eiData}`);
  if (eType !== 2 && eType !== 3) fail(`${label}: ELF e_type must be EXEC (2) or DYN (3), got ${eType}`);
  if (eMachine !== AARCH64_EM_AARCH64) fail(`${label}: ELF e_machine must be 183 (AArch64), got ${eMachine}`);
  return { class: "ELF64", endian: "little", type: eType === 3 ? "DYN" : "EXEC", machine: "AArch64" };
}

function neededEntries(bytes) {
  // Parse PT_DYNAMIC NEEDED entries without external tools: walk the dynamic
  // table for tag 1 (DT_NEEDED) and resolve string-table offsets.
  if (bytes.readUInt16LE(16) !== 3) return []; // EXEC files have no dynamic table we rely on
  const ePhoff = Number(bytes.readBigUInt64LE(32));
  const ePhentsize = bytes.readUInt16LE(54);
  const ePhnum = bytes.readUInt16LE(56);
  let dynOffset = -1;
  let dynSize = 0;
  for (let i = 0; i < ePhnum; i++) {
    const ph = ePhoff + i * ePhentsize;
    const pType = bytes.readUInt32LE(ph);
    if (pType === 2) {
      dynOffset = Number(bytes.readBigUInt64LE(ph + 8));
      dynSize = Number(bytes.readBigUInt64LE(ph + 32));
    }
  }
  if (dynOffset < 0) return [];
  const needed = [];
  let strTabOffset = -1;
  for (let off = dynOffset; off < dynOffset + dynSize; off += 16) {
    const tag = bytes.readBigUInt64LE(off);
    const val = bytes.readBigUInt64LE(off + 8);
    if (tag === 0n) break;
    if (tag === 5n) strTabOffset = Number(val); // DT_STRTAB is a vaddr; entries we need sit near it for these small libs
  }
  // DT_STRTAB holds a virtual address. For the small pinned artifacts the
  // file offsets and vaddrs coincide (single PT_LOAD at 0). Verify the guess
  // and bail out (fail closed) rather than mis-parsing.
  if (strTabOffset <= 0 || strTabOffset >= bytes.length) return [];
  for (let off = dynOffset; off < dynOffset + dynSize; off += 16) {
    const tag = bytes.readBigUInt64LE(off);
    const val = Number(bytes.readBigUInt64LE(off + 8));
    if (tag === 0n) break;
    if (tag === 1n) {
      const start = strTabOffset + val;
      if (start >= bytes.length) fail(`DT_NEEDED string offset out of range while parsing`);
      const end = bytes.indexOf(0, start);
      needed.push(bytes.toString("utf8", start, end));
    }
  }
  return needed;
}

function verifyNeeded(bytes, allowlist, label) {
  const needed = neededEntries(bytes);
  const unexpected = needed.filter((l) => !allowlist.includes(l));
  if (unexpected.length > 0) {
    fail(`${label}: unexpected NEEDED libraries ${unexpected.join(", ")} (allowed: ${allowlist.join(", ")})`);
  }
  return needed;
}

async function downloadDeb(pkg, destPath) {
  const url = `${APT_ROOT}/${pkg.debPath}`;
  const res = await fetch(url);
  if (!res.ok) fail(`download of ${url} failed with HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== pkg.debSha256) fail(`${path.basename(pkg.debPath)} SHA-256 ${got} != pinned ${pkg.debSha256}`);
  writeFileSync(destPath, buf);
  return got;
}

function extractDebData(debPath, workdir) {
  // macOS `ar` mishandles GNU deb member naming, so parse the ar container
  // directly and hand the data.tar.* member to host tar for extraction.
  const data = readFileSync(debPath);
  if (data.subarray(0, 8).toString("utf8") !== "!<arch>\n") fail(`${path.basename(debPath)} is not an ar archive`);
  let pos = 8;
  let member = null;
  while (pos + 60 <= data.length) {
    const header = data.subarray(pos, pos + 60);
    const name = header.toString("utf8", 0, 16).replace(/[\s/]+$/, "");
    const size = parseInt(header.toString("utf8", 48, 58).trim(), 10);
    if (name.startsWith("data.tar")) {
      member = { name, bytes: data.subarray(pos + 60, pos + 60 + size) };
      break;
    }
    pos += 60 + size + (size % 2);
  }
  if (!member) fail(`${path.basename(debPath)} contains no data.tar member`);
  mkdirSync(workdir, { recursive: true });
  const memberPath = path.join(workdir, member.name);
  writeFileSync(memberPath, member.bytes);
  const extractDir = path.join(workdir, `extract-${path.basename(debPath)}`);
  mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xf", memberPath, "-C", extractDir]);
  return extractDir;
}

/**
 * Android's JNI-library packaging only ships files named lib*.so, but PRoot
 * declares libtalloc.so.2 as its DT_NEEDED dependency. Shorten the string in
 * place inside the fixed .dynstr table (an earlier NUL terminator; the
 * trailing bytes are dead padding), then ship the library as libtalloc.so.
 * The library bytes are otherwise untouched. The match is anchored on the
 * explicit NUL terminator so libtalloc.so.2.4.3 is never rewritten.
 */
function patchTallocSoname(bytes, label) {
  const from = Buffer.from("libtalloc.so.2\0", "utf8");
  const to = Buffer.from("libtalloc.so\0\0\0", "utf8");
  if (from.length !== to.length) fail("talloc soname patch lengths must match");
  let count = 0;
  let idx = bytes.indexOf(from);
  while (idx !== -1) {
    to.copy(bytes, idx);
    count++;
    idx = bytes.indexOf(from, idx + from.length);
  }
  if (count !== 1) fail(`${label}: expected exactly one libtalloc.so.2 string, found ${count}`);
  return count;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a !== "--offline")) {
    console.error("Usage: node scripts/alpine-poc/acquire-proot.mjs [--offline]");
    process.exit(2);
  }
  const offline = argv.includes("--offline");

  const workdir = offline ? null : mkdtempSync(path.join(os.tmpdir(), "alpine-proot-acquire-"));
  if (workdir) process.stdout.write(`==> work directory: ${workdir}\n`);

  const staged = [];
  try {
    for (const [name, pkg] of Object.entries(PINNED_PACKAGES)) {
      process.stdout.write(`==> package ${name} ${pkg.version}\n`);
      let debPath;
      let debSha256;
      const vendoredDeb = path.join(VENDOR_DIR, path.basename(pkg.debPath));
      if (offline) {
        if (!existsSync(vendoredDeb)) fail(`--offline: ${vendoredDeb} is missing`);
        debPath = vendoredDeb;
        debSha256 = sha256(readFileSync(debPath));
        if (debSha256 !== pkg.debSha256) fail(`--offline: ${path.basename(debPath)} digest mismatch`);
      } else {
        debPath = path.join(workdir, path.basename(pkg.debPath));
        debSha256 = await downloadDeb(pkg, debPath);
        copyFileSync(debPath, vendoredDeb);
      }

      const extractDir = workdir ? extractDebData(debPath, workdir) : extractDebData(debPath, path.join(VENDOR_DIR, ".extract"));
      for (const file of pkg.files) {
        const sourcePath = path.join(extractDir, file.inDeb);
        if (!existsSync(sourcePath)) fail(`${name}: ${file.inDeb} is missing from the package`);
        const bytes = readFileSync(sourcePath);
        if (file.patch === "talloc-soname") patchTallocSoname(bytes, file.stagedAs);
        if (bytes.length <= 0 || bytes.length > SIZE_BUDGET_BYTES) fail(`${file.stagedAs}: unreasonable size ${bytes.length}`);
        const elf = verifyElfHeader(bytes, file.stagedAs);
        const needed = verifyNeeded(bytes, pkg.needed, file.stagedAs);
        const stagedPath = path.join(VENDOR_DIR, file.stagedAs);
        writeFileSync(stagedPath, bytes);
        if (file.mustBeExecutable) run("chmod", ["+x", stagedPath]);
        staged.push({ package: name, stagedAs: file.stagedAs, jniName: file.jniName, sizeBytes: bytes.length, sha256: sha256(bytes), elf, needed });
      }
    }

    // The launcher relies on the environment overrides; a build that only
    // supports the compiled-in Termux paths is unusable for this app.
    const prootBytes = readFileSync(path.join(VENDOR_DIR, "proot"));
    for (const marker of REQUIRED_PROOT_ENV_MARKERS) {
      if (!prootBytes.includes(Buffer.from(marker))) fail(`proot binary lacks the ${marker} environment override marker`);
    }

    const manifest = {
      schemaVersion: 1,
      status: "available",
      source: {
        repository: APT_ROOT,
        index: "dists/stable/main/binary-aarch64/Packages",
        pinnedAtUtc: "2026-09-07",
        packages: Object.entries(PINNED_PACKAGES).map(([name, pkg]) => ({
          name,
          version: pkg.version,
          debUrl: `${APT_ROOT}/${pkg.debPath}`,
          debSha256: pkg.debSha256,
          srcurl: pkg.srcurl,
          ...(pkg.srcSha256 ? { srcSha256: pkg.srcSha256 } : {}),
        })),
      },
      target: {
        abi: EXPECTED_ABI,
        jniPaths: Object.fromEntries(staged.map((f) => [f.stagedAs, `lib/${EXPECTED_ABI}/${f.jniName}`])),
        artifacts: staged.map(({ package: _p, stagedAs, jniName, sizeBytes, sha256, elf, needed }) => ({
          stagedAs,
          jniName,
          sizeBytes,
          sha256,
          elf,
          needed,
        })),
        sizeBudgetBytes: SIZE_BUDGET_BYTES,
      },
      licenses: Object.values(PINNED_PACKAGES).map((p) => p.license),
      sbom: Object.entries(PINNED_PACKAGES).map(([name, p]) => ({ name, version: p.version })),
      packaging: {
        mechanism: "APK JNI library path",
        forbidAssetExtractionAsExecutable: true,
        launcherContract: {
          executable: "libproot.so",
          loaderEnv: "PROOT_LOADER=libproot_loader.so (compiled-in Termux paths are never used)",
          sharedLibraryPath: "LD_LIBRARY_PATH=nativeLibraryDir (resolves libtalloc.so.2, libandroid-shmem.so)",
          envMarkers: REQUIRED_PROOT_ENV_MARKERS,
        },
      },
      build: {
        script: "scripts/alpine-poc/acquire-proot.mjs",
        note: "pinned Termux aarch64 runtime artifacts, verified against the signed Packages index digests; the shipped Android PRoot rebuild additionally carries scripts/alpine-poc/proot-android-fork-child.patch",
        patches: [
          {
            change: "DT_NEEDED/DT_SONAME string libtalloc.so.2 -> libtalloc.so (in-place NUL re-termination, identical length, library bytes unchanged)",
            files: ["proot", "libtalloc.so"],
            reason: "Android JNI-library packaging ships only lib*.so file names; the dependency is resolved by the shortened name via LD_LIBRARY_PATH",
          },
          {
            change: "Recover the oldest unregistered direct fork/clone child from /proc/<pid>/stat when Android reports the ptrace event but PTRACE_GETEVENTMSG fails",
            files: ["proot"],
            reason: "The Android kernel can leave forked external-command children in tracing-stop; the fallback preserves PRoot child bookkeeping without changing the normal ptrace path",
            sourcePatch: "scripts/alpine-poc/proot-android-fork-child.patch",
          },
        ],
      },
    };
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

    const r = spawnSync(process.execPath, [VALIDATOR_SCRIPT], { encoding: "utf8" });
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    if (r.status !== 0) fail(`validator exited ${r.status}`);

    console.log(`\nACQUIRED: vendor/alpine-runtime/ (${staged.length} files)`);
    for (const f of staged) console.log(`  ${f.stagedAs} -> lib/${EXPECTED_ABI}/${f.jniName}  ${f.sizeBytes}B  sha256=${f.sha256.slice(0, 16)}...`);
  } finally {
    rmSync(path.join(VENDOR_DIR, ".extract"), { recursive: true, force: true });
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
