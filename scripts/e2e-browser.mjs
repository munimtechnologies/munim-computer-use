#!/usr/bin/env node
// End-to-end check of the browser tools against a real Chrome, isolated from
// the user's own: a throwaway Chrome for Testing profile, an extension build
// with its own native-messaging host name, and a server running under its own
// identity (support dir, bridge socket). Nothing the user's Chrome or another
// Computer Use server is using is touched.
//
//   node scripts/e2e-browser.mjs --server <munim-computer-use binary> --chrome <Chrome for Testing binary>
//       [--headed] [--shots <dir>]
//
// Chrome for Testing is the one to use: branded Chrome ignores --load-extension.
// Playwright caches one (`npx playwright install chromium`).
//
// It serves a small site on 127.0.0.1, then checks page reading, return_state,
// that password values never reach the model, the credential prompt (answered
// the way a person would, by typing into the prompt window), and site rules.
// Exit code 0 means every check passed.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const serverBinary = option("--server");
const chromeBinary = option("--chrome");
if (!serverBinary || !chromeBinary) {
  console.error("usage: node scripts/e2e-browser.mjs --server <binary> --chrome <Chrome for Testing binary> [--headed]");
  process.exit(2);
}

const HOST = "com.munimtech.cu_e2e";
const SECRET = "correct-horse-battery-staple";
const PREFILLED = "PREFILLED-VALUE-MUST-NOT-LEAK";
const sleep = (ms) => new Promise((resume) => setTimeout(resume, ms));

// Short base path: a Unix socket path must fit in 104 bytes on macOS.
const root = fs.mkdtempSync(path.join(os.platform() === "win32" ? os.tmpdir() : "/tmp", "cu-e2e-"));
const children = [];
function cleanup() {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
}
process.on("exit", cleanup);

// ── the site ────────────────────────────────────────────────────────────────

