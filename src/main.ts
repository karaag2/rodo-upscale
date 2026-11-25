import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import type { Format, HistoryEntry, JobStatus, Kind, Progress, ScanResult, Scale, Settings, Speed, Summary } from "./api";
import { loadBackend, type Backend } from "./backend";

// ---- formatting (French) ------------------------------------------------------------------
const nf = new Intl.NumberFormat("fr-FR");
const n = (v: number) => nf.format(v);
const plural = (v: number, one: string, many: string) => `${n(v)} ${v > 1 ? many : one}`;

function bytes(b: number) {
  const go = b / 1024 ** 3;
  if (go >= 1) return `${go.toFixed(1).replace(".", ",")} Go`;
  return `${Math.max(1, Math.round(b / 1024 ** 2))} Mo`;
}

function duration(s: number) {
  if (s < 60) return "moins d'1 min";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const sepOf = (p: string) => (p.includes("\\") ? "\\" : "/");
const trimSep = (p: string) => p.replace(/[\\/]+$/, "");

function parentDir(p: string) {
  const t = trimSep(p);
  return t.slice(0, Math.max(0, Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"))));
}

/** Same rule as the backend: "<outputParent or the input's parent>/<input name> (Rodo xN)". */
function finalDir(input: string, scale: Scale, outputParent: string | null) {
  const parent = trimSep(outputParent ?? parentDir(input));
  return `${parent}${sepOf(outputParent ?? input)}${baseName(input)} (Rodo x${scale})`;
}

/** "C:\\Users\\Rodo\\Images\\Mariage" with keep 2 → "…\\Images\\Mariage". */
function shortPath(p: string, keep: number) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep) return p;
  const sep = sepOf(p);
  return `…${sep}${parts.slice(-keep).join(sep)}`;
}

const KIND_LABEL: Record<Kind, string> = { photo: "Photo", drawing: "Dessin" };
const SPEED_LABEL: Record<Speed, string> = { quality: "Qualité", fast: "Rapide" };
const settingsSummary = (s: Settings) => `${KIND_LABEL[s.kind]} ×${s.scale} · ${s.format.toUpperCase()} · ${SPEED_LABEL[s.speed]}`;

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
function relativeDate(ms: number, now = Date.now()) {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const then = new Date(ms);
  const days = Math.round((day(new Date(now)) - day(then)) / 86_400_000);
  // Hours read better than « hier » for something a few hours old, even across midnight.
  if (days <= 0 || minutes < 6 * 60) return `il y a ${Math.floor(minutes / 60)} h`;
  if (days === 1) return "hier";
  if (days < 7) return `il y a ${days} jours`;
  const year = then.getFullYear() === new Date(now).getFullYear() ? "" : ` ${then.getFullYear()}`;
  return `le ${then.getDate()} ${MONTHS[then.getMonth()]}${year}`;
}
const perImage = (s: number) => `${s.toFixed(1).replace(".", ",")} s par image`;

// ---- settings ---------------------------------------------------------------------------
const STORE_KEY = "rodo.settings";
const DEFAULTS: Settings = { kind: "photo", scale: 4, format: "jpg", speed: "quality" };

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Partial<Record<keyof Settings, unknown>>;
    return {
      kind: raw.kind === "drawing" ? "drawing" : "photo",
      scale: raw.scale === 2 ? 2 : 4,
      format: raw.format === "png" ? "png" : "jpg",
      speed: raw.speed === "fast" ? "fast" : "quality",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* private mode or blocked storage: settings simply won't be remembered */
  }
}

const OUTPUT_KEY = "rodo.outputParent";

