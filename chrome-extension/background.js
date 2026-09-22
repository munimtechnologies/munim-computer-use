// MT Code desktop control — Chrome side.
//
// The agent works in tabs it owns. Ownership is acquired two ways:
//
//   - `open_tab` creates a new background tab and collects it into a labelled
//     tab group. The user's own tabs are untouched and they keep browsing.
//   - `use_tab` adopts a tab the user already had open, on request, so the
//     agent can drive a page that is already signed in / mid-flow rather than
//     re-opening it. An adopted tab is never moved into the group and never
//     closed on cleanup — releasing it just hands it back.
//
// Page interaction goes through the DevTools protocol rather than synthetic
// mouse input, which is what makes it work in a *background* tab: a window only
// renders its active tab, so anything coordinate-based would be blind the
// moment the user switches away.
//
// Commands arrive from the desktop app over native messaging; every reply
// carries the originating request id.

// Embedder configuration. `scripts/build-extension.mjs` rewrites the block
// between the markers to build a variant for an app that runs the server under
// its own identity (its own native-messaging host name, its own group title).
// @embed-config-begin
/**
 * Native-messaging hosts to try, in order; the first one Chrome can start wins.
 * `com.munimtech.computer-use.desktop` is the pre-rename id: installs that
 * still carry only that manifest keep working until they run the installer
 * again, rather than being unable to reach the desktop at all.
 */
const NATIVE_HOSTS = ["com.munim.mtcode.desktop", "com.munimtech.computer-use.desktop"];
/** Title of the agent's tab group. */
const GROUP_TITLE = "MT Code";
// @embed-config-end
/**
 * Chrome's tab-group palette. Two MCP clients sharing one window are told apart
 * by colour, not by an id in the group title: the strip is narrow, and a hash
 * next to the product name reads as noise rather than as information.
 */
const GROUP_COLORS = ["blue", "cyan", "purple", "pink", "green", "yellow", "orange", "red", "grey"];
const OWNED_STATE_KEY = "ownedState";

/**
 * Per-MCP-client ownership. Cursor and MT Code (and extra MCP children) share
 * one extension via the desktop bridge; each process has its own clientId so
 * one client's cleanup cannot close another client's tabs.
 *
 * `tabs` is every owned tab; `adopted` is the subset that was the user's. The
 * favicon an adopted tab had before it was badged is kept in the page itself
 * (see applyFavicon), so a release can put the tab back the way we found it.
 *
 * @typedef {{ tabs: Set<number>, adopted: Set<number>, groupId: number|null }} ClientOwned
 * @type {Map<string, ClientOwned>}
 */
const clients = new Map();
/** tabId → clientId, for assertOwned / favicon listeners / onRemoved. */
const tabOwner = new Map();
/** Tabs we have attached the debugger to, so we detach exactly once. */
const attached = new Set();
let port = null;
let reconnectTimer = null;
/** Quick retries since the last message; the minute alarm takes over after. */
let quickRetries = 0;
const QUICK_RETRY_LIMIT = 5;
let stateReady = null;

function requireClientId(params) {
  const clientId = params && typeof params.clientId === "string" ? params.clientId.trim() : "";
  if (!clientId) throw new Error("clientId is required");
  return clientId;
}

/** @returns {ClientOwned} */
function clientState(clientId) {
  let state = clients.get(clientId);
  if (!state) {
    state = { tabs: new Set(), adopted: new Set(), groupId: null };
    clients.set(clientId, state);
  }
  return state;
}

