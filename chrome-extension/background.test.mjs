// Ownership tests for the extension, against a fake Chrome.
//
//   node chrome-extension/background.test.mjs
//
// Adoption is the reason this file exists. Once `use_tab` can hand the agent a
// tab the user opened, a bookkeeping slip stops being a cosmetic bug and starts
// closing the user's work, so the rules that protect an adopted tab — never
// grouped, never activated, never closed by cleanup — are pinned here.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "background.js"), "utf8");

// ── fake Chrome ─────────────────────────────────────────────────────────────

let nextTabId = 100;
let nextGroupId = 1;
const tabs = new Map();
const groups = new Map();
const removed = [];
const executed = [];
const storage = {};
/** Every native port the extension opened, newest last. */
const ports = [];
const MT_HOST = "com.munim.mtcode.desktop";
const STANDALONE_HOST = "com.munimtech.computer_use.desktop";
/** The live port for a host: the one a bridge would be talking to. */
const portFor = (host) => ports.findLast((p) => p.host === host);
let alarmListener = null;
/** runtime.onMessage listeners, so tests can play the prompt page. */
const messageListeners = [];
/** Popup windows the extension opened, and the ones it closed. */
const openedWindows = [];
const closedWindows = [];
let windowRemovedListener = null;
/**
 * What a page answers to Runtime.evaluate. Tests swap this to play a page;
 * by default every expression returns an empty object.
 */
let pageEval = () => ({ result: { value: {} } });
/** Window types by id (normal unless listed), the window new tabs land in, and a grouping failure to play. */
const windowTypes = new Map();
let createInWindow = 1;
let groupFailure = null;
let connects = 0;
let sent = [];
/** Tabs the extension attached the debugger to, in order. */
const attaches = [];
let debuggerDetachListener = null;
/** chrome.debugger.onEvent: tests play DevTools events (dialogs, problems) through it. */
let debuggerEventListener = null;
let tabCreatedListener = null;
let tabRemovedListener = null;

/** A tab the page opened (target=_blank, window.open), as Chrome reports it. */
function openChild(openerTabId, url = "https://shop.example/terms") {
  const child = makeTab({ url });
  child.openerTabId = openerTabId;
  tabCreatedListener(child);
  return child.id;
}

// Most tests drive the MT Code host's port; the multi-host tests pick one.
const nativeListener = (msg) => portFor(MT_HOST).onMessageListener(msg);
const disconnectListener = () => portFor(MT_HOST).onDisconnectListener();

function makeTab({ url = "about:blank", title = "t", active = false, favIconUrl = "" }) {
  const id = nextTabId++;
  tabs.set(id, { id, url, title, active, favIconUrl, windowId: 1, groupId: -1 });
  return tabs.get(id);
}

const chrome = {
  runtime: {
    connectNative: (host) => {
      connects++;
      const nativePort = {
        host,
        sent: [],
        onMessageListener: null,
        onDisconnectListener: null,
        onMessage: { addListener: (fn) => { nativePort.onMessageListener = fn; } },
        onDisconnect: { addListener: (fn) => { nativePort.onDisconnectListener = fn; } },
        postMessage: (message) => {
          nativePort.sent.push(message);
          sent.push(message);
        },
      };
      ports.push(nativePort);
      return nativePort;
    },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    lastError: null,
    getURL: (file) => `chrome-extension://fake/${file}`,
  },
  alarms: { create() {}, onAlarm: { addListener: (fn) => { alarmListener = fn; } } },
  storage: {
    session: {
      get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
      set: async (entries) => Object.assign(storage, entries),
    },
  },
  tabs: {
    create: async ({ url }) => Object.assign(makeTab({ url }), { windowId: createInWindow }),
    move: async (id, { windowId }) => Object.assign(tabs.get(id), { windowId }),
    get: async (id) => {
      if (!tabs.has(id)) throw new Error(`no tab ${id}`);
      return tabs.get(id);
    },
    query: async (q) =>
      [...tabs.values()].filter((tab) =>
        q.groupId !== undefined
          ? tab.groupId === q.groupId
          : q.active !== undefined
            ? tab.active && tab.windowId === q.windowId
            : true,
      ),
    remove: async (id) => {
      if (!tabs.has(id)) throw new Error("gone");
      removed.push(id);
      tabs.delete(id);
    },
    update: async (id, props) => Object.assign(tabs.get(id), props),
    group: async ({ tabIds, groupId }) => {
      if (groupFailure) throw new Error(groupFailure);
      for (const tabId of tabIds) {
        if ((windowTypes.get(tabs.get(tabId).windowId) ?? "normal") !== "normal") {
          throw new Error("Grouping is not supported by tabs in this window.");
        }
      }
      const id = groupId ?? nextGroupId++;
      if (!groups.has(id)) groups.set(id, { windowId: tabs.get(tabIds[0]).windowId });
      for (const tabId of tabIds) tabs.get(tabId).groupId = id;
      return id;
    },
    ungroup: async (ids) => ids.forEach((id) => { tabs.get(id).groupId = -1; }),
    onUpdated: { addListener() {}, removeListener() {} },
    onRemoved: { addListener: (fn) => { tabRemovedListener = fn; } },
    onCreated: { addListener: (fn) => { tabCreatedListener = fn; } },
  },
  tabGroups: {
    get: async (id) => {
      if (!groups.has(id)) throw new Error("no group");
      return groups.get(id);
    },
    update: async (id, props) => Object.assign(groups.get(id), props),
  },
  debugger: {
    attach: async ({ tabId }) => {
      attaches.push(tabId);
    },
    detach: async () => {},
    onDetach: { addListener: (fn) => { debuggerDetachListener = fn; } },
    onEvent: { addListener: (fn) => { debuggerEventListener = fn; } },
    sendCommand: async (target, method, params) => pageEval(method, params ?? {}, target.tabId, target.sessionId),
  },
  windows: {
    create: async (options) => {
      const win = { id: 900 + openedWindows.length, ...options };
      openedWindows.push(win);
      return win;
    },
    remove: async (id) => {
      closedWindows.push(id);
    },
    get: async (id) => ({ id, type: windowTypes.get(id) ?? "normal" }),
    getLastFocused: async () => ({ id: 1, type: "normal" }),
    onRemoved: { addListener: (fn) => { windowRemovedListener = fn; } },
  },
  scripting: {
    executeScript: async ({ target, func, args }) =>
      executed.push({ tabId: target.tabId, fn: func.name, args }),
  },
};

// The favicon badge inlines the cursor PNG and the site's icon as data URLs.
const fetched = [];
async function fetch(url) {
  fetched.push(url);
  return {
    ok: true,
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
  };
}

// URL is not an enumerable global, so the spread below would leave it out.
// The extension reads Chrome's version from the user agent (frame sessions
// need Chrome 125); Node's own navigator is not enumerable either.
const navigator = { userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36" };
const extensionContext = vm.createContext({ ...globalThis, URL, AbortSignal, chrome, console, fetch, navigator });
vm.runInContext(source, extensionContext, {
  filename: "background.js",
});

// ── driving it ──────────────────────────────────────────────────────────────

let nextRequestId = 0;
async function call(command, params = {}) {
  const id = ++nextRequestId;
  // The extension's native-port listener is fire-and-forget, so poll for the reply.
  nativeListener({ id, command, params: { clientId: "agentA", ...params } });
  let reply;
  for (let tick = 0; tick < 500 && !reply; tick++) {
    await new Promise((resume) => setImmediate(resume));
    reply = sent.find((message) => message.id === id);
  }
  if (!reply) throw new Error(`no reply to ${command}`);
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

/** Fire several commands in one tick, the way concurrent MCP calls arrive. */
async function callAll(requests) {
  const ids = requests.map(([command, params]) => {
    const id = ++nextRequestId;
    nativeListener({ id, command, params: { clientId: "agentA", ...params } });
    return id;
  });
  const replies = [];
  for (const id of ids) {
    let reply;
    for (let tick = 0; tick < 500 && !reply; tick++) {
      await new Promise((resume) => setImmediate(resume));
      reply = sent.find((message) => message.id === id);
    }
    if (!reply) throw new Error(`no reply to request ${id}`);
    replies.push(reply);
  }
  return replies;
}

async function refuses(command, params) {
  try {
    await call(command, params);
  } catch (error) {
    return error.message;
  }
  throw new Error(`${command} was supposed to fail`);
}

const checks = [];
const test = (name, body) => checks.push([name, body]);

// ── tests ───────────────────────────────────────────────────────────────────

const userTab = makeTab({ url: "https://shop.example/checkout", title: "Checkout", active: true, favIconUrl: "https://shop.example/f.ico" });
const chromePage = makeTab({ url: "chrome://settings", title: "Settings" });
let agentTab;

test("open_tab still lands in the agent's group", async () => {
  agentTab = await call("open_tab", { url: "https://example.com" });
  assert.ok(agentTab.tabId);
  assert.notEqual(tabs.get(agentTab.tabId).groupId, -1);
});

test("the group reads as the product and is told apart by a stable colour", async () => {
  const group = groups.get(tabs.get(agentTab.tabId).groupId);
  assert.equal(group.title, "MT Code");
  const again = await call("open_tab", { url: "https://example.net" });
  assert.equal(tabs.get(again.tabId).groupId, tabs.get(agentTab.tabId).groupId);
  const other = await call("open_tab", { url: "https://example.edu", clientId: "agentC" });
  const otherGroup = groups.get(tabs.get(other.tabId).groupId);
  assert.equal(otherGroup.title, "MT Code");
  // Colour is hashed from the client id, so the same id always gets it back.
  assert.equal(typeof group.color, "string");
  assert.equal(typeof otherGroup.color, "string");
  await call("close_tab", { tabId: again.tabId });
  await call("close_all_tabs", { clientId: "agentC" });
});

test("agent tabs wear the pointer over the site's own icon", async () => {
  const badge = executed.findLast(
    (call) => call.tabId === agentTab.tabId && call.fn === "applyFavicon",
  );
  assert.ok(badge, "applyFavicon was injected");
  const svg = decodeURIComponent(badge.args[0].slice("data:image/svg+xml,".length));
  assert.match(svg, /agent-favicon-badge/);
  // Both layers are inlined: an SVG used as an image fetches nothing itself.
  assert.doesNotMatch(svg, /chrome-extension:\/\//);
  assert.ok(fetched.some((url) => url.endsWith("icons/cursor-224.png")));
});

test("list_tabs defaults to the agent's tabs only", async () => {
  const listed = await call("list_tabs");
  assert.equal(listed.scope, "agent");
  // Values cross the vm realm boundary, so compare scalars rather than shapes.
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0].tabId, agentTab.tabId);
});

test("list_tabs all=true shows the whole browser with ownership", async () => {
  const listed = await call("list_tabs", { all: true });
  assert.equal(listed.scope, "all");
  const byId = Object.fromEntries(listed.tabs.map((tab) => [tab.tabId, tab]));
  assert.equal(byId[userTab.id].owned, false);
  assert.equal(byId[userTab.id].attachable, true);
  assert.equal(byId[agentTab.tabId].owned, true);
  assert.equal(byId[chromePage.id].attachable, false);
});

test("use_tab adopts in place: no group move, no activation, no reload", async () => {
  const adopted = await call("use_tab", { tabId: userTab.id });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.url, "https://shop.example/checkout");
  assert.equal(tabs.get(userTab.id).groupId, -1);
  assert.equal(tabs.get(userTab.id).active, true);
  assert.ok(executed.some((call) => call.tabId === userTab.id && call.fn === "applyFavicon"));
});

test("an adopted tab accepts interaction", async () => {
  await call("snapshot", { tabId: userTab.id });
});

test("Chrome's own pages are refused with a reason", async () => {
  assert.match(await refuses("use_tab", { tabId: chromePage.id }), /does not allow automating/);
});

test("a tab another agent holds cannot be taken", async () => {
  const contested = makeTab({ url: "https://other.example" });
  await call("use_tab", { tabId: contested.id, clientId: "agentB" });
  assert.match(await refuses("use_tab", { tabId: contested.id }), /another agent/);
});

test("close_tab releases an adopted tab instead of closing it", async () => {
  const result = await call("close_tab", { tabId: userTab.id });
  assert.equal(result.released, userTab.id);
  assert.ok(tabs.has(userTab.id));
  assert.ok(!removed.includes(userTab.id));
  assert.ok(executed.some(
    (call) => call.tabId === userTab.id && call.fn === "restoreFavicon",
  ));
});

