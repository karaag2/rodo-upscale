// Fake engine for `pnpm dev` in a browser. Never loaded inside Tauri (see src/backend.ts).
// It draws its own images on a canvas, so the before / after compare has something to show.
// Query flags to reach the rare states: ?erreur (GPU error after a few images),
// drop or pick a folder whose name contains "vide" (scan rejected), ?sortie-dedans (the output
// picker returns a folder inside the input one, so start_job rejects it), ?historique-vide.
import type { Backend, DropEvent } from "./backend";
import type { HistoryEntry, JobStarted, Progress, ScanResult, Settings, Summary } from "./api";

const COUNT = 48;
const TICK_MS = 650;
const params = new URLSearchParams(location.search);

type Listener<T> = (v: T) => void;
const listeners = {
  progress: new Set<Listener<Progress>>(),
  paused: new Set<Listener<Summary>>(),
  finished: new Set<Listener<Summary>>(),
  error: new Set<Listener<string>>(),
  history: new Set<Listener<void>>(),
};
function on<T>(set: Set<Listener<T>>, cb: Listener<T>) {
  set.add(cb);
  return Promise.resolve(() => void set.delete(cb));
}
function emit<T>(set: Set<Listener<T>>, v: T) {
  set.forEach((cb) => cb(v));
}

// ---- generated images -------------------------------------------------------------------
const urls = new Map<string, string>();

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  const rnd = (n: number) => {
    seed = (seed * 9301 + 49297) % 233280;
    return (seed / 233280) * n;
  };
  const skies = [["#f4b37a", "#e06a3c"], ["#9fc3d8", "#e8b48c"], ["#d9a5b3", "#7b5a8a"], ["#f1d39b", "#c9733f"]];
  const [top, mid] = skies[Math.floor(rnd(skies.length))];
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top); g.addColorStop(0.55, mid); g.addColorStop(0.56, "#3b2a2a"); g.addColorStop(1, "#141011");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fde4c2"; ctx.beginPath(); ctx.arc(w * (0.2 + rnd(0.6)), h * 0.4, h * 0.11, 0, 7); ctx.fill();
  ["#7a3b34", "#4a2729", "#241718"].forEach((c, l) => {
    ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(0, h);
    for (let i = 0; i <= 24; i++) ctx.lineTo((w * i) / 24, h * (0.5 + l * 0.1) - rnd(h * 0.12));
    ctx.lineTo(w, h); ctx.fill();
  });
  ctx.strokeStyle = "#fde4c255"; ctx.lineWidth = Math.max(1, w / 800);
  for (let i = 0; i < 60; i++) {
    const y = h * 0.6 + rnd(h * 0.35);
    ctx.beginPath(); ctx.moveTo(w * 0.5 + rnd(w * 0.2), y); ctx.lineTo(w * 0.55 + rnd(w * 0.3), y); ctx.stroke();
  }
}

function makeImage(path: string, seed: number, w: number, h: number) {
  if (urls.has(path)) return;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  paint(c.getContext("2d")!, w, h, seed);
  // toDataURL is synchronous: toBlob can wait for a paint, which stalls in a background tab.
  urls.set(path, c.toDataURL("image/jpeg", 0.9));
}

const sep = "\\";
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const fileName = (i: number) => `IMG_${String(i + 1).padStart(4, "0")}.jpg`;
const inputPath = (dir: string, i: number) => `${dir}${sep}${fileName(i)}`;

// ---- history ----------------------------------------------------------------------------
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();
const photos = `C:${sep}Users${sep}Rodo${sep}Images`;

function seed(e: Omit<HistoryEntry, "id" | "outputDir" | "errorMessage"> & { errorMessage?: string }): HistoryEntry {
  return {
    ...e,
    id: Math.random().toString(36).slice(2, 10),
    outputDir: outputDirFor(e.inputDir, e.settings, e.outputParent),
    errorMessage: e.errorMessage ?? null,
  };
}