const article = [
  "<h1>Field guide</h1>",
  "<p>Introductory paragraph about the guide.</p>",
  "<h2>Pricing</h2>",
  "<p>The Pro plan costs $20 a month.</p>",
  ...Array.from({ length: 40 }, (_, i) => `<p>Filler paragraph number ${i} with some words in it.</p>`),
  "<h2>Contact</h2><p>Write to the team.</p>",
  '<a href="/next">Next page</a>',
].join("\n");
const pages = {
  "/article": `<title>Article</title>${article}`,
  "/login": `<title>Sign in</title>
    <form onsubmit="event.preventDefault(); document.title = 'Signed in as ' + email.value;">
      <label for="email">Email</label><input id="email" type="email">
      <label for="pw">Password</label><input id="pw" type="password" value="${PREFILLED}">
      <button id="go">Sign in</button>
    </form>
    <a href="/next">Next page</a>`,
  "/next": "<title>Next</title><h1>You made it</h1><button>Continue</button>",
};
const site = http.createServer((req, res) => {
  const body = pages[req.url.split("?")[0]];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(body ? `<!doctype html><meta charset="utf-8">${body}` : "not found");
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${site.address().port}`;
const otherBase = `http://localhost:${site.address().port}`;

// ── extension, host manifest, identity ──────────────────────────────────────

const extensionDir = path.join(root, "extension");
const built = JSON.parse(
  execFileSync(process.execPath, [path.join(here, "build-extension.mjs"), "--out", extensionDir, "--host", HOST], {
    encoding: "utf8",
  }),
);
const userDataDir = path.join(root, "chrome");
const profilePath = path.join(root, "profile.json");
fs.writeFileSync(
  profilePath,
  JSON.stringify({
    name: "cu-e2e",
    supportDir: path.join(root, "support"),
    bridgeSocket: path.join(root, "b.sock"),
    nativeHostNames: [HOST],
    extensionIds: [built.extensionId],
  }),
);
const wrapper = path.join(root, "native-host");
fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${serverBinary}' --profile '${profilePath}' native-host\n`, { mode: 0o755 });
// With --user-data-dir, Chrome reads user-level host manifests from inside it.
fs.mkdirSync(path.join(userDataDir, "NativeMessagingHosts"), { recursive: true });
fs.writeFileSync(
  path.join(userDataDir, "NativeMessagingHosts", `${HOST}.json`),
  JSON.stringify({ name: HOST, description: "Computer Use e2e", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${built.extensionId}/`] }),
);
const policyPath = path.join(root, "policy.json");

// ── the MCP server ──────────────────────────────────────────────────────────

const server = spawn(serverBinary, ["--profile", profilePath], {
  env: { ...process.env, COMPUTER_USE_POLICY: policyPath },
  stdio: ["pipe", "pipe", "pipe"],
});
children.push(server);
let serverLog = "";
server.stderr.on("data", (chunk) => (serverLog += chunk));
let buffer = "";
const waiting = new Map();
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  }
});
let nextId = 1;
function rpc(method, params = {}) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => waiting.set(id, resolve));
}
// Every browser call carries a session id. Besides isolating the run, that
// makes the macOS server refuse outright when the extension is not connected,
// instead of falling back to AppleScript — which drives the user's real Chrome.
const SESSION = "e2e";
async function tool(name, args = {}) {
  if (name.startsWith("browser_")) args = { session_id: SESSION, ...args };
  const reply = await rpc("tools/call", { name, arguments: args });
  const text = reply.result?.content?.[0]?.text ?? JSON.stringify(reply);
  return { text, isError: reply.result?.isError === true };
}
async function ok(name, args) {
  const result = await tool(name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.text}`);
  return result.text;
}

await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });

// ── Chrome ──────────────────────────────────────────────────────────────────

const chromeArgs = [
  `--user-data-dir=${userDataDir}`,
  `--load-extension=${extensionDir}`,
  `--disable-extensions-except=${extensionDir}`,
  "--remote-debugging-port=0",
  // Without this, a fresh profile on macOS waits forever on a Keychain prompt
  // for "Chrome Safe Storage" and never opens its DevTools port.
  "--use-mock-keychain",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  argv.includes("--headed") ? "--window-position=40,40" : "--headless=new",
  // Ubuntu 23.10+ blocks the unprivileged user namespaces Chrome's sandbox
  // needs ("No usable sandbox"). This browser only ever loads the local test
  // site, so running it unsandboxed is fine.
  ...(os.platform() === "linux" ? ["--no-sandbox"] : []),
  "about:blank",
];
const chrome = spawn(chromeBinary, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
children.push(chrome);
let chromeLog = "";
chrome.stderr.on("data", (chunk) => (chromeLog += chunk));
// Chrome writes the port it picked to DevToolsActivePort in the profile.
let devtoolsPort;
for (let attempt = 0; attempt < 200 && !devtoolsPort; attempt++) {
  try {
    devtoolsPort = Number(fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0]);
  } catch {
    await sleep(100);
  }
}
if (!devtoolsPort) throw new Error(`Chrome did not start:\n${chromeLog}`);

/** Evaluate in the first DevTools target whose URL matches. */
async function evaluateIn(match, expression, method = "Runtime.evaluate") {
  for (let attempt = 0; attempt < 100; attempt++) {
    const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json();
    const target = targets.find((entry) => match(entry.url));
    if (target) {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
      const answer = new Promise((resolve) =>
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.id === 1) resolve(method === "Runtime.evaluate" ? message.result?.result?.value : message.result);
        }),
      );
      const params = method === "Runtime.evaluate" ? { expression, awaitPromise: true, returnByValue: true } : expression;
      socket.send(JSON.stringify({ id: 1, method, params }));
      const value = await answer;
      socket.close();
      return value;
    }
    await sleep(100);
  }
  throw new Error("no DevTools target matched");
}
/**
 * Evaluate in every DevTools target whose URL matches, until one returns a
 * value other than null. A popup can list more than one target for the same
 * URL for a moment (the document it started with and the one it navigated
 * to), and only the live one has run its script, so the first match is not
 * necessarily the page on screen.
 */
async function evaluateInLive(match, expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json();
    for (const target of targets.filter((entry) => entry.type === "page" && match(entry.url))) {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
      const value = await new Promise((resolve) => {
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.id === 1) resolve(message.result?.result?.value ?? null);
        });
        socket.send(
          JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
        );
      });
      socket.close();
      if (value !== null) return value;
    }
    await sleep(100);
  }
  throw new Error("no live DevTools target answered");
}
// Each prompt window is prompt.html#<id>, ids counting up. An answered one can
// linger in the target list for a moment, so always take the newest.
let lastPrompt = 0;
const promptId = (url) =>
  url.startsWith(`chrome-extension://${built.extensionId}/prompt.html#`) ? Number(url.split("#")[1]) : 0;
