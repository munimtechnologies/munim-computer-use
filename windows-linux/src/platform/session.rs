//! Whether this process can see the desktop the signed-in user is looking at.
//!
//! A server started inside a sandbox can still enumerate windows and read their
//! titles, yet get an empty UI Automation tree and black captures: other apps'
//! UIA providers refuse a restricted or low-integrity token, and a process on
//! another desktop, session or account sees none of the user's pixels. Every
//! call succeeds, so nothing fails loudly. [`desktop_warning`] turns what the
//! token and desktop say into one sentence the tools attach to results that
//! look wrong, so the model stops retrying something that cannot work.
//!
//! The same facts explain a native-messaging install Chrome cannot see: an
//! MSIX-packaged parent redirects HKCU and %LOCALAPPDATA% writes into a private
//! copy, and another account's HKCU is not the one the user's Chrome reads.

use serde_json::{Value, json};
use windows::Win32::Foundation::{APPMODEL_ERROR_NO_PACKAGE, CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE};
use windows::Win32::Security::{
    EqualSid, GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsTokenRestricted,
    LookupAccountSidW, PSID, SID_NAME_USE, TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    TOKEN_USER, TokenIntegrityLevel, TokenIsAppContainer, TokenUser,
};
use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetThreadDesktop, GetUserObjectInformationW,
    OpenInputDesktop, UOI_NAME,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};
use windows::core::{PCWSTR, PWSTR};

/// SECURITY_MANDATORY_MEDIUM_RID: an ordinary signed-in user's processes.
const MEDIUM_RID: u32 = 0x2000;

/// What one look at this process and its desktop found. `None` is "could not
/// be read", which is never itself treated as a problem.
#[derive(Debug, Clone)]
pub struct Context {
    /// `DOMAIN\name` this process runs as.
    pub user: Option<String>,
    /// The account that owns the desktop's shell (explorer.exe).
    pub desktop_user: Option<String>,
    /// This process and the shell run as different accounts.
    pub other_user: bool,
    /// Mandatory integrity level RID of this process's token.
    pub integrity: Option<u32>,
    pub restricted: bool,
    pub app_container: bool,
    /// Full name of the MSIX package this process runs inside, if any.
    pub package: Option<String>,
    pub session: Option<u32>,
    pub shell_session: Option<u32>,
    /// The desktop this thread is attached to.
    pub desktop: Option<String>,
    /// The desktop receiving input, or why it could not be opened.
    pub input_desktop: std::result::Result<String, String>,
}

/// Closes a token or process handle when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn token_of(process: HANDLE) -> Option<Owned> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    Some(Owned(token))
}

/// A variable-length token information block, in a buffer aligned for the
/// pointer-bearing structs it holds.
fn token_info(token: &Owned, class: TOKEN_INFORMATION_CLASS) -> Option<Vec<u64>> {
    let mut needed = 0u32;
    let _ = unsafe { GetTokenInformation(token.0, class, None, 0, &mut needed) };
    if needed == 0 {
        return None;
    }
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    unsafe {
        GetTokenInformation(token.0, class, Some(buffer.as_mut_ptr().cast()), needed, &mut needed)
    }
    .ok()?;
    Some(buffer)
}

/// The user SID inside a `TokenUser` block (valid while the block lives).
fn user_sid(block: &[u64]) -> PSID {
    unsafe { (*block.as_ptr().cast::<TOKEN_USER>()).User.Sid }
}

fn account_name(sid: PSID) -> Option<String> {
    let mut name = [0u16; 256];
    let mut domain = [0u16; 256];
    let (mut name_len, mut domain_len) = (name.len() as u32, domain.len() as u32);
    let mut kind = SID_NAME_USE::default();
    unsafe {
        LookupAccountSidW(
            PCWSTR::null(),
            sid,
            Some(PWSTR(name.as_mut_ptr())),
            &mut name_len,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut kind,
        )
    }
    .ok()?;
    let name = String::from_utf16_lossy(&name[..name_len as usize]);
    let domain = String::from_utf16_lossy(&domain[..domain_len as usize]);
    Some(if domain.is_empty() { name } else { format!("{domain}\\{name}") })
}

fn integrity_rid(token: &Owned) -> Option<u32> {
    let block = token_info(token, TokenIntegrityLevel)?;
    unsafe {
        let sid = (*block.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        (count > 0).then(|| *GetSidSubAuthority(sid, u32::from(count) - 1))
    }
}

fn integrity_name(rid: u32) -> &'static str {
    match rid {
        0..0x1000 => "untrusted",
        0x1000..0x2000 => "low",
        0x2000..0x3000 => "medium",
        0x3000..0x4000 => "high",
        _ => "system",
    }
}

fn is_app_container(token: &Owned) -> bool {
    token_info(token, TokenIsAppContainer).is_some_and(|block| block[0] as u32 != 0)
}