function groupColorFor(clientId) {
  // Stable per client, so a reconnecting agent lands back on its own colour
  // rather than repainting the group the user has been watching.
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) hash = (hash * 31 + clientId.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

async function persistOwnedState() {
  try {
    const serialized = {};
    for (const [clientId, state] of clients) {
      serialized[clientId] = {
        tabs: Array.from(state.tabs),
        adopted: Array.from(state.adopted),
        groupId: state.groupId,
        processId: state.processId,
        sessionId: state.sessionId,
      };
    }
    await chrome.storage.session.set({ [OWNED_STATE_KEY]: { clients: serialized } });
  } catch {
    // Storage can fail in restricted contexts; ownership still works in-memory.
  }
}

async function restoreOwnedState() {
  try {
    const stored = await chrome.storage.session.get(OWNED_STATE_KEY);
    const state = stored?.[OWNED_STATE_KEY];
    if (!state || typeof state !== "object") return;

    clients.clear();
    tabOwner.clear();

    // Legacy single-owner shape: { tabs, groupId }.
    if (Array.isArray(state.tabs)) {
      const legacy = clientState("legacy");
      for (const tabId of state.tabs) {
        if (typeof tabId !== "number") continue;
        try {
          await chrome.tabs.get(tabId);
          legacy.tabs.add(tabId);
          tabOwner.set(tabId, "legacy");
        } catch {
          // Tab closed while the service worker was asleep.
        }
      }
      // The legacy shape predates adoption, so every restored tab is agent-created.
      legacy.groupId = typeof state.groupId === "number" ? state.groupId : null;
      if (legacy.groupId !== null) {
        try {
          await chrome.tabGroups.get(legacy.groupId);
        } catch {
          legacy.groupId = null;
        }
      }
      await persistOwnedState();
      return;
    }

    const serialized = state.clients && typeof state.clients === "object" ? state.clients : {};
    for (const [clientId, entry] of Object.entries(serialized)) {
      if (!entry || typeof entry !== "object") continue;
      const next = clientState(clientId);
      next.processId = typeof entry.processId === "string" ? entry.processId : clientId;
      next.sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
      for (const tabId of Array.isArray(entry.tabs) ? entry.tabs : []) {
        if (typeof tabId !== "number") continue;
        try {
          await chrome.tabs.get(tabId);
          next.tabs.add(tabId);
          tabOwner.set(tabId, clientId);
        } catch {
          // Tab closed while the service worker was asleep.
        }
      }
      for (const item of Array.isArray(entry.adopted) ? entry.adopted : []) {
        // 0.4.0 stored [tabId, favIconUrl] pairs; later versions store bare ids.
        const tabId = Array.isArray(item) ? item[0] : item;
        // Only tabs that survived the ownership restore above can stay adopted.
        if (typeof tabId === "number" && next.tabs.has(tabId)) next.adopted.add(tabId);
      }
      next.groupId = typeof entry.groupId === "number" ? entry.groupId : null;
      if (next.groupId !== null) {
        try {
          await chrome.tabGroups.get(next.groupId);
        } catch {
          next.groupId = null;
        }
      }
    }
    await persistOwnedState();
  } catch {
    // Fresh start if session storage is unavailable.
  }
}

function ensureStateReady() {
  if (!stateReady) stateReady = restoreOwnedState();
  return stateReady;
}

// ── native messaging ────────────────────────────────────────────────────────

function connect() {
  if (port) return;
  // Chrome throws for a host id it has no manifest for, so try each configured
  // name in order (see NATIVE_HOSTS).
  for (const host of NATIVE_HOSTS) {
    try {
      port = chrome.runtime.connectNative(host);
      break;
    } catch {
      port = null;
    }
  }
  if (!port) return;
  const sessionPort = port;
  sessionPort.onMessage.addListener((msg) => {
    quickRetries = 0;
    void handleCommand(msg, sessionPort);
  });
  sessionPort.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port !== sessionPort) return;
    port = null;
    // Losing the transport is not the end of every task. In particular, an
    // owning MCP process can exit while peers elect a replacement. Keep their
    // tabs and ownership; only explicit client/session cleanup may close them.
    // Retry quickly so a re-elected owner is picked up within seconds, but back
    // off: with no MCP server running every attempt spawns a native host.
    if (reconnectTimer === null && quickRetries < QUICK_RETRY_LIMIT) {
      const delay = 1000 * 2 ** quickRetries;
      quickRetries += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }
  });
}

// The desktop app comes and goes with the user's session, so reconnect on a
// schedule. An alarm rather than setTimeout: a service worker is terminated
// when idle and timers do not survive that, which would strand the connection
// until the user reloaded the extension by hand.
// Chrome clamps alarm periods to a minute, so ask for what we will get.
chrome.alarms.create("cu-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cu-reconnect") connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// Connect as soon as the service worker evaluates. onStartup/onInstalled alone
// can miss unpacked loads; content-script pings also wake us via onMessage.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "cu-wake") connect();
});
connect();

function reply(portRef, id, result) {
  try {
    portRef?.postMessage({ id, ok: true, result });
  } catch {
    // Port went away mid-command; drop the reply.
  }
}

function replyError(portRef, id, message) {
  try {
    portRef?.postMessage({ id, ok: false, error: String(message) });
  } catch {
    // Port went away mid-command; drop the reply.
  }
}

// ── tab + group management ──────────────────────────────────────────────────

