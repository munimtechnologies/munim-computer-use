#!/usr/bin/env node
// Manual smoke for launch_app on a real desktop, over stdio with modern
// (2026-07-28) requests, under a throwaway identity so it shares nothing
// (support dir, Chrome bridge, agent pointer) with an installed copy.
// Run from a terminal on the signed-in desktop (not over ssh):
//   node scripts/launch-app-smoke.mjs <server binary> [app name, default calc]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [binary, app = "calc"] = process.argv.slice(2);
const profile = JSON.stringify({ name: "munim-smoke", agentCursorName: "MunimSmokeCursor", agentCursorBundleId: "com.munimtech.smoke.agent-cursor" });
const server = spawn(binary, ["--profile", profile], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, COMPUTER_USE_BROWSER: "0" } });
const pending = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
});
let id = 0;
const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const call = (method, params = {}) =>
  new Promise((resolve) => {
    pending.set(++id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } }) + "\n");
  });
const tool = async (name, args) => {
  const { result, error } = await call("tools/call", { name, arguments: args });
  if (error) return `JSON-RPC error ${error.code}: ${error.message}`;
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
};

const discovered = (await call("server/discover")).result;
console.log("server/discover:", discovered.supportedVersions.join(", "), "| tools/list ttlMs", (await call("tools/list")).result.ttlMs);
const launched = await tool("launch_app", { app });
console.log("launch_app:", launched);
console.log("launch_app again:", await tool("launch_app", { app }));
const pid = /pid (\d+)/.exec(launched)?.[1];
if (pid) console.log("get_app_state:", (await tool("get_app_state", { app: pid, max_elements: 30 })).slice(0, 1500));
console.log("unknown:", await tool("launch_app", { app: "zzqx-no-such-app", wait_seconds: 0 }));
server.stdin.end();
