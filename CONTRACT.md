# Contract between the interface (src/) and the engine (src-tauri/)

The interface and the Rust backend are written in parallel. This file is the only thing they share.
`src/api.ts` is its TypeScript mirror: the interface imports it and never calls `invoke` directly.
Changing this contract means changing this file, `src/api.ts` and `src-tauri/src/` together.

All field names are camelCase on the wire (Rust structs use `#[serde(rename_all = "camelCase")]`).

## Settings

```ts
type Kind   = "photo" | "drawing";
type Scale  = 2 | 4;
type Format = "jpg" | "png";
type Speed  = "quality" | "fast";
interface Settings { kind: Kind; scale: Scale; format: Format; speed: Speed }
```

Model used by the backend (Real-ESRGAN ncnn models shipped in `models/`):

| kind    | speed   | model                     | how ×2 is made                       |
|---------|---------|---------------------------|--------------------------------------|
| photo   | quality | `realesrgan-x4plus`       | ×4, then Lanczos down to ×2          |
| drawing | quality | `realesrgan-x4plus-anime` | ×4, then Lanczos down to ×2          |
| any     | fast    | `realesr-animevideov3`    | native `-s 2` / `-s 4`               |

## Commands (`invoke`)

| command        | args                                   | returns         |
|----------------|----------------------------------------|-----------------|
| `scan_folder`  | `{ path: string }`                     | `ScanResult`    |
| `start_job`    | `{ inputDir: string, settings: Settings, outputParent: string \| null }` | `JobStarted` |
| `pause_job`    | none                                   | `null` (finishes the image in progress, then emits `job://paused`) |
| `open_path`    | `{ path: string }`                     | `null` (opens a folder or file in Explorer / Finder) |
| `list_history` | none                                   | `HistoryEntry[]`, most recent first, at most 50 |
| `clear_history`| none                                   | `null` (forgets every entry except a running one; never deletes images) |

```ts
interface ScanResult {
  path: string;
  count: number;          // images found (jpg, jpeg, png, webp), top level only, not recursive
  totalBytes: number;
  firstImage: string | null;   // absolute path, for the empty-state preview
  sampleWidth: number | null;  // size of firstImage, for "1600×1200 → 6400×4800"
  sampleHeight: number | null;
}

interface JobStarted {
  outputDir: string;      // "<outputParent>/<input name> (Rodo x4)"; outputParent null = the input's own parent folder
  total: number;
  alreadyDone: number;    // images already present in outputDir: skipped, so a job resumes
}
```

Errors: commands reject with a plain French string the interface can show as is
(e.g. « Ce dossier ne contient aucune image. »).

## Output folder

`outputParent` is the folder the user picked with « Changer… », or `null` for « À côté de l'original ».
The backend always creates `<input name> (Rodo x2|x4)` inside it, so batches never mix and resuming works.
It rejects an `outputParent` inside the input folder (« Choisis un dossier de sortie en dehors du dossier d'images. »).

## History

Kept by the backend in the app data folder (`history.json`), written after every image so a crash loses nothing.

```ts
type JobStatus = "running" | "paused" | "finished" | "error" | "interrupted";

interface HistoryEntry {
  id: string;
  startedAt: number;          // unix ms of the first run
  updatedAt: number;          // unix ms of the last change
  inputDir: string;
  outputDir: string;
  outputParent: string | null;
  settings: Settings;
  total: number;
  done: number;               // includes images skipped because already there
  failed: number;
  elapsedSeconds: number;     // summed over every run of this entry
  status: JobStatus;          // "interrupted": the app was closed while it was running
  errorMessage: string | null;
  inputExists: boolean;       // checked when listed
  outputExists: boolean;
}
```

- `start_job` with the same `inputDir`, `outputDir` and `settings` as an existing entry continues that entry
  (status back to `running`) instead of adding a new one. « Reprendre » in the history is just `start_job`
  with the entry's `inputDir`, `settings` and `outputParent`.
- At startup, entries left `running` become `interrupted`.

## Events (`listen`)

| event           | payload       | when |
|-----------------|---------------|------|
| `job://progress`| `Progress`    | after each image (done or failed) |
| `job://paused`  | `Summary`     | after `pause_job` |
| `job://finished`| `Summary`     | when every image is processed |
| `job://error`   | `{ message: string }` | fatal error: engine missing, GPU not supported. The job stops. |
| `history://changed` | none | an entry was added, changed status, or the history was cleared (not on every image) |

```ts
interface Progress {
  done: number;            // includes alreadyDone
  total: number;
  failed: number;
  inputPath: string;       // the image just processed (for the "Avant" side)
  outputPath: string | null; // its result, null if it failed (for the "Après" side)
  fileName: string;
  secondsPerImage: number; // rolling average over the images processed in this run
  etaSeconds: number;
}

interface Summary {
  done: number; total: number; failed: number;
  elapsedSeconds: number;
  outputDir: string;
}
```

## Showing images

Image paths are local files. The interface displays them with `convertFileSrc(path)` from
`@tauri-apps/api/core` (asset protocol is enabled for all paths in `tauri.conf.json`).

## Folder picking

The interface uses `open({ directory: true })` from `@tauri-apps/plugin-dialog`, and the window's
drag-and-drop event (`getCurrentWebview().onDragDropEvent`) for a dropped folder.