test("a released tab is no longer the agent's", async () => {
  assert.match(await refuses("snapshot", { tabId: userTab.id }), /not one of this agent's tabs/);
});

test("cleanup closes the agent's tabs and releases the user's", async () => {
  await call("use_tab", { tabId: userTab.id });
  const result = await call("close_all_tabs");
  assert.equal(result.closed, 1);
  assert.equal(result.released, 1);
  assert.ok(!tabs.has(agentTab.tabId));
  assert.ok(tabs.has(userTab.id));
});

test("release_tab points agent-created tabs at close_tab", async () => {
  const own = await call("open_tab", { url: "https://example.org" });
  assert.match(await refuses("release_tab", { tabId: own.tabId }), /close it with close_tab/);
});

// ── concurrent tasks ────────────────────────────────────────────────────────

test("two sessions in one MCP process get separate groups and tabs", async () => {
  const one = await call("open_tab", { url: "https://one.example", sessionId: "thread-1" });
  const two = await call("open_tab", { url: "https://two.example", sessionId: "thread-2" });
  const groupOne = tabs.get(one.tabId).groupId;
  const groupTwo = tabs.get(two.tabId).groupId;
  assert.notEqual(groupOne, -1);
  assert.notEqual(groupOne, groupTwo);
  assert.equal(groups.get(groupOne).title, "MT Code · thread-1");
  const listed = await call("list_tabs", { sessionId: "thread-1" });
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0].tabId, one.tabId);
  // Neither the other session nor the process's default session can drive it.
  assert.match(await refuses("snapshot", { tabId: one.tabId, sessionId: "thread-2" }), /not one of this agent's tabs/);
  assert.match(await refuses("snapshot", { tabId: one.tabId }), /not one of this agent's tabs/);
  assert.match(await refuses("use_tab", { tabId: one.tabId, sessionId: "thread-2" }), /another agent/);
  for (const sessionId of ["thread-1", "thread-2"]) await call("close_all_tabs", { sessionId });
});

test("close_all_tabs in one session leaves the other session's tabs", async () => {
  const keep = await call("open_tab", { url: "https://keep.example", sessionId: "keep" });
  const drop = await call("open_tab", { url: "https://drop.example", sessionId: "drop" });
  const result = await call("close_all_tabs", { sessionId: "drop" });
  assert.equal(result.closed, 1);
  assert.ok(!tabs.has(drop.tabId));
  assert.ok(tabs.has(keep.tabId));
  await call("close_all_tabs", { sessionId: "keep" });
  assert.ok(!tabs.has(keep.tabId));
});

test("process cleanup closes all of its sessions and none of a peer's", async () => {
  const a1 = await call("open_tab", { url: "https://a1.example", clientId: "procA", sessionId: "s1" });
  const a2 = await call("open_tab", { url: "https://a2.example", clientId: "procA" });
  const b1 = await call("open_tab", { url: "https://b1.example", clientId: "procB", sessionId: "s1" });
  const result = await call("close_client_tabs", { clientId: "procA" });
  assert.equal(result.closed, 2);
  assert.ok(!tabs.has(a1.tabId));
  assert.ok(!tabs.has(a2.tabId));
  assert.ok(tabs.has(b1.tabId), "same session id in another process is a different task");
  await call("close_client_tabs", { clientId: "procB" });
  assert.ok(!tabs.has(b1.tabId));
});

test("process cleanup also catches an open still waiting in its queue", async () => {
  const before = new Set(tabs.keys());
  const [opened, cleaned] = await callAll([
    ["open_tab", { url: "https://late.example", clientId: "procC", sessionId: "late" }],
    ["close_client_tabs", { clientId: "procC" }],
  ]);
  assert.ok(opened.ok);
  assert.ok(cleaned.ok);
  assert.ok(!tabs.has(opened.result.tabId));
  assert.deepEqual([...tabs.keys()].filter((id) => !before.has(id)), []);
});

test("two agents racing for one user tab: exactly one wins", async () => {
  const contested = makeTab({ url: "https://race.example" });
  const replies = await callAll([
    ["use_tab", { tabId: contested.id, clientId: "racer1" }],
    ["use_tab", { tabId: contested.id, clientId: "racer2" }],
  ]);
  assert.equal(replies.filter((reply) => reply.ok).length, 1);
  assert.match(replies.find((reply) => !reply.ok).error, /another agent/);
  for (const clientId of ["racer1", "racer2"]) await call("close_all_tabs", { clientId });
});

test("concurrent opens in one session share a single group", async () => {
  const replies = await callAll([1, 2, 3].map((n) =>
    ["open_tab", { url: `https://burst${n}.example`, sessionId: "burst" }]));
  const groupIds = new Set(replies.map((reply) => tabs.get(reply.result.tabId).groupId));
  assert.equal(groupIds.size, 1);
  await call("close_all_tabs", { sessionId: "burst" });
});

test("a bad session_id is refused", async () => {
  assert.match(await refuses("list_tabs", { sessionId: "  " }), /session_id must be/);
  assert.match(await refuses("list_tabs", { sessionId: "x".repeat(129) }), /session_id must be/);
  assert.match(await refuses("list_tabs", { sessionId: 7 }), /session_id must be/);
});

test("losing the native host keeps every task's tabs and reconnects", async () => {
  const survivor = await call("open_tab", { url: "https://survive.example", clientId: "procD", sessionId: "s" });
  const before = connects;
  disconnectListener();
  await new Promise((resume) => setTimeout(resume, 1100));
  assert.ok(tabs.has(survivor.tabId));
  assert.equal(connects, before + 1);
  // Ownership survived the reconnect, so the task can keep driving its tab.
  await call("snapshot", { tabId: survivor.tabId, clientId: "procD", sessionId: "s" });
  await call("close_client_tabs", { clientId: "procD" });
});

// ── several bridges ─────────────────────────────────────────────────────────

/** Send a command down one host's port and wait for the reply on that port. */
async function callVia(host, command, params) {
  const id = ++nextRequestId;
  const nativePort = portFor(host);
  nativePort.onMessageListener({ id, command, params });
  let reply;
  for (let tick = 0; tick < 500 && !reply; tick++) {
    await new Promise((resume) => setImmediate(resume));
    reply = nativePort.sent.find((message) => message.id === id);
  }
  if (!reply) throw new Error(`no reply to ${command} on ${host}`);
  return reply;
}

test("every configured host is connected, not just the first that answers", async () => {
  // MT Code's bundled server and a standalone server are separate bridges;
  // connecting to one only left the other without a browser.
  assert.ok(portFor(MT_HOST));
  assert.ok(portFor(STANDALONE_HOST));
});

test("each bridge is answered on its own port and keeps its own tabs", async () => {
  const mine = await callVia(STANDALONE_HOST, "open_tab", { url: "https://standalone.example", clientId: "standalone-proc" });
  assert.ok(mine.ok);
  assert.ok(!portFor(MT_HOST).sent.some((message) => message.id === mine.id), "reply stayed on its port");
  const theirs = await callVia(MT_HOST, "open_tab", { url: "https://mtcode.example", clientId: "mtcode-proc" });
  assert.ok(theirs.ok);
  assert.notEqual(tabs.get(mine.result.tabId).groupId, tabs.get(theirs.result.tabId).groupId);
  // Neither bridge's agent can drive, adopt or clean up the other's tab.
  const drive = await callVia(MT_HOST, "snapshot", { tabId: mine.result.tabId, clientId: "mtcode-proc" });
  assert.match(drive.error, /not one of this agent's tabs/);
  const adopt = await callVia(MT_HOST, "use_tab", { tabId: mine.result.tabId, clientId: "mtcode-proc" });
  assert.match(adopt.error, /another agent/);
  const cleanup = await callVia(MT_HOST, "close_client_tabs", { clientId: "mtcode-proc" });
  assert.equal(cleanup.result.closed, 1);
  assert.ok(tabs.has(mine.result.tabId));
  assert.ok(!tabs.has(theirs.result.tabId));
  await callVia(STANDALONE_HOST, "close_client_tabs", { clientId: "standalone-proc" });
  assert.ok(!tabs.has(mine.result.tabId));
});

test("one bridge dropping leaves the other connected", async () => {
  const standalone = portFor(STANDALONE_HOST);
  const before = connects;
  disconnectListener();
  assert.equal(portFor(STANDALONE_HOST), standalone);
  const still = await callVia(STANDALONE_HOST, "list_tabs", { clientId: "standalone-proc" });
  assert.ok(still.ok);
  await new Promise((resume) => setTimeout(resume, 1100));
  assert.equal(connects, before + 1, "only the dropped host reconnected");
});

test("a host that is not installed waits for the alarm instead of retrying", async () => {
  const before = connects;
  chrome.runtime.lastError = { message: "Specified native messaging host not found." };
  portFor(STANDALONE_HOST).onDisconnectListener();
  chrome.runtime.lastError = null;
  await new Promise((resume) => setTimeout(resume, 1100));
  assert.equal(connects, before, "no quick retry");
  alarmListener({ name: "cu-reconnect" });
  assert.equal(connects, before + 1, "the minute alarm tries again");
  assert.ok(portFor(STANDALONE_HOST).onMessageListener);
});

// ── reading, return_state, site rules, credentials ─────────────────────────

let pageTab;
test("a fresh agent tab for the page tests", async () => {
  pageTab = (await call("open_tab", { url: "https://shop.example/login" })).tabId;
  assert.ok(pageTab);
});

/** Like call(), but for commands that wait on timers (settling, prompts). */
async function callAndWait(command, params = {}, beforeReply = async () => {}) {
  const id = ++nextRequestId;
  nativeListener({ id, command, params: { clientId: "agentA", ...params } });
  await beforeReply();
  for (let waited = 0; waited < 5000; waited += 10) {
    const reply = sent.find((message) => message.id === id);
    if (reply) {
      if (!reply.ok) throw new Error(reply.error);
      return reply.result;
    }
    await new Promise((resume) => setTimeout(resume, 10));
  }
  throw new Error(`no reply to ${command}`);
}

/** Wait until the extension has opened another prompt window, and return its id. */
async function nextPrompt(count) {
  for (let waited = 0; waited < 3000 && openedWindows.length < count; waited += 5) {
    await new Promise((resume) => setTimeout(resume, 5));
  }
  const win = openedWindows[count - 1];
  if (!win) throw new Error("no prompt window opened");
  assert.match(win.url, /^chrome-extension:\/\/fake\/prompt\.html#/);
  return win.url.split("#")[1];
}

/** Talk to the extension the way prompt.html does. */
function fromPrompt(message, url = "chrome-extension://fake/prompt.html#x") {
  let response;
  for (const listener of messageListeners) listener(message, { url }, (value) => { response = value; });
  return response;
}

test("read returns the page text in chunks and says where to continue", async () => {
  const text = "# Title\n" + "word ".repeat(100).trim();
  pageEval = (method, params) =>
    params.expression?.includes("readPageInPage")
      ? { result: { value: { title: "Doc", url: "https://docs.example/a", text, links: [] } } }
      : { result: { value: {} } };
  const first = await call("read", { tabId: pageTab, maxChars: 50 });
  assert.equal(first.text.length, 50);
  assert.equal(first.end, 50);
  assert.equal(first.total, text.length);
  const rest = await call("read", { tabId: pageTab, offset: 50, maxChars: 100000 });
  assert.equal(first.text + rest.text, text);
  pageEval = () => ({ result: { value: {} } });
});

test("read with a query keeps matching lines, their neighbours and their heading", async () => {
  const text = ["# Pricing", "intro", "", "Pro costs $20", "after", "", "# Other", "unrelated", "more"].join("\n");
  pageEval = () => ({ result: { value: { title: "P", url: "https://p.example/", text } } });
  const found = await call("read", { tabId: pageTab, query: "costs" });
  assert.equal(found.matches, 1);
  assert.match(found.text, /# Pricing/);
  assert.match(found.text, /Pro costs \$20/);
  assert.doesNotMatch(found.text, /unrelated/);
  pageEval = () => ({ result: { value: {} } });
});

test("return_state attaches a fresh snapshot to an action", async () => {
  pageEval = (method, params) => {
    const expression = params.expression ?? "";
    if (expression.includes("byIndex(3)")) return { result: { value: { ok: true, tag: "button", x: 5, y: 5 } } };
    if (expression.includes("queryAll(document, sel")) {
      return { result: { value: { title: "After", url: "https://shop.example/next", elements: [{ i: 0, tag: "a", label: "Next" }] } } };
    }
    return { result: { value: {} } };
  };
  const plain = await callAndWait("click", { tabId: pageTab, index: 3 });
  assert.equal(plain.snapshot, undefined, "no snapshot unless asked");
  const withState = await callAndWait("click", { tabId: pageTab, index: 3, returnState: true });
  assert.equal(withState.snapshot.title, "After");
  assert.equal(withState.readiness.status, "not_requested", "tab.complete must not claim SPA readiness");
  pageEval = () => ({ result: { value: {} } });
});

test("every stateful action forwards an explicit wait and preserves its successful result", async () => {
  for (const [command, args] of [["click", { index: 3 }], ["type", { text: "hello" }], ["press", { key: "Enter" }], ["navigate", { url: "https://shop.example/next" }]]) {
    let observations = 0;
    pageEval = (_method, params) => {
      const expression = params.expression ?? "";
      if (expression.includes("visibleSelectorInPage")) {
        observations++;
        return { result: { value: { met: observations >= 2 } } };
      }
      if (expression.includes("byIndex(3)")) return { result: { value: { ok: true, tag: "button", x: 5, y: 5 } } };
      if (expression.includes("queryAll(document, sel")) return { result: { value: { title: "Ready", elements: [] } } };
      return { result: { value: {} } };
    };
    const result = await callAndWait(command, { tabId: pageTab, ...args, returnState: true, waitForSelector: "#ready", waitTimeoutMs: 1000 });
    assert.equal(result.readiness.status, "met", command);
    assert.equal(result.snapshot.title, "Ready", command);
    assert.equal(observations, 2, command);
  }
  pageEval = () => ({ result: { value: {} } });
});

test("snapshot waits without another action, including an immediate timeout", async () => {
  let actions = 0;
  pageEval = (method, params) => {
    const expression = params.expression ?? "";
    if (method.startsWith("Input.") || expression.includes(".byIndex(")) actions++;
    if (expression.includes("visibleSelectorInPage")) return { result: { value: { met: false } } };
    return { result: { value: { title: "Current", elements: [] } } };
  };
  const result = await callAndWait("snapshot", { tabId: pageTab, waitForSelector: "#missing", waitTimeoutMs: 0 });
  assert.equal(result.readiness.status, "timeout");
  assert.equal(result.title, "Current");
  assert.equal(actions, 0);
  pageEval = () => ({ result: { value: {} } });
});

test("invalid wait contracts are rejected before any stateful action", async () => {
  let sideEffects = 0;
  const before = tabs.get(pageTab).url;
  pageEval = () => { sideEffects++; return { result: { value: {} } }; };
  const invalid = [
    { waitForSelector: "#ready" },
    { returnState: true, waitForSelector: "" },
    { returnState: true, waitForSelector: 1 },
    { returnState: true, waitForSelector: "x".repeat(2001) },
    { returnState: true, waitTimeoutMs: 100 },
    { returnState: true, waitForSelector: 'input[type=password][value^="a"]' },
    { returnState: true, waitForSelector: 'form:has(input[VALUE*="x"])' },
    { returnState: true, waitForSelector: "input[\\76 alue^=a]" },
    { returnState: true, waitForSelector: "input[*|value]" },
    ...[-1, 10001, 0.5, "100"].map((waitTimeoutMs) => ({ returnState: true, waitForSelector: "#ready", waitTimeoutMs })),
  ];
  for (const command of ["click", "type", "press", "navigate"]) {
    for (const params of invalid) {
      const error = await refuses(command, { tabId: pageTab, index: 3, text: "x", key: "Enter", url: "https://changed.example", ...params });
      assert.match(error, /wait_for_selector|wait_timeout_ms/);
    }
  }
  assert.equal(sideEffects, 0);
  assert.equal(tabs.get(pageTab).url, before);
  pageEval = () => ({ result: { value: {} } });
});

test("a readiness evaluation error is not reported as a failed click", async () => {
  let clicks = 0;
  pageEval = (_method, params) => {
    const expression = params.expression ?? "";
    if (expression.includes("byIndex(3)")) {
      // The lookup, then the press itself.
      if (expression.includes("'pointerdown'")) clicks++;
      return { result: { value: { ok: true, x: 5, y: 5 } } };
    }
    if (expression.includes("visibleSelectorInPage")) return { result: { value: { error: "invalid CSS selector" } } };
    return { result: { value: { title: "Current", elements: [] } } };
  };
  const result = await callAndWait("click", { tabId: pageTab, index: 3, returnState: true, waitForSelector: "[" });
  assert.equal(result.ok, true);
  assert.equal(result.readiness.status, "error");
  assert.equal(result.readiness.error, "invalid CSS selector");
  assert.equal(clicks, 1);
  pageEval = () => ({ result: { value: {} } });
});

test("a readiness transport failure preserves the successful action and current snapshot", async () => {
  let clicks = 0;
  pageEval = (_method, params) => {
    const expression = params.expression ?? "";
    if (expression.includes("byIndex(3)")) {
      // The lookup, then the press itself.
      if (expression.includes("'pointerdown'")) clicks++;
      return { result: { value: { ok: true, x: 5, y: 5 } } };
    }
    if (expression.includes("visibleSelectorInPage")) throw new Error("readiness transport unavailable");
    return { result: { value: { title: "Current", elements: [] } } };
  };
  const result = await callAndWait("click", { tabId: pageTab, index: 3, returnState: true, waitForSelector: "#ready", waitTimeoutMs: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.readiness.status, "error");
  assert.equal(result.readiness.error, "readiness transport unavailable");
  assert.equal(result.snapshot.title, "Current");
  assert.equal(clicks, 1);
  pageEval = () => ({ result: { value: {} } });
});

test("an explicit wait rechecks site rules before each selector observation", async () => {
  const tab = tabs.get(pageTab);
  const before = tab.url;
  let observations = 0;
  pageEval = (_method, params) => {
    if ((params.expression ?? "").includes("visibleSelectorInPage")) {
      observations++;
      tab.url = "https://bank.example/accounts";
      return { result: { value: { met: false } } };
    }
    return { result: { value: {} } };
  };
  const error = await callAndWait("snapshot", { tabId: pageTab, waitForSelector: "#ready", waitTimeoutMs: 1000, sites: [{ pattern: "bank.example", rule: "block" }] }).then(
    () => "expected refusal", (failure) => failure.message,
  );
  assert.match(error, /blocked by the user's Computer Use policy/);
  assert.equal(observations, 1, "a selector was evaluated after the redirect was blocked");
  tab.url = before;
  pageEval = () => ({ result: { value: {} } });
});

test("navigation loading is bounded and is not confused with an explicit condition", async () => {
  const tab = tabs.get(pageTab);
  tab.status = "loading";
  const start = Date.now();
  const result = await vm.runInContext(`settle(${pageTab}, 0, 25)`, extensionContext);
  assert.equal(result.status, "timeout");
  assert.equal(result.condition, "document_load");
  assert.ok(Date.now() - start < 500);
  tab.status = "complete";
});

test("a click index that is not a plain number never reaches the page as script", async () => {
  const evaluated = [];
  pageEval = (method, params) => {
    evaluated.push(params.expression ?? "");
    return { result: { value: { ok: true, x: 1, y: 1 } } };
  };
  const payload = `0"]'); globalThis.leaked = 1; ('`;
  for (const index of [payload, 1.5, -1, { toString: () => "0" }]) {
    const error = await refuses("click", { tabId: pageTab, index });
    assert.match(error, /index must be an element index/);
  }
  assert.ok(!evaluated.some((expression) => expression.includes("leaked")), "the payload was evaluated");
  pageEval = () => ({ result: { value: {} } });
});

/**
 * Play a page for an indexed click: `found` is what the element lookup says,
 * `seen` what the probe saw after the hover and after the press. Records the
 * real input sent and whether the press was played as page events.
 */
function playClick({ found, hover = true, press = true, gone = false }) {
  const log = { input: [], pageEvents: 0 };
  let probes = 0;
  pageEval = (method, params) => {
    if (method === "Input.dispatchMouseEvent") {
      log.input.push(params.type);
      return {};
    }
    const expression = params.expression ?? "";
    if (expression.includes("scrollIntoView")) return { result: { value: { ok: true, tag: "div", label: "More", x: 5, y: 6, ...found } } };
    if (expression.includes("window.__cuClickProbe")) {
      probes += 1;
      if (probes === 1) return { result: { value: { hover } } };
      return { result: { value: gone && probes === 2 ? { gone: true } : { hover, press } } };
    }
    if (expression.includes("'pointerdown'")) {
      log.pageEvents += 1;
      return { result: { value: { ok: true } } };
    }
    return { result: { value: {} } };
  };
  return log;
}

test("a click in a shown tab is a real press once the hover reached the element", async () => {
  const log = playClick({ found: { reachable: true } });
  const result = await callAndWait("click", { tabId: pageTab, index: 4 });
  assert.deepEqual(log.input, ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(log.pageEvents, 0, "the press was played twice");
  assert.equal(result.route, "input");
  assert.equal(result.target, '[4] div "More"');
  pageEval = () => ({ result: { value: {} } });
});

test("a click in a background tab plays the press as page events", async () => {
  const log = playClick({ found: { reachable: false, why: "the tab is in the background" } });
  const result = await callAndWait("click", { tabId: pageTab, index: 4 });
  assert.deepEqual(log.input, [], "real input sent to a tab Chrome drops it for");
  assert.equal(log.pageEvents, 1);
  assert.equal(result.route, "page-events");
  assert.equal(result.why, "the tab is in the background");
  pageEval = () => ({ result: { value: {} } });
});

test("a hover that lands elsewhere never presses there, nor plays page events", async () => {
  const log = playClick({ found: { reachable: true }, hover: false });
  assert.match(await refuses("click", { tabId: pageTab, index: 4 }), /not clicked: \[4\] div "More" moved before it could be pressed.*Nothing was pressed/);
  assert.deepEqual(log.input, ["mouseMoved"]);
  assert.equal(log.pageEvents, 0);
  pageEval = () => ({ result: { value: {} } });
});

// Play Console: a checkbox below the fold was "covered", the press went out as
// page events, and the Admin box at the top was the one that changed.
test("a covered element is never pressed: no real input, no page events, an error naming the cover", async () => {
  const log = playClick({
    found: { reachable: false, covered: true, why: '[3] input "Admin (all permissions)" covers it even after scrolling it into view' },
  });
  const error = await refuses("click", { tabId: pageTab, index: 4 });
  assert.match(error, /not clicked: \[4\] div "More" cannot be reached — \[3\] input "Admin \(all permissions\)" covers it/);
  assert.match(error, /Nothing was pressed/);
  assert.deepEqual(log.input, []);
  assert.equal(log.pageEvents, 0);
  pageEval = () => ({ result: { value: {} } });
});

test("a checkbox click says what the box is now, and when it did not change", async () => {
  for (const [after, note] of [["checked", undefined], ["unchecked", "its state did not change (still unchecked)"]]) {
    const log = playClick({ found: { reachable: true, toggle: true, before: "unchecked", tag: "input", label: "Release manager" } });
    const inner = pageEval;
    pageEval = (method, params) =>
      (params.expression ?? "").includes("{ gone: true }") && (params.expression ?? "").includes("state:")
        ? { result: { value: { state: after } } }
        : inner(method, params);
    const result = await callAndWait("click", { tabId: pageTab, index: 4 });
    assert.equal(result.route, "input");
    assert.equal(result.state, after);
    assert.equal(result.note, note);
    assert.equal(result.target, '[4] input "Release manager"');
    assert.equal(log.pageEvents, 0);
  }
  pageEval = () => ({ result: { value: {} } });
});

test("an undelivered press falls back once, a press that navigated does not", async () => {
  let log = playClick({ found: { reachable: true }, press: false });
  let result = await callAndWait("click", { tabId: pageTab, index: 4 });
  assert.equal(log.pageEvents, 1);
  assert.equal(result.route, "page-events");
  log = playClick({ found: { reachable: true }, gone: true });
  result = await callAndWait("click", { tabId: pageTab, index: 4 });
  assert.equal(log.pageEvents, 0, "a link was followed and then clicked again");
  assert.equal(result.route, "input");
  pageEval = () => ({ result: { value: {} } });
});

test("page events carry a real press's button state and pointer type", () => {
  const script = vm.runInContext("CLICK_EVENTS_JS(4)", extensionContext);
  assert.match(script, /'pointerdown', \{ \.\.\.pointer, buttons: 1/);
  assert.match(script, /'mousedown', \{ buttons: 1, detail: 1 \}/);
  assert.match(script, /pointerType: 'mouse'/);
  assert.match(script, /'click', \{ \.\.\.pointer, detail: 1 \}/);
});

test("return_state does not read a blocked site the action landed on", async () => {
  const sites = [{ pattern: "bank.example", rule: "block" }];
  const tab = tabs.get(pageTab);
  const before = tab.url;
  let snapshots = 0;
  pageEval = (method, params) => {
    const expression = params.expression ?? "";
    if (expression.includes("byIndex(2)")) {
      // The click follows a link into a blocked site.
      tab.url = "https://www.bank.example/accounts";
      return { result: { value: { ok: true, tag: "a", x: 5, y: 5 } } };
    }
    if (expression.includes("queryAll(document, sel")) {
      snapshots += 1;
      return { result: { value: { title: "Accounts", url: tab.url, elements: [] } } };
    }
    return { result: { value: {} } };
  };
  // return_state waits for the page to settle, so wait for the reply in time.
  const error = await callAndWait("click", { tabId: pageTab, index: 2, returnState: true, sites }).then(
    () => "click was supposed to fail",
    (failure) => failure.message,
  );
  assert.match(error, /blocked by the user's Computer Use policy/);
  assert.equal(snapshots, 0, "the blocked page was read");
  tab.url = before;
  pageEval = () => ({ result: { value: {} } });
});

test("a trailing dot does not take a host out from under its rule", async () => {
  const error = await refuses("open_tab", {
    url: "https://www.bank.example./login",
    sites: [{ pattern: "bank.example", rule: "block" }],
  });
  assert.match(error, /blocked by the user's Computer Use policy/);
  const rule = await refuses("open_tab", {
    url: "https://bank.example/",
    sites: [{ pattern: "bank.example.", rule: "block" }],
  });
  assert.match(rule, /blocked by the user's Computer Use policy/);
});

test("a debugger session Chrome ended is attached again on the next command", async () => {
  pageEval = () => ({ result: { value: { title: "T", url: "https://shop.example/", elements: [] } } });
  await call("snapshot", { tabId: pageTab });
  const before = attaches.filter((id) => id === pageTab).length;
  await call("snapshot", { tabId: pageTab });
  assert.equal(attaches.filter((id) => id === pageTab).length, before, "an attached tab is reused");
  // The user pressed Cancel on Chrome's "is debugging this browser" bar.
  debuggerDetachListener({ tabId: pageTab }, "canceled_by_user");
  await call("snapshot", { tabId: pageTab });
  assert.equal(attaches.filter((id) => id === pageTab).length, before + 1, "re-attached after Chrome detached");
  pageEval = () => ({ result: { value: {} } });
});

test("snapshot forwards bounded pagination and refuses malformed options before evaluation", async () => {
  const expressions = [];
  pageEval = (method, params) => {
    if (params.expression?.includes("queryAll(document, sel")) expressions.push(params.expression);
    return { result: { value: {} } };
  };
  await call("snapshot", { tabId: pageTab, offset: 250, limit: 20 });
  assert.ok(expressions[0].endsWith('({"offset":250,"limit":20,"base":0})'));
  const count = expressions.length;
  const malformed = [
    { offset: -1 }, { offset: "250" }, { offset: 1.5 },
    { offset: 2147483648 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 251 }, { limit: "10" },
  ];
  for (const args of malformed) {
    assert.match(await refuses("snapshot", { tabId: pageTab, ...args }), /offset must|limit must/);
  }
  assert.equal(expressions.length, count, "malformed pagination reached page script");
  await call("snapshot", { tabId: pageTab });
  assert.ok(expressions.at(-1).endsWith('({"offset":0,"limit":250,"base":0})'));
  // A client that sends null for an unset optional argument gets the default.
  await call("snapshot", { tabId: pageTab, offset: null, limit: null, waitForSelector: null, waitTimeoutMs: null });
  assert.ok(expressions.at(-1).endsWith('({"offset":0,"limit":250,"base":0})'));
  pageEval = () => ({ result: { value: {} } });
});

test("a snapshot clears indices an earlier snapshot left on now-hidden elements", () => {
  const element = (tag, { hidden = false, idx } = {}) => {
    const attributes = new Map(idx === undefined ? [] : [["data-cu-idx", idx]]);
    return {
      tagName: tag.toUpperCase(),
      innerText: tag,
      // Selectors are comma lists; a bare tag name in one matches this element.
      matches: (selector) => selector.split(",").includes(tag),
      hidden,
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: (name) => attributes.delete(name),
      hasAttribute: (name) => attributes.has(name),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: hidden ? 0 : 10, height: hidden ? 0 : 10 }),
    };
  };
  // Step one's button, now hidden, still carries index 0 from the last snapshot.
  const stale = element("button", { hidden: true, idx: "0" });
  const next = element("button");
  const elements = [stale, next];
  const document = {
    title: "Step 2",
    querySelectorAll: (selector) =>
      selector === "[data-cu-idx]" ? elements.filter((el) => el.hasAttribute("data-cu-idx")) : selector.startsWith("dialog") ? [] : elements,
  };
  const page = vm.createContext({
    document,
    location: { href: "https://shop.example/step2" },
    innerHeight: 800,
    innerWidth: 1200,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  });
  const result = vm.runInContext(vm.runInContext("SNAPSHOT_JS", extensionContext), page);
  assert.equal(result.elements.length, 1);
  assert.equal(next.getAttribute("data-cu-idx"), "0");
  assert.equal(stale.getAttribute("data-cu-idx"), null, "the hidden element still answers to index 0");
});

test("a blocked site is refused before the tab is opened", async () => {
  const tabsBefore = tabs.size;
  const error = await refuses("open_tab", {
    url: "https://www.bank.example/login",
    sites: [{ pattern: "bank.example", rule: "block" }],
  });
  assert.match(error, /blocked by the user's Computer Use policy/);
  assert.equal(tabs.size, tabsBefore);
});

test("the most specific site rule wins", async () => {
  const opened = await call("open_tab", {
    url: "https://docs.bank.example/",
    sites: [{ pattern: "*", rule: "block" }, { pattern: "bank.example", rule: "block" }, { pattern: "docs.bank.example", rule: "allow" }],
  });
  assert.ok(opened.tabId);
  await call("close_tab", { tabId: opened.tabId });
});

test("an ask rule opens one approval prompt per origin and task", async () => {
  const sites = [{ pattern: "mail.example", rule: "ask" }];
  const before = openedWindows.length;
  const pending = callAndWait("open_tab", { url: "https://mail.example/inbox", sites }, async () => {
    const id = await nextPrompt(before + 1);
    const spec = fromPrompt({ type: "cu-prompt-init", id });
    assert.equal(spec.kind, "approve");
    assert.equal(spec.origin, "https://mail.example");
    fromPrompt({ type: "cu-prompt-answer", id, approved: true });
  });
  const opened = await pending;
  assert.ok(opened.tabId);
  const again = await call("navigate", { tabId: opened.tabId, url: "https://mail.example/sent", sites });
  assert.ok(again);
  assert.equal(openedWindows.length, before + 1, "approved once for this task");
  await call("close_tab", { tabId: opened.tabId });
});

test("declining an ask prompt refuses the action", async () => {
  const before = openedWindows.length;
  let failure;
  try {
    await callAndWait("open_tab", { url: "https://chat.example/", sites: [{ pattern: "chat.example", rule: "ask" }] }, async () => {
      const id = await nextPrompt(before + 1);
      fromPrompt({ type: "cu-prompt-answer", id, approved: false });
    });
  } catch (error) {
    failure = error.message;
  }
  assert.match(failure ?? "", /declined/);
});

test("credentials go from the prompt into the page and never back to the agent", async () => {
  const secret = "hunter2-correct-horse";
  let filledExpression = "";
  pageEval = (method, params) => {
    const expression = params.expression ?? "";
    if (expression.includes("describeFieldsInPage")) {
      return { result: { value: [
        { index: 1, found: true, editable: true, type: "email", label: "Email" },
        { index: 2, found: true, editable: true, type: "password", label: "Password" },
      ] } };
    }
    if (expression.includes("fillFieldsInPage")) {
      filledExpression = expression;
      return { result: { value: { filled: [1, 2], missing: [] } } };
    }
    return { result: { value: {} } };
  };
  const before = openedWindows.length;
  const result = await callAndWait(
    "request_credentials",
    { tabId: pageTab, fields: [{ index: 1 }, { index: 2 }], reason: "Sign in to finish checkout" },
    async () => {
      const id = await nextPrompt(before + 1);
      // A web page's content script cannot read or answer the prompt.
      assert.equal(fromPrompt({ type: "cu-prompt-init", id }, "https://evil.example/"), undefined);
      fromPrompt({ type: "cu-prompt-answer", id, approved: true, values: { 1: "a@b.example", 2: "stolen" } }, "https://evil.example/");
      const spec = fromPrompt({ type: "cu-prompt-init", id });
      assert.equal(spec.kind, "credentials");
      assert.deepEqual(spec.fields.map((field) => field.kind), ["email", "password"], "kinds inferred from the inputs");
      fromPrompt({ type: "cu-prompt-answer", id, approved: true, values: { 1: "a@b.example", 2: secret } });
    },
  );
  assert.deepEqual([...result.filled], [1, 2]);
  assert.ok(filledExpression.includes(secret), "the value reached the page");
  assert.ok(!JSON.stringify(result).includes(secret), "the value did not come back");
  assert.ok(!JSON.stringify(sent).includes(secret), "nothing sent to the host carries it");
  pageEval = () => ({ result: { value: {} } });
});

test("closing the sign-in window cancels without filling", async () => {
  pageEval = (method, params) =>
    (params.expression ?? "").includes("describeFieldsInPage")
      ? { result: { value: [{ index: 2, found: true, editable: true, type: "password", label: "" }] } }
      : { result: { value: {} } };
  const before = openedWindows.length;
  const result = await callAndWait("request_credentials", { tabId: pageTab, fields: [{ index: 2 }] }, async () => {
    await nextPrompt(before + 1);
    windowRemovedListener(openedWindows[before].id);
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.filled, undefined);
  pageEval = () => ({ result: { value: {} } });
});

test("credentials refuse an index that is not a text field", async () => {
  pageEval = (method, params) =>
    (params.expression ?? "").includes("describeFieldsInPage")
      ? { result: { value: [{ index: 4, found: true, editable: false, type: "a", label: "Help" }] } }
      : { result: { value: {} } };
  const error = await refuses("request_credentials", { tabId: pageTab, fields: [{ index: 4 }] });
  assert.match(error, /not a text field/);
  pageEval = () => ({ result: { value: {} } });
});

// ── tabs the agent's own actions open ──────────────────────────────────────

test("a tab the agent's click opens belongs to the task and is cleaned up with it", async () => {
  const parent = (await call("open_tab", { url: "https://shop.example/help", sessionId: "child" })).tabId;
  pageEval = () => ({ result: { value: { ok: true, tag: "a", x: 5, y: 5 } } });
  await callAndWait("click", { tabId: parent, index: 1, sessionId: "child" });
  pageEval = () => ({ result: { value: {} } });
  const child = openChild(parent);
  const listed = await call("list_tabs", { sessionId: "child" });
  const row = listed.tabs.find((tab) => tab.tabId === child);
  assert.ok(row, "the child is one of the task's tabs");
  assert.equal(row.adopted, false, "it is agent-created, not adopted");
  await call("ping", { sessionId: "child" });
  assert.equal(tabs.get(child).groupId, tabs.get(parent).groupId, "it joins the task's group");
  const cleaned = await call("close_all_tabs", { sessionId: "child" });
  assert.equal(cleaned.closed, 2);
  assert.ok(!tabs.has(child), "cleanup closed the child");
});

test("a tab opened from an agent tab with no recent agent action stays the user's", async () => {
  const parent = (await call("open_tab", { url: "https://shop.example/help", sessionId: "idle" })).tabId;
  const child = openChild(parent);
  const listed = await call("list_tabs", { sessionId: "idle" });
  assert.ok(!listed.tabs.some((tab) => tab.tabId === child), "the user's own click is not claimed");
  await call("close_all_tabs", { sessionId: "idle" });
  assert.ok(tabs.has(child), "cleanup left the user's tab open");
  tabs.delete(child);
});

test("a child of another task's tab is not claimed by this one", async () => {
  const parent = (await call("open_tab", { url: "https://shop.example/help", sessionId: "mine" })).tabId;
  pageEval = () => ({ result: { value: { ok: true, tag: "a", x: 5, y: 5 } } });
  await callAndWait("click", { tabId: parent, index: 1, sessionId: "mine" });
  pageEval = () => ({ result: { value: {} } });
  const child = openChild(parent);
  const theirs = await call("list_tabs", { sessionId: "theirs" });
  assert.ok(!theirs.tabs.some((tab) => tab.tabId === child));
  await call("close_all_tabs", { sessionId: "mine" });
});

// ── Tab key ────────────────────────────────────────────────────────────────

let formTab;
test("a fresh agent tab for the Tab key tests", async () => {
  formTab = (await call("open_tab", { url: "https://console.example/branding" })).tabId;
});

test("Tab in a background tab moves focus itself and says where it went", async () => {
  const keys = [];
  pageEval = (method, params) => {
    if (method === "Input.dispatchKeyEvent") keys.push(params.type);
    if ((params.expression ?? "").includes("__cuTabProbe;")) {
      return { result: { value: { moved: true, focused: '[7] input "Privacy policy link"' } } };
    }
    return { result: { value: {} } };
  };
  const result = await callAndWait("press", { tabId: formTab, key: "Tab" });
  assert.deepEqual([...keys], ["rawKeyDown", "keyUp"], "the page still sees the keystroke");
  assert.equal(result.focused, '[7] input "Privacy policy link"');
  pageEval = () => ({ result: { value: {} } });
});

test("a Tab that moves nothing is an error, not a success", async () => {
  pageEval = (method, params) =>
    (params.expression ?? "").includes("__cuTabProbe;")
      ? { result: { value: { moved: false, reason: "focus is already on the last element of the page" } } }
      : { result: { value: {} } };
  const error = await refuses("press", { tabId: formTab, key: "Tab" });
  assert.match(error, /Tab did not move focus \(focus is already on the last element/);
  pageEval = () => ({ result: { value: {} } });
});

test("a Tab the page handled itself is a success", async () => {
  pageEval = (method, params) =>
    (params.expression ?? "").includes("__cuTabProbe;")
      ? { result: { value: { moved: false, handled: true, focused: "textarea" } } }
      : { result: { value: {} } };
  const result = await callAndWait("press", { tabId: formTab, key: "Tab" });
  assert.equal(result.handledByPage, true);
  pageEval = () => ({ result: { value: {} } });
});

test("Backspace that edited the field is a plain success", async () => {
  pageEval = (method, params) =>
    (params.expression ?? "").includes("__cuEditProbe;")
      ? { result: { value: { checked: true, edited: true } } }
      : { result: { value: {} } };
  const result = await callAndWait("press", { tabId: formTab, key: "Backspace" });
  assert.equal(result.pressed, "Backspace");
  assert.equal(result.note, undefined);
  pageEval = () => ({ result: { value: {} } });
});

test("a Backspace the background tab ignored is deleted by the extension, and says so", async () => {
  pageEval = (method, params) =>
    (params.expression ?? "").includes("__cuEditProbe;")
      ? { result: { value: { checked: true, edited: true, fallback: true } } }
      : { result: { value: {} } };
  const result = await callAndWait("press", { tabId: formTab, key: "Backspace" });
  assert.match(result.note, /deleted the character itself/);
  pageEval = () => ({ result: { value: {} } });
});

test("a Backspace that changed nothing is an error, not a success (#54)", async () => {
  pageEval = (method, params) =>
    (params.expression ?? "").includes("__cuEditProbe;")
      ? { result: { value: { checked: true, edited: false } } }
      : { result: { value: {} } };
  await assert.rejects(callAndWait("press", { tabId: formTab, key: "Backspace" }), /did not change/);
  pageEval = (method, params) =>
    (params.expression ?? "").includes("__cuEditProbe;")
      ? { result: { value: { checked: true, edited: false, handled: true } } }
      : { result: { value: {} } };
  assert.equal((await callAndWait("press", { tabId: formTab, key: "Backspace" })).handledByPage, true);
  pageEval = () => ({ result: { value: {} } });
});

// #52: a DevTools command that never answers must not hold the task's queue.
test("a stalled page call times out, frees the task and never presses late", async () => {
  const owned = await call("open_tab", { url: "https://shop.example/note", sessionId: "stall" });
  const realSet = extensionContext.setTimeout;
  const realClear = extensionContext.clearTimeout;
  const deadlines = new Set();
  let late;
  let inputs = 0;
  extensionContext.setTimeout = (fn, ms, ...rest) => {
    if (ms !== 6000) return realSet(fn, ms, ...rest);
    const timer = { fn };
    deadlines.add(timer);
    return timer;
  };
  extensionContext.clearTimeout = (timer) => { if (!deadlines.delete(timer)) realClear(timer); };
  pageEval = (method, params) => {
    if (method.startsWith("Input.")) inputs++;
    const expression = params.expression || "";
    if (expression.includes("scrollIntoView")) {
      assert.equal(params.timeout, 4000, "page evaluations carry Chrome's own execution limit");
      return new Promise((resolve) => { late = resolve; });
    }
    if (expression.includes("queryAll(document, sel")) return { result: { value: { title: "Recovered", elements: [] } } };
    return { result: { value: {} } };
  };
  try {
    const failure = refuses("click", { tabId: owned.tabId, index: 1, sessionId: "stall" });
    for (let n = 0; n < 50 && !late; n++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(late, "the click's target lookup is in flight");
    for (const timer of [...deadlines]) timer.fn();
    assert.match(await failure, /Runtime\.evaluate timed out.*not retried/s);
    // The same task answers again straight away.
    assert.equal((await call("snapshot", { tabId: owned.tabId, sessionId: "stall" })).title, "Recovered");
    late({ result: { value: { ok: true, x: 1, y: 1, reachable: true } } });
    for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inputs, 0, "a lookup that answers late must not go on to press");
  } finally {
    extensionContext.setTimeout = realSet;
    extensionContext.clearTimeout = realClear;
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "stall" });
  }
});

// #56: calls queued behind a stuck command fail at once and name it.
test("a call behind a stuck command fails fast and says which command holds the task", async () => {
  const owned = await call("open_tab", { url: "https://shop.example/stuck", sessionId: "stuck" });
  const realSet = extensionContext.setTimeout;
  extensionContext.setTimeout = (fn, ms, ...rest) => (ms === 6000 ? {} : realSet(fn, ms, ...rest));
  let release;
  // Only the page hangs; attaching (focus emulation, the frame wait) still answers.
  pageEval = (method, params) =>
    method === "Runtime.evaluate" && !params.awaitPromise ? new Promise((resolve) => { release = resolve; }) : { result: { value: true } };
  try {
    const first = call("snapshot", { tabId: owned.tabId, sessionId: "stuck" }).catch((error) => error);
    for (let n = 0; n < 50 && !release; n++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(release, "the snapshot is in flight");
    vm.runInContext("globalThis.__realNow = Date.now; Date.now = () => __realNow() + 21000", extensionContext);
    assert.match(await refuses("list_tabs", { sessionId: "stuck" }), /not started: this task's earlier snapshot has been waiting on Chrome for 2\d s/);
    // Another task is not held up.
    assert.ok(Array.isArray((await call("list_tabs", { sessionId: "elsewhere" })).tabs));
    vm.runInContext("Date.now = __realNow", extensionContext);
    release({ result: { value: { title: "Late", elements: [] } } });
    assert.equal((await first).title, "Late");
    assert.ok(Array.isArray((await call("list_tabs", { sessionId: "stuck" })).tabs), "the task answers again once it is free");
  } finally {
    vm.runInContext("if (globalThis.__realNow) Date.now = __realNow", extensionContext);
    extensionContext.setTimeout = realSet;
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "stuck" });
  }
});

// #59: an installed web app can capture the URL into its own window, where
// Chrome refuses tab groups.
test("a tab captured into an app window is moved back and grouped", async () => {
  windowTypes.set(7, "app");
  createInWindow = 7;
  try {
    const opened = await call("open_tab", { url: "https://www.linkedin.com/in/someone", sessionId: "pwa" });
    assert.equal(opened.note, undefined);
    assert.equal(tabs.get(opened.tabId).windowId, 1, "moved to the normal window");
    assert.notEqual(tabs.get(opened.tabId).groupId, -1, "and grouped");
  } finally {
    windowTypes.delete(7);
    createInWindow = 1;
    await call("close_all_tabs", { sessionId: "pwa" });
  }
});

test("a tab Chrome will not group still opens, is reported, and is the task's (#59)", async () => {
  groupFailure = "Grouping is not supported by tabs in this window.";
  try {
    const opened = await call("open_tab", { url: "https://www.linkedin.com/in/someone", sessionId: "nogroup" });
    assert.ok(tabs.has(opened.tabId));
    assert.equal(opened.grouped, false);
    assert.match(opened.note, /the tab is open, but Chrome would not add it to the agent's tab group \(Grouping is not supported/);
    const listed = await call("list_tabs", { sessionId: "nogroup" });
    assert.ok(listed.tabs.some((tab) => tab.tabId === opened.tabId || tab.id === opened.tabId), "it is the task's tab");
    groupFailure = null;
    await call("close_all_tabs", { sessionId: "nogroup" });
    assert.ok(!tabs.has(opened.tabId), "cleanup closes it");
  } finally {
    groupFailure = null;
  }
});

// ── background-tab input ────────────────────────────────────────────────────

// A hidden tab drops trusted mouse input and runs no editing action for keys;
// focus emulation on the debugger session is what makes both work there.
test("attaching to a tab turns on focus emulation, once per session", async () => {
  const tab = (await call("open_tab", { url: "https://console.example/users", sessionId: "emulate" })).tabId;
  const seen = [];
  pageEval = (method, params) => {
    seen.push([method, params.enabled]);
    return { result: { value: {} } };
  };
  await call("snapshot", { tabId: tab, sessionId: "emulate" });
  await call("snapshot", { tabId: tab, sessionId: "emulate" });
  const emulations = seen.filter(([method]) => method === "Emulation.setFocusEmulationEnabled");
  assert.equal(emulations.length, 1);
  assert.equal(emulations[0][1], true);
  assert.equal(seen[0][0], "Emulation.setFocusEmulationEnabled", "before anything reaches the page");
  pageEval = () => ({ result: { value: {} } });
  await call("close_all_tabs", { sessionId: "emulate" });
});

// #63: Fathom's call page is Stencil web components, hidden until their first
// drawn frame. In a tab Chrome is not drawing, snapshot and read found nothing.
/** A page that reports itself hidden until `drawsAfter` focus emulations, and logs what was sent. */
function playHiddenPage({ drawsAfter = 2, listed = [{ i: 0, tag: "button", label: "Rename" }] } = {}) {
  const seen = [];
  let emulations = 0;
  pageEval = (method, params) => {
    seen.push(method === "Emulation.setFocusEmulationEnabled" ? `emulation ${params.enabled}` : method);
    if (method === "Emulation.setFocusEmulationEnabled" && params.enabled) emulations++;
    const shown = emulations >= drawsAfter;
    const expression = params.expression ?? "";
    if (params.awaitPromise) return { result: { value: shown } };
    if (expression.includes("visibleSelectorInPage")) return { result: { value: { met: shown, frames: 0, shown } } };
    if (expression.includes("queryAll(document, sel")) {
      return { result: { value: { title: "Call", url: "https://fathom.example/calls/1", elements: shown ? listed : [], total: shown ? listed.length : 0, shown } } };
    }
    if (expression.includes("readPageInPage")) {
      return { result: { value: { title: "Call", url: "https://fathom.example/calls/1", text: shown ? "Weekly sync" : "", shown, ...(shown ? {} : { unshown: 420 }) } } };
    }
    return { result: { value: {} } };
  };
  return seen;
}

test("a snapshot of a page Chrome is not drawing asks again for it to be shown, then lists it", async () => {
  const tab = (await call("open_tab", { url: "https://fathom.example/calls/1", sessionId: "drawn" })).tabId;
  const seen = playHiddenPage();
  const result = await call("snapshot", { tabId: tab, sessionId: "drawn" });
  assert.equal(result.total, 1);
  assert.equal(result.elements[0].label, "Rename");
  assert.equal(result.empty, undefined);
  assert.deepEqual(seen.filter((entry) => entry.startsWith("emulation")), ["emulation true", "emulation false", "emulation true"]);
  // A page that is drawn is not asked again.
  seen.length = 0;
  await call("snapshot", { tabId: tab, sessionId: "drawn" });
  assert.deepEqual(seen, ["Runtime.evaluate"]);
  pageEval = () => ({ result: { value: {} } });
  await call("close_all_tabs", { sessionId: "drawn" });
});

test("a page that stays undrawn says so instead of reading as empty", async () => {
  const tab = (await call("open_tab", { url: "https://fathom.example/calls/1", sessionId: "undrawn" })).tabId;
  playHiddenPage({ drawsAfter: Infinity });
  const snap = await call("snapshot", { tabId: tab, sessionId: "undrawn" });
  assert.equal(snap.total, 0);
  assert.match(snap.empty, /Chrome is not drawing this tab/);
  const read = await call("read", { tabId: tab, sessionId: "undrawn" });
  assert.equal(read.text, "");
  assert.match(read.note, /Chrome is not drawing this tab/);
  pageEval = () => ({ result: { value: {} } });
  await call("close_all_tabs", { sessionId: "undrawn" });
});

test("read of a hidden page asks for it to be drawn and returns its text", async () => {
  const tab = (await call("open_tab", { url: "https://fathom.example/calls/1", sessionId: "drawn-read" })).tabId;
  playHiddenPage();
  const read = await call("read", { tabId: tab, sessionId: "drawn-read" });
  assert.equal(read.text, "Weekly sync");
  assert.equal(read.note, undefined);
  pageEval = () => ({ result: { value: {} } });
  await call("close_all_tabs", { sessionId: "drawn-read" });
});

test("an empty read of a drawn page says how much text is hidden by CSS", async () => {
  pageEval = (method, params) =>
    params.expression?.includes("readPageInPage")
      ? { result: { value: { title: "T", url: "https://p.example/", text: "", shown: true, unshown: 1200 } } }
      : { result: { value: {} } };
  const read = await call("read", { tabId: pageTab });
  assert.match(read.note, /about 1200 characters of text, but none of it is shown/);
  pageEval = () => ({ result: { value: {} } });
});

test("a selector wait on an undrawn page asks once for it to be drawn, then sees the selector", async () => {
  const tab = (await call("open_tab", { url: "https://fathom.example/calls/1", sessionId: "drawn-wait" })).tabId;
  const seen = playHiddenPage();
  const result = await callAndWait("snapshot", { tabId: tab, sessionId: "drawn-wait", waitForSelector: "button", waitTimeoutMs: 2000 });
  assert.equal(result.readiness.status, "met");
  assert.equal(seen.filter((entry) => entry === "emulation false").length, 1);
  pageEval = () => ({ result: { value: {} } });
  await call("close_all_tabs", { sessionId: "drawn-wait" });
});

const resolve = (key, modifiers, mac) =>
  JSON.parse(vm.runInContext(`JSON.stringify(resolveKeyPress(${JSON.stringify(key)}, ${JSON.stringify(modifiers)}, ${mac}))`, extensionContext));

test("select all is Cmd+A with its editing command on a Mac and Ctrl+A elsewhere", () => {
  const mac = resolve("a", ["cmd"], true);
  assert.equal(mac.label, "Cmd+A");
  assert.equal(mac.modifiers, 4);
  assert.deepEqual([...mac.commands], ["selectAll"]);
  assert.equal(mac.text, undefined, "a shortcut types nothing");
  const other = resolve("a", ["ctrl"], false);
  assert.equal(other.label, "Ctrl+A");
  assert.equal(other.modifiers, 2);
  assert.equal(other.commands.length, 0, "Blink maps Ctrl+A itself off the Mac");
});

test("an editing shortcut means the same on every platform, and says when it was translated", () => {
  const onMac = resolve("ctrl+a", undefined, true);
  assert.equal(onMac.label, "Cmd+A");
  assert.deepEqual([...onMac.commands], ["selectAll"]);
  assert.match(onMac.note, /sent Ctrl\+A as Cmd\+A/);
  const offMac = resolve("a", ["cmd"], false);
  assert.equal(offMac.label, "Ctrl+A");
  assert.match(offMac.note, /sent Cmd\+A as Ctrl\+A/);
  assert.equal(resolve("y", ["ctrl"], true).label, "Shift+Cmd+Z", "redo on a Mac");
  // Not every Ctrl combination is an editing shortcut.
  assert.equal(resolve("k", ["ctrl"], true).label, "Ctrl+K");
});

test("named keys, aliases and combinations resolve to the right events", () => {
  for (const [key, modifiers, mac, label, vk, commands] of [
    ["Delete", [], true, "Delete", 46, ["deleteForward"]],
    ["del", [], false, "Delete", 46, []],
    ["Home", [], true, "Home", 36, ["moveToBeginningOfLine"]],
    ["End", ["shift"], true, "Shift+End", 35, ["moveToEndOfLineAndModifySelection"]],
    ["left", ["alt"], true, "Alt+ArrowLeft", 37, ["moveWordLeft"]],
    ["ArrowDown", [], false, "ArrowDown", 40, []],
    ["Cmd+Shift+Z", undefined, true, "Shift+Cmd+Z", 90, ["redo"]],
    ["Escape", [], true, "Escape", 27, []],
    ["F5", [], false, "F5", 116, []],
    ["space", [], false, "Space", 32, []],
  ]) {
    const press = resolve(key, modifiers, mac);
    assert.equal(press.label, label, key);
    assert.equal(press.vk, vk, key);
    assert.deepEqual([...press.commands], commands, key);
  }
  const enter = resolve("return", [], false);
  assert.equal(enter.text, "\r");
  const capital = resolve("A", [], false);
  assert.equal(capital.text, "A");
  assert.equal(capital.modifiers, 8, "a capital is typed with Shift");
  const bang = resolve("!", [], false);
  assert.equal(bang.code, "Digit1");
  assert.equal(bang.text, "!");
});

test("unknown keys and modifiers are refused with what is accepted", () => {
  assert.throws(() => resolve("Hyper", [], true), /unknown key "Hyper" — use a single character or one of Enter/);
  assert.throws(() => resolve("a", ["fn"], true), /unknown modifier "fn"/);
  assert.throws(() => resolve("", [], true), /key must be/);
});

test("a key press with modifiers sends one rawKeyDown with its command, then keyUp, and reports focus and selection", async () => {
  const tab = (await call("open_tab", { url: "https://console.example/listing", sessionId: "keys" })).tabId;
  vm.runInContext("macPlatform = true", extensionContext);
  const events = [];
  pageEval = (method, params) => {
    if (method === "Input.dispatchKeyEvent") events.push(params);
    if ((params.expression ?? "").includes("selectionStart === 'number'")) {
      return { result: { value: { focused: '[4] textarea "Full description"', selected: 1612 } } };
    }
    return { result: { value: {} } };
  };
  try {
    const result = await callAndWait("press", { tabId: tab, key: "a", modifiers: ["cmd"], sessionId: "keys" });
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "rawKeyDown");
    assert.equal(events[0].modifiers, 4);
    assert.deepEqual([...events[0].commands], ["selectAll"]);
    assert.equal(events[1].type, "keyUp");
    assert.equal(result.pressed, "Cmd+A");
    assert.equal(result.focused, '[4] textarea "Full description"');
    assert.equal(result.selected, 1612);
  } finally {
    vm.runInContext("macPlatform = null", extensionContext);
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "keys" });
  }
});

test("fill selects the field, inserts the text through Chrome and checks it took", async () => {
  const tab = (await call("open_tab", { url: "https://console.example/listing", sessionId: "fill" })).tabId;
  const steps = [];
  pageEval = (method, params) => {
    const expression = params.expression ?? "";
    if (method === "Input.insertText") steps.push(["insert", params.text]);
    if (expression.includes("__cuFillBefore = value()")) {
      steps.push(["prepare"]);
      return { result: { value: { ok: true, tag: "textarea", label: "Full description" } } };
    }
    if (expression.includes("const expected =")) {
      steps.push(["check"]);
      return { result: { value: { ok: true, matches: true, length: 9 } } };
    }
    return { result: { value: {} } };
  };
  try {
    const result = await callAndWait("fill", { tabId: tab, index: 4, text: "New words", sessionId: "fill" });
    assert.deepEqual(steps.map((step) => step.join(":")), ["prepare", "insert:New words", "check"]);
    assert.equal(result.target, '[4] textarea "Full description"');
    assert.equal(result.matches, true);
    assert.equal(result.length, 9);
    assert.equal(result.note, undefined);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "fill" });
  }
});

test("fill reports a direct set when Chrome's input never reached the field", async () => {
  const tab = (await call("open_tab", { url: "https://console.example/listing", sessionId: "fill2" })).tabId;
  const checks = [];
  pageEval = (method, params) => {
    const expression = params.expression ?? "";
    if (expression.includes("__cuFillBefore = value()")) return { result: { value: { ok: true, tag: "input", label: "Title" } } };
    if (expression.includes("const expected =")) {
      checks.push(/if \(true &&/.test(expression));
      return { result: { value: { ok: true, matches: true, fallback: true, length: 3 } } };
    }
    return { result: { value: {} } };
  };
  try {
    const result = await callAndWait("fill", { tabId: tab, index: 2, text: "new", sessionId: "fill2" });
    assert.deepEqual([...checks], [true], "one check, allowed to set the value");
    assert.equal(result.matches, true);
    assert.match(result.note, /set its value directly/);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "fill2" });
  }
});

test("fill says what a field holds when the page limited the text", async () => {
  const tab = (await call("open_tab", { url: "https://console.example/listing", sessionId: "fill4" })).tabId;
  pageEval = (method, params) => {
    const expression = params.expression ?? "";
    if (expression.includes("__cuFillBefore = value()")) return { result: { value: { ok: true, tag: "input", label: "Code" } } };
    if (expression.includes("const expected =")) return { result: { value: { ok: true, matches: false, length: 4, value: "ABCD" } } };
    return { result: { value: {} } };
  };
  try {
    const result = await callAndWait("fill", { tabId: tab, index: 2, text: "ABCDEFG", sessionId: "fill4" });
    assert.equal(result.matches, false);
    assert.equal(result.actualLength, 4);
    assert.equal(result.value, "ABCD");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "fill4" });
  }
});

test("fill refuses an index that is not a plain number before anything reaches the page", async () => {
  const tab = (await call("open_tab", { url: "https://console.example/listing", sessionId: "fill3" })).tabId;
  const expressions = [];
  pageEval = (method, params) => {
    if (params.expression) expressions.push(params.expression);
    return { result: { value: {} } };
  };
  try {
    assert.match(await refuses("fill", { tabId: tab, index: "1); alert(1", text: "x", sessionId: "fill3" }), /index must be an element index/);
    assert.match(await refuses("fill", { tabId: tab, index: 1, sessionId: "fill3" }), /text is required/);
    assert.equal(expressions.length, 0);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "fill3" });
  }
});

/** A page with one file input at index 3, recording the DevTools calls an upload makes. */
function playFileInput({ multiple = false, via = "input", label = "Attachments", names } = {}) {
  const calls = [];
  pageEval = (method, params) => {
    calls.push([method, params]);
    if (method === "Runtime.evaluate" && params.objectGroup === "cu-upload") {
      return { result: { type: "object", subtype: "node", objectId: "input-1" } };
    }
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.startsWith("function fileInputInfoInPage")) {
      return { result: { value: { via, label, multiple, disabled: false, folder: false } } };
    }
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.startsWith("function fileInputFilesInPage")) {
      const set = calls.find(([name]) => name === "DOM.setFileInputFiles");
      const files = names ?? (set ? set[1].files.map((file) => file.split("/").pop()) : []);
      return { result: { value: { names: files, input: !!set, change: !!set } } };
    }
    return { result: { value: {} } };
  };
  return calls;
}

