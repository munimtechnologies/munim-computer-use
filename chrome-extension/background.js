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
 * Native-messaging hosts to connect to — every one of them, at the same time.
 * Each host is a separate desktop bridge: `com.munim.mtcode.desktop` is the one
 * MT Code registers for the server it bundles, and
 * `com.munimtech.computer_use.desktop` is the standalone server's (npx, a
 * checkout, another MCP client). Connecting to only the first that answered
 * left whichever server did not own that host without a browser. A host with no
 * manifest on this machine simply stays disconnected.
 */
const NATIVE_HOSTS = ["com.munim.mtcode.desktop", "com.munimtech.computer_use.desktop"];
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
/**
 * One native-messaging connection per host in NATIVE_HOSTS. Commands are
 * answered on the port they arrived on, so two bridges never see each other's
 * replies. Tab ownership is keyed by the MCP process's client id, not by the
 * port, so a bridge that reconnects (or re-elects its owner) keeps its tabs.
 *
 * @typedef {{ port: any, reconnectTimer: any, quickRetries: number }} HostLink
 * @type {Map<string, HostLink>}
 */
const hostLinks = new Map(NATIVE_HOSTS.map((host) => [host, { port: null, reconnectTimer: null, quickRetries: 0 }]));
/** Quick retries since the last message; the minute alarm takes over after. */
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

/** Connect every configured host that is not connected already. */
function connect() {
  for (const host of NATIVE_HOSTS) connectHost(host);
}

function connectHost(host) {
  const link = hostLinks.get(host);
  if (!link || link.port) return;
  let sessionPort;
  try {
    sessionPort = chrome.runtime.connectNative(host);
  } catch {
    // Chrome throws for a malformed host name; nothing to retry.
    return;
  }
  link.port = sessionPort;
  sessionPort.onMessage.addListener((msg) => {
    link.quickRetries = 0;
    void handleCommand(msg, sessionPort);
  });
  sessionPort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    if (link.port !== sessionPort) return;
    link.port = null;
    // No manifest for this host (that server is not installed here) or it is
    // not allowed for this extension: retrying in seconds cannot help, so
    // leave it to the minute alarm, which also notices a later install.
    if (/not found|forbidden|invalid/i.test(String(error?.message ?? ""))) return;
    // Losing the transport is not the end of every task. In particular, an
    // owning MCP process can exit while peers elect a replacement. Keep their
    // tabs and ownership; only explicit client/session cleanup may close them.
    // Retry quickly so a re-elected owner is picked up within seconds, but back
    // off: with no MCP server running every attempt spawns a native host.
    if (link.reconnectTimer === null && link.quickRetries < QUICK_RETRY_LIMIT) {
      const delay = 1000 * 2 ** link.quickRetries;
      link.quickRetries += 1;
      link.reconnectTimer = setTimeout(() => {
        link.reconnectTimer = null;
        connectHost(host);
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
/** clientId → the command running now for that task, and since when. */
const running = new Map();
// Past this, a task's command is stuck rather than slow: every Chrome call it
// makes has its own deadline, and only a prompt waiting on the user runs
// longer. The native host gives up on a call at about this point anyway.
const STUCK_COMMAND_MS = 20000;
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

/// The normal browser window an agent tab belongs in: the task's group's, or
/// the one the user was last in. Only normal windows hold tab groups; a
/// popup, or an installed web app's window, refuses them (#59).
async function normalWindowFor(clientId) {
  const groupId = clientState(clientId).groupId;
  if (groupId !== null) {
    try {
      const group = await chrome.tabGroups.get(groupId);
      const win = await chrome.windows.get(group.windowId);
      if (win.type === "normal") return win.id;
    } catch {
      // The group is gone; ensureGroup makes a new one.
    }
  }
  try {
    return (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }))?.id ?? null;
  } catch {
    return null;
  }
}

async function openTab(clientId, url) {
  const windowId = await normalWindowFor(clientId);
  // active:false is the whole point — the user stays on whatever they were doing.
  const created = await chrome.tabs.create({
    url: url || "about:blank",
    active: false,
    ...(windowId !== null ? { windowId } : {}),
  });
  // The tab exists from here on: own it before anything else can fail, so a
  // failure below still leaves it the task's, closed with the task's cleanup.
  const state = clientState(clientId);
  state.tabs.add(created.id);
  tabOwner.set(created.id, clientId);
  await persistOwnedState();
  keepBadged(created.id);
  let tab = created;
  let note = null;
  try {
    // An installed web app can capture the URL into its own window (an
    // installed LinkedIn app, say). Bring the tab back to a normal window.
    tab = await chrome.tabs.get(created.id);
    const win = await chrome.windows.get(tab.windowId);
    if (win.type !== "normal" && windowId !== null) {
      await chrome.tabs.move(tab.id, { windowId, index: -1 });
      tab = await chrome.tabs.get(tab.id);
    }
    await ensureGroup(clientId, tab.id);
  } catch (error) {
    // Opening worked; only the group did not. Say so instead of failing a
    // call whose tab is already open (#59).
    note =
      `the tab is open, but Chrome would not add it to the agent's tab group ` +
      `(${error?.message || error}). It is still this task's tab and is closed with it`;
  }
  return { tabId: tab.id, url: tab.url, title: tab.title, clientId, ...(note ? { grouped: false, note } : {}) };
}

/// Pages replace their favicon on load (Spotify, YouTube, …). Re-apply the
/// pointer whenever the document finishes, and also when the tab's own icon
/// changes, so the strip stays on the agent cursor rather than the site logo.
function keepBadged(tabId) {
  chrome.tabs.onUpdated.addListener(function badge(id, info) {
    if (id !== tabId) return;
    if (info.status === "complete" || info.favIconUrl) markTab(tabId);
    if (!tabOwner.has(tabId)) chrome.tabs.onUpdated.removeListener(badge);
  });
}

/**
 * When the agent last clicked or pressed a key in a tab, by tab id. A tab that
 * opens from one of the agent's tabs shortly after such an action was opened by
 * the agent (a target=_blank link, a window.open popup), so it belongs to that
 * task. Without the time bound, a link the user clicks in a tab the agent holds
 * would be claimed too — and then closed by the agent's cleanup.
 *
 * @type {Map<number, { clientId: string, at: number }>}
 */
const agentInputAt = new Map();
const CHILD_TAB_WINDOW_MS = 10_000;

function noteAgentInput(clientId, tabId) {
  agentInputAt.set(tabId, { clientId, at: Date.now() });
}

/// Take ownership of a tab the agent's own action opened. It is agent-created,
/// not adopted, so the task's cleanup closes it like any tab it opened itself.
function claimChildTab(tab) {
  const openerId = tab.openerTabId;
  if (typeof tab.id !== "number" || typeof openerId !== "number") return;
  if (tabOwner.has(tab.id)) return;
  const input = agentInputAt.get(openerId);
  if (!input || Date.now() - input.at > CHILD_TAB_WINDOW_MS) return;
  const clientId = tabOwner.get(openerId);
  // The opener changed hands (released, closed) since the action.
  if (clientId === undefined || clientId !== input.clientId) return;
  // Ownership is recorded now, synchronously, so a list_tabs or cleanup that is
  // already queued sees the child; grouping waits its turn in the task's queue.
  const state = clientState(clientId);
  state.tabs.add(tab.id);
  tabOwner.set(tab.id, clientId);
  void persistOwnedState();
  keepBadged(tab.id);
  void enqueue(clientId, async () => {
    if (tabOwner.get(tab.id) !== clientId) return;
    try {
      await ensureGroup(clientId, tab.id);
    } catch {
      // A popup window cannot hold a tab group. The tab is still the task's,
      // and cleanup closes it wherever it is.
      await markTab(tab.id).catch(() => {});
    }
  }).catch(() => {});
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
    forgetPage(tabId);
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
    forgetPage(id);
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
  // A tab Chrome is not showing gets no frames, and Chrome holds or drops the
  // real input sent to it: a mouse press never lands, and keys reach the page
  // without their editing action (select all, delete, caret moves). Focus
  // emulation makes Chrome treat the tab as shown and focused for as long as
  // this debugger session lasts, the way it renders a tab that is being
  // captured. It does not select the tab, raise its window or take focus from
  // the user's own tab; detaching (release, close, the user cancelling the
  // debugging bar) ends it. A Chrome that refuses it still works through the
  // page-event fallbacks.
  try {
    await withDeadline(
      chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }),
      "Emulation.setFocusEmulationEnabled",
    );
  } catch {
    // Older Chrome, or a session Chrome ended at once.
  }
  await watchFrames(tabId);
  await watchPage(tabId);
  // A page that loaded while Chrome was not drawing it has done no frame work
  // yet. Web-component apps (Stencil, which Fathom uses) keep every component
  // `visibility: hidden` until its first frame hydrates it, so read at once it
  // is a page with no text and no controls (#63). Let it draw first.
  await nextFrames(tabId);
}

/// True after two animation frames in the page, false after `ms` without. Never
/// throws: a page that will not answer is the caller's next command's problem.
async function nextFrames(tabId, ms = 300) {
  try {
    const res = await withDeadline(
      chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: `new Promise((done) => {
          const timer = setTimeout(() => done(false), ${ms});
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); done(true); }));
        })`,
        awaitPromise: true,
        returnByValue: true,
        timeout: EVALUATE_TIMEOUT_MS,
      }),
      "waiting for the page to draw",
      ms + 1000,
    );
    return res?.result?.value === true;
  } catch {
    return false;
  }
}

// A page reports itself hidden when Chrome is not drawing it: its window is
// minimized or covered and focus emulation did not take (an older Chrome, or
// a session that lost it). Nothing that waits for a frame runs there.
const NOT_DRAWN_NOTE =
  "Chrome is not drawing this tab (the page reports itself hidden: its window is minimized or covered, " +
  "and Chrome would not treat it as shown for the agent). A page that reveals its content on its first " +
  "drawn frame, such as a web-component app, shows nothing until then. Restore or uncover the tab's " +
  "Chrome window, then try again";

/// Ask Chrome again to treat the tab as shown, then give the page its frames.
/// True when the page draws frames again.
async function redraw(tabId) {
  try {
    await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
    await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch {
    // Refused: the frame check below says whether it is drawn anyway.
  }
  return nextFrames(tabId, 500);
}

// Chrome ends a session on its own when the user cancels the "is debugging
// this browser" bar, DevTools takes the tab, or the renderer goes away.
// Forget it, so the next command attaches again instead of failing forever.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === undefined) return;
  if (source.sessionId) {
    childSessions.get(source.tabId)?.delete(source.sessionId);
    return;
  }
  attached.delete(source.tabId);
  forgetPage(source.tabId);
  forgetFrames(source.tabId);
});

// ── frames ──────────────────────────────────────────────────────────────────
//
// A page's controls and text can live in frames: a support chat, a payment
// form or a sign-in box embedded from another site. Each frame is its own
// document, so nothing evaluated in the page reaches into it. Two kinds:
//
//   - A frame from the same site runs in the page's renderer. It is in the
//     tab's own Page.getFrameTree, and Page.createIsolatedWorld gives an
//     execution context in it without turning Runtime on (see the note on
//     Runtime under "JavaScript dialogs and page problems"). The world is
//     named, so Chrome hands back the same one every time.
//   - A frame from another site runs in a renderer of its own (an out-of-
//     process iframe). Target.setAutoAttach with flatten gives the debugger a
//     session for each, addressed as { tabId, sessionId }; it evaluates in that
//     frame's document by default, and frames nested in it from its own site
//     are reached through isolated worlds in that session again.
//
// Input never goes to a frame's session. Mouse events are sent to the tab at
// page coordinates and Chrome routes them by hit test, keys and text go to
// whichever frame has focus, the same way a person's input does. So an
// element's position in a frame is its position in the frame's document plus
// the frame's own place in its parent, all the way up.
//
// Indices stay plain numbers. A snapshot numbers the page's elements first,
// then each frame's in document order, and remembers which frame holds which
// range, so browser_click, browser_fill and browser_upload_file act in the
// right document.

/** tabId → sessionId → { targetId, parent: the session holding its parent frame (undefined = the tab), url }. */
const childSessions = new Map();
/** tabId → Set of promises for child sessions still being set up. */
const childSetups = new Map();
/** tabId → [{ start, end, frame }]: which frame holds which snapshot indices. */
const frameIndexes = new Map();
/** Isolated world the extension's scripts run in inside same-site frames. */
const FRAME_WORLD = "munim-computer-use";
/** Most frames one call searches; pages with dozens of ad frames stop here. */
const FRAME_LIMIT = 40;

function debuggee(tabId, session) {
  return session ? { tabId, sessionId: session } : { tabId };
}

/// Ask Chrome for a session per out-of-process frame, now and as frames come.
/// Only iframes: workers and the like are not pages the agent reads. A Chrome
/// that refuses still works on the page itself and its same-site frames.
async function watchFrames(tabId) {
  childSessions.set(tabId, new Map());
  // chrome.debugger addresses a child session from Chrome 125 on. An older
  // Chrome would ignore the sessionId and run a frame's scripts in the page.
  if (chromeMajor() < 125) return;
  try {
    await withDeadline(
      chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }],
      }),
      "Target.setAutoAttach",
      WATCH_TIMEOUT_MS,
    );
  } catch {
    // Older Chrome: frames from other sites stay out of reach.
  }
}

function chromeMajor() {
  const match = /Chrom(?:e|ium)\/(\d+)/.exec(globalThis.navigator?.userAgent ?? "");
  return match ? Number(match[1]) : 0;
}

function forgetFrames(tabId) {
  childSessions.delete(tabId);
  childSetups.delete(tabId);
  frameIndexes.delete(tabId);
}

/// A frame from another site got its own session. Set it up the way the tab
/// is: treated as shown and focused, and watching for frames nested in it.
function adoptChildSession(tabId, parent, params) {
  const sessions = childSessions.get(tabId);
  if (!sessions || params?.targetInfo?.type !== "iframe") return;
  const session = params.sessionId;
  sessions.set(session, { targetId: params.targetInfo.targetId, parent, url: params.targetInfo.url || "" });
  const target = { tabId, sessionId: session };
  const setup = Promise.all([
    withDeadline(chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true }),
      "Emulation.setFocusEmulationEnabled", WATCH_TIMEOUT_MS).catch(() => {}),
    withDeadline(chrome.debugger.sendCommand(target, "Target.setAutoAttach", {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }],
    }), "Target.setAutoAttach", WATCH_TIMEOUT_MS).catch(() => {}),
  ]);
  if (!childSetups.has(tabId)) childSetups.set(tabId, new Set());
  const pending = childSetups.get(tabId);
  pending.add(setup);
  void setup.finally(() => pending.delete(setup));
}

function onTargetEvent(source, method, params) {
  const sessions = childSessions.get(source.tabId);
  if (!sessions) return;
  if (method === "Target.attachedToTarget") {
    adoptChildSession(source.tabId, source.sessionId, params);
  } else if (method === "Target.detachedFromTarget") {
    sessions.delete(params?.sessionId);
  } else if (method === "Target.targetInfoChanged") {
    for (const info of sessions.values()) {
      if (info.targetId === params?.targetInfo?.targetId) info.url = params.targetInfo.url || info.url;
    }
  }
}

/**
 * Every document in the tab, the page first, then its frames depth first in
 * document order: { id, session, world, parentId, parentSession, depth }. A
 * same-site frame is evaluated in the isolated world (`world`), an out-of-
 * process one in its session's own document. Frames whose documents cannot be
 * listed (a session Chrome is tearing down) are left out.
 */
async function tabFrames(tabId) {
  await withDeadline(attach(tabId), "attaching to the tab");
  await Promise.allSettled([...(childSetups.get(tabId) ?? [])]);
  const byId = new Map();
  const children = new Map();
  const add = (node, session, isRoot) => {
    const frame = node.frame;
    byId.set(frame.id, {
      id: frame.id, session, world: !isRoot, parentId: frame.parentId ?? null,
      // A same-site frame's parent is in the same session; the root of an
      // out-of-process frame's session has its parent in the session above.
      parentSession: isRoot ? childSessions.get(tabId)?.get(session)?.parent : session,
      url: frame.url || "",
    });
    if (frame.parentId) {
      if (!children.has(frame.parentId)) children.set(frame.parentId, []);
      children.get(frame.parentId).push(frame.id);
    }
    for (const child of node.childFrames || []) add(child, session, false);
  };
  const main = await send(tabId, "Page.getFrameTree");
  add(main.frameTree, undefined, true);
  byId.get(main.frameTree.frame.id).main = true;
  const trees = await Promise.all([...(childSessions.get(tabId)?.keys() ?? [])].map((session) =>
    send(tabId, "Page.getFrameTree", {}, session).then((tree) => [session, tree]).catch(() => null)));
  for (const entry of trees) {
    if (!entry) continue;
    const [session, tree] = entry;
    // The page's own tree can list an out-of-process frame too; its session
    // is the one that can evaluate in it.
    const known = byId.get(tree.frameTree.frame.id);
    if (known) {
      const siblings = children.get(known.parentId);
      if (siblings) siblings.splice(siblings.indexOf(known.id), 1);
    }
    add(tree.frameTree, session, true);
  }
  const out = [];
  const visit = (id, depth) => {
    const frame = byId.get(id);
    if (!frame || out.length > FRAME_LIMIT) return;
    out.push({ ...frame, depth });
    for (const child of children.get(id) || []) visit(child, depth + 1);
  };
  visit(main.frameTree.frame.id, 0);
  return out;
}

/// Evaluate in one of the tab's documents. `frame` is undefined (or the main
/// frame) for the page itself.
async function evaluateIn(tabId, frame, params) {
  if (!frame || frame.main) return send(tabId, "Runtime.evaluate", params);
  if (!frame.world) return send(tabId, "Runtime.evaluate", params, frame.session);
  const world = await send(tabId, "Page.createIsolatedWorld",
    { frameId: frame.id, worldName: FRAME_WORLD, grantUniveralAccess: false }, frame.session);
  return send(tabId, "Runtime.evaluate", { ...params, contextId: world.executionContextId }, frame.session);
}

/**
 * Called on a frame's owner element (<iframe>, <frame>): where its document
 * starts in the owner's own viewport (inside the border and padding), its
 * size, a name a person would know it by, whether it is shown, and whether
 * the parent's last snapshot listed it as in scope (not behind a dialog).
 */
function frameOwnerInPage(visible) {
  const r = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  const px = (value) => parseFloat(value) || 0;
  const left = r.left + px(style.borderLeftWidth) + px(style.paddingLeft);
  const top = r.top + px(style.borderTopWidth) + px(style.paddingTop);
  const right = r.right - px(style.borderRightWidth) - px(style.paddingRight);
  const bottom = r.bottom - px(style.borderBottomWidth) - px(style.paddingBottom);
  const name = (this.getAttribute("title") || this.getAttribute("aria-label") || this.getAttribute("name") || "")
    .replace(/\s+/g, " ").trim().slice(0, 60);
  return {
    left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top), name,
    outer: { width: r.width, height: r.height },
    shown: visible(this) === true, listed: this.hasAttribute("data-cu-frame"),
    view: { width: innerWidth, height: innerHeight },
  };
}

