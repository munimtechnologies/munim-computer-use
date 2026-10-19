//! What a browser call that cannot reach Chrome needs to say, and what
//! `check-native-host` reports about the bridge (#36): which process owns the
//! bridge, why this one could not join it, and whether the extension is even
//! installed. Without these, "not connected" covers three different fixes:
//! install the extension, end a stale server, or start the servers from one
//! security context.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

// ── the owner record ────────────────────────────────────────────────────────

/// What the bridge owner writes about itself, so a server that cannot join it
/// and `check-native-host` can name it. Servers before 0.7.3 write none.
#[derive(Clone, Debug, PartialEq)]
pub struct OwnerRecord {
    pub pid: u32,
    pub version: String,
    pub exe: String,
    pub started_unix: u64,
    pub extension_connected: bool,
    pub host_connections: u32,
    pub peer_endpoint: bool,
}

impl OwnerRecord {
    pub fn to_json(&self) -> Value {
        json!({
            "pid": self.pid,
            "version": self.version,
            "exe": self.exe,
            "startedUnix": self.started_unix,
            "extensionConnected": self.extension_connected,
            "hostConnections": self.host_connections,
            "peerEndpoint": self.peer_endpoint,
        })
    }

    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            pid: u32::try_from(value.get("pid")?.as_u64()?).ok()?,
            version: value.get("version")?.as_str()?.to_string(),
            exe: value.get("exe").and_then(Value::as_str).unwrap_or_default().to_string(),
            started_unix: value.get("startedUnix").and_then(Value::as_u64).unwrap_or(0),
            extension_connected: value.get("extensionConnected").and_then(Value::as_bool).unwrap_or(false),
            host_connections: value
                .get("hostConnections")
                .and_then(Value::as_u64)
                .and_then(|count| u32::try_from(count).ok())
                .unwrap_or(0),
            peer_endpoint: value.get("peerEndpoint").and_then(Value::as_bool).unwrap_or(true),
        })
    }

    /// `pid 1234 (munim-computer-use 0.7.3, C:\…\munim-computer-use.exe, started 3h ago)`.
    pub fn describe(&self) -> String {
        let started = match unix_now().checked_sub(self.started_unix) {
            Some(seconds) if self.started_unix > 0 => format!(", started {} ago", ago_secs(seconds)),
            _ => String::new(),
        };
        let exe = if self.exe.is_empty() { String::new() } else { format!(", {}", self.exe) };
        format!("pid {} (munim-computer-use {}{exe}{started})", self.pid, self.version)
    }

    /// Whether the extension is connected to this owner, in words.
    pub fn extension_state(&self) -> String {
        match (self.extension_connected, self.host_connections) {
            (true, _) => "which has the extension connected".into(),
            (false, 0) => "which has had no connection from the extension since it started".into(),
            (false, count) => format!(
                "which has no connection from the extension right now ({count} earlier connection{})",
                if count == 1 { "" } else { "s" }
            ),
        }
    }
}

pub fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0)
}

/// `12s`, `4m`, `3h`, `2d`.
pub fn ago_secs(seconds: u64) -> String {
    match seconds {
        0..90 => format!("{seconds}s"),
        90..5400 => format!("{}m", seconds / 60),
        5400..172_800 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86_400),
    }
}

fn owner_record_path() -> Option<PathBuf> {
    crate::identity::get().support_dir().map(|dir| dir.join("bridge-owner.json"))
}

/// Replace the owner record. Best effort: a server that cannot write it still
/// owns the bridge, it just cannot be named by the others.
pub fn write_owner_record(record: &OwnerRecord) {
    let Some(path) = owner_record_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write then rename, so a reader never sees half a record.
    let staged = path.with_extension(format!("json.{}", std::process::id()));
    if std::fs::write(&staged, format!("{:#}\n", record.to_json())).is_ok() && std::fs::rename(&staged, &path).is_err() {
        let _ = std::fs::remove_file(&staged);
    }
}

