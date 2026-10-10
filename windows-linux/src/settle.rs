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
//! Some apps never go quiet: a ticking clock, a progress spinner or a playing
//! video raise events all the time. Each event carries the element and kind
//! that raised it, and a source that was already firing before the action is
//! background, not the app reacting, so its events are left out of the count.
//!
//! Windows counts WinEvents for the app's process on a dedicated hook thread,
//! hooked from `get_app_state` on, so the time before an action shows which
//! sources are background. Elsewhere, or when the hook cannot be installed,
//! the old fixed pause stands.

// Only Windows has an event source; elsewhere the event bookkeeping is unused.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashSet;
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

/// One event: when, and which element and kind of event raised it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Event {
    pub at: Instant,
    pub source: u64,
}

/// How far back before an action a source must have fired to be background.
pub const BACKGROUND_WINDOW: Duration = Duration::from_millis(1500);

/// A background source fired in at least this many separate slices of the
/// window: a ticker or spinner does, while the bursts of a few earlier actions
/// on the same control do not.
const BACKGROUND_SLICES: usize = 5;
const SLICE: Duration = Duration::from_millis(100);

/// Sources that kept firing through the `window` before `action`: they change
/// on their own, so their events after it say nothing about the action.
pub fn background(events: &[Event], action: Instant, window: Duration) -> HashSet<u64> {
    let from = action.checked_sub(window).unwrap_or(action);
    let mut slices: std::collections::HashMap<u64, HashSet<u128>> = Default::default();
    for event in events.iter().filter(|e| e.at >= from && e.at <= action) {
        let slice = event.at.duration_since(from).as_millis() / SLICE.as_millis();
        slices.entry(event.source).or_default().insert(slice);
    }
    slices
        .into_iter()
        .filter(|(_, seen)| seen.len() >= BACKGROUND_SLICES)
        .map(|(source, _)| source)
        .collect()
}

