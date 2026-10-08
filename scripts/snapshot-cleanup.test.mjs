#!/usr/bin/env node
// Deterministic teardown regression: no browser, filesystem writes or real kills.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";

const source = fs.readFileSync(new URL("./snapshot-dom.test.mjs", import.meta.url), "utf8");
const launchStart = source.indexOf("const chrome = spawn(");
const launchEnd = source.indexOf("let chromeLog =", launchStart);
const cleanupStart = source.lastIndexOf("} finally {");
assert.ok(launchStart >= 0 && launchEnd > launchStart && cleanupStart >= 0);
const launch = source.slice(launchStart, launchEnd);
const cleanup = source.slice(cleanupStart + "} finally {".length, source.lastIndexOf("}"));

let failed = 0;
for (const platform of ["linux", "darwin"]) {
  for (const alreadyExited of [false, true]) {
    const label = `${platform}: ${alreadyExited ? "exited launcher" : "running launcher"}, surviving profile writer`;
    const chrome = new EventEmitter();
    chrome.pid = 31337;
    chrome.exitCode = alreadyExited ? 0 : null;
    chrome.signalCode = null;
    let descendantWriting = true;
    let launchOptions;
    const exit = () => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) return;
      chrome.signalCode = "SIGKILL";
      queueMicrotask(() => chrome.emit("exit", null, "SIGKILL"));
    };
    chrome.kill = () => { exit(); return true; }; // Parent-only kill leaves writer.
    const context = {
      chromePath: "fixture-only-chrome", profile: "fixture-only-profile",
      socket: { close() {} },
      spawn(_executable, _args, options) { launchOptions = options; return chrome; },
      process: {
        platform,
        kill(pid, signal) {
          assert.equal(pid, -chrome.pid, "signal only the private browser process group");
          assert.equal(signal, "SIGKILL");
          assert.equal(launchOptions.detached, true, "browser must own its process group");
          descendantWriting = false;
          exit();
        },
      },
      fs: {
        rmSync(profile, options) {
          assert.equal(profile, "fixture-only-profile");
          assert.equal(options.recursive, true);
          assert.equal(descendantWriting, false, "Chrome descendant still writing when profile deletion starts");
          assert.ok(chrome.exitCode !== null || chrome.signalCode !== null, "wait for the launcher to exit");
        },
      },
    };
    try {
      await vm.runInNewContext(`(async () => { ${launch}\n${cleanup}\n})()`, context);
      console.log(`PASS ${label}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${label}: ${error.message}`);
    }
  }
}
if (failed) process.exitCode = 1;
