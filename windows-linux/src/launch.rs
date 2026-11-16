//! launch_app: start an installed app that is not running yet.
//!
//! Windows finds apps the way its Start menu lists them (`Get-StartApps`,
//! which covers both desktop programs and packaged apps such as Calculator)
//! and starts one through `shell:AppsFolder`, exactly as clicking its Start
//! menu entry would. Linux reads the freedesktop `.desktop` entries that app
//! launchers list and runs the entry's `Exec` line. The macOS server does the
//! same through Launch Services (`toolLaunchApp` in main.swift).
//!
//! Whether the launch worked is judged by what appears: a running app with a
//! window that was not there before, read the same way `list_apps` reads it.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use crate::platform::{AppInfo, DesktopError, Result};

/// How long launch_app waits for the new app's first window by default.
pub const DEFAULT_WAIT_SECS: f64 = 10.0;
pub const MAX_WAIT_SECS: f64 = 30.0;

/// An installed app, as the system's app list names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installed {
    pub name: String,
    /// What starts it: a Start menu AppID on Windows, the `.desktop` file id on Linux.
    pub id: String,
    /// The command line on Linux (from `Exec`, field codes removed).
    pub command: Vec<String>,
}

/// Choose the one installed app `query` names: an exact name or id first
/// (ignoring case), then a unique name that starts with it, then a unique name
/// that contains it. Several candidates are an error that lists them, as an
/// ambiguous running app is, rather than a guess.
pub fn choose<'a>(query: &str, installed: &'a [Installed]) -> Result<&'a Installed> {
    let wanted = query.trim().to_lowercase();
    if wanted.is_empty() {
        return Err(DesktopError::new("missing required argument 'app'"));
    }
    let exact: Vec<&Installed> = installed
        .iter()
        .filter(|app| app.name.to_lowercase() == wanted || app.id.to_lowercase() == wanted)
        .collect();
    if let [one, ..] = exact.as_slice() {
        return Ok(one);
    }
    let starts = |name: &str| name.starts_with(&wanted);
    let contains = |name: &str| name.contains(&wanted);
    let tests: [&dyn Fn(&str) -> bool; 2] = [&starts, &contains];
    for test in tests {
        let found: Vec<&Installed> = installed.iter().filter(|app| test(&app.name.to_lowercase())).collect();
        match found.as_slice() {
            [] => continue,
            [one] => return Ok(one),
            several => {
                let mut names: Vec<&str> = several.iter().map(|app| app.name.as_str()).collect();
                names.sort_unstable();
                names.dedup();
                let shown = names.iter().take(10).map(|name| format!("\"{name}\"")).collect::<Vec<_>>().join(", ");
                let more = names.len().saturating_sub(10);
                return Err(DesktopError::new(format!(
                    "'{query}' matches {} installed apps: {shown}{} — pass the full name of the one you mean",
                    names.len(),
                    if more > 0 { format!(" and {more} more") } else { String::new() }
                )));
            }
        }
    }
    Err(DesktopError::new(format!(
        "no installed app is named '{query}' — pass the name its {} lists, or call list_apps if it is already running",
        if cfg!(windows) { "Start menu" } else { "app launcher" }
    )))
}

/// A running app that is this installed app, matched by name or list_apps id.
pub fn already_running<'a>(app: &Installed, query: &str, running: &'a [AppInfo]) -> Option<&'a AppInfo> {
    let names = [app.name.to_lowercase(), query.trim().to_lowercase()];
    running
        .iter()
        .filter(|info| info.windows > 0)
        .find(|info| names.iter().any(|name| info.name.to_lowercase() == *name || info.id == name.replace(' ', "-")))
}

/// The app that appeared after a launch: among apps whose pid is new, the one
/// whose name shares a word with what was launched, else the only new one.
pub fn newcomer<'a>(app: &Installed, before: &HashSet<u32>, now: &'a [AppInfo]) -> Option<&'a AppInfo> {
    let fresh: Vec<&AppInfo> = now.iter().filter(|info| info.windows > 0 && !before.contains(&info.pid)).collect();
    let words: Vec<String> = app
        .name
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.len() > 2)
        .map(str::to_string)
        .collect();
    fresh
        .iter()
        .copied()
        .find(|info| {
            let name = info.name.to_lowercase();
            words.iter().any(|word| name.contains(word.as_str()))
        })
        .or(match fresh.as_slice() {
            [only] => Some(*only),
            _ => None,
        })
}

