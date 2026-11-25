//! Runs `realesrgan-ncnn-vulkan` on every image of a folder, one at a time, in a background thread.

use crate::history::{History, JobStatus};
use crate::{list_images, JobStarted};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Photo, Drawing }

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Format { Jpg, Png }

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Speed { Quality, Fast }

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct Settings {
    kind: Kind,
    scale: u32,
    format: Format,
    speed: Speed,
}

impl Format {
    fn ext(self) -> &'static str {
        match self { Format::Jpg => "jpg", Format::Png => "png" }
    }
}

/// Model name, and the scale the engine itself runs at (×2 with an ×4-only model is ×4 then resized).
fn model_for(s: &Settings) -> (&'static str, u32) {
    match (s.speed, s.kind) {
        (Speed::Fast, _) => ("realesr-animevideov3", s.scale),
        (Speed::Quality, Kind::Photo) => ("realesrgan-x4plus", 4),
        (Speed::Quality, Kind::Drawing) => ("realesrgan-x4plus-anime", 4),
    }
}

pub struct JobControl {
    pub running: AtomicBool,
    pub pause: AtomicBool,
    pub cancel: AtomicBool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: usize,
    total: usize,
    failed: usize,
    input_path: String,
    output_path: Option<String>,
    file_name: String,
    seconds_per_image: f64,
    eta_seconds: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Summary {
    done: usize,
    total: usize,
    failed: usize,
    elapsed_seconds: f64,
    output_dir: String,
}

#[derive(Serialize, Clone)]
struct JobError { message: String }

/// `<parent>/<input name> (Rodo x4)`, where parent is the chosen output folder or the input's own parent.
fn output_dir_for(input: &Path, scale: u32, output_parent: Option<&Path>) -> PathBuf {
    let name = input.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Images".into());
    let parent = output_parent.unwrap_or_else(|| input.parent().unwrap_or(input));
    parent.join(format!("{name} (Rodo x{scale})"))
}

/// The chosen output folder must exist and must not be inside the images folder (the results would
/// mix with the originals and be picked up as input next time).
fn check_output_parent(input: &Path, parent: &Path) -> Result<(), String> {
    let parent = parent.canonicalize().map_err(|_| "Le dossier de sortie est introuvable.".to_string())?;
    if !parent.is_dir() {
        return Err("Le dossier de sortie est introuvable.".into());
    }
    let input = input.canonicalize().map_err(|_| "Impossible d'ouvrir ce dossier.".to_string())?;
    if parent.starts_with(&input) {
        return Err("Choisis un dossier de sortie en dehors du dossier d'images.".into());
    }
    Ok(())
}

fn output_file(out_dir: &Path, input: &Path, fmt: Format) -> PathBuf {
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    out_dir.join(format!("{stem}.{}", fmt.ext()))
}

fn is_done(path: &Path) -> bool {
    path.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

/// The engine sits next to the app executable (Tauri copies sidecars there, in dev and once installed).
fn engine_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) { "realesrgan-ncnn-vulkan.exe" } else { "realesrgan-ncnn-vulkan" };
    let path = exe.parent().ok_or("exe sans dossier")?.join(name);
    if path.is_file() { Ok(path) } else {
        Err("Le moteur d'agrandissement est introuvable. Réinstalle Rodo Upscale.".into())
    }
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("models");
    if dir.is_dir() { Ok(dir) } else {
        Err("Les modèles d'agrandissement sont introuvables. Réinstalle Rodo Upscale.".into())
    }
}

