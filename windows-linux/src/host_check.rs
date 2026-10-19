//! `munim-computer-use check-native-host`: look for this identity's
//! native-messaging host the way Chrome does, start it the way Chrome does, and
//! say which step would fail.
//!
//! Chrome reports every lookup failure — no registry key, a manifest it cannot
//! read or parse, a name that does not match — as the same "Specified native
//! messaging host not found.", so a registration that succeeded says nothing
//! about whether Chrome can use it. It may have been written somewhere Chrome
//! does not look (a parent that is MSIX-packaged or runs as another account
//! sees its own private HKCU), or replaced since. This retraces each step.
//!
//! The launch runs the registered command line exactly as Chrome would, but
//! points the relay at a throwaway bridge name: a relay that reached the real
//! bridge would take the live extension's place. Only wrappers this identity
//! wrote are started; another app's host is checked but left alone.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::identity::Identity;

/// How long a started host may take to report that the throwaway bridge is
/// not there. It normally takes milliseconds; a cold antivirus scan does not.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(15);

/// What Chrome's `connectNative` would end in, named by the message it shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    NotFound,
    Forbidden,
    FailedToStart,
}

impl Outcome {
    fn chrome_error(self) -> Option<&'static str> {
        match self {
            Self::Ok => None,
            Self::NotFound => Some("Specified native messaging host not found."),
            Self::Forbidden => Some("Access to the specified native messaging host is forbidden."),
            Self::FailedToStart => Some("Failed to start native messaging host."),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::NotFound => "not_found",
            Self::Forbidden => "forbidden",
            Self::FailedToStart => "failed_to_start",
        }
    }
}

#[derive(Debug)]
struct Step {
    name: &'static str,
    ok: bool,
    detail: String,
}

impl Step {
    fn pass(name: &'static str, detail: impl Into<String>) -> Self {
        Self { name, ok: true, detail: detail.into() }
    }

    fn fail(name: &'static str, detail: impl Into<String>) -> Self {
        Self { name, ok: false, detail: detail.into() }
    }
}

/// One host name as one browser would see it.
#[derive(Debug)]
struct Finding {
    browser: &'static str,
    host: String,
    /// This identity's own host (the first name), not a compatibility alias.
    primary: bool,
    steps: Vec<Step>,
    outcome: Outcome,
    /// The program the manifest names, once it parsed, and whether it is the
    /// wrapper this identity writes.
    program: Option<(PathBuf, bool)>,
}

impl Finding {
    fn to_json(&self) -> Value {
        json!({
            "browser": self.browser,
            "host": self.host,
            "primary": self.primary,
            "outcome": self.outcome.label(),
            "chromeError": self.outcome.chrome_error(),
            "steps": self.steps.iter().map(|step| json!({
                "step": step.name,
                "ok": step.ok,
                "detail": step.detail,
            })).collect::<Vec<_>>(),
        })
    }
}

pub fn run(args: &[String]) -> i32 {
    let mut as_json = false;
    let mut launch = true;
    let mut extension_id: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--json" => as_json = true,
            "--no-launch" => launch = false,
            "--extension-id" => extension_id = iter.next().cloned(),
            other => {
                eprintln!("munim-computer-use: check-native-host: unknown option {other}");
                eprintln!("usage: munim-computer-use check-native-host [--extension-id ID] [--no-launch] [--json]");
                return 2;
            }
        }
    }
    let identity = crate::identity::get();
    let Some(extension_id) = extension_id.or_else(|| identity.extension_ids.first().cloned()) else {
        eprintln!("munim-computer-use: check-native-host: this identity names no extension id; pass --extension-id");
        return 2;
    };
    let report = check(identity, &extension_id, launch);
    if as_json {
        println!("{:#}", report.json);
    } else {
        print!("{}", report.text);
    }
    if report.ready { 0 } else { 1 }
}