/// Start `app`, then wait up to `wait` for its window. The reply names the
/// running app to use with get_app_state, or says the launch is still loading.
pub fn launch_and_wait(app: &Installed, wait: Duration) -> Result<String> {
    let before: HashSet<u32> = crate::apps::list_apps().unwrap_or_default().into_iter().map(|info| info.pid).collect();
    start(app)?;
    let deadline = Instant::now() + wait;
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let now = crate::apps::list_apps().unwrap_or_default();
        if let Some(info) = newcomer(app, &before, &now) {
            return Ok(format!(
                "launched {} — it is running as {} (pid {}) with {} window{}. Read it with get_app_state app=\"{}\"",
                app.name,
                info.name,
                info.pid,
                info.windows,
                if info.windows == 1 { "" } else { "s" },
                info.pid
            ));
        }
        if Instant::now() >= deadline {
            return Ok(format!(
                "asked the system to start {}, but no new window appeared within {:.0} s — it may still be loading, or it \
                 opened in a copy that was already running. Call wait, then list_apps",
                app.name,
                wait.as_secs_f64()
            ));
        }
    }
}

// ── Windows ─────────────────────────────────────────────────────────────────

/// Every app the Start menu lists, desktop programs and packaged apps alike.
#[cfg(windows)]
pub fn installed() -> Result<Vec<Installed>> {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // UTF-8 out, so app names outside the console code page survive.
    let script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
                  Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress";
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| DesktopError::new(format!("could not read the Start menu's app list: {error}")))?;
    if !output.status.success() {
        return Err(DesktopError::new(format!(
            "could not read the Start menu's app list: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(parse_start_apps(&String::from_utf8_lossy(&output.stdout)))
}

/// `Get-StartApps | ConvertTo-Json`: an array, or a bare object for one app.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_start_apps(json: &str) -> Vec<Installed> {
    let value: serde_json::Value = serde_json::from_str(json.trim().trim_start_matches('\u{feff}')).unwrap_or_default();
    let items = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    items
        .iter()
        .filter_map(|item| {
            let name = item.get("Name")?.as_str()?.trim().to_string();
            let id = item.get("AppID")?.as_str()?.trim().to_string();
            (!name.is_empty() && !id.is_empty()).then_some(Installed { name, id, command: Vec::new() })
        })
        .collect()
}

/// Start it the way its Start menu entry does: through the shell's app folder,
/// which handles desktop programs and packaged apps alike.
#[cfg(windows)]
fn start(app: &Installed) -> Result<()> {
    std::process::Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{}", app.id))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| DesktopError::new(format!("could not start {}: {error}", app.name)))
}

// ── Linux ───────────────────────────────────────────────────────────────────

/// Every app an app launcher would list: the `.desktop` entries in the XDG
/// data directories, the user's own first, hidden and terminal ones left out.
#[cfg(target_os = "linux")]
pub fn installed() -> Result<Vec<Installed>> {
    let home = std::env::var("HOME").unwrap_or_default();
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|dir| !dir.is_empty())
        .unwrap_or_else(|| format!("{home}/.local/share"));
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|dirs| !dirs.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    let mut seen = HashSet::new();
    let mut apps = Vec::new();
    for dir in std::iter::once(data_home.as_str()).chain(data_dirs.split(':')) {
        let root = std::path::Path::new(dir).join("applications");
        collect_desktop_entries(&root, &root, 0, &mut seen, &mut apps);
    }
    Ok(apps)
}

#[cfg(target_os = "linux")]
fn collect_desktop_entries(
    root: &std::path::Path,
    dir: &std::path::Path,
    depth: usize,
    seen: &mut HashSet<String>,
    apps: &mut Vec<Installed>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < 3 {
                collect_desktop_entries(root, &path, depth + 1, seen, apps);
            }
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("desktop") {
            continue;
        }
        // The desktop file id: its path under applications/, with / as -.
        let Some(id) = path
            .strip_prefix(root)
            .ok()
            .and_then(|relative| relative.to_str())
            .map(|relative| relative.trim_end_matches(".desktop").replace('/', "-"))
        else {
            continue;
        };
        // An earlier directory's entry with the same id overrides this one.
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path)
            && let Some(app) = parse_desktop_entry(&id, &text)
        {
            apps.push(app);
        }
    }
}