/// Where a frame sits: its owner element's box in the parent's viewport, or
/// null when Chrome no longer knows the frame.
async function frameOwner(tabId, frame) {
  try {
    const owner = await send(tabId, "DOM.getFrameOwner", { frameId: frame.id }, frame.parentSession);
    const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: owner.backendNodeId }, frame.parentSession);
    const objectId = resolved?.object?.objectId;
    if (!objectId) return null;
    try {
      // Functions cannot be passed as arguments, so the visibility check goes
      // in as source.
      const res = await send(tabId, "Runtime.callFunctionOn", {
        objectId, returnByValue: true,
        functionDeclaration: `function () { return (${frameOwnerInPage.toString()}).call(this, ${isElementVisibleInPage.toString()}); }`,
      }, frame.parentSession);
      return res?.result?.value ?? null;
    } finally {
      send(tabId, "Runtime.releaseObject", { objectId }, frame.parentSession).catch(() => {});
    }
  } catch {
    return null;
  }
}

/**
 * The tab's frames with where each one is on the page: `offset` adds a point
 * in the frame's document to page coordinates, `clip` is the part of the page
 * the frame shows (clipped by every frame around it), `label` names it, and
 * `reachable` says whether it is shown at all. With `scoped`, a frame its
 * parent's snapshot left out (hidden, or behind that page's dialog) is not
 * reachable either. The page itself comes first.
 */
async function placedFrames(tabId, { scoped = false } = {}) {
  const frames = await tabFrames(tabId);
  const placed = new Map();
  const out = [];
  for (const frame of frames) {
    if (frame.main) {
      const entry = { ...frame, offset: { x: 0, y: 0 }, clip: null, reachable: true, label: "" };
      placed.set(frame.id, entry);
      out.push(entry);
      continue;
    }
    const parent = placed.get(frame.parentId);
    if (!parent) continue;
    const owner = parent.reachable ? await frameOwner(tabId, frame) : null;
    const offset = owner ? { x: parent.offset.x + owner.left, y: parent.offset.y + owner.top } : parent.offset;
    let clip = owner ? { left: offset.x, top: offset.y, right: offset.x + owner.width, bottom: offset.y + owner.height } : null;
    // The parent's own viewport clips the frame too.
    if (clip && owner?.view) {
      const viewport = { left: parent.offset.x, top: parent.offset.y,
        right: parent.offset.x + owner.view.width, bottom: parent.offset.y + owner.view.height };
      const outer = parent.clip ?? viewport;
      clip = {
        left: Math.max(clip.left, outer.left, viewport.left), top: Math.max(clip.top, outer.top, viewport.top),
        right: Math.min(clip.right, outer.right, viewport.right), bottom: Math.min(clip.bottom, outer.bottom, viewport.bottom),
      };
    }
    const reachable = !!owner && owner.shown && owner.width >= 2 && owner.height >= 2 && (!scoped || owner.listed);
    const entry = {
      ...frame, offset, clip, reachable,
      // Shown parent, but Chrome would not say where the frame is: it could
      // not be searched, which is not the same as hidden.
      unknown: !owner && parent.reachable,
      label: owner?.name || "",
      outer: owner?.outer ?? null,
    };
    placed.set(frame.id, entry);
    out.push(entry);
  }
  return out;
}

/// What the agent is told a frame is: its owner's name, else its document's
/// title, else its site.
function frameName(frame, title) {
  if (frame.label) return frame.label;
  if (title && String(title).trim()) return String(title).replace(/\s+/g, " ").trim().slice(0, 60);
  try {
    return new URL(frame.url).host || "frame";
  } catch {
    return "frame";
  }
}

/// A frame's name as a snapshot gives it, for a frame from tabFrames (which
/// does not look at owners): its owner's name, else its title, else its site.
async function nameOfFrame(tabId, frame) {
  const owner = await frameOwner(tabId, frame);
  const title = await evaluateIn(tabId, frame, { expression: "document.title", returnByValue: true }).catch(() => null);
  return frameName({ ...frame, label: owner?.name || "" }, title?.result?.value);
}

/// The frame holding a snapshot index, or undefined for the page itself.
function frameForIndex(tabId, index) {
  const ranges = frameIndexes.get(tabId);
  const hit = ranges?.find((range) => index >= range.start && index < range.end);
  return hit?.frame?.main ? undefined : hit?.frame;
}

/// A frame's current offset on the page, after a script in it may have
/// scrolled. Null when the frame is gone or no longer shown.
async function currentPlacement(tabId, frame) {
  const frames = await placedFrames(tabId);
  const now = frames.find((entry) => entry.id === frame.id && entry.session === frame.session);
  return now?.reachable ? now : null;
}

// ── JavaScript dialogs and page problems ────────────────────────────────────
//
// alert(), confirm(), prompt() and beforeunload are browser dialogs, not DOM:
// no snapshot can see them, and while one is open the page runs nothing else.
// The Page domain reports them (Page.javascriptDialogOpening/Closed) and
// Page.handleJavaScriptDialog answers them without activating the tab or
// sending OS input.
//
// What Chrome does, checked on Chrome 151 (Chrome for Testing, headed and
// headless) with the tab in the background and a debugger attached:
//   - A dialog in a background tab is not dismissed by Chrome, with or without
//     the Page domain. It stays open, Chrome shows it to the user when they
//     switch to the tab (the event says hasBrowserHandler: true), and the page
//     is paused: Runtime.evaluate and Page.captureScreenshot do not answer, nor
//     does the Input.dispatchMouseEvent whose click opened it, until it closes.
//   - The user can still answer it in Chrome; Page.javascriptDialogClosed then
//     arrives without the agent having acted.
//   - A dialog that opened before the agent attached is not reported: Page.enable
//     itself does not answer while it is open, and Page.handleJavaScriptDialog
//     says no dialog is showing. Only the user can answer that one.
//
// Failed requests come from Log, on from the moment the agent attaches: Chrome
// logs every net error and HTTP error status there, documents included, with
// the URL. Log reports only failures, so nothing is sent per successful
// request, which is why the Network domain is not used: it would stream every
// request with its headers to the extension. Log.enable also replays what
// Chrome still holds for the current document; those entries are kept and
// marked as earlier than the capture.
//
// Exceptions and console errors come from Runtime, and Runtime is NOT left on.
// A page can tell that a debugger has Runtime enabled (the best-known probe
// logs an Error whose stack getter fires when DevTools serializes console
// arguments), and the user's signed-in sites are the ones that flag accounts
// for it. Chrome keeps each document's console messages and exceptions anyway,
// whether or not anyone listens, and replays them on Runtime.enable. So
// browser_page_errors turns Runtime on, takes the replay, and turns it off
// again: what it lists is what the page has logged since it loaded, as far as
// Chrome kept it. The replay itself serializes the stored messages, so a page
// with such a probe can still notice that moment; it cannot notice the hours
// in between.

/** tabId → the dialog open in that tab now. */
const dialogs = new Map();
/** tabId → the last dialog that closed, so a stale dialog_id can say why. */
const closedDialogs = new Map();
/** tabId → listeners waiting for a dialog to open (see whileNoDialog). */
const dialogListeners = new Map();
let dialogCount = 0;
/** tabId → { since, entries, dropped }: failed requests and other logged errors since the agent attached. */
const captures = new Map();
/** tabId → { since, entries, dropped }: what one browser_page_errors call is taking from Chrome's replay. */
const replays = new Map();
// How long the replay keeps arriving after Runtime.enable answers. Chrome sends
// it before the reply; the slack covers the hop to the service worker.
const REPLAY_SETTLE_MS = 100;
const PAGE_PROBLEM_LIMIT = 50;
const PAGE_PROBLEM_TEXT = 300;
const DIALOG_MESSAGE_MAX = 2000;
// Short: a page already paused behind a dialog never answers these, and the
// attach that sends them must finish within its own deadline.
const WATCH_TIMEOUT_MS = 3000;

/// Start a fresh capture for a newly attached tab and turn on the domains that
/// report dialogs and failed requests. Runtime stays off (see above). A Chrome
/// that refuses one still works; it just reports less.
async function watchPage(tabId) {
  captures.set(tabId, { since: Date.now(), entries: [], dropped: 0 });
  await Promise.all(["Page.enable", "Log.enable"].map((method) =>
    withDeadline(chrome.debugger.sendCommand({ tabId }, method), method, WATCH_TIMEOUT_MS).catch(() => {})));
}

/// Drop a tab's dialog state and capture: it was released, closed or detached.
function forgetPage(tabId) {
  dialogs.delete(tabId);
  closedDialogs.delete(tabId);
  dialogListeners.delete(tabId);
  captures.delete(tabId);
  replays.delete(tabId);
}

/// What the agent is shown of a dialog. A prompt's default text is part of
/// what the page asked, so it is shown too; what the user typed never is.
function publicDialog(dialog) {
  return {
    id: dialog.id, type: dialog.type, message: dialog.message,
    ...(dialog.type === "prompt" ? { defaultPrompt: dialog.defaultPrompt } : {}),
  };
}

function dialogLabel(dialog) {
  return `JavaScript ${dialog.type} dialog ${dialog.id}: "${dialog.message}"`;
}

/// For a command that would have run in a page already paused by a dialog.
function dialogPendingError(tabId, dialog) {
  const error = new Error(
    `not started: tab ${tabId} is showing a ${dialogLabel(dialog)}. The page is paused until it is answered, ` +
      `so nothing else can run in it: call browser_handle_dialog with dialog_id=${dialog.id} to accept or dismiss it`,
  );
  error.dialog = dialog;
  return error;
}

/// For a command that was running when the page opened a dialog.
function dialogOpenedError(tabId, dialog) {
  const error = new Error(
    `the page in tab ${tabId} opened a ${dialogLabel(dialog)} while the agent was acting on it. The action ` +
      "reached the page, but whether all of it ran is unknown, and the page is paused until the dialog is " +
      `answered: call browser_handle_dialog with dialog_id=${dialog.id} to accept or dismiss it, then look at the ` +
      "page before doing anything again",
  );
  error.dialog = dialog;
  error.opened = true;
  return error;
}

/// The result of a click or key press that made the page open a dialog. The
/// press reached the page (that is what opened it), so it is reported as done,
/// with the dialog, rather than as a failure.
function openedDialog(dialog, result = {}) {
  const note = `the page opened a ${dialogLabel(dialog)} and is paused until it is answered: ` +
    `call browser_handle_dialog with dialog_id=${dialog.id} to accept or dismiss it`;
  return { ...result, jsDialog: publicDialog(dialog), note: result.note ? `${result.note}; ${note}` : note };
}

/// Settle a DevTools command, or reject as soon as the page opens a dialog: the
/// command would not answer until the dialog closed.
function whileNoDialog(tabId, promise) {
  let listener;
  const opened = new Promise((_, reject) => {
    listener = (dialog) => reject(dialogOpenedError(tabId, dialog));
    if (!dialogListeners.has(tabId)) dialogListeners.set(tabId, new Set());
    dialogListeners.get(tabId).add(listener);
  });
  return Promise.race([promise, opened]).finally(() => dialogListeners.get(tabId)?.delete(listener));
}

/// The dialog that opens in a tab within `ms`, or null.
function nextDialog(tabId, ms) {
  if (dialogs.has(tabId)) return Promise.resolve(dialogs.get(tabId));
  return whileNoDialog(tabId, sleep(ms).then(() => null)).catch((error) => error.dialog ?? null);
}

/// "12s", "4m", "3h", as the servers word ages elsewhere.
function agoText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/// A URL with no query string, fragment or user name and password: those can
/// carry tokens and session ids. A data: URL keeps only its type.
function redactUrl(url) {
  const text = String(url ?? "");
  if (!text) return "";
  if (/^data:/i.test(text)) return `${text.slice(0, Math.min(60, text.search(/[,;]|$/)))},…`;
  try {
    const parsed = new URL(text);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href.slice(0, PAGE_PROBLEM_TEXT);
  } catch {
    return text.split(/[?#]/)[0].slice(0, PAGE_PROBLEM_TEXT);
  }
}

/// Message text with the same parts taken out of any URL in it, cut to length.
function redactText(text) {
  const plain = String(text ?? "")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi, "$1")
    .replace(/\b((?:https?|wss?|ftp|file|blob):\/\/?[^\s?#"'<>()]*)[?#][^\s"'<>()]*/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PAGE_PROBLEM_TEXT ? `${plain.slice(0, PAGE_PROBLEM_TEXT - 1)}…` : plain;
}

/// Where in a script something happened, as url:line:column.
function scriptPlace(url, line, column) {
  if (!url) return undefined;
  return `${redactUrl(url)}${Number.isInteger(line) ? `:${line + 1}` : ""}${Number.isInteger(column) ? `:${column + 1}` : ""}`;
}

/// One DevTools event as a page problem, or null when it is not one. Only
/// errors are kept: an exception nobody caught, console.error and
/// console.assert, a request that failed, and other errors Chrome logged
/// (blocked content, security). Values are cut down and redacted here, so
/// nothing longer or more revealing is ever stored.
function pageProblem(method, params) {
  if (method === "Runtime.exceptionThrown") {
    const details = params?.exceptionDetails ?? {};
    const first = String(details.exception?.description ?? "").split("\n")[0];
    const prefix = details.text && details.text !== first ? details.text : "";
    const text = [prefix, first].filter(Boolean).join(" ") || "Uncaught exception";
    const frame = details.stackTrace?.callFrames?.[0];
    return {
      kind: "exception", at: params.timestamp, text: redactText(text),
      url: scriptPlace(details.url || frame?.url, details.lineNumber ?? frame?.lineNumber, details.columnNumber ?? frame?.columnNumber),
    };
  }
  if (method === "Runtime.consoleAPICalled") {
    if (params?.type !== "error" && params?.type !== "assert") return null;
    const parts = (params.args ?? []).map((arg) =>
      arg.value !== undefined ? String(arg.value) : String(arg.description ?? arg.unserializableValue ?? arg.type ?? "").split("\n")[0]);
    const frame = params.stackTrace?.callFrames?.[0];
    return {
      kind: `console.${params.type}`, at: params.timestamp,
      text: redactText(parts.join(" ") || (params.type === "assert" ? "Assertion failed" : "")),
      url: scriptPlace(frame?.url, frame?.lineNumber, frame?.columnNumber),
    };
  }
  if (method === "Log.entryAdded") {
    const entry = params?.entry ?? {};
    if (entry.level !== "error") return null;
    if (entry.source === "network") {
      const status = /status of (\d{3})(?: \(([^)]*)\))?/.exec(entry.text ?? "");
      const failure = /(net::ERR_[A-Z0-9_]+)/.exec(entry.text ?? "");
      const text = status ? `HTTP ${status[1]}${status[2] ? ` ${status[2]}` : ""}` : failure ? failure[1] : redactText(entry.text);
      return { kind: "request", at: entry.timestamp, text, url: redactUrl(entry.url) || undefined };
    }
    return { kind: "error", at: entry.timestamp, text: redactText(entry.text), url: redactUrl(entry.url) || undefined };
  }
  return null;
}

/// Keep a problem in a ring buffer: the tab's capture for Log, or the replay a
/// browser_page_errors call is taking for Runtime. A repeat of the entry just
/// before it (a failing poll, an error in an animation frame) is counted, not
/// stored.
function recordProblem(capture, problem) {
  if (!capture || !problem) return;
  const at = Number.isFinite(problem.at) ? problem.at : Date.now();
  const earlier = at < capture.since;
  const last = capture.entries.at(-1);
  if (last && last.kind === problem.kind && last.text === problem.text && last.url === problem.url && Boolean(last.earlier) === earlier) {
    last.repeats = (last.repeats ?? 1) + 1;
    last.at = at;
    return;
  }
  capture.entries.push({ ...problem, at, ...(earlier ? { earlier: true } : {}) });
  if (capture.entries.length > PAGE_PROBLEM_LIMIT) {
    capture.entries.shift();
    capture.dropped += 1;
  }
}

/// Take the exceptions and console errors Chrome holds for the tab's document:
/// Runtime on, its replay into a fresh buffer, Runtime off. Null when it could
/// not be read, with why.
async function replayRuntime(tabId) {
  // A page paused behind a dialog answers no Runtime command.
  if (dialogs.has(tabId)) {
    return { failed: `exceptions and console errors cannot be read while the page waits on JavaScript dialog ${dialogs.get(tabId).id}` };
  }
  const replay = { since: -Infinity, entries: [], dropped: 0 };
  replays.set(tabId, replay);
  try {
    await withDeadline(chrome.debugger.sendCommand({ tabId }, "Runtime.enable"), "Runtime.enable", WATCH_TIMEOUT_MS);
    await sleep(REPLAY_SETTLE_MS);
    return { replay };
  } catch {
    return { failed: "Chrome did not hand over the page's exceptions and console errors (the page did not answer)" };
  } finally {
    if (replays.get(tabId) === replay) replays.delete(tabId);
    await withDeadline(chrome.debugger.sendCommand({ tabId }, "Runtime.disable"), "Runtime.disable", WATCH_TIMEOUT_MS).catch(() => {});
  }
}

/// browser_page_errors: the replayed exceptions and console errors with the
/// failed requests since the agent attached, oldest first, the latest
/// PAGE_PROBLEM_LIMIT of them. Nothing is evaluated in the page.
async function pageProblems(tabId, fresh) {
  const capture = captures.get(tabId) ?? { since: Date.now(), entries: [], dropped: 0 };
  const { replay, failed } = await replayRuntime(tabId);
  const merged = [...capture.entries, ...(replay?.entries ?? [])].sort((a, b) => a.at - b.at);
  const kept = merged.slice(-PAGE_PROBLEM_LIMIT);
  const now = Date.now();
  return {
    tabId,
    since: agoText(now - capture.since),
    ...(fresh ? { fresh: true } : {}),
    ...(failed ? { note: failed } : {}),
    limit: PAGE_PROBLEM_LIMIT,
    dropped: capture.dropped + (replay?.dropped ?? 0) + (merged.length - kept.length),
    entries: kept.map((entry) => ({
      kind: entry.kind, ago: agoText(now - entry.at), text: entry.text,
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.repeats ? { repeats: entry.repeats } : {}),
      ...(entry.earlier ? { earlier: true } : {}),
    })),
  };
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined || !attached.has(tabId)) return;
  if (method.startsWith("Target.")) return onTargetEvent(source, method, params);
  // A frame's own session reports nothing else the extension listens for.
  if (source.sessionId) return;
  if (method === "Page.javascriptDialogOpening") {
    const message = String(params?.message ?? "");
    const dialog = {
      id: `d${++dialogCount}`,
      type: String(params?.type ?? "alert"),
      message: message.length > DIALOG_MESSAGE_MAX ? `${message.slice(0, DIALOG_MESSAGE_MAX - 1)}…` : message,
      defaultPrompt: String(params?.defaultPrompt ?? ""),
    };
    dialogs.set(tabId, dialog);
    for (const listener of [...(dialogListeners.get(tabId) ?? [])]) listener(dialog);
    return;
  }
  if (method === "Page.javascriptDialogClosed") {
    // Answered by the agent, by the user in Chrome, or closed by a navigation.
    // What the user typed into a prompt is never kept.
    const dialog = dialogs.get(tabId);
    if (dialog) {
      dialogs.delete(tabId);
      closedDialogs.set(tabId, { ...dialog, accepted: params?.result === true, byAgent: false });
    }
    return;
  }
  // Runtime events only arrive while browser_page_errors has Runtime on.
  const problem = pageProblem(method, params);
  if (method.startsWith("Runtime.")) recordProblem(replays.get(tabId), problem);
  else recordProblem(captures.get(tabId), problem);
});

