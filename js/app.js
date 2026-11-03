/* ========================================================================
   Live2D Cubism Web Example — Application Entry Point
   ========================================================================

   This file does two things:
     1. Provides a fully working LIVE DEMO character (Canvas 2D) so this
        page runs immediately, even without the Live2D SDK.
     2. Contains the REAL CubismWebFramework integration code (guarded behind
        `if (window.Live2DCubismFramework)`). Once you drop the downloaded
        Cubism SDK into `sdk/` and uncomment the <script> tags in index.html,
        the real model will load automatically.

   Read README.md for step-by-step setup instructions.
   ======================================================================== */

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------
const CONFIG = {
  // Path to your exported model folder (relative to this HTML file).
  // Example: models/Hiyori/Hiyori.model3.json
  modelPath: "models/Hiyori/Hiyori.model3.json",

  // Canvas element
  canvasSelector: "#live2d-canvas",

  // Whether the real SDK is available (set during init)
  useRealSdk: false,
};

// --------------------------------------------------------------------------
// DOM references
// --------------------------------------------------------------------------
const canvas = document.querySelector(CONFIG.canvasSelector);
const ctx = canvas.getContext("2d");

const modeBanner = document.getElementById("mode-banner");
const statusChip = document.getElementById("status-chip");
const modelNameEl = document.getElementById("model-name");

// Parameter value displays
const paramEls = {
  angleX: document.getElementById("val-angle-x"),
  angleY: document.getElementById("val-angle-y"),
  angleZ: document.getElementById("val-angle-z"),
  eyeX: document.getElementById("val-eye-x"),
  eyeY: document.getElementById("val-eye-y"),
  mouth: document.getElementById("val-mouth"),
};

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;
const deg2rad = (deg) => (deg * Math.PI) / 180;
const rand = (min, max) => Math.random() * (max - min) + min;

function setStatus(text, type = "loading") {
  statusChip.textContent = text;
  statusChip.className = "status-chip";
  if (type === "ok") statusChip.classList.add("status-ok");
  else if (type === "loading") statusChip.classList.add("status-loading");
}

function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

// --------------------------------------------------------------------------
// Real SDK integration (CubismWebFramework)
// --------------------------------------------------------------------------
// This block only runs if the real Live2D SDK files are loaded via <script>
// tags in index.html. Until then, useRealSdk stays false and the demo runs.
async function initRealSdk() {
  try {
    // The built framework is expected at sdk/Framework/live2dcubismframework.js
    // and exposes window.Live2DCubismFramework.
    if (!window.Live2DCubismFramework) {
      throw new Error("Live2DCubismFramework not found on window");
    }

    const {
      CubismFramework,
      CubismModelSettingJson,
      CubismMoc,
      CubismRenderer_WebGL,
      LogLevel,
      Option,
    } = window.Live2DCubismFramework;

    // 1. Set up logging options
    const option = new Option();
    option.logFunction = (message) => {
      console.log("[Cubism]", message);
    };
    option.loggingLevel = LogLevel.LogLevel_Verbose;

    // 2. Start up & initialize CubismFramework
    CubismFramework.startUp(option);
    CubismFramework.initialize();

    setStatus("SDK loaded — fetching model…", "loading");

    // 3. Load .model3.json
    const res = await fetch(CONFIG.modelPath);
    if (!res.ok) throw new Error(`Failed to load model3.json: ${res.status}`);
    const buffer = await res.arrayBuffer();
    const setting = new CubismModelSettingJson(buffer, buffer.byteLength);

    // 4. Load .moc3 and create model
    const mocPath = new URL(setting.getModelFileName(), CONFIG.modelPath).href;
    const mocRes = await fetch(mocPath);
    const mocBuffer = await mocRes.arrayBuffer();
    const moc = CubismMoc.create(mocBuffer);
    const model = moc.createModel();

    // 5. Create WebGL renderer
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) throw new Error("WebGL not supported");
    const renderer = new CubismRenderer_WebGL();
    renderer.initialize(gl);
    renderer.bindModel(model);

    // 6. Load textures
    const textureCount = setting.getTextureCount();
    const textures = [];
    for (let i = 0; i < textureCount; i++) {
      const texPath = new URL(setting.getTextureFileName(i), CONFIG.modelPath).href;
      const tex = await loadTexture(gl, texPath);
      textures.push(tex);
      renderer.bindTexture(i, tex);
    }

    CONFIG.useRealSdk = true;
    modelNameEl.textContent = CONFIG.modelPath.split("/").pop().replace(".model3.json", "");
    setStatus("Real Live2D model running", "ok");
    modeBanner.className = "mode-banner mode-real";
    modeBanner.innerHTML =
      '<strong>REAL SDK MODE</strong> — Live2D model loaded successfully. <button id="btn-close-sdk-help" class="btn btn-outline btn-sm">Dismiss</button>';
    document
      .getElementById("btn-close-sdk-help")
      .addEventListener("click", () => (modeBanner.style.display = "none"));

    showToast("Real Live2D SDK loaded!");

    // 7. Animation loop for real model
    let lastTime = performance.now();
    function realLoop(now) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      // Update parameters here based on input / time
      // Example: model.setParameterValueById(id, value);

      model.update();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.drawModel();

      requestAnimationFrame(realLoop);
    }
    requestAnimationFrame(realLoop);

    return { model, renderer, setting, moc, textures, gl };
  } catch (err) {
    console.error("Real SDK initialization failed:", err);
    showToast("Real SDK not available — running demo mode", "error");
    return null;
  }
}

