// node scripts/build-extension.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildExtension, extensionIdForKey, parseArgs } from "./build-extension.mjs";

const checks = [];
const test = (name, body) => checks.push([name, body]);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cu-extension-"));

test("the stock build keeps the shipped id and hosts and leaves tests behind", () => {
  const result = buildExtension(parseArgs(["--out", path.join(scratch, "stock")]));
  // Pinned by the "key" in manifest.json; install.sh and embedders rely on it.
  assert.equal(result.extensionId, "kgdolgnijopbghhomnblabjkmjhnoage");
  const background = fs.readFileSync(path.join(result.out, "background.js"), "utf8");
  assert.match(background, /const NATIVE_HOSTS = \["com\.munim\.mtcode\.desktop", "com\.munimtech\.computer-use\.desktop"\];/);
  assert.ok(fs.existsSync(path.join(result.out, "icons/cursor-224.png")));
  assert.ok(!fs.existsSync(path.join(result.out, "background.test.mjs")));
  assert.ok(!fs.existsSync(path.join(result.out, "install.sh")));
});

test("a variant carries its own hosts, title, name and key", () => {
  const key = Buffer.from("not a real key, only hashed").toString("base64");
  const result = buildExtension(
    parseArgs([
      "--out", path.join(scratch, "variant"),
      "--host", "com.example.app.desktop",
      "--host", "com.example.app.legacy",
      "--group-title", "Example \"App\"",
      "--name", "Example Desktop Control",
      "--key", key,
      "--version", "9.9.9",
    ]),
  );
  assert.equal(result.extensionId, extensionIdForKey(key));
  assert.match(result.extensionId, /^[a-p]{32}$/);
  const background = fs.readFileSync(path.join(result.out, "background.js"), "utf8");
  assert.match(background, /const NATIVE_HOSTS = \["com\.example\.app\.desktop","com\.example\.app\.legacy"\];/);
  assert.match(background, /const GROUP_TITLE = "Example \\"App\\"";/);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.out, "manifest.json"), "utf8"));
  assert.equal(manifest.name, "Example Desktop Control");
  assert.equal(manifest.key, key);
  assert.equal(manifest.version, "9.9.9");
});

test("bad host names and unknown flags are refused", () => {
  assert.throws(() => parseArgs(["--out", "x", "--host", "Not Valid"]), /invalid native-messaging host/);
  assert.throws(() => parseArgs(["--out", "x", "--hots", "a"]), /unknown option/);
  assert.throws(() => parseArgs([]), /--out/);
});

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
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : `\n${checks.length} passed`);
process.exit(failed ? 1 : 0);
