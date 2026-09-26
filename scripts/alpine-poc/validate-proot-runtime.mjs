#!/usr/bin/env node
// Fail-closed validator for the pinned Alpine PRoot runtime manifest.
//
// Usage:
//   node scripts/alpine-poc/validate-proot-runtime.mjs [manifestPath]
//   node scripts/alpine-poc/validate-proot-runtime.mjs --self-test
//
// Exit codes: 0 = valid, 1 = fail-closed, 2 = usage error.
//
// A manifest that does not satisfy EVERY check below fails closed. Checks:
//   - schemaVersion 1, status "available"
//   - three pinned packages with full URLs and 64-hex digests
//   - every artifact in vendor/alpine-runtime/ exists, matches its recorded
//     size and SHA-256, and is an ELF64 LE AArch64 object
//   - the proot executable embeds the PROOT_LOADER / PROOT_LOADER_32 markers
//   - packaging mechanism is the APK JNI library path

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_MANIFEST = path.join(
  REPO_ROOT,
  "android/app/src/main/assets/alpine-runtime/manifest.json",
);
const VENDOR_DIR = path.join(REPO_ROOT, "vendor/alpine-runtime");
const EXPECTED_ABI = "arm64-v8a";
const REQUIRED_MECHANISM = "APK JNI library path";
const REQUIRED_PACKAGES = ["proot", "libtalloc", "libandroidShmem"];
const REQUIRED_PROOT_ENV_MARKERS = ["PROOT_LOADER", "PROOT_LOADER_32"];
const SHA256_RE = /^[a-f0-9]{64}$/;
const REQUIRED_ARTIFACTS = ["proot", "loader", "libtalloc.so", "libandroid-shmem.so"];
const FORBIDDEN_ARTIFACT_BYTES = [Buffer.from("libtalloc.so.2\0")];

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function validate(manifestPath) {
  const failures = [];
  const fail = (m) => failures.push(m);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`fail-closed: cannot parse ${manifestPath}: ${e.message}`);
    return 1;
  }

  if (manifest.schemaVersion !== 1) fail(`schemaVersion must be 1, got ${manifest.schemaVersion}`);
  if (manifest.status !== "available") fail(`status must be "available", got ${JSON.stringify(manifest.status)}`);

  const source = manifest.source ?? {};
  const packages = source.packages ?? [];
  const packageNames = packages.map((p) => p.name);
  for (const required of REQUIRED_PACKAGES) {
    if (!packageNames.includes(required)) fail(`missing pinned package entry ${required}`);
  }
  for (const p of packages) {
    if (!/^https:\/\//.test(p.debUrl ?? "")) fail(`package ${p.name}: debUrl must be https`);
    if (!SHA256_RE.test(p.debSha256 ?? "")) fail(`package ${p.name}: debSha256 must be 64 hex chars`);
    if (!/^https:\/\//.test(p.srcurl ?? "")) fail(`package ${p.name}: srcurl must be https`);
  }

  const target = manifest.target ?? {};
  if (target.abi !== EXPECTED_ABI) fail(`target.abi must be ${EXPECTED_ABI}`);
  const artifacts = target.artifacts ?? [];
  if (artifacts.length < REQUIRED_ARTIFACTS.length) fail(`expected at least ${REQUIRED_ARTIFACTS.length} artifacts, got ${artifacts.length}`);
  const byStagedAs = new Map(artifacts.map((a) => [a.stagedAs, a]));
  for (const required of REQUIRED_ARTIFACTS) {
    if (!byStagedAs.has(required)) fail(`missing artifact record for ${required}`);
  }
  for (const a of artifacts) {
    const jniPath = (target.jniPaths ?? {})[a.stagedAs];
    if (!jniPath || !jniPath.startsWith(`lib/${EXPECTED_ABI}/`)) fail(`artifact ${a.stagedAs}: jniPath must sit under lib/${EXPECTED_ABI}/`);
    const stagedPath = path.join(VENDOR_DIR, a.stagedAs);
    if (!existsSync(stagedPath)) {
      fail(`artifact ${a.stagedAs}: staged file ${path.relative(REPO_ROOT, stagedPath)} is missing`);
      continue;
    }
    const stats = statSync(stagedPath);
    if (stats.size !== a.sizeBytes) fail(`artifact ${a.stagedAs}: size ${stats.size} != recorded ${a.sizeBytes}`);
    const digest = sha256File(stagedPath);
    if (digest !== a.sha256) fail(`artifact ${a.stagedAs}: SHA-256 mismatch`);
    const bytes = readFileSync(stagedPath);
    if (bytes.length < 64 || bytes.readUInt32LE(0) !== 0x464c457f) fail(`artifact ${a.stagedAs}: not an ELF file`);
    if (bytes[4] !== 2) fail(`artifact ${a.stagedAs}: not ELF64`);
    if (bytes[5] !== 1) fail(`artifact ${a.stagedAs}: not little-endian`);
    if (bytes.readUInt16LE(18) !== 183) fail(`artifact ${a.stagedAs}: not AArch64`);
    if (!Array.isArray(a.needed)) fail(`artifact ${a.stagedAs}: needed list missing`);
    for (const forbidden of FORBIDDEN_ARTIFACT_BYTES) {
      if (bytes.includes(forbidden)) fail(`artifact ${a.stagedAs}: unpatched libtalloc.so.2 string remains`);
    }
  }

  const prootBytes = readFileSync(path.join(VENDOR_DIR, "proot"));
  for (const marker of REQUIRED_PROOT_ENV_MARKERS) {
    if (!prootBytes.includes(Buffer.from(marker))) fail(`proot binary lacks the ${marker} marker`);
  }

  if (manifest.packaging?.mechanism !== REQUIRED_MECHANISM) fail(`packaging.mechanism must be ${REQUIRED_MECHANISM}`);
  const contract = manifest.packaging?.launcherContract ?? {};
  if (contract.executable !== "libproot.so") fail("launcherContract.executable must be libproot.so");
  if (!Array.isArray(manifest.licenses) || manifest.licenses.length < REQUIRED_PACKAGES.length) {
    fail("licenses must cover every pinned package");
  }

  if (failures.length > 0) {
    console.error(`fail-closed: ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(
    `alpine proot manifest valid: ${artifacts.length} artifacts, abi=${EXPECTED_ABI}, mechanism=${REQUIRED_MECHANISM}`,
  );
  return 0;
}

function selfTest() {
  const cases = [];
  const baseManifest = () => ({
    schemaVersion: 1,
    status: "available",
    source: {
      packages: [
        { name: "proot", version: "1", debUrl: "https://x/y.deb", debSha256: "a".repeat(64), srcurl: "https://x/s" },
        { name: "libtalloc", version: "1", debUrl: "https://x/y.deb", debSha256: "b".repeat(64), srcurl: "https://x/s" },
        { name: "libandroidShmem", version: "1", debUrl: "https://x/y.deb", debSha256: "c".repeat(64), srcurl: "https://x/s" },
      ],
    },
    target: { abi: EXPECTED_ABI, jniPaths: {}, artifacts: [] },
    packaging: { mechanism: REQUIRED_MECHANISM, launcherContract: { executable: "libproot.so" } },
    licenses: [{}, {}, {}],
  });
  const ok = baseManifest();
  cases.push(["accepts a well-formed manifest", () => validateShape(ok).length === 0]);
  cases.push(["rejects status missing", () => validateShape({ ...ok, status: "missing" }).length > 0]);
  cases.push(["rejects http debUrl", () => validateShape({
    ...ok,
    source: { packages: ok.source.packages.map((p, i) => (i === 0 ? { ...p, debUrl: "http://x/y.deb" } : p)) },
  }).length > 0]);
  cases.push(["rejects wrong abi", () => validateShape({ ...ok, target: { ...ok.target, abi: "x86_64" } }).length > 0]);
  cases.push(["rejects bad mechanism", () => validateShape({ ...ok, packaging: { mechanism: "assets" } }).length > 0]);
  let passed = 0;
  for (const [name, check] of cases) {
    const okCase = check();
    console.log(`${okCase ? "PASS" : "FAIL"} ${name}`);
    if (okCase) passed++;
  }
  return passed === cases.length ? 0 : 1;
}

// Shape-only checks for the self-test; shared with the file validator.
function validateShape(manifest) {
  const failures = [];
  if (manifest.schemaVersion !== 1) failures.push("schemaVersion");
  if (manifest.status !== "available") failures.push("status");
  const packages = manifest.source?.packages ?? [];
  if (packages.length !== 3 || packages.some((p) => !/^https:\/\//.test(p.debUrl ?? "") || !SHA256_RE.test(p.debSha256 ?? ""))) failures.push("packages");
  if (manifest.target?.abi !== EXPECTED_ABI) failures.push("abi");
  if (manifest.packaging?.mechanism !== REQUIRED_MECHANISM) failures.push("mechanism");
  if (manifest.packaging?.launcherContract?.executable !== "libproot.so") failures.push("launcherContract");
  if (!Array.isArray(manifest.licenses) || manifest.licenses.length < 3) failures.push("licenses");
  return failures;
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  process.exit(selfTest());
}
if (args.length > 1) {
  console.error("Usage: node scripts/alpine-poc/validate-proot-runtime.mjs [manifestPath] | --self-test");
  process.exit(2);
}
process.exit(validate(args[0] ?? DEFAULT_MANIFEST));
