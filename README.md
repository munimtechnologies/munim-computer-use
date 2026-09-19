<!-- Banner Image -->

<p align="center">
  <a href="https://github.com/munimtechnologies/munim-computer-use">
    <img alt="Munim Technologies Computer Use" height="128" src="./.github/resources/banner.png?v=1">
    <h1 align="center">munim-computer-use</h1>
  </a>
</p>

<p align="center">
  <a aria-label="Latest release" href="https://github.com/munimtechnologies/munim-computer-use/releases/latest" target="_blank">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/munimtechnologies/munim-computer-use?style=flat-square&label=Version&labelColor=000000&color=0066CC" />
  </a>
  <a aria-label="License" href="https://github.com/munimtechnologies/munim-computer-use/blob/main/LICENSE" target="_blank">
    <img alt="License: Apache-2.0" src="https://img.shields.io/badge/License-Apache%202.0-success.svg?style=flat-square&color=33CC12" />
  </a>
  <a aria-label="package downloads" href="https://www.npmtrends.com/munim-computer-use" target="_blank">
    <img alt="Downloads" src="https://img.shields.io/npm/dm/munim-computer-use.svg?style=flat-square&labelColor=gray&color=33CC12&label=Downloads" />
  </a>
  <a aria-label="total package downloads" href="https://www.npmjs.com/package/munim-computer-use" target="_blank">
    <img alt="Total Downloads" src="https://img.shields.io/npm/dt/munim-computer-use.svg?style=flat-square&labelColor=gray&color=0066CC&label=Total%20Downloads" />
  </a>
  <a aria-label="MCP" href="https://modelcontextprotocol.io" target="_blank">
    <img alt="MCP stdio server" src="https://img.shields.io/badge/MCP-stdio%20server-8A2BE2?style=flat-square" />
  </a>
  <img alt="Platforms" src="https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" />
</p>

<p align="center">
  <a aria-label="download" href="https://github.com/munimtechnologies/munim-computer-use/releases/latest"><b>Download</b></a>
&ensp;•&ensp;
  <a aria-label="documentation" href="https://github.com/munimtechnologies/munim-computer-use#readme">Read the Documentation</a>
&ensp;•&ensp;
  <a aria-label="report issues" href="https://github.com/munimtechnologies/munim-computer-use/issues">Report Issues</a>
&ensp;•&ensp;
  <a aria-label="website" href="https://munimtech.com/computer-use">munimtech.com/computer-use</a>
</p>

<h6 align="center">Follow Munim Technologies</h6>
<p align="center">
  <a aria-label="Follow Munim Technologies on GitHub" href="https://github.com/munimtechnologies" target="_blank">
    <img alt="Munim Technologies on GitHub" src="https://img.shields.io/badge/GitHub-222222?style=for-the-badge&logo=github&logoColor=white" />
  </a>&nbsp;
  <a aria-label="Follow Munim Technologies on LinkedIn" href="https://linkedin.com/in/sheehanmunim" target="_blank">
    <img alt="Munim Technologies on LinkedIn" src="https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" />
  </a>&nbsp;
  <a aria-label="Visit Munim Technologies Website" href="https://munimtech.com" target="_blank">
    <img alt="Munim Technologies Website" src="https://img.shields.io/badge/Website-0066CC?style=for-the-badge&logo=globe&logoColor=white" />
  </a>
</p>

## Introduction

