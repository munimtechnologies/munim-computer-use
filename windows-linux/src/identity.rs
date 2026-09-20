//! Who this server presents itself as on the machine: where its bridge socket
//! and support files live, what its agent-cursor overlay is called, which
//! native-messaging hosts it registers, and which prefix its tunables use.
//!
//! The defaults are the standalone server's. An app that ships the binary
//! inside its own bundle ("embedding") can run it under its own identity so
//! it never collides with a standalone install on the same machine:
//!
//! - `--profile <file|json>` (any position) or `COMPUTER_USE_PROFILE`: a JSON
//!   object with any of the keys below, either inline or as a file path.
//! - `COMPUTER_USE_SUPPORT_DIR`, `COMPUTER_USE_BRIDGE_SOCKET`,
//!   `COMPUTER_USE_ENV_PREFIX`, `COMPUTER_USE_AGENT_CURSOR_NAME`,
//!   `COMPUTER_USE_AGENT_CURSOR_BUNDLE_ID`, `COMPUTER_USE_HISTORY_DIR`:
//!   per-field overrides, which win over the profile.
//!
//! Profile keys: `name`, `supportDir`, `bridgeSocket`, `envPrefix`,
//! `agentCursorName`, `agentCursorBundleId`, `historyDir`, `nativeHostNames`,
//! `extensionIds`, `nativeHostDescription`. `name` alone moves every default
//! path (support dir, bridge socket, Windows pipe) under that name.
//!
//! The Swift server (`macos/Sources/Identity.swift`) reads the same keys.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::{Map, Value, json};

/// Directory and pipe-name stem when no `name` is configured.
pub const DEFAULT_NAME: &str = "munim-computer-use";
pub const DEFAULT_AGENT_CURSOR_NAME: &str = "MunimAgentCursor";
pub const DEFAULT_AGENT_CURSOR_BUNDLE_ID: &str = "com.munimtech.computer-use.agent-cursor";
pub const DEFAULT_NATIVE_HOST_NAMES: [&str; 2] =
    ["com.munim.mtcode.desktop", "com.munimtech.computer-use.desktop"];
/// Pinned by the `key` in chrome-extension/manifest.json.
pub const DEFAULT_EXTENSION_IDS: [&str; 1] = ["kgdolgnijopbghhomnblabjkmjhnoage"];
pub const DEFAULT_NATIVE_HOST_DESCRIPTION: &str = "Munim Computer Use browser bridge";

const KNOWN_KEYS: [&str; 10] = [
    "name",
    "supportDir",
    "bridgeSocket",
    "envPrefix",
    "agentCursorName",
    "agentCursorBundleId",
    "historyDir",
    "nativeHostNames",
    "extensionIds",
    "nativeHostDescription",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    /// Stem for default paths; `None` keeps the standalone layout.
    pub name: Option<String>,
    support_dir: Option<PathBuf>,
    bridge_socket: Option<String>,
    /// Extra prefix read before `COMPUTER_USE_` for every tunable.
    pub env_prefix: Option<String>,
    pub agent_cursor_name: String,
    pub agent_cursor_bundle_id: String,
    pub history_dir: Option<PathBuf>,
    pub native_host_names: Vec<String>,
    pub extension_ids: Vec<String>,
    pub native_host_description: String,
    /// The profile fields that were actually set, so a native-host wrapper can
    /// hand exactly this identity to the relay Chrome starts.
    overrides: Map<String, Value>,
}

impl Default for Identity {
    fn default() -> Self {
        Self {
            name: None,
            support_dir: None,
            bridge_socket: None,
            env_prefix: None,
            agent_cursor_name: DEFAULT_AGENT_CURSOR_NAME.into(),
            agent_cursor_bundle_id: DEFAULT_AGENT_CURSOR_BUNDLE_ID.into(),
            history_dir: None,
            native_host_names: DEFAULT_NATIVE_HOST_NAMES.iter().map(|s| s.to_string()).collect(),
            extension_ids: DEFAULT_EXTENSION_IDS.iter().map(|s| s.to_string()).collect(),
            native_host_description: DEFAULT_NATIVE_HOST_DESCRIPTION.into(),
            overrides: Map::new(),
        }
    }
}

