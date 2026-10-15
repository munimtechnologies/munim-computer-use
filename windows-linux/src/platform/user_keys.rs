//! The user's own keystrokes, as a low-level keyboard hook sees them.
//!
//! Keystrokes go to whichever window is in front, so to type into its target
//! the agent puts that window in front for a moment. Two things can go wrong
//! with the user typing elsewhere at the same time, and the hook covers both:
//! the agent's own keys reset the system's idle time, so a pause in the user's
//! typing cannot be read from it; and a key the user presses while the target
//! is in front lands in the target. The hook tells the user's keys from the
//! agent's (the agent marks its own with `AGENT_INPUT`), and while a `Hold` is
//! alive it keeps the user's keys back, replaying them once their window has
//! the foreground again.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetLastInputInfo, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, LASTINPUTINFO, SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, LLKHF_UP, MSG, SetWindowsHookExW,
    WH_KEYBOARD_LL,
};

/// `dwExtraInfo` on every keystroke the agent sends.
pub const AGENT_INPUT: usize = 0x4D55_4E49;

/// How long the user must have been still before the agent types, and how
/// long it waits for that before typing anyway.
const USER_PAUSE_MS: u32 = 300;
const USER_PAUSE_LIMIT: Duration = Duration::from_secs(10);

/// VK_PACKET: a key carrying a Unicode character in its scan code.
const VK_PACKET: u32 = 0xE7;

static HOOKED: OnceLock<bool> = OnceLock::new();
/// Tick of the user's last key event, 0 until the hook has seen one.
static LAST_USER_KEY: AtomicU32 = AtomicU32::new(0);
/// Whether a `Hold` is alive, and the user's keys it has kept back.
static HELD: Mutex<(bool, Vec<KBDLLHOOKSTRUCT>)> = Mutex::new((false, Vec::new()));

/// Install the hook on its own thread, which must pump messages for it, the
/// first time it is needed. False if Windows refused it.
fn hooked() -> bool {
    *HOOKED.get_or_init(|| {
        let (ready, installed) = std::sync::mpsc::channel();
        std::thread::spawn(move || unsafe {
            let module = GetModuleHandleW(None).ok();
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module.map(Into::into), 0);
            let _ = ready.send(hook.is_ok());
            if hook.is_ok() {
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {}
            }
        });
        installed.recv_timeout(Duration::from_secs(2)).unwrap_or(false)
    })
}

unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let key = unsafe { *(lparam.0 as *const KBDLLHOOKSTRUCT) };
        // UI Automation's SetFocus sends UNLOCK_VK too, and waits for it.
        let unlock = key.vkCode == u32::from(super::windows::UNLOCK_VK);
        if key.dwExtraInfo != AGENT_INPUT && !unlock {
            LAST_USER_KEY.store(unsafe { GetTickCount() }.max(1), Ordering::Relaxed);
            let mut held = HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if held.0 {
                held.1.push(key);
                return LRESULT(1);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Wait until the user has stopped typing (no key held, no key of theirs for
/// USER_PAUSE_MS), so a held Shift or Ctrl of theirs cannot change the agent's
/// keys. Before the hook has seen a key, any input counts, as it is all the
/// system can tell.
pub fn wait_for_pause() {
    let hooked = hooked();
    let start = Instant::now();
    while start.elapsed() < USER_PAUSE_LIMIT {
        let now = unsafe { GetTickCount() };
        let last = LAST_USER_KEY.load(Ordering::Relaxed);
        let idle = if hooked && last != 0 {
            now.wrapping_sub(last)
        } else {
            let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
            if unsafe { GetLastInputInfo(&mut info) }.as_bool() { now.wrapping_sub(info.dwTime) } else { u32::MAX }
        };
        // 0x07 and below are mouse buttons and cancel, not keys.
        let key_held = (0x08..=0xFE).any(|vk| unsafe { GetAsyncKeyState(vk) } < 0);
        if idle >= USER_PAUSE_MS && !key_held {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Keeps the user's keystrokes back while alive and replays them, in order,
/// when dropped.
pub struct Hold(());

/// Start holding the user's keys. None if the hook is not available.
pub fn hold() -> Option<Hold> {
    if !hooked() {
        return None;
    }
    HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).0 = true;
    Some(Hold(()))
}

impl Drop for Hold {
    fn drop(&mut self) {
        let keys: Vec<KBDLLHOOKSTRUCT> = {
            let mut held = HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            held.0 = false;
            held.1.drain(..).collect()
        };
        // Outside the lock, which the hook takes for each replayed key, and one
        // key at a time: replaying them under the lock or in one batch put
        // some out of order in the user's window.
        for key in &keys {
            unsafe { SendInput(&[replay(key)], std::mem::size_of::<INPUT>() as i32) };
        }
    }
}

/// The input that repeats a hooked key event. It keeps the original
/// `dwExtraInfo`, so it is still the user's key if a new hold catches it.
fn replay(key: &KBDLLHOOKSTRUCT) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if key.flags.0 & LLKHF_UP.0 != 0 {
        flags |= KEYEVENTF_KEYUP;
    }
    if key.flags.0 & LLKHF_EXTENDED.0 != 0 {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let vk = if key.vkCode == VK_PACKET {
        flags |= KEYEVENTF_UNICODE;
        0
    } else {
        key.vkCode as u16
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: key.scanCode as u16,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: key.dwExtraInfo,
            },
        },
    }
}