// Commands for one task run in order. Different tasks never share this queue.
// Register queues before starting work, so process cleanup also sees queued opens.
const commandQueues = new Map();
function enqueue(clientId, task) {
  const run = (commandQueues.get(clientId) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  commandQueues.set(clientId, tail);
  void tail.then(() => {
    if (commandQueues.get(clientId) === tail) commandQueues.delete(clientId);
  });
  return run;
}

async function ensureGroup(clientId, tabId) {
    const state = clientState(clientId);
    // Re-create the group if the user dismissed it or Chrome dropped it.
    if (state.groupId !== null) {
      try {
        await chrome.tabGroups.get(state.groupId);
      } catch {
        state.groupId = null;
      }
    }
    if (state.groupId === null) {
      state.groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(state.groupId, {
        title: state.sessionId ? `${GROUP_TITLE} · ${state.sessionId}` : GROUP_TITLE,
        color: groupColorFor(clientId),
      });
    } else {
      await chrome.tabs.group({ groupId: state.groupId, tabIds: [tabId] });
    }
    // Agent tabs get the pointer favicon (not the MT toolbar logo) as soon as
    // they join the group, so the strip reads as "agent-owned" before the first click.
    await markTab(tabId);
    await persistOwnedState();
    return state.groupId;
}

async function openTab(clientId, url) {
  // active:false is the whole point — the user stays on whatever they were doing.
  const tab = await chrome.tabs.create({ url: url || "about:blank", active: false });
  const state = clientState(clientId);
  state.tabs.add(tab.id);
  tabOwner.set(tab.id, clientId);
  await ensureGroup(clientId, tab.id);
  await persistOwnedState();
  // Pages replace their favicon on load (Spotify, YouTube, …). Re-apply the
  // pointer whenever the document finishes, and also when the tab's own icon
  // changes, so the strip stays on the agent cursor rather than the site logo.
  chrome.tabs.onUpdated.addListener(function badge(id, info) {
    if (id !== tab.id) return;
    if (info.status === "complete" || info.favIconUrl) markTab(tab.id);
    if (!tabOwner.has(tab.id)) chrome.tabs.onUpdated.removeListener(badge);
  });
  return { tabId: tab.id, url: tab.url, title: tab.title, clientId };
}

async function listTabs(clientId, all = false) {
  const state = clientState(clientId);
  const out = [];
  if (all) {
    // Every tab in every window, so the agent can pick one the user already has
    // open and adopt it with use_tab. Ownership is reported per tab rather than
    // filtered out: an unowned row is still a valid use_tab target.
    for (const tab of await chrome.tabs.query({})) {
      if (typeof tab.id !== "number") continue;
      const owner = tabOwner.get(tab.id);
      out.push({
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        owned: owner === clientId,
        adopted: state.adopted.has(tab.id),
        // A tab held by a peer MCP client is not ours to take.
        otherAgent: owner !== undefined && owner !== clientId,
        attachable: isAttachable(tab.url),
      });
    }
    return { groupId: state.groupId, tabs: out, clientId, scope: "all" };
  }
  // Snapshot first: the loop drops ids for tabs the user closed behind us.
  const known = Array.from(state.tabs);
  for (const tabId of known) {
    try {
      const tab = await chrome.tabs.get(tabId);
      out.push({
        tabId,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        owned: true,
        adopted: state.adopted.has(tabId),
      });
    } catch {
      forgetTab(clientId, tabId);
    }
  }
  return { groupId: state.groupId, tabs: out, clientId, scope: "agent" };
}

/// Chrome refuses a debugger attach on its own pages and on the Web Store, so
/// adopting one would hand back a tab_id that fails on the first snapshot.
function isAttachable(url) {
  const target = String(url || "");
  if (!target || target === "about:blank") return true;
  if (/^(chrome|devtools|chrome-extension|edge|about):/i.test(target)) return false;
  if (/^https:\/\/chromewebstore\.google\.com\//i.test(target)) return false;
  if (/^https:\/\/chrome\.google\.com\/webstore/i.test(target)) return false;
  return true;
}

/// Drop every trace of one tab from one client's bookkeeping.
function forgetTab(clientId, tabId) {
  const state = clients.get(clientId);
  if (state) {
    state.tabs.delete(tabId);
    state.adopted.delete(tabId);
  }
  if (tabOwner.get(tabId) === clientId) {
    tabOwner.delete(tabId);
    attached.delete(tabId);
  }
}

/// Take over a tab the user already had open. The tab keeps its place in the
/// strip — no group move, no activation, no reload — because the user may be
/// looking straight at it.
async function adoptTab(clientId, tabId) {
  if (typeof tabId !== "number") throw new Error("tabId is required");
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw new Error(`there is no open tab with id ${tabId} — call list_tabs with all:true`);
  });
  if (!isAttachable(tab.url)) {
    throw new Error(`Chrome does not allow automating ${tab.url || "that page"}`);
  }
  const owner = tabOwner.get(tabId);
  if (owner !== undefined && owner !== clientId) {
    throw new Error(`tab ${tabId} is already being used by another agent`);
  }
  const state = clientState(clientId);
  const alreadyOwned = state.tabs.has(tabId);
  state.tabs.add(tabId);
  tabOwner.set(tabId, clientId);
  // Only tabs that arrived through adoption are release-on-cleanup; one that
  // the agent opened itself stays agent-created even if use_tab is called on it.
  if (!alreadyOwned) state.adopted.add(tabId);
  await persistOwnedState();
  // Badge it the way agent-opened tabs are badged: with a user tab especially,
  // the strip is the only place they can see the agent has it.
  if (state.adopted.has(tabId)) await markTab(tabId);
  return {
    tabId,
    url: tab.url,
    title: tab.title,
    windowId: tab.windowId,
    adopted: state.adopted.has(tabId),
    clientId,
  };
}

/// Hand an adopted tab back to the user: detach the debugger, clear the agent
/// cursor, restore the favicon we replaced. The tab itself is left alone.
async function releaseTab(clientId, tabId) {
  const state = clientState(clientId);
  if (!state.adopted.has(tabId)) {
    if (state.tabs.has(tabId)) {
      throw new Error(`tab ${tabId} was opened by the agent — close it with close_tab`);
    }
    throw new Error(`tab ${tabId} is not one of this agent's tabs`);
  }
  await hideCursor(tabId);
  await detachTab(tabId);
  await unmarkTab(tabId);
  forgetTab(clientId, tabId);
  if (state.tabs.size === 0 && state.groupId === null) clients.delete(clientId);
  await persistOwnedState();
  return { released: tabId, clientId };
}