function loadOutputParent(): string | null {
  try {
    const v = localStorage.getItem(OUTPUT_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

function saveOutputParent(v: string | null) {
  try {
    if (v) localStorage.setItem(OUTPUT_KEY, v);
    else localStorage.removeItem(OUTPUT_KEY);
  } catch {
    /* not remembered, same as the settings */
  }
}

/** Seconds per image before the engine has measured anything. */
const guessSeconds = (s: Settings) => (s.speed === "fast" ? 2 : 8);
const settingsKey = (s: Settings) => `${s.kind}-${s.scale}-${s.speed}`;

// ---- state ------------------------------------------------------------------------------
type Phase = "empty" | "ready" | "running" | "pausing" | "paused" | "finished";
interface Shot { inputPath: string; outputPath: string; fileName: string }

const state = {
  phase: "empty" as Phase,
  scanning: false,
  scan: null as ScanResult | null,
  settings: loadSettings(),
  /** null = « À côté de l'original ». */
  outputParent: loadOutputParent(),
  measured: new Map<string, number>(),
  job: null as null | {
    outputDir: string; scale: Scale; key: string;
    total: number; done: number; failed: number; alreadyDone: number;
    secondsPerImage: number | null; etaSeconds: number | null;
    elapsed: number;
  },
  error: null as string | null,
  shots: [] as Shot[],
  pinned: null as number | null,
  dropping: false,
  history: {
    open: false,
    entries: null as HistoryEntry[] | null,
    loading: false,
    error: null as string | null,
    confirm: false,
    /** Bumped whenever the list must be rebuilt. */
    version: 0,
  },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  folder: $<HTMLButtonElement>("folder"), fname: $("fname"), fcount: $("fcount"),
  scaleHint: $("scaleHint"),
  outPath: $("outPath"), outReset: $<HTMLButtonElement>("outReset"), outChange: $<HTMLButtonElement>("outChange"),
  outFinal: $("outFinal"),
  histBtn: $<HTMLButtonElement>("histBtn"), history: $("history"), histCount: $("histCount"),
  histClose: $<HTMLButtonElement>("histClose"), histAlert: $("histAlert"), histLoading: $("histLoading"),
  histEmpty: $("histEmpty"), histList: $("histList"), histFoot: $("histFoot"),
  histClearRow: $("histClearRow"), histClear: $<HTMLButtonElement>("histClear"),
  histConfirm: $("histConfirm"), histConfirmText: $("histConfirmText"),
  histCancel: $<HTMLButtonElement>("histCancel"), histConfirmBtn: $<HTMLButtonElement>("histConfirmBtn"),
  estimate: $("estimate"), estTime: $("estTime"), estSize: $("estSize"),
  go: $<HTMLButtonElement>("go"),
  stage: $("stage"), cmp: $("cmp"), handle: $("handle"),
  imgBefore: $<HTMLImageElement>("imgBefore"), imgAfter: $<HTMLImageElement>("imgAfter"),
  tagAfter: $("tagAfter"), cur: $("cur"),
  preview: $("preview"), imgPreview: $<HTMLImageElement>("imgPreview"), previewName: $("previewName"),
  empty: $("empty"), emptyTitle: $("emptyTitle"),
  alert: $("alert"), note: $("note"),
  prog: $("prog"), count: $("n"), total: $("total"), eta: $("eta"),
  bar: $("bar"), barFill: $("barFill"), resume: $("resume"),
  strip: $("strip"), done: $("done"), doneText: $("doneText"), openDir: $<HTMLButtonElement>("openDir"),
};

let backend: Backend;
const busy = () => state.phase === "running" || state.phase === "pausing";
const errorText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "Une erreur inattendue est survenue.";

// ---- render -----------------------------------------------------------------------------
function estimateSize(scan: ScanResult, s: Settings, images: number) {
  const bytesPerPixel = s.format === "png" ? 1.6 : 0.22;
  if (scan.sampleWidth && scan.sampleHeight) {
    return images * scan.sampleWidth * scan.sampleHeight * s.scale ** 2 * bytesPerPixel;
  }
  const perImageIn = scan.count > 0 ? scan.totalBytes / scan.count : 0;
  return images * perImageIn * s.scale ** 2 * (s.format === "png" ? 2 : 0.3);
}

function render() {
  const { phase, scan, settings, job } = state;

  // Folder
  el.folder.disabled = busy() || state.scanning;
  if (state.scanning) {
    el.fname.textContent = "Lecture du dossier…";
    el.fcount.textContent = "un instant";
  } else if (scan) {
    el.fname.textContent = baseName(scan.path);
    el.fcount.textContent = `${plural(scan.count, "image", "images")} · ${bytes(scan.totalBytes)}`;
  } else {
    el.fname.textContent = "Choisir un dossier…";
    el.fcount.textContent = "ou glisse-le à droite";
  }
  el.folder.title = scan?.path ?? "";
  el.folder.classList.toggle("drop", state.dropping);
  el.stage.classList.toggle("drop", state.dropping);

  // Settings
  document.querySelectorAll<HTMLElement>(".seg").forEach((seg) => {
    const key = seg.dataset.key as keyof Settings;
    seg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.setAttribute("aria-pressed", String(String(settings[key]) === b.dataset.v));
      b.disabled = busy();
    });
  });
  el.scaleHint.textContent =
    scan?.sampleWidth && scan.sampleHeight
      ? `${scan.sampleWidth}×${scan.sampleHeight} → ${scan.sampleWidth * settings.scale}×${scan.sampleHeight * settings.scale}`
      : `Chaque côté ×${settings.scale}`;

  // Output folder
  const out = state.outputParent;
  el.outPath.textContent = out ? shortPath(out, 2) : "À côté de l'original";
  el.outPath.title = out ?? "Dans le même dossier que le dossier d'images";
  el.outPath.classList.toggle("custom", !!out);
  el.outReset.hidden = !out;
  el.outReset.disabled = busy();
  el.outChange.disabled = busy();
  el.outFinal.hidden = !scan;
  if (scan) {
    const target = finalDir(scan.path, settings.scale, out);
    el.outFinal.textContent = shortPath(target, 1);
    el.outFinal.title = target;
  }

  // Estimate, only once a folder is known
  el.estimate.hidden = !scan;
  if (scan) {
    const sameJob = job && job.key === settingsKey(settings) && phase !== "finished";
    const left = Math.max(0, scan.count - (sameJob ? job.done : 0));
    const spi = state.measured.get(settingsKey(settings)) ?? guessSeconds(settings);
    el.estTime.textContent = left === 0 ? "terminé" : `≈ ${duration(left * spi)}`;
    el.estSize.textContent = `≈ ${bytes(estimateSize(scan, settings, scan.count))}`;
  }

  // Main button
  const labels: Record<Phase, string> = {
    empty: "Lancer", ready: "Lancer", running: "Mettre en pause",
    pausing: "Pause après cette image…", paused: "Reprendre", finished: "Relancer",
  };
  el.go.textContent = state.error && !busy() && phase !== "empty" ? "Réessayer" : labels[phase];
  el.go.classList.toggle("stop", busy());
  el.go.disabled = phase === "empty" || phase === "pausing" || state.scanning || (scan?.count ?? 0) === 0;

  // Stage
  const shot = currentShot();
  el.empty.hidden = !!scan && !state.dropping;
  el.emptyTitle.textContent = state.dropping ? "Lâche le dossier ici." : "Glisse un dossier d'images ici.";
  el.cmp.hidden = !el.empty.hidden || !shot;
  el.preview.hidden = !el.empty.hidden || !!shot || !scan?.firstImage;
  if (!el.preview.hidden && scan?.firstImage) {
    const src = backend.fileSrc(scan.firstImage);
    if (el.imgPreview.getAttribute("src") !== src) el.imgPreview.src = src;
    el.imgPreview.alt = `Aperçu de ${baseName(scan.firstImage)}`;
    el.previewName.textContent = baseName(scan.firstImage);
  }
  if (job) el.tagAfter.textContent = `Après ×${job.scale}`;

  // Footer
  el.alert.hidden = !state.error;
  el.alert.textContent = state.error ?? "";

  el.note.hidden = phase !== "ready" || !scan || !!state.error;
  if (!el.note.hidden && scan) {
    el.note.replaceChildren(
      "Les images agrandies iront dans un nouveau dossier, ",
      Object.assign(document.createElement("b"), { textContent: `${baseName(scan.path)} (Rodo x${settings.scale})` }),
      out ? `, dans ${baseName(out)}. ` : ", à côté de l'original. ",
      "Tes originaux ne bougent pas.",
    );
  }

  el.prog.hidden = !job || phase === "ready" || phase === "empty";
  if (job) {
    el.count.textContent = n(job.done);
    el.total.textContent = ` / ${n(job.total)}`;
    const pct = job.total > 0 ? (job.done / job.total) * 100 : 0;
    el.barFill.style.setProperty("--p", `${pct}%`);
    el.bar.setAttribute("aria-valuenow", String(Math.round(pct)));
    if (phase === "finished") el.eta.textContent = "terminé";
    else if (phase === "paused") el.eta.textContent = state.error ? "arrêté" : "en pause";
    else if (job.etaSeconds === null || job.secondsPerImage === null) el.eta.textContent = "calcul du temps restant…";
    else el.eta.textContent = `reste ≈ ${duration(job.etaSeconds)} · ${perImage(job.secondsPerImage)}`;
    el.resume.hidden = job.alreadyDone === 0 || phase === "finished";
    el.resume.textContent = `Reprise : ${plural(job.alreadyDone, "image déjà faite", "images déjà faites")}`;
  }

  el.strip.hidden = !busy() || state.shots.length === 0;
  renderStrip();

  el.done.hidden = !job || (phase !== "finished" && phase !== "paused");
  if (job && !el.done.hidden) {
    const ok = job.done - job.failed;
    const parts: HTMLElement[] = [];
    const main = document.createElement("span");
    if (phase === "finished") {
      main.className = "ok";
      const took = duration(job.elapsed).replace("moins d'1 min", "moins d'une minute");
      const thisRun = job.done - job.alreadyDone;
      main.textContent =
        thisRun <= 0 || job.elapsed < 1
          ? `${plural(ok, "image agrandie", "images agrandies")}.`
          : job.alreadyDone > 0
            ? `${plural(ok, "image agrandie", "images agrandies")}, dont ${n(thisRun)} cette fois en ${took}.`
            : `${plural(ok, "image agrandie", "images agrandies")} en ${took}.`;
    } else {
      main.textContent = state.error
        ? `Arrêté à ${n(job.done)} sur ${n(job.total)}. Les images déjà faites sont gardées.`
        : `En pause. ${n(job.done)} sur ${n(job.total)} faites, reprends quand tu veux.`;
    }
    parts.push(main);
    if (job.failed > 0) {
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = job.failed > 1 ? `${n(job.failed)} n'ont pas pu être agrandies.` : "1 n'a pas pu être agrandie.";
      parts.push(warn);
    }
    el.doneText.replaceChildren(...parts.flatMap((p, i) => (i ? [" ", p] : [p])));
  }

  renderHistory();
}

// ---- history view -------------------------------------------------------------------------
const STATUS_LABEL: Record<JobStatus, string> = {
  running: "En cours", paused: "En pause", finished: "Terminé", error: "Erreur", interrupted: "Interrompu",
};
const resumable = (e: HistoryEntry) => e.status === "paused" || e.status === "interrupted" || e.status === "error";
const isLiveEntry = (e: HistoryEntry) => e.status === "running" && state.job?.outputDir === e.outputDir;

function button(label: string, cls: string, onClick: () => void, disabled = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

function span(cls: string, text: string) {
  return Object.assign(document.createElement("span"), { className: cls, textContent: text });
}

function historyItem(e: HistoryEntry) {
  const li = document.createElement("li");
  li.className = "hist-item";

  const info = document.createElement("div");
  info.className = "hist-info";

  const title = document.createElement("div");
  title.className = "hist-title";
  const name = Object.assign(document.createElement("b"), { textContent: baseName(e.inputDir), title: e.inputDir });
  title.append(name, span(`chip s-${e.status}`, STATUS_LABEL[e.status]));

  const meta = document.createElement("div");
  meta.className = "hist-meta mono";
  const when = span("", relativeDate(e.updatedAt));
  when.title = new Date(e.updatedAt).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
  meta.append(when, ` · ${settingsSummary(e.settings)}`);

  const counts = document.createElement("div");
  counts.className = "hist-counts mono";
  const done = span("", `${n(isLiveEntry(e) && state.job ? state.job.done : e.done)} / ${n(e.total)}`);
  if (isLiveEntry(e)) done.id = "histLive";
  counts.append(done, span("dim", e.total > 1 ? " images" : " image"));
  if (e.failed > 0) counts.append(" · ", span("err", e.failed > 1 ? `${n(e.failed)} échecs` : "1 échec"));
  if (e.elapsedSeconds >= 1) counts.append(span("dim", ` · ${duration(e.elapsedSeconds)}`));

  info.append(title, meta, counts);

  const notes: string[] = [];
  if (e.status === "error" && e.errorMessage) notes.push(e.errorMessage);
  const outputMissing = !e.outputExists && e.status !== "running";
  if (!e.inputExists && outputMissing) notes.push("Dossiers introuvables : déplacés, renommés ou sur une clé débranchée.");
  else if (!e.inputExists) notes.push("Dossier d'origine introuvable : déplacé, renommé ou sur une clé débranchée.");
  else if (outputMissing) notes.push("Dossier des images agrandies introuvable.");
  if (e.inputExists && resumable(e) && busy()) notes.push("Un traitement est en cours : mets-le en pause pour reprendre celui-ci.");
  for (const t of notes) info.append(Object.assign(document.createElement("p"), { className: "hist-note", textContent: t }));

  const actions = document.createElement("div");
  actions.className = "hist-actions";
  const open = button("Ouvrir", "ghost sm", () => void openOutput(e.outputDir), !e.outputExists);
  open.title = e.outputExists ? e.outputDir : "Dossier introuvable";
  actions.append(open);
  if (resumable(e)) {
    const blocked = !e.inputExists || busy() || state.scanning;
    const resume = button("Reprendre", "ghost sm primary", () => void resumeEntry(e), blocked);
    resume.title = `${e.done} / ${e.total} déjà faites, il en reste ${e.total - e.done}`;
    actions.append(resume);
  }

  li.append(info, actions);
  return li;
}

let historyKey = "";
function renderHistory() {
  const h = state.history;
  el.history.hidden = !h.open;
  el.stage.hidden = h.open;
  el.histBtn.setAttribute("aria-expanded", String(h.open));
  el.histBtn.classList.toggle("on", h.open);
  if (!h.open) {
    historyKey = "";
    return;
  }

  const live = document.getElementById("histLive");
  if (live && state.job) live.textContent = `${n(state.job.done)} / ${n(state.job.total)}`;

  const key = `${h.version}|${busy()}|${state.scanning}|${h.confirm}|${h.loading}|${h.error}`;
  if (key === historyKey) return;
  historyKey = key;

  const entries = h.entries ?? [];
  el.histAlert.hidden = !h.error;
  el.histAlert.textContent = h.error ?? "";
  el.histLoading.hidden = !(h.loading && h.entries === null);
  el.histEmpty.hidden = h.entries === null || entries.length > 0;
  el.histCount.textContent = entries.length ? plural(entries.length, "lot", "lots") : "";
  el.histList.hidden = entries.length === 0;
  el.histList.replaceChildren(...entries.map(historyItem));

  const clearable = entries.filter((e) => e.status !== "running").length;
  el.histFoot.hidden = clearable === 0;
  el.histClearRow.hidden = h.confirm;
  el.histConfirm.hidden = !h.confirm;
  el.histConfirmText.textContent =
    `Oublier ${clearable > 1 ? `ces ${n(clearable)} lots` : "ce lot"} ? Les images restent sur ton disque.`;
}

async function refreshHistory() {
  const h = state.history;
  h.loading = true;
  render();
  try {
    h.entries = await backend.listHistory();
    h.error = null;
  } catch (e) {
    h.error = errorText(e);
  } finally {
    h.loading = false;
    h.version++;
    render();
  }
}

function openHistory() {
  state.history.open = true;
  state.history.confirm = false;
  render();
  el.histClose.focus();
  void refreshHistory();
}

function closeHistory() {
  state.history.open = false;
  state.history.confirm = false;
  render();
  el.histBtn.focus();
}

async function openOutput(path: string) {
  try {
    await backend.openPath(path);
  } catch (e) {
    state.history.error = errorText(e);
    render();
  }
}

async function resumeEntry(e: HistoryEntry) {
  if (busy() || state.scanning || !e.inputExists) return;
  state.settings = { ...e.settings };
  saveSettings(state.settings);
  state.outputParent = e.outputParent;
  saveOutputParent(e.outputParent);
  state.history.open = false;
  state.history.confirm = false;
  el.go.focus();
  if (await chooseFolder(e.inputDir)) await start();
}

async function clearHistory() {
  const h = state.history;
  try {
    await backend.clearHistory();
    h.confirm = false;
    el.histBtn.focus();
    await refreshHistory();
  } catch (e) {
    h.error = errorText(e);
    h.version++;
    render();
  }
}

function currentShot(): Shot | undefined {
  if (state.pinned !== null) return state.shots[state.pinned];
  return state.shots[state.shots.length - 1];
}

let shownShot: Shot | undefined;
function showShot() {
  const shot = currentShot();
  if (!shot || shot === shownShot) return;
  shownShot = shot;
  // Load both sides before swapping, so the compare never shows half an old pair.
  const before = new Image();
  const after = new Image();
  before.src = backend.fileSrc(shot.inputPath);
  after.src = backend.fileSrc(shot.outputPath);
  Promise.allSettled([before.decode(), after.decode()]).then(() => {
    if (shownShot !== shot) return;
    el.imgBefore.src = before.src;
    el.imgAfter.src = after.src;
    el.imgBefore.alt = `${shot.fileName}, avant`;
    el.imgAfter.alt = `${shot.fileName}, après`;
    el.cur.textContent = shot.fileName;
    render();
  });
}

let stripKey = "";
function renderStrip() {
  const recent = state.shots.slice(-8);
  const offset = state.shots.length - recent.length;
  const curIndex = state.pinned ?? state.shots.length - 1;
  const key = `${state.shots.length}:${curIndex}`;
  if (key === stripKey) return;
  stripKey = key;
  el.strip.replaceChildren(
    ...recent.map((shot, i) => {
      const index = offset + i;
      const b = document.createElement("button");
      b.type = "button";
      b.className = index === curIndex ? "cur" : "";
      b.setAttribute("aria-label", `Comparer ${shot.fileName}`);
      b.setAttribute("aria-pressed", String(index === curIndex));
      const img = document.createElement("img");
      img.src = backend.fileSrc(shot.inputPath);
      img.alt = "";
      img.loading = "lazy";
      b.append(img);
      b.addEventListener("click", () => {
        // Clicking the latest one goes back to following the job live.
        state.pinned = index === state.shots.length - 1 ? null : index;
        showShot();
        render();
      });
      return b;
    }),
  );
}

// ---- actions ----------------------------------------------------------------------------
async function chooseFolder(path: string): Promise<boolean> {
  if (busy() || state.scanning) return false;
  state.scanning = true;
  state.error = null;
  render();
  try {
    const scan = await backend.scanFolder(path);
    state.scan = scan;
    state.phase = "ready";
    state.job = null;
    state.shots = [];
    state.pinned = null;
    shownShot = undefined;
    return true;
  } catch (e) {
    state.error = errorText(e);
    return false;
  } finally {
    state.scanning = false;
    render();
  }
}

async function chooseOutput() {
  if (busy()) return;
  try {
    const path = await backend.pickFolder("output");
    if (!path) return;
    state.outputParent = path;
    saveOutputParent(path);
    state.error = null;
  } catch (e) {
    state.error = errorText(e);
  }
  render();
}

async function start() {
  if (!state.scan) return;
  const settings = { ...state.settings };
  state.error = null;
  state.phase = "running";
  render();
  try {
    const started = await backend.startJob(state.scan.path, settings, state.outputParent);
    const keepShots = state.job?.outputDir === started.outputDir;
    state.job = {
      outputDir: started.outputDir, scale: settings.scale, key: settingsKey(settings),
      total: started.total, done: started.alreadyDone, failed: 0, alreadyDone: started.alreadyDone,
      secondsPerImage: null, etaSeconds: null, elapsed: 0,
    };
    if (!keepShots) {
      state.shots = [];
      state.pinned = null;
      shownShot = undefined;
    }
  } catch (e) {
    state.error = errorText(e);
    state.phase = state.job ? "paused" : "ready";
  }
  render();
}

async function pause() {
  state.phase = "pausing";
  render();
  try {
    await backend.pauseJob();
  } catch (e) {
    state.error = errorText(e);
    state.phase = "running";
    render();
  }
}

function onProgress(p: Progress) {
  if (!state.job) return;
  const job = state.job;
  job.done = p.done;
  job.total = p.total;
  job.failed = p.failed;
  job.secondsPerImage = p.secondsPerImage;
  job.etaSeconds = p.etaSeconds;
  if (p.secondsPerImage > 0) state.measured.set(job.key, p.secondsPerImage);
  if (p.outputPath) {
    state.shots.push({ inputPath: p.inputPath, outputPath: p.outputPath, fileName: p.fileName });
    if (state.shots.length > 40) {
      state.shots.shift();
      if (state.pinned !== null) state.pinned = state.pinned > 0 ? state.pinned - 1 : null;
    }
    showShot();
  }
  render();
}

function onStopped(phase: "paused" | "finished") {
  return (s: Summary) => {
    if (state.job) {
      state.job.done = s.done;
      state.job.total = s.total;
      state.job.failed = s.failed;
      state.job.elapsed = s.elapsedSeconds;
      state.job.outputDir = s.outputDir;
    }
    state.phase = phase;
    render();
  };
}

function onJobError(message: string) {
  state.error = message;
  state.phase = state.job && state.job.done > 0 ? "paused" : "ready";
  render();
}

// ---- compare slider ---------------------------------------------------------------------
let split = 50;
function setSplit(v: number) {
  split = Math.min(100, Math.max(0, v));
  el.cmp.style.setProperty("--x", `${split}%`);
  el.handle.setAttribute("aria-valuenow", String(Math.round(split)));
  el.handle.setAttribute("aria-valuetext", `${Math.round(split)} % avant`);
}

function wireCompare() {
  const fromPointer = (e: PointerEvent) => {
    const r = el.cmp.getBoundingClientRect();
    setSplit(((e.clientX - r.left) / r.width) * 100);
  };
  el.cmp.addEventListener("pointerdown", (e) => {
    el.cmp.setPointerCapture(e.pointerId);
    fromPointer(e);
    el.handle.focus({ preventScroll: true });
  });
  el.cmp.addEventListener("pointermove", (e) => {
    if (el.cmp.hasPointerCapture(e.pointerId)) fromPointer(e);
  });
  el.handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 2;
    const moves: Record<string, number> = {
      ArrowLeft: split - step, ArrowDown: split - step, ArrowRight: split + step, ArrowUp: split + step,
      PageDown: split - 10, PageUp: split + 10, Home: 0, End: 100,
    };
    if (e.key in moves) {
      e.preventDefault();
      setSplit(moves[e.key]);
    }
  });
  setSplit(50);
}