/// browser_handle_dialog. `dialogId`, when given, must name the dialog open
/// now, so a dialog that replaced the one the agent read is never answered in
/// its place. Page.handleJavaScriptDialog answers whichever dialog is open, so
/// the check is made right before it; the window between them is one message.
async function handleDialog(tabId, { action, promptText, dialogId }) {
  if (action !== "accept" && action !== "dismiss") throw new Error("action must be accept or dismiss");
  if (promptText !== undefined && typeof promptText !== "string") throw new Error("prompt_text must be a string");
  if (dialogId !== undefined && typeof dialogId !== "string") throw new Error("dialog_id must be a string such as d3");
  const dialog = dialogs.get(tabId);
  if (!dialog) {
    const closed = closedDialogs.get(tabId);
    if (dialogId !== undefined && closed?.id === dialogId) {
      throw new Error(
        `dialog ${dialogId} is no longer open: it was already ${closed.accepted ? "accepted" : "dismissed"}` +
          (closed.byAgent ? " by the agent" : " (by the user in Chrome, or the page moved on)") + ". Nothing was answered",
      );
    }
    throw new Error(
      `tab ${tabId} has no JavaScript dialog open, so nothing was answered. browser_snapshot shows one when it is ` +
        "open; a dialog that opened before the agent attached to the tab cannot be seen or answered by it",
    );
  }
  if (dialogId !== undefined && dialogId !== dialog.id) {
    throw new Error(
      `dialog ${dialogId} is no longer open; tab ${tabId} now shows ${dialogLabel(dialog)}. Nothing was answered: ` +
        `read it, then call again with dialog_id=${dialog.id}`,
    );
  }
  if (promptText !== undefined && (dialog.type !== "prompt" || action !== "accept")) {
    throw new Error(
      `prompt_text only applies when accepting a prompt dialog; ${dialog.id} is ${/^[aeiou]/.test(dialog.type) ? "an" : "a"} ${dialog.type} dialog`,
    );
  }
  // Accepting a prompt without text submits what it already holds, as OK does.
  const text = dialog.type === "prompt" && action === "accept" ? (promptText ?? dialog.defaultPrompt) : undefined;
  try {
    await withDeadline(
      chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", {
        accept: action === "accept", ...(text !== undefined ? { promptText: text } : {}),
      }),
      "Page.handleJavaScriptDialog",
    );
  } catch (error) {
    if (!/no dialog is showing/i.test(error?.message ?? "")) throw error;
    if (dialogs.get(tabId) === dialog) dialogs.delete(tabId);
    throw new Error(`dialog ${dialog.id} closed before it could be answered (the user answered it, or the page moved on). Nothing was answered`);
  }
  if (dialogs.get(tabId) === dialog) dialogs.delete(tabId);
  closedDialogs.set(tabId, { ...dialog, accepted: action === "accept", byAgent: true });
  // Pages often open the next dialog at once (an alert after a confirm). Say so,
  // so the agent does not act on a page that is still paused.
  const next = await nextDialog(tabId, 250);
  return {
    tabId, action, dialog: publicDialog(dialog),
    ...(text !== undefined ? (promptText !== undefined ? { promptChars: promptText.length } : { promptDefault: true }) : {}),
    ...(next ? { next: publicDialog(next) } : {}),
  };
}

/// Let go of a tab's debugger session, clearing Chrome's "is debugging this
/// browser" banner. Safe to call for a tab that was never attached.
async function detachTab(tabId) {
  forgetPage(tabId);
  forgetFrames(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Tab gone, or Chrome already tore the session down.
  }
}

// The native host gives up on a call after its own timeout, but that does not
// cancel Chrome's request. A DevTools command that never answers (a renderer
// stuck in a site's handler, a tab Chrome froze under memory pressure) would
// hold this task's queue for good, and every later call for it would time out
// too (#52). Bound each command here, so the queue moves on. Nothing is replayed.
const DEBUGGER_TIMEOUT_MS = 6000;
// Chrome stops a synchronous page evaluation at this limit, so neither an
// injected script nor a page handler it set off can run on for ever.
const EVALUATE_TIMEOUT_MS = 4000;

function withDeadline(promise, what, ms = DEBUGGER_TIMEOUT_MS) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/// One DevTools command for a tab, or with `session` for one of its frames
/// from another site (see "frames").
async function send(tabId, method, params = {}, session = undefined) {
  try {
    await withDeadline(attach(tabId), "attaching to the tab");
    // A page paused behind a dialog answers nothing; say so at once instead of
    // after the deadline, and stop waiting the moment one opens.
    const pending = dialogs.get(tabId);
    if (pending) throw dialogPendingError(tabId, pending);
    const bounded = method === "Runtime.evaluate" ? { timeout: EVALUATE_TIMEOUT_MS, ...params } : params;
    return await withDeadline(whileNoDialog(tabId, chrome.debugger.sendCommand(debuggee(tabId, session), method, bounded)), method);
  } catch (error) {
    if (error?.dialog) throw error;
    const message = error?.message || "";
    const stopped = /Execution was terminated/.test(message);
    if (!stopped && !/timed out$/.test(message)) throw error;
    // Chrome's own view of the tab often still answers when its page does not.
    // Read it only: never activate, reload or discard a tab that may hold a draft.
    const tab = await withDeadline(chrome.tabs.get(tabId), "tab lookup").catch(() => null);
    const state = tab
      ? ` (Chrome reports the tab ${tab.discarded ? "discarded" : tab.frozen ? "frozen" : tab.status || "open"})`
      : "";
    const what = stopped
      ? `${method} was stopped: the page was still busy after ${EVALUATE_TIMEOUT_MS / 1000} s`
      : `${message}: the page did not answer within ${DEBUGGER_TIMEOUT_MS / 1000} s`;
    throw new Error(
      `${what}${state}. ` +
        "Whether the action took effect is unknown, so it was not retried: look at the page " +
        "(browser_snapshot or browser_read) before doing it again. Many open tabs can starve " +
        "Chrome of memory; close finished ones. A JavaScript dialog that opened before the agent attached " +
        "to the tab also pauses the page without being reported; only the user can answer it in Chrome.",
    );
  }
}

/** Shared by snapshots and explicit readiness checks, serialized into the page. */
/// With `why === true` it returns why the element is hidden instead ("" when
/// it is visible), for snapshots that find nothing to say what they left out.
function isElementVisibleInPage(el, why) {
  const hidden = (reason) => (why === true ? reason : false);
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return hidden("no size");
  // Styled labels often use transparent native controls as real hit targets.
  // Do not extend this exception to containers: a faded-out dialog is not ready.
  const transparentControl = el.matches('input,button,select,textarea');
  // An element fading in starts at opacity 0. Chrome does not advance
  // animations in a tab it is not showing, so a menu opened in a background
  // tab stays at its first frame for as long as the agent works there (#53).
  // It counts as shown; one fading out (ending at 0) does not. Keyframes that
  // stop short of the end (`from { opacity: 0 }`) end at the element's own
  // opacity.
  const fadingIn = (node) => (node.getAnimations?.() || []).some((animation) => {
    if (animation.playState !== "running" && !animation.pending) return false;
    const frames = (animation.effect?.getKeyframes?.() || []).filter((frame) => "opacity" in frame);
    const last = frames[frames.length - 1];
    return !!last && ((last.computedOffset ?? last.offset ?? 1) < 1 || Number(last.opacity) > 0);
  });
  let escapedInert = false;
  // Walk the flat tree (slot, then shadow host), so a hidden host or a hidden
  // slot hides the shadow content and slotted children it renders.
  for (let node = el; node; node = node.assignedSlot || node.parentElement || node.parentNode?.host || null) {
    if (node.hidden) return hidden("hidden");
    if (node.getAttribute("aria-hidden")?.toLowerCase() === "true") return hidden("aria-hidden");
    if (node.inert && !escapedInert) return hidden("inert");
    // Native showModal() escapes ancestor inertness, not its own inert subtrees.
    if (node.matches("dialog:modal")) escapedInert = true;
    const style = getComputedStyle(node);
    if (style.display === "none") return hidden("display: none");
    if (style.contentVisibility === "hidden") return hidden("content-visibility: hidden");
    if (Number(style.opacity) === 0 && (node !== el || !transparentControl) && !fadingIn(node)) return hidden("opacity 0");
  }
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.visibility === "collapse") return hidden("visibility: hidden");
  return why === true ? "" : true;
}

/**
 * DOM lookups that reach into open shadow roots, serialized into the page.
 * Sites render dialogs inside web components (LinkedIn's invitation dialog
 * lives in the shadow root of `#interop-outlet`), where document-level
 * queries, `contains` and hit tests stop at the host. Closed shadow roots and
 * child frames stay out of reach, so results count the visible frames they
 * could not search.
 */
function pageDomInPage() {
  // Matches in a document, shadow root or element, then in every open shadow
  // root inside it, nested ones included.
  const queryAll = (root, selector) => {
    const out = [...root.querySelectorAll(selector)];
    const visit = (scope) => {
      for (const el of scope.querySelectorAll("*")) {
        if (!el.shadowRoot) continue;
        out.push(...el.shadowRoot.querySelectorAll(selector));
        visit(el.shadowRoot);
      }
    };
    if (root.shadowRoot) {
      out.push(...root.shadowRoot.querySelectorAll(selector));
      visit(root.shadowRoot);
    }
    visit(root);
    return out;
  };
  const parent = (node) => node.assignedSlot || node.parentElement || node.parentNode?.host || null;
  // Whether `node` renders inside `ancestor`, across shadow boundaries and slots.
  const contains = (ancestor, node) => {
    if (!ancestor || !node) return false;
    if (ancestor.contains(node)) return true;
    for (let at = parent(node); at; at = parent(at)) if (at === ancestor) return true;
    return false;
  };
  // Everything painted at a point, topmost first, with each shadow host's
  // own painted content ahead of the host itself.
  const stack = (x, y) => {
    const expand = (root) => {
      const out = [];
      for (const el of root.elementsFromPoint(x, y) || []) {
        if (root !== document && el.getRootNode() !== root) continue;
        if (el.shadowRoot && el.shadowRoot !== root) out.push(...expand(el.shadowRoot));
        out.push(el);
      }
      return out;
    };
    return expand(document);
  };
  // The element a press at a point would land on, not its shadow host.
  const hit = (x, y) => {
    let at = document.elementFromPoint(x, y);
    while (at?.shadowRoot) {
      const inner = at.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === at || inner.getRootNode() !== at.shadowRoot) break;
      at = inner;
    }
    return at;
  };
  const byIndex = (index) => queryAll(document, '[data-cu-idx="' + index + '"]')[0] || null;
  const byId = (from, id) => from.getRootNode().getElementById?.(id) || document.getElementById(id);
  return { queryAll, parent, contains, stack, hit, byIndex, byId };
}

/**
 * What a person reads as a control's name, serialized into the page. A
 * checkbox's value is "on" for every checkbox on the page, so it must never
 * stand in for the name: a list of permissions all labelled "on" is how an
 * agent ticked Admin when it meant another box. In order: aria-label,
 * aria-labelledby, an associated <label>, then the nearest wrapper with text
 * that holds no other control (custom checkbox components such as Angular
 * Material's put the text beside the input, not in a label).
 */
function controlLabelInPage(el, dom, wrappers = true) {
  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const aria = clean(el.getAttribute("aria-label"));
  if (aria) return aria;
  const ids = clean(el.getAttribute("aria-labelledby"));
  if (ids) {
    const text = clean(ids.split(" ").map((id) => dom.byId(el, id)?.innerText || "").join(" "));
    if (text) return text;
  }
  for (const label of el.labels || []) {
    const text = clean(label.innerText);
    if (text) return text;
  }
  if (!wrappers) return "";
  const controls = "input:not([type=hidden]),button,select,textarea,a[href],[role=checkbox],[role=radio],[role=switch],[role=button]";
  for (let at = dom.parent(el), steps = 0; at instanceof Element && steps < 5; at = dom.parent(at), steps++) {
    if (at === document.body || at === document.documentElement) break;
    const text = clean(at.innerText);
    if (!text) continue;
    const others = dom.queryAll(at, controls).filter((other) => other !== el && !el.contains(other));
    return others.length === 0 ? text : "";
  }
  return clean(el.getAttribute("title"));
}

/** Whether a control is checked, selected or disabled, as words: "checked, disabled". */
function controlStateInPage(el) {
  const parts = [];
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
    parts.push(el.indeterminate ? "mixed" : el.checked ? "checked" : "unchecked");
  } else if (/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role)) {
    const checked = (el.getAttribute("aria-checked") || "").toLowerCase();
    parts.push(checked === "true" ? "checked" : checked === "mixed" ? "mixed" : "unchecked");
  } else if (/^(tab|option|treeitem|row|gridcell)$/.test(role) && el.getAttribute("aria-selected") === "true") {
    parts.push("selected");
  }
  if (el.getAttribute("aria-expanded") === "true" && el.matches("[aria-haspopup],[role=combobox],button,summary")) {
    parts.push("expanded");
  }
  // A file input says how many files it holds, so a staged upload shows.
  const files = el.tagName === "INPUT" && el.type === "file" ? el.files?.length || 0 : 0;
  if (files) parts.push(files === 1 ? "1 file" : `${files} files`);
  if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
  return parts.join(", ");
}

/**
 * A file input the page hides itself (display: none, no size, transparent),
 * as sites do behind a styled "Upload" button that opens it from script. It
 * is still what browser_upload_file attaches files to, so a snapshot lists it
 * while the content around it is shown: nothing between it and its nearest
 * sized ancestor hides it on purpose, and that ancestor is visible.
 */
function hiddenFileInputInPage(el, dom, visible) {
  if (el.tagName !== "INPUT" || el.type !== "file" || el.matches(":disabled")) return false;
  for (let at = dom.parent(el); at instanceof Element; at = dom.parent(at)) {
    if (at.hidden || at.inert || at.getAttribute("aria-hidden")?.toLowerCase() === "true") return false;
    if (getComputedStyle(at).display === "none") return false;
    const r = at.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) return visible(at);
  }
  return false;
}

