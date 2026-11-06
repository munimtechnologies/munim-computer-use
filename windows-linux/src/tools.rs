//! Tool schemas, kept byte-compatible with the macOS Swift server's `toolDefs`.
//!
//! A model that learned the tools on one platform must not have to relearn them
//! on another, so the names, argument shapes and descriptions are deliberately
//! identical. Behavioural differences belong in the tool text, not the schema.

use serde_json::{Value, json};

/// Host settings pass `COMPUTER_USE_BROWSER=0` when browser control is off.
/// `name` is the tunable without its prefix (`BROWSER`); an embedder's
/// `envPrefix` is read first (see identity.rs).
pub fn env_flag_disabled(name: &str) -> bool {
    match crate::identity::env_var(name).ok_or(()) {
        Ok(raw) => {
            let trimmed = raw.trim().to_ascii_lowercase();
            matches!(trimmed.as_str(), "0" | "false" | "off" | "no")
        }
        Err(_) => false,
    }
}

pub fn browser_control_enabled() -> bool {
    !env_flag_disabled("BROWSER")
}

/// Returned in the `initialize` result; identical in the Swift server.
pub const SERVER_INSTRUCTIONS: &str = "Munim Computer Use operates this computer's desktop apps and, through the browser_* tools, the user's signed-in Chrome. Look, act, verify: call list_apps to find the app, then get_app_state (narrow it with query) before acting, and act on element ids such as e12 rather than screen coordinates. Ids belong to one snapshot, so call get_app_state again after the UI changes. Use screenshot to check a result or to see content the accessibility tree cannot describe, and zoom to read small text. Where the platform allows, input is delivered to the target app in the background and the agent has its own pointer, so the user can keep working; call activate_app only when a keystroke needs keyboard focus. For web pages prefer the browser_* tools, which work in the agent's own tab group, and release any tab adopted with browser_use_tab when done. In a Chrome tab the agent works in, use browser_click, browser_type, browser_fill (to replace a field's value) and browser_press_key (keys and shortcuts such as cmd+a); they act on that tab in the background without bringing Chrome forward. Never use the desktop click, press_key or type_text on a Chrome tab: they go to whichever Chrome window is in front, which can be the user's. For concurrent tasks sharing this MCP server, pass a distinct session_id on every browser call for each task; keep it stable, including cleanup. Separate sessions share website logins and cookies. Desktop apps and clipboard are not session-isolated. Pass return_state on an action to get current state back in the same call. Use run_steps for several actions you already know, like click, type, press return: one call, stopping at the first that fails. For delayed browser UI, use wait_for_selector with return_state and inspect readiness; a loaded tab is not SPA readiness. A timeout does not undo the action: re-observe with browser_snapshot and the same wait before repeating a non-idempotent action. Use browser_read to read a page's text. When a page opens a JavaScript alert, confirm or prompt, browser_snapshot shows it and browser_handle_dialog answers it; browser_page_errors lists a page's exceptions, console errors and failed requests. Never ask for, or type, a password or code yourself: browser_request_credentials lets the user enter it without you seeing it. The user's Computer Use policy can block apps and sites or require their approval; when a call says so, do not work around it. Ask the user before anything irreversible, such as sending, deleting, purchasing or submitting forms on their behalf.";

pub fn tool_defs() -> Value {
    let Value::Array(defs) = all_tool_defs() else {
        unreachable!("tool defs are an array literal");
    };
    let browser = browser_control_enabled();
    Value::Array(
        defs.into_iter()
            .filter(|tool| {
                browser
                    || tool
                        .get("name")
                        .and_then(Value::as_str)
                        .is_none_or(|name| !name.starts_with("browser_"))
            })
            .map(|mut tool| {
                // Newer protocol revisions read a top-level title; older clients
                // read annotations.title. Derive one from the other so they
                // cannot drift.
                if let Some(title) = tool.pointer("/annotations/title").cloned() {
                    tool["title"] = title;
                }
                tool
            })
            .collect(),
    )
}

