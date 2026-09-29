//! `munim-computer-use install-native-host`: register this binary as Chrome's
//! native-messaging host for the current identity.
//!
//! Chrome starts the host itself and passes no arguments of ours, so the host
//! manifest points at a small wrapper that re-execs this binary in
//! `native-host` mode — with `--profile` when the identity is customised, so
//! the relay Chrome starts connects to the same bridge the MCP server binds.
//! An embedding app calls this with its profile instead of shipping installer
//! scripts; `chrome-extension/install.sh` / `install.ps1` call it for checkouts.
//!
//! The identity's first host name is its own and is always written. Later names
//! are compatibility aliases, possibly shared with another app (the standalone
//! default lists MT Code's host for old extensions): one is written only when no
//! manifest exists yet or it already points at this wrapper, so a standalone
//! install never hijacks an embedding app's bridge.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::identity::Identity;

pub fn run(args: &[String]) -> i32 {
    let mut binary: Option<PathBuf> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--binary" => binary = iter.next().map(PathBuf::from),
            other => {
                eprintln!("munim-computer-use: install-native-host: unknown option {other}");
                return 2;
            }
        }
    }
    let binary = match binary.map(Ok).unwrap_or_else(std::env::current_exe) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("munim-computer-use: cannot locate this binary: {error}");
            return 1;
        }
    };
    match install(crate::identity::get(), &binary) {
        Ok(report) => {
            let registered = report["registered"].as_array().map_or(0, Vec::len);
            println!("{report}");
            if registered == 0 {
                eprintln!("munim-computer-use: no Chrome or Chromium profile found to register with");
                1
            } else {
                0
            }
        }
        Err(error) => {
            eprintln!("munim-computer-use: install-native-host failed: {error}");
            1
        }
    }
}

fn install(identity: &Identity, binary: &Path) -> Result<Value, String> {
    let support = identity
        .support_dir()
        .ok_or("no support directory (HOME / LOCALAPPDATA unset)")?;
    std::fs::create_dir_all(&support)
        .map_err(|error| format!("cannot create {}: {error}", support.display()))?;

    let profile = if identity.is_customized() {
        let path = support.join("profile.json");
        write_if_changed(&path, &format!("{:#}\n", identity.profile_json()))?;
        Some(path)
    } else {
        None
    };
    let wrapper = write_wrapper(&support, binary, profile.as_deref())?;

    let origins: Vec<String> = identity
        .extension_ids
        .iter()
        .map(|id| format!("chrome-extension://{id}/"))
        .collect();
    let manifest_for = |name: &str| {
        format!(
            "{:#}\n",
            json!({
                "name": name,
                "description": identity.native_host_description,
                "path": wrapper.to_string_lossy(),
                "type": "stdio",
                "allowed_origins": origins,
            })
        )
    };

    let mut skipped: Vec<String> = Vec::new();
    let registered = register(identity, &support, &wrapper, &manifest_for, &mut skipped)?;
    Ok(json!({
        "wrapper": wrapper.to_string_lossy(),
        "profile": profile.map(|p| p.to_string_lossy().into_owned()),
        "hostNames": identity.native_host_names,
        "registered": registered,
        "skipped": skipped,
    }))
}

/// Whether an existing host manifest belongs to another installed app: it
/// points somewhere other than `wrapper`, and that program still exists. A
/// missing or unreadable manifest, or one left by an uninstalled app, is free
/// to take.
fn claimed_by_another_host(existing: Option<&str>, wrapper: &Path) -> bool {
    let Some(path) = existing
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|manifest| manifest.get("path").and_then(Value::as_str).map(PathBuf::from))
        .filter(|path| !path.as_os_str().is_empty())
    else {
        return false;
    };
    path != wrapper && path.exists()
}

fn note_skipped(skipped: &mut Vec<String>, name: &str) {
    if !skipped.iter().any(|seen| seen == name) {
        skipped.push(name.to_string());
    }
}

/// Rewriting an identical file would bump its mtime for nothing, and an app
/// that registers on every launch should leave no trace when nothing changed.
fn write_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return Ok(());
    }
    std::fs::write(path, contents).map_err(|error| format!("cannot write {}: {error}", path.display()))
}

#[cfg(unix)]
fn write_wrapper(support: &Path, binary: &Path, profile: Option<&Path>) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let quote = |text: &str| format!("'{}'", text.replace('\'', r"'\''"));
    let mut command = format!("exec {}", quote(&binary.to_string_lossy()));
    if let Some(profile) = profile {
        command.push_str(&format!(" --profile {}", quote(&profile.to_string_lossy())));
    }
    command.push_str(" native-host");
    let wrapper = support.join("native-host");
    write_if_changed(&wrapper, &format!("#!/bin/sh\n{command}\n"))?;
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("cannot chmod {}: {error}", wrapper.display()))?;
    Ok(wrapper)
}

#[cfg(windows)]
fn write_wrapper(support: &Path, binary: &Path, profile: Option<&Path>) -> Result<PathBuf, String> {
    let mut command = format!("\"{}\"", binary.to_string_lossy());
    if let Some(profile) = profile {
        command.push_str(&format!(" --profile \"{}\"", profile.to_string_lossy()));
    }
    command.push_str(" native-host");
    let wrapper = support.join("native-host.cmd");
    write_if_changed(&wrapper, &format!("@echo off\r\n{command}\r\n"))?;
    Ok(wrapper)
}