/// Close a captured set of one client's agent tabs. Only mutates that client's
/// ownership so a peer MCP client's tabs survive.
async function closeOwnedTabs(clientId, ids, expectedGroupId) {
  const state = clients.get(clientId);
  let released = 0;
  let closed = 0;
  for (const id of ids) {
    if (tabOwner.get(id) !== clientId) continue;
    // An adopted tab is the user's. Cleanup hands it back; it is never closed,
    // which is the whole reason adoption is tracked separately from ownership.
    if (state?.adopted.has(id)) {
      await hideCursor(id);
      await detachTab(id);
      await unmarkTab(id);
      forgetTab(clientId, id);
      released += 1;
      continue;
    }
    closed += 1;
    if (state) state.tabs.delete(id);
    tabOwner.delete(id);
    attached.delete(id);
    try {
      await chrome.tabs.remove(id);
    } catch {
      // Already closed by the user; nothing to do.
    }
  }
  if (state && expectedGroupId !== null && state.groupId === expectedGroupId) {
    try {
      const remaining = await chrome.tabs.query({ groupId: expectedGroupId });
      // Ungroup stragglers that are not part of this client's owned set — a
      // reconnect may already have placed new agent tabs in this same group.
      const leftover = remaining.filter((t) => !state.tabs.has(t.id));
      if (leftover.length) {
        await chrome.tabs.ungroup(leftover.map((t) => t.id));
        // They are out of the agent group now, so they should stop wearing its
        // pointer. A client that still owns one re-badges on its next command.
        for (const t of leftover) await unmarkTab(t.id);
      }
    } catch {
      // The group is already gone.
    }
    if (state.groupId === expectedGroupId && state.tabs.size === 0) {
      state.groupId = null;
    }
  }
  if (state && state.tabs.size === 0 && state.groupId === null) {
    clients.delete(clientId);
  }
  await persistOwnedState();
  return { closed, released, clientId };
}

async function closeAllTabs(clientId) {
  const state = clientState(clientId);
  return closeOwnedTabs(clientId, Array.from(state.tabs), state.groupId);
}

function assertOwned(clientId, tabId) {
  if (tabOwner.get(tabId) !== clientId) {
    throw new Error(`tab ${tabId} is not one of this agent's tabs`);
  }
}

// ── DevTools protocol ───────────────────────────────────────────────────────

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
}

/// Let go of a tab's debugger session, clearing Chrome's "is debugging this
/// browser" banner. Safe to call for a tab that was never attached.
async function detachTab(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Tab gone, or Chrome already tore the session down.
  }
}

async function send(tabId, method, params = {}) {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/// A compact outline of the interactive elements on the page, with ids the
/// agent can click. Mirrors the accessibility-tree tools on the desktop side.
const SNAPSHOT_JS = `(() => {
  const out = [];
  const sel = 'a,button,input,textarea,select,cfc-select,mat-option,[role=button],[role=link],[role=textbox],[role=combobox],[role=listbox],[role=option],[role=menu],[role=menuitem],[aria-haspopup],[contenteditable=true],summary';
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value ||
                   el.getAttribute('title') || el.getAttribute('placeholder') || '')
                  .replace(/\\s+/g, ' ').trim().slice(0, 90);
    el.setAttribute('data-cu-idx', String(i));
    out.push({
      i: i++,
      tag: el.tagName.toLowerCase(),
      label,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      inView: r.top >= 0 && r.bottom <= innerHeight,
    });
    if (i >= 250) break;
  }
  return { title: document.title, url: location.href, elements: out };
})()`;

async function snapshot(tabId) {
  const res = await send(tabId, "Runtime.evaluate", {
    expression: SNAPSHOT_JS,
    returnByValue: true,
  });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || "evaluate failed");
  return res.result.value;
}

async function clickAt(tabId, x, y) {
  // Show the same agent pointer the desktop overlay uses, painted into the page.
  const cursor = await paintCursor(tabId, x, y);
  // A hover first, then press/release carrying the button bitmask. Single-page
  // apps route clicks through pointer/hover handlers, and without the leading
  // mouseMoved (or with buttons unset) the press lands on nothing.
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse",
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
  await markTab(tabId);
  return { clicked: { x, y }, cursor };
}

/// The agent cursor, drawn into the page itself so a controlled tab shows the
/// same pointer as the desktop overlay. Fixed-position, pointer-events:none and
/// max z-index, so it is purely decorative and cannot intercept anything.
///
/// Uses the PNG rendered from BubbleView in AgentCursor.swift (not a hand-traced
/// SVG) so Chrome and desktop stay pixel-matched: same glow, fill, rim, shape.
/// The overlay asset is the 2x render (224px shown at 112 CSS px) so it stays as
/// crisp as the desktop panel on Retina/HiDPI displays; the 1x file is kept for
/// the tab favicon.
/// Motion mirrors the desktop overlay: slow fade-in, cubic flight with tip
/// following path tangent, and fade-out after Computer Use tools stop (not a
/// short idle after the last pixel move).
const CURSOR_IMG_URL = chrome.runtime.getURL("icons/cursor-224.png");
const CURSOR_HOTSPOT = 56; // OverlayController.hotspot — tip at centre of 112×112
const CURSOR_FADE_IN_MS = 500;
const CURSOR_FADE_OUT_MS = 350;
/** Match desktop `COMPUTER_USE_AGENT_CURSOR_TASK_FADE_SECS` default (8s). */
const CURSOR_TASK_FADE_MS = 8000;