test("upload_file sets the files on the input by its handle and reads back what it holds", async () => {
  const tab = (await call("open_tab", { url: "https://forms.example/apply", sessionId: "up1" })).tabId;
  const calls = playFileInput({ multiple: true });
  try {
    const result = await callAndWait("upload_file", { tabId: tab, index: 3, paths: ["/home/a/cv.pdf", "/home/a/photo.png"], sessionId: "up1" });
    assert.equal(result.target, '[3] input[file] "Attachments"');
    assert.deepEqual(result.files, ["cv.pdf", "photo.png"]);
    assert.equal(result.count, 2);
    assert.deepEqual({ ...result.events }, { input: true, change: true });
    const set = calls.find(([method]) => method === "DOM.setFileInputFiles");
    assert.deepEqual(JSON.parse(JSON.stringify(set[1])), { files: ["/home/a/cv.pdf", "/home/a/photo.png"], objectId: "input-1" });
    // Nothing else reaches the tab: no input events, no activation, no submit.
    assert.deepEqual(calls.filter(([method]) => method.startsWith("Input.")), []);
    assert.equal(tabs.get(tab).active, false);
    assert.ok(calls.some(([method, params]) => method === "Runtime.releaseObjectGroup" && params.objectGroup === "cu-upload"));
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "up1" });
  }
});