/// A compact outline of the interactive elements on the page, with ids the
/// agent can click. Mirrors the accessibility-tree tools on the desktop side.
const SNAPSHOT_JS = `((options = {}) => {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 250;
  // A frame's elements are numbered after the page's (and earlier frames'),
  // so every index in one snapshot names one element.
  const base = options.base ?? 0;
  const out = [];
  // Every spelling that makes an element editable (contenteditable="",
  // "true", "plaintext-only"), not just "true": an inline title editor that
  // is a bare span is still the place to type (#72).
  const sel = 'a,button,input,textarea,select,cfc-select,mat-option,[role=button],[role=link],[role=textbox],[role=combobox],[role=listbox],[role=option],[role=menu],[role=menuitem],[aria-haspopup],[contenteditable]:not([contenteditable=false i]),summary,' +
    '[role=tab],[role=checkbox],[role=radio],[role=switch],[role=treeitem],[role=menuitemcheckbox],[role=menuitemradio]';
  // Table and grid rows are listed too, so a row in a list of users or orders
  // can be found by its text and clicked. Rows built from custom elements
  // (Angular Material, Play Console) carry role=row, plain tables have tr.
  const rowSel = 'tr,[role=row]';
  // A cell is listed only when it is a click target of its own: in an ARIA
  // grid every cell has role=gridcell, and listing them all would bury the
  // page's controls.
  const cellSel = 'td,th,[role=gridcell],[role=cell],[role=rowheader],[role=columnheader]';
  // Pages also make plain elements clickable with a handler and a pointer
  // cursor: a custom-element row, a card, a list entry. The outermost element
  // showing the pointer is the target (the cursor is inherited by everything
  // inside it), and only when it has text to be found by.
  const pointer = (el) => {
    if (getComputedStyle(el).cursor !== 'pointer') return false;
    const up = dom.parent(el);
    return !(up instanceof Element) || getComputedStyle(up).cursor !== 'pointer';
  };
  // Something inside a listed control (the label span of a button) is that
  // control's target already.
  const inControl = (el) => {
    for (let at = dom.parent(el); at instanceof Element; at = dom.parent(at)) if (at.matches(sel)) return true;
    return false;
  };
  // Nor is a wrapper around one (a checkbox component's host, a label): the
  // control inside is the target, and listing both shifted every index after
  // it the moment the wrapper's pointer cursor appeared.
  const holdsControl = (el) => dom.queryAll(el, sel).length > 0;
  const plainTarget = (el) => (el.hasAttribute('onclick') || pointer(el)) && !inControl(el) && !holdsControl(el);
  const listed = (el) => {
    if (el.matches(sel + ',' + rowSel + ',iframe,frame')) return true;
    if (el === document.body || el === document.documentElement) return false;
    if (el.matches(cellSel)) return (el.tabIndex >= 0 && el.hasAttribute('tabindex')) || plainTarget(el);
    return plainTarget(el);
  };
  const kindOf = (el) => {
    if (el.matches(sel + ',iframe,frame')) return null;
    if (el.matches(rowSel)) return 'row';
    if (el.matches(cellSel)) return 'cell';
    return 'clickable';
  };
  let i = 0;
  const dom = (${pageDomInPage.toString()})();
  // Clear the previous snapshot's indices first. An element hidden since then
  // would otherwise keep its old number, and querySelector, which returns the
  // first match, could send a click or a credential fill to it instead.
  for (const old of dom.queryAll(document, '[data-cu-idx]')) old.removeAttribute('data-cu-idx');
  for (const old of dom.queryAll(document, '[data-cu-frame]')) old.removeAttribute('data-cu-frame');
  // Accessibility-hidden/inert ancestors are not actionable. Do not use viewport
  // intersection here: indexed click scrolls reachable offscreen controls into view.
  const visible = ${isElementVisibleInPage.toString()};
  const labelOf = ${controlLabelInPage.toString()};
  const stateOf = ${controlStateInPage.toString()};
  const hiddenFileInput = ${hiddenFileInputInPage.toString()};
  // Native modal dialogs live in Chrome's top layer, above ordinary z-indexes.
  // For custom dialogs, use paint order at their visible centre, not DOM order
  // or raw z-index (which is only meaningful inside a stacking context).
  // Modeless native dialogs and explicit aria-modal=false keep page controls.
  // Component libraries often build a dialog with no dialog role at all, as
  // a custom element named for it (Fathom's <ui-dialog>, #71). Those count as
  // implicit dialogs, held to the same test below: painted on top at the
  // page's centre, or inside a backdrop that is.
  const roleDialogs = dom.queryAll(document, 'dialog:modal,[role=dialog]:not([aria-modal=false i]),[role=alertdialog]:not([aria-modal=false i]),[aria-modal=true i]');
  const namedDialogs = dom.queryAll(document, '*').filter((el) => /-(dialog|modal)$/.test(el.localName) &&
    !el.matches('[aria-modal=false i]') && !roleDialogs.includes(el));
  const dialogs = [...roleDialogs, ...namedDialogs].filter((dialog) => {
    if (!visible(dialog)) return false;
    if (dialog.matches('dialog:modal,[aria-modal=true i]')) return true;
    // An implicit ARIA dialog is not automatically modal. Preserve full-page
    // overlays, but never let a corner widget or bottom banner hide the page.
    const x = innerWidth / 2, y = innerHeight / 2;
    const r = dialog.getBoundingClientRect();
    const painted = dom.stack(x, y);
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom &&
        (!painted.length || dom.contains(dialog, painted[0]))) return true;
    // A dialog placed near the top of a blocking backdrop does not cover the
    // centre, but the backdrop does: a fixed, full-viewport ancestor that is
    // painted on top there. A modeless chat widget in a corner has none.
    if (!painted.length) return false;
    for (let node = dom.parent(dialog); node && node !== document.body && node !== document.documentElement; node = dom.parent(node)) {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (style.position !== 'fixed' || style.pointerEvents === 'none' || box.left > 1 || box.top > 1 ||
          box.right < innerWidth - 1 || box.bottom < innerHeight - 1) continue;
      if (dom.contains(node, painted[0])) return true;
    }
    return false;
  });
  const native = dialogs.filter((dialog) => dialog.matches(':modal'));
  // Keep nested custom dialogs inside the native top layer eligible too.
  const candidates = dialogs.filter((dialog) => !native.length || native.some((layer) => dom.contains(layer, dialog))).reverse();
  let modal = null;
  for (const candidate of candidates) {
    const r = candidate.getBoundingClientRect();
    const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
    const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    if (left >= right || top >= bottom) continue;
    const painted = dom.stack((left + right) / 2, (top + bottom) / 2);
    // The first dialog in the hit-test stack wins, including nested dialogs.
    for (const hit of painted) {
      const owner = candidates.find((dialog) => dom.contains(dialog, hit));
      if (owner) { modal = owner; break; }
    }
    if (modal) break;
  }
  // A background tab can lack a hit-test stack. Keep its visible dialog usable
  // rather than falling back to the background document and losing it again.
  if (!modal) modal = candidates.find((dialog) => {
    const r = dialog.getBoundingClientRect();
    return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  }) || null;
  // A select, combobox or menu inside the modal often renders its options in a
  // portal at the end of <body>, outside the dialog. Those stay in scope: roots
  // the modal's controls point at (aria-controls/aria-owns), open popovers, and
  // any control painted on top of the modal: inside the modal's rectangle, and
  // the topmost element at its own centre.
  // The dialog's name, so a snapshot scoped to it says which one it is:
  // its ARIA name, or its first heading.
  let dialogName = '';
  if (modal) {
    const heading = dom.queryAll(modal, 'h1,h2,h3,h4,h5,h6,[role=heading]').find((h) => visible(h) && (h.innerText || '').trim());
    dialogName = (labelOf(modal, dom, false) || heading?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
  }
  const floating = [];
  if (modal) {
    for (const owner of dom.queryAll(modal, '[aria-controls],[aria-owns]')) {
      const ids = ((owner.getAttribute('aria-controls') || '') + ' ' + (owner.getAttribute('aria-owns') || '')).split(/\\s+/);
      for (const id of ids) {
        const root = id && dom.byId(owner, id);
        if (root && !dom.contains(modal, root)) floating.push(root);
      }
    }
    try {
      for (const pop of dom.queryAll(document, ':popover-open')) {
        if (!dom.contains(modal, pop) && !dom.contains(pop, modal)) floating.push(pop);
      }
    } catch {}
  }
  const bounds = modal ? modal.getBoundingClientRect() : null;
  const inScope = (el) => {
    if (!modal || dom.contains(modal, el)) return true;
    if (floating.some((root) => dom.contains(root, el))) return true;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < Math.max(0, bounds.left) || y < Math.max(0, bounds.top) ||
        x >= Math.min(innerWidth, bounds.right) || y >= Math.min(innerHeight, bounds.bottom)) return false;
    const hit = dom.hit(x, y);
    return !!hit && (hit === el || dom.contains(el, hit));
  };
  let frames = 0;
  let framed = 0;
  // Rows and cells are labelled cell by cell, so "Ana | Admin | Active" reads
  // as one row rather than run-together text.
  const cellText = (el) => (el.innerText || '').split(/[\\t\\n]+/).map((part) => part.replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' | ');
  for (const el of dom.queryAll(document, '*')) {
    if (!listed(el) || !inScope(el) || !(visible(el) || hiddenFileInput(el, dom, visible))) continue;
    const kind = kindOf(el);
    // Rows, cells and plain click targets are only worth listing by their
    // text: an empty spacer row or an icon-only wrapper is noise.
    if (kind && !(el.getAttribute('aria-label') || '').trim() && !(el.innerText || '').trim()) continue;
    // A frame's controls are its own document's, searched separately. Mark
    // the frames in scope so that search knows which to enter (one behind
    // this page's dialog is not), and count the ones big enough to hold a
    // form, not tracking pixels or ads.
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      el.setAttribute('data-cu-frame', '');
      framed++;
      const r = el.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 40) frames++;
      continue;
    }
    const index = base + i++;
    // Tag the full selected scope so indices stay global and earlier pages remain
    // actionable when paging an unchanged UI. Only label/serialize this page.
    el.setAttribute('data-cu-idx', String(index));
    if (index < offset || index >= offset + limit) continue;
    const r = el.getBoundingClientRect();
    // A password field's value is the secret itself: never let it reach the
    // model as a label (browser_request_credentials fills these instead).
    const secret = el.tagName === 'INPUT' && el.type === 'password';
    // A checkbox or radio is named by its label, never its value ("on").
    const toggle = (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) ||
      /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/i.test(el.getAttribute('role') || '');
    const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    const label = kind === 'row' || kind === 'cell'
      ? (el.getAttribute('aria-label') || cellText(el)).replace(/\\s+/g, ' ').trim().slice(0, 160)
      : toggle
      ? labelOf(el, dom).slice(0, 90)
      : (el.getAttribute('aria-label') || (field ? labelOf(el, dom, false) : '') || el.innerText || (secret ? '' : el.value) ||
         el.getAttribute('title') || el.getAttribute('placeholder') || '')
        .replace(/\\s+/g, ' ').trim().slice(0, 90);
    const state = stateOf(el);
    // Text the page lets the user edit in place reads as a plain span or div
    // otherwise, and an agent then clicks it expecting an editor to open (#72).
    const type = el.tagName === 'INPUT' && el.type && el.type !== 'text' ? '[' + el.type + ']'
      : !field && el.isContentEditable ? '[editable]' : '';
    out.push({
      i: index,
      tag: kind === 'row' || kind === 'cell' ? kind : el.tagName.toLowerCase() + (kind === 'clickable' ? '[clickable]' : type),
      label,
      ...(state ? { state } : {}),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
    });
  }
  // Nothing listed while the page has controls reads as an empty page. Say
  // what kept them out instead, by count; never their text.
  let empty = null;
  if (i === 0) {
    const reasons = {};
    let skipped = 0;
    for (const el of dom.queryAll(document, sel)) {
      const reason = !inScope(el) ? 'behind the dialog' : visible(el, true);
      if (!reason) continue;
      skipped++;
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    if (skipped) {
      const parts = Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, n]) => n + ' ' + reason);
      empty = 'no control is listed, but the page has ' + skipped + ' that ' + (skipped === 1 ? 'is' : 'are') +
        ' not shown (' + parts.join(', ') + '). A menu or dialog that is still opening, or one that hides the ' +
        'rest of the page from assistive tech, can do this: wait_for_selector, snapshot again, or use browser_read for its text';
    }
  }
  const end = Math.min(base + i, offset + out.length);
  return { title: document.title, url: location.href, elements: out, ...(empty ? { empty } : {}),
    shown: document.visibilityState === 'visible',
    scope: modal ? 'modal' : 'page', ...(dialogName ? { dialog: dialogName } : {}), total: i, offset, limit, frames, framed,
    truncated: end < i, nextOffset: end < i ? end : null };
})()`;

async function snapshot(tabId, { offset = 0, limit = 250, access } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) throw new Error("offset must be an integer from 0 to 2147483647");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new Error("limit must be an integer from 1 to 250");
  const take = async (frame, base) => {
    const res = await evaluateIn(tabId, frame, {
      expression: SNAPSHOT_JS.slice(0, -2) + `(${JSON.stringify({ offset, limit, base })})`,
      returnByValue: true,
    });
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || "evaluate failed");
    return res.result.value;
  };
  try {
    let value = await take(undefined, 0);
    // Nothing listed on a page Chrome is not drawing: ask once more for it to
    // be shown and look again, and if it still is not, say so (#63).
    if (value?.shown === false && value.total === 0) {
      if (await redraw(tabId)) value = await take(undefined, 0);
      if (value?.shown === false && value.total === 0) value.empty = NOT_DRAWN_NOTE;
    }
    return await withFrames(tabId, value, take, offset, limit, access);
  } catch (error) {
    if (!error?.dialog) throw error;
    return dialogSnapshot(tabId, error.dialog, offset, limit);
  }
}

/**
 * Add the page's frames to its snapshot: each shown, in-scope frame's
 * elements, numbered after everything before it, placed at page coordinates
 * and tagged with the frame's name. `frames` becomes the number of frames
 * that could not be searched, and `framesSearched` the number that were.
 */
async function withFrames(tabId, page, take, offset, limit, access) {
  const ranges = [{ start: 0, end: page.total, frame: { main: true } }];
  frameIndexes.set(tabId, ranges);
  // `framed` counts the shown frames the page marked; none means nothing to search.
  if (!page.framed) {
    delete page.framed;
    return page;
  }
  let frames;
  try {
    frames = await placedFrames(tabId, { scoped: true });
  } catch {
    return page;
  }
  let total = page.total;
  let searched = 0;
  let blocked = 0;
  // `page.frames` counts the page's own big frames; each of those searched
  // comes off it, and any other frame that could not be read is added.
  let unsearched = page.frames || 0;
  const big = (frame) => frame.depth === 1 && frame.outer && frame.outer.width >= 100 && frame.outer.height >= 40;
  const elements = [...page.elements];
  for (const frame of frames) {
    if (frame.main || (!frame.reachable && !frame.unknown)) continue;
    // The user's site rules hold inside frames too.
    if (!frameAllowed(access, frame.url)) {
      blocked++;
      if (!big(frame)) unsearched++;
      continue;
    }
    let value = null;
    if (frame.reachable) {
      try {
        value = await take(frame, total);
      } catch {
        value = null;
      }
    }
    if (!value) {
      if (!big(frame)) unsearched++;
      continue;
    }
    searched++;
    if (big(frame)) unsearched = Math.max(0, unsearched - 1);
    const name = frameName(frame, value.title);
    frame.name = name;
    ranges.push({ start: total, end: total + value.total, frame });
    total += value.total;
    for (const element of value.elements) {
      const x = element.x + frame.offset.x;
      const y = element.y + frame.offset.y;
      const clip = frame.clip;
      const inClip = !clip || (x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom);
      elements.push({ ...element, x: Math.round(x), y: Math.round(y), inView: element.inView && inClip, frame: name });
    }
  }
  const end = Math.min(total, offset + elements.length);
  delete page.framed;
  const merged = {
    ...page,
    elements,
    total,
    truncated: end < total,
    nextOffset: end < total ? end : null,
    frames: unsearched,
    ...(searched ? { framesSearched: searched } : {}),
    ...(blocked ? { framesBlocked: blocked } : {}),
  };
  // "Nothing is listed" was about the page alone; a frame listed something.
  if (total > 0) delete merged.empty;
  return merged;
}

/// Whether the tab has any frame at all, without placing them.
async function hasChildFrames(tabId) {
  if (childSessions.get(tabId)?.size) return true;
  try {
    const tree = await send(tabId, "Page.getFrameTree");
    return (tree?.frameTree?.childFrames?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/// A snapshot of a page paused behind a JavaScript dialog: the dialog is the
/// one thing on it that can be acted on, and nothing in the page can be read.
/// Title and URL come from Chrome's view of the tab, which still answers.
async function dialogSnapshot(tabId, dialog, offset, limit) {
  const tab = await withDeadline(chrome.tabs.get(tabId), "tab lookup").catch(() => ({}));
  return {
    title: tab.title ?? "", url: tab.url ?? "", elements: [], total: 0, offset, limit,
    scope: "page", frames: 0, truncated: false, nextOffset: null,
    jsDialog: publicDialog(dialog),
    empty: `nothing is listed while the page waits on its JavaScript ${dialog.type} dialog (${dialog.id}); answer it with browser_handle_dialog`,
  };
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
  try {
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
  } catch (error) {
    if (!error?.opened) throw error;
    return openedDialog(error.dialog, { clicked: { x, y }, cursor });
  }
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

/// Find a snapshotted element, scroll it to the middle of the view, and find a
/// point where a press reaches it: the element itself, or its own label. Then
/// say whether real input can reach it there: only in a tab Chrome is showing.
/// When something else is painted over every point (a sticky bar, another
/// checkbox, a dialog), the click fails: pressing there would press that
/// instead. When it can, a probe records which trusted events land on it, so
/// the click can check its hover reached the element before pressing anything.
const CLICK_TARGET_JS = (index) => `(() => {
  const dom = (${pageDomInPage.toString()})();
  const labelOf = ${controlLabelInPage.toString()};
  const stateOf = ${controlStateInPage.toString()};
  const el = dom.byIndex(${index});
  if (!el) return { ok: false, reason: 'element ${index} is no longer on the page' };
  // Instant, so a page with smooth scrolling is not measured mid-flight.
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const clean = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
  const toggle = (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) ||
    /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/i.test(el.getAttribute('role') || '');
  const label = clean(toggle ? labelOf(el, dom) : (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '')).slice(0, 60);
  const describe = (node) => {
    if (!(node instanceof Element)) return 'nothing';
    const idx = node.closest?.('[data-cu-idx]')?.getAttribute('data-cu-idx');
    const text = clean(node.getAttribute('aria-label') || node.innerText).slice(0, 40);
    return (idx !== null && idx !== undefined ? '[' + idx + '] ' : '') + node.tagName.toLowerCase() + (text ? ' "' + text + '"' : '');
  };
  const shown = document.visibilityState === 'visible';
  const found = { ok: true, tag: el.tagName.toLowerCase(), label, href: el.href || null, toggle, before: stateOf(el) };
  window.__cuClickProbe?.done();
  delete window.__cuClickProbe;
  // A press lands on the element itself, or on its own label, or on the
  // decoration of a small widget that holds this control and no other (a
  // checkbox component's box and ripple). Anything else at the point is a
  // different control, a sticky header or a dialog in front: never pressed.
  const controls = 'input:not([type=hidden]),button,select,textarea,a[href],[role=button],[role=link],[role=checkbox],' +
    '[role=radio],[role=switch],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab]';
  const own = (hit) => !!hit && (hit === el || dom.contains(el, hit));
  const belongs = (hit) => {
    if (!hit) return false;
    for (const owner of el.labels || []) if (dom.contains(owner, hit) || owner === hit) return true;
    let common = dom.parent(el);
    while (common instanceof Element && !dom.contains(common, hit) && common !== hit) common = dom.parent(common);
    if (!(common instanceof Element) || common === document.body || common === document.documentElement) return false;
    const box = common.getBoundingClientRect();
    if (box.width * box.height > Math.max(r.width * r.height, 48 * 48) * 12) return false;
    return dom.queryAll(common, controls).every((other) => other === el || dom.contains(el, other) || dom.contains(other, el));
  };
  // The centre first, then points around it, kept inside the viewport.
  const points = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.2, 0.2], [0.8, 0.8], [0.2, 0.8], [0.8, 0.2]]
    .map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy])
    .filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
  if (!points.length) {
    return { ...found, x: r.left + r.width / 2, y: r.top + r.height / 2, reachable: false, covered: true,
      why: 'it is outside the visible page even after scrolling it into view' };
  }
  let chosen = null;
  let through = null;
  let cover = null;
  for (const [x, y] of points) {
    const hit = dom.hit(x, y);
    if (own(hit)) { chosen = [x, y]; break; }
    if (!through && belongs(hit)) through = [x, y];
    if (!cover) cover = hit;
  }
  const via = chosen ? 'own' : through ? 'label' : null;
  const [x, y] = chosen || through || points[0];
  if (!shown) return { ...found, x, y, reachable: false, why: 'the tab is in the background' };
  if (!via) {
    return { ...found, x, y, reachable: false, covered: true,
      why: (cover ? describe(cover) + ' covers it' : 'nothing is painted at its position') + ' even after scrolling it into view' };
  }
  const seen = { hover: false, press: false, click: false };
  const kinds = { pointerover: 'hover', pointermove: 'hover', mousemove: 'hover', pointerdown: 'press', mousedown: 'press', click: 'click' };
  const accept = (node) => own(node) || (via === 'label' && belongs(node));
  const listener = (e) => {
    if (!e.isTrusted) return;
    const kind = kinds[e.type];
    if (kind === 'click' ? e.composedPath().includes(el) : accept(e.composedPath()[0])) seen[kind] = true;
  };
  for (const type in kinds) addEventListener(type, listener, true);
  window.__cuClickProbe = { seen, done: () => { for (const type in kinds) removeEventListener(type, listener, true); } };
  return { ...found, x, y, reachable: true, via };
})()`;

/// The state of a clicked toggle after the press, so the reply can say what
/// it is now rather than leave the agent to assume.
const CLICK_STATE_JS = (index) => `(() => {
  const el = (${pageDomInPage.toString()})().byIndex(${index});
  return el ? { state: (${controlStateInPage.toString()})(el) } : { gone: true };
})()`;

/// What the click probe has seen; `finish` also removes it. Gone means the
/// document it was installed in is gone too: the press navigated.
const CLICK_PROBE_JS = (finish) => `(() => {
  const probe = window.__cuClickProbe;
  if (!probe) return { gone: true };
  if (${finish}) { probe.done(); delete window.__cuClickProbe; }
  return { ...probe.seen };
})()`;

/// The press as page events, for a tab real input cannot reach. Carries what
/// a real mouse press carries (button state, pointer type, a click count), so
/// controls that check those (menus that open only when buttons === 1) still
/// respond; and, like a real press, a cancelled pointerdown suppresses the
/// mouse events and a cancelled mousedown keeps focus where it was.
const CLICK_EVENTS_JS = (index) => `(() => {
  const el = (${pageDomInPage.toString()})().byIndex(${index});
  if (!el) return { ok: false, reason: 'element ${index} is no longer on the page' };
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y,
                 screenX: screenX + x, screenY: screenY + outerHeight - innerHeight + y, button: 0, buttons: 0 };
  const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
  const fire = (Type, type, init) => el.dispatchEvent(new Type(type, { ...base, ...init }));
  fire(PointerEvent, 'pointerover', pointer);
  fire(PointerEvent, 'pointerenter', { ...pointer, bubbles: false, cancelable: false });
  fire(MouseEvent, 'mouseover', {});
  fire(MouseEvent, 'mouseenter', { bubbles: false, cancelable: false });
  fire(PointerEvent, 'pointermove', pointer);
  fire(MouseEvent, 'mousemove', {});
  const mouse = fire(PointerEvent, 'pointerdown', { ...pointer, buttons: 1, pressure: 0.5 });
  if (mouse && fire(MouseEvent, 'mousedown', { buttons: 1, detail: 1 })) el.focus?.();
  fire(PointerEvent, 'pointerup', pointer);
  if (mouse) fire(MouseEvent, 'mouseup', { detail: 1 });
  // A dispatched click still runs the element's activation (links follow,
  // checkboxes toggle); el.click() would say detail 0 and no pointer type.
  fire(PointerEvent, 'click', { ...pointer, detail: 1 });
  return { ok: true };
})()`;

async function evaluateValue(tabId, expression, failure, frame = undefined) {
  const res = await evaluateIn(tabId, frame, { expression, returnByValue: true, userGesture: true });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || failure);
  return res?.result?.value || {};
}

/// The frame a snapshot index is in, checked to still be there. Undefined for
/// the page itself. A frame that went away (it navigated, or its site's
/// process ended) takes its indices with it.
async function liveFrameForIndex(tabId, index, access) {
  const frame = frameForIndex(tabId, index);
  if (!frame) return undefined;
  const sessions = childSessions.get(tabId);
  if (frame.session && !sessions?.has(frame.session)) {
    throw new Error(`element ${index} was in frame "${frame.name || "frame"}", which is no longer on the page — call browser_snapshot again`);
  }
  // The frame may have navigated since the snapshot; its session knows where it is now.
  const url = (frame.world ? null : sessions?.get(frame.session)?.url) || frame.url;
  if (!frameAllowed(access, url)) {
    throw new Error(`element ${index} is in a frame from ${originOf(url)}, which the user's Computer Use policy does not allow here`);
  }
  return frame;
}

/// Turn a point in a frame's document into page coordinates, re-measured now
/// (scrolling the element into view can move the frame too). Says why not
/// when the point is outside what the frame shows.
async function pointInPage(tabId, frame, x, y) {
  if (!frame) return { x, y };
  const now = await currentPlacement(tabId, frame);
  if (!now) return { why: `its frame "${frame.name || "frame"}" is no longer shown on the page` };
  const px = x + now.offset.x;
  const py = y + now.offset.y;
  const clip = now.clip;
  if (clip && !(px >= clip.left && px < clip.right && py >= clip.top && py < clip.bottom)) {
    return { x: px, y: py, why: `it is outside the part of frame "${frame.name || "frame"}" that the page shows` };
  }
  return { x: px, y: py };
}

/// Click a snapshotted element.
///
/// This is a real press through the DevTools input pipeline: trusted events,
/// exactly as a person's mouse makes them. It works in a background tab too,
/// because the debugger session emulates focus (see attach), which keeps the
/// tab rendering without selecting it or raising its window; frameworks that
/// ignore untrusted events (Angular Material buttons) respond to it. Only when
/// real input cannot reach the element (Chrome would not emulate focus, or
/// another element covers it) is the press played as page events on the node
/// itself. `route` says which one ran, and `target` which element it was, so
/// an ignored click can be told from a stale index.
async function clickElement(tabId, index, access) {
  // The index is spliced into the scripts that run in the page, so only a
  // plain snapshot index may reach them: anything else would run as page script.
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("index must be an element index from browser_snapshot");
  }
  const frame = await liveFrameForIndex(tabId, index, access);
  const found = await evaluateValue(tabId, CLICK_TARGET_JS(index), "click failed", frame);
  if (!found.ok) throw new Error(found.reason || "click failed");
  const target = describeTarget(index, found) + (frame ? ` in frame "${frame.name || "frame"}"` : "");
  // A point in a frame's document is pressed at its place on the page.
  const point = await pointInPage(tabId, frame, found.x, found.y);
  if (point.why && !found.covered) {
    found.covered = true;
    found.why = point.why;
  }
  // Covered or outside the page: a press at that point would land on
  // whatever is there, so nothing is pressed at all.
  if (found.covered) {
    await evaluateValue(tabId, CLICK_PROBE_JS(true), "click failed", frame).catch(() => {});
    throw new Error(
      `not clicked: ${target} cannot be reached — ${found.why}. Nothing was pressed. ` +
        "Close or scroll away what is in front of it, then browser_snapshot again",
    );
  }
  const { x, y } = point;
  let route = "page-events";
  let why = found.why;
  if (found.reachable) {
    try {
      // Hover first and check it reached the element: a press at a point the
      // page reads differently (zoom, a layout shift) would hit something else.
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse" });
      if ((await evaluateValue(tabId, CLICK_PROBE_JS(false), "click failed", frame)).hover) {
        const press = { x, y, button: "left", clickCount: 1, pointerType: "mouse" };
        try {
          await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...press, buttons: 1 });
          await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...press, buttons: 0 });
        } catch (error) {
          if (!error?.opened) throw error;
          return openedDialog(error.dialog, { ok: true, tag: found.tag, x, y, route: "input", target });
        }
        // A press that navigated took the probe (or the whole context) with
        // it. Otherwise not pressed means not delivered, so the page events
        // below are not a second click.
        const seen = await evaluateValue(tabId, CLICK_PROBE_JS(true), "click failed", frame).catch(() => ({ gone: true }));
        if (seen.press || seen.click || seen.gone) route = "input";
        else why = "real input did not reach it";
      } else {
        // The page moved between finding the point and hovering it. Pressing
        // now could land on something else, so stop here.
        throw new Error(
          `not clicked: ${target} moved before it could be pressed, and the pointer landed on something else. ` +
            "Nothing was pressed; browser_snapshot again",
        );
      }
    } finally {
      await evaluateValue(tabId, CLICK_PROBE_JS(true), "click failed", frame).catch(() => {});
    }
  }
  if (route !== "input") {
    let fired;
    try {
      fired = await evaluateValue(tabId, CLICK_EVENTS_JS(index), "click failed", frame);
    } catch (error) {
      if (!error?.opened) throw error;
      return openedDialog(error.dialog, { ok: true, tag: found.tag, x, y, route, why, target });
    }
    if (!fired.ok) throw new Error(fired.reason || "click failed");
  }
  // A checkbox, radio or switch says what it is now.
  let state;
  let note;
  if (found.toggle) {
    const after = await evaluateValue(tabId, CLICK_STATE_JS(index), "click failed", frame).catch(() => ({}));
    if (typeof after.state === "string") {
      state = after.state;
      if (after.state === found.before) note = `its state did not change (still ${after.state || "the same"})`;
    }
  }
  const cursor = await paintCursor(tabId, x, y);
  await markTab(tabId);
  return {
    ok: true, tag: found.tag, href: found.href, x, y, route,
    ...(route === "input" ? {} : { why }),
    ...(found.via === "label" ? { via: "label" } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(note ? { note } : {}),
    target, cursor,
  };
}

