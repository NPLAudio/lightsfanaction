//! Listens to what the PC is playing (the default output device, captured in loopback) and turns it into
//! a handful of levels for the sound-reactive lighting effects: 32 log-spaced frequency bands, bass, mid and
//! treble levels, overall level, and a beat counter. No audio leaves this module, only those numbers.
//!
//! Capture runs only while an effect needs it. The window asks with `audio_set_active`, and levels are
//! pushed to it as `audio-levels` events about 40 times a second.

use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const BANDS: usize = 32;
const FFT: usize = 2048;
const LOW_HZ: f32 = 35.0;
const HIGH_HZ: f32 = 16_000.0;
const EMIT_EVERY: Duration = Duration::from_millis(25);

#[derive(Clone, Default, Serialize, Debug, PartialEq)]
pub struct Levels {
    /// 0 to 1 per band, lowest frequency first
    pub bands: Vec<f32>,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    /// overall loudness, 0 to 1
    pub level: f32,
    /// how many beats have been heard since capture started; the window notes when it changes
    pub beats: u32,
    /// strength of the latest beat, 0 to 1
    pub beat_strength: f32,
}

// ---- analysis ----------------------------------------------------------------------------------

pub struct Analyzer {
    rate: f32,
    window: Vec<f32>,
    hann: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    /// FFT bin range of each band
    edges: Vec<(usize, usize)>,
    smooth: Vec<f32>,
    /// slow-moving loudest recent magnitude, so quiet and loud music both fill the range
    peak: f32,
    prev_bass: f32,
    flux_avg: f32,
    since_beat: f32,
    beats: u32,
    beat_strength: f32,
    out: Levels,
}

impl Analyzer {
    pub fn new(rate: f32) -> Self {
        let hann = (0..FFT).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (FFT as f32 - 1.0)).cos()).collect();
        let nyquist = rate / 2.0;
        let top = HIGH_HZ.min(nyquist * 0.98);
        let bin = |hz: f32| ((hz * FFT as f32 / rate).round() as usize).clamp(1, FFT / 2 - 1);
        let edges = (0..BANDS)
            .map(|b| {
                let lo = LOW_HZ * (top / LOW_HZ).powf(b as f32 / BANDS as f32);
                let hi = LOW_HZ * (top / LOW_HZ).powf((b + 1) as f32 / BANDS as f32);
                let (lo, hi) = (bin(lo), bin(hi));
                (lo, hi.max(lo + 1))
            })
            .collect();
        Self {
            rate,
            window: vec![0.0; FFT],
            hann,
            re: vec![0.0; FFT],
            im: vec![0.0; FFT],
            edges,
            smooth: vec![0.0; BANDS],
            peak: 0.02,
            prev_bass: 0.0,
            flux_avg: 0.0,
            since_beat: 1.0,
            beats: 0,
            beat_strength: 0.0,
            out: Levels { bands: vec![0.0; BANDS], ..Levels::default() },
        }
    }

    /// Adds newly captured mono samples; only the most recent window is kept.
    pub fn push(&mut self, samples: &[f32]) {
        if samples.len() >= FFT {
            self.window.copy_from_slice(&samples[samples.len() - FFT..]);
        } else {
            self.window.rotate_left(samples.len());
            let at = FFT - samples.len();
            self.window[at..].copy_from_slice(samples);
        }
    }

    /// Advances by `dt` seconds and returns the current levels. With no new audio the levels fall away.
    pub fn step(&mut self, dt: f32) -> &Levels {
        for i in 0..FFT {
            self.re[i] = self.window[i] * self.hann[i];
            self.im[i] = 0.0;
        }
        fft(&mut self.re, &mut self.im);

        let mut raw = [0.0f32; BANDS];
        let mut loudest = 0.0f32;
        for (b, &(lo, hi)) in self.edges.iter().enumerate() {
            let mut sum = 0.0;
            for k in lo..hi {
                sum += (self.re[k] * self.re[k] + self.im[k] * self.im[k]).sqrt();
            }
            // higher bands cover more bins; the mean keeps the bands comparable, and pink-noise tilt lifts the highs
            let mean = sum / (hi - lo) as f32 / (FFT as f32 / 4.0);
            let tilt = 1.0 + 2.5 * b as f32 / BANDS as f32;
            raw[b] = mean * tilt;
            loudest = loudest.max(raw[b]);
        }

        // auto gain: follow the loudest band up quickly and down slowly, never below a noise floor
        if loudest > self.peak {
            self.peak += (loudest - self.peak) * (1.0 - (-dt / 0.05).exp());
        } else {
            self.peak += (loudest - self.peak) * (1.0 - (-dt / 4.0).exp());
        }
        let peak = self.peak.max(0.004);

        let mut level = 0.0;
        for b in 0..BANDS {
            let v = (raw[b] / peak).clamp(0.0, 1.0).powf(0.8);
            let gone = if v > self.smooth[b] { 0.012 } else { 0.12 };
            self.smooth[b] += (v - self.smooth[b]) * (1.0 - (-dt / gone).exp());
            level += self.smooth[b];
        }
        // silence reads as silence however low the gain has fallen
        let quiet = (loudest / 0.004).clamp(0.0, 1.0);
        for s in &mut self.smooth {
            *s *= quiet;
        }
        level = level / BANDS as f32 * quiet;

        let mean = |a: usize, b: usize| self.smooth[a..b].iter().sum::<f32>() / (b - a) as f32;
        let bass_now = mean(0, 5);

        // beat: a sudden rise in bass compared with the recent average rise
        let flux = (bass_now - self.prev_bass).max(0.0);
        self.prev_bass = bass_now;
        self.flux_avg += (flux - self.flux_avg) * (1.0 - (-dt / 0.8).exp());
        self.since_beat += dt;
        if flux > self.flux_avg * 1.8 + 0.03 && bass_now > 0.3 && self.since_beat > 0.17 {
            self.beats = self.beats.wrapping_add(1);
            self.beat_strength = (bass_now * 1.2).min(1.0);
            self.since_beat = 0.0;
        }

        self.out = Levels {
            bands: self.smooth.clone(),
            bass: bass_now,
            mid: mean(8, 20),
            treble: mean(22, BANDS),
            level,
            beats: self.beats,
            beat_strength: self.beat_strength,
        };
        &self.out
    }

    pub fn rate(&self) -> f32 {
        self.rate
    }
}

