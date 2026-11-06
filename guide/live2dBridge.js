// Generic Live2D gaze bridge. No page knowledge — it only needs the model's canvas
// and (optionally) the CubismLook + model to drive, or an onAim callback for apps
// that render their own way. Any site can create it with its own handles; the guide
// module talks to it through one small contract, so "look at this element" uses the
// exact same screen->clip geometry a mouse cursor would.

const clamp = (v) => Math.max(-1, Math.min(1, v));

export function createLive2dGuideBridge(config = {}) {
  const {
    canvas,
    sensitivity = 2.0,      // cursor->gaze gain (how fast the head reaches full turn)
    smoothing = 12.0,       // gaze easing speed (higher = snappier)
    lookYSign = -1,         // CubismLook wants +Y = up; most cursor feeds are +Y = down
    onGesture,              // optional: play a guiding motion
    maxPan = Infinity,      // optional clamp on how far the model can be dragged
  } = config;

  if (!canvas) throw new Error('createLive2dGuideBridge: `canvas` is required');

  // Live gaze + pan state, all in clip space (x -1..1 right, y -1..1 up).
  const s = {
    curX: 0, curY: 0,       // last aim point (cursor or guide target)
    originX: 0, originY: 0, // gaze pivot: the model's head, in clip space
    offsetX: 0, offsetY: 0, // model pan centre
    mouseX: 0, mouseY: 0,   // gaze target (clamped)
    dragX: 0, dragY: 0,     // smoothed gaze (what the model sees)
    held: false,            // guide has taken over from the mouse
    targetEl: null,         // DOM element the current hold points at, if any
    frozen: false,          // gaze is held while the host drags the model
  };

  const rect = () => canvas.getBoundingClientRect();

  function screenToClip(clientX, clientY) {
    const r = rect();
    return { x: (clientX - r.left) / r.width * 2 - 1, y: -((clientY - r.top) / r.height * 2 - 1) };
  }
  function clipToScreen(x, y) {
    const r = rect();
    return { x: r.left + (x + 1) / 2 * r.width, y: r.top + (1 - y) / 2 * r.height };
  }
  // Point the gaze at a clip location; keeps the same relation to the pivot the
  // mouse uses. The pivot is the model's head (see setOrigin), so "left" means
  // "left of her head" no matter where she stands on screen.
  function setGazeClip(cx, cy) {
    s.curX = cx; s.curY = cy;
    s.mouseX = clamp((cx - s.originX) * sensitivity);
    s.mouseY = clamp(-(cy - s.originY) * sensitivity);
  }

  const bridge = {
    // host can attach the real look/model once the app initializes them.
    model: config.model || null,
    look: config.look || null,

    canvasEl: () => canvas,
    screenToClip, clipToScreen,
    curClip: () => ({ x: s.curX, y: s.curY }),
    offsetClip: () => ({ x: s.offsetX, y: s.offsetY }),
    originClip: () => ({ x: s.originX, y: s.originY }),
    setGazeClip,
    // Move the gaze pivot (the model's head, in clip space). The host updates
    // it every frame, because the head travels with the pan and the squash.
    setOrigin(x, y) {
      s.originX = x; s.originY = y;
      if (!s.held && !s.frozen) setGazeClip(s.curX, s.curY);
    },
    // Freeze the gaze while the host drags the model. Without this, panning
    // moves the pivot away from the cursor and she re-aims (and leans) the
    // instant she is carried, which fights the drag.
    freezeGaze(on) {
      s.frozen = !!on;
      if (!s.frozen && !s.held) setGazeClip(s.curX, s.curY);
    },
    holdGaze: (on) => { s.held = !!on; },
    isHeld: () => s.held,
    // Which DOM element the current hold refers to, when there is one. The gaze
    // only needs the point; hosts that want to place something BESIDE the target
    // (a companion, a highlight) need its box, and this keeps them out of the
    // guide module's internals.
    setTargetElement: (el) => { s.targetEl = el || null; },
    targetElement: () => s.targetEl,
    gaze: () => ({ mouseX: s.mouseX, mouseY: s.mouseY, dragX: s.dragX, dragY: s.dragY }),
    get state() { return s; },

    // Call once per frame from the host's render loop, where you'd normally call
    // look.updateParameters(). Eases the gaze and applies it; returns the vector so
    // apps that also steer an arm/params can reuse it.
    tick(dt) {
      const lerp = Math.min(1, (dt || 0.016) * smoothing);
      s.dragX += (s.mouseX - s.dragX) * lerp;
      s.dragY += (s.mouseY - s.dragY) * lerp;
      if (bridge.model && bridge.look) bridge.look.updateParameters(bridge.model, s.dragX, lookYSign * s.dragY);
      return { x: s.dragX, y: s.dragY };
    },

    // --- optional host-input plumbing (mirrors the validated mouse/drag model) ---
    pointerMove(clientX, clientY) {
      const c = screenToClip(clientX, clientY);
      if (s.held) return;
      // While frozen, still remember where the cursor IS, so releasing the freeze
      // re-aims at the real position instead of a stale one.
      if (s.frozen) { s.curX = c.x; s.curY = c.y; return; }
      setGazeClip(c.x, c.y);
    },
    panByPixels(dxPx, dyPx) {
      const r = rect();
      // Clip space has +Y up, so dragging down (dyPx > 0) must lower the model.
      s.offsetX = clampPan(s.offsetX + dxPx * (2 / r.width));
      s.offsetY = clampPan(s.offsetY - dyPx * (2 / r.height));
      if (!s.held && !s.frozen) setGazeClip(s.curX, s.curY);
    },
    resetPan() { s.offsetX = 0; s.offsetY = 0; if (!s.held && !s.frozen) setGazeClip(s.curX, s.curY); },
    gesture() { if (typeof onGesture === 'function') onGesture(); },

    // Convenience used directly and by tests: aim at a screen pixel and hold.
    lookAtScreen(clientX, clientY, hold = true) {
      const c = screenToClip(clientX, clientY);
      bridge.holdGaze(hold);
      setGazeClip(c.x, c.y);
      return c;
    },
  };

  function clampPan(v) { return Number.isFinite(maxPan) ? Math.max(-maxPan, Math.min(maxPan, v)) : v; }

  return bridge;
}
