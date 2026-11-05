// Companion models: small Live2D rigs pinned RELATIVE to a host model, in the
// host's own model-space units (exactly how VTube Studio pin data stores them —
// Hu Tao's ghost beside her hat). Because the transform is composed on top of
// the host's MVP, companions stay glued to her through zoom, pan and fit.
//
// Manifest entry shape:
//   companions: [{ label, model3, x: -0.27, y: 0.81, pin: 'ArtMesh6',
//                  scale: 0.105, rot: 0, flip: false }]
//   x, y   - anchor in host model units (host origin = canvas centre)
//   pin    - optional host mesh id; the anchor rides that mesh, so the companion
//            stays attached when the host turns her head
//   scale  - companion art height as a fraction of the host canvas height
//   rot    - radians (clockwise)
//   flip   - mirror the companion horizontally

import { loadModel } from './loadModel.js';
import { CubismMatrix44 } from '../framework/dist/math/cubismmatrix44.js';
import { CubismFramework } from '../framework/dist/live2dcubismframework.js';

// How far the ghost drifts when the host turns her head (model units per full
// ±30° head rotation). Used only when no pin mesh is given.
const FOLLOW_X = 0.07;
const FOLLOW_Y = 0.05;
const FOLLOW_ROT = 0.18;   // radians of lean at full head turn

// Pointing: while the host aims at something, the companions leave the pin and
// glide to that spot - the nearer one leads, the other trails so they never
// stack. Releasing the aim eases them back onto the pin, so a lost target can
// never strand one mid-air.
const POINT_EASE = 3.0;    // per second: how quickly they arrive and retreat
const POINT_TRAIL = 0.55;  // how far the trailing companion follows
const POINT_LEAN = 0.45;   // radians of tilt at full reach (it points with its body)
const POINT_EDGE = 0.94;   // clamp of the aim in clip space: targets outside the
                           // canvas (a form near the page edge) would fly them off
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Host drawable id -> index (the SDK exposes ids as CubismId objects).
function buildMeshIndex(model) {
  const map = new Map();
  for (let i = 0, n = model.getDrawableCount(); i < n; i++) {
    const o = model.getDrawableId(i);
    const s = (o && (o._id || (o.getString && o.getString()))) || String(o);
    if (s && !map.has(s)) map.set(s, i);
  }
  return map;
}

// Vertex centroid of a drawable, in host model units.
function meshCentroid(model, drawableIndex) {
  const ps = model.getDrawableVertexPositions(drawableIndex);
  if (!ps || ps.length < 2) return null;
  let x = 0, y = 0;
  const n = ps.length / 2;
  for (let i = 0; i < ps.length; i += 2) { x += ps[i]; y += ps[i + 1]; }
  return [x / n, y / n];
}

