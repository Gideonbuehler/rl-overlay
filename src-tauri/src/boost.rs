//! Reads your boost amount off the screen.
//!
//! The Stats API only sends boost for spectators, so while you play the only
//! way to know it without touching the game is to look at the HUD the same way
//! a screen recorder does: copy the small area around the boost meter's number
//! and read the digits. Nothing is read from the game process.
//!
//! Windows' built-in OCR handles two- and three-digit numbers but often misses
//! single digits. So the reader learns the HUD's own digit shapes: whenever OCR
//! confidently reads a number, each digit's shape is stored as a template, and
//! from then on digits are matched against those templates directly.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::HSTRING;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

/// Screen area in physical pixels.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, Serialize)]
struct Reading {
    /// 0–100, or None when the number couldn't be read.
    value: Option<u8>,
    /// How it was read, for the calibration readout.
    raw: String,
    /// Which digits have learned shapes so far.
    learned: String,
}

static REGION: Mutex<Option<Region>> = Mutex::new(None);
/// Paused while settings or the report cover the screen, or outside matches.
static PAUSED: AtomicBool = AtomicBool::new(true);
static STARTED: AtomicBool = AtomicBool::new(false);
static RESET: AtomicBool = AtomicBool::new(false);
static LOGGING: AtomicBool = AtomicBool::new(false);

const INTERVAL: Duration = Duration::from_millis(100);
/// Every Nth frame runs OCR even when the templates already know the answer,
/// to keep checking them and keep learning.
const OCR_EVERY: u32 = 10;

#[tauri::command]
pub fn set_boost_region(app: AppHandle, region: Option<Region>) {
    *REGION.lock().unwrap() = region.filter(|r| r.w > 4 && r.h > 4);
    if !STARTED.swap(true, Ordering::Relaxed) {
        std::thread::spawn(move || reader_loop(app));
    }
}

#[tauri::command]
pub fn set_boost_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
}

/// Writes every reading to `boost-log.csv` in the app's data folder, for
/// checking the reader against what really happened.
#[tauri::command]
pub fn set_boost_logging(on: bool) {
    LOGGING.store(on, Ordering::Relaxed);
}

/// Forgets the learned digit shapes, e.g. after changing resolution or HUD scale.
#[tauri::command]
pub fn reset_boost_digits(app: AppHandle) {
    if let Some(path) = templates_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    RESET.store(true, Ordering::Relaxed);
}

fn templates_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("boost-digits.json"))
}

fn reader_loop(app: AppHandle) {
    // WinRT calls need COM initialised on this thread.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let path = templates_path(&app);
    let mut reader = match Reader::new(path.as_ref().and_then(|p| std::fs::read_to_string(p).ok())) {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                "boost-reading",
                Reading { value: None, raw: format!("OCR unavailable: {e}"), learned: String::new() },
            );
            return;
        }
    };
    let mut last_save = Instant::now();
    let log_path = path.as_ref().and_then(|p| p.parent()).map(|d| d.join("boost-log.csv"));

    loop {
        let started = Instant::now();
        if RESET.swap(false, Ordering::Relaxed) {
            reader.templates = Templates::default();
        }
        let region = *REGION.lock().unwrap();
        if let (Some(r), false) = (region, PAUSED.load(Ordering::Relaxed)) {
            let reading = match capture(r) {
                Ok(px) => {
                    let (value, raw) = reader.read(&px, r.w as usize, r.h as usize);
                    Reading { value, raw, learned: reader.learned() }
                }
                Err(e) => Reading { value: None, raw: format!("capture failed: {e}"), learned: reader.learned() },
            };
            if LOGGING.load(Ordering::Relaxed) {
                if let Some(p) = &log_path {
                    log_reading(p, &reading);
                }
            }
            let _ = app.emit("boost-reading", reading);
        }
        if reader.dirty && last_save.elapsed() > Duration::from_secs(20) {
            if let (Some(p), Ok(json)) = (&path, serde_json::to_string(&reader.templates)) {
                if let Some(dir) = p.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(p, json);
            }
            reader.dirty = false;
            last_save = Instant::now();
        }
        std::thread::sleep(INTERVAL.saturating_sub(started.elapsed()));
    }
}

fn log_reading(path: &PathBuf, r: &Reading) {
    use std::io::Write;
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let value = r.value.map(|v| v.to_string()).unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{ms},{value},{}", r.raw.replace(',', ";"));
    }
}