fn package_name() -> Option<String> {
    let mut length = 0u32;
    let status = unsafe { GetCurrentPackageFullName(&mut length, None) };
    if status == APPMODEL_ERROR_NO_PACKAGE || status != ERROR_INSUFFICIENT_BUFFER || length == 0 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    let status = unsafe { GetCurrentPackageFullName(&mut length, Some(PWSTR(buffer.as_mut_ptr()))) };
    if status.is_err() {
        return None;
    }
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

fn object_name(handle: HANDLE) -> Option<String> {
    let mut buffer = [0u16; 256];
    unsafe {
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            (buffer.len() * 2) as u32,
            None,
        )
    }
    .ok()?;
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

fn session_of(pid: u32) -> Option<u32> {
    let mut session = 0u32;
    unsafe { ProcessIdToSessionId(pid, &mut session) }.ok()?;
    Some(session)
}

impl Context {
    pub fn probe() -> Self {
        let ours = token_of(unsafe { GetCurrentProcess() });
        let our_user = ours.as_ref().and_then(|token| token_info(token, TokenUser));

        // The shell window belongs to whoever is signed in on this desktop.
        let shell = unsafe { GetShellWindow() };
        let mut shell_pid = 0u32;
        if !shell.0.is_null() {
            unsafe { GetWindowThreadProcessId(shell, Some(&mut shell_pid)) };
        }
        let shell_user = (shell_pid != 0)
            .then(|| unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, shell_pid) }.ok())
            .flatten()
            .map(Owned)
            .and_then(|process| token_of(process.0))
            .and_then(|token| token_info(&token, TokenUser));
        let other_user = match (&our_user, &shell_user) {
            (Some(ours), Some(theirs)) => unsafe { EqualSid(user_sid(ours), user_sid(theirs)) }.is_err(),
            _ => false,
        };

        let desktop = unsafe { GetThreadDesktop(GetCurrentThreadId()) }
            .ok()
            .and_then(|desk| object_name(HANDLE(desk.0)));
        let input_desktop = match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) } {
            Ok(desk) => {
                let name = object_name(HANDLE(desk.0));
                unsafe {
                    let _ = CloseDesktop(desk);
                }
                name.ok_or_else(|| "its name could not be read".to_string())
            }
            Err(error) => Err(error.message()),
        };

        Self {
            user: our_user.as_deref().and_then(|block| account_name(user_sid(block))),
            desktop_user: shell_user.as_deref().and_then(|block| account_name(user_sid(block))),
            other_user,
            integrity: ours.as_ref().and_then(integrity_rid),
            restricted: ours.as_ref().is_some_and(|token| unsafe { IsTokenRestricted(token.0) }.is_ok()),
            app_container: ours.as_ref().is_some_and(is_app_container),
            package: package_name(),
            session: session_of(unsafe { GetCurrentProcessId() }),
            shell_session: (shell_pid != 0).then(|| session_of(shell_pid)).flatten(),
            desktop,
            input_desktop,
        }
    }

    fn user_label(&self) -> String {
        self.user.clone().unwrap_or_else(|| "another account".into())
    }

    /// Why this process may not see the user's windows, as clauses that
    /// follow "it". Empty when everything looks like an ordinary session.
    pub fn desktop_problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        if self.app_container {
            problems.push("runs in an AppContainer, which other apps' UI Automation and screen capture refuse".into());
        } else if self.restricted {
            problems.push(
                "runs with a restricted (sandboxed) token, which other apps' UI Automation providers refuse".into(),
            );
        }
        if let Some(rid) = self.integrity.filter(|rid| *rid < MEDIUM_RID) {
            problems.push(format!(
                "runs at {} integrity, so Windows hides the UI of ordinary apps from it",
                integrity_name(rid)
            ));
        }
        if self.other_user {
            problems.push(format!(
                "runs as {}, but the desktop belongs to {}",
                self.user_label(),
                self.desktop_user.as_deref().unwrap_or("another account")
            ));
        }
        match (self.session, self.shell_session) {
            (Some(0), _) => problems.push("runs in session 0, the services session, which has no user desktop".into()),
            (Some(ours), Some(theirs)) if ours != theirs => {
                problems.push(format!("runs in session {ours}, but the desktop's shell is in session {theirs}"));
            }
            _ => {}
        }
        match &self.input_desktop {
            Err(reason) => problems.push(format!(
                "cannot open the desktop that receives input ({}) — the screen may be locked or showing a \
                 UAC prompt, or this process is not allowed onto the user's desktop",
                reason.trim_end_matches('.')
            )),
            Ok(input) => {
                if let Some(ours) = self.desktop.as_deref().filter(|ours| !ours.eq_ignore_ascii_case(input)) {
                    problems.push(format!("is attached to desktop \"{ours}\", but input goes to \"{input}\""));
                }
            }
        }
        problems
    }

    /// Why registry keys and files written from here may be invisible to the
    /// user's Chrome, as clauses that follow "it".
    pub fn registration_problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        if let Some(package) = &self.package {
            problems.push(format!(
                "runs inside the MSIX package {package}, and Windows redirects a packaged app's HKCU and \
                 %LOCALAPPDATA% writes into a private copy that Chrome never reads"
            ));
        } else if self.app_container {
            problems.push(
                "runs in an AppContainer, whose registry and AppData writes are kept away from the ones Chrome reads"
                    .into(),
            );
        }
        if self.other_user {
            problems.push(format!(
                "runs as {}, but the signed-in desktop belongs to {}: Chrome reads its own user's HKCU, and the \
                 bridge pipe is named after the user who starts the server",
                self.user_label(),
                self.desktop_user.as_deref().unwrap_or("another account")
            ));
        }
        problems
    }

    pub fn to_json(&self) -> Value {
        json!({
            "user": self.user,
            "desktopUser": self.desktop_user,
            "integrity": self.integrity.map(integrity_name),
            "restricted": self.restricted,
            "appContainer": self.app_container,
            "package": self.package,
            "session": self.session,
            "shellSession": self.shell_session,
            "desktop": self.desktop,
            "inputDesktop": match &self.input_desktop {
                Ok(name) => json!(name),
                Err(reason) => json!({ "error": reason }),
            },
            "desktopProblems": self.desktop_problems(),
            "registrationProblems": self.registration_problems(),
        })
    }
}