export async function loadCompanions(entries, { gl, hostModel, shadersPath, onLog }) {
  const idm = CubismFramework.getIdManager();
  const meshIndex = buildMeshIndex(hostModel);
  // Every companion loads at once — their assets are already in the shared cache
  // (live2d/assets.js), so this is decode + upload, and serialising it just adds
  // each model's latency to the next.
  const loaded = await Promise.all((entries || []).map((e) =>
    loadModel({ model3Url: e.model3, gl, shadersPath, onLog: onLog || (() => {}) })
      .then((h) => ({ e, h }))));

  const comps = [];
  for (const { e, h } of loaded) {
    const pinIndex = e.pin ? (meshIndex.has(e.pin) ? meshIndex.get(e.pin) : -1) : -1;
    // Reference centroid of the pin mesh in the host's rest pose: the anchor
    // follows the mesh's live centroid relative to this, so the companion keeps
    // its placed position but still rides the host's head movement.
    const ref = pinIndex >= 0 ? meshCentroid(hostModel, pinIndex) : null;
    comps.push({
      e, h,
      pinIndex,
      ref,
      reach: 0,           // 0 = riding the pin, 1 = fully at the point target
      idAngleX: idm.getId('ParamAngleX'),
      idAngleY: idm.getId('ParamAngleY'),
      idAngleZ: idm.getId('ParamAngleZ'),
    });
    if (onLog) onLog('[LIVE2D] Companion "' + (e.label || e.model3) + '" loaded' +
      (pinIndex >= 0 ? ' pinned to ' + e.pin : ''));
  }

  return {
    count: comps.length,
    comps,

    // Call inside the host's frame, after the host drawModel and before the
    // offscreen endFrameProcess, passing the host's MVP array, dt and - when the
    // host has somewhere to point - the aim as { x, y, strength } in the host
    // canvas's clip space (x -1..1 right, y -1..1 up). strength (default 1) is how
    // far they commit to it; pass null to keep them on their pin.
    updateAndDraw(dt, hostMvpArray, hostModel, aimClip) {
      // Aim point in the host's own model units. The host MVP is scale then
      // translate, so this inversion is exact and follows pan, zoom and the
      // press-squash without the caller having to pass anything else.
      let aim = null;
      if (aimClip) {
        const hsx = hostMvpArray[0], hsy = hostMvpArray[5];
        if (hsx && hsy) {
          const cx = clamp(aimClip.x, -POINT_EDGE, POINT_EDGE);
          const cy = clamp(aimClip.y, -POINT_EDGE, POINT_EDGE);
          aim = {
            x: (cx - hostMvpArray[12]) / hsx,
            y: (cy - hostMvpArray[13]) / hsy,
            strength: clamp(aimClip.strength == null ? 1 : aimClip.strength, 0, 1),
          };
        }
      }
      // The companion placed nearest the target leads; the other trails.
      let lead = null;
      if (aim) {
        let best = Infinity;
        for (const c of comps) {
          const d = Math.abs(aim.x - (c.e.x || 0));
          if (d < best) { best = d; lead = c; }
        }
      }

      for (const c of comps) {
        const m = c.h.model;
        const e = c.e;

        m.loadParameters();
        if (c.h.eyeBlink) c.h.eyeBlink.updateParameters(m, dt);
        if (c.h.breath) c.h.breath.updateParameters(m, dt);
        m.saveParameters();
        if (c.h.physics) c.h.physics.evaluate(m, dt);
        m.update();

        let ax = e.x || 0, ay = e.y || 0, fr = e.rot || 0;

        if (c.pinIndex >= 0 && c.ref) {
          // Ride the pinned mesh: keep the placed anchor, add the mesh's motion.
          const live = meshCentroid(hostModel, c.pinIndex);
          if (live) {
            ax += live[0] - c.ref[0];
            ay += live[1] - c.ref[1];
          }
        } else if (e.follow !== false) {
          // Head-follow offset: read the host's CURRENT head angles (set by the
          // point rig this frame, before model.update()).
          const deg = (id) => {
            const idx = hostModel.getParameterIndex(id);
            // Out-of-range guard: this SDK returns bogus indices for unknown ids.
            if (idx < 0 || idx >= hostModel.getParameterCount()) return 0;
            const v = hostModel.getParameterValueByIndex(idx);
            return typeof v === 'number' && Number.isFinite(v) ? v : 0;
          };
          ax += (deg(c.idAngleX) / 30) * FOLLOW_X;
          ay += (deg(c.idAngleY) / 30) * FOLLOW_Y;
          fr += (deg(c.idAngleZ) / 30) * FOLLOW_ROT;
        }

        // Glide toward the point target, and back to the pin when there is
        // nothing to point at - reach is eased, so they never snap or strand.
        const want = aim ? aim.strength * (c === lead ? 1 : POINT_TRAIL) : 0;
        c.reach += (want - c.reach) * Math.min(1, (dt || 0.016) * POINT_EASE);
        if (aim && c.reach > 0.001) {
          ax += (aim.x - ax) * c.reach;
          ay += (aim.y - ay) * c.reach;
          // Lean into the travel direction (from where they live, so the tilt
          // holds while she keeps pointing).
          fr += c.reach * POINT_LEAN * clamp((aim.x - (e.x || 0)) / 0.5, -1, 1) * (e.flip ? -1 : 1);
        }

        // Where this companion actually ended up this frame, in host model units
        // (also handy when verifying a glide from the outside).
        c.anchor = [ax, ay, fr];

        // local = T(x, y) * R(rot) * S(gs) [* mirror-x when e.flip], column-major;
        // gs maps the companion's canvas units onto the requested fraction of
        // host height. (VTS stores the Nervous ghost mirrored.)
        const gs = (e.scale || 0.135) * hostModel.getCanvasHeight() / m.getCanvasHeight();
        const cos = Math.cos(fr) * gs, sin = Math.sin(fr) * gs;
        const mir = e.flip ? -1 : 1;
        const local = new Float32Array([
          cos * mir, sin * mir, 0, 0,
          -sin, cos, 0, 0,
          0, 0, 1, 0,
          ax, ay, 0, 1,
        ]);
        // SDK matrices are row-vector (v' = v * M) and multiply(a, b) means
        // "apply a, THEN b" — so local must come first or the anchor lands in
        // raw clip space instead of riding the host transform.
        const final = new Float32Array(16);
        CubismMatrix44.multiply(local, hostMvpArray, final);
        const proj = new CubismMatrix44();
        proj.setMatrix(final);
        c.h.renderer.setMvpMatrix(proj);
        // The renderer sizes its mask buffers from the render state — without
        // this the masked drawables (the ghost's face!) silently draw nothing.
        c.h.renderer.setRenderState(null, [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight]);
        c.h.renderer.drawModel(shadersPath);
      }
    },
  };
}
