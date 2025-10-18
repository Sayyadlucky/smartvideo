# Gaze Tracking Enhancement Plan

## Tasks
- [x] Clean up code structure: Remove global variables, consolidate calibration logic in startFaceMonitoring.
- [x] Improve calibration: Increase to 60 frames, use median averaging for robustness.
- [x] Add dynamic thresholds: Calculate based on calibration variance (std dev).
- [x] Add confidence checks: Detection score > 0.8, eye openness > 0.5.
- [x] Enhance smoothing: Increase history to 15, add hysteresis (require 3 consecutive frames for direction change).
- [ ] Test and verify: Ensure no false positives, works in various conditions.