pub struct Report {
    pub json: Value,
    pub text: String,
    /// Chrome should reach this identity's own host, as far as this process
    /// can tell (a virtualised view of the registry is not "can tell").
    pub ready: bool,
    /// One line per thing that would stop the extension connecting.
    pub problems: Vec<String>,
}

pub fn check(identity: &Identity, extension_id: &str, launch: bool) -> Report {
    let origin = format!("chrome-extension://{extension_id}/");
    let ours = wrapper_path(identity);
    let mut findings = find_all(identity, &origin, ours.as_deref());
    if launch {
        // Each distinct wrapper once, even when several names point at it.
        let mut launched: Vec<(PathBuf, Step)> = Vec::new();
        for finding in findings.iter_mut().filter(|finding| finding.outcome == Outcome::Ok) {
            let Some((program, is_ours)) = finding.program.clone() else { continue };
            if !is_ours {
                finding.steps.push(Step::pass(
                    "launch",
                    format!("not started: {} is another app's host", program.display()),
                ));
                continue;
            }
            let step = match launched.iter().find(|(path, _)| *path == program) {
                Some((_, step)) => Step { name: step.name, ok: step.ok, detail: step.detail.clone() },
                None => {
                    let step = launch_like_chrome(&program, &origin);
                    launched.push((program.clone(), Step { name: step.name, ok: step.ok, detail: step.detail.clone() }));
                    step
                }
            };
            if !step.ok {
                finding.outcome = Outcome::FailedToStart;
            }
            finding.steps.push(step);
        }
    }

    let bridge = bridge_status(identity);
    let owner = if bridge.2 { ask_owner() } else { OwnerReport::default() };
    let presence = crate::bridge_diag::Presence::look(extension_id);
    let extension_problem = presence.problem(extension_id);
    #[cfg(windows)]
    let context = crate::platform::session::Context::probe();
    #[cfg(windows)]
    let context_problems = context.registration_problems();
    #[cfg(not(windows))]
    let context_problems: Vec<String> = Vec::new();

    let primary_ok = findings.iter().any(|finding| finding.primary && finding.outcome == Outcome::Ok);
    let mut problems: Vec<String> = context_problems.iter().map(|problem| format!("this process {problem}")).collect();
    if !primary_ok {
        let host = identity.native_host_names.first().map_or("", String::as_str);
        let why = findings
            .iter()
            .filter(|finding| finding.primary)
            .filter_map(|finding| {
                let failed = finding.steps.iter().find(|step| !step.ok)?;
                Some(format!("{}: {} — {}", finding.browser, failed.name, failed.detail))
            })
            .collect::<Vec<_>>();
        problems.push(if why.is_empty() {
            format!("no browser would find {host}")
        } else {
            format!("Chrome would not reach {host} ({})", why.join("; "))
        });
    }
    if let Some((said, step)) = &extension_problem {
        problems.push(format!("{said}; {step}"));
    }
    let ready = primary_ok && context_problems.is_empty() && extension_problem.is_none();

    let mut text = format!("extension: {origin} (pass --extension-id for another build)\n\n");
    for finding in &findings {
        text.push_str(&format!(
            "{} · {}{}\n",
            finding.browser,
            finding.host,
            if finding.primary { "" } else { " (compatibility alias)" }
        ));
        for step in &finding.steps {
            text.push_str(&format!("  {:<5} {}: {}\n", if step.ok { "ok" } else { "FAIL" }, step.name, step.detail));
        }
        text.push_str(&match finding.outcome.chrome_error() {
            None => "  => connectNative would reach this host\n\n".to_string(),
            Some(error) => format!("  => connectNative would fail: \"{error}\"\n\n"),
        });
    }
    text.push_str(&format!("bridge: {}\n", bridge.1));
    for line in &owner.lines {
        text.push_str(&format!("  {line}\n"));
    }
    text.push_str(&format!("extension installed: {}\n", presence_line(&presence)));
    #[cfg(windows)]
    {
        text.push_str(&format!(
            "this process: {}, {} integrity, session {}{}\n",
            context.user.as_deref().unwrap_or("unknown user"),
            context.to_json()["integrity"].as_str().unwrap_or("unknown"),
            context.session.map_or("?".to_string(), |session| session.to_string()),
            context.package.as_deref().map_or(String::new(), |package| format!(", inside package {package}")),
        ));
        for problem in &context_problems {
            text.push_str(&format!(
                "  WARN  it {problem}.\n        Everything above was read through that same view, so it can look \
                 right here and still be invisible to Chrome. Run install-native-host from an ordinary terminal \
                 as the signed-in user.\n"
            ));
        }
    }
    text.push_str(&if ready {
        "\nready: Chrome can find and start this host. If the extension still reports it missing, check in \
         chrome://extensions that it is enabled and has the extension id above.\n"
            .to_string()
    } else if primary_ok && let Some((said, step)) = &extension_problem {
        format!("\nnot ready — the host is fine, but: {said}. Next: {step}.\n")
    } else {
        "\nnot ready — fix the first FAIL or WARN above, then run this again.\n".to_string()
    });

    #[cfg(windows)]
    let context_json = context.to_json();
    #[cfg(not(windows))]
    let context_json = Value::Null;
    Report {
        json: json!({
            "ready": ready,
            "extensionOrigin": origin,
            "wrapper": ours.map(|path| path.to_string_lossy().into_owned()),
            "hosts": findings.iter().map(Finding::to_json).collect::<Vec<_>>(),
            "bridge": {
                "name": bridge.0,
                "listening": bridge.2,
                "detail": bridge.1,
                "owner": owner.record.as_ref().map(crate::bridge_diag::OwnerRecord::to_json),
                "extensionConnected": owner.extension_connected,
                "joinError": owner.join_error,
            },
            "extensionInstalled": presence.to_json(),
            "process": context_json,
            "problems": problems,
        }),
        text,
        ready,
        problems,
    }
}

