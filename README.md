# Rodo Upscale

Petite application Windows qui agrandit (×2 ou ×4) toutes les images d'un dossier, directement sur le PC,
avec [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN). Gratuit, hors ligne, les originaux ne sont pas modifiés.

## Pour les développeurs

- `CONTRACT.md` : l'API entre l'interface (`src/`) et le moteur (`src-tauri/`).
- `docs/maquette/` : la maquette validée, référence visuelle de l'interface.
- Stack : [Tauri 2](https://tauri.app), TypeScript + Vite, Rust. Le moteur `realesrgan-ncnn-vulkan`
  et ses modèles sont téléchargés par `scripts/` et par la CI, jamais commités.

## Licences

Real-ESRGAN et ncnn sont sous licence BSD-3-Clause.