test("upload_file through a label names the label, and one file goes to an input without multiple", async () => {
  const tab = (await call("open_tab", { url: "https://forms.example/apply", sessionId: "up2" })).tabId;
  playFileInput({ via: "label", label: "Upload your CV" });
  try {
    const result = await callAndWait("upload_file", { tabId: tab, index: 3, paths: ["C:\\Users\\a\\cv.pdf"], sessionId: "up2" });
    assert.equal(result.target, 'the file input of [3] label "Upload your CV"');
    assert.equal(result.count, 1);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "up2" });
  }
});

test("upload_file refuses several files for an input without multiple, and sets nothing", async () => {
  const tab = (await call("open_tab", { url: "https://forms.example/apply", sessionId: "up3" })).tabId;
  const calls = playFileInput({ multiple: false });
  try {
    const error = await refuses("upload_file", { tabId: tab, index: 3, paths: ["/a.txt", "/b.txt"], sessionId: "up3" });
    assert.match(error, /^not attached: \[3\] input\[file\] "Attachments" takes one file \(it has no multiple attribute\) and 2 were given/);
    assert.equal(calls.filter(([method]) => method === "DOM.setFileInputFiles").length, 0);
    // The event watch is taken down again, and the handle released.
    assert.ok(calls.some(([method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration.startsWith("function fileInputFilesInPage")));
    assert.ok(calls.some(([method]) => method === "Runtime.releaseObjectGroup"));
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "up3" });
  }
});