/// The wrapper `install-native-host` writes for this identity.
fn wrapper_path(identity: &Identity) -> Option<PathBuf> {
    let support = identity.support_dir()?;
    Some(support.join(if cfg!(windows) { "native-host.cmd" } else { "native-host" }))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Chrome's own checks on a host manifest, in Chrome's order. On success, the
/// program it names (resolved against the manifest's directory if relative).
pub fn check_manifest(bytes: &[u8], manifest: &Path, host: &str, origin: &str) -> Result<PathBuf, (Outcome, String)> {
    let not_found = |detail: String| Err((Outcome::NotFound, detail));
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return not_found("saved as UTF-16; Chrome only reads UTF-8 manifests".into());
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return not_found("not valid UTF-8".into());
    };
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(error) => return not_found(format!("not valid JSON ({error})")),
    };
    let Some(fields) = value.as_object() else {
        return not_found("not a JSON object".into());
    };
    let name = fields.get("name").and_then(Value::as_str);
    if !name.is_some_and(valid_host_name) {
        return not_found("\"name\" is missing or not a valid host name".into());
    }
    if !fields.get("description").is_some_and(Value::is_string) {
        return not_found("\"description\" is missing".into());
    }
    let Some(path) = fields.get("path").and_then(Value::as_str).filter(|path| !path.is_empty()) else {
        return not_found("\"path\" is missing".into());
    };
    if fields.get("type").and_then(Value::as_str) != Some("stdio") {
        return not_found("\"type\" must be \"stdio\"".into());
    }
    let Some(origins) = fields.get("allowed_origins").and_then(Value::as_array) else {
        return not_found("\"allowed_origins\" is missing".into());
    };
    let mut patterns = Vec::new();
    for entry in origins {
        let Some(pattern) = entry.as_str().filter(|pattern| pattern.starts_with("chrome-extension://")) else {
            return not_found(format!("\"allowed_origins\" has an entry Chrome rejects: {entry}"));
        };
        let authority = &pattern["chrome-extension://".len()..];
        if authority.split('/').next().is_some_and(|id| id.is_empty() || id.contains('*')) {
            return not_found(format!("\"allowed_origins\" may not use a wildcard extension id: {pattern}"));
        }
        patterns.push(pattern);
    }
    if name != Some(host) {
        return not_found(format!("its \"name\" is {:?}, not {host:?}", name.unwrap_or_default()));
    }
    if !patterns.iter().any(|pattern| pattern.starts_with(origin)) {
        return Err((Outcome::Forbidden, format!("\"allowed_origins\" does not include {origin}")));
    }
    let program = PathBuf::from(path);
    let program = if program.is_absolute() {
        program
    } else if cfg!(windows) {
        manifest.parent().map_or(program.clone(), |dir| dir.join(&program))
    } else {
        return not_found(format!("\"path\" must be absolute on this platform: {path}"));
    };
    if !program.is_file() {
        return Err((Outcome::FailedToStart, format!("names {}, which does not exist", program.display())));
    }
    Ok(program)
}

