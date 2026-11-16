#!/usr/bin/env node
// Both MCP protocol eras over stdio against a built server, on any platform.
// Modern (2026-07-28) requests carry their revision and capabilities in
// `_meta` and need no handshake: server/discover, tools/list and tools/call
// answer in the modern envelope (resultType, serverInfo, cache hints), an
// unknown revision is refused with the supported list, and a request missing
// required `_meta` is invalid params. Legacy clients that open with initialize
// get exactly the answers they always did. Uses only the wait tool, which
// needs no permission or open app.
//
//   node scripts/mcp-protocol.test.mjs <path to munim-computer-use binary>
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const binary = process.argv[2];
if (!binary) {
  console.error("usage: node scripts/mcp-protocol.test.mjs <server binary>");
  process.exit(2);
}

const MODERN = "2026-07-28";
const meta = (version = MODERN, extra = {}) => ({
  _meta: {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "mcp-protocol-test", version: "0" },
    ...extra,
  },
});

function start() {
  const server = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, COMPUTER_USE_BROWSER: "0" } });
  const pending = new Map();
  const unsolicited = [];
  createInterface({ input: server.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    } else {
      unsolicited.push(message);
    }
  });
  let nextId = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `r${++nextId}`;
      const timer = setTimeout(() => reject(new Error(`${method} got no answer`)), 20_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    });
  const notify = (method, params) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { server, request, notify, unsolicited };
}

// ── modern: no initialize at all ────────────────────────────────────────────
{
  const { server, request, unsolicited } = start();

  const discovered = await request("server/discover", meta());
  assert.equal(discovered.error, undefined, JSON.stringify(discovered));
  const d = discovered.result;
  assert.equal(d.resultType, "complete");
  assert.equal(d.supportedVersions[0], MODERN);
  assert.ok(d.supportedVersions.includes("2025-11-25"), "legacy revisions stay listed for dual-era clients");
  assert.deepEqual(d.capabilities.tools, { listChanged: false });
  assert.equal(d._meta["io.modelcontextprotocol/serverInfo"].name, "mt-desktop");
  assert.match(d._meta["io.modelcontextprotocol/serverInfo"].version, /^\d+\.\d+\.\d+/);
  assert.ok(d.instructions.includes("get_app_state"));
  assert.ok(Number.isInteger(d.ttlMs) && d.ttlMs > 0);
  assert.ok(["public", "private"].includes(d.cacheScope));

  const listed = (await request("tools/list", meta())).result;
  assert.equal(listed.resultType, "complete");
  assert.ok(listed.tools.some((tool) => tool.name === "get_app_state"));
  assert.ok(!listed.tools.some((tool) => tool.name.startsWith("browser_")), "browser tools follow the setting");
  assert.ok(Number.isInteger(listed.ttlMs) && listed.ttlMs > 0);
  assert.equal(listed._meta["io.modelcontextprotocol/serverInfo"].name, "mt-desktop");
  const again = (await request("tools/list", meta())).result;
  assert.deepEqual(again.tools.map((tool) => tool.name), listed.tools.map((tool) => tool.name), "deterministic order");

  const waited = (await request("tools/call", { name: "wait", arguments: { seconds: 0.01 }, ...meta(MODERN, { traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01" }) })).result;
  assert.equal(waited.resultType, "complete");
  assert.equal(waited.isError, false, JSON.stringify(waited));
  assert.equal(waited.content[0].type, "text");

  const failed = (await request("tools/call", { name: "wait", arguments: { seconds: -1 }, ...meta() })).result;
  assert.equal(failed.resultType, "complete", "a tool error is still a complete result");
  assert.equal(failed.isError, true);

  const unsupported = await request("tools/list", meta("1900-01-01"));
  assert.equal(unsupported.error?.code, -32022, JSON.stringify(unsupported));
  assert.equal(unsupported.error.data.requested, "1900-01-01");
  assert.ok(unsupported.error.data.supported.includes(MODERN));

  const noCaps = await request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } });
  assert.equal(noCaps.error?.code, -32602, JSON.stringify(noCaps));

  // A dual-era client's stdio probe without `_meta` must fail, not succeed as legacy.
  const bare = await request("server/discover", {});
  assert.ok(bare.error, JSON.stringify(bare));

  const unknown = await request("resources/list", meta());
  assert.equal(unknown.error?.code, -32601, JSON.stringify(unknown));

  assert.deepEqual(unsolicited, [], "nothing is written that was not asked for");
  server.stdin.end();
}

// ── legacy: initialize, then bare requests, unchanged ───────────────────────
{
  const { server, request, notify, unsolicited } = start();
  const init = (await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "0" } })).result;
  assert.equal(init.protocolVersion, "2025-11-25");
  assert.equal(init.serverInfo.name, "mt-desktop");
  assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
  // A legacy client asking for a revision only the modern era has gets the oldest legacy one.
  const asked = (await request("initialize", { protocolVersion: MODERN, capabilities: {} })).result;
  assert.equal(asked.protocolVersion, "2024-11-05");
  notify("notifications/initialized", {});

  const listed = (await request("tools/list", {})).result;
  assert.equal(listed.resultType, undefined, "legacy answers carry no modern fields");
  assert.equal(listed.ttlMs, undefined);
  const waited = (await request("tools/call", { name: "wait", arguments: { seconds: 0.01 } })).result;
  assert.equal(waited.isError, false);
  assert.equal(waited.resultType, undefined);
  assert.deepEqual((await request("ping")).result, {});

  // The same process serves a modern request too: eras are chosen per request.
  const modern = (await request("tools/list", meta())).result;
  assert.equal(modern.resultType, "complete");
  assert.deepEqual(modern.tools, listed.tools);

  assert.deepEqual(unsolicited, [], "notifications are never answered");
  server.stdin.end();
}

console.log("mcp protocol OK: 2026-07-28 per-request _meta, server/discover, errors; legacy initialize unchanged");
