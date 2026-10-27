//! Administrator (UAC) and lock-screen prompts in a remote viewer, the way
//! Chrome Remote Desktop shows them.
//!
//! Windows draws those prompts on the Winlogon desktop, which only SYSTEM can
//! open. This server runs as the signed-in user, so while one is up its live
//! capture is refused and its input goes nowhere. Three pieces close the gap:
//!
//! - `install-secure-desktop` (one administrator approval) copies this binary
//!   to an admin-owned folder and registers a LocalSystem service that runs it
//!   as `secure-desktop-service`.
//! - The service keeps one `secure-desktop-helper` running as SYSTEM in the
//!   active console session. Before every request the helper moves its thread
//!   to whichever desktop has input, so it captures and clicks the prompt.
//! - A remote-control server (`<prefix>REMOTE_CONTROL=1`, the viewer's own
//!   process) hands display captures and pointer/keyboard input to the helper
//!   over a named pipe whenever it cannot open the input desktop itself.
//!
//! Agent servers never route, so agent tools cannot answer an elevation
//! prompt. The pipe admits the signed-in user's processes, though, so this
//! is not a boundary against other code running as that user.

use std::cell::{Cell, RefCell};
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::FromRawHandle;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Value, json};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_CANCELLED, ERROR_PIPE_CONNECTED, HANDLE, HLOCAL, LocalFree, WAIT_TIMEOUT,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    DuplicateTokenEx, GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, SecurityImpersonation,
    SetTokenInformation, TOKEN_ACCESS_MASK, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DUPLICATE, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER, TokenElevation, TokenPrimary, TokenSessionId,
    TokenUser,
};
use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, HDESK, OpenInputDesktop, SetThreadDesktop,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateProcessAsUserW, GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess,
    INFINITE, OpenProcess, OpenProcessToken, PROCESS_INFORMATION, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, STARTUPINFOW, TerminateProcess,
    WaitForSingleObject,
};
use windows::Win32::UI::Shell::{SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
use windows::core::{PCWSTR, PWSTR};
use windows_service::service::{
    ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode, ServiceInfo,
    ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

use crate::platform::ScrollDirection;
use crate::platform::windows::raw;
use crate::{arg_f64, arg_i64, arg_str, text_result};

const SERVICE_NAME: &str = "MunimComputerUseSecureDesktop";
const SERVICE_DISPLAY_NAME: &str = "Munim Computer Use secure desktop";
const SERVICE_DESCRIPTION: &str = "Lets the person viewing this computer in MT Code's Computer View see and \
     answer administrator (UAC) and lock-screen prompts.";
const BINARY_NAME: &str = "munim-computer-use.exe";

/// Tools a viewer uses. Everything else needs UI Automation, which cannot
/// reach the Winlogon desktop.
const ROUTED_TOOLS: [&str; 9] =
    ["screenshot", "list_displays", "hover", "click", "right_click", "drag", "scroll", "press_key", "type_text"];

const NOT_INSTALLED: &str = "the screen is showing an administrator (UAC) or lock-screen prompt, which this \
     process cannot see or answer. To show those prompts here, run `munim-computer-use install-secure-desktop` \
     once and approve it (in MT Code: Settings → Computer Use → Admin prompts)";

/// The subcommands this module owns; None for any other mode.
pub fn run(mode: &str) -> Option<i32> {
    Some(match mode {
        "install-secure-desktop" => elevated("install-secure-desktop", install),
        "uninstall-secure-desktop" => elevated("uninstall-secure-desktop", uninstall),
        "secure-desktop-status" => {
            println!("{}", status());
            0
        }
        "secure-desktop-service" => match service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("munim-computer-use: secure-desktop-service must be started by Windows: {error}");
                1
            }
        },
        "secure-desktop-helper" => run_helper(),
        _ => return None,
    })
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn session_of(pid: u32) -> Option<u32> {
    let mut session = 0u32;
    unsafe { ProcessIdToSessionId(pid, &mut session) }.ok().map(|_| session)
}

fn pipe_name(session: u32) -> String {
    format!(r"\\.\pipe\munim-computer-use-secure-desktop-{session}")
}

fn install_dir() -> PathBuf {
    let base = std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .unwrap_or_else(|| OsString::from(r"C:\Program Files"));
    PathBuf::from(base).join("Munim").join("munim-computer-use")
}

// ---------------------------------------------------------------------------
// Install, uninstall, status

fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

/// Run `action` with administrator rights, asking for them (one UAC prompt)
/// by relaunching this binary elevated when the current token lacks them.
fn elevated(mode: &str, action: fn() -> Result<(), String>) -> i32 {
    if is_elevated() {
        return match action() {
            Ok(()) => {
                println!("{}", status());
                0
            }
            Err(error) => {
                eprintln!("munim-computer-use: {mode} failed: {error}");
                1
            }
        };
    }
    let Ok(exe) = std::env::current_exe() else {
        eprintln!("munim-computer-use: cannot find this binary to relaunch it elevated");
        return 1;
    };
    let file = wide(&exe.to_string_lossy());
    let verb = wide("runas");
    let parameters = wide(mode);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    if let Err(error) = unsafe { ShellExecuteExW(&mut info) } {
        if error.code() == ERROR_CANCELLED.to_hresult() {
            eprintln!("munim-computer-use: the administrator prompt was declined; nothing changed");
        } else {
            eprintln!("munim-computer-use: could not ask for administrator rights: {error}");
        }
        return 1;
    }
    let mut code = 1u32;
    unsafe {
        WaitForSingleObject(info.hProcess, INFINITE);
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
    }
    println!("{}", status());
    code as i32
}

fn manager(access: ServiceManagerAccess) -> Result<ServiceManager, String> {
    ServiceManager::local_computer(None::<&str>, access).map_err(|error| format!("service manager: {error}"))
}

fn stop_and_wait(service: &windows_service::service::Service) {
    let Ok(status) = service.query_status() else { return };
    if status.current_state == ServiceState::Stopped {
        return;
    }
    let _ = service.stop();
    for _ in 0..100 {
        if service.query_status().map(|status| status.current_state == ServiceState::Stopped).unwrap_or(true) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Copy, retrying while the old service process lets go of the file.
fn copy_binary(from: &Path, to: &Path) -> Result<(), String> {
    let mut last = String::new();
    for _ in 0..50 {
        match std::fs::copy(from, to) {
            Ok(_) => return Ok(()),
            Err(error) => last = error.to_string(),
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("could not copy {} to {}: {last}", from.display(), to.display()))
}

fn install() -> Result<(), String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let dir = install_dir();
    std::fs::create_dir_all(&dir).map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    let target = dir.join(BINARY_NAME);

    let manager = manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;
    let access = ServiceAccess::QUERY_STATUS | ServiceAccess::START | ServiceAccess::STOP | ServiceAccess::CHANGE_CONFIG;
    let existing = manager.open_service(SERVICE_NAME, access).ok();
    if let Some(service) = &existing {
        stop_and_wait(service);
    }
    // The service runs as SYSTEM, so it must run a copy only administrators
    // can replace, never the per-user install this was launched from.
    if !same_file(&current, &target) {
        copy_binary(&current, &target)?;
    }

    let info = ServiceInfo {
        name: SERVICE_NAME.into(),
        display_name: SERVICE_DISPLAY_NAME.into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: target,
        launch_arguments: vec!["secure-desktop-service".into()],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };
    let service = match existing {
        Some(service) => {
            service.change_config(&info).map_err(|error| format!("could not update the service: {error}"))?;
            service
        }
        None => manager
            .create_service(&info, access)
            .map_err(|error| format!("could not create the service: {error}"))?,
    };
    let _ = service.set_description(SERVICE_DESCRIPTION);
    service.start::<&str>(&[]).map_err(|error| format!("could not start the service: {error}"))
}

fn uninstall() -> Result<(), String> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    if let Ok(service) =
        manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE)
    {
        stop_and_wait(&service);
        service.delete().map_err(|error| format!("could not remove the service: {error}"))?;
    }
    let dir = install_dir();
    for _ in 0..25 {
        if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if let Some(parent) = dir.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// `{installed, running, current, path}`. `current` says whether the installed
/// copy is this exact binary, so an embedder can offer an update.
fn status() -> Value {
    let target = install_dir().join(BINARY_NAME);
    let service = manager(ServiceManagerAccess::CONNECT)
        .ok()
        .and_then(|manager| manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS).ok());
    let running = service
        .as_ref()
        .and_then(|service| service.query_status().ok())
        .is_some_and(|status| status.current_state == ServiceState::Running);
    let current = std::env::current_exe().is_ok_and(|exe| same_file(&exe, &target));
    json!({
        "installed": service.is_some(),
        "running": running,
        "current": current,
        "path": target.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Service: keep one helper in the active console session

define_windows_service!(ffi_service_main, service_main);

enum Event {
    Stop,
    SessionChanged,
}

fn service_main(_arguments: Vec<OsString>) {
    if let Err(error) = run_service() {
        eprintln!("munim-computer-use: secure-desktop-service stopped: {error}");
    }
}

fn run_service() -> windows_service::Result<()> {
    let (events, received) = mpsc::channel();
    let handler = move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = events.send(Event::Stop);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::SessionChange(_) => {
            let _ = events.send(Event::SessionChanged);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let status = service_control_handler::register(SERVICE_NAME, handler)?;
    let report = |state, accepted| {
        status.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accepted,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })
    };
    report(
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN | ServiceControlAccept::SESSION_CHANGE,
    )?;

    let mut helper: Option<(u32, HANDLE)> = None;
    let stop = |helper: &mut Option<(u32, HANDLE)>| {
        if let Some((_, process)) = helper.take() {
            unsafe {
                let _ = TerminateProcess(process, 0);
                let _ = CloseHandle(process);
            }
        }
    };
    loop {
        let session = unsafe { WTSGetActiveConsoleSessionId() };
        let alive = helper.is_some_and(|(owner, process)| {
            owner == session && unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT
        });
        if !alive {
            stop(&mut helper);
            if session != u32::MAX {
                match spawn_helper(session) {
                    Ok(process) => helper = Some((session, process)),
                    Err(error) => eprintln!("munim-computer-use: could not start the helper: {error}"),
                }
            }
        }
        match received.recv_timeout(Duration::from_secs(2)) {
            Ok(Event::Stop) => break,
            // A sign-in or user switch changes who may use the pipe: start over.
            Ok(Event::SessionChanged) => stop(&mut helper),
            Err(_) => {}
        }
    }
    stop(&mut helper);
    report(ServiceState::Stopped, ServiceControlAccept::empty())
}

/// Start this binary as SYSTEM in `session`: the service's own token, moved
/// into the user's session.
fn spawn_helper(session: u32) -> windows::core::Result<HANDLE> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_SESSIONID | TOKEN_ADJUST_DEFAULT,
            &mut token,
        )?;
        let mut primary = HANDLE::default();
        let duplicated = DuplicateTokenEx(
            token,
            TOKEN_ACCESS_MASK(0x0200_0000), // MAXIMUM_ALLOWED
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        );
        let _ = CloseHandle(token);
        duplicated?;
        let result = (|| {
            SetTokenInformation(
                primary,
                TokenSessionId,
                &session as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            )?;
            let exe = std::env::current_exe().map_err(|_| windows::core::Error::from_thread())?;
            let mut command = wide(&format!("\"{}\" secure-desktop-helper", exe.display()));
            let mut desktop = wide(r"winsta0\default");
            let startup = STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOW>() as u32,
                lpDesktop: PWSTR(desktop.as_mut_ptr()),
                ..Default::default()
            };
            let mut process = PROCESS_INFORMATION::default();
            CreateProcessAsUserW(
                Some(primary),
                PCWSTR::null(),
                Some(PWSTR(command.as_mut_ptr())),
                None,
                None,
                false,
                CREATE_NO_WINDOW,
                None,
                PCWSTR::null(),
                &startup,
                &mut process,
            )?;
            let _ = CloseHandle(process.hThread);
            Ok(process.hProcess)
        })();
        let _ = CloseHandle(primary);
        result
    }
}