/// Chrome's rule: lowercase letters, digits, `_` and `.`, with no leading,
/// trailing or doubled dot. A `-` is the usual way to break it.
pub fn valid_host_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
}

/// Load a manifest Chrome found and record what Chrome would make of it; on
/// success the finding stays `Ok`, with its program set for the launch step.
fn read_manifest(finding: &mut Finding, manifest: &Path, origin: &str, ours: Option<&Path>) {
    let bytes = match std::fs::read(manifest) {
        Ok(bytes) => bytes,
        Err(error) => {
            finding.steps.push(Step::fail("manifest", format!("{} cannot be read: {error}", manifest.display())));
            finding.outcome = Outcome::NotFound;
            return;
        }
    };
    match check_manifest(&bytes, manifest, &finding.host, origin) {
        Ok(program) => {
            let is_ours = ours.is_some_and(|ours| same_file(&program, ours));
            finding.steps.push(Step::pass(
                "manifest",
                format!("{} is valid, allows {origin}, and runs {}", manifest.display(), program.display()),
            ));
            finding.program = Some((program, is_ours));
        }
        Err((outcome, detail)) => {
            finding.steps.push(Step::fail("manifest", format!("{}: {detail}", manifest.display())));
            finding.outcome = outcome;
        }
    }
}

#[cfg(windows)]
fn find_all(identity: &Identity, origin: &str, ours: Option<&Path>) -> Vec<Finding> {
    // Every Chrome channel reads Google\Chrome's keys; Chromium reads its own.
    let browsers = [("Google Chrome", r"Google\Chrome"), ("Chromium", "Chromium")];
    let mut findings = Vec::new();
    for (browser, vendor) in browsers {
        let policy = Policy::read(vendor);
        for (index, host) in identity.native_host_names.iter().enumerate() {
            let mut finding = Finding {
                browser,
                host: host.clone(),
                primary: index == 0,
                steps: Vec::new(),
                outcome: Outcome::Ok,
                program: None,
            };
            if let Some(reason) = policy.blocks(host) {
                finding.steps.push(Step::fail("policy", reason));
                finding.outcome = Outcome::Forbidden;
                findings.push(finding);
                continue;
            }
            // Chrome takes the first of these that has a value, and does not
            // fall back past a key that points at a broken manifest.
            let mut views = Vec::new();
            if policy.user_level_hosts {
                views.push(("HKCU", "64"));
                views.push(("HKCU", "32"));
            }
            views.push(("HKLM", "64"));
            views.push(("HKLM", "32"));
            let found = views.iter().find_map(|(hive, view)| {
                let key = format!(r"{hive}\SOFTWARE\{vendor}\NativeMessagingHosts\{host}");
                crate::install::registry_default(&key, Some(view)).map(|path| (key, *view, path))
            });
            match found {
                None => {
                    let skipped = if policy.user_level_hosts {
                        ""
                    } else {
                        " (HKCU skipped: the NativeMessagingUserLevelHosts policy disables per-user hosts)"
                    };
                    finding.steps.push(Step::fail("registry", format!("no key under {vendor} in HKCU or HKLM{skipped}")));
                    finding.outcome = Outcome::NotFound;
                }
                Some((key, view, path)) => {
                    let manifest = PathBuf::from(&path);
                    if !manifest.is_absolute() {
                        finding.steps.push(Step::fail("registry", format!("{key} names a relative path, {path}")));
                        finding.outcome = Outcome::NotFound;
                    } else {
                        finding.steps.push(Step::pass("registry", format!("{key} ({view}-bit view) → {path}")));
                        read_manifest(&mut finding, &manifest, origin, ours);
                    }
                }
            }
            findings.push(finding);
        }
    }
    findings
}

