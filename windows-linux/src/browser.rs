//! Agent-owned Chrome tabs, via the MT Code Chrome extension.
//!
//! A tab becomes the agent's either by being opened (`open_tab`) or by being
//! adopted from the user on request (`use_tab`). Adopted tabs are released, not
//! closed, on cleanup — the extension tracks the difference.
//!
//! Chrome owns the lifetime of a native messaging host: it spawns the host when
//! the extension connects and speaks 4-byte-length-prefixed JSON over that
//! process's stdio. The MCP server is a different process with its own
//! lifetime, so the two are joined by a local socket:
//!
//! ```text
//!   Chrome ──stdio(length-prefixed)──▶ `munim-computer-use native-host`
//!                                          │ local socket
//!                                          ▼
//!                                    MCP server (this process)
//! ```
//!
//! This mirrors the macOS Swift bridge exactly, including the wire messages, so
//! one extension build serves all three platforms. The first live server binds
//! the socket and owns the extension; later servers share it through the
//! owner's `.rpc` endpoint, each with its own client id and tabs.

use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::path::PathBuf;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use interprocess::local_socket::{ListenerOptions, SendHalf, Stream};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
// Imported anonymously: the traits share their names with the enums above.
use interprocess::local_socket::traits::{Listener as _, Stream as _};
use serde_json::{Value, json};

/// Timeout for extension replies; a stuck call must not wedge a turn.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

fn new_browser_client_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("mcp-{nanos}-{}", std::process::id())
}

/// User-private filesystem socket (Unix) or user-scoped named pipe (Windows).
/// Abstract / global names are intentionally avoided — they have no ownership.
#[cfg(unix)]
fn bridge_socket_path() -> Option<PathBuf> {
    // The directory comes from the identity (`name` / `bridgeSocket`), so an app
    // embedding this server gets its own bridge. Fail closed below if the
    // directory cannot be claimed as private.
    let (dir, file) = crate::identity::get().bridge_socket_path();

    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    // `create_dir_all` / `metadata` / `set_permissions` follow symlinks. A
    // pre-planted `/tmp/munim-computer-use-{uid}` → victim-dir symlink would let us
    // chmod someone else's directory and drop `bridge.sock` there. Reject
    // symlinks via `symlink_metadata` before and after create.
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            eprintln!("munim-computer-use: bridge dir is a symlink; refusing");
            return None;
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Err(error) = std::fs::create_dir_all(&dir) {
                eprintln!("munim-computer-use: bridge dir create failed: {error}");
                return None;
            }
        }
        Err(error) => {
            eprintln!("munim-computer-use: bridge dir metadata failed: {error}");
            return None;
        }
    }

    let metadata = match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            eprintln!("munim-computer-use: bridge dir became a symlink; refusing");
            return None;
        }
        Ok(metadata) => metadata,
        Err(error) => {
            eprintln!("munim-computer-use: bridge dir metadata failed: {error}");
            return None;
        }
    };
    if !metadata.is_dir() {
        eprintln!("munim-computer-use: bridge path is not a directory");
        return None;
    }
    if metadata.uid() != unsafe { libc::getuid() } {
        eprintln!("munim-computer-use: bridge dir not owned by current user");
        return None;
    }
    if let Err(error) = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)) {
        eprintln!("munim-computer-use: bridge dir chmod failed: {error}");
        return None;
    }
    // Re-check mode after chmod — refuse a sticky/world-writable directory.
    let mode = match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            eprintln!("munim-computer-use: bridge dir became a symlink after chmod; refusing");
            return None;
        }
        Ok(metadata) => metadata.mode() & 0o777,
        Err(error) => {
            eprintln!("munim-computer-use: bridge dir re-stat failed: {error}");
            return None;
        }
    };
    if mode != 0o700 {
        eprintln!("munim-computer-use: bridge dir mode {mode:o} is not 0700");
        return None;
    }
    Some(dir.join(file))
}

#[cfg(windows)]
fn bridge_pipe_name() -> String {
    // Named-pipe namespace is global; the identity embeds the username so
    // sessions do not collide, and its name so embedders do not either.
    crate::identity::get().bridge_pipe_name()
}

type Waiter = SyncSender<Result<Value, String>>;

/// State shared by the MCP thread and the bridge threads. A process is either
/// the owner (it holds the native host connection and serves peers over RPC)
/// or a peer (it forwards every call to the owner); it can switch from peer to
/// owner when the previous owner exits.
struct Hub {
    /// Owner: writer to the native host, once the extension connects.
    extension: Mutex<Option<SendHalf>>,
    /// Owner: calls waiting for an extension reply, keyed by wire id. Peer
    /// calls go through here too, re-numbered, so ids never collide.
    pending: Mutex<HashMap<u64, Waiter>>,
    /// Peer: writer to the owner's RPC endpoint.
    rpc: Mutex<Option<SendHalf>>,
    rpc_pending: Mutex<HashMap<u64, Waiter>>,
    next_id: AtomicU64,
}