// ---------------------------------------------------------------------------
// Helper: SYSTEM in the user's session, serving the pipe

fn run_helper() -> i32 {
    let Some(session) = session_of(unsafe { GetCurrentProcessId() }) else {
        return 1;
    };
    loop {
        // No one signed in yet (the boot-time lock screen): nobody to serve.
        match session_user_sid(session) {
            Some(sid) => {
                if let Err(error) = serve_pipe(session, &sid) {
                    eprintln!("munim-computer-use: secure desktop pipe failed: {error}");
                }
            }
            None => {}
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

fn session_user_sid(session: u32) -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        WTSQueryUserToken(session, &mut token).ok()?;
        let mut buffer = vec![0u8; 256];
        let mut size = 0u32;
        let read = GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut _),
            buffer.len() as u32,
            &mut size,
        );
        let _ = CloseHandle(token);
        read.ok()?;
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
        let sid = text.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
        sid
    }
}

fn serve_pipe(session: u32, user_sid: &str) -> Result<(), String> {
    // SYSTEM and the session's user only; never other users or the network.
    let sddl = wide(&format!("D:P(A;;GA;;;SY)(A;;GRGW;;;{user_sid})"));
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(|error| format!("pipe security: {error}"))?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let name = wide(&pipe_name(session));
    loop {
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                Some(&attributes),
            )
        };
        if pipe.is_invalid() {
            return Err(format!("could not create the pipe: {}", windows::core::Error::from_thread()));
        }
        let connected = match unsafe { ConnectNamedPipe(pipe, None) } {
            Ok(()) => true,
            Err(error) => error.code() == ERROR_PIPE_CONNECTED.to_hresult(),
        };
        if !connected || !client_allowed(pipe, session) {
            unsafe {
                let _ = DisconnectNamedPipe(pipe);
                let _ = CloseHandle(pipe);
            }
            continue;
        }
        let stream = unsafe { File::from_raw_handle(pipe.0) };
        std::thread::spawn(move || serve_client(stream));
    }
}