/// One sentence for a tool result that came back empty or black, when this
/// process's token or desktop explains it. Probed afresh each time: the input
/// desktop changes when the screen locks or a UAC prompt opens.
pub fn desktop_warning() -> Option<String> {
    let problems = Context::probe().desktop_problems();
    (!problems.is_empty()).then(|| {
        format!(
            "this server process may not have access to the interactive desktop: it {}. Results read from \
             here can be empty or black even though the app is fine, so retrying will not help; start the \
             MCP server in the signed-in user's own, unsandboxed context instead",
            problems.join("; it ")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ordinary() -> Context {
        Context {
            user: Some("PC\\ada".into()),
            desktop_user: Some("PC\\ada".into()),
            other_user: false,
            integrity: Some(MEDIUM_RID),
            restricted: false,
            app_container: false,
            package: None,
            session: Some(1),
            shell_session: Some(1),
            desktop: Some("Default".into()),
            input_desktop: Ok("Default".into()),
        }
    }

    #[test]
    fn an_ordinary_session_has_no_problems() {
        assert!(ordinary().desktop_problems().is_empty());
        assert!(ordinary().registration_problems().is_empty());
        // Elevated is still the same user on the same desktop.
        let elevated = Context { integrity: Some(0x3000), ..ordinary() };
        assert!(elevated.desktop_problems().is_empty());
    }

    #[test]
    fn a_sandboxed_token_is_named() {
        let sandboxed = Context { restricted: true, integrity: Some(0x1000), ..ordinary() };
        let problems = sandboxed.desktop_problems();
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(problems[0].contains("restricted"), "{problems:?}");
        assert!(problems[1].contains("low integrity"), "{problems:?}");
    }

    #[test]
    fn another_account_breaks_both_desktop_and_registration() {
        let other = Context { user: Some("PC\\CodexSandbox".into()), other_user: true, ..ordinary() };
        assert!(other.desktop_problems()[0].contains("runs as PC\\CodexSandbox, but the desktop belongs to PC\\ada"));
        assert!(other.registration_problems()[0].contains("Chrome reads its own user's HKCU"));
    }

    #[test]
    fn a_locked_screen_or_other_desktop_is_reported() {
        let locked = Context { input_desktop: Err("Access is denied.".into()), ..ordinary() };
        assert!(locked.desktop_problems()[0].contains("(Access is denied)"));
        let private = Context { desktop: Some("SandboxDesktop".into()), ..ordinary() };
        assert!(private.desktop_problems()[0].contains("\"SandboxDesktop\""));
        let service = Context { session: Some(0), ..ordinary() };
        assert!(service.desktop_problems()[0].contains("session 0"));
    }

    #[test]
    fn a_packaged_parent_hides_the_registration() {
        let packaged = Context { package: Some("OpenAI.Codex_1.0.0.0_x64__abc".into()), ..ordinary() };
        assert!(packaged.desktop_problems().is_empty());
        assert!(packaged.registration_problems()[0].contains("MSIX package OpenAI.Codex"));
    }

    #[test]
    fn the_live_probe_runs() {
        // Whatever this machine is, probing must not fail or panic.
        let context = Context::probe();
        assert!(context.to_json().is_object());
    }
}