/// Linux: one manifest per host name in every Chrome / Chromium config dir
/// that exists. (macOS is the Swift server's job.)
#[cfg(not(windows))]
fn register(
    identity: &Identity,
    _support: &Path,
    wrapper: &Path,
    manifest_for: &dyn Fn(&str) -> String,
    skipped: &mut Vec<String>,
) -> Result<Vec<String>, String> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or("HOME is not set")?;
    let mut registered = Vec::new();
    for browser in ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium"] {
        let root = config.join(browser);
        if !root.is_dir() {
            continue;
        }
        let dir = root.join("NativeMessagingHosts");
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
        for (index, name) in identity.native_host_names.iter().enumerate() {
            let target = dir.join(format!("{name}.json"));
            let existing = std::fs::read_to_string(&target).ok();
            if index > 0 && claimed_by_another_host(existing.as_deref(), wrapper) {
                note_skipped(skipped, name);
                continue;
            }
            write_if_changed(&target, &manifest_for(name))?;
        }
        registered.push(root.to_string_lossy().into_owned());
    }
    Ok(registered)
}

/// Windows: Chrome finds hosts through the registry, which points at a
/// manifest file; the manifests live in the support dir.
#[cfg(windows)]
fn register(
    identity: &Identity,
    support: &Path,
    wrapper: &Path,
    manifest_for: &dyn Fn(&str) -> String,
    skipped: &mut Vec<String>,
) -> Result<Vec<String>, String> {
    let mut manifests = Vec::new();
    for name in &identity.native_host_names {
        let path = support.join(format!("{name}.json"));
        write_if_changed(&path, &manifest_for(name))?;
        manifests.push((name, path));
    }
    let mut registered = Vec::new();
    for vendor in [r"Google\Chrome", r"Google\Chrome Beta", "Chromium"] {
        let mut ok = true;
        for (index, (name, path)) in manifests.iter().enumerate() {
            let key = format!(r"HKCU\Software\{vendor}\NativeMessagingHosts\{name}");
            if index > 0 {
                // The registry names the manifest file; another app's lives elsewhere.
                let existing = registered_manifest(&key)
                    .filter(|current| current.as_path() != path.as_path())
                    .and_then(|current| std::fs::read_to_string(current).ok());
                if claimed_by_another_host(existing.as_deref(), wrapper) {
                    note_skipped(skipped, name);
                    continue;
                }
            }
            let status = std::process::Command::new("reg")
                .args(["add", &key, "/ve", "/t", "REG_SZ", "/d"])
                .arg(path)
                .arg("/f")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            ok &= status.is_ok_and(|status| status.success());
        }
        if ok {
            registered.push(format!(r"HKCU\Software\{vendor}"));
        }
    }
    Ok(registered)
}

/// The manifest path a host key's default value points at, if any.
#[cfg(windows)]
fn registered_manifest(key: &str) -> Option<PathBuf> {
    let output = std::process::Command::new("reg")
        .args(["query", key, "/ve"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find_map(|line| line.split_once("REG_SZ").map(|(_, value)| value.trim().to_string()))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_compat_host_owned_by_another_app_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("cu-install-claim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ours = dir.join("ours");
        let theirs = dir.join("theirs");
        std::fs::write(&theirs, "#!/bin/sh\n").unwrap();
        let manifest = |path: &Path| json!({ "name": "x", "path": path.to_string_lossy() }).to_string();
        // Another app's live wrapper: hands off.
        assert!(claimed_by_another_host(Some(&manifest(&theirs)), &ours));
        // Already ours, never registered, unreadable, or left by an uninstalled app: take it.
        assert!(!claimed_by_another_host(Some(&manifest(&ours)), &ours));
        assert!(!claimed_by_another_host(None, &ours));
        assert!(!claimed_by_another_host(Some("not json"), &ours));
        assert!(!claimed_by_another_host(Some(&manifest(&dir.join("gone"))), &ours));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrapper_replays_a_custom_profile_and_quotes_paths() {
        let dir = std::env::temp_dir().join(format!("cu-install-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wrapper = write_wrapper(
            &dir,
            Path::new("/Applications/It's An App.app/bin/munim-computer-use"),
            Some(&dir.join("profile.json")),
        )
        .unwrap();
        let text = std::fs::read_to_string(&wrapper).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert!(text.starts_with("#!/bin/sh\nexec '/Applications/It'\\''s An App.app/bin/munim-computer-use' --profile '"));
        assert!(text.trim_end().ends_with("profile.json' native-host"));
    }

    #[test]
    fn default_wrapper_has_no_profile() {
        let dir = std::env::temp_dir().join(format!("cu-install-default-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wrapper = write_wrapper(&dir, Path::new("/usr/bin/munim-computer-use"), None).unwrap();
        let text = std::fs::read_to_string(&wrapper).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(text, "#!/bin/sh\nexec '/usr/bin/munim-computer-use' native-host\n");
    }
}
