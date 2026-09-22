#!/usr/bin/env node
// Checks that the Swift (macOS) and Rust (Windows/Linux) servers advertise the
// same tools: same order, names, descriptions, input schemas and annotations,
// and the same `initialize` instructions. A model that learned the tools on one
// platform must not meet different ones on another.
//
// The two tool lists are source literals (a Swift dictionary literal and a
// serde_json `json!` block), so this parses both with a small tolerant parser
// instead of building either server.
//
// Deliberate differences, and the only ones allowed:
//   * get_app_state.window  — macOS only (scope to one window or the agent's
//     Chrome window).
//   * screenshot.format     — Windows/Linux only (jpeg encoding).
//
// Usage: node scripts/check-tool-parity.mjs   (exit 1 on any mismatch)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const swiftPath = path.join(root, "macos/Sources/main.swift");
const rustPath = path.join(root, "windows-linux/src/tools.rs");

const ALLOWED_EXTRAS = {
  swift: [["get_app_state", "window"]],
  rust: [["screenshot", "format"]],
};

// ---------------------------------------------------------------- tokenizer

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (source.startsWith("/*", i)) {
      i = source.indexOf("*/", i + 2) + 2;
    } else if (ch === '"') {
      let value = "";
      i++;
      while (source[i] !== '"') {
        if (source[i] === "\\") {
          const next = source[i + 1];
          if (next === "u" && source[i + 2] === "{") {
            const end = source.indexOf("}", i);
            value += String.fromCodePoint(parseInt(source.slice(i + 3, end), 16));
            i = end + 1;
            continue;
          }
          if (next === "\n") {
            // Rust line continuation: skip the newline and leading whitespace.
            i += 2;
            while (/\s/.test(source[i])) i++;
            continue;
          }
          value += { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "'": "'" }[next] ?? next;
          i += 2;
        } else {
          value += source[i++];
        }
      }
      i++;
      tokens.push({ type: "string", value });
    } else if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^-?[0-9]+(\.[0-9]+)?/.exec(source.slice(i));
      tokens.push({ type: "number", value: Number(match[0]) });
      i += match[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ type: "ident", value: match[0] });
      i += match[0].length;
    } else {
      tokens.push({ type: "punct", value: ch });
      i++;
    }
  }
  return tokens;
}

// ------------------------------------------------------------------- parser

function parseLiteral(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (value) => {
    const token = next();
    if (!token || token.value !== value) {
      throw new Error(`expected '${value}' but found '${token?.value}' at token ${pos - 1}`);
    }
  };
  const isPunct = (value) => peek()?.type === "punct" && peek().value === value;

  function skipType() {
    // Swift casts such as `as [String: Any]`.
    if (isPunct("[")) {
      let depth = 0;
      do {
        const token = next();
        if (token.value === "[") depth++;
        if (token.value === "]") depth--;
      } while (depth > 0);
    } else {
      next();
    }
  }

  function value() {
    const token = next();
    let result;
    if (token.type === "string" || token.type === "number") {
      result = token.value;
    } else if (token.type === "ident" && (token.value === "true" || token.value === "false")) {
      result = token.value === "true";
    } else if (token.type === "ident" && isPunct("(")) {
      // A wrapper call such as obj([...]).
      next();
      result = value();
      expect(")");
    } else if (token.value === "{") {
      result = {};
      while (!isPunct("}")) {
        const key = next();
        if (key.type !== "string") throw new Error(`object key must be a string, got ${key.value}`);
        expect(":");
        result[key.value] = value();
        if (isPunct(",")) next();
      }
      next();
    } else if (token.value === "[") {
      if (isPunct(":")) {
        next();
        expect("]");
        result = {};
      } else if (isPunct("]")) {
        next();
        result = [];
      } else {
        const first = value();
        if (isPunct(":")) {
          next();
          result = { [first]: value() };
          if (isPunct(",")) next();
          while (!isPunct("]")) {
            const key = value();
            expect(":");
            result[key] = value();
            if (isPunct(",")) next();
          }
        } else {
          result = [first];
          if (isPunct(",")) next();
          while (!isPunct("]")) {
            result.push(value());
            if (isPunct(",")) next();
          }
        }
        next();
      }
    } else {
      throw new Error(`unexpected token '${token.value}' at ${pos - 1}`);
    }
    while (peek()?.type === "ident" && peek().value === "as") {
      next();
      skipType();
    }
    return result;
  }

  return value();
}

