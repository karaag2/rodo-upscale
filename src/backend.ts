// What the interface needs from the engine: the contract in src/api.ts, plus the folder picker,
// the drag-and-drop of a folder and a way to show a local image. Inside Tauri this is the real
// engine; in a plain browser (`pnpm dev`) it is the fake one from src/mock.ts.
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { HistoryEntry, JobStarted, Progress, ScanResult, Settings, Summary } from "./api";

type Unlisten = () => void;

export type DropEvent = { type: "over" } | { type: "leave" } | { type: "drop"; path: string };

export type FolderPurpose = "input" | "output";

const PICKER_TITLES: Record<FolderPurpose, string> = {
  input: "Choisis un dossier d'images",
  output: "Choisis où ranger les images agrandies",
};

export interface Backend {
  scanFolder(path: string): Promise<ScanResult>;
  /** outputParent null = next to the input folder. */
  startJob(inputDir: string, settings: Settings, outputParent: string | null): Promise<JobStarted>;
  pauseJob(): Promise<unknown>;
  openPath(path: string): Promise<unknown>;
  onProgress(cb: (p: Progress) => void): Promise<Unlisten>;
  onPaused(cb: (s: Summary) => void): Promise<Unlisten>;
  onFinished(cb: (s: Summary) => void): Promise<Unlisten>;
  onJobError(cb: (message: string) => void): Promise<Unlisten>;
  listHistory(): Promise<HistoryEntry[]>;
  clearHistory(): Promise<unknown>;
  onHistoryChanged(cb: () => void): Promise<Unlisten>;
  /** Opens the system folder picker. Null when the user cancels. */
  pickFolder(purpose?: FolderPurpose): Promise<string | null>;
  onDrop(cb: (e: DropEvent) => void): Promise<Unlisten>;
  /** URL the page can load for a local image path. */
  fileSrc(path: string): string;
}

const realBackend: Backend = {
  scanFolder: api.scanFolder,
  startJob: api.startJob,
  pauseJob: api.pauseJob,
  openPath: api.openPath,
  onProgress: api.onProgress,
  onPaused: api.onPaused,
  onFinished: api.onFinished,
  onJobError: api.onJobError,
  listHistory: api.listHistory,
  clearHistory: api.clearHistory,
  onHistoryChanged: api.onHistoryChanged,
  async pickFolder(purpose = "input") {
    const picked = await open({ directory: true, multiple: false, title: PICKER_TITLES[purpose] });
    return typeof picked === "string" ? picked : null;
  },
  onDrop(cb) {
    return getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") cb({ type: "over" });
      else if (p.type === "leave") cb({ type: "leave" });
      else if (p.type === "drop" && p.paths.length > 0) cb({ type: "drop", path: p.paths[0] });
      else cb({ type: "leave" });
    });
  },
  fileSrc: (path) => convertFileSrc(path),
};

export async function loadBackend(): Promise<Backend> {
  if ("__TAURI_INTERNALS__" in window) return realBackend;
  const { mockBackend } = await import("./mock");
  return mockBackend;
}