/// The recorded owner, if that process is still running the program it
/// recorded (a pid reused by another program is not the owner).
pub fn read_owner_record() -> Option<OwnerRecord> {
    let text = std::fs::read_to_string(owner_record_path()?).ok()?;
    let record = OwnerRecord::from_json(&serde_json::from_str(&text).ok()?)?;
    if record.pid == std::process::id() {
        return Some(record);
    }
    let exe = process_exe(record.pid)?;
    (record.exe.is_empty() || same_path(&exe, Path::new(&record.exe))).then_some(record)
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

pub fn current_exe() -> String {
    std::env::current_exe().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default()
}

// ── running servers ─────────────────────────────────────────────────────────

/// The program a process runs, if it is alive and this process may ask.
pub fn process_exe(pid: u32) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
        };
        use windows::core::PWSTR;
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let named =
            unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len) };
        let _ = unsafe { CloseHandle(handle) };
        named.ok()?;
        Some(PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])))
    }
    #[cfg(not(windows))]
    {
        std::fs::read_link(format!("/proc/{pid}/exe")).ok()
    }
}

/// A munim-computer-use process other than this one.
#[derive(Clone, Debug, PartialEq)]
pub struct Server {
    pub pid: u32,
    /// Full path when this process may read it, else the image name.
    pub exe: String,
}

/// The munim-computer-use processes running now, other than this one and the
/// relays Chrome starts (those are children of a browser).
pub fn running_servers() -> Vec<Server> {
    let me = std::process::id();
    let all = processes();
    let name_of = |pid: u32| all.iter().find(|process| process.pid == pid).map(|process| process.name.as_str());
    let mut servers: Vec<Server> = all
        .iter()
        .filter(|process| process.pid != me && is_server_image(&process.name))
        .filter(|process| !name_of(process.parent).is_some_and(is_browser_image))
        .map(|process| Server {
            pid: process.pid,
            exe: process_exe(process.pid).map_or_else(|| process.name.clone(), |path| path.to_string_lossy().into_owned()),
        })
        .collect();
    servers.sort_by_key(|server| server.pid);
    servers
}

fn is_server_image(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "munim-computer-use" || name == "munim-computer-use.exe"
}

fn is_browser_image(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    matches!(name, "chrome" | "msedge" | "brave" | "chromium" | "chromium-browser" | "google-chrome" | "chrome_proxy")
}

struct Process {
    pid: u32,
    parent: u32,
    name: String,
}

#[cfg(windows)]
fn processes() -> Vec<Process> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else { return Vec::new() };
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut found = Vec::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let len = entry.szExeFile.iter().position(|&unit| unit == 0).unwrap_or(entry.szExeFile.len());
        found.push(Process {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..len]),
        });
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    let _ = unsafe { CloseHandle(snapshot) };
    found
}

#[cfg(not(windows))]
fn processes() -> Vec<Process> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            // `pid (comm) state ppid …`; comm may itself contain parentheses.
            let open = stat.find('(')?;
            let close = stat.rfind(')')?;
            let name = stat[open + 1..close].to_string();
            let parent = stat[close + 1..].split_whitespace().nth(1)?.parse().ok()?;
            Some(Process { pid, parent, name })
        })
        .collect()
}

// ── why joining failed ──────────────────────────────────────────────────────

/// The owner's peer endpoint could not be reached, in words that say why.
pub fn join_failure(error: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::PermissionDenied => format!(
            "its peer endpoint refused this server ({error}): the two run in different security contexts, such as \
             a sandbox, an elevated (administrator) process, or another user account"
        ),
        ErrorKind::NotFound => "it has no peer endpoint to join: it is from a build before 0.6, or its endpoint \
             failed to open"
            .into(),
        ErrorKind::ConnectionRefused => format!(
            "its peer endpoint refused the connection ({error}): the server that opened it may have exited \
             without closing it"
        ),
        _ => format!("connecting to its peer endpoint failed: {error}"),
    }
}

// ── is the extension installed? ─────────────────────────────────────────────

/// Where an extension id was found in a browser profile.
#[derive(Clone, Debug, PartialEq)]
pub struct Installed {
    /// `Google Chrome/Default`.
    pub profile: String,
    pub enabled: bool,
}

/// The extension in every profile of every Chromium browser found, and how
/// many profiles were looked at.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Presence {
    pub profiles: Vec<String>,
    pub found: Vec<Installed>,
}