function describeTarget(index, { tag, label }) {
  return `[${index}] ${tag}${label ? ` "${label}"` : ""}`;
}

async function typeText(tabId, text) {
  await send(tabId, "Input.insertText", { text });
  await markTab(tabId);
  return { typed: text.length };
}

/// Watch the next Tab keydown, so the follow-up can tell a page that handled
/// the key itself (an editor indenting, a widget trapping focus) from one where
/// nothing happened.
const TAB_PROBE_JS = `(() => {
  const probe = { before: document.activeElement };
  probe.listener = (e) => {
    if (e.key !== 'Tab') return;
    probe.event = e;
  };
  addEventListener('keydown', probe.listener, true);
  window.__cuTabProbe = probe;
  return true;
})()`;

/// Finish a Tab press. Chrome runs its own focus traversal only in a page that
/// has focus, and an agent tab in the background never does: the keystroke
/// reaches the page's handlers and then focus stays put, so the next type lands
/// in the field the agent meant to leave. When that happens, move focus to the
/// next element in sequential focus order the way the browser would have.
const TAB_FINISH_JS = `(() => {
  const probe = window.__cuTabProbe;
  delete window.__cuTabProbe;
  if (probe) removeEventListener('keydown', probe.listener, true);
  const name = (el) => {
    if (!el || el === document.body || el === document.documentElement) return null;
    const label = el.getAttribute('aria-label') || el.labels?.[0]?.innerText ||
      el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') ||
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : el.innerText) || el.id || '';
    const index = el.getAttribute('data-cu-idx');
    return (index !== null ? '[' + index + '] ' : '') + el.tagName.toLowerCase() +
      (label ? ' "' + String(label).trim().replace(/\\s+/g, ' ').slice(0, 60) + '"' : '');
  };
  const before = probe ? probe.before : null;
  const active = document.activeElement;
  if (probe && active !== before) return { moved: true, focused: name(active) };
  if (probe?.event?.defaultPrevented) return { moved: false, handled: true, focused: name(active) };
  if (active && (active.tagName === 'IFRAME' || active.tagName === 'FRAME' || active.shadowRoot)) {
    return { moved: false, reason: 'focus is inside a frame or component the extension cannot step through' };
  }
  const shown = (el) => {
    if (el.disabled || el.closest('[inert]') || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse';
  };
  // A radio group is one stop: its checked button, or its first if none is.
  const radioStop = (el) => {
    if (el.type !== 'radio' || !el.name) return true;
    const scope = el.form || document;
    const group = Array.from(scope.querySelectorAll('input[type=radio]'))
      .filter((r) => r.name === el.name && shown(r));
    const checked = group.find((r) => r.checked);
    return checked ? checked === el : group[0] === el;
  };
  const sel = 'a[href], area[href], button, input:not([type=hidden]), select, textarea, iframe, ' +
    'summary, [contenteditable]:not([contenteditable=false]), [tabindex]';
  const stops = Array.from(document.querySelectorAll(sel))
    .filter((el) => el.tabIndex >= 0 && shown(el) && radioStop(el));
  const order = stops.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex)
    .concat(stops.filter((el) => el.tabIndex === 0));
  const at = order.indexOf(active);
  let next;
  if (at >= 0) next = order[at + 1];
  else if (active && active !== document.body && active !== document.documentElement) {
    next = order.find((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  } else next = order[0];
  if (!next) return { moved: false, reason: 'focus is already on the last element of the page' };
  next.focus();
  if (document.activeElement !== next) return { moved: false, reason: 'the next element refused focus' };
  // Tabbing into a text field selects its contents, as it does for a person.
  if (next.tagName === 'TEXTAREA' || (next.tagName === 'INPUT' && typeof next.select === 'function' &&
      /^(text|search|url|tel|email|password|number)$/.test(next.type))) {
    try { next.select(); } catch {}
  }
  return { moved: true, focused: name(next) };
})()`;

/// Note the focused text field before a Backspace, and watch whether the page
/// takes the key for itself, so the follow-up can check the field changed.
/// Values stay in the page: only whether they changed comes back.
const EDIT_PROBE_JS = `(() => {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  const field = !!el && (el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(el.type)));
  if (!field && !el?.isContentEditable) { window.__cuEditProbe = { el: null }; return false; }
  const state = () => {
    if (field) {
      let start = null, end = null;
      try { start = el.selectionStart; end = el.selectionEnd; } catch {}
      return { value: el.value, start, end };
    }
    const sel = getSelection();
    return { value: el.textContent, start: sel?.focusOffset ?? null, end: sel?.anchorOffset ?? null };
  };
  const probe = { el, field, state, before: state(), events: [] };
  probe.listener = (e) => {
    if (e.type === 'keydown' && e.key !== 'Backspace') return;
    if (e.composedPath().includes(el)) probe.events.push(e);
  };
  probe.done = () => { for (const type of ['keydown', 'beforeinput']) removeEventListener(type, probe.listener, true); };
  for (const type of ['keydown', 'beforeinput']) addEventListener(type, probe.listener, true);
  window.__cuEditProbe = probe;
  return true;
})()`;

/// Finish a Backspace. Chrome runs a key's editing action only in a page that
/// has focus, and an agent tab in the background never does: the page sees the
/// keydown and the field keeps its text (#54). When the field did not change
/// and the page did not take the key for itself, delete the way the browser
/// would have, the character before the caret or the selection, with the
/// input event a page listens for. A field that still does not change is an
/// error, never a success.
const EDIT_FINISH_JS = `(() => {
  const probe = window.__cuEditProbe;
  delete window.__cuEditProbe;
  if (!probe?.el) return { checked: false };
  probe.done();
  const { el, field, state, before } = probe;
  const same = (a, b) => a.value === b.value && a.start === b.start && a.end === b.end;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active !== el) return { checked: true, edited: true, note: 'focus moved off the field' };
  if (!same(before, state())) return { checked: true, edited: true };
  // A page that cancels the key (a chip input removing a tag, an editor with
  // its own undo) decided what Backspace does; do not delete on top of that.
  if (probe.events.some((e) => e.defaultPrevented)) return { checked: true, edited: false, handled: true };
  const empty = before.value === '' || (before.start === 0 && before.end === 0);
  if (empty) return { checked: true, edited: false, note: 'there was nothing before the caret to delete' };
  try { document.execCommand('delete'); } catch {}
  if (!same(before, state())) return { checked: true, edited: true, fallback: true };
  if (field && before.start !== null) {
    let start = Math.min(before.start, before.end), end = Math.max(before.start, before.end);
    if (start === end) {
      start -= 1;
      // Never split a character made of two UTF-16 units (most emoji).
      if (start > 0 && /[\\uDC00-\\uDFFF]/.test(el.value[start]) && /[\\uD800-\\uDBFF]/.test(el.value[start - 1])) start -= 1;
    }
    try {
      el.setRangeText('', start, end, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
    } catch {}
    if (!same(before, state())) return { checked: true, edited: true, fallback: true };
  }
  return { checked: true, edited: false };
})()`;

// ── keys ────────────────────────────────────────────────────────────────────
//
// A key goes to the tab's own page through the DevTools input pipeline, never
// to the OS: a desktop keystroke lands in whichever Chrome window is in front,
// which can be the user's. Chrome keeps these events to the page (Cmd+W does
// not close the tab, Cmd+Q does not quit), and focus emulation (see attach)
// lets their editing action run in a tab the user is not looking at.

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MODIFIER_NAMES = {
  alt: "Alt", option: "Alt", opt: "Alt",
  ctrl: "Control", control: "Control",
  cmd: "Meta", command: "Meta", meta: "Meta", super: "Meta", win: "Meta", windows: "Meta",
  shift: "Shift",
};
/** Named keys: [windowsVirtualKeyCode, code, text]. */
const NAMED_KEYS = {
  Enter: [13, "Enter", "\r"], Tab: [9, "Tab"], Escape: [27, "Escape"], Backspace: [8, "Backspace"],
  Delete: [46, "Delete"], Insert: [45, "Insert"], Home: [36, "Home"], End: [35, "End"],
  PageUp: [33, "PageUp"], PageDown: [34, "PageDown"],
  ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], ArrowLeft: [37, "ArrowLeft"], ArrowRight: [39, "ArrowRight"],
  " ": [32, "Space", " "],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, [112 + i, `F${i + 1}`]])),
};
const KEY_ALIASES = {
  return: "Enter", enter: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", backspace: "Backspace",
  delete: "Delete", del: "Delete", forwarddelete: "Delete", insert: "Insert", ins: "Insert",
  home: "Home", end: "End", pageup: "PageUp", pgup: "PageUp", pagedown: "PageDown", pgdn: "PageDown",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  space: " ", spacebar: " ",
};
/** US-layout punctuation: [windowsVirtualKeyCode, code]. */
const PUNCTUATION = {
  ";": [186, "Semicolon"], "=": [187, "Equal"], ",": [188, "Comma"], "-": [189, "Minus"], ".": [190, "Period"],
  "/": [191, "Slash"], "`": [192, "Backquote"], "[": [219, "BracketLeft"], "\\": [220, "Backslash"],
  "]": [221, "BracketRight"], "'": [222, "Quote"],
};
/** Shifted characters and the key they are typed on. */
const SHIFTED = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};
/**
 * On macOS a key's editing action comes from the Cocoa key bindings, which
 * events sent through DevTools skip; without these commands Cmd+A selects
 * nothing. Elsewhere Blink maps the keys itself. Home and End move within the
 * line here, as they do on Windows and Linux, not scroll the page.
 */
const MAC_EDIT_COMMANDS = {
  Backspace: "deleteBackward", "Shift+Backspace": "deleteBackward",
  "Alt+Backspace": "deleteWordBackward", "Meta+Backspace": "deleteToBeginningOfLine",
  Delete: "deleteForward", "Alt+Delete": "deleteWordForward", "Meta+Delete": "deleteToEndOfLine",
  ArrowUp: "moveUp", ArrowDown: "moveDown", ArrowLeft: "moveLeft", ArrowRight: "moveRight",
  "Shift+ArrowUp": "moveUpAndModifySelection", "Shift+ArrowDown": "moveDownAndModifySelection",
  "Shift+ArrowLeft": "moveLeftAndModifySelection", "Shift+ArrowRight": "moveRightAndModifySelection",
  "Alt+ArrowLeft": "moveWordLeft", "Alt+ArrowRight": "moveWordRight",
  "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection", "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection",
  "Meta+ArrowLeft": "moveToBeginningOfLine", "Meta+ArrowRight": "moveToEndOfLine",
  "Shift+Meta+ArrowLeft": "moveToBeginningOfLineAndModifySelection",
  "Shift+Meta+ArrowRight": "moveToEndOfLineAndModifySelection",
  "Meta+ArrowUp": "moveToBeginningOfDocument", "Meta+ArrowDown": "moveToEndOfDocument",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection",
  Home: "moveToBeginningOfLine", End: "moveToEndOfLine",
  "Shift+Home": "moveToBeginningOfLineAndModifySelection", "Shift+End": "moveToEndOfLineAndModifySelection",
  "Meta+Home": "moveToBeginningOfDocument", "Meta+End": "moveToEndOfDocument",
  "Shift+Meta+Home": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+Meta+End": "moveToEndOfDocumentAndModifySelection",
  "Meta+KeyA": "selectAll", "Meta+KeyC": "copy", "Meta+KeyX": "cut", "Meta+KeyV": "paste",
  "Meta+KeyZ": "undo", "Shift+Meta+KeyZ": "redo",
};
/** Shortcuts that use Cmd on macOS and Ctrl elsewhere. */
const PRIMARY_SHORTCUT_KEYS = new Set(["KeyA", "KeyC", "KeyX", "KeyV", "KeyZ", "KeyY", "Home", "End"]);

let macPlatform = null;
async function isMacPlatform() {
  if (macPlatform === null) {
    try {
      macPlatform = (await chrome.runtime.getPlatformInfo()).os === "mac";
    } catch {
      macPlatform = /mac/i.test(globalThis.navigator?.platform ?? "");
    }
  }
  return macPlatform;
}

/**
 * Work out the events for one key press: `key` is a key name ("Enter", "a",
 * "ArrowLeft") or a combination ("cmd+a"), `modifiers` names held keys.
 * Editing shortcuts are made to mean the same on every platform: Ctrl+A on a
 * Mac and Cmd+A on Windows both select all, and the reply says so.
 */
