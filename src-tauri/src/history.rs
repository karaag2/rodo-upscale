//! History of batches, kept in `history.json` in the app data folder. See CONTRACT.md « History ».

use crate::engine::Settings;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_ENTRIES: usize = 50;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus { Running, Paused, Finished, Error, Interrupted }

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub input_dir: String,
    pub output_dir: String,
    pub output_parent: Option<String>,
    pub settings: Settings,
    pub total: usize,
    pub done: usize,
    pub failed: usize,
    pub elapsed_seconds: f64,
    pub status: JobStatus,
    pub error_message: Option<String>,
    // Computed when listed, never trusted from the file.
    #[serde(default)]
    pub input_exists: bool,
    #[serde(default)]
    pub output_exists: bool,
}

pub struct History {
    file: Option<PathBuf>,
    entries: Mutex<Vec<HistoryEntry>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl History {
    /// Loads the file (a missing or broken file is an empty history). Entries left running were cut off
    /// by a crash or by closing the app: they become interrupted.
    pub fn load(file: Option<PathBuf>) -> Self {
        let mut entries: Vec<HistoryEntry> = file
            .as_deref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        for e in &mut entries {
            if e.status == JobStatus::Running {
                e.status = JobStatus::Interrupted;
            }
        }
        let history = History { file, entries: Mutex::new(entries) };
        history.save(&history.entries.lock().unwrap());
        history
    }

    fn save(&self, entries: &[HistoryEntry]) {
        let Some(file) = &self.file else { return };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let Ok(json) = serde_json::to_vec_pretty(entries) else { return };
        let tmp = file.with_extension("json.part");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, file);
        }
    }

    /// Most recent first, with the existence of both folders checked now.
    pub fn list(&self) -> Vec<HistoryEntry> {
        let mut list = self.entries.lock().unwrap().clone();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        for e in &mut list {
            e.input_exists = Path::new(&e.input_dir).is_dir();
            e.output_exists = Path::new(&e.output_dir).is_dir();
        }
        list
    }

    pub fn clear(&self) {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|e| e.status == JobStatus::Running);
        self.save(&entries);
    }

    /// Records a job start. The same input, output and settings continue the existing entry.
    /// Returns the entry id and the time already spent on it in earlier runs.
    pub fn begin(
        &self,
        input_dir: &Path,
        output_dir: &Path,
        output_parent: Option<&Path>,
        settings: Settings,
        total: usize,
        already_done: usize,
    ) -> (String, f64) {
        let input_dir = input_dir.to_string_lossy().into_owned();
        let output_dir = output_dir.to_string_lossy().into_owned();
        let now = now_ms();
        let mut entries = self.entries.lock().unwrap();
        let existing = entries
            .iter_mut()
            .find(|e| e.input_dir == input_dir && e.output_dir == output_dir && e.settings == settings);
        let (id, elapsed) = match existing {
            Some(e) => {
                e.updated_at = now;
                e.total = total;
                e.done = already_done;
                e.failed = 0;
                e.status = JobStatus::Running;
                e.error_message = None;
                (e.id.clone(), e.elapsed_seconds)
            }
            None => {
                let id = format!("{now:x}-{:x}", std::process::id() ^ entries.len() as u32);
                entries.push(HistoryEntry {
                    id: id.clone(),
                    started_at: now,
                    updated_at: now,
                    input_dir,
                    output_dir,
                    output_parent: output_parent.map(|p| p.to_string_lossy().into_owned()),
                    settings,
                    total,
                    done: already_done,
                    failed: 0,
                    elapsed_seconds: 0.0,
                    status: JobStatus::Running,
                    error_message: None,
                    input_exists: true,
                    output_exists: true,
                });
                (id, 0.0)
            }
        };
        // Keep the most recent entries; a running one is never dropped.
        if entries.len() > MAX_ENTRIES {
            entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            let running = entries.iter().filter(|e| e.status == JobStatus::Running).count();
            let mut room = MAX_ENTRIES.saturating_sub(running);
            entries.retain(|e| {
                if e.status == JobStatus::Running {
                    return true;
                }
                let keep = room > 0;
                room = room.saturating_sub(1);
                keep
            });
        }
        self.save(&entries);
        (id, elapsed)
    }

    /// Applies a change to one entry and saves. Does nothing if the entry was cleared meanwhile.
    pub fn update(&self, id: &str, change: impl FnOnce(&mut HistoryEntry)) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(e) = entries.iter_mut().find(|e| e.id == id) {
            change(e);
            e.updated_at = now_ms();
            self.save(&entries);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(scale: u32) -> Settings {
        serde_json::from_value(serde_json::json!({"kind":"photo","scale":scale,"format":"jpg","speed":"quality"})).unwrap()
    }

    #[test]
    fn continues_same_job_and_survives_restart() {
        let dir = std::env::temp_dir().join(format!("rodo-history-{}", std::process::id()));
        let file = dir.join("history.json");
        let h = History::load(Some(file.clone()));
        let (a, _) = h.begin(Path::new("/in"), Path::new("/in (Rodo x4)"), None, settings(4), 10, 0);
        h.update(&a, |e| { e.done = 4; e.elapsed_seconds = 12.0; e.status = JobStatus::Paused; });

        // Same folder and settings: same entry, time carried over.
        let (again, elapsed) = h.begin(Path::new("/in"), Path::new("/in (Rodo x4)"), None, settings(4), 10, 4);
        assert_eq!(again, a);
        assert_eq!(elapsed, 12.0);
        // Other settings: a new entry.
        let (b, _) = h.begin(Path::new("/in"), Path::new("/in (Rodo x2)"), None, settings(2), 10, 0);
        assert_ne!(a, b);
        assert_eq!(h.list().len(), 2);

        // The app closes while both are running: they come back interrupted.
        let reloaded = History::load(Some(file));
        let list = reloaded.list();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|e| e.status == JobStatus::Interrupted));
        assert!(!list[0].input_exists);

        reloaded.clear();
        assert!(reloaded.list().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn clear_keeps_running_and_size_is_capped() {
        let h = History::load(None);
        for i in 0..MAX_ENTRIES + 5 {
            let (id, _) = h.begin(Path::new(&format!("/in{i}")), Path::new("/out"), None, settings(4), 1, 0);
            if i == 0 {
                h.entries.lock().unwrap()[0].updated_at = 0; // the oldest of all
            } else {
                h.update(&id, |e| e.status = JobStatus::Finished);
            }
        }
        // The first one is still running: kept even though it is the oldest.
        let list = h.list();
        assert_eq!(list.len(), MAX_ENTRIES);
        assert!(list.iter().any(|e| e.input_dir == "/in0"));
        h.clear();
        let list = h.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status, JobStatus::Running);
    }
}
