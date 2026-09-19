#!/usr/bin/env node
// Build the Chrome extension, optionally as a variant for an embedding app.
//
//   node scripts/build-extension.mjs --out <dir>
//       [--host <native-messaging host name>]...   (repeatable, tried in order)
//       [--group-title <tab group title>]
//       [--name <extension name>] [--description <text>]
//       [--key <base64 public key>] [--version <x.y.z>]
//
// With no options the output is the stock extension (tests and installers
// left out). An app that runs munim-computer-use under its own identity (see
// "Embedding" in the README) passes its own host names so the extension talks
// to its native host rather than the standalone one, and its own key so Chrome
// gives the variant its own extension id. The id is printed, because the native
// host manifest has to list it in `allowed_origins`.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../chrome-extension");

/** Files that belong in the shipped extension. Everything else stays behind. */
const SHIPPED = ["manifest.json", "background.js", "wake.js", "icons"];

const BEGIN = "// @embed-config-begin";
const END = "// @embed-config-end";

export function parseArgs(argv) {
  const options = { hosts: [] };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "--out":
        options.out = value();
        break;
      case "--host":
        options.hosts.push(value());
        break;
      case "--group-title":
        options.groupTitle = value();
        break;
      case "--name":
        options.name = value();
        break;
      case "--description":
        options.description = value();
        break;
      case "--key":
        options.key = value();
        break;
      case "--version":
        options.version = value();
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  if (!options.out) throw new Error("--out <dir> is required");
  for (const host of options.hosts) {
    // Chrome's rule for native-messaging host names.
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(host)) {
      throw new Error(`invalid native-messaging host name: ${host}`);
    }
  }
  return options;
}

/** Chrome derives an extension's id from its public key: sha256, first 16 bytes, hex mapped onto a-p. */
export function extensionIdForKey(base64Key) {
  const digest = crypto.createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex");
  return Array.from(digest.slice(0, 32), (c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** Rewrite the embedder configuration block in background.js. */
export function configureBackground(script, { hosts, groupTitle }) {
  const begin = script.indexOf(BEGIN);
  const end = script.indexOf(END);
  if (begin < 0 || end < begin) throw new Error("background.js has no embed-config block");
  const block = script.slice(begin, end);
  let next = block;
  if (hosts.length > 0) {
    next = replaceConst(next, "NATIVE_HOSTS", JSON.stringify(hosts));
  }
  if (groupTitle !== undefined) {
    next = replaceConst(next, "GROUP_TITLE", JSON.stringify(groupTitle));
  }
  return script.slice(0, begin) + next + script.slice(end);
}

function replaceConst(block, name, literal) {
  const pattern = new RegExp(`^const ${name} = .*;$`, "m");
  if (!pattern.test(block)) throw new Error(`embed-config block does not define ${name}`);
  return block.replace(pattern, () => `const ${name} = ${literal};`);
}

export function buildExtension(options) {
  const out = path.resolve(options.out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const entry of SHIPPED) {
    fs.cpSync(path.join(source, entry), path.join(out, entry), { recursive: true });
  }

  const backgroundPath = path.join(out, "background.js");
  fs.writeFileSync(
    backgroundPath,
    configureBackground(fs.readFileSync(backgroundPath, "utf8"), options),
  );

  const manifestPath = path.join(out, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (options.name !== undefined) manifest.name = options.name;
  if (options.description !== undefined) manifest.description = options.description;
  if (options.key !== undefined) manifest.key = options.key;
  if (options.version !== undefined) manifest.version = options.version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { out, extensionId: extensionIdForKey(manifest.key), version: manifest.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildExtension(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`build-extension: ${error.message}`);
    process.exit(1);
  }
}