/// The balanced bracket expression that starts at `open` in `source`.
function balanced(source, open) {
  const opener = source[open];
  const closer = { "[": "]", "{": "}", "(": ")" }[opener];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      i++;
      while (source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      i = source.indexOf("\n", i);
      continue;
    }
    if (ch === opener) depth++;
    if (ch === closer && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error("unbalanced literal");
}

function extract(source, marker, what) {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`could not find ${what} (${marker})`);
  return balanced(source, at + marker.length - 1);
}

function stringConstant(source, pattern, what) {
  const match = pattern.exec(source);
  if (!match) throw new Error(`could not find ${what}`);
  return tokenize(match[1])[0].value;
}

// ------------------------------------------------------------------ compare

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function diff(a, b, where, out) {
  if (JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) out.push(`${where}.${key}: only in Rust`);
      else if (!(key in b)) out.push(`${where}.${key}: only in Swift`);
      else diff(a[key], b[key], `${where}.${key}`, out);
    }
    return;
  }
  out.push(`${where}:\n    swift: ${JSON.stringify(a)}\n    rust:  ${JSON.stringify(b)}`);
}

function withoutExtras(tools, extras) {
  const copy = structuredClone(tools);
  for (const [tool, property] of extras) {
    const def = copy.find((entry) => entry.name === tool);
    if (!def) throw new Error(`allowed extra ${tool}.${property} refers to a missing tool`);
    if (!(property in (def.inputSchema?.properties ?? {}))) {
      throw new Error(`allowed extra ${tool}.${property} no longer exists; update ALLOWED_EXTRAS`);
    }
    delete def.inputSchema.properties[property];
  }
  return copy;
}

const swiftSource = readFileSync(swiftPath, "utf8");
const rustSource = readFileSync(rustPath, "utf8");

const swiftTools = parseLiteral(extract(swiftSource, "let toolDefs: [[String: Any]] = [", "Swift toolDefs"));
const rustTools = parseLiteral(extract(rustSource, "json!([", "Rust all_tool_defs"));

const problems = [];
const swiftNames = swiftTools.map((tool) => tool.name);
const rustNames = rustTools.map((tool) => tool.name);
if (JSON.stringify(swiftNames) !== JSON.stringify(rustNames)) {
  problems.push(`tool order differs:\n    swift: ${swiftNames.join(", ")}\n    rust:  ${rustNames.join(", ")}`);
}

const swiftComparable = withoutExtras(swiftTools, ALLOWED_EXTRAS.swift);
const rustComparable = withoutExtras(rustTools, ALLOWED_EXTRAS.rust);
for (const tool of swiftComparable) {
  const other = rustComparable.find((entry) => entry.name === tool.name);
  if (!other) {
    problems.push(`${tool.name}: only in Swift`);
    continue;
  }
  diff(tool, other, tool.name, problems);
}
for (const tool of rustComparable) {
  if (!swiftComparable.some((entry) => entry.name === tool.name)) problems.push(`${tool.name}: only in Rust`);
}

const swiftInstructions = stringConstant(swiftSource, /let serverInstructions = ("(?:[^"\\]|\\.)*")/, "Swift serverInstructions");
const rustInstructions = stringConstant(rustSource, /SERVER_INSTRUCTIONS: &str = ("(?:[^"\\]|\\.)*")/, "Rust SERVER_INSTRUCTIONS");
if (swiftInstructions !== rustInstructions) {
  problems.push(`initialize instructions differ:\n    swift: ${swiftInstructions}\n    rust:  ${rustInstructions}`);
}

if (problems.length) {
  console.error(`Tool parity check failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Tool parity OK: ${swiftNames.length} tools, identical in order, text and schema (allowed extras: get_app_state.window on macOS, screenshot.format on Windows/Linux).`);