static IDENTITY: OnceLock<Identity> = OnceLock::new();

/// The process identity. Falls back to the environment alone if `init` was
/// never called (unit tests, library use).
pub fn get() -> &'static Identity {
    IDENTITY.get_or_init(|| {
        Identity::resolve(None, &|name| std::env::var(name).ok()).unwrap_or_else(|error| {
            eprintln!("munim-computer-use: {error}; using the default identity");
            Identity::default()
        })
    })
}

/// Pull `--profile <value>` out of the arguments, resolve the identity, and
/// return the remaining arguments (program name first). Exits on a bad profile:
/// running under the wrong identity would talk to another app's browser bridge.
pub fn init_from_args(args: Vec<String>) -> Vec<String> {
    let mut rest = Vec::with_capacity(args.len());
    let mut profile = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--profile" {
            match iter.next() {
                Some(value) => profile = Some(value),
                None => {
                    eprintln!("munim-computer-use: --profile needs a file path or a JSON object");
                    std::process::exit(2);
                }
            }
        } else if let Some(value) = arg.strip_prefix("--profile=") {
            profile = Some(value.to_string());
        } else {
            rest.push(arg);
        }
    }
    match Identity::resolve(profile.as_deref(), &|name| std::env::var(name).ok()) {
        Ok(identity) => {
            let _ = IDENTITY.set(identity);
        }
        Err(error) => {
            eprintln!("munim-computer-use: {error}");
            std::process::exit(2);
        }
    }
    rest
}

/// Read a tunable such as `AGENT_CURSOR`: `<envPrefix>AGENT_CURSOR` first, then
/// `COMPUTER_USE_AGENT_CURSOR`.
pub fn env_var(suffix: &str) -> Option<String> {
    lookup_tunable(get(), suffix, &|name| std::env::var(name).ok())
}

/// Remote-desktop mode: this process drives the machine for a person watching
/// its screen from another one, so input takes over the real pointer and
/// keyboard instead of being routed to a window in the background. Off unless
/// `COMPUTER_USE_REMOTE_CONTROL=1` (or the embedder's prefixed equivalent).
///
/// A host that runs an agent as well keeps it in a separate process, which
/// stays in background mode.
pub fn remote_control() -> bool {
    match env_var("REMOTE_CONTROL") {
        Some(value) => {
            let value = value.trim();
            value == "1"
                || value.eq_ignore_ascii_case("true")
                || value.eq_ignore_ascii_case("on")
                || value.eq_ignore_ascii_case("yes")
        }
        None => false,
    }
}

fn lookup_tunable(
    identity: &Identity,
    suffix: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    if let Some(prefix) = identity.env_prefix.as_deref().filter(|p| !p.is_empty()) {
        if let Some(value) = env(&format!("{prefix}{suffix}")) {
            return Some(value);
        }
    }
    env(&format!("COMPUTER_USE_{suffix}"))
}

impl Identity {
    pub fn resolve(
        profile_arg: Option<&str>,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let mut fields = Map::new();
        let profile = profile_arg
            .map(str::to_string)
            .or_else(|| env("COMPUTER_USE_PROFILE"))
            .filter(|value| !value.trim().is_empty());
        if let Some(profile) = profile {
            fields = load_profile(&profile)?;
        }
        for (key, var) in [
            ("supportDir", "COMPUTER_USE_SUPPORT_DIR"),
            ("bridgeSocket", "COMPUTER_USE_BRIDGE_SOCKET"),
            ("envPrefix", "COMPUTER_USE_ENV_PREFIX"),
            ("agentCursorName", "COMPUTER_USE_AGENT_CURSOR_NAME"),
            ("agentCursorBundleId", "COMPUTER_USE_AGENT_CURSOR_BUNDLE_ID"),
            ("historyDir", "COMPUTER_USE_HISTORY_DIR"),
        ] {
            if let Some(value) = env(var).filter(|v| !v.is_empty()) {
                fields.insert(key.into(), Value::String(value));
            }
        }
        Self::from_fields(fields)
    }