function resolveKeyPress(rawKey, rawModifiers, mac) {
  if (typeof rawKey !== "string" || !rawKey || rawKey.length > 40) {
    throw new Error("key must be a key name such as Enter, a, ArrowLeft or Delete");
  }
  if (rawModifiers !== undefined && (!Array.isArray(rawModifiers) || rawModifiers.length > 4)) {
    throw new Error("modifiers must be a list of up to four of cmd, ctrl, alt, shift");
  }
  const names = [...(rawModifiers ?? [])];
  let keyName = rawKey;
  // "cmd+a", "Ctrl+Shift+Z": the last part is the key ("cmd++" is Cmd with +).
  if (rawKey.length > 1 && rawKey.includes("+")) {
    const parts = rawKey.endsWith("++") ? [...rawKey.slice(0, -2).split("+"), "+"] : rawKey.split("+");
    keyName = parts.pop();
    names.push(...parts);
  }
  let bits = 0;
  for (const name of names) {
    const modifier = typeof name === "string" ? MODIFIER_NAMES[name.trim().toLowerCase()] : undefined;
    if (!modifier) throw new Error(`unknown modifier ${JSON.stringify(name)} — use cmd, ctrl, alt or shift`);
    bits |= MODIFIER_BITS[modifier];
  }
  let key;
  let code;
  let vk;
  let text;
  const named = NAMED_KEYS[keyName] ? keyName : KEY_ALIASES[keyName.toLowerCase()];
  if (named !== undefined) {
    key = named;
    [vk, code, text] = NAMED_KEYS[named];
  } else if ([...keyName].length === 1) {
    const char = keyName;
    const base = SHIFTED[char];
    if (base) bits |= MODIFIER_BITS.Shift;
    const plain = base ?? char;
    if (/^[a-z]$/i.test(plain)) {
      code = `Key${plain.toUpperCase()}`;
      vk = plain.toUpperCase().charCodeAt(0);
      // A capital letter is typed with Shift; a Shift press types a capital.
      if (plain !== plain.toLowerCase()) bits |= MODIFIER_BITS.Shift;
      key = bits & MODIFIER_BITS.Shift ? plain.toUpperCase() : plain.toLowerCase();
    } else if (/^[0-9]$/.test(plain)) {
      code = `Digit${plain}`;
      vk = plain.charCodeAt(0);
      key = char;
    } else if (PUNCTUATION[plain]) {
      [vk, code] = PUNCTUATION[plain];
      key = char;
    } else {
      key = char;
      vk = 0;
      code = "";
    }
    text = key;
  } else {
    throw new Error(
      `unknown key ${JSON.stringify(keyName)} — use a single character or one of Enter, Tab, Escape, Backspace, ` +
        "Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Insert, Space, F1-F12",
    );
  }
  const notes = [];
  // The same editing shortcut on every platform.
  if (PRIMARY_SHORTCUT_KEYS.has(code) && !(bits & MODIFIER_BITS.Alt)) {
    const has = (name) => (bits & MODIFIER_BITS[name]) !== 0;
    const label = (b) => comboLabel(b, key, code);
    const asked = bits;
    if (mac && has("Control") && !has("Meta")) {
      bits = (bits & ~MODIFIER_BITS.Control) | MODIFIER_BITS.Meta;
      // Redo is Cmd+Shift+Z on a Mac.
      if (code === "KeyY") {
        code = "KeyZ";
        vk = 90;
        bits |= MODIFIER_BITS.Shift;
        key = "Z";
      }
    } else if (!mac && has("Meta") && !has("Control")) {
      bits = (bits & ~MODIFIER_BITS.Meta) | MODIFIER_BITS.Control;
    }
    if (bits !== asked) notes.push(`sent ${label(asked)} as ${label(bits)}, the same shortcut on this ${mac ? "Mac" : "computer"}`);
  }
  // Ctrl, Cmd and Alt combinations type nothing; Shift does.
  if (bits & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt)) text = undefined;
  const lookup = [
    bits & MODIFIER_BITS.Shift ? "Shift+" : "",
    bits & MODIFIER_BITS.Alt ? "Alt+" : "",
    bits & MODIFIER_BITS.Control ? "Control+" : "",
    bits & MODIFIER_BITS.Meta ? "Meta+" : "",
    code?.startsWith("Key") ? code : key,
  ].join("");
  const command = mac ? MAC_EDIT_COMMANDS[lookup] : undefined;
  return {
    key, code, vk, text, modifiers: bits,
    commands: command ? [command] : [],
    label: comboLabel(bits, key, code),
    note: notes.join("; ") || null,
  };
}

function comboLabel(bits, key, code) {
  const parts = [];
  if (bits & MODIFIER_BITS.Control) parts.push("Ctrl");
  if (bits & MODIFIER_BITS.Alt) parts.push("Alt");
  if (bits & MODIFIER_BITS.Shift) parts.push("Shift");
  if (bits & MODIFIER_BITS.Meta) parts.push("Cmd");
  const name = key === " " ? "Space" : code?.startsWith("Key") ? code.slice(3) : key;
  return [...parts, name].join("+");
}

/// Send one resolved key press: down (with its text and editing command),
/// then up.
async function dispatchKey(tabId, press) {
  const base = {
    key: press.key, code: press.code, windowsVirtualKeyCode: press.vk, nativeVirtualKeyCode: press.vk,
    modifiers: press.modifiers,
  };
  await send(tabId, "Input.dispatchKeyEvent", {
    type: press.text ? "keyDown" : "rawKeyDown",
    ...base,
    ...(press.text ? { text: press.text, unmodifiedText: press.text } : {}),
    ...(press.commands.length ? { commands: press.commands } : {}),
  });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/// Where focus is after a key, and how much text is selected there: lengths
/// only, never the text.
const KEY_RESULT_JS = `(() => {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { focused: null };
  const label = el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') ||
    el.getAttribute('name') || el.getAttribute('title') ||
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : el.innerText) || el.id || '';
  const index = el.getAttribute('data-cu-idx');
  const focused = (index !== null ? '[' + index + '] ' : '') + el.tagName.toLowerCase() +
    (label ? ' "' + String(label).trim().replace(/\\s+/g, ' ').slice(0, 60) + '"' : '');
  let selected = null;
  try {
    if (typeof el.selectionStart === 'number') selected = Math.abs(el.selectionEnd - el.selectionStart);
  } catch {}
  if (selected === null && el.isContentEditable) {
    const sel = (el.getRootNode().getSelection?.() || getSelection());
    selected = sel ? sel.toString().length : null;
  }
  return { focused, selected };
})()`;

/// The frame keys go to now: the deepest one that has focus, or undefined
/// when focus is in the page itself. Keys are sent to the tab and Chrome
/// routes them there, so the checks that follow a key must look there too.
async function focusedFrame(tabId) {
  const res = await send(tabId, "Runtime.evaluate", {
    expression: `(() => {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      return !!el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME');
    })()`,
    returnByValue: true,
  });
  if (res?.result?.value !== true) return undefined;
  let best;
  for (const frame of await tabFrames(tabId)) {
    if (frame.main) continue;
    const focus = await evaluateIn(tabId, frame, { expression: "document.hasFocus()", returnByValue: true }).catch(() => null);
    if (focus?.result?.value === true && (!best || frame.depth > best.depth)) best = frame;
  }
  return best;
}

async function pressKey(tabId, rawKey, rawModifiers) {
  const press = resolveKeyPress(rawKey, rawModifiers, await isMacPlatform());
  const tab = press.key === "Tab" && press.modifiers === 0;
  const backspace = press.key === "Backspace" && press.modifiers === 0;
  const frame = await focusedFrame(tabId).catch(() => undefined);
  if (tab) await evaluateIn(tabId, frame, { expression: TAB_PROBE_JS, returnByValue: true });
  if (backspace) await evaluateIn(tabId, frame, { expression: EDIT_PROBE_JS, returnByValue: true });
  const pressed = { pressed: press.label, ...(press.note ? { note: press.note } : {}) };
  try {
    await dispatchKey(tabId, press);
  } catch (error) {
    // The key reached the page: that is what opened the dialog.
    if (!error?.opened) throw error;
    return openedDialog(error.dialog, pressed);
  }
  if (backspace) return { ...(await finishBackspace(tabId, frame)), pressed: press.label };
  if (!tab) {
    const after = await evaluateValue(tabId, KEY_RESULT_JS, "key press failed", frame).catch(() => ({}));
    const where = frame && after.focused ? ` in frame "${await nameOfFrame(tabId, frame)}"` : "";
    return {
      ...pressed,
      ...(after.focused ? { focused: after.focused + where } : {}),
      ...(Number.isInteger(after.selected) && after.selected > 0 ? { selected: after.selected } : {}),
    };
  }
  const res = await evaluateIn(tabId, frame, { expression: TAB_FINISH_JS, returnByValue: true });
  const focus = res?.result?.value || {};
  // Reporting success when focus stayed put sent the next type into the wrong
  // field, so an unmoved Tab is an error the agent can act on.
  if (!focus.moved && !focus.handled) {
    throw new Error(
      `Tab did not move focus (${focus.reason || "the page did not respond"}) — ` +
        "click the field you want with browser_click instead",
    );
  }
  return { ...pressed, focused: focus.focused ?? null, handledByPage: focus.handled === true };
}

// ── replacing a field's value ───────────────────────────────────────────────

/**
 * The text field a snapshot index names, inside the page. A snapshot can list
 * the wrapper around a field (a form-field component, a label) rather than
 * the field itself; a wrapper holding exactly one field stands for it.
 */
function fillTargetInPage(index, dom) {
  const found = dom.byIndex(index);
  if (!found) return { reason: `element ${index} is no longer on the page — call browser_snapshot again` };
  const textInput = (node) => node.tagName === "TEXTAREA" || (node.tagName === "INPUT" &&
    !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(node.type));
  const editable = (node) => textInput(node) || node.isContentEditable;
  let el = found;
  if (!editable(el)) {
    const inner = dom.queryAll(el, "input,textarea,[contenteditable]").filter(editable)
      .filter((node, _, all) => !all.some((other) => other !== node && other.contains(node)));
    if (inner.length !== 1) {
      return {
        reason: `element ${index} is not a text field` +
          (inner.length > 1 ? ` (it holds ${inner.length}; pass the index of one of them)` : ""),
      };
    }
    el = inner[0];
  }
  // A contenteditable's editing host is its outermost editable ancestor.
  let host = el;
  if (!textInput(el)) {
    for (let up = dom.parent(el); up instanceof Element && up.isContentEditable; up = dom.parent(up)) host = up;
  }
  return { el: host, field: textInput(host) };
}

/// Focus the field and select everything in it, so the text that follows
/// replaces it. Remembers the old value on the element to tell, afterwards,
/// whether anything reached it.
const FILL_PREPARE_JS = (index) => `(() => {
  const dom = (${pageDomInPage.toString()})();
  const target = (${fillTargetInPage.toString()})(${index}, dom);
  if (!target.el) return { ok: false, reason: target.reason };
  const { el, field } = target;
  if (el.disabled) return { ok: false, reason: 'element ${index} is disabled' };
  if (field && el.readOnly) return { ok: false, reason: 'element ${index} is read-only' };
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  el.focus({ preventScroll: true });
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active !== el && !(el.contains(active))) return { ok: false, reason: 'element ${index} would not take focus' };
  const value = () => field ? el.value : el.innerText;
  el.__cuFillBefore = value();
  // Whether Chrome's input reaches the field at all. A page that receives it
  // and refuses or reshapes it has decided; one it never reached has not.
  el.__cuFillSeen?.done();
  const seen = { reached: false };
  const listener = (e) => { if (e.isTrusted && e.composedPath().includes(el)) seen.reached = true; };
  addEventListener('beforeinput', listener, true);
  seen.done = () => removeEventListener('beforeinput', listener, true);
  el.__cuFillSeen = seen;
  if (field) {
    el.select();
  } else {
    const selection = el.getRootNode().getSelection?.() || getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const label = (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') ||
    el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  return {
    ok: true,
    tag: el.tagName.toLowerCase() + (el.tagName === 'INPUT' && el.type !== 'text' ? '[' + el.type + ']' : ''),
    label,
    secret: el.tagName === 'INPUT' && el.type === 'password',
  };
})()`;

/// After the text went in: whether the field now holds exactly it. With
/// `force`, a field Chrome's input never reached (no beforeinput at all) is
/// set directly, with the input event a framework listens for; a page that
/// got the input and refused or reshaped it is left as it decided. Only a non-secret value comes back, and only
/// when it differs from what was asked for.
const FILL_CHECK_JS = (index, expected, force) => `(() => {
  const dom = (${pageDomInPage.toString()})();
  const target = (${fillTargetInPage.toString()})(${index}, dom);
  if (!target.el) return { ok: false, reason: target.reason };
  const { el, field } = target;
  const expected = ${JSON.stringify(expected)};
  const value = () => field ? el.value : el.innerText;
  // innerText renders block breaks and trailing newlines its own way.
  const norm = (text) => field ? text : text.replace(/\\s+/g, ' ').trim();
  const before = el.__cuFillBefore;
  const reached = el.__cuFillSeen?.reached === true;
  el.__cuFillSeen?.done();
  delete el.__cuFillSeen;
  delete el.__cuFillBefore;
  let fallback = false;
  if (${force} && norm(value()) !== norm(expected) && value() === before && !reached) {
    if (field) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, expected); else el.value = expected;
    } else {
      el.textContent = expected;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: expected }));
    fallback = true;
  }
  const now = value();
  const matches = norm(now) === norm(expected);
  const secret = el.tagName === 'INPUT' && el.type === 'password';
  return {
    ok: true, matches, fallback, unchanged: now === before && !reached, length: now.length,
    ...(matches || secret ? {} : { value: now.slice(0, 300) }),
  };
})()`;

/// Replace a field's whole value: focus it by its snapshot index, select all
/// of it, then put the new text in through Chrome's own text input, so the
/// page sees the beforeinput/input events of a person typing (trusted, like a
/// paste over a selection). Works on input, textarea and contenteditable,
/// including inside open shadow roots, in a background tab.
async function fillElement(tabId, index, text, access) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("index must be an element index from browser_snapshot");
  }
  if (typeof text !== "string") throw new Error("text is required (pass an empty string to clear the field)");
  const frame = await liveFrameForIndex(tabId, index, access);
  const found = await evaluateValue(tabId, FILL_PREPARE_JS(index), "fill failed", frame);
  if (!found.ok) throw new Error(found.reason || "fill failed");
  // Chrome's text and key input goes to the focused frame, which focusing the
  // field made this one.
  if (text === "") {
    // Nothing to insert: delete the selection the way a person would.
    await dispatchKey(tabId, resolveKeyPress("Backspace", [], await isMacPlatform()));
  } else {
    await send(tabId, "Input.insertText", { text });
  }
  // When Chrome's input never reached the field (a Chrome that would not
  // emulate focus, say), the check sets the value directly, once.
  const check = await evaluateValue(tabId, FILL_CHECK_JS(index, text, true), "fill failed", frame);
  if (!check.ok) throw new Error(check.reason || "fill failed");
  await markTab(tabId);
  return {
    filled: true,
    target: describeTarget(index, found) + (frame ? ` in frame "${frame.name || "frame"}"` : ""),
    length: [...text].length,
    matches: check.matches,
    ...(check.fallback ? { note: "Chrome's text input did not reach the field, so the extension set its value directly" } : {}),
    ...(check.matches ? {} : { actualLength: check.length, ...(typeof check.value === "string" ? { value: check.value } : {}) }),
  };
}

async function finishBackspace(tabId, frame = undefined) {
  const res = await evaluateIn(tabId, frame, { expression: EDIT_FINISH_JS, returnByValue: true, userGesture: true });
  const edit = res?.result?.value || {};
  if (!edit.checked) return { pressed: "Backspace", note: "no text field has focus, so nothing was checked" };
  if (edit.handled) return { pressed: "Backspace", handledByPage: true };
  if (edit.edited) {
    return {
      pressed: "Backspace",
      ...(edit.fallback ? { note: "Chrome did not edit the field in this background tab, so the extension deleted the character itself" } : {}),
      ...(edit.note ? { note: edit.note } : {}),
    };
  }
  if (edit.note) return { pressed: "Backspace", note: edit.note };
  // Reporting success here let the next type append to text the agent meant
  // to remove.
  throw new Error(
    "Backspace reached the page but the focused field did not change — click the field with " +
      "browser_click and look at it with browser_snapshot before trying again",
  );
}

const SCREENSHOT_MAX_WIDTH = 1400;
const SCREENSHOT_QUALITY = 55;

/**
 * The part of the page the tab shows, as the user would see it if they
 * switched to it, frames included: Page.captureScreenshot renders the tab's
 * own compositor frame, so it works on a background tab, and never selects
 * the tab, raises its window or captures the screen (captureVisibleTab only
 * sees the tab in front). Focus emulation (see attach) keeps Chrome drawing
 * the tab. `maxWidth` scales the image down (0 keeps every pixel); the reply
 * gives the page's size in CSS pixels, the space browser_click's x and y use.
 */
async function screenshot(tabId, { format = "png", quality, maxWidth } = {}) {
  if (format !== "png" && format !== "jpeg") throw new Error("format must be png or jpeg");
  if (quality !== undefined && (!Number.isInteger(quality) || quality < 1 || quality > 100)) {
    throw new Error("quality must be an integer from 1 to 100");
  }
  if (maxWidth !== undefined && (!Number.isInteger(maxWidth) || maxWidth < 0)) {
    throw new Error("max_width must be a whole number of pixels (0 keeps full resolution)");
  }
  const limit = Math.min(maxWidth ?? SCREENSHOT_MAX_WIDTH, 8000);
  const view = (await evaluateValue(tabId,
    "({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY, dpr: devicePixelRatio, shown: document.visibilityState === 'visible' })",
    "could not measure the page"));
  if (!(view.width > 0 && view.height > 0)) throw new Error("the page has no size to capture");
  // Chrome captures device pixels; scale so the image is at most `limit` wide.
  const deviceWidth = view.width * (view.dpr || 1);
  const scale = limit > 0 && deviceWidth > limit ? limit / deviceWidth : 1;
  const params = {
    format,
    ...(format === "jpeg" ? { quality: quality ?? SCREENSHOT_QUALITY } : {}),
    ...(scale < 1 ? { clip: { x: view.x, y: view.y, width: view.width, height: view.height, scale } } : {}),
  };
  let res = await send(tabId, "Page.captureScreenshot", params);
  // A tab Chrome is not drawing hands back its last frame, or none; ask once
  // more for it to be shown (#63) and capture again.
  if (!res?.data && await redraw(tabId)) res = await send(tabId, "Page.captureScreenshot", params);
  if (!res?.data) throw new Error(`Chrome returned no image for tab ${tabId}. ${NOT_DRAWN_NOTE}`);
  return {
    data: res.data,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    width: Math.round(deviceWidth * scale),
    height: Math.round(view.height * (view.dpr || 1) * scale),
    cssWidth: view.width,
    cssHeight: view.height,
    scrollX: Math.round(view.x),
    scrollY: Math.round(view.y),
    ...(view.shown ? {} : { note: NOT_DRAWN_NOTE }),
  };
}

// ── attaching files ─────────────────────────────────────────────────────────

/** How many files one browser_upload_file call may attach. */
const UPLOAD_MAX_FILES = 50;
/** DevTools object group for the input's handle, released after every upload. */
const UPLOAD_GROUP = "cu-upload";

/**
 * The file input a snapshot index names, inside the page. Exactly two things
 * stand for one: the input itself (snapshots list it as input[file], hidden
 * or not), and a <label> whose control is one, since sites hide the input
 * behind a styled label. Anything else is refused, a button that opens the
 * picker from script included: nothing ties it to an input, and pressing it
 * would open the native picker. When it holds one listed file input, the
 * refusal names that input's index.
 */