/// The Chrome policies that decide whether a host may be used at all.
#[cfg(windows)]
struct Policy {
    user_level_hosts: bool,
    blocklist: Vec<String>,
    allowlist: Vec<String>,
}

#[cfg(windows)]
impl Policy {
    fn read(vendor: &str) -> Self {
        let roots = [format!(r"HKLM\SOFTWARE\Policies\{vendor}"), format!(r"HKCU\SOFTWARE\Policies\{vendor}")];
        let user_level_hosts = !roots.iter().any(|root| {
            crate::install::registry_values(root)
                .iter()
                .any(|(name, data)| name.eq_ignore_ascii_case("NativeMessagingUserLevelHosts") && data == "0x0")
        });
        let list = |name: &str| {
            roots
                .iter()
                .flat_map(|root| crate::install::registry_values(&format!(r"{root}\{name}")))
                .map(|(_, data)| data)
                .collect::<Vec<_>>()
        };
        Self { user_level_hosts, blocklist: list("NativeMessagingBlocklist"), allowlist: list("NativeMessagingAllowlist") }
    }

    fn blocks(&self, host: &str) -> Option<String> {
        if self.allowlist.iter().any(|allowed| allowed == host) {
            return None;
        }
        self.blocklist
            .iter()
            .find(|blocked| *blocked == "*" || *blocked == host)
            .map(|blocked| format!("the NativeMessagingBlocklist policy lists {blocked:?}"))
    }
}

#[cfg(not(windows))]
fn find_all(identity: &Identity, origin: &str, ours: Option<&Path>) -> Vec<Finding> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    // User-level directory first, then the system one, as Chrome looks.
    let browsers: [(&'static str, &str, &str); 2] = [
        ("Google Chrome", "google-chrome", "/etc/opt/chrome/native-messaging-hosts"),
        ("Chromium", "chromium", "/etc/chromium/native-messaging-hosts"),
    ];
    let mut findings = Vec::new();
    for (browser, dir, system) in browsers {
        let user_dir = config.as_ref().map(|config| config.join(dir).join("NativeMessagingHosts"));
        if !user_dir.as_ref().is_some_and(|dir| dir.parent().is_some_and(Path::is_dir)) && !Path::new(system).is_dir() {
            continue;
        }
        for (index, host) in identity.native_host_names.iter().enumerate() {
            let mut finding = Finding {
                browser,
                host: host.clone(),
                primary: index == 0,
                steps: Vec::new(),
                outcome: Outcome::Ok,
                program: None,
            };
            let candidates = user_dir.iter().cloned().chain([PathBuf::from(system)]).map(|dir| dir.join(format!("{host}.json")));
            match candidates.into_iter().find(|path| path.is_file()) {
                None => {
                    finding.steps.push(Step::fail("lookup", format!("no {host}.json in {dir}/NativeMessagingHosts or {system}")));
                    finding.outcome = Outcome::NotFound;
                }
                Some(manifest) => {
                    finding.steps.push(Step::pass("lookup", manifest.display().to_string()));
                    read_manifest(&mut finding, &manifest, origin, ours);
                }
            }
            findings.push(finding);
        }
    }
    findings
}

