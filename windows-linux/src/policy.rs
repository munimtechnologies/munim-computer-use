//! The user's Computer Use policy: which apps and sites the agent may use.
//!
//! A JSON file — `COMPUTER_USE_POLICY` if set, else `policy.json` in the
//! support directory — shaped like
//!
//! ```json
//! { "apps":  { "Keychain Access": "block", "Messages": "ask" },
//!   "sites": { "bank.example": "block", "mail.google.com": "ask", "*": "allow" } }
//! ```
//!
//! Each rule is `allow`, `ask` (the user approves once per server process) or
//! `block`. Apps match their name or id exactly, ignoring case; sites match a
//! host and its subdomains, and the most specific pattern wins. `*` sets the
//! default, which is otherwise `allow`. The file is re-read whenever it
//! changes, so an edit applies to servers that are already running.
//!
//! Site rules are enforced by the Chrome extension, which knows what page a tab
//! is on at the moment of the action; this side only forwards them. A file that
//! does not parse blocks everything it could have covered rather than being
//! ignored: a typo must not quietly turn a block into an allow.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use serde_json::{Value, json};

use crate::platform::{DesktopError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Allow,
    Ask,
    Block,
}

impl Rule {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "allow" => Some(Self::Allow),
            "ask" => Some(Self::Ask),
            "block" => Some(Self::Block),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Block => "block",
        }
    }
}

#[derive(Debug, Default)]
pub struct Policy {
    apps: Vec<(String, Rule)>,
    sites: Vec<(String, Rule)>,
    /// Why the file could not be used, when it exists but is not valid.
    error: Option<String>,
}

impl Policy {
    pub fn parse(text: &str) -> std::result::Result<Self, String> {
        let root: Value = serde_json::from_str(text).map_err(|error| format!("not valid JSON: {error}"))?;
        let Some(root) = root.as_object() else {
            return Err("the top level must be an object with \"apps\" and/or \"sites\"".into());
        };
        let section = |key: &str| -> std::result::Result<Vec<(String, Rule)>, String> {
            match root.get(key) {
                None | Some(Value::Null) => Ok(Vec::new()),
                Some(Value::Object(map)) => map
                    .iter()
                    .map(|(pattern, rule)| {
                        rule.as_str()
                            .and_then(Rule::parse)
                            .map(|rule| (pattern.trim().to_lowercase(), rule))
                            .ok_or_else(|| format!("\"{key}\".\"{pattern}\" must be \"allow\", \"ask\" or \"block\""))
                    })
                    .collect(),
                Some(_) => Err(format!("\"{key}\" must be an object of pattern → rule")),
            }
        };
        Ok(Self { apps: section("apps")?, sites: section("sites")?, error: None })
    }

    /// The rule for an app, matched on its name or id.
    pub fn app_rule(&self, name: &str, id: &str) -> Rule {
        if self.error.is_some() {
            return Rule::Block;
        }
        let (name, id) = (name.trim().to_lowercase(), id.trim().to_lowercase());
        self.apps
            .iter()
            .find(|(pattern, _)| pattern != "*" && (*pattern == name || *pattern == id))
            .or_else(|| self.apps.iter().find(|(pattern, _)| pattern == "*"))
            .map_or(Rule::Allow, |(_, rule)| *rule)
    }

    /// Whether anything about apps needs checking: rules, or a broken file.
    pub fn has_app_rules(&self) -> bool {
        !self.apps.is_empty() || self.error.is_some()
    }

    pub fn has_site_rules(&self) -> bool {
        !self.sites.is_empty()
    }

    pub fn sites_ask(&self) -> bool {
        self.sites.iter().any(|(_, rule)| *rule == Rule::Ask)
    }

    /// The site rules in the shape the extension takes.
    pub fn sites_json(&self) -> Value {
        Value::Array(
            self.sites
                .iter()
                .map(|(pattern, rule)| json!({ "pattern": pattern, "rule": rule.as_str() }))
                .collect(),
        )
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
}

fn policy_path() -> Option<PathBuf> {
    if let Some(path) = crate::identity::env_var("POLICY").filter(|path| !path.trim().is_empty()) {
        return Some(PathBuf::from(path));
    }
    crate::identity::get().support_dir().map(|dir| dir.join("policy.json"))
}

struct Cached {
    path: Option<PathBuf>,
    stamp: Option<(SystemTime, u64)>,
    policy: Arc<Policy>,
}

/// The current policy, re-read only when the file's path, size or mtime moved.
pub fn current() -> Arc<Policy> {
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    let path = policy_path();
    let stamp = path
        .as_ref()
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|meta| (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()));
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(cached) = cache.as_ref()
        && cached.path == path
        && cached.stamp == stamp
    {
        return Arc::clone(&cached.policy);
    }
    let policy = match (&path, stamp) {
        (Some(path), Some(_)) => match std::fs::read_to_string(path) {
            Ok(text) => Policy::parse(&text).unwrap_or_else(|reason| Policy {
                error: Some(format!("the Computer Use policy file {} is invalid: {reason}", path.display())),
                ..Policy::default()
            }),
            Err(error) => Policy {
                error: Some(format!("the Computer Use policy file {} cannot be read: {error}", path.display())),
                ..Policy::default()
            },
        },
        _ => Policy::default(),
    };
    let policy = Arc::new(policy);
    *cache = Some(Cached { path, stamp, policy: Arc::clone(&policy) });
    policy
}

fn approved() -> &'static Mutex<HashSet<String>> {
    static APPROVED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    APPROVED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Refuse an app the policy blocks, and ask the user about one it marks `ask`.