fn all_tool_defs() -> Value {
    json!([
        {
            "name": "list_apps",
            "description": "List running applications with their bundle id, pid, window count, and which one is frontmost. Call it first to learn the exact `app` value that get_app_state, screenshot and activate_app accept. One app can have several running instances and only some own windows, so prefer the instance that has windows. Instances that share a name each show their main window title, and a closing note lists their pids: pass the pid to choose one. Read-only: no window or input is touched.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            },
            "annotations": {
                "title": "List running apps",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "get_app_state",
            "description": "Read an app's accessibility tree as an indented outline in which interactive elements carry ids like [e12] that click, type_text, set_value, scroll, hover and select_text accept. Use it instead of screenshot whenever you intend to act: it is far cheaper in tokens and gives exact targets. Call it before interacting and again after the UI changes, because ids are per-snapshot. Each id is rechecked before an action: one whose element is gone or has changed fails instead of acting on something else. The outline lists what is on screen: rows of long lists and content scrolled out of view are skipped (scroll, or pass offscreen), and while a dialog, sheet or popover blocks a window only its controls are listed. When an app exposes little to accessibility, its on-screen text is read with OCR and listed with ids too. Read-only; it does not change focus.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": {
                        "type": "string",
                        "description": "App name, bundle id, or pid exactly as reported by list_apps, or \"frontmost\" for the app the user is looking at"
                    },
                    "max_depth": {
                        "type": "integer",
                        "description": "Maximum nesting depth to descend (default 18). Lower it for a quick overview of a large window."
                    },
                    "max_elements": {
                        "type": "integer",
                        "description": "Maximum elements to emit before the outline is truncated (default 800). With `query`, the maximum matches to list instead: a query searches past this cap. Prefer `query` over raising this."
                    },
                    "query": {
                        "type": "string",
                        "description": "Only list elements whose role, label or value contains this text (case-insensitive). Ids stay valid. It searches the whole outline, not just the first max_elements elements, and says when the read stopped early. Use it instead of raising max_elements when you know what you are looking for."
                    },
                    "offscreen": {
                        "type": "boolean",
                        "description": "Also list elements scrolled out of view, such as every row of a long list (default false). Prefer scrolling or `query`: this can make the outline far larger."
                    },
                    "ocr": {
                        "type": "string",
                        "enum": ["auto", "always", "never"],
                        "description": "Read on-screen text with OCR and list it with ids that click, hover, right_click and drag accept: auto (default) only when the app exposes no labelled controls to accessibility, always, or never. macOS and Windows; macOS needs Screen Recording permission."
                    }
                },
                "required": ["app"]
            },
            "annotations": {
                "title": "Read accessibility tree",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "click",
            "description": "Click an element by element_id (preferred: it uses the accessibility press action, so it works even when the element is scrolled out of view) or at absolute screen coordinates taken from a screenshot or zoom. Pass element_id or x and y, not both. When element_id is clicked by position (web content, or no press action), the point is checked with the app's own hit test first, and the element is scrolled into view if needed; if something else is there the call fails without clicking. A checkbox or radio button says what it is now, and a click that left it unchanged is reported as an error. Use browser_click for pages in the agent's Chrome tabs, right_click for context menus, and drag for press-move-release. The click reaches the target app for real and can trigger any action the user could, so read the target with get_app_state first. The agent's own pointer overlay moves to the target. On macOS the user's mouse pointer never moves; on Windows and Linux a target that ignores background input gets real mouse input, which moves the user's pointer, and the result then says via cursor.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "element_id": {
                        "type": "string",
                        "description": "Element id from the most recent get_app_state snapshot, e.g. e12. Preferred over coordinates."
                    },
                    "x": {
                        "type": "number",
                        "description": "Screen x coordinate in points, used together with y when no element_id is given"
                    },
                    "y": {
                        "type": "number",
                        "description": "Screen y coordinate in points, used together with x when no element_id is given"
                    },
                    "click_count": {
                        "type": "integer",
                        "description": "1 for a single click (default), 2 for a double-click"
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "After acting, wait for the app to finish reacting (up to 2 s) and append a fresh get_app_state of the app you last read, so you can check the result and pick the next target in the same call. Its ids replace every earlier id."
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                }
            },
            "annotations": {
                "title": "Click",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            }
        },
        {
            "name": "type_text",
            "description": "Type literal text as keystrokes into the field that currently has focus, optionally focusing element_id first. Use it for short entries and for fields that reject set_value; use set_value to replace a long value in one step, and press_key for shortcuts or keys such as return and tab. Never use it for a Chrome tab the agent works in (it goes to whichever Chrome window is in front, which can be the user's); use browser_type or browser_fill there. Text is inserted at the caret without clearing what is already there. It does not take over the user's keyboard: on macOS and Windows the text goes to the app you are working in, not the window the user is typing in, so do not call activate_app first. Typing into password fields is refused by default (see COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Exact text to type, character by character"
                    },
                    "element_id": {
                        "type": "string",
                        "description": "Element to focus before typing, from get_app_state. Omit to type into whatever currently has focus."
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "After acting, wait for the app to finish reacting (up to 2 s) and append a fresh get_app_state of the app you last read, so you can check the result and pick the next target in the same call. Its ids replace every earlier id."
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                },
                "required": ["text"]
            },
            "annotations": {
                "title": "Type text",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            }
        },
        {
            "name": "press_key",
            "description": "Press one named key, optionally with modifiers held, e.g. key='s' modifiers=['cmd'] to save or key='return' to submit. Use it for shortcuts and navigation keys; use type_text for literal text. Never use it for a Chrome tab the agent works in: it goes to whichever Chrome window is in front, which can be the user's; use browser_press_key, browser_type or browser_fill there. The key goes to the app you are working in (the one you last clicked or focused); on macOS and Windows the user can keep typing elsewhere meanwhile, so call activate_app only when nothing has targeted the app yet. Shortcuts can close windows or delete content, so confirm the target before pressing.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "Key name: a single character such as 's' or '/' (resolved through the current keyboard layout), or a named key: return, tab, escape, space, delete, backspace, forwarddelete, up, down, left, right, home, end, pageup, pagedown, insert, f1 to f20, punctuation names (minus, equal, leftbracket, rightbracket, backslash, semicolon, quote, comma, period, slash, grave), numpad0 to numpad9, numpadadd, numpadsubtract, numpadmultiply, numpaddivide, numpaddecimal, numpadenter"
                    },
                    "modifiers": {
                        "type": "array",
                        "items": {
                            "type": "string"
                        },
                        "description": "Modifier keys to hold while pressing: any of cmd, shift, alt, ctrl, fn. cmd maps to the Windows/Super key off macOS."
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "After acting, wait for the app to finish reacting (up to 2 s) and append a fresh get_app_state of the app you last read, so you can check the result and pick the next target in the same call. Its ids replace every earlier id."
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                },
                "required": ["key"]
            },
            "annotations": {
                "title": "Press key",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            }
        },
        {
            "name": "scroll",
            "description": "Scroll up, down, left or right by a number of lines, over element_id when given so the right pane scrolls. Use it to bring off-screen content into view before get_app_state or screenshot. It only scrolls; nothing is clicked or selected. On macOS it scrolls the target app in the background without moving the user's pointer. On Windows and Linux, without element_id it scrolls whatever is under the user's pointer, and an element with no background route gets the real pointer moved onto it (the result then says via cursor).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "direction": {
                        "type": "string",
                        "enum": ["up", "down", "left", "right"],
                        "description": "Scroll direction (default down)"
                    },
                    "amount": {
                        "type": "integer",
                        "description": "Number of scroll lines, 1 to 100 (default 5)"
                    },
                    "element_id": {
                        "type": "string",
                        "description": "Element to scroll, from get_app_state; the nearest scrollable area around it moves. Omit to scroll the last inspected app (macOS) or whatever is under the pointer (Windows, Linux)."
                    },
                    "x": {
                        "type": "number",
                        "description": "Screen x to scroll over. Remote control only: the pointer moves there first. Ignored otherwise."
                    },
                    "y": {
                        "type": "number",
                        "description": "Screen y to scroll over. Remote control only: the pointer moves there first. Ignored otherwise."
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "After acting, wait for the app to finish reacting (up to 2 s) and append a fresh get_app_state of the app you last read, so you can check the result and pick the next target in the same call. Its ids replace every earlier id."
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                }
            },
            "annotations": {
                "title": "Scroll",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            }
        },
        {
            "name": "activate_app",
            "description": "Bring an app's windows to the foreground and give it keyboard focus. type_text, press_key and element-id actions such as click and set_value do not need it; use it only when the app itself must be in front. Side effect: the window the user was working in loses focus.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": {
                        "type": "string",
                        "description": "App name, bundle id, or pid exactly as reported by list_apps"
                    },
                    "window_id": {
                        "type": "integer",
                        "description": "Windows only: bring this one window forward instead of the app's frontmost window, for an app with several windows such as Chrome. Use the window_id from a get_app_state window line; it must belong to app. The result names the window in front afterwards."
                    }
                },
                "required": ["app"]
            },
            "annotations": {
                "title": "Activate app",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "screenshot",
            "description": "Capture an app's largest window, or a whole display, as an image. The result text states the capture's screen origin and pixels-per-point so an image pixel can be converted into click or hover coordinates. Prefer get_app_state for interaction, which is cheaper and returns clickable element ids; use screenshot to verify an outcome or to see content the accessibility tree cannot describe (canvas, video, custom drawing), and zoom to read small text. Read-only; the captured window is not raised or focused.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": {
                        "type": "string",
                        "description": "App name, bundle id, or pid exactly as reported by list_apps. Captures that app's largest window. Provide either app or display, or \"frontmost\" for the app the user is looking at"
                    },
                    "display": {
                        "type": "integer",
                        "description": "0-based display index from list_displays. Captures the whole display instead of an app window."
                    },
                    "max_width": {
                        "type": "integer",
                        "description": "Downscale the image to this width in pixels (default 1400). Lower it to save tokens."
                    },
                    "format": {
                        "type": "string",
                        "enum": ["png", "jpeg"],
                        "description": "Image encoding (default png). Use jpeg for live remote viewing."
                    },
                    "quality": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "description": "JPEG quality from 1 to 100 (default 55). Ignored for png. Raise it when small text must stay sharp."
                    }
                }
            },
            "annotations": {
                "title": "Screenshot",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "list_displays",
            "description": "List every attached display with its index, resolution and position, for use with screenshot(display: N) and for interpreting screen coordinates on multi-monitor setups. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            },
            "annotations": {
                "title": "List displays",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "right_click",
            "description": "Right-click (secondary click) an element or screen position to open its context menu. Follow with get_app_state to read the menu items, then click one. Use click for normal activation. Pass element_id or x and y, not both. The user's pointer is treated as for click.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "element_id": {
                        "type": "string",
                        "description": "Element id from the most recent get_app_state snapshot, e.g. e12"
                    },
                    "x": {
                        "type": "number",
                        "description": "Screen x coordinate in points, used together with y when no element_id is given"
                    },
                    "y": {
                        "type": "number",
                        "description": "Screen y coordinate in points, used together with x when no element_id is given"
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "After acting, wait for the app to finish reacting (up to 2 s) and append a fresh get_app_state of the app you last read, so you can check the result and pick the next target in the same call. Its ids replace every earlier id."
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                }
            },
            "annotations": {
                "title": "Right-click",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            }
        },
        {
            "name": "drag",
            "description": "Press at one point, move, and release at another to drag and drop, move a slider, or select a range. Give each end as an element id or as screen coordinates; the two ends may use different forms. A drop can move or reorder items in the app, so verify the result with get_app_state. On macOS a drag must stay inside one app window and never moves the user's pointer; on Windows and Linux most drags use real mouse input, which moves the user's pointer (the result then says via cursor).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from_element_id": {
                        "type": "string",
                        "description": "Element to start the drag on, from get_app_state"
                    },
                    "to_element_id": {
                        "type": "string",
                        "description": "Element to release on, from get_app_state"
                    },
                    "from_x": {
                        "type": "number",
                        "description": "Screen x to start at, used with from_y when no from_element_id is given"
                    },
                    "from_y": {
                        "type": "number",
                        "description": "Screen y to start at, used with from_x when no from_element_id is given"
                    },
                    "to_x": {
                        "type": "number",
                        "description": "Screen x to release at, used with to_y when no to_element_id is given"
                    },
                    "to_y": {
                        "type": "number",
                        "description": "Screen y to release at, used with to_x when no to_element_id is given"
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "After acting, wait for the app to finish reacting (up to 2 s) and append a fresh get_app_state of the app you last read, so you can check the result and pick the next target in the same call. Its ids replace every earlier id."
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                }
            },
            "annotations": {
                "title": "Drag",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            }
        },
        {
            "name": "set_value",
            "description": "Replace a text field's entire contents in one step through the accessibility API, without keystrokes. Prefer it over type_text for long values or when the field already holds text; fall back to click plus type_text if the field rejects it, which the result reports. The previous value is discarded.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "element_id": {
                        "type": "string",
                        "description": "Text field to set, from get_app_state"
                    },
                    "value": {
                        "type": "string",
                        "description": "New complete value for the field"
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "After acting, wait for the app to finish reacting (up to 2 s) and append a fresh get_app_state of the app you last read, so you can check the result and pick the next target in the same call. Its ids replace every earlier id."
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                },
                "required": ["element_id", "value"]
            },
            "annotations": {
                "title": "Set field value",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "zoom",
            "description": "Capture one region of the screen at full resolution, to read small text, dense tables, file names or tiny controls that a normal screenshot blurs. Give the region as two corners in screen coordinates (the same space click uses); the result text explains how to map pixels in the zoomed image back to screen coordinates. Use screenshot for a whole window and get_app_state when the text is exposed by accessibility. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x0": {
                        "type": "number",
                        "description": "Left edge, screen coordinates"
                    },
                    "y0": {
                        "type": "number",
                        "description": "Top edge, screen coordinates"
                    },
                    "x1": {
                        "type": "number",
                        "description": "Right edge, screen coordinates"
                    },
                    "y1": {
                        "type": "number",
                        "description": "Bottom edge, screen coordinates"
                    },
                    "max_width": {
                        "type": "integer",
                        "description": "Downscale the zoomed image to this width in pixels (default 1400)"
                    }
                },
                "required": ["x0", "y0", "x1", "y1"]
            },
            "annotations": {
                "title": "Zoom into region",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "hover",
            "description": "Move the agent pointer over an element or screen position without clicking, to reveal hover menus, toolbars, tooltips or drag handles. Follow with get_app_state or screenshot to see what appeared. Use click to activate. Pass element_id or x and y, not both. On macOS the user's own mouse pointer is not moved; on Windows and Linux it may be, and the result then says via cursor.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "element_id": {
                        "type": "string",
                        "description": "Element id from the most recent get_app_state snapshot, e.g. e12"
                    },
                    "x": {
                        "type": "number",
                        "description": "Screen x coordinate in points, used together with y when no element_id is given"
                    },
                    "y": {
                        "type": "number",
                        "description": "Screen y coordinate in points, used together with x when no element_id is given"
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "After acting, wait for the app to finish reacting (up to 2 s) and append a fresh get_app_state of the app you last read, so you can check the result and pick the next target in the same call. Its ids replace every earlier id."
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                }
            },
            "annotations": {
                "title": "Hover",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "wait",
            "description": "Pause before the next action so the UI can catch up: page loads, animations, dialogs opening, apps launching. Follow with get_app_state or screenshot to confirm the new state instead of guessing. Sends no input.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "seconds": {
                        "type": "number",
                        "description": "Seconds to wait (default 1, maximum 30)"
                    }
                }
            },
            "annotations": {
                "title": "Wait",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "run_steps",
            "description": "Run a sequence of actions in one call, in order, stopping at the first step that fails. Each step names another tool and its arguments, and runs exactly as if you had called it: the same app and site rules, element id checks and password-field refusals apply. Use it for steps you already know will follow each other, like click a field, type, press return, after reading the app with get_app_state. Element ids from that snapshot stay valid until a step reads the app again. The result lists every step's outcome; when a step fails, the steps after it do not run and the call reports an error. Put return_state on run_steps, not on a step, to get the state after the last step. At most 20 steps; run_steps cannot contain run_steps.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "description": "The actions to run, in order",
                        "items": {
                            "type": "object",
                            "properties": {
                                "tool": {
                                    "type": "string",
                                    "description": "Name of the tool to call, e.g. click, type_text, press_key, wait, browser_click"
                                },
                                "args": {
                                    "type": "object",
                                    "description": "That tool's arguments, as you would pass them to it directly"
                                }
                            },
                            "required": ["tool"]
                        }
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "Pass return_state to the last step, so the result ends with the state after it (the app you last read, or the page for a browser step)"
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                },
                "required": ["steps"]
            },
            "annotations": {
                "title": "Run steps",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": true
            }
        },
        {
            "name": "select_text",
            "description": "Select a character range inside a text element through the accessibility API, for example to copy part of a value or to replace just that part with type_text. Defaults to selecting from `start` to the end of the value. Use set_value to replace the whole value instead. Only the selection changes; the text is not modified.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "element_id": {
                        "type": "string",
                        "description": "Text element to select in, from get_app_state"
                    },
                    "start": {
                        "type": "integer",
                        "description": "Zero-based character offset to start the selection at (default 0)"
                    },
                    "length": {
                        "type": "integer",
                        "description": "Number of characters to select (default: through the end of the value)"
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "After acting, wait for the app to finish reacting (up to 2 s) and append a fresh get_app_state of the app you last read, so you can check the result and pick the next target in the same call. Its ids replace every earlier id."
                    },
                    "state_query": {
                        "type": "string",
                        "description": "With return_state, list only elements whose role, label or value contains this text, like get_app_state's query"
                    }
                },
                "required": ["element_id"]
            },
            "annotations": {
                "title": "Select text",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "clipboard_read",
            "description": "Read the plain text on the system clipboard, for example after press_key cmd+c (ctrl+c off macOS) copied a selection, or when the user says they copied something for you. Prefer get_app_state, browser_snapshot or screenshot to read what is on screen; use this for text that was deliberately copied. Images and files on the clipboard are reported as no text. Read-only, but the clipboard can hold private data the user copied, such as passwords, so do not repeat it beyond what the task needs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "max_chars": {
                        "type": "integer",
                        "description": "Maximum characters to return (default 20000, maximum 200000). Longer text is cut off with a note giving its full length."
                    }
                }
            },
            "annotations": {
                "title": "Read clipboard",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "clipboard_write",
            "description": "Replace the system clipboard with plain text, typically so a long or multi-line value can be pasted with press_key cmd+v (ctrl+v off macOS) where set_value is rejected and type_text would be slow. This tool does not paste anything itself. Side effect: whatever the user had on the clipboard is overwritten and not restored, so tell the user when you use it. Prefer set_value or type_text when they work.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Exact text to place on the clipboard, replacing its current contents"
                    }
                },
                "required": ["text"]
            },
            "annotations": {
                "title": "Write clipboard",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_open_tab",
            "description": "Open a URL in a new background tab inside the agent's own labelled tab group in the user's signed-in Chrome, and return its tab_id for browser_snapshot, browser_click, browser_type and browser_navigate. The tab opens in the background, so the user's browsing is not interrupted. Use browser_use_tab instead when the user already has the page open and signed in. Requires the Computer Use Chrome extension; a limited fallback mode applies without it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "url": {
                        "type": "string",
                        "description": "Absolute URL to open (default about:blank)"
                    }
                }
            },
            "annotations": {
                "title": "Open browser tab",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": true
            }
        },
        {
            "name": "browser_list_tabs",
            "description": "List the tabs in the agent's own Chrome tab group, marking the active one, with the tab_id each other browser tool needs. Pass all=true to see every tab open in the browser, including the user's, so you can pick one to drive with browser_use_tab. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "all": {
                        "type": "boolean",
                        "description": "List every tab in the browser, not just the agent's (default false)"
                    }
                }
            },
            "annotations": {
                "title": "List browser tabs",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_use_tab",
            "description": "Take over a tab the user already has open, instead of opening a new one. Use this when the page is already signed in or mid-flow — a checkout, a draft, a dashboard behind SSO — and re-opening the URL would lose that state. Find the tab_id with browser_list_tabs all=true. The tab stays exactly where it is in the user's window; it is not moved into the agent's group, not activated, and not reloaded. It is never closed by cleanup — call browser_release_tab to hand it back. Ask the user before taking over a tab they are actively working in.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of the user's tab, from browser_list_tabs all=true"
                    }
                },
                "required": ["tab_id"]
            },
            "annotations": {
                "title": "Adopt user's tab",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": true
            }
        },
        {
            "name": "browser_release_tab",
            "description": "Hand a tab taken over with browser_use_tab back to the user: the agent stops driving it and the page is left exactly as it is. Call it as soon as you are done with an adopted tab. Use browser_close_tab for tabs the agent opened itself.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of a tab previously adopted with browser_use_tab"
                    }
                },
                "required": ["tab_id"]
            },
            "annotations": {
                "title": "Release adopted tab",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_select_tab",
            "description": "Make one of the agent's tabs the visible one in its window, for example before native keyboard input or a screenshot. browser_snapshot, browser_click, browser_type and browser_press_key work on background tabs, so most tasks never need this. The agent's tabs live in the user's Chrome window, so by default the tab is only shown when the user is already looking at one of the agent's tabs; otherwise it stays in the background, the user keeps their tab, and the reply says it was not brought to front. Pass bring_to_front=true to show it and raise its window regardless; that takes the window from the user, so use it sparingly. The user's own tabs are never selected.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "bring_to_front": {
                        "type": "boolean",
                        "description": "Show the tab and raise its Chrome window even when the user is on one of their own tabs. Default false: the tab is only shown when the user is already on an agent tab."
                    },
                    "index": {
                        "type": "integer",
                        "description": "1-based position within the agent's tabs; fallback mode only, when tab_id is unavailable"
                    }
                }
            },
            "annotations": {
                "title": "Select browser tab",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_close_tab",
            "description": "Close one of the agent's tabs, discarding any unsaved page state. A tab taken over with browser_use_tab is released rather than closed — it belongs to the user. Use browser_close_all_tabs to clean up everything at the end of a task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "index": {
                        "type": "integer",
                        "description": "1-based position within the agent's tabs; fallback mode only, when tab_id is unavailable"
                    }
                }
            },
            "annotations": {
                "title": "Close browser tab",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_snapshot",
            "description": "List the interactive elements (links, buttons, inputs, tabs, checkboxes, table and grid rows listed as row with their cell text, and other clickable elements) on the page in one of the agent's tabs, with the index each one has for browser_click, plus the page title and URL. Inputs show their type, such as input[password], and text the page lets you edit in place shows as [editable], such as span[editable] (click it, or browser_fill it); checkboxes, radios and switches are named by their label and show their state, such as (checked) or (unchecked, disabled). Works on a background tab, so the user can be looking at something else. Use it before every browser_click, because indices change when the page changes; use browser_read for the page's text. Read-only. Automatically scopes to the topmost visible dialog when one is open, naming it on a dialog: line, excluding hidden/inert controls but retaining reachable offscreen controls. Results report scope, total and truncation. Continue with offset and limit on the same tab/session; indices stay global across pages of an unchanged UI. Snapshot again after UI changes. While the page has a JavaScript dialog open (alert, confirm, prompt), the snapshot shows the dialog's type, message and dialog_id instead, for browser_handle_dialog.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 2147483647,
                        "description": "Control offset for pagination (default 0). Use the continuation offset from the previous result on an unchanged UI."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 250,
                        "description": "Maximum controls returned per page (default 250, maximum 250)."
                    },
                    "wait_for_selector": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000,
                        "description": "Wait for any visible element matching this CSS selector in the page, including open shadow roots (web components); child frames are not searched, and a timeout says how many were visible. On actions requires return_state=true. Returns readiness met, timeout or error; only this condition is checked, not general app readiness. Prefer a selector specific to the expected new UI."
                    },
                    "wait_timeout_ms": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 10000,
                        "description": "Bound for wait_for_selector in milliseconds (default 8000, maximum 10000; 0 checks once). Requires wait_for_selector. Timeout preserves action success and returns current state. Use browser_snapshot with the same wait to re-observe without repeating an action."
                    }
                },
                "required": ["tab_id"]
            },
            "annotations": {
                "title": "Snapshot page elements",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": true
            }
        },
        {
            "name": "browser_read",
            "description": "Read the text of the page in one of the agent's tabs: headings marked with #, then paragraphs, lists and table text in reading order, including content scrolled out of view. Use it to read an article, results or documentation; use browser_snapshot to find something to click. Works on a background tab. Long pages come back in chunks: the result says where it stopped, and offset continues from there. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "query": {
                        "type": "string",
                        "description": "Only return lines containing this text (case-insensitive), each with its neighbouring lines and the heading above it"
                    },
                    "max_chars": {
                        "type": "integer",
                        "description": "Characters to return (default 20000, at most 200000)"
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Character offset to start from, to continue a page that was cut off (default 0)"
                    },
                    "include_links": {
                        "type": "boolean",
                        "description": "Also list the page's links as text and URL (up to 150)"
                    }
                },
                "required": ["tab_id"]
            },
            "annotations": {
                "title": "Read page text",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": true
            }
        },
        {
            "name": "browser_page_errors",
            "description": "List the problems the page in one of the agent's tabs has reported: uncaught JavaScript exceptions and console errors the page has logged since it loaded (Chrome keeps a limited number), and requests that failed since the agent attached to the tab (network errors and HTTP status 400 or above), oldest first, with how long ago each happened. Use it when a page is empty, broken or ignores an action, before navigating again or assuming a sign-in problem. The reply says when watching for failed requests began; ones Chrome still held from before are marked as earlier. Exceptions and console errors are read from what Chrome keeps for the page during this call only, so the page is not watched for them in between. The latest 50 are listed. URLs are shown without query strings, fragments or credentials, and request headers, cookies and bodies are never read. Read-only: it does not reload, navigate or show the tab.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    }
                },
                "required": ["tab_id"]
            },
            "annotations": {
                "title": "List page errors",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": true
            }
        },
        {
            "name": "browser_click",
            "description": "Click in one of the agent's tabs, either an element by its index from browser_snapshot (preferred) or a point given in page coordinates. Pass index or x and y, not both. Works on a background tab with real (trusted) mouse input, without selecting the tab or raising its window. An element out of view is scrolled into view first; when something else covers it (a banner, a dialog, another control) nothing is pressed and the call fails, naming what is in front. A checkbox, radio or switch reports what it is now. A tab the click opens (a target=_blank link or a popup) becomes one of the agent's tabs; find it with browser_list_tabs. Use click for native app windows. A click can submit forms or follow links, so snapshot first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "index": {
                        "type": "integer",
                        "description": "Element index from the latest browser_snapshot of this tab. Preferred over coordinates."
                    },
                    "x": {
                        "type": "number",
                        "description": "Page x coordinate in CSS pixels, used together with y when no index is given"
                    },
                    "y": {
                        "type": "number",
                        "description": "Page y coordinate in CSS pixels, used together with x when no index is given"
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "Append a current snapshot and readiness status after acting. Without wait_for_selector, only a short pause and bounded navigation wait are used; SPA readiness is not guaranteed. Snapshot indices replace earlier ones. A timeout does not mean the action failed: re-observe with browser_snapshot before repeating it."
                    },
                    "wait_for_selector": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000,
                        "description": "Wait for any visible element matching this CSS selector in the page, including open shadow roots (web components); child frames are not searched, and a timeout says how many were visible. On actions requires return_state=true. Returns readiness met, timeout or error; only this condition is checked, not general app readiness. Prefer a selector specific to the expected new UI."
                    },
                    "wait_timeout_ms": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 10000,
                        "description": "Bound for wait_for_selector in milliseconds (default 8000, maximum 10000; 0 checks once). Requires wait_for_selector. Timeout preserves action success and returns current state. Use browser_snapshot with the same wait to re-observe without repeating an action."
                    }
                },
                "required": ["tab_id"]
            },
            "annotations": {
                "title": "Click in browser",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": true
            }
        },
        {
            "name": "browser_type",
            "description": "Type text into the field that currently has focus in one of the agent's tabs; browser_click the field first. Text is inserted at the caret without clearing existing content: to replace a field's whole value use browser_fill. Use browser_press_key for Enter, Tab, Backspace, arrows and shortcuts such as Cmd+A, and type_text for native apps. Never use the desktop press_key or type_text for a Chrome tab: those go to whichever Chrome window is in front, which can be the user's.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "text": {
                        "type": "string",
                        "description": "Exact text to type into the focused field"
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "Append a current snapshot and readiness status after acting. Without wait_for_selector, only a short pause and bounded navigation wait are used; SPA readiness is not guaranteed. Snapshot indices replace earlier ones. A timeout does not mean the action failed: re-observe with browser_snapshot before repeating it."
                    },
                    "wait_for_selector": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000,
                        "description": "Wait for any visible element matching this CSS selector in the page, including open shadow roots (web components); child frames are not searched, and a timeout says how many were visible. On actions requires return_state=true. Returns readiness met, timeout or error; only this condition is checked, not general app readiness. Prefer a selector specific to the expected new UI."
                    },
                    "wait_timeout_ms": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 10000,
                        "description": "Bound for wait_for_selector in milliseconds (default 8000, maximum 10000; 0 checks once). Requires wait_for_selector. Timeout preserves action success and returns current state. Use browser_snapshot with the same wait to re-observe without repeating an action."
                    }
                },
                "required": ["tab_id", "text"]
            },
            "annotations": {
                "title": "Type in browser",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_fill",
            "description": "Replace the whole value of a text field in one of the agent's tabs: focuses the element by its browser_snapshot index, selects everything in it and puts the text in through Chrome's own text input, so the page sees the same trusted input events as typing. Works on input, textarea and contenteditable fields, including inside web components (open shadow roots), in a background tab without selecting it or raising its window. Pass an empty string to clear the field. The reply says whether the field now holds exactly the text, and what it holds when the page changed or limited it (not for password fields). Use browser_type to add at the caret instead, and browser_request_credentials for passwords and codes. Never use the desktop press_key or type_text for a Chrome tab: those go to whichever Chrome window is in front, which can be the user's.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "index": {
                        "type": "integer",
                        "description": "Element index of the field from the latest browser_snapshot of this tab. An index naming a wrapper that holds exactly one field fills that field."
                    },
                    "text": {
                        "type": "string",
                        "description": "The field's new value, replacing everything in it. Empty clears the field."
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "Append a current snapshot and readiness status after acting. Without wait_for_selector, only a short pause and bounded navigation wait are used; SPA readiness is not guaranteed. Snapshot indices replace earlier ones. A timeout does not mean the action failed: re-observe with browser_snapshot before repeating it."
                    },
                    "wait_for_selector": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000,
                        "description": "Wait for any visible element matching this CSS selector in the page, including open shadow roots (web components); child frames are not searched, and a timeout says how many were visible. On actions requires return_state=true. Returns readiness met, timeout or error; only this condition is checked, not general app readiness. Prefer a selector specific to the expected new UI."
                    },
                    "wait_timeout_ms": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 10000,
                        "description": "Bound for wait_for_selector in milliseconds (default 8000, maximum 10000; 0 checks once). Requires wait_for_selector. Timeout preserves action success and returns current state. Use browser_snapshot with the same wait to re-observe without repeating an action."
                    }
                },
                "required": ["tab_id", "index", "text"]
            },
            "annotations": {
                "title": "Fill field in browser",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_upload_file",
            "description": "Attach local files to a file input in one of the agent's tabs, by its browser_snapshot index, as if the user had picked them: Chrome sets the input's files and the page gets its usual input and change events. No file picker opens, the tab is not selected or raised, and no keyboard or mouse input is used. Snapshots list file inputs as input[file], including ones a page hides behind a styled upload button; the index of a label for one works too, and any other element is refused. Paths are absolute paths of regular files on the computer running Chrome and this server, which may not be the machine you run on; each is checked before anything is sent. Several paths need an input that takes several files (multiple). This only stages the files in the input: it never submits the form, and the site has not received them until the page shows it has. Submit or press the page's upload button yourself when the user wants that, then check the page. The reply names the files the input now holds. Never click a file input or its upload button to open the picker: the native dialog cannot be driven from here.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "index": {
                        "type": "integer",
                        "description": "Element index of the file input (input[file]), or of a label for one, from the latest browser_snapshot of this tab."
                    },
                    "paths": {
                        "type": "array",
                        "items": {
                            "type": "string"
                        },
                        "minItems": 1,
                        "maxItems": 50,
                        "description": "Absolute paths of the files to attach, on the computer running Chrome and this server. Each must exist and be a regular file, not a folder. More than one needs an input with the multiple attribute. Replaces whatever files the input held."
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "Append a current snapshot and readiness status after acting. Without wait_for_selector, only a short pause and bounded navigation wait are used; SPA readiness is not guaranteed. Snapshot indices replace earlier ones. A timeout does not mean the action failed: re-observe with browser_snapshot before repeating it."
                    },
                    "wait_for_selector": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000,
                        "description": "Wait for any visible element matching this CSS selector in the page, including open shadow roots (web components); child frames are not searched, and a timeout says how many were visible. On actions requires return_state=true. Returns readiness met, timeout or error; only this condition is checked, not general app readiness. Prefer a selector specific to the expected new UI."
                    },
                    "wait_timeout_ms": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 10000,
                        "description": "Bound for wait_for_selector in milliseconds (default 8000, maximum 10000; 0 checks once). Requires wait_for_selector. Timeout preserves action success and returns current state. Use browser_snapshot with the same wait to re-observe without repeating an action."
                    }
                },
                "required": ["tab_id", "index", "paths"]
            },
            "annotations": {
                "title": "Attach files in browser",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_request_credentials",
            "description": "Ask the user to sign in on the page in one of the agent's tabs without the values passing through you. Chrome shows the user a small window naming the site's real origin, with one field per input you list; what they type goes straight into those inputs and is never returned to you. Use it for passwords, verification codes and any secret instead of browser_type, and never ask the user to paste a secret into the conversation. Take the input indices from browser_snapshot (password inputs show as input[password]), then click the page's sign-in button yourself. Waits until the user answers, cancels, or the time runs out.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "fields": {
                        "type": "array",
                        "description": "The inputs to fill, in the order the user should see them (1 to 6)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "index": {
                                    "type": "integer",
                                    "description": "Input index from the latest browser_snapshot of this tab"
                                },
                                "kind": {
                                    "type": "string",
                                    "enum": ["username", "email", "password", "code", "text"],
                                    "description": "What the user is asked for; inferred from the input's type when omitted"
                                }
                            },
                            "required": ["index"]
                        }
                    },
                    "reason": {
                        "type": "string",
                        "description": "One sentence the user sees explaining why you need to sign in"
                    },
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "How long to wait for the user (default 180, at most 600)"
                    }
                },
                "required": ["tab_id", "fields"]
            },
            "annotations": {
                "title": "Ask the user to sign in",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": true
            }
        },
        {
            "name": "browser_press_key",
            "description": "Press a key in one of the agent's tabs, optionally with modifiers held: Enter to submit, Tab to move to the next field, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, F1-F12, a character, or a shortcut such as key='a' modifiers=['cmd'] to select all in the focused field. Works in a background tab: the key goes to that tab's page only, never to the user's windows, and browser shortcuts (close tab, quit) never reach Chrome itself. Editing shortcuts (select all, copy, cut, paste, undo) work with cmd or ctrl on every platform. The reply says where focus is and how many characters are selected. Tab fails rather than leave focus where it was, and Backspace checks the focused field changed. Use browser_type for text and browser_fill to replace a field's value. Never use the desktop press_key or type_text for a Chrome tab: those go to whichever Chrome window is in front, which can be the user's. Enter can submit forms and Backspace deletes, so check the page state with browser_snapshot first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "key": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 40,
                        "description": "Key to press: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space, F1-F12 or a single character. A combination such as 'cmd+a' is accepted too."
                    },
                    "modifiers": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["cmd", "ctrl", "alt", "shift"]
                        },
                        "maxItems": 4,
                        "description": "Modifier keys held during the press. cmd is Command on macOS and the Windows key elsewhere; for editing shortcuts cmd and ctrl mean the same on every platform."
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "Append a current snapshot and readiness status after acting. Without wait_for_selector, only a short pause and bounded navigation wait are used; SPA readiness is not guaranteed. Snapshot indices replace earlier ones. A timeout does not mean the action failed: re-observe with browser_snapshot before repeating it."
                    },
                    "wait_for_selector": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000,
                        "description": "Wait for any visible element matching this CSS selector in the page, including open shadow roots (web components); child frames are not searched, and a timeout says how many were visible. On actions requires return_state=true. Returns readiness met, timeout or error; only this condition is checked, not general app readiness. Prefer a selector specific to the expected new UI."
                    },
                    "wait_timeout_ms": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 10000,
                        "description": "Bound for wait_for_selector in milliseconds (default 8000, maximum 10000; 0 checks once). Requires wait_for_selector. Timeout preserves action success and returns current state. Use browser_snapshot with the same wait to re-observe without repeating an action."
                    }
                },
                "required": ["tab_id", "key"]
            },
            "annotations": {
                "title": "Press key in browser",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_handle_dialog",
            "description": "Answer the JavaScript dialog (alert, confirm, prompt or leave-page) open in one of the agent's tabs. While one is open the page is paused: browser_snapshot shows the dialog's type, message and dialog_id instead of the page, and other browser commands on the tab say a dialog is open. accept presses OK and dismiss presses Cancel. prompt_text is entered into a prompt before accepting it; without it, a prompt is accepted with its default text. Pass the dialog_id from the snapshot, so a dialog that replaced the one you read is refused instead of answered. Works on a background tab without showing it or using the keyboard. A dialog that opened before the agent attached to the tab cannot be seen or answered; the user answers that one in Chrome. Accepting a confirm can submit, delete or leave a page with unsaved changes, so read the message, and ask the user before confirming anything irreversible.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "action": {
                        "type": "string",
                        "enum": ["accept", "dismiss"],
                        "description": "accept (OK) or dismiss (Cancel)"
                    },
                    "prompt_text": {
                        "type": "string",
                        "description": "Text to enter into a prompt dialog before accepting it. Only with action=accept on a prompt"
                    },
                    "dialog_id": {
                        "type": "string",
                        "description": "dialog_id of the dialog being answered, from browser_snapshot (such as d3). A different dialog open now is refused instead of answered"
                    }
                },
                "required": ["tab_id", "action"]
            },
            "annotations": {
                "title": "Answer JavaScript dialog",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": true
            }
        },
        {
            "name": "browser_close_all_tabs",
            "description": "Close every tab the agent opened, including tabs its clicks opened, and remove its tab group. Tabs taken over with browser_use_tab are released back to the user, not closed. Call this when finished with the browser so no empty group is left in the user's tab strip. The MCP process also runs this automatically when the Computer Use session ends. Unsaved state in the agent's tabs is lost.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    }
                }
            },
            "annotations": {
                "title": "Close all agent tabs",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": true,
                "openWorldHint": false
            }
        },
        {
            "name": "browser_navigate",
            "description": "Point one of the agent's tabs at a different URL, replacing the current page; unsaved page state is lost. Use browser_open_tab to keep the current page and open another. Follow with browser_snapshot, since element indices reset after navigation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Stable task or thread ID. Pass the same value on every browser call for this task. Different IDs isolate tabs and cleanup within one MCP process. Omit for the default process session."
                    },
                    "tab_id": {
                        "type": "integer",
                        "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs"
                    },
                    "url": {
                        "type": "string",
                        "description": "Absolute URL to load in the tab"
                    },
                    "return_state": {
                        "type": "boolean",
                        "description": "Append a current snapshot and readiness status after acting. Without wait_for_selector, only a short pause and bounded navigation wait are used; SPA readiness is not guaranteed. Snapshot indices replace earlier ones. A timeout does not mean the action failed: re-observe with browser_snapshot before repeating it."
                    },
                    "wait_for_selector": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000,
                        "description": "Wait for any visible element matching this CSS selector in the page, including open shadow roots (web components); child frames are not searched, and a timeout says how many were visible. On actions requires return_state=true. Returns readiness met, timeout or error; only this condition is checked, not general app readiness. Prefer a selector specific to the expected new UI."
                    },
                    "wait_timeout_ms": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 10000,
                        "description": "Bound for wait_for_selector in milliseconds (default 8000, maximum 10000; 0 checks once). Requires wait_for_selector. Timeout preserves action success and returns current state. Use browser_snapshot with the same wait to re-observe without repeating an action."
                    }
                },
                "required": ["tab_id", "url"]
            },
            "annotations": {
                "title": "Navigate browser tab",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": true
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::{all_tool_defs, tool_defs};

    /// The macOS server advertises exactly these 37 tools. Drifting apart would
    /// silently give a model different capabilities per platform.
    #[test]
    fn advertises_the_macos_tool_surface() {
        let defs = all_tool_defs();
        let names: Vec<&str> = defs
            .as_array()
            .expect("tool defs are an array")
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool has a name"))
            .collect();

        assert_eq!(names.len(), 37, "tool count drifted from the macOS server");
        for expected in [
            "list_apps",
            "get_app_state",
            "click",
            "type_text",
            "press_key",
            "scroll",
            "activate_app",
            "screenshot",
            "list_displays",
            "right_click",
            "drag",
            "set_value",
            "zoom",
            "hover",
            "wait",
            "run_steps",
            "select_text",
            "clipboard_read",
            "clipboard_write",
            "browser_open_tab",
            "browser_list_tabs",
            "browser_use_tab",
            "browser_release_tab",
            "browser_select_tab",
            "browser_close_tab",
            "browser_snapshot",
            "browser_read",
            "browser_page_errors",
            "browser_click",
            "browser_type",
            "browser_fill",
            "browser_upload_file",
            "browser_request_credentials",
            "browser_press_key",
            "browser_handle_dialog",
            "browser_close_all_tabs",
            "browser_navigate",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
    }

    #[test]
    fn every_tool_has_a_top_level_title_matching_its_annotation() {
        for tool in tool_defs().as_array().expect("tool defs are an array") {
            assert!(tool["title"].is_string(), "{} has no title", tool["name"]);
            assert_eq!(tool["title"], tool["annotations"]["title"]);
        }
    }

    #[test]
    fn every_tool_declares_an_object_input_schema() {
        for tool in tool_defs().as_array().expect("tool defs are an array") {
            let schema = &tool["inputSchema"];
            assert_eq!(
                schema["type"].as_str(),
                Some("object"),
                "{} has a non-object input schema",
                tool["name"]
            );
            assert!(
                schema["properties"].is_object(),
                "{} is missing properties",
                tool["name"]
            );
        }
    }
}
