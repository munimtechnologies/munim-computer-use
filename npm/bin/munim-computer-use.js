#!/usr/bin/env node
// Launcher for the Computer Use MCP server.
//
// The server itself is a native binary (Swift on macOS, Rust on Windows and
// Linux). npm is the distribution channel MCP clients already know how to run,
// so this script fetches the signed release binary that matches this package's
// version into a per-user cache on first run, then execs it with stdio passed
// straight through — the MCP conversation never touches Node.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const pkg = require("../package.json");
const REPO = "munimtechnologies/munim-computer-use";
const VERSION = pkg.version;

function assetFor(platform, arch) {
  if (platform === "darwin")
    return { asset: "munim-computer-use-macos-universal.zip", binary: "munim-computer-use" };
  if (platform === "win32" && arch === "x64")
    return { asset: "munim-computer-use-windows-x64.zip", binary: "munim-computer-use.exe" };
  return null;
}

function cacheDir() {
  const base =
    process.env.COMPUTER_USE_CACHE_DIR ||
    (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), "munim-computer-use")
      : path.join(
          process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
          "munim-computer-use",
        ));
  return path.join(base, VERSION);
}

// A stalled connection must not hang the MCP client's startup forever.
const DOWNLOAD_TIMEOUT_MS = Number(process.env.COMPUTER_USE_DOWNLOAD_TIMEOUT_MS) || 120_000;

async function download(url, dest) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  }).catch((error) => {
    if (error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}`);
    throw error;
  });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, bytes);
}

function extractZip(zipPath, dir) {
  // bsdtar on macOS and tar.exe on Windows 10+ both open zip archives, so no
  // dependency is needed for the two platforms that get prebuilt binaries.
  const result = spawnSync("tar", ["-xf", zipPath, "-C", dir], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("could not extract the release archive with tar");
}

async function ensureBinary() {
  // The override comes first so platforms without a prebuilt binary (Linux,
  // Windows on ARM) can still run a binary built from source.
  const override = process.env.COMPUTER_USE_BINARY;
  if (override) return override;

  const target = assetFor(process.platform, process.arch);
  if (!target) {
    console.error(
      `munim-computer-use: no prebuilt binary for ${process.platform}/${process.arch}.\n` +
        `Build from source: https://github.com/${REPO}#build-from-source\n` +
        `then point COMPUTER_USE_BINARY at the result.`,
    );
    process.exit(1);
  }

  const dir = cacheDir();
  const binary = path.join(dir, target.binary);
  if (fs.existsSync(binary)) return binary;

  // Download and extract into a private staging directory, then rename it into
  // place. A crash, a timeout or two MCP clients starting at once can then never
  // leave a half-written binary in the cache that later runs would trust.
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, `.${VERSION}-download-`));
  try {
    const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${target.asset}`;
    const zipPath = path.join(staging, target.asset);
    console.error(`munim-computer-use: downloading ${target.asset} (v${VERSION})…`);
    await download(url, zipPath);
    extractZip(zipPath, staging);
    fs.rmSync(zipPath, { force: true });
    const staged = path.join(staging, target.binary);
    if (!fs.existsSync(staged)) throw new Error(`archive did not contain ${target.binary}`);
    if (process.platform !== "win32") fs.chmodSync(staged, 0o755);
    // A cache directory without the binary is debris from an older launcher
    // that extracted in place and was interrupted; replace it.
    if (fs.existsSync(dir) && !fs.existsSync(binary)) fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      // Another launcher finished first; its copy is just as good.
      if (!fs.existsSync(binary)) throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  if (!fs.existsSync(binary)) throw new Error(`could not install ${target.binary} into ${dir}`);
  return binary;
}

async function main() {
  const binary = await ensureBinary();
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
  child.on("error", (error) => {
    console.error(`munim-computer-use: could not start ${binary}: ${error.message}`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(`munim-computer-use: ${error.message}`);
  process.exit(1);
});
