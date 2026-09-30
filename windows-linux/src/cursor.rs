//! The pointer's current shape and position, for a person viewing this screen
//! from another computer. Screen captures leave the cursor out, so a viewer
//! draws it itself: with this image as its own pointer, the arrow, I-beam or
//! resize handle under the viewer's mouse is the one this machine is showing.

use serde_json::Value;

/// `{id, visible, x, y, hotspot_x, hotspot_y, width, height, png}` for the
/// cursor on screen now, or None where the platform cannot say (Linux for
/// now). `png` is base64 and only changes when `id` does.
pub fn current() -> Option<Value> {
    #[cfg(windows)]
    {
        windows_cursor::current()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
mod windows_cursor {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};

    use base64::Engine;
    use image::{ImageEncoder, codecs::png::PngEncoder};
    use serde_json::{Value, json};
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
        DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetObjectW, HBITMAP, HGDIOBJ,
        SelectObject,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CURSOR_SHOWING, CURSORINFO, DI_NORMAL, DrawIconEx, GetCursorInfo, GetIconInfo, HICON,
        ICONINFO,
    };

    struct Shape {
        png: String,
        hotspot_x: u32,
        hotspot_y: u32,
        width: u32,
        height: u32,
    }

    fn cache() -> &'static Mutex<HashMap<isize, Shape>> {
        static CACHE: OnceLock<Mutex<HashMap<isize, Shape>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn current() -> Option<Value> {
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        unsafe { GetCursorInfo(&mut info) }.ok()?;
        let visible = (info.flags.0 & CURSOR_SHOWING.0) != 0 && !info.hCursor.is_invalid();
        let id = info.hCursor.0 as isize;
        let mut shapes = cache().lock().ok()?;
        if visible && !shapes.contains_key(&id) {
            // Cursor handles are shared system objects that live as long as
            // the session, so a handful of shapes cover a whole sitting.
            if shapes.len() > 64 {
                shapes.clear();
            }
            if let Some(shape) = render(HICON(info.hCursor.0)) {
                shapes.insert(id, shape);
            }
        }
        let shape = shapes.get(&id);
        Some(json!({
            "id": format!("{id:#x}"),
            "visible": visible && shape.is_some(),
            "x": info.ptScreenPos.x,
            "y": info.ptScreenPos.y,
            "hotspot_x": shape.map_or(0, |s| s.hotspot_x),
            "hotspot_y": shape.map_or(0, |s| s.hotspot_y),
            "width": shape.map_or(0, |s| s.width),
            "height": shape.map_or(0, |s| s.height),
            "png": shape.map(|s| s.png.clone()),
        }))
    }

    /// Draws the cursor twice, over black and over white, and recovers each
    /// pixel's colour and opacity from the difference. That one path handles
    /// alpha cursors, classic AND/XOR mask cursors, and the inverting I-beam,
    /// which comes out black so it stays visible over a light page.
    fn render(icon: HICON) -> Option<Shape> {
        let mut icon_info = ICONINFO::default();
        unsafe { GetIconInfo(icon, &mut icon_info) }.ok()?;
        let color = icon_info.hbmColor;
        let mask = icon_info.hbmMask;
        let size = bitmap_size(if color.is_invalid() { mask } else { color });
        unsafe {
            if !color.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(color.0));
            }
            if !mask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(mask.0));
            }
        }
        let (width, mut height) = size?;
        // A mask-only cursor stacks its AND and XOR masks in one bitmap.
        if color.is_invalid() {
            height /= 2;
        }
        if width == 0 || height == 0 || width > 256 || height > 256 {
            return None;
        }
        let over_black = draw(icon, width, height, 0xFF00_0000)?;
        let over_white = draw(icon, width, height, 0xFFFF_FFFF)?;
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for (black, white) in over_black.iter().zip(over_white.iter()) {
            let channel = |pixel: u32, shift: u32| ((pixel >> shift) & 0xFF) as i32;
            let (br, bg, bb) = (channel(*black, 16), channel(*black, 8), channel(*black, 0));
            let wg = channel(*white, 8);
            if wg < bg {
                // Inverting pixel: white over black, black over white.
                rgba.extend_from_slice(&[0, 0, 0, 255]);
                continue;
            }
            let alpha = (255 - (wg - bg)).clamp(0, 255);
            if alpha == 0 {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            let unpremultiply = |value: i32| ((value * 255) / alpha).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[
                unpremultiply(br),
                unpremultiply(bg),
                unpremultiply(bb),
                alpha as u8,
            ]);
        }
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
            .ok()?;
        Some(Shape {
            png: base64::engine::general_purpose::STANDARD.encode(png),
            hotspot_x: icon_info.xHotspot,
            hotspot_y: icon_info.yHotspot,
            width,
            height,
        })
    }

    fn bitmap_size(bitmap: HBITMAP) -> Option<(u32, u32)> {
        if bitmap.is_invalid() {
            return None;
        }
        let mut info = BITMAP::default();
        let read = unsafe {
            GetObjectW(
                HGDIOBJ(bitmap.0),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut info as *mut BITMAP as *mut c_void),
            )
        };
        (read > 0).then(|| (info.bmWidth.max(0) as u32, info.bmHeight.unsigned_abs()))
    }

    /// The cursor drawn over a solid background, as 0xAARRGGBB pixels.
    fn draw(icon: HICON, width: u32, height: u32, background: u32) -> Option<Vec<u32>> {
        let header = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            // Negative height: top-down rows, matching PNG order.
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let bitmap_info = BITMAPINFO {
            bmiHeader: header,
            ..Default::default()
        };
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return None;
            }
            let mut bits: *mut c_void = std::ptr::null_mut();
            let Ok(dib) = CreateDIBSection(Some(dc), &bitmap_info, DIB_RGB_COLORS, &mut bits, None, 0)
            else {
                let _ = DeleteDC(dc);
                return None;
            };
            let previous = SelectObject(dc, HGDIOBJ(dib.0));
            let count = (width * height) as usize;
            let pixels = std::slice::from_raw_parts_mut(bits as *mut u32, count);
            pixels.fill(background);
            let drawn = DrawIconEx(dc, 0, 0, icon, width as i32, height as i32, 0, None, DI_NORMAL);
            let _ = GdiFlush();
            let copy = drawn.is_ok().then(|| pixels.to_vec());
            SelectObject(dc, previous);
            let _ = DeleteObject(HGDIOBJ(dib.0));
            let _ = DeleteDC(dc);
            copy
        }
    }
}
