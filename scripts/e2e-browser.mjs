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
const root = fs.mkdtempSync(path.join(os.platform() === "win32" ? (process.env.TMPDIR || os.tmpdir()) : "/tmp", "cu-e2e-"));
const children = [];
function cleanup() {
  for (const child of children) {
    try {
      // Each POSIX child owns an isolated process group, including Chromium's
      // renderers and native hosts. Killing just its launcher leaves writers.
      if (os.platform() === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  // Chrome's children may still be exiting after SIGKILL; retry filesystem races.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  "/spa": `<title>Delayed dialog</title><button id="open">Open dialog</button><script>
    window.clicks = 0;
    document.getElementById('open').onclick = () => {
      window.clicks++;
      setTimeout(() => {
        const modal = document.createElement('div');
        modal.setAttribute('role', 'dialog');
        modal.innerHTML = '<h1>Connect your Domain</h1><input aria-label="Domain"><button>Next</button>';
        document.body.append(modal);
      }, 1100);
    };
  </script>`,
  "/article": `<title>Article</title>${article}`,
  "/login": `<title>Sign in</title>
    <form onsubmit="event.preventDefault(); document.title = 'Signed in as ' + email.value;">
      <label for="email">Email</label><input id="email" type="email">
      <label for="pw">Password</label><input id="pw" type="password" value="${PREFILLED}">
      <button id="go">Sign in</button>
    </form>
    <a href="/next">Next page</a>`,
  "/next": "<title>Next</title><h1>You made it</h1><button>Continue</button>",
  // Issue #42: a menu that, like Gmail's, opens only for a press that carries
  // the left button's state. Every press event is logged with its metadata.
  "/press": `<title>Press</title><button id="more" aria-label="More message options">More</button>
    <div id="menu" role="menu" hidden><div role="menuitem">Report</div></div><script>
    window.presses = [];
    const more = document.getElementById('more');
    more.addEventListener('pointerdown', (e) => presses.push(['pointerdown', e.isTrusted, e.buttons, e.pointerType]));
    more.addEventListener('mousedown', (e) => {
      presses.push(['mousedown', e.isTrusted, e.buttons, e.detail]);
      if (e.buttons === 1) document.getElementById('menu').hidden = false;
    });
    more.addEventListener('mouseup', (e) => presses.push(['mouseup', e.isTrusted, e.buttons, e.detail]));
    more.addEventListener('click', (e) => presses.push(['click', e.isTrusted, e.detail, e.pointerType]));
  </script>`,
};
// Background editing: a button that, like an Angular Material one, ignores
// synthetic clicks; fields of every kind, some inside a web component; and
// rows of a table, an ARIA grid and custom elements, as a users list has.
const LONG_TEXT = Array.from({ length: 32 }, (_, i) => `Line ${i} of the old description, long enough to matter.`).join("\n");
pages["/editor"] = `<title>Editor</title>
  <button id="edit">Edit</button>
  <div id="dialog" role="dialog" hidden><h2>Edit details</h2><button id="save">Save</button></div>
  <input id="name" aria-label="Name" value="Old name">
  <textarea id="about" aria-label="About">${LONG_TEXT}</textarea>
  <div id="rich" contenteditable="true" aria-label="Rich">Old <b>rich</b> text</div>
  <x-field></x-field>
  <input id="code" aria-label="Code" maxlength="4">
  <input id="locked" aria-label="Locked" value="keep">
  <table><tr><th>Name</th><th>Role</th></tr><tr><td>Cara</td><td>Owner</td></tr></table>
  <div role="grid"><div role="row"><div role="gridcell">Ben</div><div role="gridcell">Viewer</div></div></div>
  <x-list><x-row id="ana" style="display:block;cursor:pointer"><x-cell>Ana</x-cell> <x-cell>Admin</x-cell></x-row></x-list>
  <script>
    window.events = [];
    window.rowClicks = [];
    for (const type of ['beforeinput', 'input']) addEventListener(type, (e) => events.push([type, e.isTrusted]), true);
    document.getElementById('edit').addEventListener('click', (e) => {
      if (e.isTrusted) document.getElementById('dialog').hidden = false;
    });
    document.getElementById('ana').addEventListener('click', (e) => rowClicks.push(e.isTrusted));
    document.getElementById('locked').addEventListener('beforeinput', (e) => e.preventDefault());
    customElements.define('x-field', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML =
          '<input id="inner" aria-label="Shadow input" value="shadow old">' +
          '<div id="innerRich" contenteditable="true" aria-label="Shadow rich">shadow rich old</div>';
      }
    });
  </script>`;
pages["/user"] = "<title>User window</title><h1>The user's own page</h1>";
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
  detached: os.platform() !== "win32",
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
const chrome = spawn(chromeBinary, chromeArgs, { detached: os.platform() !== "win32", stdio: ["ignore", "ignore", "pipe"] });
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
/** One command on the browser-wide DevTools session (windows, targets). */
async function browserCommand(method, params = {}) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const answer = new Promise((resolve) =>
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) resolve(message.result ?? message.error);
    }),
  );
  socket.send(JSON.stringify({ id: 1, method, params }));
  const value = await answer;
  socket.close();
  return value;
}
/**
 * Evaluate in every DevTools target whose URL matches, until one returns a
 * value other than null. A popup can list more than one target for the same
 * URL for a moment (the document it started with and the one it navigated
 * to), and only the live one has run its script, so the first match is not
 * necessarily the page on screen.
 */
/**
 * One Runtime.evaluate in one target, or null if it errors, closes, or stays
 * silent for two seconds: a target that has already gone away can accept the
 * socket and then never answer, and waiting on it hung the whole run.
 */
function evaluateTarget(webSocketUrl, expression) {
  return new Promise((resolve) => {
    const socket = new WebSocket(webSocketUrl);
    const done = (value) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 2000);
    socket.addEventListener("error", () => done(null), { once: true });
    socket.addEventListener("close", () => done(null), { once: true });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) done(message.result?.result?.value ?? null);
    });
    socket.addEventListener(
      "open",
      () =>
        socket.send(
          JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
        ),
      { once: true },
    );
  });
}

async function evaluateInLive(match, expression) {
  let targets = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json();
    for (const target of targets.filter((entry) => entry.type === "page" && match(entry.url))) {
      if (!target.webSocketDebuggerUrl) continue;
      const value = await evaluateTarget(target.webSocketDebuggerUrl, expression);
      if (value !== null) return value;
    }
    await sleep(100);
  }
  // Say what was there, so a CI failure shows whether the window never opened,
  // was already gone, or was open but never matched.
  const seen = targets.map((target) => `${target.type} ${target.url}`).join("; ");
  throw new Error(`no live DevTools target answered (last prompt ${lastPrompt}; targets: ${seen})`);
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
/** Evaluate in the prompt on screen (see evaluateInLive), then retire it. */
async function inNewPrompt(expression) {
  const value = await evaluateInLive(isPrompt, expression);
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
  assert.equal(names.length, 34);
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

check("return_state waits for a delayed SPA dialog after exactly one click", async () => {
  await ok("browser_navigate", { tab_id: tab, url: `${base}/spa`, return_state: true });
  const snapshot = await ok("browser_snapshot", { tab_id: tab });
  const index = Number(/\[(\d+)\] button "Open dialog"/.exec(snapshot)[1]);
  const text = await ok("browser_click", {
    tab_id: tab, index, return_state: true, wait_for_selector: "[role=dialog] button", wait_timeout_ms: 3000,
  });
  assert.match(text, /readiness: met \(visible_selector/);
  assert.match(text, /button "Next"/);
  const counts = await evaluateIn((url) => url === `${base}/spa`, "[window.clicks, document.querySelectorAll('[role=dialog]').length, location.href]");
  assert.deepEqual(counts, [1, 1, `${base}/spa`]);
});

check("a timed-out SPA observation can be waited on without clicking again", async () => {
  await ok("browser_navigate", { tab_id: tab, url: `${base}/spa`, return_state: true });
  const snapshot = await ok("browser_snapshot", { tab_id: tab });
  const index = Number(/\[(\d+)\] button "Open dialog"/.exec(snapshot)[1]);
  const text = await ok("browser_click", {
    tab_id: tab, index, return_state: true, wait_for_selector: "[role=dialog] button", wait_timeout_ms: 0,
  });
  assert.match(text, /clicked in tab/);
  assert.match(text, /readiness: timeout/);
  const observed = await ok("browser_snapshot", { tab_id: tab, wait_for_selector: "[role=dialog] button", wait_timeout_ms: 3000 });
  assert.match(observed, /readiness: met/);
  assert.match(observed, /button "Next"/);
  assert.deepEqual(await evaluateIn((url) => url === `${base}/spa`, "[window.clicks, document.querySelectorAll('[role=dialog]').length]"), [1, 1]);
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
  const shown = await evaluateInLive(
    isPrompt,
    `document.querySelectorAll('input').length !== 2 ? null : {
      title: document.getElementById('title').textContent,
      origin: document.getElementById('origin').textContent,
      reason: document.getElementById('reason').textContent,
      types: [...document.querySelectorAll('input')].map((i) => i.type),
    }`,
  );
  assert.equal(shown.origin, base);
  assert.equal(shown.reason, "Sign in to run the e2e check");
  assert.deepEqual(shown.types, ["email", "password"]);
  await shootPrompt("credentials");
  await inNewPrompt(`(() => {
    if (document.querySelectorAll('input').length !== 2) return null;
    const [email, password] = document.querySelectorAll('input');
    email.value = 'person@example.com';
    password.value = ${JSON.stringify(SECRET)};
    setTimeout(() => document.getElementById('ok').click(), 0);
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
  await inNewPrompt(`(() => {
    if (!document.querySelector('input')) return null;
    // Cancelling closes this window. Click after the reply is on its way, or
    // the window can close first and the evaluation never answers.
    setTimeout(() => document.getElementById('cancel').click(), 0);
    return true;
  })()`);
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
      setTimeout(() => document.getElementById('ok').click(), 0);
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

check("snapshot scopes appended modal controls and indexed actions reach them", async () => {
  await ok("browser_navigate", { tab_id: tab, url: `${base}/next`, return_state: true });
  const background = Array.from({ length: 260 }, (_, i) => `<button>Background ${i}</button>`).join("");
  const html = `<main aria-hidden="true">${background}</main><div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white"><input aria-label="Domain"><button id="modal-next">Next</button><button>Verify</button></div>`;
  await evaluateIn((url) => url === `${base}/next`, `document.body.innerHTML = ${JSON.stringify(html)}; document.getElementById('modal-next').onclick = () => document.title = 'Modal target clicked'; true`);
  const state = await ok("browser_snapshot", { tab_id: tab });
  assert.match(state, /scope: modal; offset=0, limit=250, total=3/);
  assert.match(state, /\[0\] input "Domain"/);
  assert.match(state, /\[1\] button "Next"/);
  assert.match(state, /\[2\] button "Verify"/);
  assert.doesNotMatch(state, /Background/);
  const after = await ok("browser_click", { tab_id: tab, index: 1, return_state: true });
  assert.match(after, /Modal target clicked/);
  assert.match(after, /scope: modal/);
});

check("snapshot pagination reaches all controls with stable global indices", async () => {
  const html = Array.from({ length: 270 }, (_, i) => `<button>Control ${i}</button>`).join("");
  await evaluateIn((url) => url === `${base}/next`, `document.body.innerHTML = ${JSON.stringify(html)}; document.querySelectorAll('button')[250].onclick = () => document.title = 'Page two clicked'; true`);
  const first = await ok("browser_snapshot", { tab_id: tab });
  assert.match(first, /scope: page; offset=0, limit=250, total=270/);
  assert.match(first, /truncated — continue with browser_snapshot offset=250, limit=250/);
  assert.doesNotMatch(first, /\[250\] button/);
  const second = await ok("browser_snapshot", { tab_id: tab, offset: 250, limit: 20 });
  assert.match(second, /scope: page; offset=250, limit=20, total=270/);
  assert.match(second, /\[250\] button "Control 250"/);
  assert.match(second, /\[269\] button "Control 269"/);
  assert.doesNotMatch(second, /truncated/);
  const after = await ok("browser_click", { tab_id: tab, index: 250, return_state: true });
  assert.match(after, /Page two clicked/);
  for (const options of [{ offset: -1 }, { limit: 251 }]) {
    const result = await tool("browser_snapshot", { tab_id: tab, ...options });
    assert.equal(result.isError, true);
    assert.match(result.text, /offset must|limit must/);
  }
});

let pressTab;
const atPress = (url) => url === `${base}/press`;
check("a background-tab click is real mouse input with a real press's button state (#42)", async () => {
  pressTab = Number(/tab_id=(\d+)/.exec(await ok("browser_open_tab", { url: `${base}/press` }))[1]);
  await ok("browser_select_tab", { tab_id: tab });
  const snapshot = await ok("browser_snapshot", { tab_id: pressTab });
  const index = Number(/\[(\d+)\] button "More message options"/.exec(snapshot)[1]);
  const text = await ok("browser_click", { tab_id: pressTab, index, return_state: true, wait_for_selector: "[role=menuitem]", wait_timeout_ms: 3000 });
  assert.ok(text.startsWith(`clicked in tab ${pressTab} — [${index}] button "More message options", with real mouse input`), text);
  assert.match(text, /readiness: met/);
  assert.deepEqual(await evaluateIn(atPress, "presses"), [
    ["pointerdown", true, 1, "mouse"],
    ["mousedown", true, 1, 1],
    ["mouseup", true, 0, 1],
    ["click", true, 1, "mouse"],
  ]);
});

check("real input survives a cross-site navigation in the same background tab", async () => {
  // 127.0.0.1 → localhost is another site, so Chrome swaps the renderer.
  await ok("browser_navigate", { tab_id: pressTab, url: `${otherBase}/press`, return_state: true });
  const snapshot = await ok("browser_snapshot", { tab_id: pressTab });
  const index = Number(/\[(\d+)\] button "More message options"/.exec(snapshot)[1]);
  const text = await ok("browser_click", { tab_id: pressTab, index, return_state: true, wait_for_selector: "[role=menuitem]", wait_timeout_ms: 3000 });
  assert.ok(text.includes("with real mouse input"), text);
  assert.deepEqual(await evaluateIn((url) => url === `${otherBase}/press`, "presses.map((press) => press[1])"), [true, true, true, true]);
});

// ── editing in a background tab while the user works in another window ──

let editTab;
let userTarget;
const atEditor = (url) => url === `${base}/editor`;
const indexOf = (snapshot, pattern) => {
  const match = new RegExp(`\\[(\\d+)\\] ${pattern}`).exec(snapshot);
  if (!match) throw new Error(`no ${pattern} in:\n${snapshot}`);
  return Number(match[1]);
};
/** The frontmost macOS app, to prove nothing brought Chrome forward. */
const frontApp = () => {
  if (os.platform() !== "darwin") return null;
  try {
    return execFileSync("lsappinfo", ["info", "-only", "name", execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim()], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const editTabActive = async () => new RegExp(`^\\* tab_id=${editTab}\\b`, "m").test(await ok("browser_list_tabs", { all: true }));
/**
 * Chrome's own record of window focus, read in the extension's service
 * worker. Unlike document.hasFocus() in the user's page, it does not depend on
 * what else is on screen: another app covering this Chrome hides its pages.
 */
const atWorker = (url) => url === `chrome-extension://${built.extensionId}/background.js`;
const inWorker = (expression) => evaluateIn(atWorker, expression);
let before;

check("an agent tab opens in the background while the user's own window has focus", async () => {
  editTab = Number(/tab_id=(\d+)/.exec(await ok("browser_open_tab", { url: `${base}/editor` }))[1]);
  userTarget = await browserCommand("Target.createTarget", { url: `${base}/user`, newWindow: true });
  await sleep(800);
  before = {
    front: frontApp(),
    ...(await inWorker(`(async () => {
      globalThis.__e2eFocus = [];
      chrome.windows.onFocusChanged.addListener((id) => __e2eFocus.push(id));
      const user = (await chrome.tabs.query({ url: ${JSON.stringify(`${base}/user`)} }))[0];
      return { agentWindow: (await chrome.tabs.get(${editTab})).windowId, userWindow: user.windowId,
        lastFocused: (await chrome.windows.getLastFocused()).id };
    })()`)),
  };
  assert.notEqual(before.agentWindow, before.userWindow, "the user's page is in a window of its own");
  assert.equal(before.lastFocused, before.userWindow, "the user's window has focus");
  assert.equal(await editTabActive(), false, "the agent tab is not the active tab");
});

check("a click in the background tab is trusted: a button that ignores synthetic clicks opens its dialog", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: editTab });
  const edit = indexOf(snapshot, 'button "Edit"');
  const text = await ok("browser_click", {
    tab_id: editTab, index: edit, return_state: true, wait_for_selector: "#dialog button", wait_timeout_ms: 3000,
  });
  assert.ok(text.includes("with real mouse input"), text);
  assert.match(text, /readiness: met/);
  assert.match(text, /button "Save"/);
  await evaluateIn(atEditor, "document.getElementById('dialog').hidden = true; true");
});

check("select all with a modifier, then type, replaces an input's value", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: editTab });
  await ok("browser_click", { tab_id: editTab, index: indexOf(snapshot, 'input "Name"') });
  const selected = await ok("browser_press_key", { tab_id: editTab, key: "a", modifiers: ["cmd"] });
  assert.match(selected, /focus is now on \[\d+\] input "Name" with 8 characters selected/, selected);
  await ok("browser_type", { tab_id: editTab, text: "New name" });
  assert.equal(await evaluateIn(atEditor, "document.getElementById('name').value"), "New name");
});

check("ctrl and cmd select all alike, in the platform's own way", async () => {
  const text = await ok("browser_press_key", { tab_id: editTab, key: "a", modifiers: ["ctrl"] });
  assert.match(text, /with 8 characters selected/, text);
  if (os.platform() === "darwin") assert.match(text, /sent Ctrl\+A as Cmd\+A/, text);
});

check("Home, shift+End and Delete edit within the field", async () => {
  await ok("browser_press_key", { tab_id: editTab, key: "Home" });
  await ok("browser_type", { tab_id: editTab, text: ">" });
  assert.equal(await evaluateIn(atEditor, "document.getElementById('name').value"), ">New name");
  await ok("browser_press_key", { tab_id: editTab, key: "ArrowLeft" });
  const selected = await ok("browser_press_key", { tab_id: editTab, key: "End", modifiers: ["shift"] });
  assert.match(selected, /with 9 characters selected/, selected);
  await ok("browser_press_key", { tab_id: editTab, key: "Delete" });
  assert.equal(await evaluateIn(atEditor, "document.getElementById('name').value"), "");
});

check("browser_fill replaces a long multi-line textarea in one call", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: editTab });
  const next = Array.from({ length: 35 }, (_, i) => `New line ${i}, with "quotes" and émoji 🙂.`).join("\n");
  const text = await ok("browser_fill", { tab_id: editTab, index: indexOf(snapshot, 'textarea "About"'), text: next });
  assert.match(text, /^filled \[\d+\] textarea "About" in tab \d+ with \d+ characters, replacing its value$/, text);
  assert.equal(await evaluateIn(atEditor, "document.getElementById('about').value"), next);
});

