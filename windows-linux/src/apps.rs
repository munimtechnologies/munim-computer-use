//! Running-application discovery, shared by the Windows and Linux backends.
//!
//! Both platforms can enumerate windows through `xcap`, and a window list is
//! exactly what `list_apps` reports: an app with no window is not something the
//! model can drive, so grouping windows by pid gives the right answer on both
//! without touching Win32 or X11 directly.

use std::collections::HashMap;

use xcap::Window;

use crate::platform::{AppInfo, DesktopError, Result};

struct Group {
    name: String,
    pid: u32,
    windows: usize,
    focused: bool,
    /// The window that best identifies this instance, ranked by `title_rank`.
    title: String,
    title_rank: (bool, bool, u64),
}

fn grouped_windows() -> Result<Vec<Group>> {
    // xcap's `Window::all` enumerates via X11/`xcb` when `DISPLAY` is set — no
    // process-wide `WAYLAND_DISPLAY` mutation needed (that is UB with threads).
    // Same panic hazard as capture: xcap aborts on compositors it cannot read.
    let windows = std::panic::catch_unwind(Window::all)
        .map_err(|_| DesktopError::new("window enumeration is not supported by this display server"))?
        .map_err(|error| DesktopError::new(format!("failed to enumerate windows: {error}")))?;

    let mut groups: HashMap<u32, Group> = HashMap::new();
    for window in windows {
        let pid = window.pid().unwrap_or(0);
        if pid == 0 {
            continue;
        }
        // Some compositors report zero-sized shadow windows; they are not
        // something a model can act on and would inflate the window count.
        if window.width().unwrap_or(0) == 0 || window.height().unwrap_or(0) == 0 {
            continue;
        }

        let name = window
            .app_name()
            .ok()
            .filter(|name| !name.is_empty())
            .or_else(|| window.title().ok().filter(|title| !title.is_empty()))
            .unwrap_or_else(|| format!("pid {pid}"));
        let focused = window.is_focused().unwrap_or(false);
        // Two instances of one app share a name; their main window titles are
        // what tells them apart. Prefer the focused window, then the largest
        // one that is not minimized; untitled popups never win.
        let title = window.title().unwrap_or_default();
        let area = u64::from(window.width().unwrap_or(0)) * u64::from(window.height().unwrap_or(0));
        let rank = if title.trim().is_empty() {
            (false, false, 0)
        } else {
            (focused, !window.is_minimized().unwrap_or(false), area)
        };

        let group = groups.entry(pid).or_insert(Group {
            name,
            pid,
            windows: 0,
            focused: false,
            title: String::new(),
            title_rank: (false, false, 0),
        });
        group.windows += 1;
        group.focused |= focused;
        if group.title.is_empty() || rank > group.title_rank {
            group.title = title;
            group.title_rank = rank;
        }
    }

    Ok(groups.into_values().collect())
}

pub fn list_apps() -> Result<Vec<AppInfo>> {
    Ok(grouped_windows()
        .map(|groups| {
            groups
                .into_iter()
                .map(|group| AppInfo {
                    id: group.name.to_lowercase().replace(' ', "-"),
                    name: group.name,
                    pid: group.pid,
                    windows: group.windows,
                    frontmost: group.focused,
                    title: group.title,
                })
                .collect()
        })?)
}

/// Resolve an app query to a pid.
///
/// Accepts a literal pid, an exact name, or a unique case-insensitive substring.
/// An ambiguous substring is an error listing the candidates rather than a guess,
/// because silently driving the wrong window is worse than asking again.
pub fn resolve_pid(query: &str) -> Result<u32> {
    let query = query.trim();
    if query.is_empty() {
        return Err(DesktopError::new(
            "app query is empty — call list_apps, or pass a numeric pid",
        ));
    }
    if let Ok(pid) = query.parse::<u32>() {
        return Ok(pid);
    }

    // Minimal window managers (WSLg among them) do not publish the EWMH
    // properties window enumeration needs. Keep the guidance rather than
    // surfacing an X11 property name the model can do nothing with.
    let apps = list_apps().map_err(|error| {
        DesktopError::new(format!(
            "cannot enumerate windows on this session ({}) — call list_apps, or pass a numeric pid",
            error.0
        ))
    })?;
    let lowered = query.to_lowercase();

    let exact: Vec<&AppInfo> = apps
        .iter()
        .filter(|app| app.name.to_lowercase() == lowered || app.id == lowered)
        .collect();
    if !exact.is_empty() {
        return pick_from_matches(query, &exact);
    }

    let matches: Vec<&AppInfo> = apps
        .iter()
        .filter(|app| app.name.to_lowercase().contains(&lowered))
        .collect();
    pick_from_matches(query, &matches)
}