function fileInputTargetInPage(index, dom) {
  const found = dom.byIndex(index);
  if (!found) return { reason: `element ${index} is no longer on the page — call browser_snapshot again` };
  const isFile = (node) => !!node && node.tagName === "INPUT" && node.type === "file";
  if (isFile(found)) return { el: found, via: "input" };
  if (found.tagName === "LABEL" && isFile(found.control)) return { el: found.control, via: "label" };
  const tag = found.tagName.toLowerCase() + (found.tagName === "INPUT" ? "[" + found.type + "]" : "");
  const inner = dom.queryAll(found, "input[type=file]").filter((input) => input.hasAttribute("data-cu-idx"));
  const hint = inner.length === 1 ? ` (it holds file input [${inner[0].getAttribute("data-cu-idx")}]: pass that index)` : "";
  return { reason: `element ${index} is ${tag}, not a file input or a label for one${hint}` };
}

/// The input as a DevTools object, or why the index names none. Run with
/// returnByValue off, so the element comes back as a handle, not a copy. What
/// the index named (the input, or its label) and that element's name are left
/// on the input for fileInputInfoInPage.
const UPLOAD_TARGET_JS = (index) => `(() => {
  const dom = (${pageDomInPage.toString()})();
  const target = (${fileInputTargetInPage.toString()})(${index}, dom);
  if (!target.el) return String(target.reason);
  const named = target.via === 'label' ? dom.byIndex(${index}) : target.el;
  target.el.__cuUploadTarget = { via: target.via, label: (${controlLabelInPage.toString()})(named, dom, false) ||
    (target.via === 'label' ? named.innerText : '') || target.el.getAttribute('name') || '' };
  return target.el;
})()`;

/// Called on the input (`this`): what it is, and a watch for the input and
/// change events Chrome fires when its files are set, so the reply can say
/// whether the page saw them.
function fileInputInfoInPage() {
  const el = this;
  const target = el.__cuUploadTarget || { via: "input", label: "" };
  delete el.__cuUploadTarget;
  el.__cuUploadSeen?.done();
  const seen = { input: false, change: false };
  const listener = (e) => { if (e.target === el) seen[e.type] = true; };
  el.addEventListener("input", listener, true);
  el.addEventListener("change", listener, true);
  seen.done = () => {
    el.removeEventListener("input", listener, true);
    el.removeEventListener("change", listener, true);
  };
  el.__cuUploadSeen = seen;
  return {
    via: target.via,
    label: String(target.label || "").replace(/\s+/g, " ").trim().slice(0, 60),
    multiple: el.multiple,
    disabled: el.matches(":disabled"),
    folder: el.webkitdirectory === true,
  };
}

/// Called on the input after its files were set: what it holds now, read
/// back from the input rather than assumed, and the events the page got.
function fileInputFilesInPage() {
  const el = this;
  const seen = el.__cuUploadSeen;
  seen?.done();
  delete el.__cuUploadSeen;
  return {
    names: Array.from(el.files || [], (file) => file.name),
    input: seen?.input === true,
    change: seen?.change === true,
  };
}

/// Attach local files to a file input by its snapshot index, the way Chrome
/// does when a person picks them: DOM.setFileInputFiles on the input, which
/// fires its input and change events. No picker opens, the tab is not
/// selected and no OS input is sent, and the form is never submitted: the
/// files are only staged in the input. The paths are on the machine running
/// Chrome; the server checked they are regular files before sending them.
async function uploadFiles(tabId, index, paths, access) {
  // The index is spliced into the script that runs in the page, so only a
  // plain snapshot index may reach it.
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("index must be an element index from browser_snapshot");
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > UPLOAD_MAX_FILES ||
      paths.some((path) => typeof path !== "string" || !path)) {
    throw new Error(`paths must list 1 to ${UPLOAD_MAX_FILES} absolute file paths`);
  }
  const frame = await liveFrameForIndex(tabId, index, access);
  // A frame from another site has its own session, and the input's handle
  // belongs to it.
  const session = frame?.session;
  try {
    const found = await evaluateIn(tabId, frame, {
      expression: UPLOAD_TARGET_JS(index), returnByValue: false, objectGroup: UPLOAD_GROUP,
    });
    if (found?.exceptionDetails) throw new Error(found.exceptionDetails.text || "upload failed");
    const handle = found?.result;
    if (handle?.type === "string") throw new Error(`not attached: ${handle.value}`);
    if (handle?.subtype !== "node" || !handle.objectId) throw new Error("upload failed: the page returned no element");
    const call = async (fn) => {
      const res = await send(tabId, "Runtime.callFunctionOn", {
        objectId: handle.objectId, functionDeclaration: fn.toString(), returnByValue: true,
      }, session);
      if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || "upload failed");
      return res?.result?.value || {};
    };
    const info = await call(fileInputInfoInPage);
    const inFrame = frame ? ` in frame "${frame.name || "frame"}"` : "";
    const target = (info.via === "label"
      ? `the file input of [${index}] label${info.label ? ` "${info.label}"` : ""}`
      : describeTarget(index, { tag: "input[file]", label: info.label })) + inFrame;
    const refusal = info.disabled ? "is disabled"
      : info.folder ? "picks a folder (webkitdirectory), not files"
      : paths.length > 1 && !info.multiple
      ? `takes one file (it has no multiple attribute) and ${paths.length} were given; pass one path`
      : null;
    if (refusal) {
      await call(fileInputFilesInPage).catch(() => {});
      throw new Error(`not attached: ${target} ${refusal}. Nothing was changed`);
    }
    await send(tabId, "DOM.setFileInputFiles", { files: paths, objectId: handle.objectId }, session);
    const after = await call(fileInputFilesInPage);
    await markTab(tabId);
    return {
      attached: true,
      target,
      files: after.names || [],
      count: (after.names || []).length,
      events: { input: after.input === true, change: after.change === true },
    };
  } finally {
    try {
      await send(tabId, "Runtime.releaseObjectGroup", { objectGroup: UPLOAD_GROUP }, session);
    } catch {
      // The page navigated or closed; its objects went with it.
    }
  }
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
    // A site that never finishes serving its icon must not hold the task (#56).
    const res = await fetch(href, { signal: AbortSignal.timeout(3000) });
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
  // A page paused behind a dialog cannot run the badge script either.
  if (dialogs.has(tabId)) return;
  try {
    // Decorative, and it runs after every action: a page too busy to take the
    // badge script must not hold the task's queue behind it (#56).
    const [cursor, site] = await withDeadline(Promise.all([inlineCursor(), siteFavicon(tabId)]), "favicon", 4000);
    if (!cursor) return;
    await withDeadline(chrome.scripting.executeScript({
      target: { tabId },
      func: applyFavicon,
      args: [badgeHref(cursor, site)],
    }), "favicon badge", 2000);
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
    await withDeadline(chrome.scripting.executeScript({ target: { tabId }, func: restoreFavicon }), "favicon", 2000);
  } catch {
    // Same injection limits as markTab; the tab is being let go either way.
  }
}

// ── reading, settling, credentials, site rules ──────────────────────────────

const sleep = (ms) => new Promise((resume) => setTimeout(resume, ms));

/** Validate the wait contract before an action can have side effects. */
function validateReadiness(p, action = false) {
  if (p.waitForSelector === undefined && p.waitTimeoutMs === undefined) return;
  if (typeof p.waitForSelector !== "string" || !p.waitForSelector.trim() || p.waitForSelector.length > 2000) {
    throw new Error("wait_for_selector must be a nonempty CSS selector (at most 2000 characters)");
  }
  if (testsValueAttribute(p.waitForSelector)) {
    throw new Error("wait_for_selector cannot test an element's value attribute");
  }
  if (action && p.returnState !== true) throw new Error("wait_for_selector requires return_state=true on actions");
  if (p.waitTimeoutMs !== undefined && (!Number.isInteger(p.waitTimeoutMs) || p.waitTimeoutMs < 0 || p.waitTimeoutMs > 10000)) {
    throw new Error("wait_timeout_ms must be an integer from 0 to 10000");
  }
}

/**
 * Whether a selector reads the `value` attribute. React mirrors a controlled
 * input's value into it, password fields included, so a wait on
 * `input[type=password][value^="a"]` would answer met/timeout one guessed
 * character at a time — the password the agent is never meant to see.
 * Escapes and comments are undone first, so `[\76 alue]` is caught too.
 */
function testsValueAttribute(selector) {
  const plain = selector
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
    })
    .replace(/\\([\s\S])/g, "$1");
  return /\[\s*(?:[\w*-]*\|)?value\s*(?:[~|^$*]?=|\])/i.test(plain);
}

/**
 * A visible match in the top-level document or an open shadow root inside it,
 * not arbitrary application readiness. A selector is matched within each
 * root, so it cannot name a host and something in its shadow tree at once.
 * Child frames are not searched; `frames` counts the visible ones so a
 * timeout can say so.
 */
function visibleSelectorInPage(selector, visible, dom) {
  let matches;
  try {
    matches = dom.queryAll(document, selector);
  } catch {
    return { error: "invalid CSS selector" };
  }
  if (matches.some(visible)) return { met: true };
  const shown = document.visibilityState === "visible";
  const frames = dom.queryAll(document, "iframe,frame").filter((frame) => {
    const r = frame.getBoundingClientRect();
    return r.width >= 100 && r.height >= 40 && visible(frame);
  }).length;
  return { met: false, frames, shown };
}

/**
 * The selector in the tab's frames: met in the first frame showing a match
 * (with its name), else how many frames could not be searched (gone, or not
 * allowed by the user's site rules).
 */
async function selectorInFrames(p) {
  if (!(await hasChildFrames(p.tabId))) return { met: false, unread: 0 };
  let unread = 0;
  for (const frame of await tabFrames(p.tabId)) {
    if (frame.main) continue;
    if (!frameAllowed(p, frame.url)) {
      unread++;
      continue;
    }
    try {
      const res = await evaluateIn(p.tabId, frame, {
        expression: `(${visibleSelectorInPage.toString()})(${JSON.stringify(p.waitForSelector)}, ${isElementVisibleInPage.toString()}, (${pageDomInPage.toString()})())`,
        returnByValue: true,
      });
      const value = res?.result?.value;
      if (value?.met === true) return { met: true, frame: await nameOfFrame(p.tabId, frame) };
    } catch (error) {
      if (error?.dialog) throw error;
      unread++;
    }
  }
  return { met: false, unread };
}

/** Poll an explicit condition, including delayed same-document rendering. */
async function waitForReadiness(p) {
  validateReadiness(p);
  const start = Date.now();
  const deadline = start + (p.waitTimeoutMs ?? 8000);
  const outcome = (status, extra = {}) => ({
    status, condition: "visible_selector", selector: p.waitForSelector,
    elapsedMs: Date.now() - start, ...extra,
  });
  let redrawn = false;
  while (true) {
    // Recheck on every observation: the action or a redirect may leave the
    // allowed site during the wait. Never evaluate selectors on a blocked page.
    await checkTab(requireClientId(p), p.tabId, p.sites, "read");
    // An explicit DOM condition is independent of document/resource loading.
    // In particular, a slow image must not hide an already-rendered dialog.
    let res;
    try {
      res = await send(p.tabId, "Runtime.evaluate", {
        expression: `(${visibleSelectorInPage.toString()})(${JSON.stringify(p.waitForSelector)}, ${isElementVisibleInPage.toString()}, (${pageDomInPage.toString()})())`,
        returnByValue: true,
      });
    } catch (error) {
      // Nothing renders while a dialog is open; waiting longer cannot help.
      if (error?.dialog) {
        return outcome("error", { error: `the page is paused behind JavaScript ${error.dialog.type} dialog ${error.dialog.id}` });
      }
      // A navigation committing mid-wait destroys the execution context; the
      // new document is the one to observe, so poll again until the deadline.
      if (Date.now() >= deadline) return outcome("error", { error: error.message || "evaluate failed" });
      await sleep(Math.min(100, deadline - Date.now()));
      continue;
    }
    if (res?.exceptionDetails) return outcome("error", { error: res.exceptionDetails.text || "evaluate failed" });
    const value = res?.result?.value;
    if (value?.error) return outcome("error", { error: value.error });
    if (value?.met === true) return outcome("met");
    // Not on the page itself: a support chat or an embedded form renders in
    // a frame, which is its own document.
    let inFrames = { met: false, unread: 0 };
    if (!value?.error) {
      try {
        inFrames = await selectorInFrames(p);
      } catch (error) {
        if (error?.dialog) {
          return outcome("error", { error: `the page is paused behind JavaScript ${error.dialog.type} dialog ${error.dialog.id}` });
        }
      }
    }
    if (inFrames.met) return outcome("met", { frame: inFrames.frame });
    // Nothing waiting for a frame runs on a page Chrome is not drawing; ask
    // once more for it to be shown, then keep polling (#63).
    if (value?.shown === false && !redrawn && Date.now() < deadline) {
      redrawn = true;
      await redraw(p.tabId);
      continue;
    }
    if (Date.now() >= deadline) {
      return outcome("timeout", {
        ...(inFrames.unread ? { frames: inFrames.unread } : {}),
        ...(value?.shown === false ? { note: NOT_DRAWN_NOTE } : {}),
      });
    }
    await sleep(Math.min(100, deadline - Date.now()));
  }
}

/** Navigation settling is only a heuristic; tab.complete says nothing about SPAs. */
async function settle(tabId, pauseMs = 350, loadBudgetMs = 8000) {
  const start = Date.now();
  await sleep(pauseMs);
  const deadline = Date.now() + loadBudgetMs;
  while (true) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== "loading") return { status: "not_requested", condition: "document_load", elapsedMs: Date.now() - start };
    if (Date.now() >= deadline) return { status: "timeout", condition: "document_load", elapsedMs: Date.now() - start };
    await sleep(Math.min(150, deadline - Date.now()));
  }
}

/** Attach current state and separate action success from readiness/timeout. */
async function withState(p, result) {
  // A dialog the page opened just after the action returned still pauses it.
  const pending = dialogs.get(p.tabId);
  if (pending && !result?.jsDialog) result = openedDialog(pending, result);
  if (p.returnState !== true) return result;
  const readiness = p.waitForSelector !== undefined ? await waitForReadiness(p) : await settle(p.tabId);
  await checkTab(requireClientId(p), p.tabId, p.sites, "read");
  return { ...result, readiness, snapshot: await snapshot(p.tabId, { access: p }) };
}

/**
 * The page's readable text, run inside the page. Headings are marked with `#`
 * so the model can see the structure; everything else is innerText, which
 * respects CSS visibility and includes content scrolled out of view.
 */
function readPageInPage(includeLinks, dom) {
  const root = document.body;
  const out = { title: document.title, url: location.href, text: "", links: [] };
  if (!root) return out;
  const heads = new Map();
  for (const h of dom.queryAll(root, "h1,h2,h3,h4,h5,h6")) {
    const t = (h.innerText || "").replace(/\s+/g, " ").trim();
    if (t && !heads.has(t)) heads.set(t, Number(h.tagName[1]));
  }
  // innerText stops at shadow roots, so a web component's own text (a dialog
  // rendered inside one) follows the page's: one block per open shadow root,
  // from its rendered children only (a hidden one's innerText is its source).
  const blocks = [root.innerText || ""];
  for (const host of dom.queryAll(root, "*")) {
    if (!host.shadowRoot) continue;
    const shown = [...host.shadowRoot.children].filter((child) =>
      child.checkVisibility ? child.checkVisibility() : child.getClientRects().length > 0);
    const text = shown.map((child) => child.innerText || "").join("\n").trim();
    if (text) blocks.push(text);
  }
  const lines = [];
  for (const raw of blocks.join("\n\n").split("\n")) {
    const line = raw.replace(/[ \t ]+/g, " ").trim();
    if (!line) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    const level = heads.get(line);
    lines.push(level ? "#".repeat(level) + " " + line : line);
  }
  out.text = lines.join("\n").trim();
  out.shown = document.visibilityState === "visible";
  // No shown text: count the text the page holds but does not show (hidden
  // by CSS), so an empty read can say the page is not empty.
  if (!out.text) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest("script,style,noscript,template")
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let held = 0;
    for (let node = walker.nextNode(); node && held < 1e6; node = walker.nextNode()) held += node.data.trim().length;
    if (held) out.unshown = held;
  }
  if (includeLinks) {
    const seen = new Set();
    for (const a of dom.queryAll(root, "a[href]")) {
      const href = a.href;
      if (!/^https?:/.test(href) || seen.has(href)) continue;
      const label = (a.innerText || a.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 90);
      if (!label) continue;
      seen.add(href);
      out.links.push({ text: label, href });
      if (out.links.length >= 150) break;
    }
  }
  return out;
}

/**
 * Keep the lines that mention `query`, each with its neighbours and the
 * nearest heading above it, so a match still says which section it is from.
 */
function focusText(text, query) {
  const needle = query.trim().toLowerCase();
  const lines = text.split("\n");
  const keep = new Set();
  let matches = 0;
  lines.forEach((line, index) => {
    if (!line.toLowerCase().includes(needle)) return;
    matches++;
    for (let j = index - 1; j <= index + 1; j++) if (j >= 0 && j < lines.length) keep.add(j);
    for (let j = index - 1; j >= 0; j--) {
      if (lines[j].startsWith("#")) {
        keep.add(j);
        break;
      }
    }
  });
  const out = [];
  let last = -2;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index !== last + 1 && out.length) out.push("…");
    if (lines[index] !== "" || (out.length && out[out.length - 1] !== "…")) out.push(lines[index]);
    last = index;
  }
  return { text: out.join("\n").trim(), matches };
}

const READ_DEFAULT_CHARS = 20000;
const READ_MAX_CHARS = 200000;

/**
 * The text of each shown frame the user's site rules allow, in document
 * order, read the way the page is. `unread` counts the shown frames that
 * could not be read (gone mid-read, or not allowed).
 */
async function frameTexts(tabId, includeLinks, access) {
  if (!(await hasChildFrames(tabId))) return { sections: [], unread: 0 };
  let frames;
  try {
    frames = await placedFrames(tabId);
  } catch {
    return { sections: [], unread: 0 };
  }
  const sections = [];
  let unread = 0;
  for (const frame of frames) {
    if (frame.main || (!frame.reachable && !frame.unknown)) continue;
    if (!frame.reachable || !frameAllowed(access, frame.url)) {
      unread++;
      continue;
    }
    try {
      const res = await evaluateIn(tabId, frame, {
        expression: `(${readPageInPage.toString()})(${includeLinks === true}, (${pageDomInPage.toString()})())`,
        returnByValue: true,
      });
      if (res?.exceptionDetails) throw new Error("unreadable");
      const value = res?.result?.value || {};
      if (value.text) sections.push({ name: frameName(frame, value.title), text: value.text, links: value.links || [] });
    } catch {
      unread++;
    }
  }
  return { sections, unread };
}

