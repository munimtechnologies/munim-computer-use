//! Desktop-control MCP server for Windows and Linux.
//!
//! The macOS half of this feature is a Swift package (`macos`)
//! built on the Accessibility API. This crate covers the other two platforms
//! and speaks the identical MCP dialect — same tool names, same argument shapes,
//! same tool text — so a model needs no per-platform knowledge.
//!
//! Transport is newline-delimited JSON-RPC over stdio, which is what the MCP
//! stdio transport expects. stdout carries protocol only; anything diagnostic
//! goes to stderr so it cannot corrupt a response.

// The tool list is one `json!` literal (see tools.rs); it outgrew the default.
#![recursion_limit = "512"]

mod apps;
mod bridge_diag;
mod browser;
mod capture;
mod clipboard;
mod cursor;
mod history;
mod host_check;
mod identity;
mod install;
// Only the Windows and Linux backends press keys; macOS builds compile this for tests.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
mod keys;
mod live;
mod platform;
mod policy;
#[cfg(windows)]
mod secure_desktop;
mod settle;
mod tools;

use std::io::{self, BufRead, Write};

use base64::Engine as _;
use serde_json::{Value, json};

use platform::outline::OcrMode;
use platform::{Desktop, DesktopError, Point, ScrollDirection, StateOptions};

/// Protocol revisions this server speaks, newest first. The tool surface is the
/// same in all of them; a client asking for one gets it echoed back.
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// Answered to clients that ask for anything else, including older drafts.
const FALLBACK_PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "mt-desktop";
const SERVER_TITLE: &str = "Munim Computer Use";
const SERVER_WEBSITE: &str = "https://munimtech.com/munim-computer-use";
const SERVER_VERSION: &str = "0.9.3";

/// Keeps the agent pointer up for the duration of a `tools/call`, then
/// schedules a fade once Computer Use tools stop for the task.
#[cfg(any(windows, target_os = "linux"))]
struct DesktopToolGuard;

#[cfg(any(windows, target_os = "linux"))]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(any(windows, target_os = "linux"))]
static DESKTOP_TOOL_DEPTH: AtomicUsize = AtomicUsize::new(0);

#[cfg(any(windows, target_os = "linux"))]
impl DesktopToolGuard {
    fn enter() -> Self {
        if DESKTOP_TOOL_DEPTH.fetch_add(1, Ordering::SeqCst) == 0 {
            platform::agent_cursor::AgentCursor::shared().note_desktop_tool_started();
        }
        Self
    }
}

#[cfg(any(windows, target_os = "linux"))]
impl Drop for DesktopToolGuard {
    fn drop(&mut self) {
        if DESKTOP_TOOL_DEPTH.fetch_sub(1, Ordering::SeqCst) == 1 {
            platform::agent_cursor::AgentCursor::shared().note_desktop_tool_finished();
        }
    }
}

fn main() {
    // `--profile` may appear anywhere; it is consumed here so every mode below
    // (server, native host, history recorder) runs under the same identity.
    let args = identity::init_from_args(std::env::args().collect());
    let mode = args.get(1).map(String::as_str);
    // Before any window exists: screenshots and clicks must share one
    // coordinate space at every display scale.
    #[cfg(windows)]
    platform::windows::use_physical_pixels();

    // Chrome spawns this same binary as its native messaging host; in that mode
    // the process is a relay, not a server.
    if mode == Some("native-host") {
        if let Err(error) = browser::run_native_host() {
            eprintln!("munim-computer-use: native host stopped: {error}");
        }
        return;
    }

    #[cfg(windows)]
    if let Some(code) = mode.and_then(secure_desktop::run) {
        std::process::exit(code);
    }

    if mode == Some("install-native-host") {
        std::process::exit(install::run(&args[2..]));
    }

    // Retrace Chrome's host lookup and launch, for "host not found" reports.
    if mode == Some("check-native-host") {
        std::process::exit(host_check::run(&args[2..]));
    }

    // Print the resolved identity (paths, names) as JSON, for embedders to check.
    if mode == Some("identity") {
        println!("{:#}", identity::get().describe());
        return;
    }

    if mode == Some("computer-history") {
        let mut root: Option<std::path::PathBuf> = identity::get().history_dir.clone();
        let mut rest = args.iter().skip(2);
        while let Some(arg) = rest.next() {
            if arg == "--root" {
                root = rest.next().map(std::path::PathBuf::from);
            }
        }
        let Some(root) = root else {
            eprintln!("munim-computer-use: computer-history requires --root <dir> (or a historyDir in the profile)");
            std::process::exit(2);
        };
        if let Err(error) = history::run(root) {
            eprintln!("munim-computer-use: computer-history stopped: {error}");
            std::process::exit(1);
        }
        return;
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    // A backend failure must not kill the process: `initialize` and `tools/list`
    // still have to answer so the client can surface a useful error, and the
    // reason is far more actionable than a closed pipe.
    let mut desktop = match platform::backend() {
        Ok(backend) => Some(backend),
        Err(error) => {
            eprintln!("munim-computer-use: desktop backend unavailable: {error}");
            None
        }
    };
    // Said once up front for whoever reads the log; the tools repeat it on
    // the results it explains.
    if let Some(warning) = platform::desktop_access_warning() {
        eprintln!("munim-computer-use: warning: {warning}");
    }
    let mut browser = if tools::browser_control_enabled() {
        browser::BrowserBridge::new()
    } else {
        browser::BrowserBridge::inert()
    };

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("munim-computer-use: stdin closed: {error}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("munim-computer-use: malformed JSON: {error}");
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": {
                        "code": -32700,
                        "message": format!("Parse error: {error}")
                    }
                });
                if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                    break;
                }
                continue;
            }
        };

        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        // Notifications carry no id and must never be answered.
        let Some(id) = request.get("id").cloned() else {
            if method == "notifications/cancelled" {
                #[cfg(any(windows, target_os = "linux"))]
                platform::agent_cursor::AgentCursor::shared().hide();
            }
            continue;
        };
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut params = request.get("params").cloned().unwrap_or(json!({}));

        #[cfg(any(windows, target_os = "linux"))]
        let _tool_guard = (method == "tools/call").then(|| DesktopToolGuard::enter());

        // A remote viewer's captures and input go to the secure desktop helper
        // while a UAC or lock-screen prompt has the screen.
        #[cfg(windows)]
        let routed = (method == "tools/call" && identity::remote_control())
            .then(|| secure_desktop::route(&mut params))
            .flatten();
        #[cfg(not(windows))]
        let routed: Option<Value> = None;

        let outcome = match routed {
            Some(result) => Ok(result),
            None => dispatch(&method, &params, desktop.as_deref_mut(), &mut browser),
        };
        let response = match outcome {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": error.0, "message": error.1 }
            }),
        };

        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            break;
        }
    }

    // Best-effort: drop the agent Chrome tab group when this MCP process exits
    // so unfinished Computer Use turns do not leave an empty group behind.
    if tools::browser_control_enabled() && browser.is_connected() {
        let _ = browser.call("close_client_tabs", &json!({}));
    }

    #[cfg(any(windows, target_os = "linux"))]
    platform::agent_cursor::AgentCursor::shared().hide();
}