pub fn check_app(name: &str, id: &str) -> Result<()> {
    let policy = current();
    if let Some(error) = policy.error() {
        return Err(DesktopError::new(format!("{error} — fix it before using apps")));
    }
    match policy.app_rule(name, id) {
        Rule::Allow => Ok(()),
        Rule::Block => Err(DesktopError::new(format!(
            "{name} is blocked by the user's Computer Use policy — do not try to reach it another way"
        ))),
        Rule::Ask => {
            let key = id.trim().to_lowercase();
            if approved().lock().unwrap_or_else(|poison| poison.into_inner()).contains(&key) {
                return Ok(());
            }
            match confirm(
                "Computer Use",
                &format!("Let the agent use {name}?\n\nYour Computer Use policy asks before the agent reads or controls this app. Allowing it lasts until this agent session ends."),
            ) {
                Some(true) => {
                    approved().lock().unwrap_or_else(|poison| poison.into_inner()).insert(key);
                    Ok(())
                }
                Some(false) => Err(DesktopError::new(format!("the user declined to let the agent use {name}"))),
                None => Err(DesktopError::new(format!(
                    "{name} needs the user's approval under their Computer Use policy, and no approval prompt could be shown here — ask the user to change the rule to allow"
                ))),
            }
        }
    }
}

/// Seconds an approval prompt waits before counting as a refusal.
#[cfg(any(windows, target_os = "linux"))]
const PROMPT_TIMEOUT_SECS: u64 = 120;

/// Ask the user yes or no. `None` when no prompt can be shown on this system.
#[cfg(windows)]
fn confirm(title: &str, message: &str) -> Option<bool> {
    use windows::Win32::UI::WindowsAndMessaging::{
        IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_SYSTEMMODAL, MB_TOPMOST, MB_YESNO, MessageBoxW,
    };
    use windows::core::{HSTRING, PCWSTR};
    let (title, message) = (HSTRING::from(title), HSTRING::from(message));
    let (sender, receiver) = std::sync::mpsc::channel();
    // A message box blocks its thread until answered; waiting on a channel lets
    // an unanswered prompt count as "no" instead of stalling the server.
    std::thread::spawn(move || {
        let answer = unsafe {
            MessageBoxW(
                None,
                PCWSTR(message.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND | MB_SYSTEMMODAL,
            )
        };
        let _ = sender.send(answer == IDYES);
    });
    Some(receiver.recv_timeout(std::time::Duration::from_secs(PROMPT_TIMEOUT_SECS)).unwrap_or(false))
}

#[cfg(target_os = "linux")]
fn confirm(title: &str, message: &str) -> Option<bool> {
    use std::process::Command;
    let timeout = PROMPT_TIMEOUT_SECS.to_string();
    let zenity = Command::new("zenity")
        .args(["--question", "--title", title, "--text", message, "--timeout", &timeout, "--no-wrap"])
        .status();
    if let Ok(status) = zenity {
        return Some(status.success());
    }
    let kdialog = Command::new("kdialog").args(["--title", title, "--yesno", message]).status();
    kdialog.ok().map(|status| status.success())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn confirm(_title: &str, _message: &str) -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::{Policy, Rule};

    #[test]
    fn apps_match_name_or_id_ignoring_case_and_fall_back_to_star() {
        let policy = Policy::parse(r#"{"apps": {"Keychain Access": "block", "com.apple.MobileSMS": "ask", "*": "allow"}}"#).unwrap();
        assert_eq!(policy.app_rule("keychain access", "com.apple.keychainaccess"), Rule::Block);
        assert_eq!(policy.app_rule("Messages", "com.apple.mobilesms"), Rule::Ask);
        assert_eq!(policy.app_rule("Notes", "com.apple.notes"), Rule::Allow);
    }

    #[test]
    fn star_can_make_block_the_default() {
        let policy = Policy::parse(r#"{"apps": {"*": "block", "Notes": "allow"}}"#).unwrap();
        assert_eq!(policy.app_rule("Notes", "notes"), Rule::Allow);
        assert_eq!(policy.app_rule("Terminal", "terminal"), Rule::Block);
    }

    #[test]
    fn no_rules_means_allow() {
        let policy = Policy::parse("{}").unwrap();
        assert_eq!(policy.app_rule("Anything", "anything"), Rule::Allow);
        assert!(!policy.has_site_rules());
    }

    #[test]
    fn an_unknown_rule_is_rejected_rather_than_ignored() {
        let error = Policy::parse(r#"{"apps": {"Terminal": "deny"}}"#).unwrap_err();
        assert!(error.contains("\"allow\", \"ask\" or \"block\""), "{error}");
        assert!(Policy::parse("[]").is_err());
        assert!(Policy::parse("{not json").is_err());
    }

    #[test]
    fn an_invalid_file_blocks_instead_of_allowing() {
        let policy = Policy { error: Some("bad".into()), ..Policy::default() };
        assert_eq!(policy.app_rule("Notes", "notes"), Rule::Block);
    }

    #[test]
    fn site_rules_are_forwarded_lowercased() {
        let policy = Policy::parse(r#"{"sites": {"Bank.Example": "block", "mail.google.com": "ask"}}"#).unwrap();
        assert!(policy.has_site_rules());
        assert!(policy.sites_ask());
        let rules = policy.sites_json();
        assert!(rules.as_array().unwrap().iter().any(|rule| rule["pattern"] == "bank.example" && rule["rule"] == "block"));
    }
}