/// Copies a screen area as top-down BGRA.
fn capture(r: Region) -> windows::core::Result<Vec<u8>> {
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, r.w, r.h);
        let old = SelectObject(mem, bitmap.into());
        let blit = BitBlt(mem, 0, 0, r.w, r.h, Some(screen), r.x, r.y, SRCCOPY);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: r.w,
                biHeight: -r.h, // negative: rows run top to bottom
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (r.w * r.h * 4) as usize];
        GetDIBits(mem, bitmap, 0, r.h as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);

        SelectObject(mem, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        blit?;
        Ok(pixels)
    }
}

/// Text pixels: the boost number is bright and nearly colourless, while the
/// gauge around it is saturated orange or blue, so the gauge drops out.
fn text_mask(bgra: &[u8], w: usize, h: usize) -> Vec<bool> {
    (0..w * h)
        .map(|i| {
            let (b, g, r) = (bgra[i * 4], bgra[i * 4 + 1], bgra[i * 4 + 2]);
            let lo = b.min(g).min(r);
            let hi = b.max(g).max(r);
            lo > 165 && hi - lo < 70
        })
        .collect()
}

// ---------- digit templates ----------

const GW: usize = 10;
const GH: usize = 14;
/// GW * GH fill fractions.
type Shape = Vec<f32>;
/// x0, y0, x1, y1, pixel count.
type BBox = (usize, usize, usize, usize, usize);

/// Splits the mask into digit shapes, left to right.
fn glyphs(mask: &[bool], w: usize, h: usize) -> Vec<Shape> {
    // 8-connected components.
    let mut label = vec![0usize; w * h];
    let mut boxes: Vec<BBox> = Vec::new();
    for start in 0..w * h {
        if !mask[start] || label[start] != 0 {
            continue;
        }
        let id = boxes.len() + 1;
        let mut stack = vec![start];
        label[start] = id;
        let mut bb: BBox = (w, h, 0, 0, 0);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            bb = (bb.0.min(x), bb.1.min(y), bb.2.max(x), bb.3.max(y), bb.4 + 1);
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    if mask[j] && label[j] == 0 {
                        label[j] = id;
                        stack.push(j);
                    }
                }
            }
        }
        boxes.push(bb);
    }

    // Digits are the tall components; specks and stray highlights are not.
    let tallest = boxes.iter().map(|b| b.3 - b.1 + 1).max().unwrap_or(0);
    let mut digits: Vec<(usize, Shape)> = boxes
        .iter()
        .enumerate()
        .filter(|(_, b)| b.3 - b.1 + 1 >= tallest * 6 / 10 && b.4 >= 12)
        .map(|(i, b)| (b.0, shape(&label, w, i + 1, *b)))
        .collect();
    digits.sort_by_key(|(x, _)| *x);
    digits.into_iter().map(|(_, s)| s).collect()
}

/// Samples one component into a GW x GH grid. The grid's width follows the
/// glyph's height, not its own width, so a thin "1" stays thin.
fn shape(label: &[usize], w: usize, id: usize, (x0, y0, x1, y1, _): BBox) -> Shape {
    let gh = (y1 - y0 + 1) as f32;
    let gw = gh * 0.8;
    let left = (x0 + x1) as f32 / 2.0 - gw / 2.0;
    let mut out = vec![0f32; GW * GH];
    for gy in 0..GH {
        for gx in 0..GW {
            let (sx0, sx1) = (left + gw * gx as f32 / GW as f32, left + gw * (gx + 1) as f32 / GW as f32);
            let (sy0, sy1) = (y0 as f32 + gh * gy as f32 / GH as f32, y0 as f32 + gh * (gy + 1) as f32 / GH as f32);
            let (mut hit, mut total) = (0, 0);
            let mut y = sy0.floor() as i32;
            while (y as f32) < sy1 {
                let mut x = sx0.floor() as i32;
                while (x as f32) < sx1 {
                    total += 1;
                    if x >= 0 && (x as usize) < w && label.get(y as usize * w + x as usize) == Some(&id) {
                        hit += 1;
                    }
                    x += 1;
                }
                y += 1;
            }
            out[gy * GW + gx] = if total > 0 { hit as f32 / total as f32 } else { 0.0 };
        }
    }
    out
}

fn distance(a: &Shape, b: &Shape) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f32>() / a.len() as f32
}

/// Mean difference below which a shape counts as that digit.
const MATCH: f32 = 0.16;
/// The runner-up digit must be at least this much further away, so look-alike
/// pairs (3 and 8, 5 and 6) are left unread rather than guessed.
const MARGIN: f32 = 0.035;

#[derive(Default, Serialize, Deserialize)]
struct Templates {
    /// Running-average shape and sample count per digit.
    digits: [Option<(Shape, u32)>; 10],
}

