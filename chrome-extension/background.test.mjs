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
let nativeListener = null;
let sent = [];

function makeTab({ url = "about:blank", title = "t", active = false, favIconUrl = "" }) {
  const id = nextTabId++;
  tabs.set(id, { id, url, title, active, favIconUrl, windowId: 1, groupId: -1 });
  return tabs.get(id);
}

const chrome = {
  runtime: {
    connectNative: () => ({
      onMessage: { addListener: (fn) => { nativeListener = fn; } },
      onDisconnect: { addListener() {} },
      postMessage: (message) => sent.push(message),
    }),
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    onMessage: { addListener() {} },
    lastError: null,
    getURL: (file) => `chrome-extension://fake/${file}`,
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
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
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({ result: { value: {} } }) },
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

vm.runInContext(source, vm.createContext({ ...globalThis, chrome, console, fetch }), {
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
