#!/usr/bin/env node
// Rewrites the two tool-definition literals — the Swift `toolDefs` array in
// macos/Sources/main.swift and the Rust `json!` block in
// windows-linux/src/tools.rs — from one edit, so they cannot drift apart.
//
//   import { rewriteToolDefs } from "./tool-defs.mjs";
//   rewriteToolDefs((tools, platform) => { /* mutate tools */ });
//
// The transform runs once per platform ("swift", "rust") on that platform's
// parsed list, so the deliberate per-platform extras (see
// check-tool-parity.mjs) survive. Run `node scripts/tool-defs.mjs --check` to
// confirm that re-emitting the current literals reproduces both files byte for
// byte; the formatting below matches the hand-written style of each file.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseLiteral, extract, SWIFT_MARKER, RUST_MARKER, swiftPath, rustPath } from "./check-tool-parity.mjs";

const quote = (text) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
const scalar = (value) => (typeof value === "string" ? quote(value) : String(value));
const isScalarArray = (value) => Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null);

function emitRust(value, indent) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 4);
  if (isScalarArray(value)) return `[${value.map(scalar).join(", ")}]`;
  if (Array.isArray(value)) {
    return `[\n${value.map((item) => inner + emitRust(item, indent + 4)).join(",\n")}\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((key) => `${inner}${quote(key)}: ${emitRust(value[key], indent + 4)}`).join(",\n")}\n${pad}}`;
  }
  return scalar(value);
}

// Swift cannot infer the type of a one-property `properties` whose schema mixes
// strings with numbers or booleans, so that one case carries an explicit type.
function emitSwift(value, indent, key) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 4);
  if (isScalarArray(value)) return `[${value.map(scalar).join(", ")}]`;
  if (Array.isArray(value)) {
    return `[\n${value.map((item) => `${inner}${emitSwift(item, indent + 4)},\n`).join("")}${pad}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "[:] as [String: Any]";
    const only = keys.length === 1 ? value[keys[0]] : null;
    const mixed = only && typeof only === "object" && !Object.values(only).every((item) => typeof item === "string");
    const cast = key === "properties" && mixed ? " as [String: Any]" : "";
    return `[\n${keys.map((name) => `${inner}${quote(name)}: ${emitSwift(value[name], indent + 4, name)},\n`).join("")}${pad}]${cast}`;
  }
  return scalar(value);
}

function splice(source, marker, text) {
  const at = source.indexOf(marker) + marker.length - 1;
  const old = extract(source, marker, marker);
  return source.slice(0, at) + text + source.slice(at + old.length);
}

export function rewriteToolDefs(transform, { write = true } = {}) {
  const swiftSource = readFileSync(swiftPath, "utf8");
  const rustSource = readFileSync(rustPath, "utf8");
  const swiftTools = parseLiteral(extract(swiftSource, SWIFT_MARKER, "Swift toolDefs"));
  const rustTools = parseLiteral(extract(rustSource, RUST_MARKER, "Rust all_tool_defs"));
  transform(swiftTools, "swift");
  transform(rustTools, "rust");
  const nextSwift = splice(swiftSource, SWIFT_MARKER, emitSwift(swiftTools, 0));
  const nextRust = splice(rustSource, RUST_MARKER, emitRust(rustTools, 4));
  if (write) {
    writeFileSync(swiftPath, nextSwift);
    writeFileSync(rustPath, nextRust);
  }
  return { swift: nextSwift === swiftSource, rust: nextRust === rustSource, nextSwift, nextRust };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes("--check")) {
  const same = rewriteToolDefs(() => {}, { write: false });
  if (!same.swift || !same.rust) {
    console.error(`round trip changed ${[!same.swift && "Swift", !same.rust && "Rust"].filter(Boolean).join(" and ")} — the emitter no longer matches the file's style`);
    process.exit(1);
  }
  console.log("tool-defs round trip OK: both literals re-emit byte for byte");
}
