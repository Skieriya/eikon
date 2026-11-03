# Models folder

Place your exported Live2D model folders here. A typical model folder contains:

```
models/
└── YourModel/
    ├── YourModel.model3.json   # main settings file
    ├── YourModel.moc3          # model mesh data
    ├── YourModel.physics3.json # physics (optional)
    ├── YourModel.pose3.json    # pose (optional)
    └── YourModel.1024/         # texture atlas folder
        └── texture_00.png
```

Update `CONFIG.modelPath` in `js/app.js` to point to your `.model3.json`,
then refresh the page. The app will load the real model via CubismWebFramework.

Sample models can be obtained from:
- [CubismWebSamples](https://github.com/Live2D/CubismWebSamples) (official samples)
- [nizima](https://nizima.com/en/) (Live2D marketplace — free & paid models)