struct Reader {
    engine: OcrEngine,
    templates: Templates,
    frame: u32,
    dirty: bool,
}

impl Reader {
    fn new(saved: Option<String>) -> windows::core::Result<Self> {
        Ok(Reader {
            engine: OcrEngine::TryCreateFromUserProfileLanguages()?,
            templates: saved.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
            frame: 0,
            dirty: false,
        })
    }

    fn learned(&self) -> String {
        (0..10u8).filter(|&d| self.templates.digits[d as usize].is_some()).map(|d| char::from(b'0' + d)).collect()
    }

    fn read(&mut self, bgra: &[u8], w: usize, h: usize) -> (Option<u8>, String) {
        self.frame = self.frame.wrapping_add(1);
        let mask = text_mask(bgra, w, h);
        let shapes = glyphs(&mask, w, h);
        if shapes.is_empty() {
            return (None, "no digits in view".into());
        }

        let matched = self.classify(&shapes);
        if matched.is_some() && !self.frame.is_multiple_of(OCR_EVERY) {
            return (matched, "shapes".into());
        }

        let (ocr, text) = match ocr_digits(&self.engine, &mask, w, h) {
            Ok(r) => r,
            Err(e) => return (matched, format!("OCR error: {e}")),
        };
        // Learn only when the shapes agree or don't know yet; a disagreement
        // means one of them is wrong, and averaging it in would spread the error.
        if let Some(value) = ocr {
            let digits = value.to_string();
            if digits.len() == shapes.len() && matched.is_none_or(|m| m == value) {
                for (ch, shape) in digits.bytes().zip(&shapes) {
                    self.learn((ch - b'0') as usize, shape);
                }
            }
        }
        match (ocr, matched) {
            (Some(a), Some(b)) if a != b => (None, format!("OCR {a} vs shapes {b}, skipped")),
            (Some(v), _) => (Some(v), format!("OCR \"{}\"", text.trim())),
            (None, Some(v)) => (Some(v), "shapes".into()),
            (None, None) => (None, format!("unreadable, OCR saw \"{}\"", text.trim())),
        }
    }

    fn classify(&self, shapes: &[Shape]) -> Option<u8> {
        if shapes.len() > 3 {
            return None;
        }
        let mut n = 0u32;
        for s in shapes {
            let mut ranked: Vec<(usize, f32)> = self
                .templates
                .digits
                .iter()
                .enumerate()
                .filter_map(|(d, t)| t.as_ref().map(|(shape, _)| (d, distance(s, shape))))
                .collect();
            ranked.sort_by(|a, b| a.1.total_cmp(&b.1));
            let best = *ranked.first()?;
            let runner_up = ranked.get(1).map_or(f32::MAX, |r| r.1);
            if best.1 > MATCH || runner_up - best.1 < MARGIN {
                return None;
            }
            n = n * 10 + best.0 as u32;
        }
        (n <= 100).then_some(n as u8)
    }

    fn learn(&mut self, digit: usize, shape: &Shape) {
        match &mut self.templates.digits[digit] {
            Some((avg, count)) => {
                // Ignore OCR's occasional wrong guess rather than averaging it in.
                if distance(avg, shape) > MATCH * 1.5 {
                    return;
                }
                let k = (*count).min(50) as f32;
                for (a, s) in avg.iter_mut().zip(shape) {
                    *a = (*a * k + s) / (k + 1.0);
                }
                *count += 1;
            }
            slot => *slot = Some((shape.clone(), 1)),
        }
        self.dirty = true;
    }
}

// ---------- OCR ----------

/// Windows OCR is much better at a line of text than at one short token, so
/// the number is repeated side by side ("47 47 47") and the readings voted on.
const COPIES: usize = 3;
const SCALE: usize = 2;
const PAD: usize = 20;

/// Renders the mask as black digits on white, scaled, padded, and repeated.
fn ocr_image(mask: &[bool], w: usize, h: usize) -> (Vec<u8>, usize, usize) {
    let gap = w * SCALE / 2;
    let (ow, oh) = (COPIES * w * SCALE + (COPIES - 1) * gap + PAD * 2, h * SCALE + PAD * 2);
    let mut out = vec![255u8; ow * oh * 4];
    for y in 0..h {
        for x in 0..w {
            if !mask[y * w + x] {
                continue;
            }
            for copy in 0..COPIES {
                let left = PAD + copy * (w * SCALE + gap);
                for dy in 0..SCALE {
                    for dx in 0..SCALE {
                        let o = ((PAD + y * SCALE + dy) * ow + left + x * SCALE + dx) * 4;
                        out[o..o + 3].copy_from_slice(&[0, 0, 0]);
                    }
                }
            }
        }
    }
    (out, ow, oh)
}

