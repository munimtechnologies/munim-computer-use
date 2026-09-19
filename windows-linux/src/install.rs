//! `munim-computer-use install-native-host`: register this binary as Chrome's
//! native-messaging host for the current identity.
//!
//! Chrome starts the host itself and passes no arguments of ours, so the host
//! manifest points at a small wrapper that re-execs this binary in
//! `native-host` mode — with `--profile` when the identity is customised, so
//! the relay Chrome starts connects to the same bridge the MCP server binds.
//! An embedding app calls this with its profile instead of shipping installer
//! scripts; `chrome-extension/install.sh` / `install.ps1` stay for checkouts.

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

    let registered = register(identity, &support, &manifest_for)?;
    Ok(json!({
        "wrapper": wrapper.to_string_lossy(),
        "profile": profile.map(|p| p.to_string_lossy().into_owned()),
        "hostNames": identity.native_host_names,
        "registered": registered,
    }))
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
    manifest_for: &dyn Fn(&str) -> String,
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
        for name in &identity.native_host_names {
            write_if_changed(&dir.join(format!("{name}.json")), &manifest_for(name))?;
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
    manifest_for: &dyn Fn(&str) -> String,
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
        for (name, path) in &manifests {
            let key = format!(r"HKCU\Software\{vendor}\NativeMessagingHosts\{name}");
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

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
