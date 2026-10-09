//! On-screen text through Windows.Media.Ocr, for apps that draw their own UI
//! and expose little to UI Automation.
//!
//! The engine runs locally on the window capture; the image never leaves the
//! machine. It recognises the user's profile languages, so a system without a
//! language pack that OCR supports simply has no engine, which callers report
//! (or, under `ocr: auto`, quietly skip).

use image::RgbaImage;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;

use super::outline::{Bounds, OcrText};
use crate::capture::CaptureFrame;

/// Recognise the text lines in a window capture, mapped back to screen
/// coordinates through the capture's frame.
pub fn recognize(image: &RgbaImage, frame: &CaptureFrame) -> Result<Vec<OcrText>, String> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "no OCR language is installed for the user's languages".to_string())?;

    // The engine refuses images past its limit (2600 px on current Windows),
    // and misreads small UI text at 1x: scale toward the limit, at most 2x,
    // and map the boxes back through the frame afterwards.
    let limit = OcrEngine::MaxImageDimension().unwrap_or(2600).max(1);
    let longest = image.width().max(image.height()).max(1);
    let ratio = (f64::from(limit) / f64::from(longest)).min(2.0);
    let scaled;
    let image = if !(1.0..=1.05).contains(&ratio) {
        let width = ((f64::from(image.width()) * ratio).floor() as u32).max(1);
        let height = ((f64::from(image.height()) * ratio).floor() as u32).max(1);
        scaled =
            image::imageops::resize(image, width, height, image::imageops::FilterType::Triangle);
        &scaled
    } else {
        image
    };
    if image.width() < 8 || image.height() < 8 {
        return Ok(Vec::new());
    }

    let bitmap = software_bitmap(image)
        .map_err(|error| format!("could not hand the capture to OCR: {error}"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .and_then(|operation| operation.join())
        .map_err(|error| format!("recognition failed: {error}"))?;
    let lines = result
        .Lines()
        .map_err(|error| format!("recognition failed: {error}"))?;

    // Image pixels to screen coordinates, as `capture::mapping_text` explains.
    let sx = frame.width / f64::from(image.width());
    let sy = frame.height / f64::from(image.height());
    let mut found = Vec::new();
    for index in 0..lines.Size().unwrap_or(0) {
        let Ok(line) = lines.GetAt(index) else {
            continue;
        };
        let text = line.Text().map(|text| text.to_string()).unwrap_or_default();
        let Ok(words) = line.Words() else { continue };
        let mut bounds: Option<Bounds> = None;
        for word in 0..words.Size().unwrap_or(0) {
            let Ok(rect) = words.GetAt(word).and_then(|word| word.BoundingRect()) else {
                continue;
            };
            let word = Bounds::new(
                frame.x + f64::from(rect.X) * sx,
                frame.y + f64::from(rect.Y) * sy,
                f64::from(rect.Width) * sx,
                f64::from(rect.Height) * sy,
            );
            bounds = Some(bounds.map_or(word, |bounds| bounds.union(&word)));
        }
        if let Some(bounds) = bounds
            && !text.trim().is_empty()
        {
            found.push(OcrText { text, bounds });
        }
    }
    Ok(found)
}

/// Copy RGBA pixels into a BGRA `SoftwareBitmap`, the format the engine reads.
fn software_bitmap(image: &RgbaImage) -> windows::core::Result<SoftwareBitmap> {
    let mut bgra = image.as_raw().clone();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let writer = DataWriter::new()?;
    writer.WriteBytes(&bgra)?;
    let buffer = writer.DetachBuffer()?;
    SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        image.width() as i32,
        image.height() as i32,
    )
}
