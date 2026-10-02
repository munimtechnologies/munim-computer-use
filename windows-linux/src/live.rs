#![cfg_attr(not(windows), allow(dead_code))]
//! Live display capture for MT Code's Computer View.
//!
//! A one-shot screenshot enumerates monitors, copies the whole screen and
//! encodes it, every frame, so a viewer polling it pays that cost even while
//! nothing moves and only learns that nothing moved by comparing bytes. On
//! Windows, Desktop Duplication keeps one duplication of the display open and
//! hands over a new image only when something on it changed, so the viewer
//! waits for the next change instead.
//!
//! Requested as `screenshot { display, live: true, after?, wait_ms? }`.
//! Deliberately not in the tool schema: it serves that viewer, not agents, the
//! same as `cursor: true`. Linux has no live path yet (the Wayland capture
//! portal asks the user every time), so there the caller falls back to an
//! ordinary screenshot.

use crate::capture::{Capture, CaptureFormat};
#[cfg(windows)]
use crate::platform::DesktopError;

pub struct LiveRequest {
    pub display: usize,
    pub max_width: u32,
    pub format: CaptureFormat,
    /// The sequence number of the frame the viewer already has. When set, the
    /// call waits up to `wait_ms` for a newer one.
    pub after: Option<u64>,
    pub wait_ms: u32,
    /// The viewer draws the pointer itself (`cursor: true`), so a pointer that
    /// moved over a still screen ends the wait early.
    pub pointer: bool,
}

pub enum LiveFrame {
    Changed { capture: Capture, seq: u64 },
    /// Nothing new within the wait: the viewer keeps its frame. Also returned
    /// early when only the pointer moved, so the viewer can redraw it.
    Unchanged { seq: u64 },
}

pub enum LiveError {
    /// No live path for this display; the caller takes an ordinary screenshot.
    Unsupported,
    #[cfg_attr(not(windows), allow(dead_code))]
    Failed(String),
}

/// `wait_ms` when the caller gives none, and the most it may ask for.
pub const DEFAULT_WAIT_MS: u32 = 1000;
pub const MAX_WAIT_MS: u32 = 5000;

/// The text line a live result carries, which the viewer parses.
pub fn live_line(seq: u64, changed: bool) -> String {
    format!("live: {{\"seq\":{seq},\"changed\":{changed}}}")
}

pub fn frame(request: &LiveRequest) -> Result<LiveFrame, LiveError> {
    #[cfg(windows)]
    {
        duplication::frame(request)
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        Err(LiveError::Unsupported)
    }
}

#[cfg(windows)]
impl From<DesktopError> for LiveError {
    fn from(error: DesktopError) -> Self {
        LiveError::Failed(error.to_string())
    }
}

#[cfg(windows)]
mod duplication {
    use std::cell::RefCell;
    use std::time::{Duration, Instant};