/// One `.desktop` file's launchable app, or None for one that is hidden, not
/// an application, needs a terminal, or has no command.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_desktop_entry(id: &str, text: &str) -> Option<Installed> {
    let mut in_entry = false;
    let (mut name, mut exec, mut kind) = (None, None, None);
    let (mut hidden, mut terminal) = (false, false);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        match key.trim() {
            "Name" => name = Some(value.trim().to_string()),
            "Exec" => exec = Some(value.trim().to_string()),
            "Type" => kind = Some(value.trim().to_string()),
            "Hidden" | "NoDisplay" => hidden |= value.trim().eq_ignore_ascii_case("true"),
            "Terminal" => terminal = value.trim().eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    if hidden || terminal || kind.as_deref() != Some("Application") {
        return None;
    }
    let command = exec_command(&exec?)?;
    Some(Installed { name: name?, id: id.to_string(), command })
}

/// An `Exec` value as argv: quoted arguments unquoted, escapes undone, and the
/// field codes (`%f`, `%U`, …) that stand for files to open dropped, since
/// launch_app opens none.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn exec_command(exec: &str) -> Option<Vec<String>> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has_arg = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                has_arg = true;
            }
            '\\' if quoted => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            ' ' | '\t' if !quoted => {
                if has_arg {
                    args.push(std::mem::take(&mut current));
                    has_arg = false;
                }
            }
            '%' => match chars.next() {
                Some('%') => {
                    current.push('%');
                    has_arg = true;
                }
                // Field codes expand to nothing here.
                Some(_) | None => {}
            },
            _ => {
                current.push(c);
                has_arg = true;
            }
        }
    }
    if has_arg {
        args.push(current);
    }
    args.retain(|arg| !arg.is_empty());
    (!args.is_empty() && !quoted).then_some(args)
}

