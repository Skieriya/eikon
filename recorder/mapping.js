// Canonical tracker signals -> this model's parameter ids.
//
// Hu Tao's rig names half its parameters by number (Param37 is "Brows Raise",
// Param71 is "MouthX"), so the mapping is a per-model table rather than a guess
// from names. Values land in each parameter's own range, read from the .moc3, so
// the clip cannot ask for something the rig does not have.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// mode: 'range'   0..1  -> min..max
//       'bipolar' -1..1 -> min..max about the middle
//       'deg'     degrees, added to the middle of the range (head angles)
const hutao = {
  id: 'hutao',
  label: 'Hu Tao',
  curves: [
    { id: 'ParamAngleX', mode: 'deg', axis: 'turn', gain: 1.0, group: 'head' },
    { id: 'ParamAngleY', mode: 'deg', axis: 'nod', gain: 1.0, group: 'head' },
    { id: 'ParamAngleZ', mode: 'deg', axis: 'tilt', gain: 1.0, group: 'head' },
    // The body lags the head: tracking it at full angle looks like a turntable.
    { id: 'ParamBodyAngleX', mode: 'deg', axis: 'turn', gain: 0.32, group: 'head' },
    { id: 'ParamBodyAngleZ', mode: 'deg', axis: 'tilt', gain: 0.3, group: 'head' },
    { id: 'ParamEyeBallX', mode: 'bipolar', from: (s) => s.gaze.x, tune: 'gazeX', group: 'eyes' },
    { id: 'ParamEyeBallY', mode: 'bipolar', from: (s) => s.gaze.y, tune: 'gazeY', group: 'eyes' },
    { id: 'ParamEyeLOpen', mode: 'range', from: (s) => 1 - s.eyes.blinkL - s.eyes.squintL * 0.3, group: 'eyes' },
    { id: 'ParamEyeROpen', mode: 'range', from: (s) => 1 - s.eyes.blinkR - s.eyes.squintR * 0.3, group: 'eyes' },
    { id: 'ParamEyeLSmile', mode: 'range', from: (s) => s.mouth.smile * 0.8, group: 'eyes' },
    { id: 'ParamEyeRSmile', mode: 'range', from: (s) => s.mouth.smile * 0.8, group: 'eyes' },
    { id: 'ParamBrowLForm', mode: 'bipolar', from: (s) => s.brows.upL - s.brows.downL, group: 'brows' },
    { id: 'ParamBrowRForm', mode: 'bipolar', from: (s) => s.brows.upR - s.brows.downR, group: 'brows' },
    { id: 'ParamBrowLAngle', mode: 'bipolar', from: (s) => s.brows.upL - s.brows.downL, group: 'brows' },
    { id: 'ParamBrowRAngle', mode: 'bipolar', from: (s) => s.brows.upR - s.brows.downR, group: 'brows' },
    { id: 'Param37', mode: 'range', from: (s) => s.brows.innerUp, group: 'brows', name: 'Brows Raise' },
    { id: 'ParamMouthForm', mode: 'bipolar', from: (s) => s.mouth.smile - s.mouth.frown, group: 'mouth' },
    { id: 'ParamMouthOpenY', mode: 'range', from: (s) => s.mouth.open, group: 'mouth' },
    { id: 'Param72', mode: 'range', from: (s) => s.mouth.open, group: 'mouth', name: 'MouthOpen' },
    { id: 'Param', mode: 'range', from: (s) => s.mouth.open, group: 'mouth', name: 'JawOpen' },
    { id: 'Param71', mode: 'bipolar', from: (s) => s.mouth.x, group: 'mouth', name: 'MouthX' },
    { id: 'Param70', mode: 'range', from: (s) => s.mouth.pucker * 0.35, group: 'mouth', name: 'TongueOut' },
    { id: 'Param38', mode: 'range', from: (s) => s.eyes.squintL, group: 'eyes', name: 'PupilShrink' },
  ],
};