const PAINT_CURSOR_JS = `
  (function paint(x, y, src, fadeInMs, fadeOutMs, taskFadeMs, hotspot) {
    const ID = '__munimAgentCursor';
    const easeInOut = (t) => t * t * (3 - 2 * t);
    const bezier = (p0, p1, p2, p3, t) => {
      const u = 1 - t;
      return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3;
    };
    const bezierTan = (p0, p1, p2, p3, t) => {
      const u = 1 - t;
      return 3*u*u*(p1-p0) + 6*u*t*(p2-p1) + 3*t*t*(p3-p2);
    };

    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ID;
      el.style.cssText = 'position:fixed;left:0;top:0;width:112px;height:112px;' +
        'pointer-events:none;z-index:2147483647;opacity:0;will-change:transform,opacity;' +
        'transform-origin:' + hotspot + 'px ' + hotspot + 'px;';
      // Same artwork as desktop BubbleView / MunimAgentCursor (cursor-224.png, 2x).
      const img = document.createElement('img');
      img.src = src;
      img.width = 112;
      img.height = 112;
      img.alt = '';
      img.draggable = false;
      img.style.cssText = 'display:block;width:112px;height:112px;' +
        'transform-origin:' + hotspot + 'px ' + hotspot + 'px;will-change:transform;';
      el.appendChild(img);
      (document.documentElement || document.body).appendChild(el);
      el.__cu = { x: x, y: y, tilt: 0, arc: 1, raf: 0, breatheRaf: 0, phase: 0 };
    } else {
      const img = el.querySelector('img');
      if (img && img.src !== src) img.src = src;
    }

    const st = el.__cu || (el.__cu = { x: x, y: y, tilt: 0, arc: 1, raf: 0, breatheRaf: 0, phase: 0 });
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    clearTimeout(el.__cuhide);

    // Idle breathe matches BubbleView: scale 1 + 0.03*sin(phase) on the artwork.
    const ensureBreathe = () => {
      if (st.breatheRaf) return;
      const tick = () => {
        const img = el.querySelector('img');
        if (!img || parseFloat(getComputedStyle(el).opacity) < 0.05) {
          st.breatheRaf = 0;
          if (img) img.style.transform = '';
          return;
        }
        st.phase = (st.phase || 0) + 0.045;
        const breathe = 1 + 0.03 * Math.sin(st.phase);
        img.style.transform = 'scale(' + breathe + ')';
        st.breatheRaf = requestAnimationFrame(tick);
      };
      st.breatheRaf = requestAnimationFrame(tick);
    };

    const place = (px, py, tilt) => {
      st.x = px; st.y = py; st.tilt = tilt;
      el.style.transform = 'translate(' + (px - hotspot) + 'px,' + (py - hotspot) +
        'px) rotate(' + tilt + 'rad)';
    };

    const fromX = st.x;
    const fromY = st.y;
    const dx = x - fromX;
    const dy = y - fromY;
    const dist = Math.hypot(dx, dy);
    const fresh = parseFloat(getComputedStyle(el).opacity) < 0.05;

    let waitMs = 80;
    if (fresh) {
      place(x, y, 0);
      el.style.transition = 'opacity ' + fadeInMs + 'ms ease-out';
      // Force style flush so the opacity transition runs from 0.
      void el.offsetWidth;
      el.style.opacity = '1';
      ensureBreathe();
      waitMs = fadeInMs + 40;
    } else if (dist < 3) {
      el.style.transition = 'opacity ' + fadeInMs + 'ms ease-out';
      el.style.opacity = '1';
      place(x, y, 0);
      ensureBreathe();
      waitMs = 60;
    } else {
      el.style.transition = 'opacity 120ms linear';
      el.style.opacity = '1';
      ensureBreathe();
      st.arc *= -1;
      const handle = Math.min(72, Math.max(22, dist * 0.18));
      const nx = -dy / dist;
      const ny = dx / dist;
      let sdx, sdy;
      if (Math.abs(st.tilt) > 0.08) {
        sdx = Math.sin(-st.tilt);
        sdy = -Math.cos(-st.tilt);
      } else {
        sdx = dx / dist;
        sdy = dy / dist;
      }
      const depart = Math.min(handle, dist * 0.28);
      const c1x = fromX + sdx * depart + nx * Math.min(36, dist * 0.10) * st.arc;
      const c1y = fromY + sdy * depart + ny * Math.min(36, dist * 0.10) * st.arc;
      // Approach from below so final tangent is screen-up → tip upright on land.
      const approach = Math.min(handle * 0.85, Math.max(20, dist * 0.16));
      const c2x = x;
      const c2y = y + approach;
      const duration = Math.min(0.85, Math.max(0.28, 0.20 + dist / 1100.0));
      waitMs = Math.round(duration * 1000) + 40;
      const t0 = performance.now();
      const tick = (now) => {
        const u = Math.min(1, (now - t0) / (duration * 1000));
        const t = easeInOut(u);
        const px = bezier(fromX, c1x, c2x, x, t);
        const py = bezier(fromY, c1y, c2y, y, t);
        const tx = bezierTan(fromX, c1x, c2x, x, t);
        const ty = bezierTan(fromY, c1y, c2y, y, t);
        let tilt = st.tilt;
        const len = Math.hypot(tx, ty);
        if (len > 0.001) {
          const desired = -Math.atan2(tx, -ty);
          let delta = desired - tilt;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          tilt += delta * Math.min(1, 0.12 + t * 0.55);
        }
        if (u >= 1) tilt = 0;
        place(px, py, tilt);
        if (u < 1) {
          st.raf = requestAnimationFrame(tick);
        } else {
          st.raf = 0;
          place(x, y, 0);
        }
      };
      st.raf = requestAnimationFrame(tick);
    }

    el.__cuhide = setTimeout(function () {
      if (st.breatheRaf) { cancelAnimationFrame(st.breatheRaf); st.breatheRaf = 0; }
      const img = el.querySelector('img');
      if (img) img.style.transform = '';
      el.style.transition = 'opacity ' + fadeOutMs + 'ms ease';
      el.style.opacity = '0';
    }, taskFadeMs);

    return {
      ok: true,
      waitMs: waitMs,
      fresh: fresh,
      dist: dist
    };
  })
`;

