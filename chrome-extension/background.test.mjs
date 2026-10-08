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
let connects = 0;
let sent = [];
/** Tabs the extension attached the debugger to, in order. */
const attaches = [];
let debuggerDetachListener = null;

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
    create: async ({ url }) => makeTab({ url }),
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
      const id = groupId ?? nextGroupId++;
      if (!groups.has(id)) groups.set(id, {});
      for (const tabId of tabIds) tabs.get(tabId).groupId = id;
      return id;
    },
    ungroup: async (ids) => ids.forEach((id) => { tabs.get(id).groupId = -1; }),
    onUpdated: { addListener() {}, removeListener() {} },
    onRemoved: { addListener() {} },
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
    sendCommand: async (target, method, params) => pageEval(method, params ?? {}, target.tabId),
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
const extensionContext = vm.createContext({ ...globalThis, URL, chrome, console, fetch });
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
    if (expression.includes("data-cu-idx=\"3\"")) return { result: { value: { ok: true, tag: "button", x: 5, y: 5 } } };
    if (expression.includes("querySelectorAll(sel)")) {
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
      if (expression.includes("data-cu-idx=\"3\"")) return { result: { value: { ok: true, tag: "button", x: 5, y: 5 } } };
      if (expression.includes("querySelectorAll(sel)")) return { result: { value: { title: "Ready", elements: [] } } };
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
    if (method.startsWith("Input.") || expression.includes("data-cu-idx=\"")) actions++;
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
    ...[-1, 10001, 0.5, "100", null].map((waitTimeoutMs) => ({ returnState: true, waitForSelector: "#ready", waitTimeoutMs })),
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
    if (expression.includes("data-cu-idx=\"3\"")) {
      clicks++;
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
    if (expression.includes("data-cu-idx=\"3\"")) {
      clicks++;
      return { result: { value: { ok: true, x: 5, y: 5 } } };
    }
    if (expression.includes("visibleSelectorInPage")) throw new Error("readiness transport unavailable");
    return { result: { value: { title: "Current", elements: [] } } };
  };
  const result = await callAndWait("click", { tabId: pageTab, index: 3, returnState: true, waitForSelector: "#ready" });
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

test("return_state does not read a blocked site the action landed on", async () => {
  const sites = [{ pattern: "bank.example", rule: "block" }];
  const tab = tabs.get(pageTab);
  const before = tab.url;
  let snapshots = 0;
  pageEval = (method, params) => {
    const expression = params.expression ?? "";
    if (expression.includes("data-cu-idx=\"2\"")) {
      // The click follows a link into a blocked site.
      tab.url = "https://www.bank.example/accounts";
      return { result: { value: { ok: true, tag: "a", x: 5, y: 5 } } };
    }
    if (expression.includes("querySelectorAll(sel)")) {
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
    if (params.expression?.includes("querySelectorAll(sel)")) expressions.push(params.expression);
    return { result: { value: {} } };
  };
  await call("snapshot", { tabId: pageTab, offset: 250, limit: 20 });
  assert.ok(expressions[0].endsWith('({"offset":250,"limit":20})'));
  const count = expressions.length;
  const malformed = [
    { offset: -1 }, { offset: "250" }, { offset: 1.5 }, { offset: null },
    { offset: 2147483648 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 251 }, { limit: "10" }, { limit: null },
  ];
  for (const args of malformed) {
    assert.match(await refuses("snapshot", { tabId: pageTab, ...args }), /offset must|limit must/);
  }
  assert.equal(expressions.length, count, "malformed pagination reached page script");
  await call("snapshot", { tabId: pageTab });
  assert.ok(expressions.at(-1).endsWith('({"offset":0,"limit":250})'));
  pageEval = () => ({ result: { value: {} } });
});

test("a snapshot clears indices an earlier snapshot left on now-hidden elements", () => {
  const element = (tag, { hidden = false, idx } = {}) => {
    const attributes = new Map(idx === undefined ? [] : [["data-cu-idx", idx]]);
    return {
      tagName: tag.toUpperCase(),
      innerText: tag,
      matches: () => false,
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