pub fn start(
    app: AppHandle,
    history: Arc<History>,
    input: PathBuf,
    settings: Settings,
    output_parent: Option<PathBuf>,
) -> Result<(Arc<JobControl>, JobStarted), String> {
    if settings.scale != 2 && settings.scale != 4 {
        return Err("Facteur d'agrandissement invalide.".into());
    }
    let images = list_images(&input)?;
    if images.is_empty() {
        return Err("Ce dossier ne contient aucune image.".into());
    }
    let engine = engine_path()?;
    let models = models_dir(&app)?;
    if let Some(parent) = &output_parent {
        check_output_parent(&input, parent)?;
    }
    let out_dir = output_dir_for(&input, settings.scale, output_parent.as_deref());
    std::fs::create_dir_all(&out_dir).map_err(|_| "Impossible de créer le dossier de sortie.".to_string())?;

    let already_done = images.iter().filter(|p| is_done(&output_file(&out_dir, p, settings.format))).count();
    let control = Arc::new(JobControl {
        running: AtomicBool::new(true),
        pause: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
    });
    let started = JobStarted {
        output_dir: out_dir.to_string_lossy().into_owned(),
        total: images.len(),
        already_done,
    };

    let (entry, earlier_seconds) =
        history.begin(&input, &out_dir, output_parent.as_deref(), settings, images.len(), already_done);
    let _ = app.emit("history://changed", ());

    let ctl = control.clone();
    std::thread::spawn(move || {
        let run_started = Instant::now();
        // Every event the job sends also updates its history entry.
        let emit = move |event: &str, payload: serde_json::Value| {
            let count = |key: &str| payload[key].as_u64().map(|n| n as usize);
            let status = match event {
                "job://paused" => Some(JobStatus::Paused),
                "job://finished" => Some(JobStatus::Finished),
                "job://error" => Some(JobStatus::Error),
                _ => None,
            };
            history.update(&entry, |e| {
                if let (Some(done), Some(failed)) = (count("done"), count("failed")) {
                    e.done = done;
                    e.failed = failed;
                }
                e.elapsed_seconds = earlier_seconds + run_started.elapsed().as_secs_f64();
                if let Some(status) = status {
                    e.status = status;
                }
                if event == "job://error" {
                    e.error_message = payload["message"].as_str().map(str::to_string);
                }
            });
            let _ = app.emit(event, payload);
            if status.is_some() {
                let _ = app.emit("history://changed", ());
            }
        };
        let job = Job { emit: &emit, engine, models, out_dir, settings, ctl: &ctl };
        job.run(images);
        ctl.running.store(false, Ordering::SeqCst);
    });
    Ok((control, started))
}

struct Job<'a> {
    emit: &'a dyn Fn(&str, serde_json::Value),
    engine: PathBuf,
    models: PathBuf,
    out_dir: PathBuf,
    settings: Settings,
    ctl: &'a JobControl,
}

enum Outcome { Ok, Failed, Fatal(String), Cancelled }

impl Job<'_> {
    fn send<T: Serialize>(&self, event: &str, payload: T) {
        (self.emit)(event, serde_json::to_value(payload).unwrap_or_default());
    }

    fn run(&self, images: Vec<PathBuf>) {
        let total = images.len();
        let started = Instant::now();
        let mut done = 0;
        let mut failed = 0;
        let mut processed = 0usize;
        let mut busy = Duration::ZERO;

        let summary = |done, failed| Summary {
            done, total, failed,
            elapsed_seconds: started.elapsed().as_secs_f64(),
            output_dir: self.out_dir.to_string_lossy().into_owned(),
        };

        for input in &images {
            let output = output_file(&self.out_dir, input, self.settings.format);
            if is_done(&output) {
                done += 1;
                continue;
            }
            if self.ctl.cancel.load(Ordering::SeqCst) {
                return;
            }
            if self.ctl.pause.load(Ordering::SeqCst) {
                self.send("job://paused", summary(done, failed));
                return;
            }

            let t = Instant::now();
            let outcome = self.upscale(input, &output);
            busy += t.elapsed();
            processed += 1;
            done += 1;
            let ok = match outcome {
                Outcome::Ok => true,
                Outcome::Failed => { failed += 1; false }
                Outcome::Cancelled => return,
                Outcome::Fatal(message) => {
                    self.send("job://error", JobError { message });
                    return;
                }
            };

            let spi = busy.as_secs_f64() / processed as f64;
            let remaining = images[images.iter().position(|p| p == input).unwrap() + 1..]
                .iter()
                .filter(|p| !is_done(&output_file(&self.out_dir, p, self.settings.format)))
                .count();
            self.send("job://progress", Progress {
                done, total, failed,
                input_path: input.to_string_lossy().into_owned(),
                output_path: ok.then(|| output.to_string_lossy().into_owned()),
                file_name: input.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                seconds_per_image: spi,
                eta_seconds: spi * remaining as f64,
            });
        }
        self.send("job://finished", summary(done, failed));
    }

    /// Upscale one image into a temp file, then move it in place, so a half-written file never counts as done.
    fn upscale(&self, input: &Path, output: &Path) -> Outcome {
        let (model, engine_scale) = model_for(&self.settings);
        let resize_after = engine_scale != self.settings.scale;
        // When resizing after, keep the engine output lossless.
        let tmp_ext = if resize_after { "png" } else { self.settings.format.ext() };
        let tmp = self.out_dir.join(format!(".rodo-tmp.{tmp_ext}"));
        let _ = std::fs::remove_file(&tmp);

        let mut cmd = Command::new(&self.engine);
        cmd.arg("-i").arg(input)
            .arg("-o").arg(&tmp)
            .arg("-n").arg(model)
            .arg("-s").arg(engine_scale.to_string())
            .arg("-f").arg(tmp_ext)
            .arg("-m").arg(&self.models)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(_) => return Outcome::Fatal("Impossible de lancer le moteur d'agrandissement. Réinstalle Rodo Upscale.".into()),
        };
        // The engine prints its progress on stderr: drain it so the pipe never blocks, keep it for diagnosis.
        let mut stderr = child.stderr.take().unwrap();
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });

        let status = loop {
            if self.ctl.cancel.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&tmp);
                return Outcome::Cancelled;
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => return Outcome::Failed,
            }
        };
        let log = reader.join().unwrap_or_default();

        if let Some(message) = gpu_problem(&log) {
            let _ = std::fs::remove_file(&tmp);
            return Outcome::Fatal(message);
        }
        if !status.success() || !is_done(&tmp) {
            let _ = std::fs::remove_file(&tmp);
            return Outcome::Failed;
        }

        let result = if resize_after {
            resize_to(&tmp, output, input, self.settings.scale, self.settings.format)
        } else {
            std::fs::rename(&tmp, output).map_err(|e| e.to_string())
        };
        let _ = std::fs::remove_file(&tmp);
        if result.is_ok() { Outcome::Ok } else { Outcome::Failed }
    }
}