async function paintCursor(tabId, x, y) {
  try {
    const res = await send(tabId, "Runtime.evaluate", {
      expression:
        `(() => {` +
        `  const r = (${PAINT_CURSOR_JS})(${Number(x)}, ${Number(y)}, ${JSON.stringify(CURSOR_IMG_URL)},` +
        `    ${CURSOR_FADE_IN_MS}, ${CURSOR_FADE_OUT_MS}, ${CURSOR_TASK_FADE_MS}, ${CURSOR_HOTSPOT});` +
        `  const el = document.getElementById('__munimAgentCursor');` +
        `  if (!el) return { ok: false, reason: 'paint produced no element' };` +
        `  const img = el.querySelector('img');` +
        `  return Object.assign({}, r, {` +
        `    hasGlow: !!(img && /cursor-(?:112|224)\\.png/.test(img.src)),` +
        `    darkFill: !!(img && /cursor-(?:112|224)\\.png/.test(img.src)),` +
        `    transform: el.style.transform || ''` +
        `  });` +
        `})()`,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      return { ok: false, reason: res.exceptionDetails.text || "paint evaluate failed" };
    }
    const value = res?.result?.value || { ok: false, reason: "empty paint result" };
    const waitMs = Math.max(0, Math.min(1200, Number(value.waitMs) || 0));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return value;
  } catch (e) {
    // Decorative only — a paint failure must never fail the click.
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

async function hideCursor(tabId) {
  try {
    await send(tabId, "Runtime.evaluate", {
      expression:
        `(() => {` +
        `  const el = document.getElementById('__munimAgentCursor');` +
        `  if (!el) return false;` +
        `  clearTimeout(el.__cuhide);` +
        `  if (el.__cu && el.__cu.raf) cancelAnimationFrame(el.__cu.raf);` +
        `  if (el.__cu && el.__cu.breatheRaf) cancelAnimationFrame(el.__cu.breatheRaf);` +
        `  if (el.__cu) { el.__cu.raf = 0; el.__cu.breatheRaf = 0; }` +
        `  const img = el.querySelector('img');` +
        `  if (img) img.style.transform = '';` +
        `  el.style.transition = 'opacity ${CURSOR_FADE_OUT_MS}ms ease';` +
        `  el.style.opacity = '0';` +
        `  return true;` +
        `})()`,
      returnByValue: true,
    });
  } catch {
    // Tab may already be gone.
  }
}

const CLICK_JS = (index) => `(() => {
  const el = document.querySelector('[data-cu-idx="${index}"]');
  if (!el) return { ok: false, reason: 'element ${index} is no longer on the page' };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, composed: true, view: window,
                 clientX: cx, clientY: cy, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), href: el.href || null, x: cx, y: cy };
})()`;

/// Click a snapshotted element by invoking it in the page.
///
/// Coordinate dispatch is unreliable here: a background tab is not composited,
/// so hit-testing a point finds nothing and the click silently does nothing.
/// Driving the node directly works regardless of whether the tab is rendered,
/// which is the whole point of working in a tab the user is not looking at.
async function clickElement(tabId, index) {
  const res = await send(tabId, "Runtime.evaluate", {
    expression: CLICK_JS(index),
    returnByValue: true,
    userGesture: true,
  });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || "click failed");
  const value = res.result.value || {};
  if (!value.ok) throw new Error(value.reason || "click failed");
  const cursor = await paintCursor(tabId, value.x, value.y);
  await markTab(tabId);
  return { ...value, cursor };
}

async function typeText(tabId, text) {
  await send(tabId, "Input.insertText", { text });
  await markTab(tabId);
  return { typed: text.length };
}

async function pressKey(tabId, key) {
  const map = {
    Enter: { windowsVirtualKeyCode: 13, key: "Enter", text: "\r" },
    Tab: { windowsVirtualKeyCode: 9, key: "Tab" },
    Escape: { windowsVirtualKeyCode: 27, key: "Escape" },
    Backspace: { windowsVirtualKeyCode: 8, key: "Backspace" },
  };
  const spec = map[key];
  if (!spec) throw new Error(`unsupported key: ${key}`);
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...spec });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...spec });
  return { pressed: key };
}