impl Presence {
    pub fn look(extension_id: &str) -> Self {
        let mut presence = Self::default();
        for (browser, dir) in user_data_dirs() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            let mut profiles: Vec<String> = entries
                .flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .filter(|name| name == "Default" || name.starts_with("Profile "))
                .filter(|name| dir.join(name).join("Preferences").is_file())
                .collect();
            profiles.sort();
            for profile in profiles {
                let label = format!("{browser}/{profile}");
                if let Some(enabled) = installed_in(&dir.join(&profile), extension_id) {
                    presence.found.push(Installed { profile: label.clone(), enabled });
                }
                presence.profiles.push(label);
            }
        }
        presence
    }

    /// One sentence for a tool error, and the step it calls for; `None` when
    /// the extension is installed and enabled, or no browser profile was found
    /// (then nothing can be told either way).
    pub fn problem(&self, extension_id: &str) -> Option<(String, String)> {
        if self.profiles.is_empty() {
            return None;
        }
        if self.found.is_empty() {
            return Some((
                format!(
                    "The extension (id {extension_id}) is not installed in any browser profile on this computer \
                     (checked {})",
                    self.profiles.join(", ")
                ),
                format!("install it first: {INSTALL_EXTENSION}"),
            ));
        }
        if self.found.iter().all(|installed| !installed.enabled) {
            let profiles: Vec<&str> = self.found.iter().map(|installed| installed.profile.as_str()).collect();
            return Some((
                format!("The extension is installed but disabled in {}", profiles.join(", ")),
                "turn it on at chrome://extensions".into(),
            ));
        }
        None
    }

    pub fn to_json(&self) -> Value {
        json!({
            "profilesChecked": self.profiles,
            "found": self.found.iter().map(|installed| json!({
                "profile": installed.profile,
                "enabled": installed.enabled,
            })).collect::<Vec<_>>(),
        })
    }
}

pub const INSTALL_EXTENSION: &str = "at chrome://extensions turn on Developer mode, choose Load unpacked, and \
     select the chrome-extension folder (from a checkout, or munim-computer-use-chrome-extension.zip from the \
     release, extracted)";

/// Whether a profile has the extension, and if so whether it is enabled.
/// Unpacked extensions are recorded in Preferences, store installs in
/// Secure Preferences, both under extensions.settings.<id>.
fn installed_in(profile: &Path, extension_id: &str) -> Option<bool> {
    ["Preferences", "Secure Preferences"].iter().find_map(|file| {
        let text = std::fs::read_to_string(profile.join(file)).ok()?;
        // Most profiles do not mention the id at all; skip parsing those.
        if !text.contains(extension_id) {
            return None;
        }
        let settings = serde_json::from_str::<Value>(&text).ok()?;
        settings_enabled(settings.get("extensions")?.get("settings")?.get(extension_id)?)
    })
}

/// Enabled unless Chrome recorded a reason it is off. `state` 0 is how older
/// Chrome said disabled; newer Chrome keeps only `disable_reasons`.
fn settings_enabled(entry: &Value) -> Option<bool> {
    if !entry.is_object() {
        return None;
    }
    let reasons = match entry.get("disable_reasons") {
        None | Some(Value::Null) => false,
        Some(Value::Number(number)) => number.as_u64() != Some(0),
        Some(Value::Array(list)) => !list.is_empty(),
        Some(_) => true,
    };
    let off = entry.get("state").and_then(Value::as_u64) == Some(0);
    Some(!reasons && !off)
}

