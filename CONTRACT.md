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
| `start_job`    | `{ inputDir: string, settings: Settings }` | `JobStarted` |
| `pause_job`    | none                                   | `null` (finishes the image in progress, then emits `job://paused`) |
| `open_path`    | `{ path: string }`                     | `null` (opens a folder or file in Explorer / Finder) |

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
  outputDir: string;      // sibling folder: "<input> (Rodo x4)" or "<input> (Rodo x2)"
  total: number;
  alreadyDone: number;    // images already present in outputDir: skipped, so a job resumes
}
```

Errors: commands reject with a plain French string the interface can show as is
(e.g. « Ce dossier ne contient aucune image. »).

## Events (`listen`)

| event           | payload       | when |
|-----------------|---------------|------|
| `job://progress`| `Progress`    | after each image (done or failed) |
| `job://paused`  | `Summary`     | after `pause_job` |
| `job://finished`| `Summary`     | when every image is processed |
| `job://error`   | `{ message: string }` | fatal error: engine missing, GPU not supported. The job stops. |

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