impl Hub {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            extension: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            rpc: Mutex::new(None),
            rpc_pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        })
    }

    fn connected(&self) -> bool {
        self.rpc.lock().is_ok_and(|guard| guard.is_some())
            || self.extension.lock().is_ok_and(|guard| guard.is_some())
    }

    fn call(&self, command: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if self.rpc.lock().is_ok_and(|guard| guard.is_some()) {
            // The owner applies its own timeout first; wait a little longer so
            // its error, which says what actually went wrong, reaches us.
            return self.send(&self.rpc, &self.rpc_pending, command, params, timeout + Duration::from_secs(5),
                "disconnected from the desktop browser bridge");
        }
        self.direct_call(command, params, timeout)
    }

    fn direct_call(&self, command: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.send(&self.extension, &self.pending, command, params, timeout, "the extension disconnected")
    }

    /// Write one request to `writer` and wait for the reply routed to its id.
    /// Readers clear the writer before failing `pending`, so a request either
    /// sees no writer or is failed by the drain; it is never stranded.
    fn send(
        &self,
        writer: &Mutex<Option<SendHalf>>,
        pending: &Mutex<HashMap<u64, Waiter>>,
        command: &str,
        params: Value,
        timeout: Duration,
        gone: &str,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (waiter, reply) = sync_channel(1);
        lock(pending).insert(id, waiter);
        let request = json!({ "id": id, "command": command, "params": params });
        let written = {
            let mut guard = lock(writer);
            match guard.as_mut() {
                None => Err(gone.to_string()),
                Some(stream) => writeln!(stream, "{request}")
                    .and_then(|()| stream.flush())
                    .map_err(|error| format!("could not reach the extension: {error}")),
            }
        };
        if let Err(error) = written {
            lock(pending).remove(&id);
            return Err(error);
        }
        match reply.recv_timeout(timeout) {
            Ok(outcome) => outcome,
            Err(_) => {
                lock(pending).remove(&id);
                Err(format!("browser_{command} timed out waiting for the extension"))
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Hand a reply line to the call waiting on its id.
fn route(pending: &Mutex<HashMap<u64, Waiter>>, line: &str) {
    let Ok(reply) = serde_json::from_str::<Value>(line) else { return };
    let Some(id) = reply.get("id").and_then(Value::as_u64) else { return };
    let Some(waiter) = lock(pending).remove(&id) else { return };
    let outcome = if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply.get("result").cloned().unwrap_or(json!({})))
    } else {
        Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the extension reported an error")
            .to_string())
    };
    let _ = waiter.send(outcome);
}

/// Clear a dropped connection's writer, then fail everything still waiting on it.
fn drop_connection(writer: &Mutex<Option<SendHalf>>, pending: &Mutex<HashMap<u64, Waiter>>, message: &str) {
    *lock(writer) = None;
    let stranded: Vec<Waiter> = lock(pending).drain().map(|(_, waiter)| waiter).collect();
    for waiter in stranded {
        let _ = waiter.send(Err(message.to_string()));
    }
}

pub struct BrowserBridge {
    hub: Arc<Hub>,
    /// Stable id for this MCP process — the Chrome extension keys tab ownership
    /// by client so one process's exit cleanup cannot close another's tabs.
    client_id: String,
}

impl BrowserBridge {
    pub fn new() -> Self {
        let hub = Hub::new();
        let background = Arc::clone(&hub);
        std::thread::spawn(move || run_bridge(&background));
        Self { hub, client_id: new_browser_client_id() }
    }

    /// No listener — used when browser control is disabled so this process does
    /// not claim the single per-user bridge socket/pipe.
    pub fn inert() -> Self {
        Self { hub: Hub::new(), client_id: new_browser_client_id() }
    }

    pub fn is_connected(&self) -> bool {
        self.connected()
    }

    fn connected(&self) -> bool {
        self.hub.connected()
    }

    /// Dispatch a `browser_*` call. `command` has the `browser_` prefix stripped.
    pub fn call(&mut self, command: &str, args: &Value) -> Result<String, String> {
        if let Some(session) = args.get("session_id") {
            if !session.as_str().is_some_and(|id| !id.trim().is_empty() && id.encode_utf16().count() <= 128) {
                return Err("session_id must be a nonblank string of at most 128 characters".into());
            }
        }
        if !self.connected() {
            return Err(format!(
                "browser_{command} needs the MT Desktop MCP Chrome extension, which is not connected. \
                 Install it from chrome-extension, or use the desktop tools instead: \
                 get_app_state on the browser window, then click"
            ));
        }

        let command = if command == "press_key" { "press" } else { command };
        let params = self.params_for(command, args)?;
        let result = self.dispatch(command, params)?;
        Ok(describe(command, &result, args))
    }