/// A bridge name no server listens on, so the relay started below reports
/// that and exits instead of connecting anywhere.
fn throwaway_bridge() -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let name = format!("munim-computer-use-hostcheck-{}-{stamp}", std::process::id());
    if cfg!(windows) {
        name
    } else {
        std::env::temp_dir().join(name).join("bridge.sock").to_string_lossy().into_owned()
    }
}

/// Start `program` with the command line Chrome uses, and watch it get as far
/// as looking for the bridge.
fn launch_like_chrome(program: &Path, origin: &str) -> Step {
    use std::io::Read;
    use std::process::{Command, Stdio};

    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        // Chrome: %COMSPEC% /d /s /c ""<path>" <origin> --parent-window=<hwnd>"
        let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
        let mut command = Command::new(comspec);
        command.raw_arg(format!("/d /s /c \"\"{}\" {origin} --parent-window=0\"", program.display()));
        // No console window when this runs from a GUI embedder.
        command.creation_flags(0x0800_0000);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(program);
        command.arg(origin);
        command
    };
    let bridge = throwaway_bridge();
    command
        .env("COMPUTER_USE_BRIDGE_SOCKET", &bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Step::fail("launch", format!("could not run the host command: {error}")),
    };
    // End of input: should the relay somehow connect, it stops at once.
    drop(child.stdin.take());
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < LAUNCH_TIMEOUT => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if !cfg!(windows) {
        if let Some(dir) = Path::new(&bridge).parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    // cmd wraps its messages; one line reads better in a step.
    let stderr = stderr.split_whitespace().collect::<Vec<_>>().join(" ");
    match status {
        None => Step::fail(
            "launch",
            format!("the host neither connected nor exited within {}s", LAUNCH_TIMEOUT.as_secs()),
        ),
        // Our relay says this when the bridge is missing: it ran, in host mode.
        Some(_) if stderr.contains("native host stopped") => {
            Step::pass("launch", "Chrome's command line started munim-computer-use in native-host mode")
        }
        Some(status) => Step::fail(
            "launch",
            format!(
                "the host command exited ({status}) without starting the relay{}",
                if stderr.is_empty() { String::new() } else { format!(": {stderr}") }
            ),
        ),
    }
}

/// (bridge name, what it means, whether a server is listening).
fn bridge_status(identity: &Identity) -> (String, String, bool) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{ERROR_SEM_TIMEOUT, GetLastError};
        use windows::Win32::System::Pipes::WaitNamedPipeW;
        use windows::core::HSTRING;
        let name = identity.bridge_pipe_name();
        let path = HSTRING::from(format!(r"\\.\pipe\{name}"));
        // Waits for a free instance without connecting to it, so this cannot
        // take the extension's place. Busy still means a server owns it.
        let listening = unsafe { WaitNamedPipeW(&path, 1) }.as_bool() || unsafe { GetLastError() } == ERROR_SEM_TIMEOUT;
        let detail = if listening {
            format!(r"\\.\pipe\{name} — an MCP server is running and will receive the extension")
        } else {
            format!(
                r"\\.\pipe\{name} — no MCP server is running for this user yet; the extension connects once your agent starts one"
            )
        };
        (name, detail, listening)
    }
    #[cfg(not(windows))]
    {
        let (dir, file) = identity.bridge_socket_path();
        let path = dir.join(file);
        let listening = path.exists();
        let detail = if listening {
            format!("{} — an MCP server is running and will receive the extension", path.display())
        } else {
            format!(
                "{} — no MCP server is running yet; the extension connects once your agent starts one",
                path.display()
            )
        };
        (path.to_string_lossy().into_owned(), detail, listening)
    }
}

