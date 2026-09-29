// Regression test: the bridge owner must keep serving new peer MCP processes
// while many others stay connected. The macOS host used to serve each peer on
// GCD's shared pool; every idle peer pinned a worker thread, and past ~64 of
// them the owner stopped answering (and stopped accepting) new peers.
//
//   node scripts/bridge-peers.test.mjs [path/to/munim-computer-use] [peers]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] ?? "macos/.build/release/munim-computer-use";
const peers = Number(process.argv[3] ?? 120);
// Short path: unix socket paths are limited to ~104 bytes.
const dir = mkdtempSync(join(tmpdir(), "cu-peers-"));
const profile = {
  name: "peers-test",
  envPrefix: "PEERS_TEST_",
  supportDir: dir,
  bridgeSocket: join(dir, "b.sock"),
  nativeHostNames: ["com.example.peers_test"],
  extensionIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
};
const rpcPath = join(dir, "b.sock.rpc");

const server = spawn(bin, ["--profile", JSON.stringify(profile)], { stdio: ["pipe", "pipe", "ignore"] });
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  server.kill();
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const connect = () =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(rpcPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });

server.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "peers-test", version: "1" } },
  }) + "\n",
);

for (let i = 0; i < 100 && !existsSync(rpcPath); i++) await sleep(100);
if (!existsSync(rpcPath)) fail("the server never bound its RPC socket");

const held = [];
for (let i = 0; i < peers; i++) {
  try {
    held.push(await connect());
  } catch (error) {
    fail(`peer ${i} of ${peers} was refused (${error.code})`);
  }
}
await sleep(500);

const probe = await connect().catch((error) => fail(`the probe peer was refused (${error.code})`));
const reply = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 5000);
  let buffer = "";
  probe.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.includes("\n")) {
      clearTimeout(timer);
      resolve(buffer.split("\n")[0]);
    }
  });
  probe.write(JSON.stringify({ id: 7, command: "list_tabs", params: { clientId: "probe" } }) + "\n");
});
if (!reply) fail(`no reply to a new peer while ${peers} others were connected`);
const parsed = JSON.parse(reply);
if (parsed.id !== 7) fail(`unexpected reply ${reply}`);

for (const socket of held) socket.destroy();
probe.destroy();
server.kill();
rmSync(dir, { recursive: true, force: true });
console.log(`ok: new peer served with ${peers} peers connected (${reply.slice(0, 80)})`);