    /// Build extension params, resolving 1-based `index` to an owned `tabId`
    /// for select_tab / close_tab when `tab_id` was omitted.
    fn params_for(&mut self, command: &str, args: &Value) -> Result<Value, String> {
        let mut params = normalise(command, args);
        if matches!(command, "select_tab" | "close_tab") {
            let needs_tab = params
                .get("tabId")
                .and_then(Value::as_i64)
                .is_none();
            if needs_tab {
                if let Some(index) = args.get("index").and_then(Value::as_i64) {
                    let tab_id = self.tab_id_for_index(index, args)?;
                    if let Some(map) = params.as_object_mut() {
                        map.insert("tabId".into(), json!(tab_id));
                        map.remove("index");
                    }
                }
            }
        }
        Ok(params)
    }

    fn tab_id_for_index(&mut self, index: i64, args: &Value) -> Result<i64, String> {
        if index < 1 {
            return Err("index must be a 1-based tab position from browser_list_tabs".into());
        }
        let listed = self.dispatch("list_tabs", normalise("list_tabs", &json!({"session_id": args.get("session_id")})))?;
        let tabs = listed
            .get("tabs")
            .and_then(Value::as_array)
            .ok_or_else(|| "the extension returned no tab list".to_string())?;
        let idx = (index - 1) as usize;
        tabs.get(idx)
            .and_then(|tab| tab.get("tabId").and_then(Value::as_i64))
            .ok_or_else(|| {
                format!(
                    "no agent tab at index {index} — call browser_list_tabs ({} open)",
                    tabs.len()
                )
            })
    }

    fn dispatch(&mut self, command: &str, params: Value) -> Result<Value, String> {
        let mut params = params;
        if let Some(map) = params.as_object_mut() {
            map.entry("clientId".to_string())
                .or_insert_with(|| json!(self.client_id.clone()));
        }
        self.hub.call(command, params, CALL_TIMEOUT)
    }
}

impl Default for BrowserBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether a Unix bridge socket path is owned by a live listener.
#[cfg(unix)]
fn bridge_socket_is_live(path: &std::path::Path) -> Result<bool, ()> {
    use std::os::unix::net::UnixStream;
    if !path.exists() {
        return Ok(false);
    }
    match UnixStream::connect(path) {
        Ok(_) => Ok(true),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.kind() == std::io::ErrorKind::ConnectionRefused =>
        {
            Ok(false)
        }
        Err(error) if error.raw_os_error() == Some(107) =>
        {
            // ECONNREFUSED on platforms that map it oddly.
            Ok(false)
        }
        Err(_) => Err(()),
    }
}

#[cfg(unix)]
fn unlink_stale_bridge_socket(path: &std::path::Path) {
    match bridge_socket_is_live(path) {
        Ok(false) => {
            let _ = std::fs::remove_file(path);
        }
        Ok(true) | Err(()) => {}
    }
}

#[cfg(unix)]
struct BridgeSocketCleanup(std::path::PathBuf);

/// Named pipes vanish with their process; nothing to clean up.
#[cfg(windows)]
struct BridgeSocketCleanup;

#[cfg(unix)]
impl Drop for BridgeSocketCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(unix)]
fn endpoint_name(path: &std::path::Path) -> std::io::Result<interprocess::local_socket::Name<'_>> {
    path.as_os_str().to_fs_name::<GenericFilePath>()
}

/// Bind the bridge the native host connects to. Failing means another live
/// server owns it (a stale Unix socket file is cleared and retried once).
fn bind_bridge() -> Option<(interprocess::local_socket::Listener, Option<BridgeSocketCleanup>)> {
    #[cfg(unix)]
    {
        let path = bridge_socket_path()?;
        // Create-first: never unlink based on a probe that can race another
        // server binding between `bridge_socket_is_live` and `remove_file`.
        let listener = ListenerOptions::new().name(endpoint_name(&path).ok()?).create_sync().ok().or_else(|| {
            unlink_stale_bridge_socket(&path);
            ListenerOptions::new().name(endpoint_name(&path).ok()?).create_sync().ok()
        })?;
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
            eprintln!("munim-computer-use: bridge socket chmod failed: {error}");
            return None;
        }
        Some((listener, Some(BridgeSocketCleanup(path))))
    }
    #[cfg(windows)]
    {
        let name = bridge_pipe_name().to_ns_name::<GenericNamespaced>().ok()?;
        ListenerOptions::new().name(name).create_sync().ok().map(|listener| (listener, None))
    }
}

/// The owner's endpoint for peer MCP processes: the bridge name plus `.rpc`.
#[cfg(unix)]
fn rpc_socket_path() -> Option<PathBuf> {
    let path = bridge_socket_path()?;
    let mut name = path.file_name()?.to_os_string();
    name.push(".rpc");
    Some(path.with_file_name(name))
}