/// Echo the client's protocol version when it is one we speak, else fall back.
fn negotiate_protocol_version(params: &Value) -> &'static str {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    SUPPORTED_PROTOCOL_VERSIONS
        .iter()
        .copied()
        .find(|version| Some(*version) == requested)
        .unwrap_or(FALLBACK_PROTOCOL_VERSION)
}

/// A JSON-RPC level failure: the request itself was unusable.
struct RpcError(i64, String);

fn method_not_found(method: &str) -> RpcError {
    RpcError(-32601, format!("unknown method '{method}'"))
}

fn dispatch(
    method: &str,
    params: &Value,
    desktop: Option<&mut (dyn Desktop + '_)>,
    browser: &mut browser::BrowserBridge,
) -> Result<Value, RpcError> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": negotiate_protocol_version(params),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": {
                "name": SERVER_NAME,
                "title": SERVER_TITLE,
                "version": SERVER_VERSION,
                "websiteUrl": SERVER_WEBSITE
            },
            "instructions": tools::SERVER_INSTRUCTIONS
        })),
        "tools/list" => Ok(json!({ "tools": tools::tool_defs() })),
        "tools/call" => Ok(call_tool(params, desktop, browser)),
        // Ping is part of the base protocol and some clients probe with it.
        "ping" => Ok(json!({})),
        other => Err(method_not_found(other)),
    }
}

/// Tool failures are reported inside the result as `isError`, not as JSON-RPC
/// errors, so the model reads them as feedback and can retry differently.
fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({
        "isError": is_error,
        "content": [{ "type": "text", "text": text.into() }]
    })
}

fn image_result(bytes: Vec<u8>, mime_type: &str, caption: String) -> Value {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    json!({
        "isError": false,
        "content": [
            { "type": "text", "text": caption },
            { "type": "image", "data": encoded, "mimeType": mime_type }
        ]
    })
}