/// Only a munim-computer-use process in this session. The ACL already admits
/// only the session's user; this keeps other programs of theirs off it.
fn client_allowed(pipe: HANDLE, session: u32) -> bool {
    let mut pid = 0u32;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) }.is_err() || session_of(pid) != Some(session) {
        return false;
    }
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return false;
    };
    let mut buffer = [0u16; 1024];
    let mut length = buffer.len() as u32;
    let named = unsafe {
        QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length)
    }
    .is_ok();
    unsafe {
        let _ = CloseHandle(process);
    }
    named
        && Path::new(&String::from_utf16_lossy(&buffer[..length as usize]))
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(BINARY_NAME))
}

/// Puts the calling thread on whichever desktop has input. A thread with no
/// windows or hooks may switch desktops at any time.
#[derive(Default)]
struct InputDesktop(Option<HDESK>);

impl InputDesktop {
    fn follow(&mut self) {
        const GENERIC_ALL: u32 = 0x1000_0000;
        let Ok(desktop) = (unsafe {
            OpenInputDesktop(
                DESKTOP_CONTROL_FLAGS(0),
                false,
                windows::Win32::System::StationsAndDesktops::DESKTOP_ACCESS_FLAGS(GENERIC_ALL),
            )
        }) else {
            return;
        };
        if unsafe { SetThreadDesktop(desktop) }.is_ok() {
            if let Some(previous) = self.0.replace(desktop) {
                unsafe {
                    let _ = CloseDesktop(previous);
                }
            }
        } else {
            unsafe {
                let _ = CloseDesktop(desktop);
            }
        }
    }
}