    use image::RgbaImage;
    use windows::Win32::Foundation::{E_ACCESSDENIED, HMODULE};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
        D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED,
    };
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT,
        DXGI_OUTDUPL_FRAME_INFO, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
        IDXGIResource,
    };
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
    };
    use windows::core::Interface;
    use xcap::Monitor;

    use super::{LiveError, LiveFrame, LiveRequest};
    use crate::capture::{self, Capture, CaptureFormat, CaptureFrame};

    /// A duplication nobody asked for in this long is closed and reopened on
    /// the next request.
    const IDLE_RELEASE: Duration = Duration::from_secs(5);
    /// How long a fresh duplication gets to produce its first image before the
    /// display is seeded with an ordinary capture. A still desktop may produce
    /// nothing until something on it changes.
    const FIRST_IMAGE_WAIT: Duration = Duration::from_millis(250);
    /// After a display turns out to have no live path, how long to stop trying.
    const UNSUPPORTED_RETRY: Duration = Duration::from_secs(10);

    struct Session {
        display: usize,
        frame: CaptureFrame,
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        duplication: IDXGIOutputDuplication,
        staging: Option<(ID3D11Texture2D, u32, u32)>,
    }

    enum Acquired {
        Image,
        Pointer,
        Nothing,
    }

    #[derive(Default)]
    struct State {
        session: Option<Session>,
        last_request: Option<Instant>,
        latest: Option<RgbaImage>,
        /// Never reset, so a frame number from before a reopen is always older.
        seq: u64,
        encoded: Option<(u64, u32, CaptureFormat, Capture)>,
        unsupported: Option<(usize, Instant)>,
    }

    thread_local! {
        // Requests are served one at a time on the stdio thread.
        static STATE: RefCell<State> = RefCell::new(State::default());
    }

    pub fn frame(request: &LiveRequest) -> Result<LiveFrame, LiveError> {
        STATE.with(|state| state.borrow_mut().serve(request))
    }

    impl State {
        fn serve(&mut self, request: &LiveRequest) -> Result<LiveFrame, LiveError> {
            if self
                .unsupported
                .is_some_and(|(display, at)| display == request.display && at.elapsed() < UNSUPPORTED_RETRY)
            {
                return Err(LiveError::Unsupported);
            }
            let idle = self.last_request.is_some_and(|at| at.elapsed() > IDLE_RELEASE);
            self.last_request = Some(Instant::now());
            if idle || self.session.as_ref().is_some_and(|session| session.display != request.display) {
                self.close();
            }
            if self.session.is_none() {
                match Session::open(request.display) {
                    Ok(session) => self.session = Some(session),
                    Err(LiveError::Unsupported) => {
                        self.unsupported = Some((request.display, Instant::now()));
                        return Err(LiveError::Unsupported);
                    }
                    Err(error) => return Err(error),
                }
                if !matches!(self.acquire(FIRST_IMAGE_WAIT)?, Acquired::Image) {
                    self.seed()?;
                }
            }

            let deadline = Instant::now() + Duration::from_millis(u64::from(request.wait_ms));
            let wants_newer =
                |state: &Self| state.latest.is_none() || request.after.is_some_and(|after| state.seq <= after);
            // First pass takes whatever is already pending without waiting, so
            // even a call that does not wait returns the newest image.
            let mut timeout = Duration::ZERO;
            loop {
                let acquired = self.acquire(timeout)?;
                if matches!(acquired, Acquired::Pointer)
                    && request.pointer
                    && request.after.is_some()
                    && self.latest.is_some()
                {
                    break;
                }
                if !wants_newer(self) {
                    break;
                }
                timeout = deadline.saturating_duration_since(Instant::now());
                if timeout.is_zero() {
                    break;
                }
            }

            if request.after.is_some_and(|after| self.seq <= after) {
                return Ok(LiveFrame::Unchanged { seq: self.seq });
            }
            let seq = self.seq;
            if let Some((cached_seq, max_width, format, capture)) = &self.encoded
                && *cached_seq == seq
                && *max_width == request.max_width
                && *format == request.format
            {
                return Ok(LiveFrame::Changed { capture: capture.clone(), seq });
            }
            let (Some(image), Some(session)) = (self.latest.clone(), self.session.as_ref()) else {
                return Err(LiveError::Failed("the live capture has no image yet".into()));
            };
            let capture = capture::finish(image, session.frame, request.max_width, request.format)?;
            self.encoded = Some((seq, request.max_width, request.format, capture.clone()));
            Ok(LiveFrame::Changed { capture, seq })
        }

        fn close(&mut self) {
            self.session = None;
            self.latest = None;
            self.encoded = None;
        }

        /// A still desktop may give a fresh duplication nothing to hand over, so
        /// the first image comes from an ordinary capture instead.
        fn seed(&mut self) -> Result<(), LiveError> {
            let Some(session) = self.session.as_ref() else { return Ok(()) };
            let monitors = Monitor::all().map_err(|error| LiveError::Failed(error.to_string()))?;
            let monitor = monitors
                .get(session.display)
                .ok_or_else(|| LiveError::Failed("the display went away".into()))?;
            let image = monitor
                .capture_image()
                .map_err(|error| LiveError::Failed(format!("failed to capture display: {error}")))?;
            self.latest = Some(image);
            self.seq += 1;
            Ok(())
        }

        fn acquire(&mut self, timeout: Duration) -> Result<Acquired, LiveError> {
            let Some(session) = self.session.as_mut() else { return Ok(Acquired::Nothing) };
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
            let acquired = unsafe { session.duplication.AcquireNextFrame(millis, &mut info, &mut resource) };
            if let Err(error) = acquired {
                if error.code() == DXGI_ERROR_WAIT_TIMEOUT {
                    return Ok(Acquired::Nothing);
                }
                if error.code() == DXGI_ERROR_ACCESS_LOST {
                    // The desktop switched (lock screen, UAC prompt), the mode
                    // changed, or a full-screen app took over: reopen, which
                    // hands over a full image again.
                    let display = session.display;
                    self.session = None;
                    self.session = Some(Session::open(display)?);
                    return Ok(Acquired::Nothing);
                }
                return Err(LiveError::Failed(format!("the live capture failed: {error}")));
            }
            let image = if info.LastPresentTime != 0 {
                resource.map(|resource| session.copy(&resource)).transpose().map(Option::flatten)
            } else {
                Ok(None)
            };
            unsafe {
                let _ = session.duplication.ReleaseFrame();
            }
            match image {
                Ok(Some(image)) => {
                    self.latest = Some(image);
                    self.seq += 1;
                    Ok(Acquired::Image)
                }
                Ok(None) if info.LastMouseUpdateTime != 0 => Ok(Acquired::Pointer),
                Ok(None) => Ok(Acquired::Nothing),
                Err(error) => Err(LiveError::Failed(format!("could not read the live frame: {error}"))),
            }
        }
    }

    impl Session {
        fn open(display: usize) -> Result<Self, LiveError> {
            let monitors = Monitor::all().map_err(|error| LiveError::Failed(error.to_string()))?;
            let monitor = monitors.get(display).ok_or_else(|| {
                LiveError::Failed(format!(
                    "display {display} does not exist — call list_displays ({} attached)",
                    monitors.len()
                ))
            })?;
            // The same geometry an ordinary screenshot reports, so both map
            // image pixels to the same screen coordinates.
            let frame = CaptureFrame {
                x: f64::from(monitor.x().unwrap_or(0)),
                y: f64::from(monitor.y().unwrap_or(0)),
                width: f64::from(monitor.width().unwrap_or(0)),
                height: f64::from(monitor.height().unwrap_or(0)),
            };
            let handle = monitor.id().map_err(|error| LiveError::Failed(error.to_string()))?;

            unsafe {
                let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|_| LiveError::Unsupported)?;
                // Duplication must run on the adapter that drives the display,
                // which on a laptop with two GPUs is not always the default.
                let mut adapter_index = 0;
                while let Ok(adapter) = factory.EnumAdapters1(adapter_index) {
                    adapter_index += 1;
                    let mut output_index = 0;
                    while let Ok(output) = adapter.EnumOutputs(output_index) {
                        output_index += 1;
                        let Ok(desc) = output.GetDesc() else { continue };
                        if desc.Monitor.0 as usize as u32 != handle {
                            continue;
                        }
                        let mut device = None;
                        let mut context = None;
                        D3D11CreateDevice(
                            &adapter,
                            D3D_DRIVER_TYPE_UNKNOWN,
                            HMODULE::default(),
                            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                            None,
                            D3D11_SDK_VERSION,
                            Some(&mut device),
                            None,
                            Some(&mut context),
                        )
                        .map_err(|_| LiveError::Unsupported)?;
                        let (Some(device), Some(context)) = (device, context) else {
                            return Err(LiveError::Unsupported);
                        };
                        let output1: IDXGIOutput1 = output.cast().map_err(|_| LiveError::Unsupported)?;
                        // Duplication refuses processes that are not DPI aware
                        // on some builds; scope the awareness to this call.
                        let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                        let duplicated = output1.DuplicateOutput(&device);
                        if !previous.is_invalid() {
                            SetThreadDpiAwarenessContext(previous);
                        }
                        let duplication = match duplicated {
                            Ok(duplication) => duplication,
                            Err(error) if error.code() == E_ACCESSDENIED => {
                                return Err(LiveError::Failed(
                                    "the screen is locked or showing a secure prompt (UAC); the live view \
                                     resumes once it closes"
                                        .into(),
                                ));
                            }
                            // Unsupported adapter, too many duplications of
                            // this display already, a remote session...
                            Err(_) => return Err(LiveError::Unsupported),
                        };
                        let duplication_desc = duplication.GetDesc();
                        let rotation = duplication_desc.Rotation;
                        if (rotation != DXGI_MODE_ROTATION_IDENTITY && rotation != DXGI_MODE_ROTATION_UNSPECIFIED)
                            || duplication_desc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
                        {
                            // A rotated or HDR desktop arrives in a layout the
                            // copy below does not convert.
                            return Err(LiveError::Unsupported);
                        }
                        return Ok(Session { display, frame, device, context, duplication, staging: None });
                    }
                }
            }
            Err(LiveError::Unsupported)
        }

        /// Copies the duplicated desktop into CPU memory as RGBA.
        fn copy(&mut self, resource: &IDXGIResource) -> windows::core::Result<Option<RgbaImage>> {
            let texture: ID3D11Texture2D = resource.cast()?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { texture.GetDesc(&mut desc) };
            let (width, height) = (desc.Width, desc.Height);
            if self.staging.as_ref().is_none_or(|(_, w, h)| *w != width || *h != height) {
                let staging_desc = D3D11_TEXTURE2D_DESC {
                    MipLevels: 1,
                    ArraySize: 1,
                    BindFlags: 0,
                    MiscFlags: 0,
                    Usage: D3D11_USAGE_STAGING,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    ..desc
                };
                let mut staging = None;
                unsafe { self.device.CreateTexture2D(&staging_desc, None, Some(&mut staging))? };
                let Some(staging) = staging else { return Ok(None) };
                self.staging = Some((staging, width, height));
            }
            let Some((staging, _, _)) = self.staging.as_ref() else { return Ok(None) };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe {
                self.context.CopyResource(staging, &texture);
                self.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            }
            let row_bytes = width as usize * 4;
            let mut rgba = vec![0u8; row_bytes * height as usize];
            for (row, target) in rgba.chunks_exact_mut(row_bytes).enumerate() {
                let source = unsafe {
                    std::slice::from_raw_parts(
                        (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                        row_bytes,
                    )
                };
                // BGRA to RGBA. The duplicated alpha is not meaningful.
                for (to, from) in target.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
                    to.copy_from_slice(&[from[2], from[1], from[0], 255]);
                }
            }
            unsafe { self.context.Unmap(staging, 0) };
            Ok(RgbaImage::from_raw(width, height, rgba))
        }
    }

}

#[cfg(test)]
mod tests {
    #[test]
    fn live_line_is_the_json_the_viewer_parses() {
        assert_eq!(super::live_line(12, true), r#"live: {"seq":12,"changed":true}"#);
        assert_eq!(super::live_line(0, false), r#"live: {"seq":0,"changed":false}"#);
    }

    #[cfg(not(windows))]
    #[test]
    fn other_platforms_fall_back_to_an_ordinary_screenshot() {
        let request = super::LiveRequest {
            display: 0,
            max_width: 1400,
            format: crate::capture::CaptureFormat::Png,
            after: None,
            wait_ms: 0,
            pointer: false,
        };
        assert!(matches!(super::frame(&request), Err(super::LiveError::Unsupported)));
    }
}