/// Events since `action` from sources that are not background. A source that
/// keeps firing through the wait is background too, for an app read too
/// recently to have shown it before the action.
pub fn reactions(events: &[Event], action: Instant, background: &HashSet<u64>) -> u64 {
    let after = || events.iter().filter(|e| e.at > action && !background.contains(&e.source));
    let mut slices: std::collections::HashMap<u64, HashSet<u128>> = Default::default();
    for event in after() {
        let slice = event.at.duration_since(action).as_millis() / SLICE.as_millis();
        slices.entry(event.source).or_default().insert(slice);
    }
    after()
        .filter(|e| slices.get(&e.source).is_none_or(|seen| seen.len() < BACKGROUND_SLICES))
        .count() as u64
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

/// The app's events from the moment an action starts, without background ones.
pub struct Watch {
    action: Instant,
    background: HashSet<u64>,
}

impl Watch {
    fn count(&self) -> u64 {
        #[cfg(windows)]
        {
            winevents::with_events(|events| reactions(events, self.action, &self.background))
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
        winevents::hook(pid)?;
        let action = Instant::now();
        let background = winevents::with_events(|events| background(events, action, BACKGROUND_WINDOW));
        Some(Watch { action, background })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Start hooking `pid`'s events when its state is read, so by the time an
/// action runs, the events before it show which sources are background.
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn observe(pid: u32) {
    #[cfg(windows)]
    {
        let _ = winevents::hook(pid);
    }
}

/// Wait for the app to finish reacting to the action `watch` was started for.
pub fn settle(watch: Option<Watch>) -> Option<Settled> {
    let Some(watch) = watch else {
        std::thread::sleep(FALLBACK);
        return None;
    };
    // The count starts from the action, so anything the action raised so far
    // already reads as a reaction.
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
    //! out-of-context hooks need. It hooks one process at a time, on request,
    //! and keeps it hooked until another one is asked for.

    use std::collections::VecDeque;
    use std::hash::{Hash, Hasher};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EVENT_MAX, EVENT_MIN, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW,
        PostThreadMessageW, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP,
    };

    use super::Event;

    /// `wParam` carries the pid to hook.
    const WM_WATCH: u32 = WM_APP + 1;

    /// Events older than this are no use to a wait, which looks back
    /// `BACKGROUND_WINDOW` and forward at most its timeout.
    const KEEP: Duration = Duration::from_secs(4);
    const MOST: usize = 8192;

    /// Recent events of the hooked process.
    static EVENTS: Mutex<VecDeque<Event>> = Mutex::new(VecDeque::new());
    /// The hooked process, or 0.
    static HOOKED: AtomicU32 = AtomicU32::new(0);

    struct HookThread {
        thread_id: u32,
        /// One request in flight at a time; the thread answers whether it hooked.
        replies: Mutex<Receiver<bool>>,
    }

    static THREAD: OnceLock<Option<HookThread>> = OnceLock::new();

    fn events() -> std::sync::MutexGuard<'static, VecDeque<Event>> {
        EVENTS.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn with_events<T>(read: impl FnOnce(&[Event]) -> T) -> T {
        let mut events = events();
        read(events.make_contiguous())
    }

    unsafe extern "system" fn on_event(
        _: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        object: i32,
        child: i32,
        _: u32,
        _: u32,
    ) {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        (event, hwnd.0 as usize, object, child).hash(&mut hasher);
        let at = Instant::now();
        let mut events = events();
        while events
            .front()
            .is_some_and(|e| at.duration_since(e.at) > KEEP || events.len() >= MOST)
        {
            events.pop_front();
        }
        events.push_back(Event { at, source: hasher.finish() });
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
                    events().clear();
                    let pid = message.wParam.0 as u32;
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
                    HOOKED.store(if hook.is_some() { pid } else { 0 }, Ordering::SeqCst);
                    let _ = replies.send(hook.is_some());
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

    /// Hook `pid`, unless it already is. `None` when it cannot be hooked.
    pub fn hook(pid: u32) -> Option<()> {
        if pid == 0 {
            return None;
        }
        if HOOKED.load(Ordering::SeqCst) == pid {
            return Some(());
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
            Ok(true) => Some(()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BACKGROUND_WINDOW, Clock, Event, Timing, background, reactions, wait_for_quiet};
    use std::time::{Duration, Instant};

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

    fn at(base: Instant, ms: i64, source: u64) -> Event {
        let offset = Duration::from_millis(ms.unsigned_abs());
        Event {
            at: if ms < 0 { base - offset } else { base + offset },
            source,
        }
    }

    #[test]
    fn a_source_firing_before_the_action_is_background() {
        let action = Instant::now() + Duration::from_secs(5);
        // Source 1 ticks every 50 ms; source 2 fired once; source 3 fired
        // often, but long before the window; source 5 is a button two earlier
        // clicks changed, each with a short burst.
        let mut events: Vec<Event> = (1..=30).map(|i| at(action, -50 * i, 1)).collect();
        events.push(at(action, -200, 2));
        events.extend((0..10).map(|i| at(action, -3000 + 50 * i, 3)));
        events.extend([-1400, -1390, -1370, -700, -690, -660].map(|ms| at(action, ms, 5)));
        events.sort_by_key(|e| e.at);
        let quiet = background(&events, action, BACKGROUND_WINDOW);
        assert_eq!(quiet, [1].into_iter().collect());

        // Right after the action the tick keeps going and the button reacts once.
        events.extend((1..=3).map(|i| at(action, 50 * i, 1)));
        events.push(at(action, 30, 2));
        events.push(at(action, 40, 4));
        assert_eq!(reactions(&events, action, &quiet), 2, "the tick is not counted");
        assert_eq!(reactions(&events, action, &Default::default()), 5, "unless nothing was known before");
    }

    #[test]
    fn a_source_that_keeps_firing_after_the_action_stops_counting() {
        let action = Instant::now();
        // Nothing before the action (the app was only just read); a tick
        // every 50 ms after it, and one real reaction.
        let mut events: Vec<Event> = (1..=6).map(|i| at(action, 50 * i, 1)).collect();
        events.push(at(action, 20, 2));
        let none = Default::default();
        assert_eq!(reactions(&events, action, &none), 7, "four slices: still counted");
        events.extend((7..=12).map(|i| at(action, 50 * i, 1)));
        assert_eq!(reactions(&events, action, &none), 1, "seven slices: only the reaction");
    }
}