/// Captures leave the pointer out. MT Code's Computer View passes
/// `cursor: true` on display screenshots and draws the returned shape as the
/// viewer's own cursor. Deliberately not in the tool schema: it serves that
/// viewer, not agents.
fn with_cursor(mut result: Value, args: &Value) -> Value {
    if args.get("cursor").and_then(Value::as_bool) == Some(true)
        && let Some(cursor) = cursor::current()
        && let Some(content) = result.get_mut("content").and_then(Value::as_array_mut)
    {
        content.push(json!({ "type": "text", "text": format!("cursor: {cursor}") }));
    }
    result
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn arg_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

fn arg_f64(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(Value::as_f64)
}

/// Parse an `e12`-style element id into its numeric handle.
fn element_id(raw: &str) -> Result<u32, DesktopError> {
    raw.trim()
        .trim_start_matches(['e', 'E'])
        .parse::<u32>()
        .map_err(|_| {
            DesktopError::new(format!(
                "'{raw}' is not an element id — pass one from get_app_state, like e12"
            ))
        })
}

/// Resolve the element-or-coordinates pair the pointer tools accept.
fn point_from(args: &Value, element_key: &str, x_key: &str, y_key: &str) -> Result<Point, DesktopError> {
    if let Some(raw) = arg_str(args, element_key) {
        return Ok(Point::Element(element_id(raw)?));
    }
    match (arg_f64(args, x_key), arg_f64(args, y_key)) {
        (Some(x), Some(y)) => Ok(Point::Screen(x, y)),
        _ => Err(DesktopError::new(format!(
            "provide {element_key} from get_app_state, or both {x_key} and {y_key}"
        ))),
    }
}

fn call_tool(
    params: &Value,
    desktop: Option<&mut (dyn Desktop + '_)>,
    browser: &mut browser::BrowserBridge,
) -> Value {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    if name == "run_steps" {
        return run_steps(&args, desktop, browser);
    }

    if let Some(rest) = name.strip_prefix("browser_") {
        if !tools::browser_control_enabled() {
            return text_result(
                "error: browser control is disabled in Computer Use settings",
                true,
            );
        }
        return match browser.call(rest, &args) {
            Ok(text) => text_result(text, false),
            Err(error) => text_result(format!("error: {error}"), true),
        };
    }

    // Display listing and whole-display screenshots need no accessibility
    // backend, so answer them even when the backend failed to start — they help
    // diagnose a headless session.
    if name == "list_displays" {
        return match capture::list_displays() {
            Ok(text) => text_result(text, false),
            Err(error) => text_result(format!("error: {error}"), true),
        };
    }
    if name == "screenshot"
        && let Some(result) = display_screenshot(&args)
    {
        return result;
    }
    // Zoom and wait need neither accessibility nor a window: keep them usable
    // when the backend failed to start, like display screenshots.
    if name == "zoom" {
        return match zoom_region(&args) {
            Ok(value) => value,
            Err(error) => text_result(format!("error: {error}"), true),
        };
    }
    // The clipboard needs no accessibility backend either.
    if name == "clipboard_read" {
        let max_chars = arg_i64(&args, "max_chars")
            .unwrap_or(clipboard::DEFAULT_MAX_CHARS as i64)
            .clamp(1, clipboard::MAX_CHARS_LIMIT as i64) as usize;
        return match clipboard::read() {
            Ok(text) => text_result(clipboard::describe_read(text, max_chars), false),
            Err(error) => text_result(format!("error: {error}"), true),
        };
    }
    if name == "clipboard_write" {
        let Some(text) = arg_str(&args, "text") else {
            return text_result("error: missing required argument 'text'", true);
        };
        return match clipboard::write(text) {
            Ok(()) => text_result(
                format!(
                    "copied {} characters to the clipboard, replacing what was there",
                    text.chars().count()
                ),
                false,
            ),
            Err(error) => text_result(format!("error: {error}"), true),
        };
    }
    if name == "wait" {
        return match wait_seconds(&args) {
            Ok(text) => text_result(text, false),
            Err(error) => text_result(format!("error: {error}"), true),
        };
    }

    let Some(desktop) = desktop else {
        return text_result(
            "error: the desktop backend is unavailable on this host — see stderr for the reason",
            true,
        );
    };

    match run_desktop_tool(&name, &args, desktop) {
        Ok(value) => value,
        Err(error) => text_result(format!("error: {error}"), true),
    }
}

/// The most steps one `run_steps` call may hold.
const MAX_STEPS: usize = 20;

/// Check a `run_steps` list before anything runs, so a typo in step 4 cannot
/// leave steps 1–3 done and the rest not. Returns each step's tool and the
/// arguments it will get: `return_state` belongs to the batch, so it is taken
/// off every step and handed to the last one.
fn plan_steps(args: &Value) -> Result<Vec<(String, Value)>, String> {
    let Some(steps) = args.get("steps").and_then(Value::as_array) else {
        return Err("steps must be a list of {\"tool\": name, \"args\": {...}}".to_string());
    };
    if steps.is_empty() {
        return Err("steps is empty — give at least one step".to_string());
    }
    if steps.len() > MAX_STEPS {
        return Err(format!("{} steps is more than the {MAX_STEPS} one call may run — split them", steps.len()));
    }
    let known: Vec<String> = match tools::tool_defs() {
        Value::Array(defs) => defs
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    let mut plan = Vec::with_capacity(steps.len());
    for (index, step) in steps.iter().enumerate() {
        let number = index + 1;
        let Some(tool) = step.get("tool").and_then(Value::as_str) else {
            return Err(format!("step {number} has no tool — each step is {{\"tool\": name, \"args\": {{...}}}}"));
        };
        if tool == "run_steps" {
            return Err(format!("step {number}: run_steps cannot contain run_steps"));
        }
        if !known.iter().any(|name| name == tool) {
            return Err(format!("step {number}: unknown tool '{tool}'"));
        }
        let mut step_args = match step.get("args") {
            None | Some(Value::Null) => json!({}),
            Some(Value::Object(map)) => Value::Object(map.clone()),
            Some(_) => return Err(format!("step {number} ({tool}): args must be an object")),
        };
        if let Some(map) = step_args.as_object_mut() {
            map.remove("return_state");
            map.remove("state_query");
        }
        plan.push((tool.to_string(), step_args));
    }
    if args.get("return_state").and_then(Value::as_bool) == Some(true)
        && let Some((_, last)) = plan.last_mut()
        && let Some(map) = last.as_object_mut()
    {
        map.insert("return_state".to_string(), json!(true));
        if let Some(query) = args.get("state_query").filter(|query| query.is_string()) {
            map.insert("state_query".to_string(), query.clone());
        }
    }
    Ok(plan)
}

/// Run each step through `call_tool`, so a step gets exactly the checks a
/// direct call would, and stop at the first one that fails. Every step's
/// output is kept, labelled with its number, images included.
fn run_steps(
    args: &Value,
    mut desktop: Option<&mut (dyn Desktop + '_)>,
    browser: &mut browser::BrowserBridge,
) -> Value {
    let plan = match plan_steps(args) {
        Ok(plan) => plan,
        Err(error) => return text_result(format!("error: {error}; nothing was run"), true),
    };
    let total = plan.len();
    let mut content: Vec<Value> = Vec::new();
    let mut failed: Option<(usize, String)> = None;
    for (index, (tool, step_args)) in plan.into_iter().enumerate() {
        let number = index + 1;
        let result = call_tool(
            &json!({ "name": tool, "arguments": step_args }),
            desktop.as_deref_mut(),
            browser,
        );
        // The step's first text leads, labelled; its images and any further
        // text follow in their own order.
        let mut items = result.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
        let first_text = items.iter().position(|item| item.get("type").and_then(Value::as_str) == Some("text"));
        let text = first_text
            .map(|at| items.remove(at))
            .and_then(|item| item.get("text").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| "done".to_string());
        content.push(json!({ "type": "text", "text": format!("{number}. {tool}: {text}") }));
        content.extend(items);
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            failed = Some((number, tool));
            break;
        }
    }
    let summary = match &failed {
        None => format!("ran all {total} step{}", if total == 1 { "" } else { "s" }),
        Some((number, tool)) if *number == total => format!("step {number} of {total} ({tool}) failed"),
        Some((number, tool)) if number + 1 == total => {
            format!("stopped at step {number} of {total}: {tool} failed, so step {total} did not run")
        }
        Some((number, tool)) => {
            format!("stopped at step {number} of {total}: {tool} failed, so steps {}–{total} did not run", number + 1)
        }
    };
    content.insert(0, json!({ "type": "text", "text": summary }));
    json!({ "isError": failed.is_some(), "content": content })
}

/// A whole-display screenshot (`display` set), live or one-shot. None when the
/// request names no display. Shared with the secure desktop helper.
fn display_screenshot(args: &Value) -> Option<Value> {
    let display = arg_i64(args, "display")?;
    let max_width = arg_i64(args, "max_width")
        .unwrap_or(capture::DEFAULT_MAX_WIDTH as i64)
        .clamp(0, 8000) as u32;
    let format = match capture::CaptureFormat::parse(arg_str(args, "format"), arg_i64(args, "quality")) {
        Ok(format) => format,
        Err(error) => return Some(text_result(format!("error: {error}"), true)),
    };
    let Ok(index) = usize::try_from(display) else {
        return Some(text_result("error: display index must be zero or greater", true));
    };
    if args.get("live").and_then(Value::as_bool) == Some(true) {
        let request = live::LiveRequest {
            display: index,
            max_width,
            format,
            after: args.get("after").and_then(Value::as_u64),
            wait_ms: arg_i64(args, "wait_ms")
                .unwrap_or(i64::from(live::DEFAULT_WAIT_MS))
                .clamp(0, i64::from(live::MAX_WAIT_MS)) as u32,
            pointer: args.get("cursor").and_then(Value::as_bool) == Some(true),
        };
        match live::frame(&request) {
            Ok(live::LiveFrame::Changed { capture, seq }) => {
                let text = capture::caption(&capture, &format!("display {index}"));
                let mut result = image_result(capture.bytes, format.mime_type(), text);
                if let Some(content) = result.get_mut("content").and_then(Value::as_array_mut) {
                    content.push(json!({ "type": "text", "text": live::live_line(seq, true) }));
                }
                return Some(with_cursor(result, args));
            }
            Ok(live::LiveFrame::Unchanged { seq }) => {
                return Some(with_cursor(text_result(live::live_line(seq, false), false), args));
            }
            Err(live::LiveError::Failed(error)) => return Some(text_result(format!("error: {error}"), true)),
            // No live path here: an ordinary capture, without the live line,
            // tells the viewer to keep polling.
            Err(live::LiveError::Unsupported) => {}
        }
    }
    Some(match capture::capture_display(index, max_width, format) {
        Ok(capture) => {
            let text = capture::caption(&capture, &format!("display {index}"));
            with_cursor(image_result(capture.bytes, format.mime_type(), text), args)
        }
        Err(error) => text_result(format!("error: {error}"), true),
    })
}

fn zoom_region(args: &Value) -> Result<Value, DesktopError> {
    let coordinate = |key: &str| {
        args.get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| {
                DesktopError::new(
                    "zoom needs x0, y0, x1, y1 in screen coordinates (the space click uses)",
                )
            })
    };
    let (x0, y0, x1, y1) = (coordinate("x0")?, coordinate("y0")?, coordinate("x1")?, coordinate("y1")?);
    let max_width = arg_i64(args, "max_width")
        .unwrap_or(capture::DEFAULT_MAX_WIDTH as i64)
        .clamp(0, 8000) as u32;
    let format = capture::CaptureFormat::parse(arg_str(args, "format"), arg_i64(args, "quality"))?;
    let capture = capture::capture_region(x0, y0, x1, y1, max_width, format)?;
    let text = capture::caption(&capture, "zoomed region");
    Ok(image_result(capture.bytes, format.mime_type(), text))
}

/// Blocks the request loop on purpose: the client is waiting on this call, and
/// a pause the model asked for is exactly the time nothing else should happen.
fn wait_seconds(args: &Value) -> Result<String, DesktopError> {
    let requested = args.get("seconds").and_then(Value::as_f64).unwrap_or(1.0);
    if !requested.is_finite() || requested <= 0.0 {
        return Err(DesktopError::new("seconds must be a positive number"));
    }
    let seconds = requested.min(30.0);
    std::thread::sleep(std::time::Duration::from_secs_f64(seconds));
    Ok(format!(
        "waited {seconds:.1}s{}",
        if seconds < requested { " (capped at 30s)" } else { "" }
    ))
}

/// How many elements a read with a `query` may walk. The query narrows what is
/// printed, not what is read: walking only `max_elements` and then filtering
/// would miss every match past the cap and still report "no match" (#30).
/// `max_elements` caps the matches printed instead.
const QUERY_WALK_ELEMENTS: usize = 5000;

/// Narrow an accessibility outline to the lines that mention `query`, printing
/// at most `limit` of them. Element ids stay valid — the backend registered
/// every element while walking; only the printout is filtered. Section headers
/// (`── window`, `── on-screen text`) and the off-screen count are kept for
/// context. A walk that stopped at its element budget is reported as an
/// incomplete search, never as a definitive empty result.
fn filter_app_state(outline: &str, query: &str, limit: usize) -> String {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return outline.to_string();
    }
    let mut lines = outline.lines();
    let mut header: Vec<&str> = Vec::new();
    // The header runs until the first blank line; keep it whole.
    for line in lines.by_ref() {
        if line.is_empty() {
            break;
        }
        header.push(line);
    }
    let body: Vec<&str> = lines.collect();
    // The budget marker is indented to the depth the walk stopped at.
    let budget_marker = |line: &str| line.trim_start().starts_with("… truncated at ");
    let context = |line: &str| line.starts_with("── ") || (line.starts_with("… ") && !budget_marker(line));
    let incomplete = body.iter().any(|line| budget_marker(line));
    let skipped_offscreen = body.iter().any(|line| line.starts_with("… ") && line.contains("off-screen"));

    let mut count = 0;
    let mut shown: Vec<&str> = Vec::new();
    for line in body.iter().copied() {
        if context(line) {
            shown.push(line);
        } else if !budget_marker(line) && line.to_lowercase().contains(&needle) {
            count += 1;
            if count <= limit {
                shown.push(line);
            }
        }
    }

    let mut out = header.join("\n");
    out.push_str(&format!(
        "\nfilter: \"{}\" — {count} matching element{}",
        query.trim(),
        if count == 1 { "" } else { "s" }
    ));
    if count > limit {
        out.push_str(&format!(", showing the first {limit}; raise max_elements to see the rest"));
    }
    if incomplete {
        out.push_str(&format!(
            "\nnote: the read stopped at {QUERY_WALK_ELEMENTS} elements before the end of the app, so elements past \
             that point were not searched; read a smaller part of it (a dialog, or after closing other windows) to search the rest"
        ));
    }
    if count == 0 {
        // The section headers still say what was read: which window, and
        // which dialog scoped the read (#44).
        let sections: Vec<&str> = body.iter().copied().filter(|line| line.starts_with("── ")).collect();
        if !sections.is_empty() {
            out.push_str("\n\n");
            out.push_str(&sections.join("\n"));
        }
        out.push_str(if incomplete {
            "\n\n(no match among the elements read; the search is incomplete, so this does not mean the control is absent)"
        } else if skipped_offscreen {
            "\n\n(no on-screen element matches; off-screen elements were not searched: pass offscreen=true to include them, \
             or scroll the content into view)"
        } else {
            "\n\n(no elements match; drop the query or scroll the content into view)"
        });
    } else {
        out.push_str("\n\n");
        out.push_str(&shown.join("\n"));
    }
    out
}

/// The app and options of the latest `get_app_state`, which `return_state`
/// reads again after an action: element ids only ever come from that snapshot,
/// so it is the app the action was aimed at.
struct LastRead {
    app: String,
    options: StateOptions,
}

static LAST_READ: std::sync::Mutex<Option<LastRead>> = std::sync::Mutex::new(None);

/// Tools that act on an app and accept `return_state`.
const STATEFUL_ACTIONS: [&str; 9] = [
    "click",
    "type_text",
    "press_key",
    "scroll",
    "right_click",
    "drag",
    "set_value",
    "hover",
    "select_text",
];

/// `frontmost` names the app the user is looking at; anything else passes through.
fn resolve_app_query(app: &str) -> Result<String, DesktopError> {
    if !app.trim().eq_ignore_ascii_case("frontmost") {
        return Ok(app.to_string());
    }
    apps::list_apps()?
        .into_iter()
        .find(|info| info.frontmost)
        .map(|info| info.pid.to_string())
        .ok_or_else(|| DesktopError::new("no app is frontmost right now — call list_apps and pass one by name"))
}

/// Apply the user's app rules before reading, capturing or activating an app.
/// Enumerates windows only when there are rules to apply.
fn check_app_policy(desktop: &mut dyn Desktop, app: &str) -> Result<(), DesktopError> {
    let current = policy::current();
    if !current.has_app_rules() {
        return Ok(());
    }
    let pid = desktop.resolve_pid(app)?;
    match apps::list_apps().ok().and_then(|list| list.into_iter().find(|info| info.pid == pid)) {
        Some(info) => policy::check_app(&info.name, &info.id),
        None => policy::check_app(app, app),
    }
}

fn read_app_state(
    desktop: &mut dyn Desktop,
    app: &str,
    options: StateOptions,
    query: Option<&str>,
) -> Result<String, DesktopError> {
    let query = query.filter(|query| !query.trim().is_empty());
    let walk = match query {
        Some(_) => StateOptions { max_elements: QUERY_WALK_ELEMENTS, ..options },
        None => options,
    };
    let outline = desktop.get_app_state(app, &walk)?;
    *LAST_READ.lock().unwrap_or_else(|poison| poison.into_inner()) =
        Some(LastRead { app: app.to_string(), options });
    Ok(match query {
        Some(query) => filter_app_state(&outline, query, options.max_elements),
        None => outline,
    })
}

fn last_read() -> Option<(String, StateOptions)> {
    LAST_READ
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .map(|last| (last.app.clone(), last.options))
}

/// Start counting the events of the app `return_state` will read, before the
/// action runs. Only Windows has an event source; elsewhere this is `None` and
/// the settle is a fixed pause.
fn watch_for_state(desktop: &mut dyn Desktop) -> Option<settle::Watch> {
    if !cfg!(windows) {
        return None;
    }
    let (app, _) = last_read()?;
    settle::watch(desktop.resolve_pid(&app).ok()?)
}

/// The text `return_state` appends after an action.
fn state_after_action(desktop: &mut dyn Desktop, args: &Value, watch: Option<settle::Watch>) -> String {
    let Some((app, options)) = last_read() else {
        return "\n\n(return_state: no app has been read yet — call get_app_state first)".to_string();
    };
    settle::settle(watch);
    match read_app_state(desktop, &app, options, arg_str(args, "state_query")) {
        Ok(outline) => format!("\n\nstate after the action (earlier ids are no longer valid):\n{outline}"),
        Err(error) => format!("\n\n(return_state: could not read {app} again: {error})"),
    }
}

fn run_desktop_tool(
    name: &str,
    args: &Value,
    desktop: &mut dyn Desktop,
) -> Result<Value, DesktopError> {
    let wants_state =
        STATEFUL_ACTIONS.contains(&name) && args.get("return_state").and_then(Value::as_bool) == Some(true);
    let watch = if wants_state { watch_for_state(desktop) } else { None };
    let text = match name {
        "list_apps" => desktop.list_apps()?,
        "get_app_state" => {
            let app = arg_str(args, "app")
                .ok_or_else(|| DesktopError::new("missing required argument 'app'"))?;
            let app = resolve_app_query(app)?;
            check_app_policy(desktop, &app)?;
            let options = StateOptions {
                max_depth: arg_i64(args, "max_depth").unwrap_or(18).clamp(1, 60) as usize,
                max_elements: arg_i64(args, "max_elements").unwrap_or(800).clamp(1, 5000) as usize,
                offscreen: args.get("offscreen").and_then(Value::as_bool).unwrap_or(false),
                ocr: OcrMode::parse(arg_str(args, "ocr"))?,
            };
            read_app_state(desktop, &app, options, arg_str(args, "query"))?
        }
        "hover" => desktop.hover(point_from(args, "element_id", "x", "y")?)?,
        "activate_app" => {
            let app = arg_str(args, "app")
                .ok_or_else(|| DesktopError::new("missing required argument 'app'"))?;
            let app = resolve_app_query(app)?;
            check_app_policy(desktop, &app)?;
            match args.get("window_id").filter(|value| !value.is_null()) {
                None => desktop.activate_app(&app)?,
                Some(value) => {
                    let id = value.as_u64().ok_or_else(|| {
                        DesktopError::new("window_id must be the number after window_id= on a get_app_state window line")
                    })?;
                    desktop.activate_window(&app, id)?
                }
            }
        }
        "click" => {
            let count = arg_i64(args, "click_count").unwrap_or(1).clamp(1, 3) as u32;
            desktop.click(point_from(args, "element_id", "x", "y")?, count)?
        }
        "right_click" => desktop.right_click(point_from(args, "element_id", "x", "y")?)?,
        "drag" => {
            let from = point_from(args, "from_element_id", "from_x", "from_y")?;
            let to = point_from(args, "to_element_id", "to_x", "to_y")?;
            desktop.drag(from, to)?
        }
        "type_text" => {
            let text = arg_str(args, "text")
                .ok_or_else(|| DesktopError::new("missing required argument 'text'"))?;
            let element = arg_str(args, "element_id").map(element_id).transpose()?;
            desktop.type_text(text, element)?
        }
        "press_key" => {
            let key = arg_str(args, "key")
                .ok_or_else(|| DesktopError::new("missing required argument 'key'"))?;
            let modifiers: Vec<String> = args
                .get("modifiers")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            desktop.press_key(key, &modifiers)?
        }
        "scroll" => {
            let direction = ScrollDirection::parse(arg_str(args, "direction").unwrap_or("down"))?;
            let amount = arg_i64(args, "amount").unwrap_or(5).clamp(1, 100) as i32;
            let element = arg_str(args, "element_id").map(element_id).transpose()?;
            // The wheel acts wherever the pointer is. A remote viewer scrolling
            // over a particular pane sends its coordinates, so put the pointer
            // there first -- the same thing their own trackpad would do.
            if identity::remote_control()
                && element.is_none()
                && let (Some(x), Some(y)) = (arg_f64(args, "x"), arg_f64(args, "y"))
            {
                desktop.hover(Point::Screen(x, y))?;
            }
            desktop.scroll(direction, amount, element)?
        }
        "set_value" => {
            let element = element_id(
                arg_str(args, "element_id")
                    .ok_or_else(|| DesktopError::new("missing required argument 'element_id'"))?,
            )?;
            let value = arg_str(args, "value")
                .ok_or_else(|| DesktopError::new("missing required argument 'value'"))?;
            desktop.set_value(element, value)?
        }
        "select_text" => {
            let element = element_id(
                arg_str(args, "element_id")
                    .ok_or_else(|| DesktopError::new("missing required argument 'element_id'"))?,
            )?;
            let start = arg_i64(args, "start").unwrap_or(0).max(0) as usize;
            let length = arg_i64(args, "length").filter(|value| *value >= 0).map(|v| v as usize);
            if let Some(len) = length
                && start.checked_add(len).is_none()
            {
                return Err(DesktopError::new("start + length overflows"));
            }
            desktop.select_text(element, start, length)?
        }
        "screenshot" => {
            let max_width = arg_i64(args, "max_width")
                .unwrap_or(capture::DEFAULT_MAX_WIDTH as i64)
                .clamp(0, 8000) as u32;
            let format = capture::CaptureFormat::parse(arg_str(args, "format"), arg_i64(args, "quality"))?;
            if let Some(display) = arg_i64(args, "display") {
                let index = usize::try_from(display).map_err(|_| {
                    DesktopError::new("display index must be zero or greater")
                })?;
                let capture = capture::capture_display(index, max_width, format)?;
                let text = capture::caption(&capture, &format!("display {index}"));
                return Ok(with_cursor(image_result(capture.bytes, format.mime_type(), text), args));
            }
            let app = arg_str(args, "app").ok_or_else(|| {
                DesktopError::new("provide 'app' to capture a window, or 'display' for a whole screen")
            })?;
            let app = resolve_app_query(app)?;
            check_app_policy(desktop, &app)?;
            let pid = desktop.resolve_pid(&app)?;
            let (capture, title) = capture::capture_app_window(pid, max_width, format)?;
            let text = capture::caption(&capture, &format!("window of {app} \"{title}\""));
            return Ok(image_result(capture.bytes, format.mime_type(), text));
        }
        other => {
            return Err(DesktopError::new(format!("unknown tool '{other}'")));
        }
    };
    let text = if wants_state {
        text + &state_after_action(desktop, args, watch)
    } else {
        text
    };
    Ok(text_result(text, false))
}

#[cfg(test)]
mod tests {
    use super::{element_id, point_from, text_result};
    use crate::platform::Point;
    use serde_json::json;

    #[test]
    fn element_ids_accept_the_advertised_form() {
        assert_eq!(element_id("e12").unwrap(), 12);
        assert_eq!(element_id("E7").unwrap(), 7);
        // Bare numbers are tolerated because models often drop the prefix.
        assert_eq!(element_id("3").unwrap(), 3);
        assert!(element_id("button").is_err());
    }

    #[test]
    fn a_bad_element_id_names_the_tool_that_produces_them() {
        let message = element_id("nope").unwrap_err().0;
        assert!(message.contains("get_app_state"), "unhelpful: {message}");
    }

    #[test]
    fn points_prefer_element_ids_over_coordinates() {
        let args = json!({ "element_id": "e5", "x": 10.0, "y": 20.0 });
        assert!(matches!(
            point_from(&args, "element_id", "x", "y").unwrap(),
            Point::Element(5)
        ));
    }

    #[test]
    fn points_fall_back_to_coordinates() {
        let args = json!({ "x": 10.5, "y": 20.5 });
        match point_from(&args, "element_id", "x", "y").unwrap() {
            Point::Screen(x, y) => assert_eq!((x, y), (10.5, 20.5)),
            other => panic!("expected screen coordinates, got {other:?}"),
        }
    }

    #[test]
    fn a_lone_coordinate_is_rejected_rather_than_guessed() {
        // Clicking at (x, 0) because y was forgotten would be worse than an error.
        let args = json!({ "x": 10.0 });
        assert!(point_from(&args, "element_id", "x", "y").is_err());
    }

    #[test]
    fn app_state_filter_keeps_header_and_matching_rows() {
        let outline = "Finder [com.apple.finder] pid=1 frontmost=true windows=1\n\n── window 0: \"Docs\"\n  [e1] Button \"Save\"\n  [e2] Button \"Cancel\"\n       StaticText \"hello\"";
        let filtered = super::filter_app_state(outline, "save", 800);
        assert!(filtered.starts_with("Finder [com.apple.finder]"), "{filtered}");
        assert!(filtered.contains("filter: \"save\" — 1 matching element"), "{filtered}");
        assert!(filtered.contains("[e1] Button \"Save\""), "{filtered}");
        assert!(!filtered.contains("[e2]"), "{filtered}");
        assert!(filtered.contains("── window 0"), "{filtered}");
    }

    #[test]
    fn app_state_filter_keeps_section_headers_and_the_offscreen_count() {
        let outline = "App (pid 1), 1 window(s)\nnote: a dialog is open — only its controls are listed; dismiss it (for example with Escape) to reach the window behind\n\n── window 0: \"Main\"\n  [e1] Button \"Play\"\n… 12 off-screen elements skipped; scroll, or pass offscreen=true to list them\n\n── on-screen text (OCR)\n  [e2] Text \"Get Lucky\"\n  [e3] Text \"Daft Punk\"";
        let filtered = super::filter_app_state(outline, "lucky", 800);
        assert!(filtered.contains("note: a dialog is open"), "{filtered}");
        assert!(filtered.contains("── on-screen text (OCR)"), "{filtered}");
        assert!(filtered.contains("… 12 off-screen elements skipped"), "{filtered}");
        assert!(filtered.contains("[e2] Text \"Get Lucky\""), "{filtered}");
        assert!(filtered.contains("1 matching element"), "{filtered}");
        assert!(!filtered.contains("[e1]") && !filtered.contains("[e3]"), "{filtered}");
    }

    // #44: a query that matches nothing must not hide which dialog scoped the read.
    #[test]
    fn app_state_filter_without_a_match_still_names_the_dialog() {
        let outline = "Chrome (pid 1), 1 window(s)\nnote: a dialog is open — only its controls are listed: Window \"Confirm\" in window 0; dismiss it (for example with Escape) to reach the window behind\n\n── window 0: \"Doc - Google Chrome\"  window_id=7 — dialog \"Confirm\"\n  [e1] Button \"Keep\"";
        let filtered = super::filter_app_state(outline, "USC disposable", 800);
        assert!(filtered.contains("0 matching elements"), "{filtered}");
        assert!(filtered.contains("Window \"Confirm\" in window 0"), "{filtered}");
        assert!(filtered.contains("── window 0: \"Doc - Google Chrome\"  window_id=7 — dialog \"Confirm\""), "{filtered}");
        assert!(filtered.ends_with("(no elements match; drop the query or scroll the content into view)"), "{filtered}");
    }

    // #33: window_id routes to activate_window, which only Windows implements.
    #[test]
    fn activate_app_with_a_window_id_targets_that_window() {
        let mut desktop = FakeDesktop::default();
        let error = super::run_desktop_tool("activate_app", &json!({ "app": "Fake", "window_id": "front" }), &mut desktop)
            .unwrap_err();
        assert!(error.0.contains("window_id must be the number"), "{}", error.0);
        let error = super::run_desktop_tool("activate_app", &json!({ "app": "Fake", "window_id": 4242 }), &mut desktop)
            .unwrap_err();
        assert!(error.0.contains("Windows only"), "the trait default answers here: {}", error.0);
        let plain = super::run_desktop_tool("activate_app", &json!({ "app": "Fake", "window_id": null }), &mut desktop).unwrap();
        assert_eq!(text_of(&plain), "activated");
    }

    #[test]
    fn an_unknown_ocr_mode_is_refused() {
        let mut desktop = FakeDesktop::default();
        let error = super::run_desktop_tool("get_app_state", &json!({ "app": "Fake", "ocr": "sometimes" }), &mut desktop).unwrap_err();
        assert!(error.0.contains("auto, always, or never"), "{}", error.0);
        assert_eq!(desktop.reads, 0);
    }

    #[test]
    fn app_state_filter_reports_no_matches() {
        let filtered = super::filter_app_state("App\n\n  [e1] Button \"Go\"", "zzz", 800);
        assert!(filtered.contains("0 matching elements"), "{filtered}");
        assert!(filtered.contains("no elements match"), "{filtered}");
    }

    #[test]
    fn app_state_filter_prints_at_most_the_limit_and_says_so() {
        let outline = "App\n\n── window 0: \"Main\"\n  [e1] Button \"Update A\"\n  [e2] Button \"Update B\"\n  [e3] Button \"Update C\"";
        let filtered = super::filter_app_state(outline, "update", 2);
        assert!(filtered.contains("3 matching elements, showing the first 2; raise max_elements"), "{filtered}");
        assert!(filtered.contains("[e1]") && filtered.contains("[e2]") && !filtered.contains("[e3]"), "{filtered}");
    }

    #[test]
    fn app_state_filter_never_reports_a_cut_short_walk_as_definitively_empty() {
        let outline = "App\n\n── window 0: \"Main\"\n  [e1] Button \"Check\"\n      … truncated at 5000 elements — raise max_elements or target a child";
        let filtered = super::filter_app_state(outline, "failed", 10);
        assert!(filtered.contains("0 matching elements"), "{filtered}");
        assert!(filtered.contains("not searched"), "{filtered}");
        assert!(filtered.contains("does not mean the control is absent"), "{filtered}");
        assert!(!filtered.contains("raise max_elements or target a child"), "the budget marker is summarised: {filtered}");
    }

    #[test]
    fn app_state_filter_points_at_offscreen_when_nothing_on_screen_matches() {
        let outline = "App\n\n── window 0: \"Main\"\n  [e1] Button \"Play\"\n… 4 off-screen elements skipped; scroll, or pass offscreen=true to list them";
        let filtered = super::filter_app_state(outline, "restart", 10);
        assert!(filtered.contains("pass offscreen=true to include them"), "{filtered}");
    }

    // #30: a query must search past max_elements, which only caps the printout.
    #[test]
    fn a_query_reads_past_max_elements_and_caps_only_the_matches() {
        let mut desktop = FakeDesktop::default();
        let result = super::run_desktop_tool(
            "get_app_state",
            &json!({ "app": "Fake", "query": "save", "max_elements": 15 }),
            &mut desktop,
        )
        .unwrap();
        assert_eq!(desktop.walked, super::QUERY_WALK_ELEMENTS);
        assert!(text_of(&result).contains("[e1] Button \"Save\""), "{}", text_of(&result));

        super::run_desktop_tool("get_app_state", &json!({ "app": "Fake", "max_elements": 15 }), &mut desktop).unwrap();
        assert_eq!(desktop.walked, 15, "an unfiltered read keeps the caller's budget");
    }

    #[test]
    fn protocol_version_is_echoed_when_supported() {
        use super::negotiate_protocol_version;
        for version in ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] {
            assert_eq!(negotiate_protocol_version(&json!({ "protocolVersion": version })), version);
        }
        assert_eq!(negotiate_protocol_version(&json!({ "protocolVersion": "2099-01-01" })), "2024-11-05");
        assert_eq!(negotiate_protocol_version(&json!({})), "2024-11-05");
    }

    #[test]
    fn initialize_advertises_identity_and_instructions() {
        let mut browser = crate::browser::BrowserBridge::inert();
        let result = super::dispatch(
            "initialize",
            &json!({ "protocolVersion": "2025-06-18" }),
            None,
            &mut browser,
        )
        .ok()
        .expect("initialize succeeds");
        assert_eq!(result["protocolVersion"], json!("2025-06-18"));
        assert_eq!(result["serverInfo"]["name"], json!("mt-desktop"));
        assert_eq!(result["serverInfo"]["title"], json!("Munim Computer Use"));
        assert!(result["instructions"].as_str().is_some_and(|text| text.contains("get_app_state")));
    }

    /// A backend that records calls and returns a fixed outline.
    #[derive(Default)]
    struct FakeDesktop {
        reads: usize,
        /// max_elements of the latest read.
        walked: usize,
    }

    impl crate::platform::Desktop for FakeDesktop {
        fn list_apps(&mut self) -> crate::platform::Result<String> {
            Ok("Fake  [fake]  pid=1  windows=1  FRONTMOST".into())
        }
        fn get_app_state(&mut self, app: &str, options: &crate::platform::StateOptions) -> crate::platform::Result<String> {
            self.reads += 1;
            self.walked = options.max_elements;
            Ok(format!("{app} [fake] pid=1\n\n── window 0: \"Main\"\n  [e1] Button \"Save\"\n  [e2] Button \"Cancel {}\"", self.reads))
        }
        fn activate_app(&mut self, _: &str) -> crate::platform::Result<String> { Ok("activated".into()) }
        fn click(&mut self, _: Point, _: u32) -> crate::platform::Result<String> { Ok("clicked e1".into()) }
        fn right_click(&mut self, _: Point) -> crate::platform::Result<String> { Ok("right-clicked".into()) }
        fn hover(&mut self, _: Point) -> crate::platform::Result<String> { Ok("hovered".into()) }
        fn drag(&mut self, _: Point, _: Point) -> crate::platform::Result<String> { Ok("dragged".into()) }
        fn type_text(&mut self, _: &str, _: Option<u32>) -> crate::platform::Result<String> { Ok("typed".into()) }
        fn press_key(&mut self, _: &str, _: &[String]) -> crate::platform::Result<String> { Ok("pressed".into()) }
        fn scroll(&mut self, _: crate::platform::ScrollDirection, _: i32, _: Option<u32>) -> crate::platform::Result<String> {
            Ok("scrolled".into())
        }
        fn set_value(&mut self, _: u32, _: &str) -> crate::platform::Result<String> { Ok("set".into()) }
        fn select_text(&mut self, _: u32, _: usize, _: Option<usize>) -> crate::platform::Result<String> { Ok("selected".into()) }
        fn resolve_pid(&mut self, _: &str) -> crate::platform::Result<u32> { Ok(1) }
    }

    fn text_of(value: &serde_json::Value) -> String {
        value["content"][0]["text"].as_str().unwrap_or_default().to_string()
    }

    // One test, because return_state reads the process-wide "last app read".
    #[test]
    fn return_state_appends_a_fresh_read_of_the_last_app() {
        let mut desktop = FakeDesktop::default();
        *super::LAST_READ.lock().unwrap() = None;

        let before = super::run_desktop_tool("click", &json!({ "element_id": "e1", "return_state": true }), &mut desktop).unwrap();
        assert!(text_of(&before).contains("call get_app_state first"), "{}", text_of(&before));

        super::run_desktop_tool("get_app_state", &json!({ "app": "Fake" }), &mut desktop).unwrap();
        let plain = super::run_desktop_tool("click", &json!({ "element_id": "e1" }), &mut desktop).unwrap();
        assert_eq!(text_of(&plain), "clicked e1", "no state unless asked");
        assert_eq!(desktop.reads, 1);

        let after = super::run_desktop_tool("type_text", &json!({ "text": "hi", "return_state": true }), &mut desktop).unwrap();
        let text = text_of(&after);
        assert!(text.starts_with("typed\n\nstate after the action"), "{text}");
        assert!(text.contains("Cancel 2"), "a fresh read, not the old one: {text}");

        let filtered = super::run_desktop_tool(
            "click",
            &json!({ "element_id": "e1", "return_state": true, "state_query": "save" }),
            &mut desktop,
        )
        .unwrap();
        let text = text_of(&filtered);
        assert!(text.contains("[e1] Button \"Save\"") && !text.contains("Cancel"), "{text}");
    }

    #[test]
    fn a_step_plan_is_checked_whole_before_anything_runs() {
        let plan = |args: serde_json::Value| super::plan_steps(&args);
        assert!(plan(json!({})).unwrap_err().contains("must be a list"));
        assert!(plan(json!({ "steps": [] })).unwrap_err().contains("empty"));
        let many: Vec<_> = (0..21).map(|_| json!({ "tool": "wait" })).collect();
        assert!(plan(json!({ "steps": many })).unwrap_err().contains("more than the 20"));
        let error = plan(json!({ "steps": [{ "tool": "click" }, { "tool": "clik" }] })).unwrap_err();
        assert_eq!(error, "step 2: unknown tool 'clik'");
        assert!(plan(json!({ "steps": [{ "tool": "run_steps" }] })).unwrap_err().contains("cannot contain run_steps"));
        assert!(plan(json!({ "steps": [{ "tool": "click", "args": [1] }] })).unwrap_err().contains("args must be an object"));
        assert!(plan(json!({ "steps": [{ "args": {} }] })).unwrap_err().contains("step 1 has no tool"));
    }

    #[test]
    fn return_state_moves_from_the_steps_to_the_last_one() {
        let plan = super::plan_steps(&json!({
            "steps": [
                { "tool": "click", "args": { "element_id": "e1", "return_state": true } },
                { "tool": "type_text", "args": { "text": "hi" } }
            ],
            "return_state": true,
            "state_query": "save"
        }))
        .unwrap();
        assert_eq!(plan[0].1, json!({ "element_id": "e1" }));
        assert_eq!(plan[1].1, json!({ "text": "hi", "return_state": true, "state_query": "save" }));

        let plain = super::plan_steps(&json!({ "steps": [{ "tool": "press_key", "args": { "key": "return", "return_state": true } }] })).unwrap();
        assert_eq!(plain[0].1, json!({ "key": "return" }), "a step's own return_state is dropped");
    }

    #[test]
    fn steps_run_in_order_and_every_outcome_is_labelled() {
        let mut desktop = FakeDesktop::default();
        let mut browser = crate::browser::BrowserBridge::inert();
        let result = super::run_steps(
            &json!({ "steps": [
                { "tool": "click", "args": { "element_id": "e1" } },
                { "tool": "type_text", "args": { "text": "hi" } },
                { "tool": "wait", "args": { "seconds": 0.01 } },
                { "tool": "press_key", "args": { "key": "return" } }
            ] }),
            Some(&mut desktop),
            &mut browser,
        );
        assert_eq!(result["isError"], json!(false));
        let texts: Vec<&str> = result["content"].as_array().unwrap().iter().filter_map(|item| item["text"].as_str()).collect();
        assert_eq!(texts, ["ran all 4 steps", "1. click: clicked e1", "2. type_text: typed", "3. wait: waited 0.0s", "4. press_key: pressed"]);
    }

    #[test]
    fn the_first_failing_step_stops_the_rest() {
        let mut desktop = FakeDesktop::default();
        let mut browser = crate::browser::BrowserBridge::inert();
        let result = super::run_steps(
            &json!({ "steps": [
                { "tool": "click", "args": { "element_id": "e1" } },
                { "tool": "click", "args": { "element_id": "zz" } },
                { "tool": "type_text", "args": { "text": "never" } },
                { "tool": "press_key", "args": { "key": "return" } }
            ] }),
            Some(&mut desktop),
            &mut browser,
        );
        assert_eq!(result["isError"], json!(true));
        let texts: Vec<&str> = result["content"].as_array().unwrap().iter().filter_map(|item| item["text"].as_str()).collect();
        assert_eq!(texts.len(), 3, "{texts:?}");
        assert_eq!(texts[0], "stopped at step 2 of 4: click failed, so steps 3–4 did not run");
        assert!(texts[2].starts_with("2. click: error: 'zz' is not an element id"), "{}", texts[2]);

        let last = super::run_steps(
            &json!({ "steps": [{ "tool": "wait" , "args": { "seconds": 0.01 } }, { "tool": "click", "args": {} }] }),
            None,
            &mut browser,
        );
        assert_eq!(text_of(&last), "step 2 of 2 (click) failed");

        let nothing = super::run_steps(&json!({ "steps": [{ "tool": "nope" }] }), Some(&mut desktop), &mut browser);
        assert_eq!(text_of(&nothing), "error: step 1: unknown tool 'nope'; nothing was run");
    }

    #[test]
    fn tool_errors_are_reported_in_band() {
        let result = text_result("error: nope", true);
        assert_eq!(result["isError"], json!(true));
        assert_eq!(result["content"][0]["type"], json!("text"));
    }
}