/// The engine needs a Vulkan GPU. Its messages when there is none are turned into something a person can act on.
fn gpu_problem(log: &str) -> Option<String> {
    let l = log.to_ascii_lowercase();
    let no_gpu = ["vkcreateinstance failed", "invalid gpu device", "no vulkan device", "vkenumeratephysicaldevices"]
        .iter()
        .any(|m| l.contains(m));
    no_gpu.then(|| {
        "Ta carte graphique n'est pas compatible ou ses pilotes sont trop anciens. \
         Mets à jour les pilotes graphiques (Intel, AMD ou NVIDIA) puis relance."
            .to_string()
    })
}

/// Bring an ×4 result down to `scale` × the original size (Lanczos), and save it in the requested format.
fn resize_to(tmp: &Path, output: &Path, original: &Path, scale: u32, fmt: Format) -> Result<(), String> {
    let (w, h) = image::image_dimensions(original).map_err(|e| e.to_string())?;
    let img = image::open(tmp).map_err(|e| e.to_string())?;
    let resized = img.resize_exact(w * scale, h * scale, image::imageops::FilterType::Lanczos3);
    let part = output.with_extension(format!("part.{}", fmt.ext()));
    match fmt {
        Format::Png => resized.save_with_format(&part, image::ImageFormat::Png),
        Format::Jpg => {
            let file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 92);
            enc.encode_image(&resized.to_rgb8())
        }
    }
    .map_err(|e| e.to_string())?;
    std::fs::rename(&part, output).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(kind: Kind, scale: u32, speed: Speed) -> Settings {
        Settings { kind, scale, format: Format::Jpg, speed }
    }

    #[test]
    fn picks_model_and_engine_scale() {
        assert_eq!(model_for(&s(Kind::Photo, 4, Speed::Quality)), ("realesrgan-x4plus", 4));
        assert_eq!(model_for(&s(Kind::Photo, 2, Speed::Quality)), ("realesrgan-x4plus", 4));
        assert_eq!(model_for(&s(Kind::Drawing, 2, Speed::Quality)), ("realesrgan-x4plus-anime", 4));
        assert_eq!(model_for(&s(Kind::Photo, 2, Speed::Fast)), ("realesr-animevideov3", 2));
    }

    #[test]
    fn output_names() {
        let out = output_dir_for(Path::new("/x/Photos vacances"), 4, None);
        assert_eq!(out, Path::new("/x/Photos vacances (Rodo x4)"));
        assert_eq!(
            output_dir_for(Path::new("/x/Photos vacances"), 2, Some(Path::new("/d/Sorties"))),
            Path::new("/d/Sorties/Photos vacances (Rodo x2)")
        );
        assert_eq!(output_file(&out, Path::new("/x/Photos vacances/IMG_1.PNG"), Format::Jpg), out.join("IMG_1.jpg"));
    }

    #[test]
    fn gpu_messages() {
        assert!(gpu_problem("vkCreateInstance failed -9").is_some());
        assert!(gpu_problem("0.00%\n100.00%").is_none());
    }

    /// Runs the real engine. Needs `scripts/fetch-engine.sh` to have run; skipped otherwise.
    #[test]
    fn real_engine_end_to_end() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let engine = std::fs::read_dir(root.join("binaries")).ok().and_then(|mut d| {
            d.find_map(|e| e.ok().map(|e| e.path()).filter(|p| {
                p.file_name().unwrap().to_string_lossy().starts_with("realesrgan-ncnn-vulkan-")
            }))
        });
        let Some(engine) = engine else { eprintln!("engine not fetched, skipping"); return };
        let models = root.join("resources/models");

        let base = std::env::temp_dir().join(format!("rodo-e2e-{}", std::process::id()));
        let input = base.join("Vacances");
        std::fs::create_dir_all(&input).unwrap();
        for (i, (w, h)) in [(64u32, 48u32), (40, 40), (50, 30)].into_iter().enumerate() {
            let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x * 4) as u8, (y * 5) as u8, (i * 80) as u8]));
            img.save(input.join(format!("img{i}.png"))).unwrap();
        }

        let run = |settings: Settings, pause: bool| {
            let out_dir = output_dir_for(&input, settings.scale, None);
            std::fs::create_dir_all(&out_dir).unwrap();
            let events = std::sync::Mutex::new(Vec::<(String, serde_json::Value)>::new());
            let emit = |e: &str, v: serde_json::Value| events.lock().unwrap().push((e.to_string(), v));
            let ctl = JobControl { running: AtomicBool::new(true), pause: AtomicBool::new(pause), cancel: AtomicBool::new(false) };
            let job = Job { emit: &emit, engine: engine.clone(), models: models.clone(), out_dir: out_dir.clone(), settings, ctl: &ctl };
            job.run(list_images(&input).unwrap());
            (out_dir, events.into_inner().unwrap())
        };

        // Pause before the first image: nothing is processed.
        let quality_x2 = Settings { kind: Kind::Photo, scale: 2, format: Format::Jpg, speed: Speed::Quality };
        let (_, ev) = run(quality_x2, true);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].0, "job://paused");
        assert_eq!(ev[0].1["done"], 0);

        // Quality ×2: engine at ×4, then resized to exactly ×2, as JPG.
        let (out, ev) = run(quality_x2, false);
        let names: Vec<_> = ev.iter().map(|e| e.0.as_str()).collect();
        assert_eq!(names, ["job://progress", "job://progress", "job://progress", "job://finished"], "{ev:?}");
        assert_eq!(ev[3].1["failed"], 0);
        assert_eq!(image::image_dimensions(out.join("img0.jpg")).unwrap(), (128, 96));
        assert_eq!(ev[2].1["etaSeconds"], 0.0);
        assert!(!out.join(".rodo-tmp.png").exists());

        // Running again resumes: everything is already there, nothing is redone.
        let (_, ev) = run(quality_x2, false);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].0, "job://finished");
        assert_eq!(ev[0].1["done"], 3);

        // Fast ×4 as PNG: native ×4 model.
        let fast_x4 = Settings { kind: Kind::Drawing, scale: 4, format: Format::Png, speed: Speed::Fast };
        let (out, ev) = run(fast_x4, false);
        assert_eq!(ev.last().unwrap().1["failed"], 0, "{ev:?}");
        assert_eq!(image::image_dimensions(out.join("img2.png")).unwrap(), (200, 120));

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn output_parent_must_be_outside_input() {
        let base = std::env::temp_dir().join(format!("rodo-parent-{}", std::process::id()));
        let input = base.join("Photos");
        std::fs::create_dir_all(input.join("sous-dossier")).unwrap();
        assert!(check_output_parent(&input, &base).is_ok());
        assert_eq!(
            check_output_parent(&input, &input.join("sous-dossier")).unwrap_err(),
            "Choisis un dossier de sortie en dehors du dossier d'images."
        );
        assert!(check_output_parent(&input, &input).is_err());
        assert_eq!(check_output_parent(&input, &base.join("absent")).unwrap_err(), "Le dossier de sortie est introuvable.");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn lists_only_visible_images_sorted() {
        let dir = std::env::temp_dir().join(format!("rodo-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["b.PNG", "a.jpg", "._a.jpg", "notes.txt", "c.webp"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let names: Vec<_> = list_images(&dir).unwrap().iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["a.jpg", "b.PNG", "c.webp"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