const isPrompt = (url) => promptId(url) > lastPrompt;
const shotsDir = option("--shots");
/** With --shots, save what the newest prompt window looks like. */
async function shootPrompt(name) {
  if (!shotsDir) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  const shot = await evaluateIn(isPrompt, { format: "png" }, "Page.captureScreenshot");
  fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(shot.data, "base64"));
}
async function inNewPrompt(expression) {
  const value = await evaluateIn(isPrompt, expression);
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json();
  lastPrompt = Math.max(lastPrompt, ...targets.map((target) => promptId(target.url)));
  return value;
}

// The extension connects when its service worker starts; wait for the bridge.
let connected = false;
for (let attempt = 0; attempt < 60 && !connected; attempt++) {
  connected = !(await tool("browser_list_tabs")).isError;
  if (!connected) await sleep(500);
}
if (!connected) {
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json().catch(() => []);
  console.error("targets:", targets.map((target) => `${target.type} ${target.url}`).join("\n  "));
  console.error("server stderr:\n" + serverLog);
  throw new Error("the extension never connected to the server");
}

// ── checks ──────────────────────────────────────────────────────────────────

const checks = [];
const check = (name, body) => checks.push([name, body]);
let tab;

check("tools/list advertises browser_read and browser_request_credentials", async () => {
  const reply = await rpc("tools/list");
  const names = reply.result.tools.map((entry) => entry.name);
  assert.equal(names.length, 32);
  assert.ok(names.includes("browser_read") && names.includes("browser_request_credentials"));
});

check("browser_read returns the page text with headings", async () => {
  const opened = await ok("browser_open_tab", { url: `${base}/article` });
  if (!/tab_id=\d+/.test(opened)) throw new Error(`open_tab said: ${opened}`);
  tab = Number(/tab_id=(\d+)/.exec(opened)[1]);
  await sleep(800);
  const text = await ok("browser_read", { tab_id: tab });
  assert.match(text, /^Article {2}\[/);
  assert.match(text, /# Field guide/);
  assert.match(text, /## Pricing\n+The Pro plan costs \$20 a month\./);
});

check("browser_read query narrows to matching lines under their heading", async () => {
  const text = await ok("browser_read", { tab_id: tab, query: "costs" });
  assert.match(text, /1 matching line/);
  assert.match(text, /## Pricing/);
  assert.doesNotMatch(text, /Filler paragraph number 30/);
});

check("browser_read chunks long pages and continues from offset", async () => {
  const first = await ok("browser_read", { tab_id: tab, max_chars: 200 });
  const offset = Number(/offset=(\d+)/.exec(first)[1]);
  assert.equal(offset, 200);
  const second = await ok("browser_read", { tab_id: tab, offset, max_chars: 200 });
  assert.match(second, /showing characters 200–400/);
});

check("browser_read include_links lists links", async () => {
  const text = await ok("browser_read", { tab_id: tab, include_links: true, query: "zzzz-none" });
  assert.match(text, new RegExp(`Next page {2}\\[${base}/next\\]`));
});

check("browser_click with return_state comes back with the next page", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: tab });
  const index = /\[(\d+)\] a "Next page"/.exec(snapshot)[1];
  const text = await ok("browser_click", { tab_id: tab, index: Number(index), return_state: true });
  assert.match(text, /page after the action/);
  assert.match(text, /Next {2}\[.*\/next\]/);
  assert.match(text, /button "Continue"/);
});

check("browser_navigate with return_state waits for the load", async () => {
  const text = await ok("browser_navigate", { tab_id: tab, url: `${base}/login`, return_state: true });
  assert.match(text, /Sign in {2}\[/);
  assert.match(text, /input\[password\]/);
});

check("a password field's value never appears in a snapshot", async () => {
  const text = await ok("browser_snapshot", { tab_id: tab });
  assert.match(text, /input\[password\]/);
  assert.ok(!text.includes(PREFILLED), text);
});

check("browser_request_credentials fills the page without returning the values", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: tab });
  const email = Number(/\[(\d+)\] input\[email\]/.exec(snapshot)[1]);
  const password = Number(/\[(\d+)\] input\[password\]/.exec(snapshot)[1]);
  const pending = tool("browser_request_credentials", {
    tab_id: tab,
    fields: [{ index: email }, { index: password }],
    reason: "Sign in to run the e2e check",
  });
  // Play the person: read what the prompt shows, type, press Fill in.
  const shown = await evaluateIn(isPrompt, `new Promise((resolve) => {
    const ready = () => document.querySelectorAll('input').length === 2;
    const go = () => resolve({ title: document.getElementById('title').textContent, origin: document.getElementById('origin').textContent,
      reason: document.getElementById('reason').textContent, types: [...document.querySelectorAll('input')].map((i) => i.type) });
    if (ready()) go(); else { const t = setInterval(() => { if (ready()) { clearInterval(t); go(); } }, 20); }
  })`);
  assert.equal(shown.origin, base);
  assert.equal(shown.reason, "Sign in to run the e2e check");
  assert.deepEqual(shown.types, ["email", "password"]);
  await shootPrompt("credentials");
  await inNewPrompt(`(() => {
    const [email, password] = document.querySelectorAll('input');
    email.value = 'person@example.com';
    password.value = ${JSON.stringify(SECRET)};
    document.getElementById('ok').click();
    return true;
  })()`);
  const result = await pending;
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /the user filled 2 fields/);
  assert.ok(!result.text.includes(SECRET));
  const values = await evaluateIn((url) => url.startsWith(`${base}/login`), "[email.value, pw.value]");
  assert.deepEqual(values, ["person@example.com", SECRET]);
  const after = await ok("browser_snapshot", { tab_id: tab });
  assert.ok(!after.includes(SECRET), "the filled password is not in a snapshot");
});

