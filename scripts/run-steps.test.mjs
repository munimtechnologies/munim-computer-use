#!/usr/bin/env node
// run_steps over stdio against a built server, on any platform: the step plan
// is checked whole before anything runs, steps run in order with each outcome
// labelled, and the first failure stops the rest. Uses only wait and
// clipboard_* steps, which need no accessibility permission or open app.
//
//   node scripts/run-steps.test.mjs <path to munim-computer-use binary>
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const binary = process.argv[2];
if (!binary) {
  console.error("usage: node scripts/run-steps.test.mjs <server binary>");
  process.exit(2);
}

const server = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, COMPUTER_USE_BROWSER: "0" } });
const pending = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
let nextId = 0;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const runSteps = async (args) => (await request("tools/call", { name: "run_steps", arguments: args })).result;
const texts = (result) => result.content.filter((item) => item.type === "text").map((item) => item.text);

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "run-steps-test", version: "0" } });
const { tools } = (await request("tools/list", {})).result;
assert.ok(tools.some((tool) => tool.name === "run_steps"), "run_steps is advertised");

// Put the user's clipboard back afterwards (plain text only, like the tools).
const saved = (await request("tools/call", { name: "clipboard_read", arguments: { max_chars: 100000 } })).result;
const savedText = saved.isError || saved.content[0].text === "(the clipboard holds no text)" ? null : saved.content[0].text;

const marker = `run-steps ${process.pid}`;
const ok = await runSteps({
  steps: [
    { tool: "clipboard_write", args: { text: marker } },
    { tool: "wait", args: { seconds: 0.05 } },
    { tool: "clipboard_read" },
  ],
});
assert.equal(ok.isError, false, JSON.stringify(ok));
const lines = texts(ok);
assert.equal(lines[0], "ran all 3 steps");
assert.match(lines[1], /^1\. clipboard_write: copied \d+ characters/);
assert.match(lines[2], /^2\. wait: waited 0\.1s|^2\. wait: waited 0\.0s/);
assert.ok(lines[3].startsWith("3. clipboard_read: ") && lines[3].includes(marker), lines[3]);

const stopped = await runSteps({
  steps: [{ tool: "wait", args: { seconds: 0.01 } }, { tool: "wait", args: { seconds: -1 } }, { tool: "clipboard_write", args: { text: "never" } }],
});
assert.equal(stopped.isError, true);
assert.deepEqual(texts(stopped).slice(0, 1), ["stopped at step 2 of 3: wait failed, so step 3 did not run"]);
assert.equal(texts(stopped).length, 3, "the step after the failure did not run");
const after = await runSteps({ steps: [{ tool: "clipboard_read" }] });
assert.ok(texts(after)[1].includes(marker), "the clipboard still holds the marker, not 'never'");

const refused = await runSteps({ steps: [{ tool: "wait" }, { tool: "clik" }] });
assert.equal(refused.isError, true);
assert.deepEqual(texts(refused), ["error: step 2: unknown tool 'clik'; nothing was run"]);

const nested = await runSteps({ steps: [{ tool: "run_steps", args: { steps: [] } }] });
assert.deepEqual(texts(nested), ["error: step 1: run_steps cannot contain run_steps; nothing was run"]);

const disabled = await runSteps({ steps: [{ tool: "browser_list_tabs" }] });
assert.deepEqual(texts(disabled), ["error: step 1: unknown tool 'browser_list_tabs'; nothing was run"], "browser steps follow the browser setting");

if (savedText !== null) await request("tools/call", { name: "clipboard_write", arguments: { text: savedText } });
server.stdin.end();
console.log("run_steps OK: plan check, order, labels, stop at first failure");
