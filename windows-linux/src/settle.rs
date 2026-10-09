//! Waiting for an app to finish reacting to an action before `return_state`
//! reads it again.
//!
//! A fixed pause is either too short (the app is still redrawing, so the read
//! shows the old UI) or too long (the app was done in 30 ms). Instead, count
//! the accessibility events the app raises: once the count moves, the app is
//! reacting, and once it holds still for a moment the app is done. When it
//! never moves, the action had no visible effect and the wait ends early. This
//! is the algorithm arc-cua uses (`settling.py`).
//!
//! Windows counts WinEvents for the app's process on a dedicated hook thread.
//! Elsewhere, or when the hook cannot be installed, the old fixed pause stands.

use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// Give up this soon when nothing changes at all.
    pub reaction: Duration,
    /// After a change, done once nothing more changed for this long.
    pub quiet: Duration,
    /// Never wait longer.
    pub timeout: Duration,
    pub poll: Duration,
}

pub const TIMING: Timing = Timing {
    reaction: Duration::from_millis(600),
    quiet: Duration::from_millis(150),
    timeout: Duration::from_secs(2),
    poll: Duration::from_millis(20),
};

/// The pause used when no event source is available.
pub const FALLBACK: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settled {
    /// The count moved after the action.
    pub reacted: bool,
    /// Still changing when the timeout ended the wait.
    pub timed_out: bool,
    pub elapsed: Duration,
}

/// Time as the wait sees it, so tests can run it on a fake clock.
pub trait Clock {
    fn elapsed(&mut self) -> Duration;
    fn sleep(&mut self, duration: Duration);
}

struct RealClock(Instant);

impl Clock for RealClock {
    fn elapsed(&mut self) -> Duration {
        self.0.elapsed()
    }
    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// Poll `probe` until the app reacted and went quiet, or did not react in time.
/// `before` is the probe read before the action.
pub fn wait_for_quiet(
    probe: &mut dyn FnMut() -> u64,
    before: u64,
    timing: &Timing,
    clock: &mut dyn Clock,
) -> Settled {
    let started = clock.elapsed();
    let mut previous = before;
    let mut changed = false;
    let mut quiet_since = started;
    loop {
        clock.sleep(timing.poll);
        let current = probe();
        let now = clock.elapsed();
        if current != previous {
            changed = true;
            quiet_since = now;
            previous = current;
        }
        let elapsed = now.saturating_sub(started);
        if changed && now.saturating_sub(quiet_since) >= timing.quiet {
            return Settled {
                reacted: true,
                timed_out: false,
                elapsed,
            };
        }
        if !changed && elapsed >= timing.reaction {
            return Settled {
                reacted: false,
                timed_out: false,
                elapsed,
            };
        }
        if elapsed >= timing.timeout {
            return Settled {
                reacted: changed,
                timed_out: true,
                elapsed,
            };
        }
    }
}

/// Events counted for one app while an action runs. Dropping it stops counting.
pub struct Watch {
    #[cfg(windows)]
    inner: winevents::Watch,
}

impl Watch {
    fn count(&self) -> u64 {
        #[cfg(windows)]
        {
            self.inner.count()
        }
        #[cfg(not(windows))]
        {
            0
        }
    }
}

/// Start counting the app's events. Call before the action, so the count it
/// starts from predates anything the action causes. `None` means there is no
/// event source here, and `settle` falls back to the fixed pause.
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn watch(pid: u32) -> Option<Watch> {
    #[cfg(windows)]
    {
        winevents::watch(pid).map(|inner| Watch { inner })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Wait for the app to finish reacting to the action `watch` was started for.
pub fn settle(watch: Option<Watch>) -> Option<Settled> {
    let Some(watch) = watch else {
        std::thread::sleep(FALLBACK);
        return None;
    };
    // The count started at zero when the watch began, just before the action,
    // so anything the action raised so far already reads as a reaction.
    let mut probe = || watch.count();
    Some(wait_for_quiet(
        &mut probe,
        0,
        &TIMING,
        &mut RealClock(Instant::now()),
    ))
}

#[cfg(windows)]
mod winevents {
    //! One background thread owns a WinEvent hook and the message loop that
    //! out-of-context hooks need. It hooks one process at a time, on request.

    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EVENT_MAX, EVENT_MIN, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW,
        PostThreadMessageW, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP,
    };

    /// `wParam` carries the pid to hook, or 0 to unhook.
    const WM_WATCH: u32 = WM_APP + 1;

    /// Events seen for the hooked process since it was hooked.
    static COUNT: AtomicU64 = AtomicU64::new(0);

    struct HookThread {
        thread_id: u32,
        /// One request in flight at a time; the thread answers whether it hooked.
        replies: Mutex<Receiver<bool>>,
    }

    static THREAD: OnceLock<Option<HookThread>> = OnceLock::new();

    unsafe extern "system" fn on_event(
        _: HWINEVENTHOOK,
        _: u32,
        _: HWND,
        _: i32,
        _: i32,
        _: u32,
        _: u32,
    ) {
        COUNT.fetch_add(1, Ordering::Relaxed);
    }

    fn run(ready: SyncSender<u32>, replies: SyncSender<bool>) {
        unsafe {
            // A thread has no message queue until it asks for one; post
            // requests would fail before this.
            let mut message = MSG::default();
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            if ready.send(GetCurrentThreadId()).is_err() {
                return;
            }
            let mut hook: Option<HWINEVENTHOOK> = None;
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                if message.hwnd.0.is_null() && message.message == WM_WATCH {
                    if let Some(old) = hook.take() {
                        let _ = UnhookWinEvent(old);
                    }
                    let pid = message.wParam.0 as u32;
                    if pid != 0 {
                        COUNT.store(0, Ordering::SeqCst);
                        let handle = SetWinEventHook(
                            EVENT_MIN,
                            EVENT_MAX,
                            None,
                            Some(on_event),
                            pid,
                            0,
                            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                        );
                        hook = (!handle.is_invalid()).then_some(handle);
                        let _ = replies.send(hook.is_some());
                    }
                    continue;
                }
                // Out-of-context WinEvents arrive through this dispatch.
                DispatchMessageW(&message);
            }
        }
    }

    fn thread() -> Option<&'static HookThread> {
        THREAD
            .get_or_init(|| {
                let (ready_tx, ready_rx) = sync_channel(1);
                let (reply_tx, reply_rx) = sync_channel(1);
                std::thread::Builder::new()
                    .name("winevent-settle".into())
                    .spawn(move || run(ready_tx, reply_tx))
                    .ok()?;
                let thread_id = ready_rx.recv_timeout(Duration::from_secs(1)).ok()?;
                Some(HookThread {
                    thread_id,
                    replies: Mutex::new(reply_rx),
                })
            })
            .as_ref()
    }