check("closing the sign-in window reports a cancel and fills nothing", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: tab });
  const email = Number(/\[(\d+)\] input\[email\]/.exec(snapshot)[1]);
  const pending = tool("browser_request_credentials", { tab_id: tab, fields: [{ index: email }] });
  await inNewPrompt(`new Promise((resolve) => {
    const t = setInterval(() => { const button = document.getElementById('cancel'); if (document.querySelector('input')) { clearInterval(t); button.click(); resolve(true); } }, 20);
  })`);
  const result = await pending;
  assert.match(result.text, /cancelled/);
});

check("a blocked site is refused", async () => {
  fs.writeFileSync(policyPath, JSON.stringify({ sites: { localhost: "block" } }));
  const result = await tool("browser_navigate", { tab_id: tab, url: `${otherBase}/article` });
  assert.equal(result.isError, true);
  assert.match(result.text, /blocked by the user's Computer Use policy/);
});

check("the tab's current page is checked too, not only where it navigates", async () => {
  fs.writeFileSync(policyPath, JSON.stringify({ sites: { "127.0.0.1": "block" } }));
  const result = await tool("browser_snapshot", { tab_id: tab });
  assert.equal(result.isError, true);
  assert.match(result.text, /blocked/);
});

check("an ask rule shows an approval prompt, once", async () => {
  fs.writeFileSync(policyPath, JSON.stringify({ sites: { localhost: "ask" } }));
  const pending = tool("browser_navigate", { tab_id: tab, url: `${otherBase}/next` });
  const approvalShown = `document.getElementById('title')?.textContent.startsWith('Let') ? true : null`;
  await evaluateInLive(isPrompt, approvalShown);
  await shootPrompt("approve-site");
  const title = await evaluateInLive(
    isPrompt,
    `(() => {
      const title = document.getElementById('title')?.textContent ?? '';
      if (!title.startsWith('Let')) return null;
      document.getElementById('ok').click();
      return title;
    })()`,
  );
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json();
  lastPrompt = Math.max(lastPrompt, ...targets.map((target) => promptId(target.url)));
  assert.match(title, /Let the agent open localhost/);
  const result = await pending;
  assert.equal(result.isError, false, result.text);
  const again = await tool("browser_snapshot", { tab_id: tab });
  assert.equal(again.isError, false, "no second prompt for the same origin");
});

check("an invalid policy file blocks instead of being ignored", async () => {
  fs.writeFileSync(policyPath, "{ not json");
  const result = await tool("browser_snapshot", { tab_id: tab });
  assert.equal(result.isError, true);
  assert.match(result.text, /policy file .* is invalid/);
  fs.rmSync(policyPath);
});

let failed = 0;
for (const [name, body] of checks) {
  try {
    await body();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
await tool("browser_close_all_tabs");
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\n${checks.length} passed`);
site.close();
process.exit(failed ? 1 : 0);