fn bind_rpc() -> Option<(interprocess::local_socket::Listener, Option<BridgeSocketCleanup>)> {
    #[cfg(unix)]
    {
        let path = rpc_socket_path()?;
        // Only the bridge owner reaches this, so any file here is a dead owner's.
        let _ = std::fs::remove_file(&path);
        let listener = ListenerOptions::new().name(endpoint_name(&path).ok()?).create_sync().ok()?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok()?;
        Some((listener, Some(BridgeSocketCleanup(path))))
    }
    #[cfg(windows)]
    {
        let name = format!("{}.rpc", bridge_pipe_name()).to_ns_name::<GenericNamespaced>().ok()?;
        ListenerOptions::new().name(name).create_sync().ok().map(|listener| (listener, None))
    }
}

fn connect_rpc() -> Option<Stream> {
    #[cfg(unix)]
    {
        let path = rpc_socket_path()?;
        Stream::connect(endpoint_name(&path).ok()?).ok()
    }
    #[cfg(windows)]
    {
        let name = format!("{}.rpc", bridge_pipe_name()).to_ns_name::<GenericNamespaced>().ok()?;
        Stream::connect(name).ok()
    }
}

/// Owner election, repeated for the life of the process. The first server to
/// bind the bridge owns the extension and serves later servers over RPC, so
/// every MCP process gets the browser, each with its own tabs. When the owner
/// exits its peers lose the RPC link and run the election again.
fn run_bridge(hub: &Arc<Hub>) {
    loop {
        if let Some((listener, _cleanup)) = bind_bridge() {
            match bind_rpc() {
                Some((rpc_listener, rpc_cleanup)) => {
                    let peers = Arc::clone(hub);
                    std::thread::spawn(move || {
                        let _rpc_cleanup = rpc_cleanup;
                        serve_peers(&peers, &rpc_listener);
                    });
                }
                None => eprintln!("munim-computer-use: could not open the bridge for other MCP servers"),
            }
            serve_extension(hub, &listener);
            return;
        }
        if let Some(stream) = connect_rpc() {
            let (recv, send) = stream.split();
            *lock(&hub.rpc) = Some(send);
            for line in BufReader::new(recv).lines() {
                let Ok(line) = line else { break };
                route(&hub.rpc_pending, &line);
            }
            drop_connection(&hub.rpc, &hub.rpc_pending, "disconnected from the desktop browser bridge");
            // The owner went away. Give another survivor a moment to bind,
            // then take over ourselves if nobody did.
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }
        // An owner is starting up, or one without the peer endpoint (an older
        // build) holds the bridge; accessibility tools still work meanwhile.
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn accept_loop(listener: &interprocess::local_socket::Listener, mut on_stream: impl FnMut(Stream)) {
    let mut accept_failures: u32 = 0;
    loop {
        match listener.accept() {
            Ok(stream) => {
                accept_failures = 0;
                on_stream(stream);
            }
            Err(_) => {
                accept_failures = accept_failures.saturating_add(1);
                if accept_failures >= 8 {
                    // Persistent accept errors (listener torn down) — exit
                    // instead of spinning a CPU core.
                    return;
                }
                std::thread::sleep(Duration::from_millis(50 * u64::from(accept_failures)));
            }
        }
    }
}

/// Accept the native host and route its replies to the waiting calls.
fn serve_extension(hub: &Arc<Hub>, listener: &interprocess::local_socket::Listener) {
    accept_loop(listener, |stream| {
        let (recv, send) = stream.split();
        *lock(&hub.extension) = Some(send);
        for line in BufReader::new(recv).lines() {
            let Ok(line) = line else { break };
            route(&hub.pending, &line);
        }
        // The host went away; clear the writer so `call` reports honestly, and
        // wake any in-flight call instead of letting it sit until CALL_TIMEOUT.
        drop_connection(&hub.extension, &hub.pending, "the extension disconnected");
    });
}

/// Serve each peer MCP process on its own thread: a peer stays connected for
/// its whole life, so serving it inline would strand every later peer.
fn serve_peers(hub: &Arc<Hub>, listener: &interprocess::local_socket::Listener) {
    accept_loop(listener, |stream| {
        let hub = Arc::clone(hub);
        std::thread::spawn(move || serve_peer(&hub, stream));
    });
}

fn serve_peer(hub: &Hub, stream: Stream) {
    let (recv, mut send) = stream.split();
    // Client ids seen on this peer, closed when it disconnects so only that
    // MCP process's tabs go.
    let mut client_ids: HashSet<String> = HashSet::new();
    for line in BufReader::new(recv).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) if request.get("command").and_then(Value::as_str).is_some() => {
                let id = request.get("id").cloned().unwrap_or(json!(-1));
                let command = request.get("command").and_then(Value::as_str).unwrap_or_default();
                let mut params = request.get("params").cloned().filter(Value::is_object).unwrap_or(json!({}));
                let client_id = match params.get("clientId").and_then(Value::as_str) {
                    Some(client_id) if !client_id.is_empty() => client_id.to_string(),
                    // A peer that sends no clientId still gets one stable id.
                    _ => client_ids
                        .iter()
                        .find(|known| known.starts_with("rpc-"))
                        .cloned()
                        .unwrap_or_else(|| format!("rpc-{}", new_browser_client_id())),
                };
                params["clientId"] = json!(client_id);
                client_ids.insert(client_id);
                match hub.direct_call(command, params, CALL_TIMEOUT) {
                    Ok(result) => json!({ "id": id, "ok": true, "result": result }),
                    Err(error) => json!({ "id": id, "ok": false, "error": error }),
                }
            }
            _ => json!({ "id": -1, "ok": false, "error": "invalid RPC request" }),
        };
        if writeln!(send, "{response}").and_then(|()| send.flush()).is_err() {
            break;
        }
    }
    for client_id in client_ids {
        let _ = hub.direct_call("close_client_tabs", json!({ "clientId": client_id }), Duration::from_secs(2));
    }
}