test("upload_file passes on why an index names no file input, and checks its arguments first", async () => {
  const tab = (await call("open_tab", { url: "https://forms.example/apply", sessionId: "up4" })).tabId;
  const calls = [];
  pageEval = (method, params) => {
    calls.push(method);
    if (method === "Runtime.evaluate" && params.objectGroup === "cu-upload") {
      return { result: { type: "string", value: "element 3 is button, not a file input or a label for one" } };
    }
    return { result: { value: {} } };
  };
  try {
    assert.match(await refuses("upload_file", { tabId: tab, index: 3, paths: ["/a.txt"], sessionId: "up4" }),
      /^not attached: element 3 is button, not a file input or a label for one$/);
    assert.ok(!calls.includes("DOM.setFileInputFiles"));
    calls.length = 0;
    assert.match(await refuses("upload_file", { tabId: tab, index: "3); alert(1", paths: ["/a.txt"], sessionId: "up4" }), /index must be an element index/);
    assert.match(await refuses("upload_file", { tabId: tab, index: 3, paths: [], sessionId: "up4" }), /paths must list 1 to 50/);
    assert.match(await refuses("upload_file", { tabId: tab, index: 3, paths: "/a.txt", sessionId: "up4" }), /paths must list 1 to 50/);
    assert.deepEqual(calls.filter((method) => method !== "Emulation.setFocusEmulationEnabled"), []);
    // Another task's tab is refused before the page is touched.
    assert.match(await refuses("upload_file", { tabId: tab, index: 3, paths: ["/a.txt"], sessionId: "someone-else" }), /not one of this agent's tabs/);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "up4" });
  }
});

// ── JavaScript dialogs (#66) ────────────────────────────────────────────────

/** A value from the extension's realm as plain data, for deep comparisons. */
const plain = (value) => JSON.parse(JSON.stringify(value));
/** Chrome reporting a dialog in a tab, the way Page.javascriptDialogOpening does. */
function openDialog(tabId, type, message, defaultPrompt = "") {
  debuggerEventListener({ tabId }, "Page.javascriptDialogOpening", { url: "https://shop.example/", frameId: "F", message, type, hasBrowserHandler: true, defaultPrompt });
}
const closeDialog = (tabId, result) => debuggerEventListener({ tabId }, "Page.javascriptDialogClosed", { frameId: "F", result, userInput: "" });
/**
 * A page that logs every DevTools command and answers Page.handleJavaScriptDialog
 * by closing the dialog. `stored` is what Chrome holds of the page's console
 * messages and exceptions: Runtime.enable replays it as events before replying.
 */
function playDialogPage(stored = []) {
  const seen = [];
  pageEval = (method, params, tabId) => {
    seen.push([method, params]);
    if (method === "Page.handleJavaScriptDialog") closeDialog(tabId, params.accept);
    if (method === "Runtime.enable") for (const [event, details] of stored) debuggerEventListener({ tabId }, event, details);
    if (params.expression?.includes("queryAll(document, sel")) return { result: { value: { title: "Shop", url: "https://shop.example/", elements: [], total: 0 } } };
    return { result: { value: {} } };
  };
  return seen;
}

test("attaching turns on dialogs and failed requests after focus emulation, and never Runtime", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/", sessionId: "watch" })).tabId;
  const seen = playDialogPage();
  await call("snapshot", { tabId: tab, sessionId: "watch" });
  await call("snapshot", { tabId: tab, sessionId: "watch" });
  const methods = seen.map(([method]) => method);
  assert.equal(methods[0], "Emulation.setFocusEmulationEnabled");
  for (const domain of ["Page.enable", "Log.enable"]) assert.ok(methods.includes(domain), `${domain} was not sent`);
  // Runtime left on is what bot checks on the user's signed-in sites look for.
  assert.ok(!methods.includes("Runtime.enable"), "Runtime was turned on outside browser_page_errors");
  assert.ok(!methods.includes("Network.enable"), "every request would stream to the extension");
  pageEval = () => ({ result: { value: {} } });
  await call("close_all_tabs", { sessionId: "watch" });
});