    fn from_fields(fields: Map<String, Value>) -> Result<Self, String> {
        let mut identity = Self::default();
        for (key, value) in &fields {
            if !KNOWN_KEYS.contains(&key.as_str()) {
                // Forward compatibility: a newer embedder may pass keys this
                // build does not know. Say so, but keep going.
                eprintln!("munim-computer-use: ignoring unknown profile key {key:?}");
                continue;
            }
            match key.as_str() {
                "nativeHostNames" | "extensionIds" => {
                    let list = string_list(key, value)?;
                    if key == "nativeHostNames" {
                        for name in &list {
                            if !valid_host_name(name) {
                                return Err(format!("invalid native-messaging host name {name:?}"));
                            }
                        }
                        identity.native_host_names = list;
                    } else {
                        identity.extension_ids = list;
                    }
                }
                _ => {
                    let Some(text) = value.as_str() else {
                        return Err(format!("profile key {key:?} must be a string"));
                    };
                    if text.is_empty() {
                        return Err(format!("profile key {key:?} must not be empty"));
                    }
                    match key.as_str() {
                        "name" => {
                            if !valid_name(text) {
                                return Err(format!(
                                    "profile name {text:?} may only use letters, digits, '.', '_' and '-'"
                                ));
                            }
                            identity.name = Some(text.into());
                        }
                        "supportDir" => identity.support_dir = Some(PathBuf::from(text)),
                        "bridgeSocket" => identity.bridge_socket = Some(text.into()),
                        "envPrefix" => identity.env_prefix = Some(text.into()),
                        "agentCursorName" => identity.agent_cursor_name = text.into(),
                        "agentCursorBundleId" => identity.agent_cursor_bundle_id = text.into(),
                        "historyDir" => identity.history_dir = Some(PathBuf::from(text)),
                        "nativeHostDescription" => identity.native_host_description = text.into(),
                        _ => unreachable!(),
                    }
                }
            }
        }
        identity.overrides = fields
            .into_iter()
            .filter(|(key, _)| KNOWN_KEYS.contains(&key.as_str()))
            .collect();
        Ok(identity)
    }

    /// True when anything differs from the standalone defaults.
    pub fn is_customized(&self) -> bool {
        !self.overrides.is_empty()
    }

    /// The set fields as a profile object, for a native-host wrapper to replay.
    pub fn profile_json(&self) -> Value {
        Value::Object(self.overrides.clone())
    }

    fn stem(&self) -> &str {
        self.name.as_deref().unwrap_or(DEFAULT_NAME)
    }

    /// Where the native-host wrapper and manifests (Windows) are written.
    pub fn support_dir(&self) -> Option<PathBuf> {
        if let Some(dir) = &self.support_dir {
            return Some(dir.clone());
        }
        #[cfg(windows)]
        {
            std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join(self.stem()))
        }
        #[cfg(not(windows))]
        {
            let data = std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
            data.map(|data| data.join(self.stem()))
        }
    }

    /// Directory that holds `bridge.sock`, unless `bridgeSocket` names the
    /// socket outright. `XDG_RUNTIME_DIR` first: it is per-user and tmpfs.
    #[cfg(unix)]
    pub fn bridge_socket_path(&self) -> (PathBuf, String) {
        if let Some(explicit) = &self.bridge_socket {
            let path = PathBuf::from(explicit);
            let file = path
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_else(|| "bridge.sock".into());
            let dir = path.parent().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
            return (dir, file);
        }
        let stem = self.stem();
        let dir = if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
            PathBuf::from(runtime).join(stem)
        } else if let Some(home) = std::env::var_os("HOME") {
            PathBuf::from(home).join(".local/share").join(stem)
        } else {
            // Prefer a UID-owned private dir over a USER-named /tmp path another
            // local account can pre-create.
            let uid = unsafe { libc::getuid() };
            std::env::temp_dir().join(format!("{stem}-{uid}"))
        };
        (dir, "bridge.sock".into())
    }

    /// User-scoped named pipe. The pipe namespace is global, hence the user.
    #[cfg(windows)]
    pub fn bridge_pipe_name(&self) -> String {
        if let Some(explicit) = &self.bridge_socket {
            return explicit.clone();
        }
        let user = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "user".into());
        format!("{}-bridge-{user}", self.stem())
    }

    /// Human-readable summary for `identity` / diagnostics.
    pub fn describe(&self) -> Value {
        #[cfg(unix)]
        let bridge = {
            let (dir, file) = self.bridge_socket_path();
            dir.join(file).to_string_lossy().into_owned()
        };
        #[cfg(windows)]
        let bridge = self.bridge_pipe_name();
        #[cfg(not(any(unix, windows)))]
        let bridge = String::new();
        json!({
            "name": self.name,
            "supportDir": self.support_dir().map(|p| p.to_string_lossy().into_owned()),
            "bridgeSocket": bridge,
            "envPrefix": self.env_prefix,
            "agentCursorName": self.agent_cursor_name,
            "agentCursorBundleId": self.agent_cursor_bundle_id,
            "historyDir": self.history_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
            "nativeHostNames": self.native_host_names,
            "extensionIds": self.extension_ids,
            "nativeHostDescription": self.native_host_description,
        })
    }
}

