// Typed mirror of CONTRACT.md. The interface only talks to the backend through this file.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Kind = "photo" | "drawing";
export type Scale = 2 | 4;
export type Format = "jpg" | "png";
export type Speed = "quality" | "fast";
export interface Settings { kind: Kind; scale: Scale; format: Format; speed: Speed }

export interface ScanResult {
  path: string;
  count: number;
  totalBytes: number;
  firstImage: string | null;
  sampleWidth: number | null;
  sampleHeight: number | null;
}

export interface JobStarted { outputDir: string; total: number; alreadyDone: number }

export interface Progress {
  done: number;
  total: number;
  failed: number;
  inputPath: string;
  outputPath: string | null;
  fileName: string;
  secondsPerImage: number;
  etaSeconds: number;
}

export interface Summary {
  done: number;
  total: number;
  failed: number;
  elapsedSeconds: number;
  outputDir: string;
}

export type JobStatus = "running" | "paused" | "finished" | "error" | "interrupted";

export interface HistoryEntry {
  id: string;
  startedAt: number;
  updatedAt: number;
  inputDir: string;
  outputDir: string;
  outputParent: string | null;
  settings: Settings;
  total: number;
  done: number;
  failed: number;
  elapsedSeconds: number;
  status: JobStatus;
  errorMessage: string | null;
  inputExists: boolean;
  outputExists: boolean;
}

export const scanFolder = (path: string) => invoke<ScanResult>("scan_folder", { path });
export const startJob = (inputDir: string, settings: Settings, outputParent: string | null) =>
  invoke<JobStarted>("start_job", { inputDir, settings, outputParent });
export const pauseJob = () => invoke<null>("pause_job");
export const openPath = (path: string) => invoke<null>("open_path", { path });
export const listHistory = () => invoke<HistoryEntry[]>("list_history");
export const clearHistory = () => invoke<null>("clear_history");

export const onProgress = (cb: (p: Progress) => void): Promise<UnlistenFn> =>
  listen<Progress>("job://progress", (e) => cb(e.payload));
export const onPaused = (cb: (s: Summary) => void): Promise<UnlistenFn> =>
  listen<Summary>("job://paused", (e) => cb(e.payload));
export const onFinished = (cb: (s: Summary) => void): Promise<UnlistenFn> =>
  listen<Summary>("job://finished", (e) => cb(e.payload));
export const onJobError = (cb: (message: string) => void): Promise<UnlistenFn> =>
  listen<{ message: string }>("job://error", (e) => cb(e.payload.message));
export const onHistoryChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("history://changed", () => cb());