fn pick_from_matches(query: &str, matches: &[&AppInfo]) -> Result<u32> {
    match matches {
        [single] => Ok(single.pid),
        [] => Err(DesktopError::new(format!(
            "no running app matches '{query}' — call list_apps to see what is open"
        ))),
        several => Err(DesktopError::new(ambiguity_message(query, several))),
    }
}

/// Name every candidate well enough to choose from without another call: the
/// windows can change between list_apps and this lookup, so the error, not an
/// earlier inventory, has to carry each pid and what tells the instances apart.
fn ambiguity_message(query: &str, several: &[&AppInfo]) -> String {
    let candidates: Vec<String> = several
        .iter()
        .map(|app| {
            let mut detail = format!("{} window{}", app.windows, if app.windows == 1 { "" } else { "s" });
            if !app.title.trim().is_empty() {
                detail.push_str(&format!(", \"{}\"", crate::platform::outline::truncate(&app.title, 80)));
            }
            if app.frontmost {
                detail.push_str(", frontmost");
            }
            format!("pid {} ({detail})", app.pid)
        })
        .collect();
    let same_app = several.iter().all(|app| app.id == several[0].id);
    let what = if same_app {
        format!("{} running instances of {}", several.len(), several[0].name)
    } else {
        format!("{} apps", several.len())
    };
    format!(
        "'{query}' matches {what}: {} — pass the pid of the one you mean; list_apps lists each instance on its own row",
        candidates.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::{ambiguity_message, resolve_pid};
    use crate::platform::AppInfo;

    fn chrome(pid: u32, title: &str, frontmost: bool) -> AppInfo {
        AppInfo {
            name: "Google Chrome".into(),
            id: "google-chrome".into(),
            pid,
            windows: 1,
            frontmost,
            title: title.into(),
        }
    }

    // #29: the error has to be enough to pick an instance on its own.
    #[test]
    fn an_ambiguous_alias_names_every_instance_with_its_pid_and_window() {
        let first = chrome(14756, "GitHub - Google Chrome", false);
        let second = chrome(28400, "New Tab - Google Chrome", true);
        let message = ambiguity_message("google-chrome", &[&first, &second]);
        assert!(message.contains("2 running instances of Google Chrome"), "{message}");
        assert!(message.contains("pid 14756 (1 window, \"GitHub - Google Chrome\")"), "{message}");
        assert!(message.contains("pid 28400 (1 window, \"New Tab - Google Chrome\", frontmost)"), "{message}");
        assert!(message.contains("pass the pid"), "{message}");
    }

    #[test]
    fn a_numeric_query_is_taken_as_a_pid_without_enumerating() {
        // Must hold on a headless CI box where window enumeration returns nothing.
        assert_eq!(resolve_pid("4321").unwrap(), 4321);
        assert_eq!(resolve_pid("  4321  ").unwrap(), 4321);
    }

    #[test]
    fn an_unmatched_name_points_at_list_apps() {
        let error = resolve_pid("definitely-not-running-xyzzy").unwrap_err().0;
        assert!(error.contains("list_apps"), "unhelpful: {error}");
    }

    #[test]
    fn whitespace_only_query_does_not_resolve_to_the_sole_app() {
        let error = resolve_pid("   ").unwrap_err().0;
        assert!(error.contains("empty"), "unhelpful: {error}");
    }
}