test("an open dialog shows in the snapshot and every page command says so at once", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/", sessionId: "dlg" })).tabId;
  const seen = playDialogPage();
  try {
    await call("snapshot", { tabId: tab, sessionId: "dlg" });
    openDialog(tab, "confirm", "Delete this order?");
    seen.length = 0;
    const snap = await call("snapshot", { tabId: tab, sessionId: "dlg" });
    assert.equal(snap.jsDialog.type, "confirm");
    assert.equal(snap.jsDialog.message, "Delete this order?");
    assert.match(snap.jsDialog.id, /^d\d+$/);
    assert.equal(snap.total, 0);
    assert.match(snap.empty, /waits on its JavaScript confirm dialog/);
    assert.deepEqual(seen, [], "nothing was sent to a paused page");
    for (const [command, params] of [["read", {}], ["click", { index: 1 }], ["type", { text: "x" }], ["screenshot", {}], ["navigate", { url: "https://shop.example/next" }]]) {
      const message = await refuses(command, { tabId: tab, sessionId: "dlg", ...params });
      assert.match(message, new RegExp(`not started: tab ${tab} is showing a JavaScript confirm dialog ${snap.jsDialog.id}: "Delete this order\\?"`), command);
      assert.match(message, /browser_handle_dialog/);
    }
    assert.deepEqual(seen, [], "nothing was sent to a paused page");
    assert.ok(!tabs.get(tab).url.endsWith("/next"), "navigate would have dismissed the dialog");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "dlg" });
  }
});

test("handle_dialog answers the dialog named by id and refuses a replaced one", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/", sessionId: "dlg2" })).tabId;
  const seen = playDialogPage();
  try {
    await call("snapshot", { tabId: tab, sessionId: "dlg2" });
    openDialog(tab, "confirm", "Delete this order?");
    const first = (await call("snapshot", { tabId: tab, sessionId: "dlg2" })).jsDialog;
    // The page closed that one (the user answered it) and opened another.
    closeDialog(tab, true);
    openDialog(tab, "confirm", "Also delete the invoice?");
    const stale = await refuses("handle_dialog", { tabId: tab, sessionId: "dlg2", action: "accept", dialogId: first.id });
    assert.match(stale, new RegExp(`dialog ${first.id} is no longer open; tab ${tab} now shows JavaScript confirm dialog d\\d+: "Also delete the invoice\\?". Nothing was answered`));
    assert.ok(!seen.some(([method]) => method === "Page.handleJavaScriptDialog"), "a replaced dialog was answered");
    const current = (await call("snapshot", { tabId: tab, sessionId: "dlg2" })).jsDialog;
    const done = await callAndWait("handle_dialog", { tabId: tab, sessionId: "dlg2", action: "dismiss", dialogId: current.id });
    assert.equal(done.action, "dismiss");
    assert.equal(done.dialog.message, "Also delete the invoice?");
    assert.equal(done.next, undefined);
    assert.deepEqual(plain(seen.filter(([method]) => method === "Page.handleJavaScriptDialog").map(([, params]) => params)), [{ accept: false }]);
    // The page runs again.
    const snap = await call("snapshot", { tabId: tab, sessionId: "dlg2" });
    assert.equal(snap.jsDialog, undefined);
    assert.equal(snap.title, "Shop");
    // Answering it twice says it is gone, and how.
    assert.match(await refuses("handle_dialog", { tabId: tab, sessionId: "dlg2", action: "accept", dialogId: current.id }), /already dismissed by the agent\. Nothing was answered/);
    assert.match(await refuses("handle_dialog", { tabId: tab, sessionId: "dlg2", action: "accept" }), /has no JavaScript dialog open, so nothing was answered/);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "dlg2" });
  }
});

test("a prompt takes the agent's text, or its default text, and prompt_text fits only a prompt", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/", sessionId: "dlg3" })).tabId;
  const seen = playDialogPage();
  const answers = () => seen.filter(([method]) => method === "Page.handleJavaScriptDialog").map(([, params]) => params);
  try {
    await call("snapshot", { tabId: tab, sessionId: "dlg3" });
    openDialog(tab, "prompt", "Name the list", "Groceries");
    assert.equal((await call("snapshot", { tabId: tab, sessionId: "dlg3" })).jsDialog.defaultPrompt, "Groceries");
    assert.match(await refuses("handle_dialog", { tabId: tab, sessionId: "dlg3", action: "dismiss", promptText: "x" }), /prompt_text only applies when accepting a prompt dialog/);
    assert.match(await refuses("handle_dialog", { tabId: tab, sessionId: "dlg3", action: "ok" }), /action must be accept or dismiss/);
    const typed = await callAndWait("handle_dialog", { tabId: tab, sessionId: "dlg3", action: "accept", promptText: "Hardware" });
    assert.equal(typed.promptChars, 8);
    openDialog(tab, "prompt", "Name the list", "Groceries");
    const kept = await callAndWait("handle_dialog", { tabId: tab, sessionId: "dlg3", action: "accept" });
    assert.equal(kept.promptDefault, true);
    openDialog(tab, "alert", "Saved");
    assert.match(await refuses("handle_dialog", { tabId: tab, sessionId: "dlg3", action: "accept", promptText: "x" }), /d\d+ is an alert dialog/);
    await callAndWait("handle_dialog", { tabId: tab, sessionId: "dlg3", action: "accept" });
    assert.deepEqual(plain(answers()), [{ accept: true, promptText: "Hardware" }, { accept: true, promptText: "Groceries" }, { accept: true }]);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "dlg3" });
  }
});