// Standard Cubism naming, for any other model dropped in /models.
const generic = {
  id: 'generic',
  label: 'Generic Cubism rig',
  curves: [
    { id: 'ParamAngleX', mode: 'deg', axis: 'turn', gain: 1.0, group: 'head' },
    { id: 'ParamAngleY', mode: 'deg', axis: 'nod', gain: 1.0, group: 'head' },
    { id: 'ParamAngleZ', mode: 'deg', axis: 'tilt', gain: 1.0, group: 'head' },
    { id: 'ParamBodyAngleX', mode: 'deg', axis: 'turn', gain: 0.32, group: 'head' },
    { id: 'ParamEyeBallX', mode: 'bipolar', from: (s) => s.gaze.x, tune: 'gazeX', group: 'eyes' },
    { id: 'ParamEyeBallY', mode: 'bipolar', from: (s) => s.gaze.y, tune: 'gazeY', group: 'eyes' },
    { id: 'ParamEyeLOpen', mode: 'range', from: (s) => 1 - s.eyes.blinkL, group: 'eyes' },
    { id: 'ParamEyeROpen', mode: 'range', from: (s) => 1 - s.eyes.blinkR, group: 'eyes' },
    { id: 'ParamBrowLY', mode: 'bipolar', from: (s) => s.brows.upL - s.brows.downL, group: 'brows' },
    { id: 'ParamBrowRY', mode: 'bipolar', from: (s) => s.brows.upR - s.brows.downR, group: 'brows' },
    { id: 'ParamBrowLForm', mode: 'bipolar', from: (s) => s.brows.upL - s.brows.downL, group: 'brows' },
    { id: 'ParamBrowRForm', mode: 'bipolar', from: (s) => s.brows.upR - s.brows.downR, group: 'brows' },
    { id: 'ParamMouthForm', mode: 'bipolar', from: (s) => s.mouth.smile - s.mouth.frown, group: 'mouth' },
    { id: 'ParamMouthOpenY', mode: 'range', from: (s) => s.mouth.open, group: 'mouth' },
    { id: 'ParamCheek', mode: 'range', from: (s) => s.mouth.smile, group: 'mouth' },
  ],
};

export const PRESETS = [hutao, generic];

// The preset that can actually drive this rig: whichever resolves more curves.
export function pickPreset(hasParam) {
  let best = generic, bestScore = -1;
  for (const p of PRESETS) {
    const score = p.curves.filter((c) => hasParam(c.id)).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

export const AXES = { turn: 'head turn', nod: 'head nod', tilt: 'head tilt' };

// What the tuning panel offers a slider for. `neutral` is only meaningful for the
// head axes: gaze has no "resting" camera reading to zero against.
export const TUNE_KEYS = [
  { key: 'turn', label: 'Head turn', neutral: true },
  { key: 'nod', label: 'Head nod', neutral: true },
  { key: 'tilt', label: 'Head tilt', neutral: true },
  { key: 'gazeX', label: 'Eye left/right', neutral: false },
  { key: 'gazeY', label: 'Eye up/down', neutral: false },
];

// The knob a curve answers to: a head axis, or its own `tune` alias, or its id.
const tuneKey = (c) => c.axis || c.tune || c.id;

/**
 * ranges: { id: {min,max,def} } from the model. tuning: per-axis gain/invert,
 * neutral offsets, and a deadzone so a still face really is still.
 * Returns [{ id, value, signal }] - `signal` is the pre-mapping number, which is
 * what the meters show.
 */
export function targets(signals, preset, ranges, tuning) {
  const out = [];
  if (!signals.present) return out;
  // Two floors, because the two kinds of signal are two different scales: head
  // axes are degrees (a still camera drifts well under half a degree), everything
  // else is a 0..1 coefficient.
  const headFloor = tuning.deadzone ?? 0;
  const normFloor = tuning.noise ?? 0;

  for (const c of preset.curves) {
    const r = ranges[c.id];
    if (!r) continue;
    const center = (r.min + r.max) / 2;
    const half = (r.max - r.min) / 2;
    const key = tuneKey(c);
    const gain = tuning.gain[key] ?? 1;
    const sign = tuning.invert[key] ? -1 : 1;
    let signal;
    // c.gain is the preset's own scaling (the body follows the head at a third of
    // the angle); tuning.gain is the user's slider on top of it.
    if (c.axis) {
      signal = (signals.head[c.axis] - (tuning.neutral[c.axis] || 0)) * (c.gain ?? 1) * gain * sign;
      if (Math.abs(signal) < headFloor) signal = 0;
    } else {
      signal = c.from(signals) * gain * sign;
      if (Math.abs(signal) < normFloor) signal = 0;
    }
    let value;
    if (c.mode === 'deg') value = center + signal;
    else if (c.mode === 'bipolar') value = center + clamp(signal, -1, 1) * half;
    else value = r.min + clamp(signal, 0, 1) * (r.max - r.min);
    out.push({ id: c.id, name: c.name || c.id, group: c.group, mode: c.mode, signal, value: clamp(value, Math.min(r.min, r.max), Math.max(r.min, r.max)) });
  }
  return out;
}

// What the page needs to know about a curve to draw its meter and its controls.
export function describe(preset, ranges) {
  return preset.curves.filter((c) => ranges[c.id]).map((c) => ({
    id: c.id, name: c.name || c.id, group: c.group, mode: c.mode, axis: c.axis || null,
    tune: tuneKey(c), range: ranges[c.id],
  }));
}

export const DEFAULT_TUNING = () => ({
  gain: { turn: 1, nod: 1, tilt: 1, gazeX: 1, gazeY: 1 },
  invert: { turn: false, nod: false, tilt: false, gazeX: false, gazeY: false },
  neutral: { turn: 0, nod: 0, tilt: 0 },
  deadzone: 0.4,   // degrees of head motion treated as stillness
  noise: 0.02,     // the same for 0..1 blendshape signals
});