/// Translate tool arguments into the extension's parameter names.
fn normalise(_command: &str, args: &Value) -> Value {
    let mut params = json!({});
    let map = params.as_object_mut().expect("just built an object");
    if let Some(tab) = args.get("tab_id").and_then(Value::as_i64) {
        map.insert("tabId".into(), json!(tab));
    }
    if let Some(session) = args.get("session_id").filter(|v| !v.is_null()) {
        map.insert("sessionId".into(), session.clone());
    }
    for key in ["url", "text", "key", "index", "x", "y", "all"] {
        if let Some(value) = args.get(key) {
            map.insert(key.into(), value.clone());
        }
    }
    // Keep `index` in the wire params for commands that still accept it; select_tab
    // / close_tab resolve index → tabId in `BrowserBridge::params_for` before dispatch.
    params
}

/// Render a reply as the tool text the macOS server produces.
fn describe(command: &str, result: &Value, args: &Value) -> String {
    match command {
        // A freshly opened tab has not loaded yet, so the reply usually carries
        // no title and no url. Echo the requested address instead of rendering
        // an empty pair the model would read as a failed open.
        "open_tab" => {
            let tab = result.get("tabId").and_then(Value::as_i64).unwrap_or(-1);
            let title = result.get("title").and_then(Value::as_str).unwrap_or("");
            let url = result
                .get("url")
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty() && *url != "about:blank")
                .or_else(|| args.get("url").and_then(Value::as_str))
                .unwrap_or("about:blank");
            if title.is_empty() {
                format!("opened {url} in the agent tab group (tab_id={tab})")
            } else {
                format!("opened tab_id={tab} — {title}  [{url}]")
            }
        }
        "list_tabs" => describe_tabs(result),
        "use_tab" => {
            let tab = result
                .get("tabId")
                .and_then(Value::as_i64)
                .or_else(|| args.get("tab_id").and_then(Value::as_i64))
                .unwrap_or(-1);
            if result.get("adopted").and_then(Value::as_bool) != Some(true) {
                return format!("tab {tab} was already the agent's — nothing to take over");
            }
            format!(
                "now driving the user's tab {tab} — {}  [{}]. It stayed where it was; \
                 call browser_release_tab when done, and never browser_close_tab it.",
                result.get("title").and_then(Value::as_str).unwrap_or(""),
                result.get("url").and_then(Value::as_str).unwrap_or("")
            )
        }
        "release_tab" => {
            let tab = result
                .get("released")
                .and_then(Value::as_i64)
                .or_else(|| args.get("tab_id").and_then(Value::as_i64))
                .unwrap_or(-1);
            format!("released tab {tab} back to the user")
        }
        "snapshot" => describe_snapshot(result),
        "close_all_tabs" => {
            let closed = result.get("closed").and_then(Value::as_i64).unwrap_or(0);
            let released = result.get("released").and_then(Value::as_i64).unwrap_or(0);
            let mut parts: Vec<String> = Vec::new();
            if closed > 0 {
                parts.push(format!(
                    "closed {closed} agent tab{} and removed the tab group",
                    if closed == 1 { "" } else { "s" }
                ));
            }
            if released > 0 {
                parts.push(format!(
                    "released {released} of the user's tab{} back to them",
                    if released == 1 { "" } else { "s" }
                ));
            }
            if parts.is_empty() {
                "nothing to clean up — the agent had no tabs open".to_string()
            } else {
                parts.join(", ")
            }
        }
        // The remaining commands have no interesting payload, so the useful
        // confirmation is what was done and where. Worded as the macOS server
        // words it, so a model reads the same feedback on either platform.
        other => {
            let tab = match other {
                "select_tab" => result.get("tabId").and_then(Value::as_i64),
                "close_tab" => result
                    .get("closed")
                    .and_then(Value::as_i64)
                    .or_else(|| result.get("released").and_then(Value::as_i64))
                    .or_else(|| result.get("tabId").and_then(Value::as_i64)),
                _ => None,
            }
            .or_else(|| args.get("tab_id").and_then(Value::as_i64))
            .or_else(|| args.get("index").and_then(Value::as_i64))
            .unwrap_or(-1);
            match other {
                "click" => format!("clicked in tab {tab}"),
                "type" => format!(
                    "typed {} characters into tab {tab}",
                    args.get("text").and_then(Value::as_str).unwrap_or("").chars().count()
                ),
                "press" => format!(
                    "pressed {} in tab {tab}",
                    args.get("key").and_then(Value::as_str).unwrap_or("?")
                ),
                "navigate" => format!(
                    "navigated tab {tab} to {}",
                    args.get("url").and_then(Value::as_str).unwrap_or("")
                ),
                "select_tab" => format!("switched the agent group to tab {tab}"),
                // An adopted tab comes back as a release, so say what happened.
                "close_tab" if result.get("released").is_some() => {
                    format!("tab {tab} was the user's — released it instead of closing")
                }
                "close_tab" => format!("closed tab {tab}"),
                _ => format!("{other} ok"),
            }
        }
    }
}