function loadTexture(gl, url) {
  return new Promise((resolve, reject) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 1x1 placeholder so it's immediately usable
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 255, 255])
    );

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      resolve(tex);
    };
    img.onerror = () => reject(new Error(`Failed to load texture: ${url}`));
    img.src = url;
  });
}

// --------------------------------------------------------------------------
// Demo character (Canvas 2D) — runs immediately without the SDK
// --------------------------------------------------------------------------
class DemoModel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = canvas.width;
    this.height = canvas.height;

    // Simulated Live2D parameters (the same IDs a real model would use)
    this.params = {
      ParamAngleX: 0, // -30..30 (face left/right)
      ParamAngleY: 0, // -30..30 (face up/down)
      ParamAngleZ: 0, // -30..30 (face roll)
      ParamEyeBallX: 0, // -1..1 (eye look left/right)
      ParamEyeBallY: 0, // -1..1 (eye look up/down)
      ParamMouthOpenY: 0, // 0..1 (mouth open)
    };

    // Targets (smoothed toward by lerp)
    this.targets = { ...this.params };

    // State
    this.blink = 0; // 1 = open, 0 = closed
    this.blinkTimer = 0;
    this.expression = "neutral"; // neutral | happy | surprised | sad
    this.mouthTalkTimer = 0;
    this.time = 0;

    // Mouse / pointer
    this.mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
    this.center = { x: this.width / 2, y: this.height / 2 };

    this._bindEvents();
    this._startBlinkLoop();
  }

  _bindEvents() {
    const move = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.targetX = (e.clientX - rect.left) / this.width; // 0..1
      this.mouse.targetY = (e.clientY - rect.top) / this.height; // 0..1
    };
    this.canvas.addEventListener("mousemove", move);
    this.canvas.addEventListener("touchmove", (e) => {
      move(e.touches[0]);
    });

    // Click -> "tap" motion
    this.canvas.addEventListener("mousedown", () => {
      this.targets.ParamMouthOpenY = 0.6;
      this.mouthTalkTimer = 0.8;
      this.expression = "happy";
      setTimeout(() => {
        this.expression = "neutral";
      }, 600);
    });
  }

  _startBlinkLoop() {
    const blink = () => {
      this.blink = 0;
      setTimeout(() => {
        this.blink = 1;
        const next = rand(1500, 4500);
        setTimeout(blink, next);
      }, rand(80, 150));
    };
    setTimeout(blink, rand(2000, 5000));
  }

  // Public API mirrored from real SDK usage so UI buttons work in both modes
  setExpression(name) {
    this.expression = name;
  }

  setMouthOpen(v) {
    this.targets.ParamMouthOpenY = clamp(v, 0, 1);
  }

  update(dt) {
    this.time += dt;

    // Smooth mouse -> head angle (simulates ParamAngleX/Y/Z)
    this.mouse.x = lerp(this.mouse.x, this.mouse.targetX, 0.1);
    this.mouse.y = lerp(this.mouse.y, this.mouse.targetY, 0.1);

    const dx = this.mouse.x - 0.5;
    const dy = this.mouse.y - 0.5;

    this.targets.ParamAngleX = dx * 30; // -15..15 deg
    this.targets.ParamAngleY = -dy * 20;
    this.targets.ParamAngleZ = dx * 10;

    // Eyes follow mouse a little
    this.targets.ParamEyeBallX = dx * 1.2;
    this.targets.ParamEyeBallY = dy * 1.2;

    // Smooth all params toward targets (like Cubism's parameter smoothing)
    for (const key of Object.keys(this.params)) {
      this.params[key] = lerp(this.params[key], this.targets[key], 0.15);
    }

    // Blink animation (ease out)
    if (this.blink < 1) {
      this.blink = lerp(this.blink, 1, 0.25);
    }

    // Talking mouth
    if (this.mouthTalkTimer > 0) {
      this.mouthTalkTimer -= dt;
      const talk = Math.abs(Math.sin(this.time * 15)) * 0.4;
      this.targets.ParamMouthOpenY = talk;
    } else if (this.expression === "surprised") {
      this.targets.ParamMouthOpenY = 0.35 + Math.sin(this.time * 3) * 0.05;
    } else if (this.expression === "happy") {
      this.targets.ParamMouthOpenY = 0.1 + Math.sin(this.time * 2) * 0.05;
    } else if (this.expression === "sad") {
      this.targets.ParamMouthOpenY = 0.05;
    } else {
      this.targets.ParamMouthOpenY = 0.02 + Math.sin(this.time * 1.5) * 0.02;
    }
  }

  draw() {
    const c = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2 + 20;

    c.clearRect(0, 0, w, h);

    const ax = this.params.ParamAngleX;
    const ay = this.params.ParamAngleY;
    const az = this.params.ParamAngleZ;

    // Save & apply subtle head tilt transform
    c.save();
    c.translate(cx, cy);
    c.rotate(deg2rad(az * 0.6));

    // ---- Neck ----
    c.fillStyle = "#d7a894";
    c.beginPath();
    c.ellipse(0, 55, 28, 40, deg2rad(ax * 0.2), 0, Math.PI * 2);
    c.fill();

    // ---- Face base ----
    c.save();
    c.translate(0, -10);
    c.rotate(deg2rad(ax * 0.5));
    c.scale(1 - Math.abs(ax) * 0.004, 1 - Math.abs(ay) * 0.003);

    c.fillStyle = "#fce7d3";
    c.beginPath();
    c.ellipse(0, 0, 110, 125, 0, 0, Math.PI * 2);
    c.fill();

    // Blush
    const blush = this.expression === "happy" ? 0.5 : 0;
    c.fillStyle = `rgba(255, 120, 150, ${blush * 0.35})`;
    c.beginPath();
    c.ellipse(-65, 12, 26, 18, 0, 0, Math.PI * 2);
    c.ellipse(65, 12, 26, 18, 0, 0, Math.PI * 2);
    c.fill();

    // ---- Eyes ----
    this._drawEyes();

    // ---- Mouth ----
    this._drawMouth();

    // ---- Hair (simple bangs + sides) ----
    this._drawHair();

    c.restore(); // face
    c.restore(); // head transform
  }

  _drawEyes() {
    const c = this.ctx;
    const blink = this.blink; // 1 open, 0 closed
    const ex = this.params.ParamEyeBallX;
    const ey = this.params.ParamEyeBallY;

    const eyeY = 8;
    const eyeSeparation = 52;

    const drawEye = (dx, mirror) => {
      c.save();
      c.translate(dx * mirror, eyeY);

      // Eye white
      c.fillStyle = "#ffffff";
      c.beginPath();
      c.ellipse(0, 0, 26 * blink + 2, 14 * blink + 2, 0, 0, Math.PI * 2);
      c.fill();

      // Eyelid top (always drawn, thickens when blinking)
      c.fillStyle = "#5b4a42";
      c.beginPath();
      c.moveTo(-28, -10);
      c.bezierCurveTo(0, -14 + (1 - blink) * 10, 0, -14 + (1 - blink) * 10, 28, -10);
      c.lineTo(28, 10);
      c.bezierCurveTo(0, 10 - (1 - blink) * 8, 0, 10 - (1 - blink) * 8, -28, 10);
      c.closePath();
      c.fill();

      // Iris + pupil
      const irisX = ex * 8 * mirror;
      const irisY = ey * 6;

      c.fillStyle = "#6ee7b7";
      c.beginPath();
      c.arc(irisX, irisY, 10, 0, Math.PI * 2);
      c.fill();

      c.fillStyle = "#111827";
      c.beginPath();
      c.arc(irisX + 2 * mirror, irisY - 2, 4.5, 0, Math.PI * 2);
      c.fill();

      // Eye highlight
      c.fillStyle = "rgba(255,255,255,0.9)";
      c.beginPath();
      c.arc(irisX - 3 * mirror, irisY - 4, 2.5, 0, Math.PI * 2);
      c.fill();

      // Upper lash line
      c.strokeStyle = "#2d2320";
      c.lineWidth = 2.5;
      c.beginPath();
      c.moveTo(-22, -8);
      c.bezierCurveTo(0, -11, 0, -11, 22, -8);
      c.stroke();

      c.restore();
    };

    drawEye(-eyeSeparation / 2, 1);
    drawEye(eyeSeparation / 2, -1);
  }

  _drawMouth() {
    const c = this.ctx;
    const open = this.params.ParamMouthOpenY;
    const cx = 0;
    const cy = 38;

    c.save();
    c.translate(cx, cy);

    // Mouth line (closed)
    c.strokeStyle = "#7f1d1d";
    c.lineWidth = 3;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(-14, 0);
    c.bezierCurveTo(0, 2, 0, 2, 14, 0);
    c.stroke();

    // Open mouth when talking / surprised
    if (open > 0.05) {
      c.fillStyle = "#450a0a";
      c.beginPath();
      c.moveTo(-10 * open, 4);
      c.bezierCurveTo(0, 8 + open * 20, 0, 8 + open * 20, 10 * open, 4);
      c.lineTo(8 * open, 4 + open * 6);
      c.bezierCurveTo(0, 6 + open * 8, 0, 6 + open * 8, -8 * open, 4 + open * 6);
      c.closePath();
      c.fill();

      // Tongue
      c.fillStyle = "#e95460";
      c.beginPath();
      c.ellipse(0, 10 + open * 10, 6 * open, 4 * open, 0, 0, Math.PI * 2);
      c.fill();
    }

    // Smile curve for happy
    if (this.expression === "happy" && open < 0.2) {
      c.strokeStyle = "#7f1d1d";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(-10, 2);
      c.quadraticCurveTo(0, 6, 10, 2);
      c.stroke();
    }

    c.restore();
  }

  _drawHair() {
    const c = this.ctx;
    const c1 = "#1e293b";
    const c2 = "#334155";

    c.save();
    c.translate(0, -20);

    // Back hair mass
    c.fillStyle = c1;
    c.beginPath();
    c.ellipse(0, 10, 105, 115, 0, 0, Math.PI * 2);
    c.fill();

    // Bangs (front)
    c.fillStyle = c1;
    c.beginPath();
    c.moveTo(-70, -15);
    c.bezierCurveTo(-70, -35, -40, -45, 0, -30);
    c.bezierCurveTo(40, -45, 70, -35, 70, -15);
    c.bezierCurveTo(75, 10, 55, 20, 0, 25);
    c.bezierCurveTo(-55, 20, -75, 10, -70, -15);
    c.fill();

    // Side locks
    [ -1, 1 ].forEach((side) => {
      c.fillStyle = c2;
      c.beginPath();
      c.moveTo(side * 30, -10);
      c.bezierCurveTo(side * 55, 5, side * 75, 45, side * 60, 90);
      c.bezierCurveTo(side * 50, 100, side * 30, 70, side * 20, 40);
      c.bezierCurveTo(side * 10, 10, side * 20, -10, side * 30, -10);
      c.fill();
    });

    c.restore();
  }
}