/// Run the entry's command detached from this server: its own process group,
/// no shared stdio, so it outlives the server and never writes into MCP.
#[cfg(target_os = "linux")]
fn start(app: &Installed) -> Result<()> {
    use std::os::unix::process::CommandExt as _;
    let (program, rest) = app
        .command
        .split_first()
        .ok_or_else(|| DesktopError::new(format!("{} has no command to run", app.name)))?;
    std::process::Command::new(program)
        .args(rest)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map(|_| ())
        .map_err(|error| DesktopError::new(format!("could not start {}: {error}", app.name)))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn installed() -> Result<Vec<Installed>> {
    Err(DesktopError::new("launch_app is served by the macOS Swift server on macOS"))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn start(app: &Installed) -> Result<()> {
    Err(DesktopError::new(format!("cannot start {} on this platform", app.name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, id: &str) -> Installed {
        Installed { name: name.into(), id: id.into(), command: Vec::new() }
    }

    fn running(name: &str, pid: u32) -> AppInfo {
        AppInfo { name: name.into(), id: name.to_lowercase().replace(' ', "-"), pid, windows: 1, frontmost: false, title: String::new() }
    }

    #[test]
    fn an_app_is_chosen_by_exact_name_then_prefix_then_substring() {
        let apps = [
            app("Calculator", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"),
            app("Visual Studio Code", "Microsoft.VisualStudioCode"),
            app("Visual Studio Installer", "vsinstaller"),
            app("Notepad", "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"),
            app("Notepad++", "notepad++"),
        ];
        assert_eq!(choose("calculator", &apps).unwrap().name, "Calculator");
        assert_eq!(choose("notepad", &apps).unwrap().name, "Notepad", "exact beats prefix");
        assert_eq!(choose("Microsoft.VisualStudioCode", &apps).unwrap().name, "Visual Studio Code");
        assert_eq!(choose("calc", &apps).unwrap().name, "Calculator");
        assert_eq!(choose("code", &apps).unwrap().name, "Visual Studio Code");
        let several = choose("visual", &apps).unwrap_err().0;
        assert!(several.contains("matches 2 installed apps") && several.contains("\"Visual Studio Installer\""), "{several}");
        assert!(choose("photoshop", &apps).unwrap_err().0.contains("no installed app is named 'photoshop'"));
        assert!(choose("  ", &apps).is_err());
    }

    #[test]
    fn a_running_copy_is_found_by_name_and_a_newcomer_by_its_new_pid() {
        let calc = app("Calculator", "x");
        let list = [running("Calculator", 40), running("Explorer", 4)];
        assert_eq!(already_running(&calc, "calc", &list).map(|info| info.pid), Some(40));
        assert!(already_running(&app("Notepad", "n"), "notepad", &list).is_none());

        let before: HashSet<u32> = [4].into();
        let after = [running("Explorer", 4), running("Windows Calculator", 41), running("Helper", 77)];
        assert_eq!(newcomer(&calc, &before, &after).map(|info| info.pid), Some(41), "the one sharing a word");
        let only = [running("Explorer", 4), running("CalculatorApp", 42)];
        assert_eq!(newcomer(&app("Calc", "x"), &before, &only).map(|info| info.pid), Some(42), "the only new one");
        assert!(newcomer(&calc, &before, &[running("Explorer", 4)]).is_none());
    }

    /// Reads this machine's real Start menu. Not run by default (a CI image
    /// may have no Start menu):  cargo test -- --ignored start_menu
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn start_menu_lists_installed_apps() {
        let apps = installed().expect("Get-StartApps answers");
        println!("{} Start menu apps, e.g. {:?}", apps.len(), apps.iter().take(5).map(|app| &app.name).collect::<Vec<_>>());
        assert!(apps.len() > 5, "{apps:?}");
        assert!(choose("notepad", &apps).is_ok() || choose("calculator", &apps).is_ok());
    }

    #[test]
    fn start_apps_json_is_read_as_a_list_or_a_single_app() {
        let many = r#"[{"Name":"Calculator","AppID":"Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"},{"Name":"","AppID":"x"},{"Name":"Café","AppID":"{6D809377}\\cafe.exe"}]"#;
        let apps = parse_start_apps(many);
        assert_eq!(apps.iter().map(|app| app.name.as_str()).collect::<Vec<_>>(), ["Calculator", "Café"]);
        assert_eq!(apps[1].id, "{6D809377}\\cafe.exe");
        assert_eq!(parse_start_apps(r#"{"Name":"Only","AppID":"only"}"#).len(), 1);
        assert!(parse_start_apps("not json").is_empty());
    }

    #[test]
    fn a_desktop_entry_becomes_a_command_without_its_field_codes() {
        let entry = "[Desktop Entry]\nType=Application\nName=Text Editor\nExec=gnome-text-editor --new-window %U\n\n[Desktop Action new]\nName=New\nExec=other\n";
        let app = parse_desktop_entry("org.gnome.TextEditor", entry).unwrap();
        assert_eq!(app.name, "Text Editor");
        assert_eq!(app.command, ["gnome-text-editor", "--new-window"]);
        let quoted = parse_desktop_entry("q", "[Desktop Entry]\nType=Application\nName=Q\nExec=\"/opt/My App/run\" --title \"a \\\"b\\\"\" 100%%\n").unwrap();
        assert_eq!(quoted.command, ["/opt/My App/run", "--title", "a \"b\"", "100%"]);
        assert!(parse_desktop_entry("t", "[Desktop Entry]\nType=Application\nName=Top\nExec=top\nTerminal=true\n").is_none());
        assert!(parse_desktop_entry("h", "[Desktop Entry]\nType=Application\nName=H\nExec=h\nNoDisplay=true\n").is_none());
        assert!(parse_desktop_entry("l", "[Desktop Entry]\nType=Link\nName=L\nURL=https://x\n").is_none());
        assert!(exec_command("\"unterminated").is_none());
    }
}