fn describe_tabs(result: &Value) -> String {
    let tabs = result.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default();
    let every_tab = result.get("scope").and_then(Value::as_str) == Some("all");
    if tabs.is_empty() {
        return if every_tab {
            "Chrome has no tabs open".to_string()
        } else {
            "the agent has no tabs open yet — call browser_open_tab".to_string()
        };
    }
    let count = format!("{} tab{}", tabs.len(), if tabs.len() == 1 { "" } else { "s" });
    let mut lines = vec![if every_tab {
        format!("every Chrome tab ({count}):")
    } else {
        format!("agent tab group ({count}):")
    }];
    for tab in tabs {
        let mut line = format!(
            "{}tab_id={}  {}  [{}]",
            if tab.get("active").and_then(Value::as_bool) == Some(true) {
                "* "
            } else {
                "  "
            },
            tab.get("tabId").and_then(Value::as_i64).unwrap_or(-1),
            tab.get("title").and_then(Value::as_str).unwrap_or(""),
            tab.get("url").and_then(Value::as_str).unwrap_or("")
        );
        // Only the whole-browser view mixes ownership, so only it needs the tag.
        if every_tab {
            let flag = |key: &str| tab.get(key).and_then(Value::as_bool);
            line.push_str(if flag("adopted") == Some(true) {
                "  (agent is driving this — the user's tab)"
            } else if flag("owned") == Some(true) {
                "  (agent's own tab)"
            } else if flag("otherAgent") == Some(true) {
                "  (another agent's tab)"
            } else if flag("attachable") == Some(false) {
                "  (Chrome page — cannot be automated)"
            } else {
                "  (the user's — browser_use_tab to drive it)"
            });
        }
        lines.push(line);
    }
    if every_tab {
        lines.push("* = active in its window".to_string());
    }
    lines.join("\n")
}

fn describe_snapshot(result: &Value) -> String {
    let mut lines = vec![format!(
        "{}  [{}]",
        result.get("title").and_then(Value::as_str).unwrap_or("?"),
        result.get("url").and_then(Value::as_str).unwrap_or("")
    )];
    for element in result
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let label = element.get("label").and_then(Value::as_str).unwrap_or("");
        lines.push(format!(
            "  [{}] {}{}{}",
            element.get("i").and_then(Value::as_i64).unwrap_or(-1),
            element.get("tag").and_then(Value::as_str).unwrap_or("?"),
            if label.is_empty() {
                String::new()
            } else {
                format!(" \"{label}\"")
            },
            if element.get("inView").and_then(Value::as_bool) == Some(false) {
                "  (scrolled out of view)"
            } else {
                ""
            }
        ));
    }
    lines.join("\n")
}

