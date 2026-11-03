# SDK folder

Place the downloaded **Cubism SDK for Web** files here.

Required layout (after download from https://www.live2d.com/en/sdk/download/web/):

```
sdk/
├── Core/
│   └── ...                # Cubism Core for Web (from the SDK package)
└── Framework/
    └── live2dcubismframework.js   # built framework (or your built output)
```

Then uncomment the SDK `<script>` tag(s) in `index.html` (see the commented
block near the top of `<head>`) and point `CONFIG.modelPath` in `js/app.js`
at your `.model3.json` file inside `models/`.

> Cubism Core is not open source and is only available in the official SDK
> package after free registration on live2d.com. Do not commit downloaded SDK
> binaries to public repositories without checking the Live2D license.