/// What the bridge owner says about itself over its peer endpoint.
#[derive(Default)]
struct OwnerReport {
    record: Option<crate::bridge_diag::OwnerRecord>,
    /// `None` when the owner could not be asked.
    extension_connected: Option<bool>,
    join_error: Option<String>,
    lines: Vec<String>,
}

/// Ask the owner for `bridge_status`, as a peer would. An owner before 0.7.3
/// passes the command on to the extension, and what comes back still tells
/// whether the extension is connected. Nothing here can take the extension's
/// place: only the bridge itself carries it, and this joins the peer endpoint.
fn ask_owner() -> OwnerReport {
    let mut report = OwnerReport::default();
    let recorded = crate::bridge_diag::read_owner_record();
    let reply = match crate::browser::connect_rpc() {
        Err(error) => {
            report.join_error = Some(crate::bridge_diag::join_failure(&error));
            None
        }
        Ok(stream) => {
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                use std::io::{BufRead, Write};
                use interprocess::local_socket::traits::Stream as _;
                let (recv, mut send) = stream.split();
                let request = json!({ "id": 1, "command": "bridge_status", "params": { "clientId": "check-native-host" } });
                if writeln!(send, "{request}").and_then(|()| send.flush()).is_err() {
                    return;
                }
                let mut line = String::new();
                if std::io::BufReader::new(recv).read_line(&mut line).is_ok() {
                    let _ = sender.send(line);
                }
            });
            receiver.recv_timeout(Duration::from_secs(5)).ok()
        }
    };
    let reply: Option<Value> = reply.and_then(|line| serde_json::from_str(&line).ok());
    match &reply {
        Some(value) if value.get("ok").and_then(Value::as_bool) == Some(true) => {
            report.record = value.get("result").and_then(crate::bridge_diag::OwnerRecord::from_json);
            report.extension_connected = report.record.as_ref().map(|record| record.extension_connected);
        }
        Some(value) => {
            // An owner before 0.7.3. 0.7.2 names itself in `link`; any other
            // error came from the extension, which is therefore connected.
            let error = value.get("error").and_then(Value::as_str).unwrap_or_default();
            let link = value.get("link");
            report.extension_connected = Some(match link.and_then(|link| link.get("kind")).and_then(Value::as_str) {
                Some(kind) => kind != "no_host",
                None => error != "the extension disconnected",
            });
            report.lines.push(format!(
                "owner: {} (a build before 0.7.3, which does not report itself)",
                match link.and_then(|link| link.get("pid")).and_then(Value::as_u64) {
                    Some(pid) => format!(
                        "pid {pid}, munim-computer-use {}",
                        link.and_then(|link| link.get("version")).and_then(Value::as_str).unwrap_or("?")
                    ),
                    None => "unknown".into(),
                }
            ));
        }
        None => {}
    }
    // The record names the owner even when it cannot be asked.
    if report.record.is_none() && reply.is_none() {
        report.record = recorded;
    }
    if let Some(record) = &report.record {
        report.lines.insert(0, format!("owner: {}", record.describe()));
        if !record.peer_endpoint {
            report.lines.push("WARN  its peer endpoint is closed, so other MCP servers cannot join it".into());
        }
    } else if reply.is_none() {
        let servers = crate::bridge_diag::running_servers();
        report.lines.push(if servers.is_empty() {
            "owner: not a munim-computer-use process visible from here (another program, or a server running \
             as another user, elevated, or in a sandbox)"
                .into()
        } else {
            format!(
                "owner: did not record itself (servers before 0.7.3 do not); munim-computer-use processes \
                 running, one of which is probably the owner: {}",
                servers.iter().map(|server| format!("pid {} ({})", server.pid, server.exe)).collect::<Vec<_>>().join(", ")
            )
        });
    }
    report.lines.push(match report.extension_connected {
        Some(true) => "extension: connected to the owner".into(),
        Some(false) => "extension: NOT connected to the owner".into(),
        None => "extension: unknown (the owner could not be asked)".into(),
    });
    if let Some(error) = &report.join_error {
        report.lines.push(format!("joining from this terminal: {error}"));
    }
    report
}