fn ocr_digits(engine: &OcrEngine, mask: &[bool], w: usize, h: usize) -> windows::core::Result<(Option<u8>, String)> {
    let (pixels, ow, oh) = ocr_image(mask, w, h);
    let writer = DataWriter::new()?;
    writer.WriteBytes(&pixels)?;
    let buffer = writer.DetachBuffer()?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, ow as i32, oh as i32)?;
    let text = engine.RecognizeAsync(&bitmap)?.join()?.Text()?.to_string();
    Ok((vote(&text), text))
}

/// Votes across the repeated copies, demanding agreement from at least two.
fn vote(text: &str) -> Option<u8> {
    let readings: Vec<u8> = text.split_whitespace().filter_map(parse_boost).collect();
    let mut best: Option<(u8, usize)> = None;
    for &r in &readings {
        let count = readings.iter().filter(|&&o| o == r).count();
        if best.is_none_or(|(_, c)| count > c) {
            best = Some((r, count));
        }
    }
    best.filter(|&(_, c)| c >= 2 || readings.len() == 1).map(|(r, _)| r)
}

/// Pulls 0–100 out of OCR text, forgiving the usual letter-for-digit mix-ups.
fn parse_boost(text: &str) -> Option<u8> {
    let digits: String = text
        .chars()
        .filter_map(|c| match c {
            '0'..='9' => Some(c),
            'O' | 'o' | 'D' | 'Q' => Some('0'),
            'I' | 'l' | 'i' | '|' | '!' => Some('1'),
            'Z' | 'z' => Some('2'),
            'S' | 's' => Some('5'),
            'B' => Some('8'),
            _ => None,
        })
        .collect();
    match digits.parse::<u32>() {
        Ok(n) if (1..=3).contains(&digits.len()) && n <= 100 => Some(n as u8),
        _ => None,
    }
}

/// `rl-overlay --ocr-test <image> <x> <y> <w> <h> [<x> <y> <w> <h> ...]`
///
/// Runs the reader over crops of an image file in order, sharing what it
/// learns between them, and prints each result. For tuning without the game.
pub fn ocr_test(args: &[String]) -> windows::core::Result<()> {
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Storage::Streams::{Buffer, DataReader};
    use windows::Storage::{FileAccessMode, StorageFile};

    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(args[0].as_str()))?.join()?;
    let stream = file.OpenAsync(FileAccessMode::Read)?.join()?;
    let decoded = BitmapDecoder::CreateAsync(&stream)?.join()?.GetSoftwareBitmapAsync()?.join()?;
    let bitmap = SoftwareBitmap::Convert(&decoded, BitmapPixelFormat::Bgra8)?;
    let (iw, ih) = (bitmap.PixelWidth()? as usize, bitmap.PixelHeight()? as usize);
    let buffer = Buffer::Create((iw * ih * 4) as u32)?;
    bitmap.CopyToBuffer(&buffer)?;
    let mut all = vec![0u8; buffer.Length()? as usize];
    DataReader::FromBuffer(&buffer)?.ReadBytes(&mut all)?;

    let mut reader = Reader::new(None)?;
    let nums: Vec<usize> = args[1..].iter().filter_map(|s| s.parse().ok()).collect();
    for crop in nums.chunks_exact(4) {
        let (x, y) = (crop[0].min(iw - 1), crop[1].min(ih - 1));
        let (w, h) = (crop[2].min(iw - x), crop[3].min(ih - y));
        let mut px = Vec::with_capacity(w * h * 4);
        for row in y..y + h {
            let start = (row * iw + x) * 4;
            px.extend_from_slice(&all[start..start + w * 4]);
        }
        // Force OCR on each crop so learning happens, like the live loop's checks.
        reader.frame = OCR_EVERY - 1;
        let (value, raw) = reader.read(&px, w, h);
        println!("({x},{y}) value={value:?} via {raw} learned={}", reader.learned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_boost, vote};

    #[test]
    fn parses_boost_text() {
        assert_eq!(parse_boost("47"), Some(47));
        assert_eq!(parse_boost("1O0"), Some(100));
        assert_eq!(parse_boost(" 5 "), Some(5));
        assert_eq!(parse_boost("BOOST"), None);
        assert_eq!(parse_boost("147"), None);
        assert_eq!(parse_boost(""), None);
    }

    #[test]
    fn votes_across_copies() {
        assert_eq!(vote("47 47 41"), Some(47));
        assert_eq!(vote("47 41 12"), None);
        assert_eq!(vote("100"), Some(100));
        assert_eq!(vote(""), None);
    }
}