check("browser_fill replaces contenteditable text and fields inside a shadow root", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: editTab });
  await ok("browser_fill", { tab_id: editTab, index: indexOf(snapshot, '[a-z]+ "Rich"'), text: "Plain new text" });
  await ok("browser_fill", { tab_id: editTab, index: indexOf(snapshot, 'input "Shadow input"'), text: "shadow new" });
  await ok("browser_fill", { tab_id: editTab, index: indexOf(snapshot, '[a-z]+ "Shadow rich"'), text: "shadow rich new" });
  assert.deepEqual(await evaluateIn(atEditor, `(() => {
    const root = document.querySelector('x-field').shadowRoot;
    return [document.getElementById('rich').innerText, root.getElementById('inner').value, root.getElementById('innerRich').innerText];
  })()`), ["Plain new text", "shadow new", "shadow rich new"]);
});

check("browser_fill with an empty string clears the field", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: editTab });
  const text = await ok("browser_fill", { tab_id: editTab, index: indexOf(snapshot, 'input "Shadow input"'), text: "" });
  assert.match(text, /^cleared \[\d+\] input "Shadow input"/, text);
  assert.equal(await evaluateIn(atEditor, "document.querySelector('x-field').shadowRoot.getElementById('inner').value"), "");
});

check("browser_fill says what the field holds when the page limits or refuses the text", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: editTab });
  const limited = await ok("browser_fill", { tab_id: editTab, index: indexOf(snapshot, 'input "Code"'), text: "ABCDEFG" });
  assert.match(limited, /but the field now holds 4 characters that differ from the text: "ABCD"/, limited);
  // A page that cancels the input decided; the extension does not force it.
  const refused = await ok("browser_fill", { tab_id: editTab, index: indexOf(snapshot, 'input "Locked"'), text: "changed" });
  assert.match(refused, /holds 4 characters that differ from the text: "keep"/, refused);
  assert.doesNotMatch(refused, /set its value directly/);
  assert.equal(await evaluateIn(atEditor, "document.getElementById('locked').value"), "keep");
});

