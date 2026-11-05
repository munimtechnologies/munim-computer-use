// Regression test: several servers started from the same binary must all be able
// to capture the screen, and a ScreenCaptureKit hang must cost one capture at
// most, not every capture after it.
//
// replayd, the daemon behind ScreenCaptureKit, keys an unbundled client by its
// executable path. Two servers run from one file used to evict each other's
// replayd connection in a loop (thousands of reconnects a second), and every
// capture in both timed out after 20 s until one of them exited. Each server
// now re-executes itself from a private hard link (PrivateExecutable.swift).
//
// Needs Screen Recording for the terminal that runs it, so it is a local check:
//
//   node scripts/capture-peers.test.mjs [path/to/munim-computer-use] [servers]
//
// MUNIM_COMPUTER_USE_SHARED_EXECUTABLE=1 turns the private path off, which
// brings the eviction loop back; the "peers" part should then fail.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = realpathSync(process.argv[2] ?? "macos/.build/release/munim-computer-use");
const count = Number(process.argv[3] ?? 3);
const dir = mkdtempSync(join(tmpdir(), "cu-capture-"));
const profile = JSON.stringify({
  name: "capture-peers-test",
  envPrefix: "CAPTURE_PEERS_TEST_",
  supportDir: dir,
  bridgeSocket: join(dir, "b.sock"),
  nativeHostNames: ["com.example.capture_peers_test"],
  extensionIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
});

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`FAIL: ${message}`);
};

function startServer(extraEnv = {}) {
  const child = spawn(bin, ["--profile", profile], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  let buffer = "";
  let stderr = "";
  const waiting = new Map();
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const request = (method, params, timeoutMs = 45000) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(null);
      }, timeoutMs);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args) => {
    const started = Date.now();
    const message = await request("tools/call", { name, arguments: args });
    const content = message?.result?.content ?? [];
    return {
      seconds: (Date.now() - started) / 1000,
      image: content.some((part) => part.type === "image"),
      text: content.filter((part) => part.type === "text").map((part) => part.text).join(" | "),
    };
  };
  const ready = request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "capture-peers-test", version: "0" },
  }).then(() => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"));
  const stop = () =>
    new Promise((resolve) => {
      child.once("exit", resolve);
      child.stdin.end();
      setTimeout(() => child.kill("SIGKILL"), 5000);
    });
  return { child, ready, call, stop, stderr: () => stderr };
}

/// The file the kernel runs for `pid` (lsof's txt entry), not argv[0].
function executableOf(pid) {
  const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { encoding: "utf8" });
  return out.split("\n").find((line) => line.startsWith("n"))?.slice(1);
}

const linkDir = (pid) => join(realpathSync(dir), "exec", String(pid));
const shared = process.env.MUNIM_COMPUTER_USE_SHARED_EXECUTABLE === "1";

try {
  // 1. Peers: every server captures, concurrently, twice.
  const servers = Array.from({ length: count }, () => startServer());
  await Promise.all(servers.map((server) => server.ready));
  const paths = servers.map((server) => executableOf(server.child.pid));
  console.log(`executables:\n  ${paths.join("\n  ")}`);
  if (!shared) {
    if (new Set(paths).size !== paths.length) fail("two servers share an executable path");
    servers.forEach((server, i) => {
      if (!paths[i]?.startsWith(linkDir(server.child.pid) + "/")) {
        fail(`server ${server.child.pid} runs ${paths[i]}, not its link under ${linkDir(server.child.pid)}`);
      }
    });
  }
  for (const round of [1, 2]) {
    const shots = await Promise.all(servers.map((server) => server.call("screenshot", { display: 0 })));
    shots.forEach((shot, i) => {
      const label = `round ${round}, server ${servers[i].child.pid}`;
      console.log(`${label}: ${shot.seconds.toFixed(2)} s, ${shot.image ? "image" : "no image"}`);
      if (!shot.image) fail(`${label}: no image (${shot.text.slice(0, 200)})`);
      else if (shot.seconds > 10) fail(`${label}: took ${shot.seconds.toFixed(1)} s`);
    });
  }
  await Promise.all(servers.map((server) => server.stop()));
  servers.forEach((server) => {
    if (existsSync(linkDir(server.child.pid))) fail(`server ${server.child.pid} left ${linkDir(server.child.pid)} behind`);
  });

  // 2. Hang: ScreenCaptureKit never answers. The first capture of each kind
  // waits out its timeout and comes back from the screencapture fallback; the
  // ones after it skip ScreenCaptureKit and come back at once.
  const hung = startServer({ MUNIM_COMPUTER_USE_TEST_SCK_HANG: "1" });
  await hung.ready;
  // The frontmost app has a window to capture.
  const front = execFileSync(
    "osascript", ["-e", 'tell application "System Events" to name of first process whose frontmost is true'],
    { encoding: "utf8" },
  ).trim();
  const steps = [
    ["display, waits out the timeout", "screenshot", { display: 0 }, 25],
    ["display again", "screenshot", { display: 0 }, 5],
    ["zoom", "zoom", { x0: 0, y0: 0, x1: 400, y1: 300 }, 5],
    [`window (${front})`, "screenshot", { app: front }, 5],
  ];
  for (const [label, name, args, limit] of steps) {
    const shot = await hung.call(name, args);
    console.log(`hang, ${label}: ${shot.seconds.toFixed(2)} s, ${shot.image ? "image" : "no image"}`);
    if (!shot.image) fail(`hang, ${label}: no image (${shot.text.slice(0, 200)})`);
    if (shot.seconds > limit) fail(`hang, ${label}: took ${shot.seconds.toFixed(1)} s (limit ${limit} s)`);
  }
  if (!/capturing with screencapture/.test(hung.stderr())) fail("the hang was not reported on stderr");
  await hung.stop();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("PASS");