fn serve_client(stream: File) {
    let Ok(reading) = stream.try_clone() else { return };
    let mut writer = stream;
    let mut desktop = InputDesktop::default();
    for line in BufReader::new(reading).lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let Some(id) = request.get("id").cloned() else { continue };
        let params = request.get("params").cloned().unwrap_or(json!({}));
        let result = match request.get("method").and_then(Value::as_str) {
            Some("tools/call") => {
                desktop.follow();
                helper_tool(&params)
            }
            Some("ping") => json!({}),
            other => text_result(format!("error: unsupported method {other:?}"), true),
        };
        let response = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        if writeln!(writer, "{response}").is_err() || writer.flush().is_err() {
            break;
        }
    }
}

fn helper_tool(params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let point = |x: &str, y: &str| match (arg_f64(&args, x), arg_f64(&args, y)) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => Err(crate::platform::DesktopError::new(format!("provide {x} and {y}"))),
    };
    let done = match name {
        "screenshot" => {
            return crate::display_screenshot(&args)
                .unwrap_or_else(|| text_result("error: the secure desktop is captured by display", true));
        }
        "list_displays" => crate::capture::list_displays(),
        "hover" => point("x", "y").and_then(|(x, y)| raw::hover(x, y)),
        "click" => point("x", "y").and_then(|(x, y)| {
            raw::click(x, y, arg_i64(&args, "click_count").unwrap_or(1).clamp(1, 3) as u32, false)
        }),
        "right_click" => point("x", "y").and_then(|(x, y)| raw::click(x, y, 1, true)),
        "drag" => point("from_x", "from_y").and_then(|from| point("to_x", "to_y").and_then(|to| raw::drag(from, to))),
        "scroll" => ScrollDirection::parse(arg_str(&args, "direction").unwrap_or("down")).and_then(|direction| {
            let amount = arg_i64(&args, "amount").unwrap_or(5).clamp(1, 100) as i32;
            raw::scroll(point("x", "y").ok(), direction, amount)
        }),
        "press_key" => {
            let modifiers: Vec<String> = args
                .get("modifiers")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            match arg_str(&args, "key") {
                Some(key) => raw::press_key(key, &modifiers),
                None => Err(crate::platform::DesktopError::new("missing required argument 'key'")),
            }
        }
        "type_text" => match arg_str(&args, "text") {
            Some(text) => raw::type_text(text),
            None => Err(crate::platform::DesktopError::new("missing required argument 'text'")),
        },
        other => Err(crate::platform::DesktopError::new(format!("'{other}' is not available on the secure desktop"))),
    };
    match done {
        Ok(text) => text_result(format!("{text} (secure desktop)"), false),
        Err(error) => text_result(format!("error: {error}"), true),
    }
}

