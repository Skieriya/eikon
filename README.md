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

1. Open `index.html` in any modern browser, or serve it with a local server:
   ```bash
   # Python 3
   python -m http.server 8000

   # Node (npx serve)
   npx serve .
   ```
2. Visit `http://localhost:8000`.
3. You'll see the demo character in **DEMO MODE**. Move your mouse over the
   canvas, click the expression/motion buttons, and watch the parameter panel.

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