test("a dialog the page opens right after an answer is reported with it", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/", sessionId: "dlg4" })).tabId;
  playDialogPage();
  const base = pageEval;
  pageEval = (method, params, tabId) => {
    const answer = base(method, params, tabId);
    if (method === "Page.handleJavaScriptDialog") setTimeout(() => openDialog(tabId, "alert", "Order deleted"), 20);
    return answer;
  };
  try {
    await call("snapshot", { tabId: tab, sessionId: "dlg4" });
    openDialog(tab, "confirm", "Delete this order?");
    const done = await callAndWait("handle_dialog", { tabId: tab, sessionId: "dlg4", action: "accept" });
    assert.equal(done.next.type, "alert");
    assert.equal(done.next.message, "Order deleted");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "dlg4" });
  }
});

test("a click whose press opens a dialog is reported as done, with the dialog", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/", sessionId: "dlg5" })).tabId;
  const log = playClick({ found: { reachable: true } });
  const click = pageEval;
  // The press's release never answers: the page is in its click handler, in confirm().
  pageEval = (method, params, tabId) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      log.input.push(params.type);
      setTimeout(() => openDialog(tabId, "confirm", "Leave the group?"), 5);
      return new Promise(() => {});
    }
    return click(method, params, tabId);
  };
  try {
    const result = await callAndWait("click", { tabId: tab, index: 4, sessionId: "dlg5" });
    assert.deepEqual(log.input, ["mouseMoved", "mousePressed", "mouseReleased"]);
    assert.equal(log.pageEvents, 0, "the press was played a second time");
    assert.equal(result.route, "input");
    assert.equal(result.target, '[4] div "More"');
    assert.equal(result.jsDialog.message, "Leave the group?");
    assert.match(result.note, /the page opened a JavaScript confirm dialog d\d+: "Leave the group\?" and is paused until it is answered/);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "dlg5" });
  }
});

test("another task cannot answer a dialog or read problems in a tab it does not own", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/", sessionId: "owner" })).tabId;
  playDialogPage();
  try {
    await call("snapshot", { tabId: tab, sessionId: "owner" });
    openDialog(tab, "confirm", "Delete this order?");
    assert.match(await refuses("handle_dialog", { tabId: tab, sessionId: "intruder", action: "accept" }), /not one of this agent's tabs/);
    assert.match(await refuses("page_errors", { tabId: tab, sessionId: "intruder" }), /not one of this agent's tabs/);
    assert.equal((await call("snapshot", { tabId: tab, sessionId: "owner" })).jsDialog.message, "Delete this order?", "still open");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "owner" });
  }
});

// ── page problems (#65) ─────────────────────────────────────────────────────

const exception = (text, description, at) => ["Runtime.exceptionThrown", { timestamp: at, exceptionDetails: { text, url: "https://shop.example/app.js?v=9", lineNumber: 11, columnNumber: 4, exception: { description } } }];
const consoleCall = (type, args, at) => ["Runtime.consoleAPICalled", { type, timestamp: at, args }];
const logEntry = (entry) => ["Log.entryAdded", { entry }];

test("page_errors reads exceptions and console errors from Chrome's replay, with failed requests since attach, redacted", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/", sessionId: "probs" })).tabId;
  const now = Date.now();
  // What Chrome holds for the document, handed over on Runtime.enable.
  const seen = playDialogPage([
    consoleCall("error", [{ type: "string", value: "boot failed" }], now - 60000),
    exception("Uncaught", "TypeError: Cannot read properties of null (reading 'x')\n    at app.js:12:5", now + 1),
    consoleCall("log", [{ type: "string", value: "just chatter" }], now + 2),
    consoleCall("error", [{ type: "string", value: "fetch https://api.example/v1/me?token=SECRET#frag failed" }, { type: "object", description: "Object" }], now + 3),
  ]);
  try {
    await call("snapshot", { tabId: tab, sessionId: "probs" });
    for (const [method, params] of [
      // Log.enable replays what Chrome logged before the agent attached.
      logEntry({ source: "network", level: "error", text: "Failed to load resource: the server responded with a status of 404 (Not Found)", url: "https://shop.example/old.png", timestamp: now - 50000 }),
      logEntry({ source: "network", level: "error", text: "Failed to load resource: the server responded with a status of 500 (Internal Server Error)", url: "https://user:pw@api.example/orders?session=SECRET#x", timestamp: now + 4 }),
      logEntry({ source: "network", level: "error", text: "Failed to load resource: net::ERR_NAME_NOT_RESOLVED", url: "https://cdn.example/lib.js", timestamp: now + 5 }),
      logEntry({ source: "violation", level: "verbose", text: "Forced reflow while executing JavaScript", timestamp: now + 6 }),
      // Runtime is off between calls; a stray event is not kept.
      consoleCall("error", [{ type: "string", value: "outside a call" }], now + 7),
    ]) debuggerEventListener({ tabId: tab }, method, params);
    seen.length = 0;
    const result = await callAndWait("page_errors", { tabId: tab, sessionId: "probs" });
    assert.equal(result.fresh, undefined, "the tab was attached already");
    assert.match(result.since, /^\d+s$/);
    assert.equal(result.note, undefined);
    const listed = () => plain(result.entries.map((entry) => [entry.kind, entry.text, entry.url ?? null, entry.earlier ?? false]));
    assert.deepEqual(listed(), [
      ["console.error", "boot failed", null, false],
      ["request", "HTTP 404 Not Found", "https://shop.example/old.png", true],
      ["exception", "Uncaught TypeError: Cannot read properties of null (reading 'x')", "https://shop.example/app.js:12:5", false],
      ["console.error", "fetch https://api.example/v1/me failed Object", null, false],
      ["request", "HTTP 500 Internal Server Error", "https://api.example/orders", false],
      ["request", "net::ERR_NAME_NOT_RESOLVED", "https://cdn.example/lib.js", false],
    ]);
    assert.ok(!JSON.stringify(result).includes("SECRET"), "a query value leaked");
    assert.ok(!JSON.stringify(result).includes("pw@"), "URL credentials leaked");
    // Runtime was on only for the call, and nothing ran in the page.
    assert.deepEqual(seen.map(([method]) => method), ["Runtime.enable", "Runtime.disable"]);
    // A second call takes the same replay again, not twice as much.
    const again = await callAndWait("page_errors", { tabId: tab, sessionId: "probs" });
    assert.equal(again.entries.length, result.entries.length);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "probs" });
  }
});

test("page_errors keeps a bounded list, counts repeats, and forgets a released or closed tab", async () => {
  const opened = await call("open_tab", { url: "https://shop.example/", sessionId: "probs2" });
  const tab = opened.tabId;
  const now = Date.now();
  const stored = [
    ...Array.from({ length: 3 }, () => consoleCall("error", [{ type: "string", value: "poll failed" }], now)),
    ...Array.from({ length: 60 }, (_, i) => consoleCall("error", [{ type: "string", value: `error ${i} ${"x".repeat(500)}` }], now + 1 + i)),
  ];
  playDialogPage(stored);
  try {
    await call("snapshot", { tabId: tab, sessionId: "probs2" });
    const result = await callAndWait("page_errors", { tabId: tab, sessionId: "probs2" });
    assert.equal(result.entries.length, 50);
    assert.equal(result.limit, 50);
    assert.equal(result.dropped, 11, "61 different problems, the first repeated three times");
    assert.ok(result.entries.every((entry) => entry.text.length <= 300));
    assert.match(result.entries.at(-1).text, /^error 59 x+…$/);
    // A repeat is counted on the entry before it.
    stored.length = 3;
    const counted = await callAndWait("page_errors", { tabId: tab, sessionId: "probs2" });
    assert.deepEqual(plain(counted.entries.map((entry) => [entry.text, entry.repeats])), [["poll failed", 3]]);
    // Failed requests are kept between calls; closed by the user, nothing is kept for the id.
    debuggerEventListener({ tabId: tab }, ...logEntry({ source: "network", level: "error", text: "Failed to load resource: net::ERR_FAILED", url: "https://x.example/", timestamp: Date.now() }));
    assert.equal(vm.runInContext(`captures.get(${tab}).entries.length`, extensionContext), 1);
    tabRemovedListener(tab);
    debuggerEventListener({ tabId: tab }, ...logEntry({ source: "network", level: "error", text: "Failed to load resource: net::ERR_FAILED", url: "https://x.example/", timestamp: Date.now() }));
    assert.equal(vm.runInContext(`captures.has(${tab})`, extensionContext), false);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "probs2" });
  }
});

test("page_errors on a page paused by a dialog lists failed requests and says why exceptions are missing", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/", sessionId: "probs4" })).tabId;
  const seen = playDialogPage([consoleCall("error", [{ type: "string", value: "never read" }], Date.now())]);
  try {
    await call("snapshot", { tabId: tab, sessionId: "probs4" });
    debuggerEventListener({ tabId: tab }, ...logEntry({ source: "network", level: "error", text: "Failed to load resource: the server responded with a status of 403 (Forbidden)", url: "https://shop.example/api", timestamp: Date.now() }));
    openDialog(tab, "alert", "Session expired");
    seen.length = 0;
    const result = await callAndWait("page_errors", { tabId: tab, sessionId: "probs4" });
    assert.match(result.note, /cannot be read while the page waits on JavaScript dialog d\d+/);
    assert.deepEqual(plain(result.entries.map((entry) => entry.text)), ["HTTP 403 Forbidden"]);
    assert.deepEqual(seen, [], "a paused page was sent a command");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "probs4" });
  }
});

test("page_errors on a tab not attached yet starts watching there and says so", async () => {
  const user = makeTab({ url: "https://shop.example/account", title: "Account" });
  const seen = playDialogPage();
  try {
    await call("use_tab", { tabId: user.id, sessionId: "probs3" });
    const result = await callAndWait("page_errors", { tabId: user.id, sessionId: "probs3" });
    assert.equal(result.fresh, true);
    assert.equal(result.entries.length, 0);
    const methods = seen.map(([method]) => method);
    assert.ok(methods.indexOf("Runtime.disable") > methods.indexOf("Runtime.enable"), "Runtime was left on");
    assert.ok(!methods.some((method) => method === "Page.navigate" || method === "Page.reload" || method === "Page.bringToFront"));
    assert.equal(tabs.get(user.id).active, false, "the tab was not activated");
    await call("release_tab", { tabId: user.id, sessionId: "probs3" });
    assert.equal(vm.runInContext(`captures.has(${user.id})`, extensionContext), false, "the capture outlived the release");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "probs3" });
  }
});

// ── frames ──────────────────────────────────────────────────────────────────
//
// A page with a same-site frame (in the page's renderer, reached through an
// isolated world) and a support chat from another site (its own renderer,
// reached through a session from Target.setAutoAttach), the way Stripe's
// support page embeds its widget.

/**
 * Play that page. The page lists 2 controls, the same-site frame 1, the chat
 * 2. Returns what was sent, as [method, params, sessionId].
 */
function playFramedPage(tabId, { chatSite = "https://help.example/chat", chatGone = false } = {}) {
  const sent = [];
  const owners = {
    SAME: { left: 10, top: 500, width: 300, height: 100, name: "", outer: { width: 300, height: 100 } },
    CHAT: { left: 800, top: 200, width: 400, height: 500, name: "Support Widget", outer: { width: 410, height: 510 } },
  };
  pageEval = (method, params, tab, session) => {
    sent.push([method, params, session]);
    const expression = params.expression ?? "";
    if (method === "Target.setAutoAttach" && !session) {
      debuggerEventListener({ tabId }, "Target.attachedToTarget", {
        sessionId: "S-CHAT", targetInfo: { type: "iframe", targetId: "CHAT", url: chatSite },
      });
      return {};
    }
    if (method === "Page.getFrameTree") {
      if (session === "S-CHAT") {
        if (chatGone) throw new Error("No session with given id");
        return { frameTree: { frame: { id: "CHAT", parentId: "MAIN", url: chatSite } } };
      }
      return { frameTree: { frame: { id: "MAIN", url: "https://shop.example/support" },
        childFrames: [{ frame: { id: "SAME", parentId: "MAIN", url: "https://shop.example/faq" } }] } };
    }
    if (method === "Page.createIsolatedWorld") return { executionContextId: params.frameId === "SAME" ? 7 : 9 };
    if (method === "DOM.getFrameOwner") return { backendNodeId: params.frameId === "SAME" ? 11 : 12 };
    if (method === "DOM.resolveNode") return { object: { objectId: params.backendNodeId === 11 ? "owner-SAME" : "owner-CHAT" } };
    if (method === "Runtime.callFunctionOn" && /^owner-/.test(params.objectId)) {
      const owner = owners[params.objectId.slice(6)];
      return { result: { value: { ...owner, shown: true, listed: true, view: { width: 1280, height: 800 } } } };
    }
    if (method === "Runtime.evaluate" && expression.includes("const base = options.base")) {
      const options = JSON.parse(expression.slice(expression.lastIndexOf("(") + 1, -1));
      const where = session === "S-CHAT" ? "chat" : params.contextId === 7 ? "same" : "page";
      const labels = { page: ["Top button", "Search"], same: ["FAQ"], chat: ["Message", "Send"] }[where];
      const elements = labels.map((label, i) => ({ i: options.base + i, tag: "button", label, x: 20 + i * 10, y: 30, inView: true }))
        .filter((element) => element.i >= options.offset && element.i < options.offset + options.limit);
      return { result: { value: {
        title: { page: "Support", same: "FAQ", chat: "Support Conversations Widget" }[where],
        url: "x", elements, total: labels.length, offset: options.offset, limit: options.limit,
        frames: where === "page" ? 2 : 0, framed: where === "page" ? 2 : 0, scope: "page", shown: true,
        truncated: false, nextOffset: null,
      } } };
    }
    if (method === "Runtime.evaluate" && expression.includes("const out = { title: document.title")) {
      const where = session === "S-CHAT" ? "chat" : params.contextId === 7 ? "same" : "page";
      const text = { page: "Contact support", same: "Questions and answers", chat: "Hello from the assistant\nHow can I help?" }[where];
      return { result: { value: { title: where === "chat" ? "Support Conversations Widget" : "x", url: "x", text, links: [], shown: true } } };
    }
    return { result: { value: {} } };
  };
  return sent;
}

