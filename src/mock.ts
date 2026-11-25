// Fake engine for `pnpm dev` in a browser. Never loaded inside Tauri (see src/backend.ts).
// It draws its own images on a canvas, so the before / after compare has something to show.
// Query flags to reach the rare states: ?erreur (GPU error after a few images),
// drop or pick a folder whose name contains "vide" (scan rejected).
import type { Backend, DropEvent } from "./backend";
import type { JobStarted, Progress, ScanResult, Settings, Summary } from "./api";

const COUNT = 48;
const TICK_MS = 650;
const params = new URLSearchParams(location.search);

type Listener<T> = (v: T) => void;
const listeners = {
  progress: new Set<Listener<Progress>>(),
  paused: new Set<Listener<Summary>>(),
  finished: new Set<Listener<Summary>>(),
  error: new Set<Listener<string>>(),
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

// ---- job --------------------------------------------------------------------------------
const doneByOutput = new Map<string, Set<number>>();
let timer: number | undefined;
let pauseAsked = false;

function summary(done: number, failed: number, elapsed: number, outputDir: string): Summary {
  return { done, total: COUNT, failed, elapsedSeconds: elapsed, outputDir };
}

export const mockBackend: Backend = {
  async scanFolder(path) {
    await new Promise((r) => setTimeout(r, 350));
    if (baseName(path).toLowerCase().includes("vide")) throw "Ce dossier ne contient aucune image.";
    const first = inputPath(path, 0);
    makeImage(first, 7, 400, 300);
    const result: ScanResult = {
      path, count: COUNT, totalBytes: COUNT * 2_150_000, firstImage: first, sampleWidth: 1600, sampleHeight: 1200,
    };
    return result;
  },

  async startJob(inputDir: string, settings: Settings): Promise<JobStarted> {
    if (timer !== undefined) throw "Un traitement est déjà en cours.";
    const outputDir = `${inputDir} (Rodo x${settings.scale})`;
    const doneSet = doneByOutput.get(outputDir) ?? new Set<number>();
    doneByOutput.set(outputDir, doneSet);
    const alreadyDone = doneSet.size;
    const spi = settings.speed === "fast" ? 1.9 : 7.4;
    let failed = 0;
    let processed = 0;
    pauseAsked = false;

    const step = () => {
      const elapsed = processed * spi;
      const next = Array.from({ length: COUNT }, (_, i) => i).find((i) => !doneSet.has(i));
      if (next === undefined) {
        timer = undefined;
        emit(listeners.finished, summary(doneSet.size, failed, elapsed, outputDir));
        return;
      }
      if (params.has("erreur") && processed === 5) {
        timer = undefined;
        emit(listeners.error, "Ta carte graphique ne peut pas faire tourner le moteur d'agrandissement. Mets à jour ses pilotes, puis relance.");
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
      emit(listeners.progress, {
        done: doneSet.size, total: COUNT, failed, inputPath: inPath, outputPath: outPath,
        fileName: fileName(next), secondsPerImage: spi, etaSeconds: (COUNT - doneSet.size) * spi,
      });
      if (pauseAsked) {
        timer = undefined;
        emit(listeners.paused, summary(doneSet.size, failed, processed * spi, outputDir));
        return;
      }
      timer = window.setTimeout(step, TICK_MS);
    };
    timer = window.setTimeout(step, TICK_MS);
    return { outputDir, total: COUNT, alreadyDone };
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

  async pickFolder() {
    return `C:${sep}Users${sep}Rodo${sep}Images${sep}Photos vacances 2024`;
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
