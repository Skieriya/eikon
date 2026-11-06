// Generic full-body pointing for any Live2D Cubism model. Instead of guessing
// how much each parameter should turn, it measures what every candidate
// parameter does to the art at init: each one is swept across its own range and
// the resulting FACE displacement (model units) is recorded. The gaze then asks
// for a travel budget — "move her face a few percent of the art height toward
// the cursor" — and divides it across the parameters that actually move the
// face, in the direction each one moves it.
//
// Measuring beats naming, because rigs lie: Hu Tao's ParamAngleX feeds physics,
// which writes ParamAngleX2 (so the *2 id moves the art but cannot be steered,
// and the plain id can), torso ids can move the head further than the head ids,
// and mirrored conventions flip signs. Every one of those self-corrects here.
//
// Sweeping is by far the most expensive thing in bring-up, so the measured table
// is cached against a fingerprint of the parameter set (localStorage unless
// opts.storage says otherwise; opts.cacheKey labels the entry, opts.cache = false
// skips it). opts.pace can hand an animation frame back between probes, which is
// what lets a host paint the model first and calibrate afterwards.

import { createParamLookup } from './paramNames.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A parameter that moves less than this across its WHOLE sweep is wired to
// nothing in the moc, so giving it a share of the budget would just lose it.
const DEAD_MOVE = 1e-4;
// Below this, the direction the face moves in is too small to read a sign from.
const SIGN_EPS = 1e-3;
// Physics evaluations run per probe pose so a physics-fed parameter is measured
// by its real-world effect. Enough to let a pendulum settle, few enough to keep
// model bring-up fast.
const SETTLE_STEPS = 10;
// A group member must move the face at least this far (as a fraction of the
// member that moves it most) to count as steerable.
const TIER_SHARE = 0.25;
// localStorage namespace for cached parameter sweeps. Bump it if the shape of the
// measured table ever changes.
const CACHE_NS = 'l2drig1:';

// Travel = fraction of the art HEIGHT that the FACE covers at full gaze
// (|dir| = 1), so the numbers mean the same thing on every rig.
export const RIG = {
  HEAD_TRAVEL: 0.07,    // head + neck roll answer the cursor together
  BODY_TRAVEL: 0.045,   // torso follow-through, kept under the head so it reads
  HEAD_Y_TRAVEL: 0.9,   // of HEAD_TRAVEL: looking up/down tilts a touch less
  BODY_Y_TRAVEL: 0.5,   // of BODY_TRAVEL
  EYE_REACH: 1.0,       // pupils always go to the extremes of their own span
  ARM_REACH: 1.0,       // arm joints sweep their entire range (was capped ~0.7)
  ARM_CONTROL: 0.9,     // 0..1 cursor authority vs the idle clip's own sway
  POINT_BOOST: 1.7,     // extra travel while the guide holds a UI element, so
                        // even a centre-screen element gets a full turn-and-point
};