async function screenshot(tabId) {
  // Page.captureScreenshot works on a background tab; captureVisibleTab does not.
  const res = await send(tabId, "Page.captureScreenshot", { format: "png" });
  return { data: res.data };
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  return { tabId, url };
}

// ── "the agent is using this tab" indicator ─────────────────────────────────
//
// Toolbar icon = MT logo (manifest icons/). Tab favicon = the site's own icon,
// dimmed, under the Computer Use cursor — composited into one SVG so the strip
// still says *which site* a tab is while saying the agent is holding it.
//
// An extension cannot set a tab's favicon directly, but it can replace the
// page's icon link, which is what Chrome renders in the tab strip. Pages
// rewrite their own favicon (YouTube does it for notifications), so this is
// re-applied on group join, load, favicon changes, and after each interaction.
//
// Both layers are inlined as data URLs. An SVG used as an image renders in
// secure static mode and fetches nothing external, so an <image href> pointing
// at the extension or at the site's server would come out blank.

/**
 * Ink box of the pointer inside icons/cursor-224.png. The art is mostly glow,
 * and Chrome scales the whole canvas into 16px: cropping to the arrow is the
 * difference between a recognisable pointer and four grey pixels.
 */
const CURSOR_CROP = { canvas: 224, x: 105, y: 108, size: 58 };
/** Lets us recognise our own badge when Chrome hands it back as favIconUrl. */
const BADGE_MARK = "agent-favicon-badge";
/** tabId → { pageUrl, icon }: the site's real icon, kept behind the badge. */
const siteFavicons = new Map();
/** icons/cursor-224.png inlined once per service-worker life. */
let cursorInlined = null;

