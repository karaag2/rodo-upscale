# Rodo Upscale

Petite application Windows qui agrandit (×2 ou ×4) toutes les images d'un dossier, directement sur le PC,
avec [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN). Gratuit, hors ligne, les originaux ne sont pas modifiés.

## Pour ton pote : installer Rodo Upscale

1. Va sur la page [Releases](https://github.com/karaag2/rodo-upscale/releases/latest) et télécharge
   `Rodo-Upscale-<version>-installer.exe` (rubrique « Assets »).
2. Double-clique dessus. Si Windows affiche « Windows a protégé votre ordinateur », clique sur
   **Informations complémentaires** puis **Exécuter quand même** : l'application n'est pas signée, c'est normal.
3. L'installation se fait dans ton compte, sans mot de passe administrateur.
4. Lance **Rodo Upscale** depuis le menu Démarrer, choisis un dossier d'images et c'est parti.
   Les images agrandies arrivent dans un nouveau dossier à côté de l'original.

Ça ne marche pas ? Mets à jour le pilote de ta carte graphique (Intel, AMD ou NVIDIA) :
le moteur utilise Vulkan, fourni par ce pilote. Pour désinstaller : Paramètres › Applications.

## Pour les développeurs

- `CONTRACT.md` : l'API entre l'interface (`src/`) et le moteur (`src-tauri/`).
- `docs/maquette/` : la maquette validée, référence visuelle de l'interface.
- Stack : [Tauri 2](https://tauri.app), TypeScript + Vite, Rust. Le moteur `realesrgan-ncnn-vulkan`
  et ses modèles sont téléchargés par `scripts/` et par la CI, jamais commités.

## Build

### Mac (développement)

Prérequis : Rust (rustup), Node LTS, pnpm.

```bash
pnpm install
```

```bash
scripts/fetch-engine.sh
```

```bash
pnpm tauri dev
```

`fetch-engine.sh` télécharge Real-ESRGAN ncnn-vulkan v0.2.5.0 (zip officiel, SHA-256 vérifié), installe
`src-tauri/binaries/realesrgan-ncnn-vulkan-<triple Rust>` (ex. `-aarch64-apple-darwin`, nommage sidecar
de Tauri) et les modèles dans `src-tauri/resources/models/`. Relançable sans risque (`--force` pour réinstaller).
Il marche aussi sous Linux ; sous Windows, utiliser `scripts/fetch-engine.ps1`.

### Windows (l'installeur)

Le Mac ne peut pas produire l'installeur Windows : c'est GitHub Actions qui le fait
(`.github/workflows/windows.yml`, sur `windows-latest`).

- Chaque push sur `main` (ou « Run workflow » dans l'onglet Actions) produit l'installeur NSIS,
  téléchargeable dans l'artifact `rodo-upscale-windows-installer` du run.
- Un tag `vX.Y.Z` fait la même chose puis publie une Release « Rodo Upscale vX.Y.Z » avec l'installeur.
  Le tag doit correspondre à `version` dans `src-tauri/tauri.conf.json`, sinon le build échoue.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Avant l'upload, `scripts/smoke-windows.ps1` installe l'installeur en silencieux et vérifie que le moteur,
`vcomp140.dll` et les modèles sont bien installés et que le moteur démarre.

Fichiers installés (dossier d'installation = dossier de ressources Tauri sous Windows) :

```
Rodo Upscale/
  rodo-upscale.exe
  realesrgan-ncnn-vulkan.exe   sidecar (Tauri retire le suffixe -x86_64-pc-windows-msvc)
  vcomp140.dll                 runtime OpenMP importé par le moteur, voir src-tauri/tauri.windows.conf.json
  models/*.param, *.bin
```

Le moteur importe aussi `vulkan-1.dll`, qui n'est pas embarquée : elle vient du pilote graphique du PC.

## Licences

Real-ESRGAN et ncnn sont sous licence BSD-3-Clause.