test("a snapshot lists controls inside frames, numbered after the page's and placed on the page", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames1" })).tabId;
  const sent = playFramedPage(tab);
  try {
    const result = await callAndWait("snapshot", { tabId: tab, sessionId: "frames1" });
    assert.equal(result.total, 5);
    assert.deepEqual([...result.elements].map((element) => `${element.i} ${element.label} ${element.frame ?? "-"}`),
      ["0 Top button -", "1 Search -", "2 FAQ FAQ", "3 Message Support Widget", "4 Send Support Widget"]);
    const send = result.elements.find((element) => element.label === "Send");
    assert.equal(send.x, 30 + 800, "a point in the chat is moved by the frame's place on the page");
    assert.equal(send.y, 30 + 200);
    assert.equal(result.frames, 0, "every frame was searched");
    assert.equal(result.framesSearched, 2);
    // The chat runs in its own session, the same-site frame in an isolated world, never in the page itself.
    const snapshots = sent.filter(([method, params]) => method === "Runtime.evaluate" && params.expression.includes("const base = options.base"));
    assert.deepEqual(snapshots.map(([, params, session]) => `${session ?? "tab"}:${params.contextId ?? "-"}`), ["tab:-", "tab:7", "S-CHAT:-"]);
    const worlds = sent.filter(([method]) => method === "Page.createIsolatedWorld");
    assert.ok(worlds.every(([, params]) => params.worldName === "munim-computer-use" && params.frameId === "SAME"));
    assert.ok(!sent.some(([method]) => method === "Runtime.enable"), "Runtime was turned on");
    assert.equal(tabs.get(tab).active, false, "the tab was activated");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames1" });
  }
});

test("a click on an element in a frame runs in that frame and presses at its place on the page", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames2" })).tabId;
  const sent = playFramedPage(tab);
  const played = pageEval;
  pageEval = (method, params, tabId, session) => {
    const expression = params.expression ?? "";
    if (expression.includes("window.__cuClickProbe?.done()")) {
      sent.push([method, params, session]);
      return { result: { value: { ok: true, tag: "button", label: "Send", x: 30, y: 40, reachable: true, via: "own" } } };
    }
    if (expression.includes("const probe = window.__cuClickProbe")) {
      sent.push([method, params, session]);
      return { result: { value: { hover: true, press: true, click: true } } };
    }
    return played(method, params, tabId, session);
  };
  try {
    await callAndWait("snapshot", { tabId: tab, sessionId: "frames2" });
    const result = await callAndWait("click", { tabId: tab, index: 4, sessionId: "frames2" });
    assert.equal(result.route, "input");
    assert.equal(result.target, '[4] button "Send" in frame "Support Widget"');
    const mouse = sent.filter(([method]) => method === "Input.dispatchMouseEvent");
    assert.deepEqual(mouse.map(([, params, session]) => `${params.type}@${params.x},${params.y}:${session ?? "tab"}`),
      ["mouseMoved@830,240:tab", "mousePressed@830,240:tab", "mouseReleased@830,240:tab"]);
    const inFrame = sent.filter(([, params]) => (params.expression ?? "").includes("__cuClickProbe"));
    assert.ok(inFrame.length >= 2 && inFrame.every(([, , session]) => session === "S-CHAT"), "the click scripts ran outside the frame");
    assert.equal(tabs.get(tab).active, false);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames2" });
  }
});

test("a frame element outside what the frame shows is not pressed", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames3" })).tabId;
  const sent = playFramedPage(tab);
  const played = pageEval;
  pageEval = (method, params, tabId, session) => {
    if ((params.expression ?? "").includes("window.__cuClickProbe?.done()")) {
      return { result: { value: { ok: true, tag: "button", label: "Send", x: 30, y: 900, reachable: true, via: "own" } } };
    }
    return played(method, params, tabId, session);
  };
  try {
    await callAndWait("snapshot", { tabId: tab, sessionId: "frames3" });
    const error = await refuses("click", { tabId: tab, index: 4, sessionId: "frames3" });
    assert.match(error, /not clicked: \[4\] button "Send" in frame "Support Widget" cannot be reached — it is outside the part of frame "Support Widget"/);
    assert.ok(!sent.some(([method]) => method === "Input.dispatchMouseEvent"), "something was pressed");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames3" });
  }
});

test("fill in a frame focuses and checks the field there, and the text goes in through the tab", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames4" })).tabId;
  const sent = playFramedPage(tab);
  const played = pageEval;
  pageEval = (method, params, tabId, session) => {
    const expression = params.expression ?? "";
    if (expression.includes("__cuFillBefore = value()")) {
      sent.push(["prepare", params, session]);
      return { result: { value: { ok: true, tag: "textarea", label: "Message" } } };
    }
    if (expression.includes("const expected =")) {
      sent.push(["check", params, session]);
      return { result: { value: { ok: true, matches: true, length: 5 } } };
    }
    return played(method, params, tabId, session);
  };
  try {
    await callAndWait("snapshot", { tabId: tab, sessionId: "frames4" });
    const result = await callAndWait("fill", { tabId: tab, index: 3, text: "Hello", sessionId: "frames4" });
    assert.equal(result.target, '[3] textarea "Message" in frame "Support Widget"');
    const steps = sent.filter(([method]) => ["prepare", "check", "Input.insertText"].includes(method));
    assert.deepEqual(steps.map(([method, , session]) => `${method}:${session ?? "tab"}`),
      ["prepare:S-CHAT", "Input.insertText:tab", "check:S-CHAT"]);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames4" });
  }
});

test("an index in the page itself still acts on the page", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames5" })).tabId;
  const sent = playFramedPage(tab);
  const played = pageEval;
  pageEval = (method, params, tabId, session) => {
    if ((params.expression ?? "").includes("__cuFillBefore = value()")) {
      sent.push(["prepare", params, session]);
      return { result: { value: { ok: true, tag: "input", label: "Search" } } };
    }
    if ((params.expression ?? "").includes("const expected =")) return { result: { value: { ok: true, matches: true, length: 1 } } };
    return played(method, params, tabId, session);
  };
  try {
    await callAndWait("snapshot", { tabId: tab, sessionId: "frames5" });
    const result = await callAndWait("fill", { tabId: tab, index: 1, text: "x", sessionId: "frames5" });
    assert.equal(result.target, '[1] input "Search"');
    const prepare = sent.find(([method]) => method === "prepare");
    assert.equal(prepare[2], undefined);
    assert.equal(prepare[1].contextId, undefined);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames5" });
  }
});

test("read follows the page's text with each frame's, under the frame's name", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames6" })).tabId;
  playFramedPage(tab);
  try {
    const result = await callAndWait("read", { tabId: tab, sessionId: "frames6" });
    assert.equal(result.text, 'Contact support\n\n[frame "x"]\nQuestions and answers\n\n[frame "Support Widget"]\nHello from the assistant\nHow can I help?');
    assert.equal(result.framesRead, 2);
    assert.equal(result.frames, undefined);
    const focused = await callAndWait("read", { tabId: tab, query: "assistant", sessionId: "frames6" });
    assert.equal(focused.matches, 1);
    assert.match(focused.text, /\[frame "Support Widget"\]\nHello from the assistant/);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames6" });
  }
});

test("wait_for_selector is met by a match inside a frame", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames7" })).tabId;
  const played = playFramedPage(tab) && pageEval;
  pageEval = (method, params, tabId, session) => {
    const expression = params.expression ?? "";
    if (expression.includes("invalid CSS selector")) {
      return { result: { value: session === "S-CHAT" ? { met: true } : { met: false, frames: 1, shown: true } } };
    }
    if (expression === "document.title") return { result: { value: "Support Conversations Widget" } };
    return played(method, params, tabId, session);
  };
  try {
    const result = await callAndWait("snapshot", { tabId: tab, waitForSelector: ".assistant-reply", waitTimeoutMs: 1000, sessionId: "frames7" });
    assert.equal(result.readiness.status, "met");
    assert.equal(result.readiness.frame, "Support Widget");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames7" });
  }
});

test("a frame the user's site rules block is neither searched nor acted in", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames8" })).tabId;
  const sent = playFramedPage(tab);
  const sites = [{ pattern: "help.example", rule: "block" }];
  try {
    const result = await callAndWait("snapshot", { tabId: tab, sites, sessionId: "frames8" });
    assert.equal(result.total, 3, "the chat's controls were listed");
    assert.equal(result.framesBlocked, 1);
    assert.equal(result.frames, 1, "the blocked chat counts as not searched");
    assert.ok(!sent.some(([method, , session]) => method === "Runtime.evaluate" && session === "S-CHAT"), "a script ran in the blocked frame");
    const read = await callAndWait("read", { tabId: tab, sites, sessionId: "frames8" });
    assert.doesNotMatch(read.text, /assistant/);
    assert.equal(read.frames, 1);
    // Indices from a snapshot taken before the rule: the frame is refused.
    await callAndWait("snapshot", { tabId: tab, sessionId: "frames8" });
    const error = await refuses("click", { tabId: tab, index: 4, sites, sessionId: "frames8" });
    assert.match(error, /element 4 is in a frame from https:\/\/help\.example, which the user's Computer Use policy does not allow/);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames8" });
  }
});

test("credentials are never filled into a frame", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames9" })).tabId;
  playFramedPage(tab);
  const windowsBefore = openedWindows.length;
  try {
    await callAndWait("snapshot", { tabId: tab, sessionId: "frames9" });
    const error = await refuses("request_credentials", { tabId: tab, fields: [{ index: 3, kind: "password" }], sessionId: "frames9" });
    assert.match(error, /element 3 is inside an embedded frame/);
    assert.equal(openedWindows.length, windowsBefore, "a prompt opened for a field in a frame");
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames9" });
  }
});

test("an index in a frame that went away asks for a new snapshot", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "frames10" })).tabId;
  playFramedPage(tab);
  try {
    await callAndWait("snapshot", { tabId: tab, sessionId: "frames10" });
    debuggerEventListener({ tabId: tab }, "Target.detachedFromTarget", { sessionId: "S-CHAT" });
    const error = await refuses("click", { tabId: tab, index: 3, sessionId: "frames10" });
    assert.match(error, /element 3 was in frame "Support Widget", which is no longer on the page — call browser_snapshot again/);
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames10" });
  }
});

test("a page with no frames costs no frame calls", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/plain", sessionId: "frames11" })).tabId;
  const sent = [];
  pageEval = (method, params) => {
    sent.push(method);
    if ((params.expression ?? "").includes("const base = options.base")) {
      return { result: { value: { title: "Plain", url: "x", elements: [], total: 0, frames: 0, framed: 0, shown: true } } };
    }
    return { result: { value: {} } };
  };
  try {
    const result = await callAndWait("snapshot", { tabId: tab, sessionId: "frames11" });
    assert.equal(result.framed, undefined);
    assert.ok(!sent.some((method) => /^(Page\.getFrameTree|DOM\.|Page\.createIsolatedWorld)/.test(method)), sent.join(","));
  } finally {
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "frames11" });
  }
});

test("screenshot captures a background tab at the size asked for, without showing it", async () => {
  const tab = (await call("open_tab", { url: "https://shop.example/support", sessionId: "shot1" })).tabId;
  const sent = [];
  const updates = [];
  const update = chrome.tabs.update;
  const windowUpdate = chrome.windows.update;
  chrome.tabs.update = async (id, props) => { updates.push(["tab", id, props]); return update(id, props); };
  chrome.windows.update = async (id, props) => { updates.push(["window", id, props]); return {}; };
  pageEval = (method, params) => {
    sent.push([method, params]);
    if ((params.expression ?? "").includes("devicePixelRatio")) {
      return { result: { value: { width: 1400, height: 900, x: 0, y: 120, dpr: 2, shown: true } } };
    }
    if (method === "Page.captureScreenshot") return { data: "aW1hZ2U=" };
    return { result: { value: {} } };
  };
  try {
    const result = await callAndWait("screenshot", { tabId: tab, format: "jpeg", maxWidth: 700, sessionId: "shot1" });
    assert.equal(result.data, "aW1hZ2U=");
    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.width, 700);
    assert.equal(result.height, 450);
    assert.equal(result.cssWidth, 1400);
    assert.equal(result.scrollY, 120);
    const capture = sent.find(([method]) => method === "Page.captureScreenshot")[1];
    assert.equal(capture.format, "jpeg");
    assert.equal(capture.quality, 55);
    assert.equal(capture.clip.scale, 0.25, "2800 device pixels down to 700");
    assert.equal(capture.clip.y, 120);
    const full = await callAndWait("screenshot", { tabId: tab, maxWidth: 0, sessionId: "shot1" });
    assert.equal(full.width, 2800);
    assert.equal(sent.filter(([method]) => method === "Page.captureScreenshot").at(-1)[1].clip, undefined);
    assert.equal(updates.length, 0, "the tab or its window was brought forward");
    assert.equal(tabs.get(tab).active, false);
    assert.ok(!sent.some(([method]) => method === "Page.bringToFront"));
    assert.match(await refuses("screenshot", { tabId: tab, format: "gif", sessionId: "shot1" }), /format must be png or jpeg/);
  } finally {
    chrome.tabs.update = update;
    chrome.windows.update = windowUpdate;
    pageEval = () => ({ result: { value: {} } });
    await call("close_all_tabs", { sessionId: "shot1" });
  }
});

// ── runner ──────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, body] of checks) {
  try {
    await body();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(failed ? `\n${failed} failed` : `\n${checks.length} passed`);
process.exit(failed ? 1 : 0);