// ---- wiring -----------------------------------------------------------------------------
function wireControls() {
  document.querySelectorAll<HTMLElement>(".seg").forEach((seg) => {
    seg.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b || b.disabled) return;
      const v = b.dataset.v!;
      const s = state.settings;
      switch (seg.dataset.key) {
        case "kind": s.kind = v as Kind; break;
        case "scale": s.scale = Number(v) as Scale; break;
        case "format": s.format = v as Format; break;
        case "speed": s.speed = v as Speed; break;
      }
      saveSettings(s);
      render();
    });
  });

  el.folder.addEventListener("click", async () => {
    try {
      const path = await backend.pickFolder();
      if (path) await chooseFolder(path);
    } catch (e) {
      state.error = errorText(e);
      render();
    }
  });

  el.outChange.addEventListener("click", () => void chooseOutput());
  el.outReset.addEventListener("click", () => {
    if (busy()) return;
    state.outputParent = null;
    saveOutputParent(null);
    state.error = null;
    render();
    el.outChange.focus();
  });

  el.histBtn.addEventListener("click", () => (state.history.open ? closeHistory() : openHistory()));
  el.histClose.addEventListener("click", closeHistory);
  el.histClear.addEventListener("click", () => {
    state.history.confirm = true;
    render();
    el.histCancel.focus();
  });
  el.histCancel.addEventListener("click", () => {
    state.history.confirm = false;
    render();
    el.histClear.focus();
  });
  el.histConfirmBtn.addEventListener("click", () => void clearHistory());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state.history.open) return;
    e.preventDefault();
    if (state.history.confirm) {
      state.history.confirm = false;
      render();
      el.histClear.focus();
    } else closeHistory();
  });

  el.go.addEventListener("click", () => {
    if (state.phase === "running") void pause();
    else void start();
  });

  el.openDir.addEventListener("click", async () => {
    if (!state.job) return;
    try {
      await backend.openPath(state.job.outputDir);
    } catch (e) {
      state.error = errorText(e);
      render();
    }
  });
}

async function init() {
  wireControls();
  wireCompare();
  render();
  try {
    backend = await loadBackend();
    await Promise.all([
      backend.onProgress(onProgress),
      backend.onPaused(onStopped("paused")),
      backend.onFinished(onStopped("finished")),
      backend.onJobError(onJobError),
      backend.onHistoryChanged(() => {
        if (state.history.open) void refreshHistory();
      }),
      backend.onDrop((e) => {
        if (busy()) return;
        state.dropping = e.type === "over";
        if (e.type === "drop") void chooseFolder(e.path);
        render();
      }),
    ]);
  } catch (e) {
    state.error = `Rodo Upscale n'a pas pu démarrer : ${errorText(e)}`;
    render();
  }
}

void init();
