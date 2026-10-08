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
assert.ok(["all", "snapshot", "readiness", "audit-r1", "audit-r2", "audit-r3"].includes(suite), "invalid --suite");
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
  const clickDeclaration = source.slice(source.indexOf("const CLICK_JS ="), source.indexOf("\n/// Click a snapshotted element"));
  const click = vm.runInNewContext(clickDeclaration + "\nCLICK_JS");
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
    const ready = (target) => evaluate(`(${selector.toString()})(${JSON.stringify(target)}, ${visible.toString()})`);
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
      between("const CLICK_JS", "/// Click a snapshotted") +
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
      assert.equal((await evaluate(extension(`CLICK_JS(${index})`))).ok, true);
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