    pub struct Watch {
        thread_id: u32,
    }

    impl Watch {
        pub fn count(&self) -> u64 {
            COUNT.load(Ordering::SeqCst)
        }
    }

    impl Drop for Watch {
        fn drop(&mut self) {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, WM_WATCH, WPARAM(0), LPARAM(0));
            }
        }
    }

    pub fn watch(pid: u32) -> Option<Watch> {
        if pid == 0 {
            return None;
        }
        let thread = thread()?;
        let replies = thread
            .replies
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        // Drop any answer a timed-out request left behind.
        while replies.try_recv().is_ok() {}
        unsafe { PostThreadMessageW(thread.thread_id, WM_WATCH, WPARAM(pid as usize), LPARAM(0)) }
            .ok()?;
        match replies.recv_timeout(Duration::from_millis(250)) {
            Ok(true) => Some(Watch {
                thread_id: thread.thread_id,
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Clock, Timing, wait_for_quiet};
    use std::time::Duration;

    /// Time only moves when the wait sleeps.
    struct FakeClock(Duration);

    impl Clock for FakeClock {
        fn elapsed(&mut self) -> Duration {
            self.0
        }
        fn sleep(&mut self, duration: Duration) {
            self.0 += duration;
        }
    }

    const TIMING: Timing = super::TIMING;

    /// A probe whose count follows `at(ms)` on the fake clock.
    fn run(at: impl Fn(u64) -> u64) -> super::Settled {
        let clock = std::rc::Rc::new(std::cell::Cell::new(Duration::ZERO));
        struct Shared(std::rc::Rc<std::cell::Cell<Duration>>);
        impl Clock for Shared {
            fn elapsed(&mut self) -> Duration {
                self.0.get()
            }
            fn sleep(&mut self, duration: Duration) {
                self.0.set(self.0.get() + duration);
            }
        }
        let reader = clock.clone();
        let mut probe = move || at(reader.get().as_millis() as u64);
        wait_for_quiet(&mut probe, 0, &TIMING, &mut Shared(clock))
    }

    #[test]
    fn nothing_happening_ends_after_the_reaction_window() {
        let settled = run(|_| 0);
        assert!(!settled.reacted && !settled.timed_out);
        assert_eq!(settled.elapsed, Duration::from_millis(600));
    }

    #[test]
    fn a_burst_ends_once_quiet_for_150_ms() {
        // Events at 40, 60 and 100 ms, then silence.
        let settled = run(|ms| match ms {
            0..40 => 0,
            40..60 => 3,
            60..100 => 5,
            _ => 9,
        });
        assert!(settled.reacted && !settled.timed_out);
        assert_eq!(
            settled.elapsed,
            Duration::from_millis(100 + 160),
            "quiet is measured from the last change"
        );
    }

    #[test]
    fn a_late_reaction_inside_the_window_still_counts() {
        let settled = run(|ms| if ms >= 500 { 1 } else { 0 });
        assert!(settled.reacted);
        assert_eq!(settled.elapsed, Duration::from_millis(660));
    }

    #[test]
    fn an_app_that_never_goes_quiet_is_cut_off_at_two_seconds() {
        let settled = run(|ms| ms / 20);
        assert!(settled.reacted && settled.timed_out);
        assert_eq!(settled.elapsed, Duration::from_secs(2));
    }

    #[test]
    fn events_before_the_first_poll_count_as_a_reaction() {
        // The action itself raised events before the wait began.
        let mut clock = FakeClock(Duration::ZERO);
        let mut probe = || 4;
        let settled = wait_for_quiet(&mut probe, 0, &TIMING, &mut clock);
        assert!(settled.reacted);
        assert_eq!(
            settled.elapsed,
            Duration::from_millis(180),
            "first seen at the 20 ms poll"
        );
    }
}
