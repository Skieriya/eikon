# Vendored face tracking

`recorder.html` tracks your face with MediaPipe Face Landmarker. These files are
copies, not a package install, so the recorder works with no network and no build
step — the page loads them from `./recorder/vendor/...` exactly like any other
project file.

| Path | What it is | License |
| --- | --- | --- |
| `mediapipe/vision_bundle.mjs` | the `@mediapipe/tasks-vision` ES module (`FaceLandmarker`, `FilesetResolver`) | Apache-2.0 |
| `mediapipe/wasm/vision_wasm_internal.js` + `.wasm` | the wasm runtime that bundle loads | Apache-2.0 |
| `models/face_landmarker.task` | the 478-point blendshape face model | CC-BY-4.0, Google LLC |

Copyright of the upstream work stays with Google LLC; full terms are in the
official repo, https://github.com/google-ai-edge/mediapipe-solutions.

## Re-downloading

The versions here are whatever `@mediapipe/tasks-vision` served when these files
were copied. To refresh them, replace all four with the matching pair — the module
and the wasm must come from the same release:

```sh
V=0.10.14   # pin the release you actually get, and update this line
curl -o mediapipe/vision_bundle.mjs \
  https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V/vision_bundle.mjs
curl -o mediapipe/wasm/vision_wasm_internal.js \
  https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V/wasm/vision_wasm_internal.js
curl -o mediapipe/wasm/vision_wasm_internal.wasm \
  https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V/wasm/vision_wasm_internal.wasm
curl -o models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
```

Only these paths are read, and they are named in `recorder/tracker.js` — a wasm
built from a different release than the module will fail to instantiate, which the
recorder reports and answers by falling back to simulate mode.