// --------------------------------------------------------------------------
// Application controller
// --------------------------------------------------------------------------
class App {
  constructor() {
    this.model = null;
    this.real = null;
    this.demo = null;
    this.lastTime = performance.now();
    this.running = false;
  }

  async init() {
    // Attempt real SDK first
    const real = await initRealSdk();
    this.real = real;

    if (!CONFIG.useRealSdk) {
      // Fall back to demo
      this.demo = new DemoModel(canvas);
      this.model = "demo";
      modeBanner.style.display = "flex";
      setStatus("Demo mode — SDK not found", "loading");
      showToast(
        "Demo mode active. Download the Cubism SDK for Web to load a real .moc3 model.",
        "error"
      );
    } else {
      this.model = "real";
    }

    this.running = true;
    this.loop();
  }

  loop(now) {
    if (!this.running) return;
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Update parameters display
    if (this.model === "demo") {
      this.demo.update(dt);
      this.demo.draw();
      this._updateParamDisplay(
        this.demo.params.ParamAngleX,
        this.demo.params.ParamAngleY,
        this.demo.params.ParamAngleZ,
        this.demo.params.ParamEyeBallX,
        this.demo.params.ParamEyeBallY,
        this.demo.params.ParamMouthOpenY
      );
    }

    requestAnimationFrame((t) => this.loop(t));
  }

