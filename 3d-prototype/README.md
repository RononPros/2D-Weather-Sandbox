# 3D Weather Sandbox Prototype

This is an experimental, intentionally simplified 3D offshoot of the 2D Weather Sandbox.

It is **not** a direct 3D conversion of the original solver and it is **not** a research model like CM1. The goal is to test the user experience and visual idea of an interactive 3D atmospheric sandbox before attempting a serious GPU compute implementation.

## What is included

- 32 km x 32 km x 12 km 3D model domain
- 40 x 40 x 24 simplified atmospheric grid
- temperature anomaly, water vapor, cloud condensate and vertical velocity fields
- approximate condensation / evaporation and latent heating
- buoyancy and condensate loading
- prescribed directional wind shear
- optional imposed rotating updraft bias for the `Supercell-ish` preset
- simplified rain particles
- 3D terrain boundary
- interactive orbit camera
- pulse, multicell, dry-convection and supercell-ish presets
- warm/moist bubble trigger
- live cloud-top and updraft diagnostics

## Important limitations

- The flow solver is deliberately crude and CPU-based.
- Horizontal wind is prescribed rather than fully prognostic.
- The rotating-updraft control is an imposed bias, not a resolved mesocyclone.
- Cloud rendering uses soft point sprites, not true volumetric ray marching.
- No ice, hail, radiation, real sounding import, real terrain import, pressure solve or Coriolis yet.
- The original 2D sandbox remains untouched outside this folder.

## Running

Serve the repository over HTTP and open `3d-prototype/index.html`.

The prototype imports a pinned Three.js build from jsDelivr, so an internet connection is required for the renderer modules.