// ---------------------------------------------------------------------------
// Client side: a remote-control server routing to the helper

thread_local! {
    static PIPE: RefCell<Option<(BufReader<File>, File)>> = const { RefCell::new(None) };
    static ON_SECURE: Cell<bool> = const { Cell::new(false) };
    static NEXT_ID: Cell<u64> = const { Cell::new(1) };
}

/// Whether this process can open the desktop that has input. It cannot while
/// Winlogon (a UAC or lock-screen prompt) has it.
fn input_desktop_accessible() -> bool {
    match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) } {
        Ok(desktop) => {
            unsafe {
                let _ = CloseDesktop(desktop);
            }
            true
        }
        Err(_) => false,
    }
}

/// For a remote-control server's `tools/call`: the helper's answer while the
/// secure desktop has input, None to handle the call here. Live frame numbers
/// restart when the source changes, so the first call after a switch drops
/// `after` and gets a full frame.
pub fn route(params: &mut Value) -> Option<Value> {
    let name = params.get("name").and_then(Value::as_str)?;
    if !ROUTED_TOOLS.contains(&name) {
        return None;
    }
    let secure = !input_desktop_accessible();
    if ON_SECURE.replace(secure) != secure
        && let Some(arguments) = params.get_mut("arguments").and_then(Value::as_object_mut)
    {
        arguments.remove("after");
    }
    if !secure {
        PIPE.with_borrow_mut(|pipe| *pipe = None);
        return None;
    }
    Some(call_helper(params).unwrap_or_else(|error| match error {
        HelperError::Unavailable => text_result(format!("error: {NOT_INSTALLED}"), true),
        HelperError::Broken(error) => text_result(format!("error: the secure desktop helper failed: {error}"), true),
    }))
}

enum HelperError {
    Unavailable,
    Broken(String),
}

fn call_helper(params: &Value) -> Result<Value, HelperError> {
    // One reconnect: the helper restarts when the user signs in or switches.
    for attempt in 0..2 {
        let connected = PIPE.with_borrow_mut(|pipe| {
            if pipe.is_none() {
                let session = session_of(unsafe { GetCurrentProcessId() }).ok_or(HelperError::Unavailable)?;
                let stream = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(pipe_name(session))
                    .map_err(|_| HelperError::Unavailable)?;
                let reader = stream.try_clone().map_err(|error| HelperError::Broken(error.to_string()))?;
                *pipe = Some((BufReader::new(reader), stream));
            }
            Ok(())
        });
        connected?;
        let id = NEXT_ID.replace(NEXT_ID.get() + 1);
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params });
        let answer = PIPE.with_borrow_mut(|pipe| -> Result<Value, String> {
            let (reader, writer) = pipe.as_mut().ok_or("not connected")?;
            writeln!(writer, "{request}").and_then(|()| writer.flush()).map_err(|error| error.to_string())?;
            let mut line = String::new();
            if reader.read_line(&mut line).map_err(|error| error.to_string())? == 0 {
                return Err("the helper closed the connection".into());
            }
            let response: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
            response.get("result").cloned().ok_or_else(|| "the helper sent no result".into())
        });
        match answer {
            Ok(result) => return Ok(result),
            Err(error) => {
                PIPE.with_borrow_mut(|pipe| *pipe = None);
                if attempt == 1 {
                    return Err(HelperError::Broken(error));
                }
            }
        }
    }
    Err(HelperError::Unavailable)
}