fn load_profile(value: &str) -> Result<Map<String, Value>, String> {
    let trimmed = value.trim();
    let text = if trimmed.starts_with('{') {
        trimmed.to_string()
    } else {
        std::fs::read_to_string(trimmed)
            .map_err(|error| format!("cannot read profile {trimmed:?}: {error}"))?
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err("profile must be a JSON object".into()),
        Err(error) => Err(format!("profile is not valid JSON: {error}")),
    }
}

fn string_list(key: &str, value: &Value) -> Result<Vec<String>, String> {
    let Some(items) = value.as_array() else {
        return Err(format!("profile key {key:?} must be an array of strings"));
    };
    let list: Option<Vec<String>> = items
        .iter()
        .map(|item| item.as_str().filter(|s| !s.is_empty()).map(str::to_string))
        .collect();
    match list {
        Some(list) if !list.is_empty() => Ok(list),
        _ => Err(format!("profile key {key:?} must be a non-empty array of strings")),
    }
}

/// Used as a directory and pipe name, so no separators or spaces.
fn valid_name(name: &str) -> bool {
    !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Chrome's rule for native-messaging host names.
pub fn valid_host_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name: &str| map.get(name).cloned()
    }

    #[test]
    fn defaults_are_the_standalone_identity() {
        let identity = Identity::resolve(None, &env_of(&[])).unwrap();
        assert_eq!(identity, Identity::default());
        assert!(!identity.is_customized());
        assert_eq!(identity.agent_cursor_bundle_id, "com.munimtech.computer-use.agent-cursor");
        assert_eq!(
            identity.native_host_names,
            vec!["com.munim.mtcode.desktop", "com.munimtech.computer-use.desktop"]
        );
        #[cfg(windows)]
        assert!(identity.bridge_pipe_name().starts_with("munim-computer-use-bridge-"));
    }

    #[test]
    fn inline_profile_sets_every_field() {
        let profile = r#"{"name":"example-desktop","envPrefix":"EXAMPLE_DESKTOP_",
            "agentCursorName":"ExampleAgentCursor","agentCursorBundleId":"com.example.agent-cursor",
            "historyDir":"/tmp/history","nativeHostNames":["com.example.desktop"],
            "extensionIds":["abcdefghijklmnopabcdefghijklmnop"],"nativeHostDescription":"Example"}"#;
        let identity = Identity::resolve(Some(profile), &env_of(&[])).unwrap();
        assert_eq!(identity.name.as_deref(), Some("example-desktop"));
        assert_eq!(identity.env_prefix.as_deref(), Some("EXAMPLE_DESKTOP_"));
        assert_eq!(identity.agent_cursor_name, "ExampleAgentCursor");
        assert_eq!(identity.agent_cursor_bundle_id, "com.example.agent-cursor");
        assert_eq!(identity.history_dir, Some(PathBuf::from("/tmp/history")));
        assert_eq!(identity.native_host_names, vec!["com.example.desktop"]);
        assert_eq!(identity.extension_ids, vec!["abcdefghijklmnopabcdefghijklmnop"]);
        assert!(identity.is_customized());
        #[cfg(unix)]
        {
            let (dir, file) = identity.bridge_socket_path();
            assert!(dir.ends_with("example-desktop"), "{dir:?}");
            assert_eq!(file, "bridge.sock");
        }
        #[cfg(windows)]
        assert!(identity.bridge_pipe_name().starts_with("example-desktop-bridge-"));
    }

    #[test]
    fn profile_from_env_and_field_overrides_win() {
        let identity = Identity::resolve(
            None,
            &env_of(&[
                ("COMPUTER_USE_PROFILE", r#"{"name":"a","agentCursorName":"FromProfile"}"#),
                ("COMPUTER_USE_AGENT_CURSOR_NAME", "FromEnv"),
                ("COMPUTER_USE_BRIDGE_SOCKET", "/run/user/1/x/custom.sock"),
            ]),
        )
        .unwrap();
        assert_eq!(identity.name.as_deref(), Some("a"));
        assert_eq!(identity.agent_cursor_name, "FromEnv");
        #[cfg(unix)]
        assert_eq!(
            identity.bridge_socket_path(),
            (PathBuf::from("/run/user/1/x"), "custom.sock".to_string())
        );
        // What a wrapper would replay includes the env overrides too.
        assert_eq!(identity.profile_json()["agentCursorName"], "FromEnv");
    }

    #[test]
    fn profile_file_is_read() {
        let path = std::env::temp_dir().join(format!("cu-profile-{}.json", std::process::id()));
        std::fs::write(&path, r#"{"name":"from-file"}"#).unwrap();
        let identity =
            Identity::resolve(Some(path.to_str().unwrap()), &env_of(&[])).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(identity.name.as_deref(), Some("from-file"));
    }

    #[test]
    fn bad_profiles_are_refused() {
        let env = env_of(&[]);
        assert!(Identity::resolve(Some("{not json"), &env).is_err());
        assert!(Identity::resolve(Some("[1]"), &env).is_err());
        assert!(Identity::resolve(Some(r#"{"name":"../escape"}"#), &env).is_err());
        assert!(Identity::resolve(Some(r#"{"name":""}"#), &env).is_err());
        assert!(Identity::resolve(Some(r#"{"nativeHostNames":["Bad Name"]}"#), &env).is_err());
        assert!(Identity::resolve(Some(r#"{"nativeHostNames":[]}"#), &env).is_err());
        assert!(Identity::resolve(Some(r#"{"agentCursorName":3}"#), &env).is_err());
        assert!(Identity::resolve(Some("/definitely/not/here.json"), &env).is_err());
        // Unknown keys are tolerated so an older binary keeps working.
        let identity = Identity::resolve(Some(r#"{"futureKey":true}"#), &env).unwrap();
        assert!(!identity.is_customized());
    }

    #[test]
    fn tunables_read_the_embedder_prefix_first() {
        let identity =
            Identity::resolve(Some(r#"{"envPrefix":"EXAMPLE_DESKTOP_"}"#), &env_of(&[])).unwrap();
        let env = env_of(&[
            ("EXAMPLE_DESKTOP_BROWSER", "0"),
            ("COMPUTER_USE_BROWSER", "1"),
            ("COMPUTER_USE_AGENT_CURSOR", "0"),
        ]);
        assert_eq!(lookup_tunable(&identity, "BROWSER", &env).as_deref(), Some("0"));
        assert_eq!(lookup_tunable(&identity, "AGENT_CURSOR", &env).as_deref(), Some("0"));
        assert_eq!(lookup_tunable(&identity, "MISSING", &env), None);
        let plain = Identity::default();
        assert_eq!(lookup_tunable(&plain, "BROWSER", &env).as_deref(), Some("1"));
    }

    #[test]
    fn host_name_rule_matches_chrome() {
        assert!(valid_host_name("com.munim.mtcode.desktop"));
        assert!(valid_host_name("a_b.c1"));
        assert!(!valid_host_name("Com.Upper"));
        assert!(!valid_host_name("a..b"));
        assert!(!valid_host_name("has-dash"));
    }
}
