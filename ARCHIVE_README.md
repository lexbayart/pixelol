# Archived: Intel Mac (Tauri v2) desktop version

This branch contains an archived snapshot of the Intel Mac desktop application
(built with Tauri v2) from April 2025. It is preserved for reference (window
configuration, transparency settings, icons, and desktop-specific patches).
Active development of Pixelol continues on the `master` branch.

## Contents

| Path | What it is |
| --- | --- |
| `src-tauri/` | Tauri v2 shell: `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, `build.rs`, Rust entrypoints in `src/`, capabilities, and bundle icons |
| `www/index.html` | The desktop-specific frontend bundle (separate from the `master` root `index.html`) |

Compiled build output is intentionally not committed. `src-tauri/target/` is
~920 MB of Rust build artifacts and is excluded by `.gitignore`; the generated
`src-tauri/gen/schemas/` directory is excluded as well. Run `cargo tauri build`
to regenerate them.

## Key desktop-specific settings

From `src-tauri/tauri.conf.json`:

- `transparent: true` and `decorations: false` with `shadow: true` — the
  borderless, click-through-styled translucent window.
- `identifier: "com.pixelol.desktop"` — the bundle ID.
- `frontendDist: "../www"` — the frontend is served from `www/`, not from
  `src-tauri/dist`.
- CSP allows `fonts.googleapis.com`, `fonts.gstatic.com`, `data:`, `blob:` and
  `tauri:` schemes.
- `src-tauri/src/lib.rs` only installs `tauri-plugin-log` under
  `cfg!(debug_assertions)`; release builds get no log plugin.

## Status

Read-only reference. Do not merge this branch into `master`.