check("every edit reached the page as trusted input events", async () => {
  const events = await evaluateIn(atEditor, "events");
  assert.ok(events.length >= 10, `only ${events.length} input events`);
  assert.deepEqual(events.filter(([, trusted]) => !trusted), [], "an untrusted input event");
});

check("a browser shortcut stays in the page: cmd+w does not close the tab", async () => {
  await ok("browser_press_key", { tab_id: editTab, key: "w", modifiers: ["cmd"] });
  await ok("browser_press_key", { tab_id: editTab, key: "w", modifiers: ["ctrl"] });
  await sleep(300);
  assert.match(await ok("browser_list_tabs"), new RegExp(`tab_id=${editTab}\\b`));
});

check("snapshot lists table, grid and custom-element rows, and a row click is trusted", async () => {
  const snapshot = await ok("browser_snapshot", { tab_id: editTab });
  assert.match(snapshot, /\] row "Cara \| Owner"/);
  assert.match(snapshot, /\] row "Name \| Role"/);
  assert.match(snapshot, /\] row "Ben \| Viewer"/);
  assert.doesNotMatch(snapshot, /cell "Ben"/, "grid cells that are not click targets stay out");
  const ana = indexOf(snapshot, 'x-row\\[clickable\\] "Ana Admin"');
  const text = await ok("browser_click", { tab_id: editTab, index: ana });
  assert.ok(text.includes("with real mouse input"), text);
  assert.deepEqual(await evaluateIn(atEditor, "rowClicks"), [true]);
});