fn presence_line(presence: &crate::bridge_diag::Presence) -> String {
    if presence.profiles.is_empty() {
        return "unknown (no Chrome, Chromium, Edge or Brave profile found for this user)".into();
    }
    if presence.found.is_empty() {
        return format!("NO — not in any of {}", presence.profiles.join(", "));
    }
    presence
        .found
        .iter()
        .map(|installed| format!("{} ({})", installed.profile, if installed.enabled { "enabled" } else { "DISABLED" }))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "com.munimtech.computer_use.desktop";
    const ORIGIN: &str = "chrome-extension://kgdolgnijopbghhomnblabjkmjhnoage/";

    fn manifest(program: &Path) -> String {
        json!({
            "name": HOST,
            "description": "d",
            "path": program.to_string_lossy(),
            "type": "stdio",
            "allowed_origins": [ORIGIN],
        })
        .to_string()
    }

    fn scratch(tag: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("cu-hostcheck-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("native-host");
        std::fs::write(&program, "").unwrap();
        (dir, program)
    }

    #[test]
    fn a_manifest_written_by_the_installer_passes() {
        let (dir, program) = scratch("ok");
        let text = manifest(&program);
        let found = check_manifest(text.as_bytes(), &dir.join("m.json"), HOST, ORIGIN);
        assert_eq!(found.unwrap(), program);
        // A UTF-8 byte order mark is fine; Chrome skips it.
        let with_bom = [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat();
        assert!(check_manifest(&with_bom, &dir.join("m.json"), HOST, ORIGIN).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn each_way_chrome_would_say_not_found_is_named() {
        let (dir, program) = scratch("bad");
        let good: Value = serde_json::from_str(&manifest(&program)).unwrap();
        let path = dir.join("m.json");
        let outcome = |value: &Value| check_manifest(value.to_string().as_bytes(), &path, HOST, ORIGIN).unwrap_err();
        let with = |key: &str, value: Value| {
            let mut changed = good.clone();
            changed[key] = value;
            changed
        };
        assert_eq!(outcome(&with("name", json!("com.other.host"))).0, Outcome::NotFound);
        assert_eq!(outcome(&with("name", json!("com.munimtech.computer-use"))).0, Outcome::NotFound);
        assert_eq!(outcome(&with("type", json!("pipe"))).0, Outcome::NotFound);
        let mut no_description = good.clone();
        no_description.as_object_mut().unwrap().remove("description");
        assert!(outcome(&no_description).1.contains("description"));
        assert!(outcome(&with("allowed_origins", json!(["chrome-extension://*/"]))).1.contains("wildcard"));
        // UTF-16, as PowerShell 5's Out-File writes it.
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("{}".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        assert!(check_manifest(&utf16, &path, HOST, ORIGIN).unwrap_err().1.contains("UTF-16"));
        // The right manifest for another extension is forbidden, not missing.
        assert_eq!(outcome(&with("allowed_origins", json!(["chrome-extension://abc/"]))).0, Outcome::Forbidden);
        // A program that is gone fails at start, after the lookup succeeded.
        assert_eq!(outcome(&with("path", json!(dir.join("gone").to_string_lossy()))).0, Outcome::FailedToStart);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn host_names_follow_chromes_rule() {
        assert!(valid_host_name(HOST));
        assert!(valid_host_name("com.munim.mtcode.desktop"));
        assert!(!valid_host_name("com.munimtech.computer-use.desktop"));
        assert!(!valid_host_name("Com.Upper"));
        assert!(!valid_host_name(".leading"));
        assert!(!valid_host_name("double..dot"));
    }
}