async function toDataUrl(href) {
  if (href.startsWith("data:")) return href;
  try {
    const res = await fetch(href);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${res.headers.get("content-type") || "image/png"};base64,${btoa(binary)}`;
  } catch {
    // Blocked host, offline, or a favicon the page never actually serves.
    return null;
  }
}

function inlineCursor() {
  cursorInlined ??= toDataUrl(chrome.runtime.getURL("icons/cursor-224.png"));
  return cursorInlined;
}

function isBadge(href) {
  return (
    typeof href === "string" &&
    href.startsWith("data:image/svg+xml,") &&
    decodeURIComponent(href).includes(BADGE_MARK)
  );
}

/// The site icon to draw under the pointer. Once badged, the tab reports our
/// own SVG as its favicon, so re-reading it would nest the badge in itself on
/// every re-apply; the cached original stands in until the page navigates.
async function siteFavicon(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
  const cached = siteFavicons.get(tabId);
  if (cached && cached.pageUrl === tab.url) return cached.icon;
  if (!tab.favIconUrl || isBadge(tab.favIconUrl)) return cached?.icon ?? null;
  const icon = await toDataUrl(tab.favIconUrl);
  siteFavicons.set(tabId, { pageUrl: tab.url, icon });
  return icon;
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function badgeHref(cursor, site) {
  const scale = 32 / CURSOR_CROP.size;
  const size = (CURSOR_CROP.canvas * scale).toFixed(2);
  const layers = site
    ? [`<image href="${escapeAttribute(site)}" width="32" height="32" opacity="0.3"/>`]
    : [];
  layers.push(
    `<image href="${escapeAttribute(cursor)}" x="${(-CURSOR_CROP.x * scale).toFixed(2)}" y="${(-CURSOR_CROP.y * scale).toFixed(2)}" width="${size}" height="${size}"/>`,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-badge="${BADGE_MARK}" width="32" height="32" viewBox="0 0 32 32">${layers.join("")}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function applyFavicon(badge) {
  const links = Array.from(
    document.querySelectorAll("link[rel~='icon'], link[rel='shortcut icon']"),
  );
  if (links.length === 0) {
    const link = document.createElement("link");
    link.rel = "icon";
    link.dataset.agentFaviconAdded = "true";
    (document.head ?? document.documentElement).appendChild(link);
    links.push(link);
  }
  for (const link of links) {
    // Already wearing this exact badge: leaving it alone stops the favicon
    // listener that brought us here from re-triggering on our own write.
    if (link.getAttribute("href") === badge) continue;
    // Remember the real icon once: a re-apply must not record the badge as it.
    if (link.dataset.agentFaviconBadge !== "true") {
      link.dataset.agentFaviconOriginal = link.getAttribute("href") ?? "";
      link.dataset.agentFaviconBadge = "true";
    }
    link.href = badge;
  }
}

function restoreFavicon() {
  for (const link of document.querySelectorAll("link[data-agent-favicon-badge='true']")) {
    if (link.dataset.agentFaviconAdded === "true") {
      link.remove();
      continue;
    }
    const original = link.dataset.agentFaviconOriginal;
    delete link.dataset.agentFaviconBadge;
    delete link.dataset.agentFaviconOriginal;
    if (original) link.href = original;
    else link.removeAttribute("href");
  }
}

async function markTab(tabId) {
  try {
    const [cursor, site] = await Promise.all([inlineCursor(), siteFavicon(tabId)]);
    if (!cursor) return;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: applyFavicon,
      args: [badgeHref(cursor, site)],
    });
  } catch {
    // Chrome's own pages (chrome://, the Web Store) refuse injection; the tab
    // still works, it just cannot show the badge.
  }
}

/// Put the site's own icon back, for a tab that leaves the agent group but
/// stays open.
async function unmarkTab(tabId) {
  siteFavicons.delete(tabId);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: restoreFavicon });
  } catch {
    // Same injection limits as markTab; the tab is being let go either way.
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────

const handlers = {
  ping: async () => ({ pong: true }),
  open_tab: async (p) => openTab(requireClientId(p), p.url),
  list_tabs: async (p) => listTabs(requireClientId(p), p.all === true),
  use_tab: async (p) => adoptTab(requireClientId(p), p.tabId),
  release_tab: async (p) => releaseTab(requireClientId(p), p.tabId),
  select_tab: async (p) => {
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    // The tool contract is "make one of the agent's tabs the visible one. Does
    // not affect the user's tabs" — but activating unconditionally yanked the
    // window away from whatever the user was doing, mid-typing, which is the
    // one thing openTab's `active:false` exists to prevent. Everything the
    // agent needs (insertText, dispatchKeyEvent, Page.captureScreenshot) works
    // on a background tab, so focus only moves when the user is already
    // looking at an agent tab; otherwise the switch is recorded silently and
    // the user keeps typing where they were.
    const target = await chrome.tabs.get(p.tabId);
    const [active] = await chrome.tabs.query({ active: true, windowId: target.windowId });
    const userIsOnAgentTab = active?.id !== undefined && tabOwner.get(active.id) === clientId;
    if (userIsOnAgentTab) {
      await chrome.tabs.update(p.tabId, { active: true });
    }
    return { tabId: p.tabId, activated: userIsOnAgentTab };
  },
  close_all_tabs: async (p) => closeAllTabs(requireClientId(p)),
  close_tab: async (p) => {
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    // Closing a tab the user opened would destroy their work, so an adopted tab
    // is released instead. The reply says which happened.
    if (clientState(clientId).adopted.has(p.tabId)) return releaseTab(clientId, p.tabId);
    await chrome.tabs.remove(p.tabId);
    forgetTab(clientId, p.tabId);
    await persistOwnedState();
    return { closed: p.tabId };
  },
  navigate: async (p) => {
    assertOwned(requireClientId(p), p.tabId);
    return navigate(p.tabId, p.url);
  },
  snapshot: async (p) => {
    assertOwned(requireClientId(p), p.tabId);
    return snapshot(p.tabId);
  },
  click: async (p) => {
    assertOwned(requireClientId(p), p.tabId);
    return p.index !== undefined ? clickElement(p.tabId, p.index) : clickAt(p.tabId, p.x, p.y);
  },
  type: async (p) => {
    assertOwned(requireClientId(p), p.tabId);
    return typeText(p.tabId, p.text);
  },
  press: async (p) => {
    assertOwned(requireClientId(p), p.tabId);
    return pressKey(p.tabId, p.key);
  },
  screenshot: async (p) => {
    assertOwned(requireClientId(p), p.tabId);
    return screenshot(p.tabId);
  },
};

async function handleCommand(msg, replyPort = port) {
  await ensureStateReady();
  const { id, command, params = {} } = msg || {};
  try {
    const processId = requireClientId(params);
    if (command === "close_client_tabs") {
      // Snapshot queues too: an open may be waiting to create its client state.
      const keys = new Set([...clients.keys(), ...commandQueues.keys()]);
      const owned = [...keys].filter((key) => key === processId ||
        clients.get(key)?.processId === processId);
      const results = await Promise.all(owned.map((key) => enqueue(key, () => closeAllTabs(key))));
      return reply(replyPort, id, { closed: results.reduce((n, r) => n + r.closed, 0),
        released: results.reduce((n, r) => n + r.released, 0) });
    }
    const handler = handlers[command];
    if (!handler) throw new Error(`unknown command: ${command}`);
    const sessionId = params.sessionId;
    if (sessionId !== undefined && (typeof sessionId !== "string" ||
        !sessionId.trim() || sessionId.length > 128)) {
      throw new Error("session_id must be a nonblank string of at most 128 characters");
    }
    // JSON tuple encoding prevents session ids from colliding across processes.
    const clientId = sessionId === undefined ? processId : JSON.stringify([processId, sessionId]);
    const state = clientState(clientId);
    state.processId = processId;
    state.sessionId = sessionId ?? null;
    const result = await enqueue(clientId, () => {
      // A preceding cleanup may have removed the state while this waited.
      Object.assign(clientState(clientId), { processId, sessionId: sessionId ?? null });
      return handler({ ...params, clientId });
    });
    reply(replyPort, id, result);
  } catch (e) {
    replyError(replyPort, id, e && e.message ? e.message : e);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  siteFavicons.delete(tabId);
  if (!tabOwner.has(tabId) && !attached.has(tabId)) return;
  const clientId = tabOwner.get(tabId);
  if (clientId) {
    const state = clients.get(clientId);
    state?.tabs.delete(tabId);
    state?.adopted.delete(tabId);
  }
  tabOwner.delete(tabId);
  attached.delete(tabId);
  void persistOwnedState();
});

void ensureStateReady().then(connect);