fn user_data_dirs() -> Vec<(&'static str, PathBuf)> {
    #[cfg(windows)]
    {
        let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else { return Vec::new() };
        [
            ("Google Chrome", r"Google\Chrome\User Data"),
            ("Google Chrome Beta", r"Google\Chrome Beta\User Data"),
            ("Google Chrome Canary", r"Google\Chrome SxS\User Data"),
            ("Chromium", r"Chromium\User Data"),
            ("Microsoft Edge", r"Microsoft\Edge\User Data"),
            ("Brave", r"BraveSoftware\Brave-Browser\User Data"),
        ]
        .into_iter()
        .map(|(browser, dir)| (browser, local.join(dir)))
        .collect()
    }
    #[cfg(not(windows))]
    {
        let Some(config) = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        else {
            return Vec::new();
        };
        [
            ("Google Chrome", "google-chrome"),
            ("Google Chrome Beta", "google-chrome-beta"),
            ("Google Chrome Dev", "google-chrome-unstable"),
            ("Chromium", "chromium"),
            ("Microsoft Edge", "microsoft-edge"),
            ("Brave", "BraveSoftware/Brave-Browser"),
        ]
        .into_iter()
        .map(|(browser, dir)| (browser, config.join(dir)))
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_owner_record_round_trips_and_reads_at_a_glance() {
        let record = OwnerRecord {
            pid: 4242,
            version: "0.7.3".into(),
            exe: r"C:\tools\munim-computer-use.exe".into(),
            started_unix: unix_now() - 3 * 3600,
            extension_connected: false,
            host_connections: 0,
            peer_endpoint: true,
        };
        assert_eq!(OwnerRecord::from_json(&record.to_json()), Some(record.clone()));
        assert_eq!(
            record.describe(),
            r"pid 4242 (munim-computer-use 0.7.3, C:\tools\munim-computer-use.exe, started 3h ago)"
        );
        assert!(record.extension_state().contains("no connection from the extension since it started"));
    }

    #[test]
    fn join_failures_name_the_likely_cause() {
        let denied = join_failure(&std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert!(denied.contains("different security contexts"), "{denied}");
        let missing = join_failure(&std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(missing.contains("no peer endpoint"), "{missing}");
    }

    #[test]
    fn chromes_extension_settings_say_enabled_or_not() {
        assert_eq!(settings_enabled(&json!({ "state": 1, "location": 4 })), Some(true));
        assert_eq!(settings_enabled(&json!({ "disable_reasons": [] })), Some(true));
        assert_eq!(settings_enabled(&json!({ "disable_reasons": [1] })), Some(false));
        assert_eq!(settings_enabled(&json!({ "disable_reasons": 1 })), Some(false));
        assert_eq!(settings_enabled(&json!({ "state": 0 })), Some(false));
        assert_eq!(settings_enabled(&json!(null)), None);
    }

    #[test]
    fn a_profile_without_the_extension_is_reported_with_the_install_step() {
        let dir = std::env::temp_dir().join(format!("mcu-presence-{}", std::process::id()));
        let profile = dir.join("Default");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("Preferences"), r#"{"extensions":{"settings":{"other":{}}}}"#).unwrap();
        assert_eq!(installed_in(&profile, "kgdolgnijopbghhomnblabjkmjhnoage"), None);
        std::fs::write(
            profile.join("Secure Preferences"),
            r#"{"extensions":{"settings":{"kgdolgnijopbghhomnblabjkmjhnoage":{"disable_reasons":[]}}}}"#,
        )
        .unwrap();
        assert_eq!(installed_in(&profile, "kgdolgnijopbghhomnblabjkmjhnoage"), Some(true));
        std::fs::remove_dir_all(&dir).unwrap();

        let missing = Presence { profiles: vec!["Google Chrome/Default".into()], found: vec![] };
        let (said, next) = missing.problem("abc").unwrap();
        assert!(said.contains("not installed in any browser profile") && said.contains("Google Chrome/Default"));
        assert!(next.contains("Load unpacked"), "{next}");
        assert_eq!(Presence::default().problem("abc"), None, "no browser found: nothing to say");
        let disabled = Presence {
            profiles: vec!["Brave/Default".into()],
            found: vec![Installed { profile: "Brave/Default".into(), enabled: false }],
        };
        assert!(disabled.problem("abc").unwrap().0.contains("disabled in Brave/Default"));
    }

    #[test]
    fn only_server_images_count_and_browsers_are_recognised() {
        assert!(is_server_image("munim-computer-use.exe") && is_server_image("MUNIM-COMPUTER-USE.EXE"));
        assert!(!is_server_image("munim-computer-use-helper.exe"));
        assert!(is_browser_image("chrome.exe") && is_browser_image("msedge.exe") && !is_browser_image("node.exe"));
    }
}
