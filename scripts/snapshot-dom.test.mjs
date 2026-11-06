#!/usr/bin/env node
// Real Chromium regression, dependency-free CDP; never uses the user's profile.
// node scripts/snapshot-dom.test.mjs --chrome <Chrome for Testing binary>
// Add --source <background.js> to run against a baseline; --suite snapshot or
// --suite readiness isolates either root-cause regression. Default: both.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const suite = option("--suite") || "all";
assert.ok(["all", "snapshot", "readiness", "shadow", "background", "audit-r1", "audit-r2", "audit-r3"].includes(suite), "invalid --suite");
const chromePath = option("--chrome");
if (!chromePath) throw new Error("provide --chrome <Chrome for Testing binary>");
if (suite === "all" || suite === "audit-r3") {
  // Exercise the actual profile-root declaration without creating a profile or
  // writing into the checkout, even when testing the pre-fix runner.
  const runner = fs.readFileSync(option("--runner-source") || fileURLToPath(import.meta.url), "utf8");
  const declaration = runner.split(String.fromCharCode(10)).find((line) => line.startsWith("const scratch ="));
  assert.ok(declaration, "missing scratch declaration");
  for (const env of [{}, { TMPDIR: "designated-scratch" }]) {
    const actual = vm.runInNewContext(declaration + "; scratch", {
      process: { env }, path, root, os: { tmpdir: () => "system-temp-fixture" },
    });
    assert.equal(actual, env.TMPDIR || "system-temp-fixture", "profile fallback must be outside the checkout");
  }
  console.log("PASS scratch override and absent-TMPDIR fallback stay outside the checkout");
  if (suite === "audit-r3") process.exit(0);
}
const scratch = process.env.TMPDIR || os.tmpdir();
fs.mkdirSync(scratch, { recursive: true });
const profile = fs.mkdtempSync(path.join(scratch, "snapshot-dom-"));
const chrome = spawn(chromePath, [
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  "about:blank",
], { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
let chromeLog = "";
chrome.stderr.on("data", (chunk) => (chromeLog += chunk));
chrome.on("error", (error) => (chromeLog += error.message));
let socket;
try {
  let port;
  for (let n = 0; n < 100; n++) {
    try {
      port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      break;
    } catch {}
    if (!chrome.pid || chrome.exitCode !== null || chrome.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(port, `Chromium did not start:\n${chromeLog}`);
  // DevTools publishes its port before the initial page target is ready.
  let target;
  for (let n = 0; n < 100 && !target; n++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(target, `Chromium did not publish a page target:\n${chromeLog}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(event.data);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  async function command(method, params) {
    const current = ++id;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(current);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      pending.set(current, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
    socket.send(JSON.stringify({ id: current, method, params }));
    const reply = await result;
    assert.ok(!reply.error, JSON.stringify(reply));
    return reply.result;
  }
  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result));
    return result.result.value;
  }
  const source = fs.readFileSync(option("--source") || path.join(root, "chrome-extension/background.js"), "utf8").split(String.fromCharCode(13)).join("");
  const start = source.includes("function isElementVisibleInPage(") ? "function isElementVisibleInPage(" : "const SNAPSHOT_JS =";
  const declaration = source.slice(source.indexOf(start), source.indexOf("\nasync function snapshot("));
  const expression = vm.runInNewContext(declaration + "\nSNAPSHOT_JS");
  // The in-page press a background tab gets (CLICK_JS before 0.9.2).
  const [clickName, clickEnd] = source.includes("const CLICK_EVENTS_JS =")
    ? ["CLICK_EVENTS_JS", "\nasync function evaluateValue("]
    : ["CLICK_JS", "\n/// Click a snapshotted element"];
  const clickDeclaration = source.slice(source.indexOf(`const ${clickName} =`), source.indexOf(clickEnd));
  // The shadow-root-aware lookups the page scripts share (none before #46).
  const domDeclaration = source.includes("function pageDomInPage(")
    ? source.slice(source.indexOf("function pageDomInPage("), source.indexOf("\n/// A compact outline")) : "";
  const domArgument = domDeclaration ? `, (${vm.runInNewContext(domDeclaration + "; pageDomInPage").toString()})()` : "";
  const click = vm.runInNewContext(domDeclaration + clickDeclaration + `\n${clickName}`);
  const snapshot = (options = {}) => evaluate(expression.slice(0, -2) + `(${JSON.stringify(options)})`);
  const set = (html) => evaluate(`document.body.innerHTML = ${JSON.stringify(html)}; true`);
  const buttons = (count, prefix = "Background") => Array.from({ length: count }, (_, i) => `<button>${prefix} ${i}</button>`).join("");
  if (suite === "all" || suite === "snapshot") {
    await set(`<main aria-hidden="true">${buttons(260)}</main><div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white"><input aria-label="Domain"><button>Next</button><button>Verify</button></div>`);
    const modal = await snapshot();
    console.log(`original reproduction: ${modal.elements.length} controls; labels=${modal.elements.slice(0, 3).map((el) => el.label).join(", ")}`);
    assert.deepEqual(modal.elements.map((el) => el.label), ["Domain", "Next", "Verify"]);
    assert.equal(modal.scope, "modal");
    console.log("PASS appended modal excludes 260 hidden background controls");
    // Keep evaluating the original target after activating a different tab.
    const foreground = await command("Target.createTarget", { url: "about:blank" });
    await command("Target.activateTarget", { targetId: foreground.targetId });
    assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Domain", "Next", "Verify"]);
    console.log("PASS modal snapshot works in a background tab");

    await set(`${buttons(260)}<div role="dialog" style="position:fixed;inset:0;background:white"><button>Foreground</button></div>`);
    assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Foreground"]);
    console.log("PASS modal budget excludes ordinary covered background");

    await set('<div role="dialog" style="position:fixed;inset:0;z-index:20;background:white"><button>Top</button></div><div role="dialog" style="position:fixed;inset:0;z-index:10;background:white"><button>Under</button></div>');
    assert.equal((await snapshot()).elements[0].label, "Top");
    await evaluate('document.body.innerHTML += \'<dialog><button>Native top layer</button></dialog>\'; document.querySelector("dialog").showModal(); true');
    assert.equal((await snapshot()).elements[0].label, "Native top layer");
    await evaluate('document.querySelector("dialog").innerHTML += \'<div role="alertdialog" style="position:fixed;inset:100px;background:white"><button>Nested native</button></div>\'; true');
    assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Nested native"]);
    console.log("PASS painted stacking and native modal top layer");

    await set('<div inert><dialog><button>Escaped inert</button><span inert><button>Still inert</button></span></dialog></div><button>Background</button>');
    await evaluate('document.querySelector("dialog").showModal(); true');
    assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Escaped inert"]);
    console.log("PASS native modal escapes ancestor inertness, not explicit descendant inertness");

    await set('<button>Page action</button><dialog open><button>Modeless</button></dialog>');
    assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Page action", "Modeless"]);
    await set('<button>Page action</button><div role="dialog" aria-modal="false"><button>Explicitly nonmodal</button></div>');
    assert.equal((await snapshot()).scope, "page");
    assert.equal((await snapshot()).total, 2);
    console.log("PASS modeless and explicitly nonmodal dialogs retain page controls");

    // #71: Fathom's share dialog is a <ui-dialog> web component with no dialog
    // role, its title and close button in its shadow root, over the page.
    await evaluate(`(() => {
      if (!customElements.get('ui-dialog')) customElements.define('ui-dialog', class extends HTMLElement {
        connectedCallback() {
          if (this.shadowRoot) return;
          this.attachShadow({ mode: 'open' }).innerHTML = '<div style="margin:80px auto;width:400px;background:white"><h2>Share Recording</h2><button aria-label="Close">x</button><slot></slot></div>';
        }
      });
      document.body.innerHTML = '<span style="cursor:pointer">Recording title</span><button>Share</button>' +
        '<ui-dialog style="position:fixed;inset:0;display:block;background:rgba(0,0,0,.4)"><input aria-label="Add users and emails"></ui-dialog>';
      return true;
    })()`);
    const shared = await snapshot();
    assert.equal(shared.scope, "modal", JSON.stringify(shared));
    assert.equal(shared.dialog, "Share Recording");
    assert.deepEqual(shared.elements.map((el) => el.label), ["Add users and emails", "Close"]);
    // A custom element named like a dialog that is not in front keeps the page.
    await set('<button>Page action</button><app-confirm-dialog style="position:fixed;right:0;bottom:0;width:200px;height:80px;display:block"><button>Corner</button></app-confirm-dialog>');
    assert.equal((await snapshot()).scope, "page");
    console.log("PASS a role-less <ui-dialog> component over the page scopes the snapshot and is named");

    // #72: an inline editor that is a contenteditable span says it is editable.
    await set('<h1><span contenteditable="">Weekly sync</span></h1><span contenteditable="plaintext-only">Notes</span><span contenteditable="false">Fixed</span><div role="textbox" contenteditable="true">Body</div>');
    assert.deepEqual((await snapshot()).elements.map((el) => el.tag + " " + el.label),
      ["span[editable] Weekly sync", "span[editable] Notes", "div[editable] Body"]);
    console.log("PASS contenteditable editors are listed as [editable] in every spelling");

    await set('<div style="position:fixed;inset:0;z-index:30"><div role="dialog" style="position:absolute;inset:0;background:white"><button>High context</button></div></div><div style="position:fixed;inset:0;z-index:10"><div role="dialog" style="position:absolute;inset:0;z-index:9999;background:white"><button>Low context</button></div></div>');
    assert.equal((await snapshot()).elements[0].label, "High context");
    await set('<div role="dialog" style="position:fixed;inset:0;background:white"><button>Parent</button><div role="alertdialog" style="position:fixed;inset:100px;background:white"><button>Nested</button></div></div>');
    assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Nested"]);
    console.log("PASS stacking contexts and nested topmost dialog");

    await set(`${buttons(260)}<div aria-modal="true" style="position:fixed;inset:0;background:white;overflow:auto">${buttons(300, "Modal")}</div>`);
    const modalFirst = await snapshot({ limit: 100 });
    assert.equal(modalFirst.total, 300);
    assert.equal(modalFirst.nextOffset, 100);
    const modalLast = await snapshot({ offset: 200, limit: 100 });
    assert.equal(modalLast.elements[0].label, "Modal 200");
    assert.equal(modalLast.elements[0].i, 200);
    assert.equal(modalLast.nextOffset, null);
    await evaluate('globalThis.savedHitTest = document.elementsFromPoint; document.elementsFromPoint = () => []; true');
    assert.equal((await snapshot()).scope, "modal");
    await evaluate('document.elementsFromPoint = globalThis.savedHitTest; delete globalThis.savedHitTest; true');
    console.log("PASS large modal pagination and background-tab hit-test fallback");

    await set('<div aria-hidden="true"><button>Hidden</button></div><div inert><button>Inert</button></div><div style="opacity:0"><button>Transparent</button></div><div hidden><button>Gone</button></div><button style="position:absolute;top:2000px">Offscreen</button><input type="password" value="DO-NOT-LEAK">');
    const accessible = await snapshot();
    assert.deepEqual(accessible.elements.map((el) => el.label), ["Offscreen", ""]);
    assert.equal(accessible.elements[0].inView, false);
    assert.ok(!JSON.stringify(accessible).includes("DO-NOT-LEAK"));
    console.log("PASS hidden/inert ancestors excluded, offscreen retained, password protected");

    await set(buttons(520, "Control"));
    const first = await snapshot();
    assert.equal(first.elements.length, 250);
    assert.equal(first.total, 520);
    assert.equal(first.truncated, true);
    assert.equal(first.nextOffset, 250);
    const second = await snapshot({ offset: first.nextOffset, limit: 250 });
    assert.equal(second.elements[0].i, 250);
    assert.equal(second.elements[0].label, "Control 250");
    assert.equal(await evaluate('document.querySelector(\'[data-cu-idx="0"]\').innerText'), "Control 0");
    assert.equal(await evaluate('document.querySelectorAll(\'[data-cu-idx="250"]\').length'), 1);
    await evaluate('document.querySelector(\'[data-cu-idx="250"]\').onclick = () => document.title = "clicked page two"; true');
    assert.equal((await evaluate(click(second.elements[0].i))).ok, true);
    assert.equal(await evaluate("document.title"), "clicked page two");
    const last = await snapshot({ offset: second.nextOffset });
    assert.equal(last.elements.length, 20);
    assert.equal(last.truncated, false);
    assert.equal(last.nextOffset, null);
    assert.equal((await snapshot({ offset: 1000 })).elements.length, 0);
    await evaluate('document.querySelector(\'[data-cu-idx="0"]\').hidden = true; true');
    await snapshot();
    assert.equal(await evaluate('document.querySelectorAll(\'button[hidden][data-cu-idx]\').length'), 0);
    console.log("PASS bounded pagination, unique actionable global indices, stale-index cleanup");

    // Radix, MUI and Headless UI render an open select's options in a portal
    // at the end of <body>, outside the dialog that owns the select.
    const dialog = '<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white"><input role="combobox" aria-label="Country" aria-controls="countries" aria-expanded="true"><button>Save</button></div>';
    await set(`${buttons(10)}${dialog}<div role="listbox" id="countries" style="position:fixed;top:40px;left:0;width:200px;background:white;z-index:5"><div role="option">Canada</div><div role="option">France</div></div>`);
    assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Country", "Save", "Canada France", "Canada", "France"]);
    await set(`${buttons(10)}${dialog.replace(' aria-controls="countries"', "")}<div role="listbox" style="position:fixed;top:40px;left:0;width:200px;background:white;z-index:5"><div role="option">Painted on top</div></div>`);
    assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Country", "Save", "Painted on top", "Painted on top"]);
    await set(`${buttons(10)}${dialog.replace(' aria-controls="countries"', "")}<div popover id="menu"><button>Popover item</button></div>`);
    await evaluate('document.getElementById("menu").showPopover(); true');
    assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Country", "Save", "Popover item"]);
    console.log("PASS a modal keeps its portalled listbox, painted-on-top options and open popovers");

  }


  if (suite === "all" || suite === "shadow") {
    // #46: LinkedIn renders its invitation dialog inside the open shadow root
    // of #interop-outlet, over the profile's own Connect/Message buttons.
    // Document-level queries and hit tests stop at the host, so the snapshot
    // listed the background and a wait for [role=dialog] timed out.
    assert.ok(domDeclaration, "the extension has no shadow-root-aware page lookups");
    const pageDom = `(${vm.runInNewContext(domDeclaration + "; pageDomInPage").toString()})()`;
    const profile = '<main><h1>Alex Example</h1><button id="connect">Connect</button><button id="message">Message</button><button>More</button></main><div id="interop-outlet"></div>';
    const invitation = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.6)"><div role="dialog" aria-labelledby="invite-title" style="position:fixed;top:25%;left:25%;width:50%;height:50%;background:white"><h2 id="invite-title">Add a note to your invitation?</h2><button aria-label="Dismiss">x</button><button id="add-note">Add a note</button><button id="send">Send without a note</button></div></div>';
    const openInvitation = (delay = 0) => evaluate(`(() => {
      const open = () => {
        const outlet = document.getElementById('interop-outlet');
        const root = outlet.shadowRoot || outlet.attachShadow({ mode: 'open' });
        root.innerHTML = ${JSON.stringify(invitation)};
      };
      if (${delay}) setTimeout(open, ${delay}); else open();
      return true;
    })()`);
    await set(profile);
    await evaluate(`document.getElementById('connect').onclick = () => (window.backgroundClicks = (window.backgroundClicks || 0) + 1); true`);
    const before = await snapshot();
    assert.deepEqual(before.elements.map((el) => el.label), ["Connect", "Message", "More"]);
    const staleConnect = before.elements.find((el) => el.label === "Connect").i;
    await openInvitation();
    const blocked = await snapshot();
    console.log(`shadow dialog: scope=${blocked.scope}; labels=${blocked.elements.map((el) => el.label).join(", ")}`);
    assert.equal(blocked.scope, "modal");
    assert.deepEqual(blocked.elements.map((el) => el.label), ["Dismiss", "Add a note", "Send without a note"]);
    assert.equal(blocked.total, 3);
    console.log("PASS a dialog in an open shadow root scopes the snapshot to its controls");

    // Background controls are not indexed while the dialog blocks them, and
    // the index Connect had a snapshot ago now names a dialog control.
    assert.equal(await evaluate("document.getElementById('connect').hasAttribute('data-cu-idx')"), false);
    await evaluate(`document.getElementById('interop-outlet').shadowRoot.getElementById('add-note').onclick = () => (window.noteClicks = (window.noteClicks || 0) + 1); true`);
    assert.equal((await evaluate(click(staleConnect))).ok, true);
    assert.equal(await evaluate("window.backgroundClicks"), undefined, "a stale index clicked the blocked background");
    const addNote = blocked.elements.find((el) => el.label === "Add a note");
    assert.equal((await evaluate(click(addNote.i))).ok, true);
    assert.equal(await evaluate("window.noteClicks"), 1);
    assert.equal((await evaluate(click(blocked.total))).ok, false, "an index past the snapshot must not resolve");
    assert.equal(await evaluate("window.backgroundClicks"), undefined);
    // A press at the button's centre lands on it, not on the shadow host.
    assert.equal(await evaluate(`(() => {
      const dom = ${pageDom};
      const target = dom.byIndex(${addNote.i});
      const r = target.getBoundingClientRect();
      return dom.hit(r.left + r.width / 2, r.top + r.height / 2) === target;
    })()`), true);
    console.log("PASS blocked background controls cannot be clicked; shadow controls click and hit-test by index");

    // A background tab can lack a hit-test stack; the shadow dialog still wins.
    await evaluate('globalThis.savedHitTest = document.elementsFromPoint; document.elementsFromPoint = () => []; true');
    assert.equal((await snapshot()).scope, "modal");
    await evaluate('document.elementsFromPoint = globalThis.savedHitTest; delete globalThis.savedHitTest; true');
    console.log("PASS shadow dialog without a hit-test stack");

    // Readiness searches the same roots the snapshot does.
    const visible = vm.runInNewContext(declaration + "; isElementVisibleInPage");
    const selectorCode = source.slice(source.indexOf("function visibleSelectorInPage("), source.indexOf("/** Poll an explicit condition"));
    const selector = vm.runInNewContext(selectorCode + "; visibleSelectorInPage");
    const ready = (target) => evaluate(`(${selector.toString()})(${JSON.stringify(target)}, ${visible.toString()}, ${pageDom})`);
    assert.equal((await ready("[role='dialog']")).met, true);
    assert.equal((await ready("#send")).met, true);
    await set(profile);
    assert.equal((await ready("[role='dialog']")).met, false);
    console.log("PASS wait_for_selector matches inside open shadow roots");

    // browser_read: innerText skips shadow content, so the dialog's text was
    // missing from the page text too. It must appear once, after the page's.
    await openInvitation();
    const readCode = source.slice(source.indexOf("function readPageInPage("), source.indexOf("\n/**\n * Keep the lines"));
    const read = await evaluate(`(${vm.runInNewContext(readCode + "; readPageInPage").toString()})(false, ${pageDom})`);
    assert.equal(read.text.split("Add a note to your invitation?").length, 2, read.text);
    assert.ok(read.text.indexOf("Connect") < read.text.indexOf("Add a note to your invitation?"), read.text);
    console.log("PASS browser_read includes a shadow root's rendered text once");

    // Slotted light children render inside the shadow dialog; nested shadow
    // roots are searched; a hidden host hides everything it renders.
    await set('<button>Page</button><x-modal><button>Slotted</button></x-modal><div id="hidden-host" hidden></div>');
    await evaluate(`(() => {
      const host = document.querySelector('x-modal');
      host.attachShadow({ mode: 'open' }).innerHTML = '<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white"><slot></slot><x-inner></x-inner></div>';
      host.shadowRoot.querySelector('x-inner').attachShadow({ mode: 'open' }).innerHTML = '<button>Nested shadow</button>';
      document.getElementById('hidden-host').attachShadow({ mode: 'open' }).innerHTML = '<button>Hidden host</button>';
      return true;
    })()`);
    const slotted = await snapshot();
    assert.equal(slotted.scope, "modal");
    assert.deepEqual(slotted.elements.map((el) => el.label).sort(), ["Nested shadow", "Slotted"]);
    console.log("PASS slotted and nested-shadow controls belong to the dialog; a hidden host hides its shadow");

    // Frames are not searched; say how many there were rather than imply none.
    await set('<button>Page</button><iframe style="width:300px;height:200px" srcdoc="<button>In frame</button>"></iframe><iframe style="width:1px;height:1px"></iframe>');
    const framed = await snapshot();
    assert.equal(framed.frames, 1);
    assert.deepEqual(framed.elements.map((el) => el.label), ["Page"]);
    const missing = await ready("#nowhere");
    assert.equal(missing.met, false);
    assert.equal(missing.frames, 1);
    console.log("PASS snapshot and readiness report the visible frames they could not search");
  }

  if (suite === "all" || suite === "background") {
    // A dialog near the top of a blocking backdrop does not cover the centre;
    // the backdrop does (LinkedIn offsets some of its dialogs like this).
    await set(`<main>${buttons(5)}</main><div style="position:fixed;inset:0;background:#0008"><div role="dialog" style="position:absolute;left:30%;right:30%;top:20px;height:120px;background:white"><button>Add a note</button><button>Send without a note</button></div></div>`);
    const offset = await snapshot();
    assert.equal(offset.scope, "modal");
    assert.deepEqual(offset.elements.map((el) => el.label), ["Add a note", "Send without a note"]);
    console.log("PASS a dialog offset inside a blocking backdrop scopes the snapshot");

    // #53: Chrome does not advance animations in a tab it is not showing, so a
    // menu opened there stays at the first frame of its fade-in. Hold that
    // frame here with a long opacity-0 stretch (explicit and implicit ends).
    const style = "<style>@keyframes hold-in{0%,99%{opacity:0}to{opacity:1}}@keyframes hold-implicit{0%,99%{opacity:0}}@keyframes out{0%{opacity:1}1%,to{opacity:0}}" +
      ".in{animation:hold-in 1000s}.implicit{animation:hold-implicit 1000s}.out{animation:out 1000s linear -500s}</style>";
    await set(`${style}<main aria-hidden="true">${buttons(3)}</main><div role="menu" class="in"><div role="menuitem">Airport</div><div role="menuitem">Downtown</div></div><div role="listbox" class="implicit"><div role="option">Pick up</div></div>`);
    assert.equal(await evaluate("Number(getComputedStyle(document.querySelector('.in')).opacity)"), 0, "the fixture holds opacity 0");
    const opening = await snapshot();
    assert.deepEqual(opening.elements.map((el) => el.label), ["Airport Downtown", "Airport", "Downtown", "Pick up", "Pick up"]);
    assert.equal(opening.empty, undefined);
    console.log("PASS controls in a menu stuck at the start of its fade-in are listed");

    // One fading out is gone, and a snapshot with nothing left says why.
    await set(`${style}<main aria-hidden="true">${buttons(3)}</main><div role="menu" class="out"><div role="menuitem">Airport</div></div>`);
    const closing = await snapshot();
    assert.equal(closing.total, 0);
    assert.match(closing.empty, /the page has 5 that are not shown \(3 aria-hidden, 2 opacity 0\)/);
    assert.ok(!/Airport|Background/.test(closing.empty), "the note counts controls, it never quotes them");
    console.log("PASS a fading-out menu is hidden, and an empty snapshot says what it left out");

    // #54: Backspace checks the field changed, and deletes itself when Chrome
    // did not (a background tab runs the page's handlers but not the edit).
    const editStart = source.indexOf("const EDIT_PROBE_JS =");
    const [probeJs, finishJs] = vm.runInNewContext(source.slice(editStart, source.indexOf("\nasync function pressKey(")) + "; [EDIT_PROBE_JS, EDIT_FINISH_JS]");
    const key = async () => {
      const spec = { windowsVirtualKeyCode: 8, code: "Backspace", key: "Backspace" };
      await command("Input.dispatchKeyEvent", { type: "keyDown", ...spec });
      await command("Input.dispatchKeyEvent", { type: "keyUp", ...spec });
    };
    const backspace = async (deliver) => {
      await evaluate(probeJs);
      if (deliver) await key();
      return evaluate(finishJs);
    };
    const front = await command("Target.getTargetInfo", {});
    await command("Target.activateTarget", { targetId: front.targetInfo.targetId });
    await set('<input id="f" value="hello"><div id="ce" contenteditable="true">abc</div><input id="guard" value="tag">');
    await evaluate("window.inputs = 0; f.addEventListener('input', () => inputs++); f.focus(); f.setSelectionRange(5, 5); true");
    assert.deepEqual(await backspace(true), { checked: true, edited: true });
    assert.equal(await evaluate("f.value"), "hell");
    // Not delivered at all is what a background tab amounts to for the edit.
    assert.deepEqual(await backspace(false), { checked: true, edited: true, fallback: true });
    assert.deepEqual(await evaluate("[f.value, f.selectionStart, inputs]"), ["hel", 3, 2]);
    await evaluate("f.value = 'a😀'; f.setSelectionRange(3, 3); true");
    await backspace(false);
    assert.equal(await evaluate("f.value"), "a", "an emoji is deleted whole");
    await evaluate("f.setSelectionRange(0, 0); true");
    assert.match((await backspace(false)).note, /nothing before the caret/);
    // A page that takes the key for itself decides what it does.
    await evaluate("guard.addEventListener('keydown', (e) => e.preventDefault()); guard.focus(); guard.setSelectionRange(3, 3); true");
    assert.deepEqual(await backspace(true), { checked: true, edited: false, handled: true });
    assert.equal(await evaluate("guard.value"), "tag");
    await evaluate("ce.focus(); getSelection().collapse(ce.firstChild, 3); true");
    assert.equal((await backspace(false)).edited, true);
    assert.equal(await evaluate("ce.textContent"), "ab");
    await evaluate("document.activeElement.blur(); true");
    assert.deepEqual(await backspace(true), { checked: false });
    console.log("PASS Backspace is checked, deletes itself when Chrome did not, and leaves a page's own handling alone");

    // #52: a page evaluation that never returns is stopped by Chrome itself.
    const begun = Date.now();
    const stuck = await new Promise((resolve) => {
      const current = 1e6;
      const listener = (event) => {
        const reply = JSON.parse(event.data);
        if (reply.id === current) { socket.removeEventListener("message", listener); resolve(reply); }
      };
      socket.addEventListener("message", listener);
      socket.send(JSON.stringify({ id: current, method: "Runtime.evaluate", params: { expression: "for (;;) {}", timeout: 500 } }));
    });
    // The extension recognises this error and reports it as a stopped page.
    assert.match(stuck.error?.message || "", /Execution was terminated/);
    assert.ok(Date.now() - begun < 5000);
    assert.equal(await evaluate("1 + 1"), 2, "the page answers again afterwards");
    console.log("PASS Chrome stops an endless page evaluation at the extension's limit");
  }

  if (suite === "all" || suite === "audit-r1") {
    await set('<nav><a href="#a">Home</a><a href="#b">Pricing</a><button>Sign in</button></nav><main><button id="buy">Buy now</button></main><div role="dialog" style="position:fixed;left:0;right:0;bottom:0;height:80px;background:white"><button>Accept cookies</button></div>');
    const banner = await snapshot();
    assert.equal(banner.scope, "page", "a modeless cookie banner must not suppress the page");
    assert.deepEqual(banner.elements.map((el) => el.label), ["Home", "Pricing", "Sign in", "Buy now", "Accept cookies"]);
    await evaluate('document.getElementById("buy").onclick = () => globalThis.pageActionClicked = true; true');
    assert.equal((await evaluate(click(banner.elements.find((el) => el.label === "Buy now").i))).ok, true);
    assert.equal(await evaluate("globalThis.pageActionClicked"), true);
    await set('<main><button>Buy now</button><button>Checkout</button></main><div role="alertdialog" style="position:fixed;right:10px;bottom:10px;width:300px;height:200px;background:white"><textarea aria-label="Message"></textarea><button>Send</button></div>');
    const chat = await snapshot();
    assert.equal(chat.scope, "page", "a corner widget must not suppress the page");
    assert.deepEqual(chat.elements.map((el) => el.label), ["Buy now", "Checkout", "Message", "Send"]);
    // A missing background-tab hit-test stack must not promote this widget.
    await evaluate('globalThis.savedHitTest = document.elementsFromPoint; document.elementsFromPoint = () => []; true');
    assert.equal((await snapshot()).scope, "page");
    await evaluate('document.elementsFromPoint = globalThis.savedHitTest; delete globalThis.savedHitTest; true');
    console.log("PASS modeless cookie/chat widgets preserve indexed page actions, including absent hit tests");
  }

  if (suite === "all" || suite === "audit-r2") {
    await set('<label style="display:inline-block;position:relative;padding:8px;border:1px solid">Upload resume<input id="upload" type="file" aria-label="Upload resume" style="position:absolute;inset:0;opacity:0"></label><label style="display:inline-block;position:relative;width:80px;height:30px">Toggle<input id="toggle" type="checkbox" aria-label="Enable notifications" style="position:absolute;inset:0;opacity:0;width:80px;height:30px"></label>');
    const controls = await snapshot();
    assert.deepEqual(controls.elements.map((el) => el.label), ["Upload resume", "Enable notifications"], "transparent native hit targets must remain indexed");
    const toggle = controls.elements.find((el) => el.tag === "input[checkbox]");
    assert.equal((await evaluate(click(toggle.i))).ok, true);
    assert.equal(await evaluate('document.getElementById("toggle").checked'), true);
    const visible = vm.runInNewContext(declaration + "; isElementVisibleInPage");
    const selectorCode = source.slice(source.indexOf("function visibleSelectorInPage("), source.indexOf("/** Poll an explicit condition"));
    const selector = vm.runInNewContext(selectorCode + "; visibleSelectorInPage");
    const ready = (target) => evaluate(`(${selector.toString()})(${JSON.stringify(target)}, ${visible.toString()}${domArgument})`);
    assert.equal((await ready("#toggle")).met, true);
    await set('<button>Page action</button><div id="transparent-dialog" role="dialog" aria-modal="true" style="position:fixed;inset:0;opacity:0"><button>Hidden modal control</button></div>');
    assert.equal((await snapshot()).scope, "page", "a fully transparent dialog is not a visible modal");
    assert.equal((await ready("#transparent-dialog")).met, false, "a transparent container must not satisfy visible readiness");
    console.log("PASS transparent native inputs stay indexed/clickable/ready while transparent containers stay hidden");
  }

  if (suite === "all" || suite === "readiness") {
    const between = (first, last) => {
      const begin = source.indexOf(first);
      const end = source.indexOf(last, begin);
      assert.ok(begin >= 0 && end > begin, `missing source boundary: ${first}`);
      return source.slice(begin, end);
    };
    const tab = { status: "complete" };
    const context = vm.createContext({
      setTimeout, Date,
      chrome: { tabs: { get: async () => tab } },
      requireClientId: () => "test",
      checkTab: async () => {},
      send: async (_tabId, _method, params) => {
        try { return { result: { value: await evaluate(params.expression) } }; }
        catch (error) { return { exceptionDetails: { text: error.message } }; }
      },
    });
    vm.runInContext(
      between(start, "async function clickAt") +
      clickDeclaration +
      between("const sleep =", "/**\n * The page's readable text"), context,
    );
    const extension = (code) => vm.runInContext(code, context);
    const openDelayedDialog = async () => {
      await set(`<button id="open">Open dialog</button><main aria-hidden="true">${buttons(260)}</main>`);
      await evaluate(`(() => {
        window.clicks = 0;
        document.getElementById('open').onclick = () => {
          window.clicks++;
          setTimeout(() => {
            const modal = document.createElement('div');
            modal.setAttribute('role', 'dialog');
            modal.style.cssText = 'position:fixed;inset:0;background:white';
            modal.innerHTML = '<h1>Connect your Domain</h1><input aria-label="Domain"><button>Next</button>';
            document.body.append(modal);
          }, 1100);
        };
      })()`);
      const initial = await extension("snapshot(1)");
      const index = initial.elements.find((el) => el.label === "Open dialog").i;
      assert.equal((await evaluate(extension(`${clickName}(${index})`))).ok, true);
    };
    await openDelayedDialog();
    const before = Date.now();
    const result = await extension('withState({tabId:1,returnState:true,waitForSelector:"[role=dialog] button",waitTimeoutMs:3000},{ok:true})');
    const rendered = await evaluate("document.querySelector('[role=dialog] button') !== null");
    console.log(`post-click wait ${Date.now() - before}ms; Next=${result.snapshot.elements.some((el) => el.label === "Next")}; dialogRendered=${rendered}`);
    assert.equal(rendered, true, "snapshot returned before the delayed dialog rendered");
    assert.ok(result.snapshot.elements.some((el) => el.label === "Next"), "snapshot returned before the delayed dialog rendered");
    assert.equal(result.readiness.status, "met");
    assert.equal(result.snapshot.scope, "modal");
    assert.deepEqual(await evaluate("[window.clicks, document.querySelectorAll('[role=dialog]').length]"), [1, 1]);
    console.log("PASS delayed same-document dialog with 260 background controls, one click only");

    await openDelayedDialog();
    const timedOut = await extension('withState({tabId:1,returnState:true,waitForSelector:"[role=dialog] button",waitTimeoutMs:0},{ok:true})');
    assert.equal(timedOut.ok, true);
    assert.equal(timedOut.readiness.status, "timeout");
    const observed = await extension('waitForReadiness({tabId:1,waitForSelector:"[role=dialog] button",waitTimeoutMs:3000})');
    assert.equal(observed.status, "met");
    assert.ok((await extension("snapshot(1)")).elements.some((el) => el.label === "Next"));
    assert.deepEqual(await evaluate("[window.clicks, document.querySelectorAll('[role=dialog]').length]"), [1, 1]);
    console.log("PASS timeout preserves action success and read-only re-observation does not replay it");

    await set('<button id="ready">Ready</button>');
    tab.status = "loading";
    assert.equal((await extension('waitForReadiness({tabId:1,waitForSelector:"#ready",waitTimeoutMs:100})')).status, "met");
    tab.status = "complete";
    const unconfigured = await extension("withState({tabId:1,returnState:true},{ok:true})");
    assert.equal(unconfigured.readiness.status, "not_requested");
    console.log("PASS explicit condition independent of resource loading; no implicit SPA-readiness claim");

    await set('<div aria-hidden="true"><button id="aria-hidden">Hidden</button></div><div inert><button id="inert">Inert</button></div><div style="opacity:0"><button id="transparent">Transparent</button></div><button id="revealed" style="display:none">Soon</button>');
    for (const selector of ["#aria-hidden", "#inert", "#transparent"]) {
      assert.equal((await extension(`waitForReadiness({tabId:1,waitForSelector:${JSON.stringify(selector)},waitTimeoutMs:0})`)).status, "timeout");
    }
    await evaluate('setTimeout(() => { document.getElementById("revealed").style.display = "block"; }, 600); true');
    const hiddenStart = Date.now();
    assert.equal((await extension('waitForReadiness({tabId:1,waitForSelector:"#revealed",waitTimeoutMs:2000})')).status, "met");
    assert.ok(Date.now() - hiddenStart >= 450);
    console.log("PASS shared hidden/inert/opacity rules and delayed visible match");

    const invalid = await extension('withState({tabId:1,returnState:true,waitForSelector:"[",waitTimeoutMs:0},{ok:true})');
    assert.equal(invalid.ok, true);
    assert.equal(invalid.readiness.status, "error");
    assert.equal(invalid.readiness.error, "invalid CSS selector");
    const malicious = '[id="x"]); window.injected = true; //';
    assert.equal((await extension(`waitForReadiness({tabId:1,waitForSelector:${JSON.stringify(malicious)},waitTimeoutMs:0})`)).status, "error");
    assert.equal(await evaluate("window.injected"), undefined);
    console.log("PASS invalid CSS reported separately from action success; selector cannot inject script");
  }
} finally {
  socket?.close();
  const exited = chrome.pid && chrome.exitCode === null && chrome.signalCode === null
    ? new Promise((resolve) => chrome.once("exit", resolve)) : null;
  if (chrome.pid) {
    try {
      // POSIX Chromium children can outlive their launcher and keep writing.
      // Signal only this test's private process group, even after launcher exit.
      if (process.platform === "win32") chrome.kill();
      else process.kill(-chrome.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  if (exited) await exited;
  // Children can release profile files a moment after the group is terminated.
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