/// In-place radix-2 FFT; the length must be a power of two.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * cr - im[b] * ci, re[b] * ci + im[b] * cr);
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
        len <<= 1;
    }
}

// ---- capture -----------------------------------------------------------------------------------

/// Whether any effect currently wants audio. Set by the window.
#[derive(Default)]
pub struct Wanted(pub AtomicBool);

#[derive(Default)]
struct Shared {
    /// samples captured since the supervisor last looked, already mixed down to mono
    pending: Vec<f32>,
    failed: bool,
}

fn capture<T>(device: &cpal::Device, config: cpal::StreamConfig, shared: Arc<Mutex<Shared>>) -> Result<cpal::Stream, String>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let on_data = shared.clone();
    let on_error = shared;
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &_| {
                if let Ok(mut s) = on_data.lock() {
                    for frame in data.chunks(channels) {
                        let sum: f32 = frame.iter().map(|&x| f32::from_sample(x)).sum();
                        s.pending.push(sum / channels as f32);
                    }
                    // keep a bound on what piles up if the supervisor is slow
                    if s.pending.len() > FFT * 8 {
                        let drop = s.pending.len() - FFT * 4;
                        s.pending.drain(..drop);
                    }
                }
            },
            move |_| {
                if let Ok(mut s) = on_error.lock() {
                    s.failed = true;
                }
            },
            None,
        )
        .map_err(|e| e.to_string())
}

struct Running {
    _stream: cpal::Stream,
    shared: Arc<Mutex<Shared>>,
    device_id: String,
    analyzer: Analyzer,
}

fn open() -> Result<Running, String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("no output device")?;
    let device_id = device.id().map(|i| i.to_string()).unwrap_or_default();
    // on Windows, an input stream on an output device records what that device is playing
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let rate = supported.sample_rate() as f32;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let shared = Arc::new(Mutex::new(Shared::default()));
    let stream = match format {
        SampleFormat::F32 => capture::<f32>(&device, config, shared.clone())?,
        SampleFormat::I16 => capture::<i16>(&device, config, shared.clone())?,
        SampleFormat::I32 => capture::<i32>(&device, config, shared.clone())?,
        other => return Err(format!("unsupported sample format {other:?}")),
    };
    stream.play().map_err(|e| e.to_string())?;
    Ok(Running { _stream: stream, shared, device_id, analyzer: Analyzer::new(rate) })
}

fn default_device_id() -> Option<String> {
    cpal::default_host().default_output_device().and_then(|d| d.id().ok()).map(|i| i.to_string())
}

/// Runs for the life of the app: opens capture while wanted, follows the default device, and emits levels.
pub fn start(app: AppHandle, wanted: Arc<Wanted>) {
    std::thread::spawn(move || {
        let mut running: Option<Running> = None;
        let mut next_try = Instant::now();
        let mut next_device_check = Instant::now();
        let mut last = Instant::now();
        let mut last_emit = Instant::now();
        let mut silent = Levels { bands: vec![0.0; BANDS], ..Levels::default() };

        loop {
            std::thread::sleep(Duration::from_millis(12));
            let now = Instant::now();
            let dt = now.duration_since(last).as_secs_f32().min(0.2);
            last = now;

            if !wanted.0.load(Ordering::Relaxed) {
                if running.take().is_some() {
                    // tell the window the levels are gone so effects settle to dark
                    let _ = app.emit("audio-levels", &silent);
                }
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }

            if let Some(r) = &running {
                let failed = r.shared.lock().map(|s| s.failed).unwrap_or(true);
                let moved = now >= next_device_check && default_device_id().is_some_and(|id| id != r.device_id);
                if now >= next_device_check {
                    next_device_check = now + Duration::from_secs(2);
                }
                if failed || moved {
                    running = None;
                }
            }
            if running.is_none() && now >= next_try {
                next_try = now + Duration::from_secs(2);
                running = open().ok();
            }

            let Some(r) = running.as_mut() else {
                if now.duration_since(last_emit) >= Duration::from_millis(200) {
                    last_emit = now;
                    let _ = app.emit("audio-levels", &silent);
                }
                continue;
            };

            // loopback delivers nothing while the PC is silent, in which case the levels simply fall away
            let samples = r.shared.lock().map(|mut s| std::mem::take(&mut s.pending)).unwrap_or_default();
            if samples.is_empty() {
                r.analyzer.push(&vec![0.0; (r.analyzer.rate() * dt) as usize]);
            } else {
                r.analyzer.push(&samples);
            }
            let levels = r.analyzer.step(dt).clone();
            silent.beats = levels.beats;
            if now.duration_since(last_emit) >= EMIT_EVERY {
                last_emit = now;
                let _ = app.emit("audio-levels", &levels);
            }
        }
    });
}