const history: HistoryEntry[] = params.has("historique-vide") ? [] : [
  seed({
    startedAt: now - 2 * HOUR - 40 * 60_000, updatedAt: now - 2 * HOUR,
    inputDir: `${photos}${sep}Scans BD Tonton`, outputParent: `D:${sep}Agrandies`,
    settings: { kind: "drawing", scale: 4, format: "png", speed: "quality" },
    total: 1000, done: 734, failed: 3, elapsedSeconds: 5460, status: "paused",
    inputExists: true, outputExists: true,
  }),
  seed({
    startedAt: now - 27 * HOUR, updatedAt: now - 26 * HOUR,
    inputDir: `${photos}${sep}Mariage Julie et Tom`, outputParent: null,
    settings: { kind: "photo", scale: 4, format: "jpg", speed: "quality" },
    total: 312, done: 312, failed: 0, elapsedSeconds: 2380, status: "finished",
    inputExists: true, outputExists: true,
  }),
  seed({
    startedAt: now - 4 * DAY, updatedAt: now - 4 * DAY + 7 * 60_000,
    inputDir: `${photos}${sep}Photos famille 1998`, outputParent: null,
    settings: { kind: "photo", scale: 2, format: "jpg", speed: "fast" },
    total: 540, done: 211, failed: 0, elapsedSeconds: 410, status: "interrupted",
    inputExists: true, outputExists: true,
  }),
  seed({
    startedAt: now - 16 * DAY, updatedAt: now - 16 * DAY + 90_000,
    inputDir: `E:${sep}Vacances Crète 2019`, outputParent: null,
    settings: { kind: "photo", scale: 4, format: "jpg", speed: "quality" },
    total: 86, done: 12, failed: 1, elapsedSeconds: 95, status: "error",
    errorMessage: "Ta carte graphique ne peut pas faire tourner le moteur d'agrandissement. Mets à jour ses pilotes, puis relance.",
    inputExists: false, outputExists: false,
  }),
];

const sameSettings = (a: Settings, b: Settings) =>
  a.kind === b.kind && a.scale === b.scale && a.format === b.format && a.speed === b.speed;
const countFor = (dir: string) => history.find((e) => e.inputDir === dir)?.total ?? COUNT;
function historyChanged() {
  emit(listeners.history, undefined);
}

// ---- job --------------------------------------------------------------------------------
function outputDirFor(inputDir: string, settings: Settings, outputParent: string | null) {
  const parent = outputParent ?? inputDir.slice(0, Math.max(0, inputDir.lastIndexOf(sep)));
  return `${parent}${sep}${baseName(inputDir)} (Rodo x${settings.scale})`;
}

const doneByOutput = new Map<string, Set<number>>();
let timer: number | undefined;
let pauseAsked = false;