check("none of it selected the agent tab, raised Chrome or took focus from the user's window", async () => {
  assert.equal(await editTabActive(), false, "the agent tab became the active tab");
  const after = await inWorker(`(async () => ({ focus: __e2eFocus, lastFocused: (await chrome.windows.getLastFocused()).id }))()`);
  assert.ok(!after.focus.includes(before.agentWindow), `the agent's window took focus (${JSON.stringify(after.focus)})`);
  assert.equal(after.lastFocused, before.userWindow, "focus left the user's window");
  // The person at this computer may switch apps during the run; what must not
  // happen is this Chrome coming forward when it was not in front.
  const front = frontApp();
  if (before.front !== null && !/Chrome for Testing|Chromium/.test(before.front)) {
    assert.doesNotMatch(front ?? "", /Chrome for Testing|Chromium/, "the test Chrome came to the front");
  }
  await browserCommand("Target.closeTarget", { targetId: userTarget.targetId });
  await ok("browser_close_tab", { tab_id: editTab });
});

// Headless Chrome reports every tab hidden, the front one too, so only a
// headed run has a tab real input can reach. browser_select_tab only switches
// when the user is already on an agent tab, so bring it up as a person would.
if (argv.includes("--headed")) check("a click in a shown tab is real mouse input (#42)", async () => {
  await ok("browser_navigate", { tab_id: pressTab, url: `${base}/press` });
  await evaluateIn(atPress, {}, "Page.bringToFront");
  const snapshot = await ok("browser_snapshot", { tab_id: pressTab });
  const index = Number(/\[(\d+)\] button "More message options"/.exec(snapshot)[1]);
  const text = await ok("browser_click", { tab_id: pressTab, index, return_state: true, wait_for_selector: "[role=menuitem]", wait_timeout_ms: 3000 });
  assert.ok(text.startsWith(`clicked in tab ${pressTab} — [${index}] button "More message options", with real mouse input`), text);
  assert.match(text, /readiness: met/);
  assert.deepEqual(await evaluateIn(atPress, "presses"), [
    ["pointerdown", true, 1, "mouse"],
    ["mousedown", true, 1, 1],
    ["mouseup", true, 0, 1],
    ["click", true, 1, "mouse"],
  ]);
  await ok("browser_close_tab", { tab_id: pressTab });
});

// #43: the reply must agree with browser_list_tabs about which tab is shown.
check("browser_select_tab says whether the tab became visible, and bring_to_front shows it (#43)", async () => {
  const shown = Number(/tab_id=(\d+)/.exec(await ok("browser_open_tab", { url: `${base}/press` }))[1]);
  const isActive = async () =>
    new RegExp(`^\\* tab_id=${shown}\\b`, "m").test(await ok("browser_list_tabs", { all: true }));
  const first = await ok("browser_select_tab", { tab_id: shown });
  if (first.startsWith(`tab ${shown} was NOT brought to front`)) {
    assert.match(first, /bring_to_front=true/);
    assert.equal(await isActive(), false, "the reply said not shown, the tab list says active");
  } else {
    assert.ok(first.startsWith(`tab ${shown} is now the visible tab`), first);
    assert.equal(await isActive(), true, "the reply said shown, the tab list says inactive");
  }
  const forced = await ok("browser_select_tab", { tab_id: shown, bring_to_front: true });
  assert.ok(forced.startsWith(`tab ${shown} is now the visible tab and its Chrome window is in front`), forced);
  assert.equal(await isActive(), true, "bring_to_front left the tab inactive");
  await ok("browser_close_tab", { tab_id: shown });
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
