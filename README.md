# Live2D Cubism Web — Running Example

A complete, immediately runnable website demonstrating **Live2D Cubism for Web**.
It includes:

1. **Demo mode (works out of the box)** — an animated Canvas 2D character that
   follows your mouse, blinks, changes expressions, and exposes Live2D-style
   parameters (`ParamAngleX`, `ParamEyeBallX`, `ParamMouthOpenY`, etc.).
2. **Real SDK integration code** — the full `CubismWebFramework` initialization
   flow (startUp → initialize → load `.model3.json` → load `.moc3` → create
   model → create WebGL renderer → draw loop). Just drop in the downloaded SDK
   and your model to switch from demo to the real model.

> 📖 Resources used:
> - Official download: https://www.live2d.com/en/sdk/download/web/
> - Framework source: https://github.com/Live2D/CubismWebFramework

---

## Project structure

```
live2d-example/
├── index.html          # Main page (canvas + UI controls)
├── css/
│   └── style.css       # Styling
├── js/
│   └── app.js          # App logic: real SDK integration + demo fallback
├── sdk/
│   ├── .gitkeep
│   └── README.md       # Where to place the downloaded SDK
├── models/
│   └── README.md       # Where to place your exported model
└── README.md           # This file
```

---

## Quick start (demo works immediately)

1. Serve the folder over HTTP - `file://` cannot load ES modules or `fetch()`
   the model, so opening `index.html` directly will not work. Double-click
   `start.bat`, or:
   ```bash
   python serve.py              # http://127.0.0.1:8000/
   ```
   `serve.py` is a stdlib static server with the three things this page needs to
   load fast: HTTP/1.1 keep-alive (one socket instead of ~60), a thread per
   connection, and revalidation on every file - so a texture you re-encoded is
   picked up on the next reload instead of being pinned in the browser cache.
   `python -m http.server 8000` also works, just noticeably slower.
2. Visit `http://127.0.0.1:8000`.
3. Move your mouse - she follows your cursor, click to squash her, type in the
   box to have her point at a part of the page (`where is faq?`).

### Model textures

`tools/make_webp.py` writes a `.webp` next to every texture the manifest references,
downscaled to what the screen actually shows (Hu Tao: 64 MB of 8192px PNG → 1.1 MB of
2048px WebP), and `live2d/assets.js` takes the `.webp` when it is there, falling back
to the PNG. The downscale matters more than the format: decoding and uploading three
8192px atlases is ~200 megapixels of work for a character about 600 px tall. Re-run it
after adding or replacing a model folder:

```bash
pip install pillow
python tools/make_webp.py            # encodes anything missing or stale
python tools/make_webp.py --check    # report only
python tools/make_webp.py --max 4096 --force   # sharper on very large/HiDPI windows
python tools/make_webp.py --max 0 --force      # keep full resolution
```

`--max` is the longest edge, halved down so the dimensions stay powers of two (WebGL 1
needs that for the mipmaps that keep her face from aliasing).

### Bring-up order

Three things keep the page near-instant, and the console says what each cost
(`Everything ready Nms after boot - cubism …, model + textures …, point rig …`):

- the framework's 41 ES modules are `<link rel="modulepreload">`ed, so importing them
  is one parallel fetch instead of the waterfall the import graph describes;
- a small inline module prefetches from `models/manifest.js` before that graph
  resolves, so the `.moc3` downloads — and the textures download *and decode* — while
  the SDK is still being imported;
- `live2d/assets.js` keys every asset by the URL its `model3.json` declares, so
  `loadModel()` gets the work already finished and nothing is fetched or decoded
  twice; bytes and bitmaps are released as soon as they are on the GPU.

Hu Tao, cold: ~6.7 s → ~450 ms to her first frame.

---

## How to switch to a REAL Live2D model

The real Cubism SDK and model data are **not** included here because they
require a free Live2D account download. Follow these steps:

### 1. Download the Cubism SDK for Web
- Go to https://www.live2d.com/en/sdk/download/web/
- Register (free) and download the **Cubism SDK for Web** package.

### 2. Add the SDK files to this project
Inside the downloaded package you will find a `Core` folder and a
`Framework` folder. Copy them into `sdk/` so the layout looks like:

```
sdk/
├── Core/
│   └── ... (Cubism Core for Web)
└── Framework/
    └── live2dcubismframework.js   # built framework entry point
```

> The framework is written in TypeScript. Use the built JavaScript output
> (or build it yourself with the project's `tsconfig.json` / build script).

### 3. Uncomment the SDK <script> tags in `index.html`
In `index.html`, near the bottom of `<head>`, you'll see a commented block
explaining this. Uncomment the real SDK `<script>` tag(s) and comment out
the demo fallback script so the browser loads `sdk/Framework/live2dcubismframework.js`.

### 4. Add your exported model
Export your model from Live2D Cubism Editor (or download a sample) into
`models/`. A typical folder looks like:

```
models/
└── Hiyori/
    ├── Hiyori.model3.json
    ├── Hiyori.moc3
    ├── Hiyori.1024/texture_00.png
    └── ...
```

Then update `CONFIG.modelPath` in `js/app.js`:

```js
const CONFIG = {
  modelPath: "models/Hiyori/Hiyori.model3.json",
  // ...
};
```

### 5. Refresh the page
The app will detect `window.Live2DCubismFramework`, initialize the real
CubismFramework, load your `.moc3` model + textures, and render it with
WebGL. The banner changes to **REAL SDK MODE**.

---

## Real SDK code overview (`js/app.js` → `initRealSdk()`)

The integration follows the official [CubismFramework cycle](https://docs.live2d.com/en/cubism-sdk-manual/use-framework-web):

| Step | What happens |
|------|--------------|
| 1 | `CubismFramework.startUp(option)` — configure logging |
| 2 | `CubismFramework.initialize()` — initialize the framework |
| 3 | `fetch(model3.json)` → `new CubismModelSettingJson(buffer, size)` — parse model settings |
| 4 | `fetch(.moc3)` → `CubismMoc.create(buffer)` → `moc.createModel()` — create the Cubism model |
| 5 | `new CubismRenderer_WebGL()` → `renderer.initialize(gl)` → `renderer.bindModel(model)` — create the WebGL renderer |
| 6 | Load each texture from `setting.getTextureFileName(i)` → `renderer.bindTexture(i, tex)` |
| 7 | Animation loop: `model.update()` → `renderer.drawModel()` |
| 8 | Cleanup: `CubismFramework.dispose()` |

Parameter manipulation example:

```js
const id = CubismFramework.getIdManager().getId("ParamAngleX");
model.setParameterValueById(id, value);
model.update();
```

---

## License & usage rules

- The **Live2D Cubism SDK** is distributed under the Live2D Proprietary
  Software License Agreement. Review the license included in the SDK package
  before use.
- Model data (`.moc3`, textures, motions) is subject to the terms of the
  model creator / Live2D. Do not redistribute models you don't have rights to.
- This example code is provided as-is for learning and development.

## References

- [Cubism SDK for Web — Manual](https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-for-web/)
- [How to Use CubismWebFramework Directly](https://docs.live2d.com/en/cubism-sdk-manual/use-framework-web/)
- [About Models (Web)](https://docs.live2d.com/en/cubism-sdk-manual/model-web/)
- [CubismWebFramework on GitHub](https://github.com/Live2D/CubismWebFramework)
- [CubismWebSamples on GitHub](https://github.com/Live2D/CubismWebSamples)
