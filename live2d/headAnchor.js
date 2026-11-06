// Where is the model's head? The gaze needs a pivot. Measuring the cursor
// offset from the middle of the screen makes the model stare at the middle of
// the page instead of at your cursor, because her head is never in the middle
// of the screen - it rides the top of the art and moves when she is dragged.
//
// The answer comes from the model's own geometry, in its own units, by asking
// which meshes a head-shaped parameter actually moves:
//  - the eye-slide parameter slides the pupils inside the eyes, so the meshes it
//    leaves behind (pupils, lashes, lids, highlights) are the head exactly;
//  - rigs without one (a lot of animal models) still turn the head with a
//    head-angle parameter: the meshes that swing hardest, taken from the top band
//    of the art only, average out onto the head.
// No per-model coordinates, no hand-placed hit areas.

import { createParamLookup } from './paramNames.js';

const MOVE_EPS = 1e-4;    // ignore drift below this (model units)
const KEEP_RATIO = 0.4;   // keep meshes that moved at least this much of the biggest move

export function detectHeadAnchor(model) {
  const lookup = createParamLookup(model);
  const drawableCount = model.getDrawableCount();

  const centroids = () => {
    const out = new Array(drawableCount).fill(null);
    for (let i = 0; i < drawableCount; i++) {
      if (!model.getDrawableDynamicFlagIsVisible(i) || model.getDrawableOpacity(i) <= 0) continue;
      const ps = model.getDrawableVertexPositions(i);
      if (!ps || ps.length < 2) continue;
      let x = 0, y = 0;
      const n = ps.length / 2;
      for (let j = 0; j < ps.length; j += 2) { x += ps[j]; y += ps[j + 1]; }
      out[i] = { x: x / n, y: y / n };
    }
    return out;
  };

  // Rest-pose top band, so a torso lean can't drag the pivot down the body.
  const rest = centroids();
  let artMinY = Infinity, artMaxY = -Infinity;
  for (const c of rest) {
    if (!c) continue;
    if (c.y < artMinY) artMinY = c.y;
    if (c.y > artMaxY) artMaxY = c.y;
  }
  const headBandY = Number.isFinite(artMaxY) ? artMaxY - (artMaxY - artMinY) * 0.30 : -Infinity;

  // loadParameters() before the write is what makes the SDK recompute the
  // drawable geometry for the new pose.
  const pose = (idx, value) => {
    model.loadParameters();
    model.setParameterValueByIndex(idx, value);
    model.update();
    return centroids();
  };

  function anchorOf(name, { bandOnly = false } = {}) {
    const hit = lookup.find(name);
    if (!hit) return null;
    const idx = hit.index;
    const min = model.getParameterMinimumValue(idx);
    const max = model.getParameterMaximumValue(idx);
    if (!(max > min)) return null;

    // Snapshot the rest pose first: loadParameters() is a no-op until something
    // has been saved, so without this the model would stay posed at the extreme.
    model.saveParameters();
    const lo = pose(idx, min);
    const hi = pose(idx, max);
    model.loadParameters();
    model.update();

    let best = 0;
    const moves = new Array(drawableCount).fill(0);
    for (let i = 0; i < drawableCount; i++) {
      if (!lo[i] || !hi[i]) continue;
      if (bandOnly && (!rest[i] || rest[i].y < headBandY)) continue;
      const d = Math.hypot(hi[i].x - lo[i].x, hi[i].y - lo[i].y);
      moves[i] = d;
      if (d > best) best = d;
    }
    if (best < MOVE_EPS) return null;

    let x = 0, y = 0, n = 0;
    for (let i = 0; i < moves.length; i++) {
      if (moves[i] < best * KEEP_RATIO) continue;
      // Average where the meshes sit at rest: their turned positions would skew
      // the pivot toward whichever way the sweep ended.
      const at = rest[i] || hi[i];
      x += at.x; y += at.y; n++;
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  return anchorOf('ParamEyeBallX')
    || anchorOf('ParamAngleX', { bandOnly: true })
    || anchorOf('ParamAngleZ', { bandOnly: true })
    || null;
}