  _updateParamDisplay(ax, ay, az, ex, ey, mouth) {
    const f = (v) => v.toFixed(2);
    paramEls.angleX.textContent = f(ax);
    paramEls.angleY.textContent = f(ay);
    paramEls.angleZ.textContent = f(az);
    paramEls.eyeX.textContent = f(ex);
    paramEls.eyeY.textContent = f(ey);
    paramEls.mouth.textContent = f(mouth);
  }

  // Public actions used by UI buttons
  setExpression(name) {
    if (this.model === "demo" && this.demo) this.demo.setExpression(name);
  }

  setMouthOpen(v) {
    if (this.model === "demo" && this.demo) this.demo.setMouthOpen(v);
  }
}

// --------------------------------------------------------------------------
// UI wiring
// --------------------------------------------------------------------------
const app = new App();

// Expression / motion buttons
document.querySelectorAll(".btn[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    if (action.startsWith("expr-")) {
      const name = action.replace("expr-", "");
      app.setExpression(name);
      showToast(`Expression: ${name}`);
    } else if (action === "motion-idle") {
      app.setMouthOpen(0.02);
      showToast("Motion: idle");
    } else if (action === "motion-tap") {
      app.setMouthOpen(0.7);
      showToast("Motion: tap");
    }
  });
});

document.getElementById("btn-switch-model").addEventListener("click", () => {
  showToast("Switch models by replacing models/ and updating CONFIG.modelPath in js/app.js");
});

// Start
app.init();
