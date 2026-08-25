# 3D Weather Sandbox

This folder contains the interactive 3D version of the Weather Sandbox. It follows the original 2D game's sandbox-first design: create an environment, edit the atmosphere directly, switch scientific display layers, inspect cells, and save the result.

## Included

- Editable 24–80 km square domain with a 10–20 km model top
- Fast, balanced and detailed 3D grids
- Prognostic horizontal and vertical wind, temperature, vapor, cloud water, rain, ice and pressure anomaly fields
- Semi-Lagrangian 3D transport
- Buoyancy, condensate loading, condensation, evaporation, rain/ice conversion and melting
- Terrain-forced uplift, ocean moisture/temperature forcing, fire heat sources and sea-breeze forcing
- Supercell, mountain-uplift, sea-breeze and empty scenarios
- Direct 3D brush tools for temperature, moisture, updrafts, horizontal wind, land, sea and fire
- Ctrl-inverted tools, whole-column painting and adjustable brush altitude
- Realistic, temperature, humidity, horizontal wind, vertical wind, pressure and precipitation displays
- Orbit camera, cell inspector, wind-vector overlay, storm diagnostics and a day/night cycle
- Horizontal boundary wrapping
- Local `.weather3d` save/load support
- Adaptive render sampling

## Controls

- **Left drag:** use the selected tool
- **Ctrl / Command + left drag:** invert the tool
- **Right drag:** orbit
- **Middle drag:** pan
- **Mouse wheel:** zoom
- **B + mouse wheel:** change brush diameter
- **Space:** pause/resume
- **R:** reset the current scenario
- **1–7:** switch display modes
- **F/T/M/U/V/L/O/X:** select inspect, temperature, moisture, updraft, wind, land, sea or fire

## Running

Serve the repository over HTTP and open `3d-prototype/index.html`.

The renderer imports a pinned Three.js build from jsDelivr, so the first load requires an internet connection.

## Scope

This is an interactive educational model, not a forecast or research core such as CM1. The atmospheric fields and feedbacks are simulated, but pressure, turbulence, radiation and microphysics use deliberately inexpensive approximations so the model can run interactively in a browser.