/// Relay mode: Chrome on stdio, the MCP server on the local socket.
///
/// Chrome frames each message with a 4-byte native-endian length; the socket
/// side is newline-delimited JSON, which keeps the server's reader trivial.
pub fn run_native_host() -> std::io::Result<()> {
    #[cfg(unix)]
    let path = bridge_socket_path().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no safe bridge socket path (HOME/XDG_RUNTIME_DIR unset or chmod failed)",
        )
    })?;
    #[cfg(unix)]
    let name = path.as_os_str().to_fs_name::<GenericFilePath>()?;
    #[cfg(windows)]
    let pipe = bridge_pipe_name();
    #[cfg(windows)]
    let name = pipe.to_ns_name::<GenericNamespaced>()?;
    let stream = Stream::connect(name)?;
    let (recv, mut writer) = stream.split();

    // Server → Chrome.
    std::thread::spawn(move || {
        let reader = BufReader::new(recv);
        let mut stdout = std::io::stdout();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let bytes = line.as_bytes();
            if stdout
                .write_all(&(bytes.len() as u32).to_ne_bytes())
                .and_then(|()| stdout.write_all(bytes))
                .and_then(|()| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    });

    // Chrome → server.
    let mut stdin = std::io::stdin().lock();
    loop {
        let mut header = [0u8; 4];
        if std::io::Read::read_exact(&mut stdin, &mut header).is_err() {
            return Ok(());
        }
        let length = u32::from_ne_bytes(header) as usize;
        // Chrome caps messages well below this; a wild length means a desync.
        if length == 0 || length > 64 * 1024 * 1024 {
            return Ok(());
        }
        let mut body = vec![0u8; length];
        if std::io::Read::read_exact(&mut stdin, &mut body).is_err() {
            return Ok(());
        }
        writer.write_all(&body)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::{BrowserBridge, describe, describe_snapshot, describe_tabs, normalise};
    use serde_json::json;

    #[test]
    fn an_unconnected_bridge_points_at_the_working_alternative() {
        let mut bridge = BrowserBridge::inert();
        let error = bridge.call("open_tab", &json!({})).unwrap_err();

        assert!(error.contains("browser_open_tab"), "names the tool: {error}");
        assert!(error.contains("get_app_state"), "offers a path: {error}");
    }

    #[test]
    fn tool_arguments_are_renamed_for_the_extension() {
        // The tools speak snake_case; the extension speaks camelCase.
        let params = normalise("snapshot", &json!({ "tab_id": 7, "text": "hi" }));
        assert_eq!(params["tabId"], json!(7));
        assert_eq!(params["text"], json!("hi"));
        assert!(params.get("tab_id").is_none());
    }

    #[test]
    fn tab_commands_keep_index_in_normalise_for_bridge_resolution() {
        // `normalise` leaves index alone; `params_for` resolves it to tabId via list_tabs.
        let params = normalise("select_tab", &json!({ "index": 2 }));
        assert_eq!(params.get("index"), Some(&json!(2)));
        assert!(params.get("tabId").is_none());
        let params = normalise("close_tab", &json!({ "index": 1 }));
        assert!(params.get("tabId").is_none());
    }

    #[test]
    fn an_empty_tab_list_tells_the_model_what_to_do_next() {
        assert!(describe_tabs(&json!({ "tabs": [] })).contains("browser_open_tab"));
    }

    #[test]
    fn tab_lists_mark_the_active_tab() {
        let rendered = describe_tabs(&json!({
            "tabs": [
                { "tabId": 1, "title": "One", "url": "https://one", "active": false },
                { "tabId": 2, "title": "Two", "url": "https://two", "active": true }
            ]
        }));
        assert!(rendered.contains("  tab_id=1"), "{rendered}");
        assert!(rendered.contains("* tab_id=2"), "{rendered}");
    }

    #[test]
    fn the_whole_browser_view_says_which_tabs_can_be_taken_over() {
        let rendered = describe_tabs(&json!({
            "scope": "all",
            "tabs": [
                { "tabId": 1, "title": "Inbox", "url": "https://mail", "owned": false,
                  "adopted": false, "otherAgent": false, "attachable": true },
                { "tabId": 2, "title": "Docs", "url": "https://docs", "owned": true,
                  "adopted": false, "otherAgent": false, "attachable": true },
                { "tabId": 3, "title": "Checkout", "url": "https://shop", "owned": true,
                  "adopted": true, "otherAgent": false, "attachable": true },
                { "tabId": 4, "title": "Settings", "url": "chrome://settings", "owned": false,
                  "adopted": false, "otherAgent": false, "attachable": false }
            ]
        }));
        assert!(rendered.contains("every Chrome tab (4 tabs)"), "{rendered}");
        assert!(rendered.contains("browser_use_tab to drive it"), "{rendered}");
        assert!(rendered.contains("(agent's own tab)"), "{rendered}");
        assert!(rendered.contains("agent is driving this"), "{rendered}");
        assert!(rendered.contains("cannot be automated"), "{rendered}");
    }

    #[test]
    fn the_agent_only_view_stays_free_of_ownership_tags() {
        let rendered = describe_tabs(&json!({
            "scope": "agent",
            "tabs": [{ "tabId": 1, "title": "One", "url": "https://one", "owned": true, "adopted": false }]
        }));
        assert!(rendered.starts_with("agent tab group"), "{rendered}");
        assert!(!rendered.contains("browser_use_tab"), "{rendered}");
    }

    #[test]
    fn list_all_is_forwarded_to_the_extension() {
        let params = normalise("list_tabs", &json!({ "all": true }));
        assert_eq!(params["all"], json!(true));
    }

    #[test]
    fn taking_over_a_tab_warns_against_closing_it() {
        let rendered = describe(
            "use_tab",
            &json!({ "tabId": 9, "title": "Checkout", "url": "https://shop", "adopted": true }),
            &json!({ "tab_id": 9 }),
        );
        assert!(rendered.contains("now driving the user's tab 9"), "{rendered}");
        assert!(rendered.contains("browser_release_tab"), "{rendered}");
        assert!(rendered.contains("never browser_close_tab"), "{rendered}");
    }

    #[test]
    fn re_taking_an_agent_tab_is_reported_as_a_no_op() {
        let rendered = describe("use_tab", &json!({ "tabId": 9, "adopted": false }), &json!({ "tab_id": 9 }));
        assert!(rendered.contains("already the agent's"), "{rendered}");
    }

    #[test]
    fn closing_a_taken_over_tab_reports_the_release_instead() {
        let rendered = describe("close_tab", &json!({ "released": 4 }), &json!({ "tab_id": 4 }));
        assert!(rendered.contains("released it instead of closing"), "{rendered}");
        // An agent-created tab still reads as a close.
        let rendered = describe("close_tab", &json!({ "closed": 4 }), &json!({ "tab_id": 4 }));
        assert_eq!(rendered, "closed tab 4");
    }

    #[test]
    fn cleanup_separates_closed_agent_tabs_from_returned_user_tabs() {
        let rendered = describe("close_all_tabs", &json!({ "closed": 2, "released": 1 }), &json!({}));
        assert!(rendered.contains("closed 2 agent tabs"), "{rendered}");
        assert!(rendered.contains("released 1 of the user's tab back to them"), "{rendered}");
        // Releasing only must not claim a group was removed.
        let rendered = describe("close_all_tabs", &json!({ "closed": 0, "released": 1 }), &json!({}));
        assert!(!rendered.contains("removed the tab group"), "{rendered}");
    }

    #[test]
    fn snapshots_flag_offscreen_elements() {
        let rendered = describe_snapshot(&json!({
            "title": "Page",
            "url": "https://example",
            "elements": [
                { "i": 0, "tag": "button", "label": "Go", "inView": true },
                { "i": 1, "tag": "a", "label": "Hidden", "inView": false }
            ]
        }));
        assert!(rendered.contains("[0] button \"Go\""), "{rendered}");
        assert!(rendered.contains("(scrolled out of view)"), "{rendered}");
    }

    #[test]
    fn closing_nothing_is_reported_as_nothing() {
        let no_args = json!({});
        assert!(describe("close_all_tabs", &json!({ "closed": 0 }), &no_args).contains("nothing to clean up"));
        assert!(describe("close_all_tabs", &json!({ "closed": 1 }), &no_args).contains("closed 1 agent tab "));
        assert!(describe("close_all_tabs", &json!({ "closed": 3 }), &no_args).contains("closed 3 agent tabs"));
    }

    #[test]
    fn a_freshly_opened_tab_echoes_the_requested_url() {
        // Chrome answers before the tab loads, so title and url come back empty;
        // rendering that verbatim reads like the open failed.
        let rendered = describe(
            "open_tab",
            &json!({ "tabId": 42 }),
            &json!({ "url": "https://example.com" }),
        );
        assert!(rendered.contains("https://example.com"), "{rendered}");
        assert!(rendered.contains("tab_id=42"), "{rendered}");
        assert!(!rendered.contains("[]"), "empty url pair leaked: {rendered}");
    }

    #[test]
    fn action_confirmations_name_the_tab_they_acted_on() {
        // "click ok" tells a model nothing; these mirror the macOS wording.
        let tab = json!({ "tab_id": 9 });
        assert_eq!(describe("click", &json!({}), &tab), "clicked in tab 9");
        assert_eq!(describe("select_tab", &json!({}), &tab), "switched the agent group to tab 9");
        assert_eq!(describe("close_tab", &json!({}), &tab), "closed tab 9");
        assert_eq!(
            describe("press", &json!({}), &json!({ "tab_id": 9, "key": "Enter" })),
            "pressed Enter in tab 9"
        );
        assert_eq!(
            describe("type", &json!({}), &json!({ "tab_id": 9, "text": "hello" })),
            "typed 5 characters into tab 9"
        );
        assert_eq!(
            describe("navigate", &json!({}), &json!({ "tab_id": 9, "url": "https://a.test" })),
            "navigated tab 9 to https://a.test"
        );
    }

    #[test]
    fn a_loaded_tab_reports_its_own_title() {
        let rendered = describe(
            "open_tab",
            &json!({ "tabId": 7, "title": "Example Domain", "url": "https://example.com/" }),
            &json!({}),
        );
        assert!(rendered.contains("Example Domain"), "{rendered}");
    }
}