export const mockBackend: Backend = {
  async scanFolder(path) {
    await new Promise((r) => setTimeout(r, 350));
    if (baseName(path).toLowerCase().includes("vide")) throw "Ce dossier ne contient aucune image.";
    const first = inputPath(path, 0);
    makeImage(first, 7, 400, 300);
    const count = countFor(path);
    const result: ScanResult = {
      path, count, totalBytes: count * 2_150_000, firstImage: first, sampleWidth: 1600, sampleHeight: 1200,
    };
    return result;
  },

  async startJob(inputDir: string, settings: Settings, outputParent: string | null): Promise<JobStarted> {
    if (timer !== undefined) throw "Un traitement est déjà en cours.";
    if (outputParent && (outputParent === inputDir || outputParent.startsWith(inputDir + sep))) {
      throw "Choisis un dossier de sortie en dehors du dossier d'images.";
    }
    const outputDir = outputDirFor(inputDir, settings, outputParent);
    const total = countFor(inputDir);
    let entry = history.find((e) => e.inputDir === inputDir && e.outputDir === outputDir && sameSettings(e.settings, settings));
    if (!entry) {
      entry = {
        id: Math.random().toString(36).slice(2, 10), startedAt: Date.now(), updatedAt: Date.now(),
        inputDir, outputDir, outputParent, settings: { ...settings }, total, done: 0, failed: 0,
        elapsedSeconds: 0, status: "running", errorMessage: null, inputExists: true, outputExists: true,
      };
      history.push(entry);
    }
    const doneSet = doneByOutput.get(outputDir) ?? new Set(Array.from({ length: entry.done }, (_, i) => i));
    doneByOutput.set(outputDir, doneSet);
    const run = entry;
    run.status = "running";
    run.errorMessage = null;
    run.outputExists = true;
    run.updatedAt = Date.now();
    historyChanged();

    const alreadyDone = doneSet.size;
    const spi = settings.speed === "fast" ? 1.9 : 7.4;
    const baseElapsed = run.elapsedSeconds;
    let failed = run.failed;
    let processed = 0;
    pauseAsked = false;

    const stop = (status: HistoryEntry["status"]) => {
      timer = undefined;
      run.status = status;
      run.updatedAt = Date.now();
      historyChanged();
    };
    const summary = (): Summary => ({
      done: doneSet.size, total, failed, elapsedSeconds: processed * spi, outputDir,
    });

    const step = () => {
      const next = Array.from({ length: total }, (_, i) => i).find((i) => !doneSet.has(i));
      if (next === undefined) {
        stop("finished");
        emit(listeners.finished, summary());
        return;
      }
      if (params.has("erreur") && processed === 5) {
        const message = "Ta carte graphique ne peut pas faire tourner le moteur d'agrandissement. Mets à jour ses pilotes, puis relance.";
        run.errorMessage = message;
        stop("error");
        emit(listeners.error, message);
        return;
      }
      const inPath = inputPath(inputDir, next);
      const ok = next % 17 !== 16;
      makeImage(inPath, next * 77 + 3, 400, 300);
      let outPath: string | null = null;
      if (ok) {
        outPath = `${outputDir}${sep}${fileName(next)}`;
        makeImage(outPath, next * 77 + 3, 1600, 1200);
      } else failed++;
      doneSet.add(next);
      processed++;
      run.done = doneSet.size;
      run.failed = failed;
      run.elapsedSeconds = baseElapsed + processed * spi;
      run.updatedAt = Date.now();
      emit(listeners.progress, {
        done: doneSet.size, total, failed, inputPath: inPath, outputPath: outPath,
        fileName: fileName(next), secondsPerImage: spi, etaSeconds: (total - doneSet.size) * spi,
      });
      if (pauseAsked) {
        stop("paused");
        emit(listeners.paused, summary());
        return;
      }
      timer = window.setTimeout(step, TICK_MS);
    };
    timer = window.setTimeout(step, TICK_MS);
    return { outputDir, total, alreadyDone };
  },

  async pauseJob() {
    pauseAsked = true;
    return null;
  },

  async openPath(path) {
    console.info("[mock] ouvrir", path);
    return null;
  },

  onProgress: (cb) => on(listeners.progress, cb),
  onPaused: (cb) => on(listeners.paused, cb),
  onFinished: (cb) => on(listeners.finished, cb),
  onJobError: (cb) => on(listeners.error, cb),

  async listHistory() {
    await new Promise((r) => setTimeout(r, 150));
    return [...history]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50)
      .map((e) => ({ ...e, settings: { ...e.settings } }));
  },

  async clearHistory() {
    await new Promise((r) => setTimeout(r, 150));
    const keep = history.filter((e) => e.status === "running");
    history.splice(0, history.length, ...keep);
    historyChanged();
    return null;
  },

  onHistoryChanged: (cb) => on(listeners.history, cb),

  async pickFolder(purpose = "input") {
    const input = `${photos}${sep}Photos vacances 2024`;
    if (purpose === "input") return input;
    return params.has("sortie-dedans") ? `${input}${sep}Agrandies` : `D:${sep}Agrandies`;
  },

  onDrop(cb: (e: DropEvent) => void) {
    const over = (e: DragEvent) => { e.preventDefault(); cb({ type: "over" }); };
    const leave = (e: DragEvent) => { if (e.relatedTarget === null) cb({ type: "leave" }); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const entry = e.dataTransfer?.items[0]?.webkitGetAsEntry();
      const name = entry?.name ?? e.dataTransfer?.files[0]?.name;
      if (name) cb({ type: "drop", path: `C:${sep}Users${sep}Rodo${sep}Images${sep}${name}` });
      else cb({ type: "leave" });
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return Promise.resolve(() => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    });
  },

  fileSrc: (path) => urls.get(path) ?? "",
};

// Lets the browser check reach the drop path without a real drag: __mockDrop("Mes dessins").
(window as unknown as { __mockDrop?: (name: string) => void }).__mockDrop = (name) => {
  const dt = new DataTransfer();
  dt.items.add(new File([""], name));
  window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, cancelable: true }));
};