**Computer Use** is an open-source [MCP](https://modelcontextprotocol.io) server — a computer-use agent (CUA) backend — that lets any coding agent use your computer the way a person does. It reads the screen through accessibility trees, clicks and types **in the background** so your mouse stays yours, shows an agent pointer where it is working, zooms in on small text, and drives tabs in your signed-in Chrome — on **macOS, Windows and Linux**.

**Works with Claude Code, Codex, Cursor and [MT Code](https://munimtech.com/mt-code)**, or any other MCP client, with any model — no vision model is required for interaction.

**Built by [Munim Technologies](https://munimtech.com/computer-use)** as the Computer Use engine of MT Code, and published here on its own.

## Table of contents

- [Quick start](#quick-start)
- [Capability matrix](#capability-matrix)
- [Why it works well](#why-it-works-well)
- [Works alongside you](#works-alongside-you)
- [Tools](#tools-30)
- [Repository layout](#repository-layout)
- [Environment flags](#environment-flags)
- [Embedding in an app](#embedding-in-an-app)
- [Prompting your agent](#prompting-your-agent)
- [Contributing](#contributing)
- [Credits and license](#credits-and-license)

## Quick start

1. Download the latest binary for your platform from [Releases](https://github.com/munimtechnologies/munim-computer-use/releases/latest) (`munim-computer-use-macos-universal.zip`, `munim-computer-use-windows-x64.zip`) or [build from source](#build-from-source).
2. Put it somewhere on your `PATH` (`/usr/local/bin/munim-computer-use`, or `%LOCALAPPDATA%\Programs\munim-computer-use\munim-computer-use.exe`).
3. macOS only: run `munim-computer-use request-permissions` once to be prompted for Accessibility and Screen Recording.
4. Register it with your agent:

```sh
# Claude Code — fastest: the npm launcher fetches the signed binary on first run
claude mcp add munim-computer-use -- npx -y munim-computer-use
# or point at a downloaded binary
claude mcp add munim-computer-use -- /usr/local/bin/munim-computer-use
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.munim-computer-use]
command = "npx"
args = ["-y", "munim-computer-use"]
```

```json
// Cursor — .cursor/mcp.json
{ "mcpServers": { "munim-computer-use": { "command": "npx", "args": ["-y", "munim-computer-use"] } } }
```

Then ask: _"Open Safari, find the cheapest flight to Denver on Tuesday and put it in a note."_ The agent reads the UI with `get_app_state`, acts by element id, and verifies with `screenshot`.

## Capability matrix

**Munim Computer Use** is the highlighted first column; the others are the computer-use servers people reach for. each cell comes from that project's own README in September 2026 (sources under [Credits and license](#credits-and-license)). ✅ present · ❌ absent or not documented · ⚠️ partial.

| Capability                                  | **Munim Computer Use** | Codex Computer Use | Anthropic reference demo | Windows-MCP | MacOS-MCP | open-computer-use | computer-use-mcp (zavora) | Notes                                                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------- | ------------------ | ------------------------ | ----------- | --------- | ----------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                                       | **✅**                 | ✅                 | ❌                       | ❌          | ✅        | ✅                | ✅                        | The Anthropic demo drives a Linux desktop inside Docker, not your machine.                                                                                                                                                                      |
| Windows                                     | **✅**                 | ✅                 | ❌                       | ✅          | ❌        | ✅                | ✅                        | Windows-MCP is Windows only; MacOS-MCP is macOS only.                                                                                                                                                                                           |
| Linux                                       | **✅**                 | ❌                 | ✅ (sandbox)             | ❌          | ❌        | ✅                | ✅                        | Munim Computer Use uses AT-SPI + X11; native Wayland apps get element actions but not coordinate clicks.                                                                                                                                        |
| Accessibility tree with element ids         | **✅**                 | ❌                 | ❌                       | ✅          | ✅        | ✅                | ✅                        | Codex and the Anthropic demo are screenshot-driven. Ids let the agent press _the button_ instead of a pixel.                                                                                                                                    |
| Background input (your mouse never moves)   | **✅**                 | ✅                 | n/a                      | ❌          | ❌        | ❌                | ❌                        | Munim Computer Use addresses events to the target window: always on macOS (SkyLight and per-process events), for UI Automation patterns and classic Win32 controls on Windows; other Windows UI and all Linux pointer input (XTEST) still move the real pointer. Codex does this too, with a second cursor of its own. Every other server in this table drives the real cursor. |
| Agent pointer overlay                       | **✅**                 | ✅                 | ❌                       | ⚠️          | ❌        | ❌                | ❌                        | Windows-MCP flashes a border around captures; Codex draws its own cursor on your screen.                                                                                                                                                        |
| Zoom into a region at full resolution       | **✅**                 | ❌                 | ✅                       | ❌          | ❌        | ❌                | ❌                        | Anthropic's toolset has `zoom`; here it is a tool on every platform.                                                                                                                                                                            |
| Screenshots carry screen-coordinate mapping | **✅**                 | n/a                | n/a                      | ❌          | ❌        | ❌                | ❌                        | Origin and pixels-per-point in every capture, so clicks from Retina or downscaled images land.                                                                                                                                                  |
| Hover, wait, label query                    | **✅**                 | ⚠️                 | ⚠️                       | ✅          | ⚠️        | ❌                | ⚠️                        | Windows-MCP has Wait/WaitFor; MacOS-MCP has Wait; Anthropic has `wait`/`mouse_move`.                                                                                                                                                            |
| Your signed-in Chrome, own tab group or yours | **✅**                 | ⚠️                 | ❌                       | ⚠️          | ❌        | ❌                | ❌                        | Codex uses its in-app browser; Windows-MCP reads the DOM of open browsers. Munim Computer Use opens its own labelled tab group in your real Chrome, and can also take over a tab you already have open when you ask it to.                                                                 |
| Works with any MCP client                   | **✅**                 | ❌                 | ❌                       | ✅          | ✅        | ✅                | ✅                        | Codex Computer Use is Codex only; the Anthropic demo is Claude only.                                                                                                                                                                            |
| Identical tool surface on every platform    | **✅**                 | n/a                | n/a                      | n/a         | n/a       | ⚠️                | ✅                        | 30 tools with byte-identical schemas across the Swift and Rust servers.                                                                                                                                                                         |
| Prebuilt signed binaries + npm launcher     | **✅**                 | ✅                 | ❌                       | ❌          | ❌        | ✅ (npm)          | ✅ (npm)                  | macOS universal (Developer ID signed) and Windows x64 on Releases.                                                                                                                                                                              |
| Open source                                 | **✅ Apache-2.0**      | ❌                 | ✅                       | ✅ MIT      | ✅ MIT    | ✅ MIT            | ✅ MIT                    |                                                                                                                                                                                                                                                 |

Also looked at: [mediar-ai/mcp-server-macos-use](https://github.com/mediar-ai/mcp-server-macos-use) (macOS, accessibility, real input), [deploymenttheory/windows-mcp-server](https://github.com/deploymenttheory/windows-mcp-server) (Windows, UIA Invoke patterns, WaitFor), [nuphus-mcp](https://github.com/mrpulor-gh/nuphus-mcp) (OCR + bring-your-own vision model, CDP Chrome), [computer-control-mcp](https://github.com/AB498/computer-control-mcp) (PyAutoGUI + OCR), and [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) (browser only). Corrections welcome — open an issue with a link.

## Why it works well

- **Accessibility first, pixels second.** `get_app_state` returns the app's accessibility tree with stable element ids, so the agent presses _the button_ instead of guessing at a coordinate. It costs a fraction of the tokens of a screenshot and it is what scores highest on OSWorld-style tasks. Screenshots are for verifying and for content the tree cannot describe.
- **Background control.** Events are addressed to the target window (SkyLight on macOS, UI Automation patterns and posted window messages on Windows). On macOS the agent never takes your mouse or keyboard; see [Works alongside you](#works-alongside-you) for the exact guarantee on each platform.
- **Pointer overlay, not your pointer.** A soft lavender agent pointer shows where the agent is acting. Your cursor is untouched.
- **Coordinates that land.** Every screenshot and zoom carries its screen origin and pixels-per-point. `zoom` captures any region at full physical resolution.
- **Your browser, your logins.** The Chrome extension gives the agent its own labelled tab group in your signed-in Chrome, and leaves your tabs alone unless you point it at one.
- **Or the tab you already have open.** `browser_list_tabs all=true` shows every tab in the browser and `browser_use_tab` takes one over in place — useful when the page is already signed in or mid-flow and re-opening the URL would throw that away. An adopted tab is not moved into the agent's group, not activated and not reloaded; cleanup releases it rather than closing it, and `browser_release_tab` hands it back early.
- **Model-agnostic.** No vision model is required for interaction; local models work too.
- **Look → act → verify.** `hover` for mouse-over menus, `wait` for loads, `query` to find a control by label without reading a whole tree.

## Works alongside you

The agent has its own pointer; yours stays yours.

**macOS — guaranteed.** Every action goes through accessibility (press, set value, select text, show menu, scroll bars) or through events addressed to the target app's process and window. The server never moves your pointer, never posts into the system-wide input stream, and never holds or blocks your input, so you can keep clicking and typing in other apps while the agent works — even in the same app, on another window. Events come from a private source, so a modifier you are holding does not leak into the agent's clicks. The target app may be brought forward when that is the point of the step (`activate_app`, or handing you a password field), but not on every action.

The exceptions refuse instead of borrowing your pointer: a click, hover or scroll with no target app (coordinates over the desktop before any `get_app_state`), and drags that leave the source window (between apps, or onto the desktop). The error says what to pass instead.

**Windows — best effort, reported.** Element presses (Invoke), `set_value`, `select_text` and scrolling through UI Automation's ScrollPattern never touch your pointer, and classic Win32 controls also take clicks, hovers, wheel and drags as posted window messages. Other UI (Chromium, Electron, WPF, UWP) only reacts to real mouse input, so those clicks, hovers and drags move your pointer, and `type_text`/`press_key` go to the focused window. Whenever the real pointer was used, the result says `via cursor`.

**Linux — pointer actions use it.** XTEST input moves the real pointer and goes to the focused window, and results say `via cursor`. Element actions through AT-SPI (press, set value, insert text, select) do not move it.

## Tools (30)

| Area    | Tools                                                                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See     | `list_apps`, `get_app_state` (with `query`), `screenshot`, `zoom`, `list_displays`                                                                                                                         |
| Act     | `click`, `right_click`, `hover`, `drag`, `scroll`, `type_text`, `set_value`, `select_text`, `press_key`, `activate_app`, `wait`                                                                            |
| Clipboard | `clipboard_read`, `clipboard_write` (plain text)                                                                                                                                                         |
| Browser | `browser_open_tab`, `browser_list_tabs`, `browser_use_tab`, `browser_release_tab`, `browser_select_tab`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_close_tab`, `browser_close_all_tabs` |

Names, argument shapes and descriptions are identical on every platform, and CI enforces it (`node scripts/check-tool-parity.mjs`); a model that learned them on a Mac needs nothing new on Windows.

## Repository layout

| Directory           | What                                                                   | Build                                                             |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `macos/`            | Swift server on the Accessibility API and ScreenCaptureKit (macOS 14+) | `swift build -c release` → `.build/release/munim-computer-use`          |
| `windows-linux/`    | Rust server: UI Automation on Windows, AT-SPI + X11 on Linux           | `cargo build --release` → `target/release/munim-computer-use`           |
| `chrome-extension/` | Chrome extension + native messaging host for the `browser_*` tools     | Load unpacked; `sh install.sh` / `install.ps1` registers the host; `node background.test.mjs` |
| `Dockerfile`        | Headless Linux build of the Rust server for registry introspection (Glama and similar); no desktop control inside a container | `docker build -t munim-computer-use .` |

### Build from source

```sh
# macOS
cd macos && swift build -c release
# Windows / Linux
cd windows-linux && cargo build --release
```

Linux notes: element actions work everywhere; coordinate clicks need an X11 or XWayland client, since native Wayland apps do not expose absolute geometry.

### Chrome extension (optional)

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `chrome-extension/`.
2. Register the native messaging host: `sh chrome-extension/install.sh` (macOS/Linux) or `powershell -File chrome-extension/install.ps1` (Windows). Point `COMPUTER_USE_PATH` at the binary if it is not in the default build location.
3. The binary can also register itself for its current identity: `munim-computer-use install-native-host` (see [Embedding](#embedding-in-an-app)).

## Environment flags

| Variable                                   | Effect                                                          |
| ------------------------------------------ | --------------------------------------------------------------- |
| `COMPUTER_USE_BROWSER=0`                   | Hide the `browser_*` tools                                      |
| `COMPUTER_USE_AGENT_CURSOR=0`              | Do not draw the agent pointer                                   |
| `COMPUTER_USE_AGENT_CURSOR_TASK_FADE_SECS` | How long the pointer stays after the last tool call (default 8) |
| `COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT=1`  | Allow typing into password fields (refused by default)          |

## Embedding in an app

An app can ship this binary inside its own bundle and run it under its own identity, so it never shares a browser bridge, agent-cursor app or native-messaging host with a standalone install on the same machine. [MT Code](https://github.com/munimtechnologies/mtcode) does exactly this. Pass a profile, either as a JSON object or a path to a JSON file, with `--profile <json|file>` (any position) or `COMPUTER_USE_PROFILE`:

```json
{
  "name": "example-desktop",
  "envPrefix": "EXAMPLE_DESKTOP_",
  "agentCursorName": "ExampleAgentCursor",
  "agentCursorBundleId": "com.example.agent-cursor",
  "nativeHostNames": ["com.example.desktop"],
  "extensionIds": ["abcdefghijklmnopabcdefghijklmnop"],
  "nativeHostDescription": "Example desktop control bridge"
}
```

| Key                                        | Default                                                            | Meaning                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `name`                                     | none (standalone paths)                                            | Moves the support dir, bridge socket and Windows pipe under this name                                |
| `supportDir`                               | `~/Library/Application Support/computer-use`, `$XDG_DATA_HOME/munim-computer-use`, `%LOCALAPPDATA%\munim-computer-use` | Native-host wrapper, profile copy; on macOS also the bridge socket and a bare build's overlay app |
| `bridgeSocket`                             | `<supportDir>/bridge.sock` (macOS), `$XDG_RUNTIME_DIR/<name>/bridge.sock` (Linux), `<name>-bridge-<user>` pipe (Windows) | Where the MCP server and the Chrome relay meet                                     |
| `envPrefix`                                | none                                                               | Tunables are read as `<prefix>BROWSER`, `<prefix>AGENT_CURSOR`, … before `COMPUTER_USE_*`           |
| `agentCursorName` / `agentCursorBundleId`  | `MunimAgentCursor` / `com.munimtech.computer-use.agent-cursor`     | The pointer overlay's app, executable and window-class name, and its macOS bundle id                 |
| `historyDir`                               | none                                                               | Default `--root` for `computer-history`                                                              |
| `nativeHostNames` / `extensionIds`         | `com.munim.mtcode.desktop`, `com.munimtech.computer-use.desktop` / `kgdolgnijopbghhomnblabjkmjhnoage` | What `install-native-host` registers, and for which extension                   |

Each of `supportDir`, `bridgeSocket`, `envPrefix`, `agentCursorName`, `agentCursorBundleId` and `historyDir` can also be overridden by `COMPUTER_USE_<SNAKE_CASE>` (for example `COMPUTER_USE_SUPPORT_DIR`), which wins over the profile. `munim-computer-use identity` prints the resolved values.

- **Browser bridge.** Run `munim-computer-use install-native-host` with the same profile. It writes a wrapper that relays Chrome into this identity's bridge (replaying the profile), and a host manifest for each name in every Chrome/Chromium profile directory (the registry on Windows). It rewrites nothing that is already current, so an app can call it on every launch.
- **Extension.** Use the stock extension, or build a variant with its own host names, tab-group title and key: `node scripts/build-extension.mjs --out <dir> --host com.example.desktop --group-title "Example" --key <base64>`. It prints the variant's extension id for `extensionIds`.
- **macOS permissions.** The MCP server is a bare executable, so Accessibility and Screen Recording are granted to the app that spawns it. Only the agent-cursor overlay has a bundle of its own; ship `<agentCursorName>.app` (a copy of the binary plus an `LSUIElement` Info.plist) beside the binary, or it is materialised under `supportDir` on first use.

## Prompting your agent

Look → act → verify. `get_app_state` for ids, act by id, then `get_app_state` or `screenshot` again before the next step. Use `zoom` for small text, `hover` for menus that appear on mouse-over, `wait` after loads, keyboard shortcuts for stubborn widgets. The system-prompt text MT Code gives its agents lives in [`CodexDeveloperInstructions.ts`](https://github.com/munimtechnologies/mtcode/blob/main/apps/server/src/provider/CodexDeveloperInstructions.ts) and is a good starting point.

## Contributing

This repository mirrors the `native/` tree of [munimtechnologies/mtcode](https://github.com/munimtechnologies/mtcode), where the server is developed and shipped inside MT Code. Issues and discussions are welcome here; code changes land in mtcode first and are synced.

## Credits and license

Designed and built by [Munim Technologies](https://munimtech.com) (Munim, Inc.) for MT Code. Copyright 2026 Munim, Inc. Licensed under the Apache License 2.0; see `LICENSE`.

Comparison sources: [Codex Computer Use](https://openai.com/index/codex-for-almost-everything/) · [Anthropic computer-use demo](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo) · [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) · [CursorTouch/MacOS-MCP](https://github.com/CursorTouch/MacOS-MCP) · [QwenLM/open-computer-use](https://github.com/QwenLM/open-computer-use) · [zavora-ai/computer-use-mcp](https://github.com/zavora-ai/computer-use-mcp) · [mediar-ai/mcp-server-macos-use](https://github.com/mediar-ai/mcp-server-macos-use) · [deploymenttheory/windows-mcp-server](https://github.com/deploymenttheory/windows-mcp-server) · [nuphus-mcp](https://github.com/mrpulor-gh/nuphus-mcp) · [computer-control-mcp](https://github.com/AB498/computer-control-mcp) · [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)