async function readPage(tabId, { query, maxChars, offset, includeLinks, access } = {}) {
  const take = async () => {
    const res = await send(tabId, "Runtime.evaluate", {
      expression: `(${readPageInPage.toString()})(${includeLinks === true}, (${pageDomInPage.toString()})())`,
      returnByValue: true,
    });
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || "could not read the page");
    return res.result.value || {};
  };
  let page = await take();
  // No text on a page Chrome is not drawing: ask once more for it to be
  // shown and read again (#63).
  if (!page.text && page.shown === false && await redraw(tabId)) page = await take();
  // Text in frames (a support chat, an embedded form) follows the page's,
  // each under a line naming its frame.
  const { sections, unread } = await frameTexts(tabId, includeLinks, access);
  for (const section of sections) {
    const heading = `[frame "${section.name}"]`;
    page.text = page.text ? `${page.text}\n\n${heading}\n${section.text}` : `${heading}\n${section.text}`;
    if (includeLinks === true) {
      const seen = new Set((page.links || []).map((link) => link.href));
      for (const link of section.links) {
        if ((page.links || []).length >= 150) break;
        if (seen.has(link.href)) continue;
        seen.add(link.href);
        (page.links ||= []).push(link);
      }
    }
  }
  let note;
  if (!page.text) {
    if (page.shown === false) note = NOT_DRAWN_NOTE;
    else if (page.unshown) {
      note = `the page holds about ${page.unshown} characters of text, but none of it is shown (hidden by CSS). ` +
        "It may still be loading or behind a closed panel: wait_for_selector on what you expect, then read again";
    }
  }
  let text = page.text || "";
  let matches;
  if (typeof query === "string" && query.trim()) {
    ({ text, matches } = focusText(text, query));
  }
  const limit = Math.min(Math.max(Number.isInteger(maxChars) ? maxChars : READ_DEFAULT_CHARS, 1), READ_MAX_CHARS);
  const start = Math.min(Math.max(Number.isInteger(offset) ? offset : 0, 0), text.length);
  const end = Math.min(start + limit, text.length);
  return {
    title: page.title,
    url: page.url,
    text: text.slice(start, end),
    offset: start,
    end,
    total: text.length,
    ...(matches === undefined ? {} : { matches }),
    ...(includeLinks === true ? { links: page.links || [] } : {}),
    ...(note ? { note } : {}),
    ...(sections.length ? { framesRead: sections.length } : {}),
    ...(unread ? { frames: unread } : {}),
  };
}

// Site rules. The server reads the user's policy file and passes its `sites`
// rules with every call; this side enforces them because only the extension
// knows which page a tab is on at the moment of the action.

/** Most specific matching rule for a URL: "allow", "ask" or "block". */
function siteRule(rules, url) {
  if (!Array.isArray(rules) || rules.length === 0) return "allow";
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "allow";
    // "bank.example." is the same site as "bank.example"; a trailing dot must
    // not take a host out from under its rule.
    host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "allow";
  }
  let best = null;
  for (const entry of rules) {
    if (!entry || typeof entry.pattern !== "string") continue;
    const pattern = entry.pattern.trim().toLowerCase().replace(/^\*\./, "").replace(/\.+$/, "");
    const matches = pattern === "*" || host === pattern || host.endsWith("." + pattern);
    if (!matches) continue;
    const specificity = pattern === "*" ? 0 : pattern.length;
    if (!best || specificity > best.specificity) best = { rule: entry.rule, specificity };
  }
  return best && ["allow", "ask", "block"].includes(best.rule) ? best.rule : "allow";
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url);
  }
}

/** clientId → origins the user approved for that task, for "ask" rules. */
const approvedOrigins = new Map();

async function checkSite(clientId, url, rules, action) {
  const rule = siteRule(rules, url);
  if (rule === "allow") return;
  const origin = originOf(url);
  if (rule === "block") {
    throw new Error(`${origin} is blocked by the user's Computer Use policy — do not try to reach it another way`);
  }
  if (approvedOrigins.get(clientId)?.has(origin)) return;
  const answer = await askUser({ kind: "approve", origin, action });
  if (answer.approved !== true) {
    throw new Error(
      answer.timedOut
        ? `the user did not answer the request to use ${origin}; ask them in the conversation before retrying`
        : `the user declined to let the agent use ${origin}`,
    );
  }
  if (!approvedOrigins.has(clientId)) approvedOrigins.set(clientId, new Set());
  approvedOrigins.get(clientId).add(origin);
}

/**
 * Whether the user's site rules let the agent into a frame on a page it may
 * use: the frame's site is allowed, or it is under an "ask" rule this task was
 * already approved for. A frame never puts a prompt in front of the user; one
 * that would need it is left out, and a blocked one always is.
 */
function frameAllowed(access, url) {
  const rule = siteRule(access?.sites, url);
  if (rule === "allow") return true;
  return rule === "ask" && approvedOrigins.get(access?.clientId)?.has(originOf(url)) === true;
}

/** Check the page a tab is showing right now, for commands that act on a tab. */
async function checkTab(clientId, tabId, rules, action) {
  if (!Array.isArray(rules) || rules.length === 0) return;
  const tab = await chrome.tabs.get(tabId);
  await checkSite(clientId, tab.pendingUrl || tab.url || "", rules, action);
}

// Prompts the user answers in a small extension window: approving a site under
// an "ask" rule, and typing credentials the model must never see. The window
// shows the origin Chrome reports for the tab, not anything the model wrote.

const PROMPT_PAGE = "prompt.html";
const PROMPT_TIMEOUT_MS = 120000;
/** promptId → { spec, resolve, windowId, timer } */
const prompts = new Map();
let nextPromptId = 1;

function finishPrompt(id, answer) {
  const entry = prompts.get(id);
  if (!entry) return;
  prompts.delete(id);
  clearTimeout(entry.timer);
  if (entry.windowId !== null) chrome.windows?.remove(entry.windowId).catch(() => {});
  entry.resolve(answer);
}

async function askUser(spec, timeoutMs = PROMPT_TIMEOUT_MS) {
  const id = String(nextPromptId++);
  const answer = new Promise((resolve) => {
    prompts.set(id, { spec, resolve, windowId: null, timer: null });
  });
  const entry = prompts.get(id);
  entry.timer = setTimeout(() => finishPrompt(id, { timedOut: true }), timeoutMs);
  try {
    // A first guess; the page grows its window to fit once it has rendered.
    const height = spec.kind === "credentials" ? 330 + 64 * (spec.fields?.length ?? 1) : 300;
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`${PROMPT_PAGE}#${id}`),
      type: "popup",
      width: 440,
      height: Math.min(height, 720),
      focused: true,
    });
    if (prompts.has(id)) entry.windowId = win?.id ?? null;
    else if (win?.id !== undefined) chrome.windows.remove(win.id).catch(() => {});
  } catch (error) {
    finishPrompt(id, { failed: String(error?.message ?? error) });
  }
  return answer;
}

chrome.windows?.onRemoved?.addListener((windowId) => {
  for (const [id, entry] of prompts) {
    if (entry.windowId === windowId) finishPrompt(id, { cancelled: true });
  }
});

// Only the extension's own prompt page may read or answer a prompt. A content
// script runs inside a web page, and its sender.url is that page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("cu-prompt-")) return;
  if (!String(sender?.url ?? "").startsWith(chrome.runtime.getURL(PROMPT_PAGE))) return;
  const entry = prompts.get(String(msg.id));
  if (msg.type === "cu-prompt-init") {
    sendResponse(entry ? entry.spec : null);
    return;
  }
  if (!entry) return;
  if (msg.type === "cu-prompt-answer") {
    if (entry.spec.kind === "credentials" && msg.approved === true) {
      const values = {};
      for (const field of entry.spec.fields) {
        const value = msg.values?.[field.index];
        if (typeof value === "string") values[field.index] = value;
      }
      finishPrompt(String(msg.id), { approved: true, values });
    } else {
      finishPrompt(String(msg.id), { approved: msg.approved === true, cancelled: msg.approved !== true });
    }
  }
});

/** Describe snapshot elements by index, inside the page, for the credential prompt. */
function describeFieldsInPage(indices, dom) {
  return indices.map((index) => {
    const el = dom.byIndex(index);
    if (!el) return { index, found: false };
    const byId = el.id ? el.getRootNode().querySelector?.(`label[for="${CSS.escape(el.id)}"]`) : null;
    const label = (el.getAttribute("aria-label") || byId?.innerText || el.closest("label")?.innerText ||
      el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("autocomplete") || "")
      .replace(/\s+/g, " ").trim().slice(0, 60);
    const editable = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
    return { index, found: true, editable, type: el.tagName === "INPUT" ? el.type : el.tagName.toLowerCase(), label };
  });
}

/**
 * Put values into snapshot elements the way typing would, so frameworks that
 * listen for input events (React, Vue) see the change. Runs inside the page.
 */
function fillFieldsInPage(entries, dom) {
  const filled = [];
  const missing = [];
  for (const { index, value } of entries) {
    const el = dom.byIndex(index);
    if (!el) {
      missing.push(index);
      continue;
    }
    el.focus();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else {
      missing.push(index);
      continue;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filled.push(index);
  }
  return { filled, missing };
}

const CREDENTIAL_KINDS = ["username", "email", "password", "code", "text"];
const CREDENTIAL_TIMEOUT_MS = 180000;
const CREDENTIAL_MAX_TIMEOUT_MS = 600000;

async function requestCredentials(clientId, p) {
  const fields = Array.isArray(p.fields) ? p.fields : [];
  if (fields.length === 0 || fields.length > 6) {
    throw new Error("fields must list 1 to 6 inputs by their browser_snapshot index");
  }
  const indices = fields.map((field) => field?.index);
  if (!indices.every((index) => Number.isInteger(index) && index >= 0)) {
    throw new Error("each field needs an index from browser_snapshot");
  }
  if (new Set(indices).size !== indices.length) throw new Error("each field index may appear once");
  // The prompt names the tab's site, and the user decides on that. A field in
  // an embedded frame can belong to another site, so it is never filled here.
  const framed = indices.filter((index) => frameForIndex(p.tabId, index));
  if (framed.length) {
    throw new Error(
      `element ${framed.join(", ")} is inside an embedded frame. browser_request_credentials fills only the ` +
        "page's own fields, because its prompt names the page's site and a frame can be another site's; " +
        "ask the user to sign in in that frame themselves",
    );
  }
  const tab = await chrome.tabs.get(p.tabId);
  const url = tab.url || "";
  const described = await send(p.tabId, "Runtime.evaluate", {
    expression: `(${describeFieldsInPage.toString()})(${JSON.stringify(indices)}, (${pageDomInPage.toString()})())`,
    returnByValue: true,
  });
  if (described?.exceptionDetails) throw new Error("could not inspect the page's fields");
  const info = described.result.value || [];
  const lost = info.filter((field) => !field.found).map((field) => field.index);
  if (lost.length) throw new Error(`element ${lost.join(", ")} is no longer on the page — call browser_snapshot again`);
  const readOnly = info.filter((field) => !field.editable).map((field) => field.index);
  if (readOnly.length) throw new Error(`element ${readOnly.join(", ")} is not a text field`);
  const spec = {
    kind: "credentials",
    origin: originOf(url),
    secure: url.startsWith("https:") || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url),
    reason: typeof p.reason === "string" ? p.reason.slice(0, 300) : "",
    fields: fields.map((field, position) => {
      const page = info[position];
      const kind = CREDENTIAL_KINDS.includes(field.kind)
        ? field.kind
        : page.type === "password" ? "password" : page.type === "email" ? "email" : "text";
      return { index: field.index, kind, label: page.label, pageType: page.type };
    }),
  };
  const timeout = Math.min(
    Math.max(Number.isFinite(p.timeoutMs) ? p.timeoutMs : CREDENTIAL_TIMEOUT_MS, 10000),
    CREDENTIAL_MAX_TIMEOUT_MS,
  );
  const answer = await askUser(spec, timeout);
  if (answer.approved !== true) {
    return {
      origin: spec.origin,
      cancelled: answer.cancelled === true,
      timedOut: answer.timedOut === true,
      failed: answer.failed,
    };
  }
  // The page may have navigated while the user typed. Never fill a different site.
  const now = await chrome.tabs.get(p.tabId);
  if (originOf(now.url || "") !== spec.origin) {
    throw new Error(`the tab left ${spec.origin} while the user was typing; nothing was filled`);
  }
  const entries = spec.fields
    .filter((field) => typeof answer.values[field.index] === "string")
    .map((field) => ({ index: field.index, value: answer.values[field.index] }));
  const res = await send(p.tabId, "Runtime.evaluate", {
    expression: `(${fillFieldsInPage.toString()})(${JSON.stringify(entries)}, (${pageDomInPage.toString()})())`,
    returnByValue: true,
    userGesture: true,
  });
  if (res?.exceptionDetails) throw new Error("could not fill the fields");
  await markTab(p.tabId);
  const outcome = res.result.value || { filled: [], missing: [] };
  return { origin: spec.origin, filled: outcome.filled, missing: outcome.missing };
}

// ── dispatch ────────────────────────────────────────────────────────────────

const handlers = {
  ping: async () => ({ pong: true }),
  open_tab: async (p) => {
    const clientId = requireClientId(p);
    if (p.url) await checkSite(clientId, p.url, p.sites, "open");
    return openTab(clientId, p.url);
  },
  list_tabs: async (p) => listTabs(requireClientId(p), p.all === true),
  use_tab: async (p) => {
    const clientId = requireClientId(p);
    await checkTab(clientId, p.tabId, p.sites, "take over");
    return adoptTab(clientId, p.tabId);
  },
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
    // looking at an agent tab; otherwise the tab stays in the background and
    // the reply says so (#43). `bringToFront` is the explicit opt-in for the
    // cases that need the tab truly shown (native keyboard input, screenshot):
    // it activates the tab and raises its window.
    const target = await chrome.tabs.get(p.tabId);
    const [active] = await chrome.tabs.query({ active: true, windowId: target.windowId });
    const alreadyActive = active?.id === p.tabId;
    const userIsOnAgentTab = active?.id !== undefined && tabOwner.get(active.id) === clientId;
    const force = p.bringToFront === true;
    if (!alreadyActive && (force || userIsOnAgentTab)) {
      await chrome.tabs.update(p.tabId, { active: true });
    }
    if (force) await chrome.windows.update(target.windowId, { focused: true });
    const [now] = await chrome.tabs.query({ active: true, windowId: target.windowId });
    return {
      tabId: p.tabId,
      activated: now?.id === p.tabId,
      windowFocused: force,
      userTabActive: !(now?.id !== undefined && tabOwner.get(now.id) === clientId),
    };
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
    validateReadiness(p, true);
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    // Navigating closes an open dialog as dismissed (checked on Chrome 151), so
    // a confirm or an "unsaved changes" prompt would be answered without anyone
    // deciding to. The agent answers it first, explicitly.
    if (dialogs.has(p.tabId)) throw dialogPendingError(p.tabId, dialogs.get(p.tabId));
    await checkSite(clientId, p.url, p.sites, "open");
    return withState(p, await navigate(p.tabId, p.url));
  },
  snapshot: async (p) => {
    validateReadiness(p);
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "read");
    const readiness = p.waitForSelector !== undefined ? await waitForReadiness(p) : undefined;
    await checkTab(clientId, p.tabId, p.sites, "read");
    const state = await snapshot(p.tabId, { offset: p.offset, limit: p.limit, access: p });
    return readiness ? { ...state, readiness } : state;
  },
  read: async (p) => {
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "read");
    return readPage(p.tabId, { query: p.query, maxChars: p.maxChars, offset: p.offset, includeLinks: p.includeLinks, access: p });
  },
  click: async (p) => {
    validateReadiness(p, true);
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "click in");
    noteAgentInput(clientId, p.tabId);
    const result = p.index !== undefined ? await clickElement(p.tabId, p.index, p) : await clickAt(p.tabId, p.x, p.y);
    return withState(p, result);
  },
  type: async (p) => {
    validateReadiness(p, true);
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "type in");
    return withState(p, await typeText(p.tabId, p.text));
  },
  press: async (p) => {
    validateReadiness(p, true);
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "press keys in");
    noteAgentInput(clientId, p.tabId);
    return withState(p, await pressKey(p.tabId, p.key, p.modifiers));
  },
  fill: async (p) => {
    validateReadiness(p, true);
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "type in");
    noteAgentInput(clientId, p.tabId);
    return withState(p, await fillElement(p.tabId, p.index, p.text, p));
  },
  upload_file: async (p) => {
    validateReadiness(p, true);
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "upload files to");
    noteAgentInput(clientId, p.tabId);
    return withState(p, await uploadFiles(p.tabId, p.index, p.paths, p));
  },
  screenshot: async (p) => {
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "look at");
    return screenshot(p.tabId, { format: p.format, quality: p.quality, maxWidth: p.maxWidth });
  },
  handle_dialog: async (p) => {
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "answer a dialog on");
    return handleDialog(p.tabId, { action: p.action, promptText: p.promptText, dialogId: p.dialogId });
  },
  page_errors: async (p) => {
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "read");
    // Watching for failed requests starts when the agent attaches. A tab it has
    // not attached to yet (just taken over, or never acted on) is attached now;
    // that reads nothing from the page and does not navigate, reload or show
    // the tab. What Log.enable replays arrives during the Runtime replay wait.
    const fresh = !attached.has(p.tabId);
    if (fresh) await withDeadline(attach(p.tabId), "attaching to the tab");
    return pageProblems(p.tabId, fresh);
  },
  request_credentials: async (p) => {
    const clientId = requireClientId(p);
    assertOwned(clientId, p.tabId);
    await checkTab(clientId, p.tabId, p.sites, "sign in to");
    return requestCredentials(clientId, p);
  },
};

async function handleCommand(msg, replyPort) {
  await ensureStateReady();
  const { id, command, params: raw = {} } = msg || {};
  // MCP clients may send null for an optional argument they did not set, and
  // the hosts pass it through; null means absent everywhere below.
  const params = Object.fromEntries(Object.entries(raw ?? {}).filter(([, value]) => value !== null));
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
    // Queued behind a command that is stuck, this call would only time out in
    // turn, minutes of identical timeouts with no cause given (#56). Say which
    // command holds the task instead, at once.
    const busy = running.get(clientId);
    if (busy && Date.now() - busy.since > STUCK_COMMAND_MS && prompts.size === 0) {
      throw new Error(
        `not started: this task's earlier ${busy.command} has been waiting on Chrome for ` +
          `${Math.round((Date.now() - busy.since) / 1000)} s and still holds the task. The extension is ` +
          "connected; that tab's page is not answering. Try again shortly, or use another session_id for other work",
      );
    }
    const state = clientState(clientId);
    state.processId = processId;
    state.sessionId = sessionId ?? null;
    const result = await enqueue(clientId, async () => {
      // A preceding cleanup may have removed the state while this waited.
      Object.assign(clientState(clientId), { processId, sessionId: sessionId ?? null });
      const entry = { command, since: Date.now() };
      running.set(clientId, entry);
      try {
        return await handler({ ...params, clientId });
      } finally {
        if (running.get(clientId) === entry) running.delete(clientId);
      }
    });
    reply(replyPort, id, result);
  } catch (e) {
    replyError(replyPort, id, e && e.message ? e.message : e);
  }
}

chrome.tabs.onCreated.addListener(claimChildTab);

chrome.tabs.onRemoved.addListener((tabId) => {
  siteFavicons.delete(tabId);
  agentInputAt.delete(tabId);
  forgetPage(tabId);
  forgetFrames(tabId);
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