#[tauri::command]
pub fn audio_set_active(state: tauri::State<'_, Arc<Wanted>>, on: bool) {
    state.0.store(on, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn tone(hz: f32, n: usize, offset: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * PI * hz * (i + offset) as f32 / RATE).sin()).collect()
    }

    /// Runs `seconds` of audio through the analyzer in ~12 ms blocks.
    fn run(a: &mut Analyzer, mut gen: impl FnMut(usize, usize) -> Vec<f32>, seconds: f32) -> Levels {
        let block = (RATE * 0.012) as usize;
        let mut at = 0;
        let mut last = Levels::default();
        while (at as f32) < seconds * RATE {
            a.push(&gen(at, block));
            last = a.step(0.012).clone();
            at += block;
        }
        last
    }

    #[test]
    fn fft_finds_the_tone() {
        let n = 1024;
        let mut re: Vec<f32> = (0..n).map(|i| (2.0 * PI * 8.0 * i as f32 / n as f32).sin()).collect();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im);
        let mags: Vec<f32> = (0..n / 2).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt()).collect();
        let top = mags.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert_eq!(top, 8);
    }

    #[test]
    fn low_and_high_tones_land_in_low_and_high_bands() {
        let mut a = Analyzer::new(RATE);
        let low = run(&mut a, |at, n| tone(80.0, n, at, 0.5), 1.0);
        let lo_peak = low.bands.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert!(lo_peak < 6, "80 Hz landed in band {lo_peak}");
        assert!(low.bass > low.treble);

        let mut b = Analyzer::new(RATE);
        let high = run(&mut b, |at, n| tone(8000.0, n, at, 0.5), 1.0);
        let hi_peak = high.bands.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert!(hi_peak > 22, "8 kHz landed in band {hi_peak}");
        assert!(high.treble > high.bass);
    }

    #[test]
    fn silence_is_silent_and_levels_fall_away() {
        let mut a = Analyzer::new(RATE);
        let loud = run(&mut a, |at, n| tone(200.0, n, at, 0.5), 1.0);
        assert!(loud.level > 0.01);
        let after = run(&mut a, |_, n| vec![0.0; n], 1.0);
        assert!(after.level < 0.01, "level {}", after.level);
        assert!(after.bands.iter().all(|&v| v < 0.02));
    }

    #[test]
    fn a_kick_drum_pattern_is_heard_as_beats_and_a_steady_tone_is_not() {
        // a decaying 60 Hz thump every half second
        let mut a = Analyzer::new(RATE);
        let kicks = run(
            &mut a,
            |at, n| {
                (0..n)
                    .map(|i| {
                        let t = (at + i) as f32 / RATE;
                        let since = t % 0.5;
                        0.8 * (-since * 18.0).exp() * (2.0 * PI * 60.0 * t).sin()
                    })
                    .collect()
            },
            4.0,
        );
        assert!((5..=10).contains(&kicks.beats), "heard {} beats in 4 s of 2 per second", kicks.beats);

        let mut b = Analyzer::new(RATE);
        let steady = run(&mut b, |at, n| tone(60.0, n, at, 0.5), 4.0);
        assert!(steady.beats <= 1, "a steady tone gave {} beats", steady.beats);
    }
}

#[cfg(test)]
mod hardware {
    use super::*;

    /// Needs a real output device: `cargo test --lib hardware -- --ignored --nocapture`. Play something first.
    #[test]
    #[ignore]
    fn loopback_opens_and_reports_levels() {
        let mut r = open().expect("open the default output device in loopback");
        println!("device {} at {} Hz", r.device_id, r.analyzer.rate());
        let mut peak = 0.0f32;
        let mut got = 0usize;
        for _ in 0..200 {
            std::thread::sleep(Duration::from_millis(12));
            let samples = r.shared.lock().map(|mut s| std::mem::take(&mut s.pending)).unwrap();
            got += samples.len();
            if samples.is_empty() {
                r.analyzer.push(&vec![0.0; 576]);
            } else {
                r.analyzer.push(&samples);
            }
            peak = peak.max(r.analyzer.step(0.012).level);
        }
        println!("samples captured {got}, peak level {peak:.3}");
    }
}
