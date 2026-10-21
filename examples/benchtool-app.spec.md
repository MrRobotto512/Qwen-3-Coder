---
title: Add thermal snapshot export to thermal_cam
gates:
  - name: syntax
    run: python3 -m py_compile app_sdk/thermal_cam/main.py
  - name: tests
    run: python3 -m pytest tests/test_thermal_cam_logic.py -q
    timeout: 300
allow_paths:
  - app_sdk/thermal_cam/
  - tests/test_thermal_cam_logic.py
  - changelog.json
max_fix_rounds: 3
---
# Add a CSV export button to the thermal_cam app

## Context
`app_sdk/thermal_cam/` is a single-file Tk touchscreen app (`app.json` + `main.py`)
that follows the app_sdk contract. It already saves PNG snapshots.

## What to build
- A second button next to SNAPSHOT that saves the current frame's temperatures as CSV
  (one row per pixel row, °C, 1 decimal) next to the PNG, same filename stem.
- Reuse the existing snapshot path helper; do not add a new folder.
- `THERMAL_SIM=1` must keep working (the tests run in sim mode).

## Done means
- `tests/test_thermal_cam_logic.py` has a test for the CSV writer (shape, units, rounding).
- Both gates pass.
- A `changelog.json` entry is added in the same format as the existing ones.

## Do not
- Touch the USB driver (`p3cam.py`) or any other app.