export async function createPointRig(model, opts = {}) {
  const idManager = opts.idManager;
  if (!idManager) throw new Error('createPointRig: pass opts.idManager (CubismFramework.getIdManager())');
  // Optional async pause called between parameter probes. Measuring every
  // candidate costs a few hundred model.update() calls (~2 s on a big rig), and
  // hosts that already show the model while calibrating use this to hand a frame
  // back to the renderer in between. Omit it and the whole thing runs in one
  // synchronous pass, exactly as before.
  const pace = typeof opts.pace === 'function' ? opts.pace : null;
  const step = () => (pace ? Promise.resolve(pace()) : Promise.resolve());

  const drawableCount = model.getDrawableCount();
  const lookup = createParamLookup(model);

  function centroidArray() {
    const out = new Array(drawableCount).fill(null);
    for (let i = 0; i < drawableCount; i++) {
      if (!model.getDrawableDynamicFlagIsVisible(i) || model.getDrawableOpacity(i) <= 0) continue;
      const ps = model.getDrawableVertexPositions(i);
      if (!ps || ps.length < 2) continue;
      let x = 0, y = 0;
      const k = ps.length / 2;
      for (let j = 0; j < ps.length; j += 2) { x += ps[j]; y += ps[j + 1]; }
      out[i] = [x / k, y / k];
    }
    return out;
  }

  // Rest-pose head band (top 30 % of the art): the sign of an axis is read from
  // where the FACE goes, so hair tips and a swaying skirt can't flip it.
  const rest = centroidArray();
  let artMinY = Infinity, artMaxY = -Infinity;
  for (const c of rest) {
    if (!c) continue;
    if (c[1] < artMinY) artMinY = c[1];
    if (c[1] > artMaxY) artMaxY = c[1];
  }
  const headBandY = Number.isFinite(artMaxY) ? artMaxY - (artMaxY - artMinY) * 0.30 : -Infinity;
  const artHeight = Number.isFinite(artMaxY) ? artMaxY - artMinY : 1;

  // Sweep one parameter across its full range and diff the drawable centroids.
  // loadParameters() before the write is what makes the SDK rebuild the geometry.
  //
  // The physics rig gets to react before we read the art back, which is what
  // makes the measurement honest: many rigs (Hu Tao included) wire ParamAngleX
  // into physics, which then writes ParamAngleX2 - so the *2 id is what moves
  // the art but cannot be steered, and only the input id is steerable. Probing
  // with physics settles that without reading the physics file.
  const physics = opts.physics || null;
  function settle(idx, value) {
    model.loadParameters();
    model.setParameterValueByIndex(idx, value);
    for (let k = 0; k < SETTLE_STEPS; k++) {
      if (physics) physics.evaluate(model, 1 / 60);
      model.update();
    }
    return centroidArray();
  }

  function measure(idx, min, max) {
    const hi = settle(idx, max);
    const lo = settle(idx, min);
    model.loadParameters();
    if (physics) for (let k = 0; k < SETTLE_STEPS; k++) physics.evaluate(model, 1 / 60);
    model.update();
    let head = 0, total = 0, hx = 0, hy = 0, tx = 0, ty = 0;
    for (let j = 0; j < drawableCount; j++) {
      if (!hi[j] || !lo[j]) continue;
      const dx = hi[j][0] - lo[j][0], dy = hi[j][1] - lo[j][1];
      const d = Math.hypot(dx, dy);
      if (d <= 0) continue;
      total += d; tx += dx * d; ty += dy * d;
      if (rest[j] && rest[j][1] > headBandY) { head += d; hx += dx * d; hy += dy * d; }
    }
    const face = head >= total * 0.1 ? head : total;   // head-anchored where possible
    const fx = head >= total * 0.1 ? hx : tx;
    const fy = head >= total * 0.1 ? hy : ty;
    return {
      move: total,
      dx: face > SIGN_EPS ? fx / face : 0,
      dy: face > SIGN_EPS ? fy / face : 0,
    };
  }

  // Everything the rig needs from measurement is plain data: the parameter name
  // and its measured span + face displacement. The CubismId is re-resolved from
  // the name on load, which makes the whole table cacheable - and it must be,
  // because sweeping every candidate through its own physics-settled range is the
  // single most expensive thing in bring-up (tens of seconds on a rig as big as
  // Hu Tao's) and the answer never changes for the same model.
  async function measureTable() {
    // Resolve a parameter by id into { name, mid, half, min, max, sx, sy }; null
    // if absent or if it moves nothing. The name is matched in any spelling (see
    // paramNames.js), and the id handed back is the moc's own.
    const probe = async (name) => {
      const hit = lookup.find(name);
      if (!hit) return null;
      const idx = hit.index;
      const min = model.getParameterMinimumValue(idx);
      const max = model.getParameterMaximumValue(idx);
      if (!(max > min)) return null;
      const m = measure(idx, min, max);
      // measure() leaves the model back on its rest pose, so this is the one point
      // in the sweep where handing a frame back is safe. Probes must stay strictly
      // sequential: two interleaved sweeps would measure each other's poses.
      await step();
      if (m.move <= DEAD_MOVE) return null;
      return {
        name: hit.name, min, max, mid: (min + max) / 2, half: (max - min) / 2,
        // Face displacement (model units) this parameter produces across its own
        // sweep: its size is the cost, its sign is the direction.
        dX: m.dx, dY: m.dy,
        sx: m.dx > SIGN_EPS ? 1 : m.dx < -SIGN_EPS ? -1 : 1,
        sy: m.dy > SIGN_EPS ? 1 : m.dy < -SIGN_EPS ? -1 : 1,
      };
    };

    // Collect live tiers per axis: ParamAngleX, ParamAngleX2, ... A rig that splits
    // head motion across two ids is fine; one that wires the first to nothing
    // simply ends up with a single (full-range) tier.
    const collectTiers = async (prefix, axis) => {
      const tiers = [];
      for (const suffix of ['', '2', '3', '4']) {
        const p = await probe(prefix + axis + suffix);
        if (p) tiers.push(p); else if (suffix !== '') break;
      }
      return tiers;
    };

    // Arm chain: explicit ids win (manifest entry `arms`), otherwise scan every
    // parameter for chains like ParamArmAL01/02/03 (PARAM_ARM_AL01 included).
    // Preference order: AL > AR > anything else (AL is what Natori's default pose shows).
    async function detectArms() {
      if (opts.arms && opts.arms.length) {
        const found = [];
        for (const name of opts.arms) {
          const p = await probe(name);
          if (p) found.push(p);
        }
        return found;
      }
      const chains = {}; // letter -> { '01': name, '02': name, ... }
      for (const e of lookup.entries) {
        const m = /^arm([a-z]{1,2})(\d{2})$/.exec(e.key);
        if (m) (chains[m[1]] = chains[m[1]] || {})[m[2]] = e.name;
      }
      const order = ['al', 'ar'].concat(Object.keys(chains).sort());
      for (const letter of order) {
        const chain = chains[letter];
        if (!chain || !chain['01']) continue;
        const joints = [];
        for (let n = 1; n <= 9; n++) {
          const name = chain[String(n).padStart(2, '0')];
          if (!name) break;
          const p = await probe(name);
          if (p) joints.push(p);
        }
        if (joints.length >= 2) return joints;
      }
      return [];
    }

    // Snapshot the rest pose first: loadParameters() is a no-op until something has
    // been saved, so without this the probes would leave the model posing at the
    // last extreme they tested.
    model.saveParameters();
    const table = {
      artHeight,
      head: { X: await collectTiers('ParamAngle', 'X'), Y: await collectTiers('ParamAngle', 'Y'), Z: await collectTiers('ParamAngle', 'Z') },
      body: { X: await collectTiers('ParamBodyAngle', 'X'), Y: await collectTiers('ParamBodyAngle', 'Y'), Z: await collectTiers('ParamBodyAngle', 'Z') },
      eyes: { X: await probe('ParamEyeBallX'), Y: await probe('ParamEyeBallY') },
      arms: await detectArms(),
    };
    model.loadParameters();
    model.update();
    return table;
  }

  // FNV-1a over the rig's own parameter set: names plus their ranges. Re-exporting
  // or editing a model changes the fingerprint, so a stale measurement can never be
  // used to drive a different rig.
  function fingerprint() {
    let h = 2166136261;
    const push = (s) => {
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    };
    push(model.getParameterCount() + '|' + drawableCount + '|');
    for (const e of lookup.entries) {
      push(e.name);
      push('#' + model.getParameterMinimumValue(e.index).toFixed(3) + ',' + model.getParameterMaximumValue(e.index).toFixed(3) + ';');
    }
    return h.toString(16);
  }

  const storage = 'storage' in opts ? opts.storage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  const cacheKey = (opts.cacheKey ? opts.cacheKey + ':' : '') + fingerprint();
  const readCache = () => {
    if (!storage || opts.cache === false) return null;
    try {
      const raw = storage.getItem(CACHE_NS + cacheKey);
      if (!raw) return null;
      const t = JSON.parse(raw);
      // Every cached parameter still has to exist in this moc.
      const ok = (p) => !p || !!lookup.find(p.name);
      for (const list of [t.head.X, t.head.Y, t.head.Z, t.body.X, t.body.Y, t.body.Z, t.arms]) if (!list.every(ok)) return null;
      if (!ok(t.eyes.X) || !ok(t.eyes.Y) || !(t.artHeight > 0)) return null;
      return t;
    } catch (_) {
      return null;
    }
  };
  const writeCache = (t) => {
    if (!storage || opts.cache === false) return;
    try { storage.setItem(CACHE_NS + cacheKey, JSON.stringify(t)); } catch (_) {}
  };

  let table = readCache();
  const measured = !table;
  if (!table) { table = await measureTable(); writeCache(table); }

  // The CubismId is the one thing a cache cannot carry, so it comes back here.
  const hydrate = (p) => (p ? { ...p, id: idManager.getId(p.name) } : null);
  const hydrateAll = (list) => list.map(hydrate);
  const head = { X: hydrateAll(table.head.X), Y: hydrateAll(table.head.Y), Z: hydrateAll(table.head.Z) };
  const body = { X: hydrateAll(table.body.X), Y: hydrateAll(table.body.Y), Z: hydrateAll(table.body.Z) };
  const eyes = { X: hydrate(table.eyes.X), Y: hydrate(table.eyes.Y) };
  const arms = hydrateAll(table.arms);

  // Pointing groups: the head's turn and its roll both answer the cursor's
  // horizontal (a roll reads as face travel sideways), and the torso trails the
  // same axis. Splitting the budget across a group's members is what keeps a
  // rig with a monster torso parameter from leaning harder than it turns.
  const groups = {
    headX: head.X.concat(head.Z),
    bodyX: body.X.concat(body.Z),
    headY: head.Y.slice(),
    bodyY: body.Y.slice(),
  };

  // Spend `travel` (model units of face displacement) on a group for dir = +-1,
  // divided across its members. Each member is driven by travel / its own
  // measured influence, so the sign comes from the geometry and a mirrored
  // parameter is simply driven the other way. Members that barely move the face
  // are skipped: those are the ids physics WRITES (the *2 outputs), and pushing
  // them only fights the physics rig while buying nothing.
  function driveGroup(tiers, dir, travel, axis) {
    if (!tiers.length || !dir || !travel) return;
    const infOf = (p) => (axis === 'y' ? p.dY : p.dX);
    const best = tiers.reduce((a, p) => Math.max(a, Math.abs(infOf(p))), 0);
    if (best < SIGN_EPS) return;
    const steerable = tiers.filter((p) => Math.abs(infOf(p)) >= best * TIER_SHARE);
    const per = travel / steerable.length;
    for (const p of steerable) {
      const frac = clamp(per / infOf(p), -1, 1);
      model.setParameterValueById(p.id, clamp(p.mid + dir * frac * p.half, p.min, p.max));
    }
  }

  let boost = false;
  const rig = {
    // false when the sweep came from cache instead of being measured here.
    measured,
    setBoost(on) { boost = !!on; },

    // x: +right, y: +up (the host feeds the same signs CubismLook used).
    apply(x, y) {
      const b = boost ? RIG.POINT_BOOST : 1;
      const headT = RIG.HEAD_TRAVEL * artHeight * b;
      const bodyT = RIG.BODY_TRAVEL * artHeight * b;
      driveGroup(groups.headX, x, headT, 'x');
      driveGroup(groups.bodyX, x, bodyT, 'x');
      driveGroup(groups.headY, y, headT * RIG.HEAD_Y_TRAVEL, 'y');
      driveGroup(groups.bodyY, y, bodyT * RIG.BODY_Y_TRAVEL, 'y');
      if (eyes.X) model.setParameterValueById(eyes.X.id, clamp(eyes.X.mid + eyes.X.sx * x * eyes.X.half * RIG.EYE_REACH * b, eyes.X.min, eyes.X.max));
      if (eyes.Y) model.setParameterValueById(eyes.Y.id, clamp(eyes.Y.mid + eyes.Y.sy * y * eyes.Y.half * RIG.EYE_REACH * b, eyes.Y.min, eyes.Y.max));
      // Joint 1 swings with X; the further joints raise/lower with Y — the
      // validated Natori pointing directions, now across the full joint span.
      if (arms.length) {
        const blend = (base, p, dir) => {
          const target = p.mid + dir * p.half * RIG.ARM_REACH * b;
          return clamp(base * (1 - RIG.ARM_CONTROL) + target * RIG.ARM_CONTROL, p.min, p.max);
        };
        arms.forEach((p, i) => {
          const dir = i === 0 ? p.sx * x : p.sy * y;
          const base = model.getParameterValueById(p.id);
          model.setParameterValueById(p.id, blend(base, p, dir));
        });
      }
    },

    summary() {
      const list = (t) => (t.length ? t.map((p) => `${p.name.replace(/^Param/, '')}(${p.dX >= 0 ? '+' : ''}${p.dX.toFixed(3)}/${p.dY >= 0 ? '+' : ''}${p.dY.toFixed(3)})`).join(' ') : 'none');
      return `head ${list(groups.headX)} | body ${list(groups.bodyX)} | pitch head ${list(groups.headY)} body ${list(groups.bodyY)} | ` +
        `eyes ${(eyes.X ? 1 : 0) + (eyes.Y ? 1 : 0)} | arms ${arms.length ? arms.map((a) => a.name.replace(/^Param/, '')).join(' ') : 'none'}`;
    },
  };
  return rig;
}
