// Webcam face tracking, in the only language this demo needs: numbers between -1
// and 1, plus head angles in degrees. MediaPipe's FaceLandmarker gives 52 ARKit
// expression coefficients and a face transform; both are reduced here to the
// canonical signals below, so a model preset never has to know what a camera is.

import { FaceLandmarker, FilesetResolver } from './vendor/mediapipe/vision_bundle.mjs';

const D = 180 / Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Everything the tracker reports, already smoothed.
//  head.turn / head.nod / head.tilt  degrees, roughly -40..40
//  gaze.x / gaze.y                   -1..1, eyes only (head angle kept separate)
//  blinkL/R, squintL/R               0..1
//  browUp(L|R), browInnerUp, browDown(L|R)
//  smile, frown, mouthOpen, mouthX, pucker, funnel, sneer, cheek   0..1 (mouthX -1..1)
const EMPTY = () => ({
  present: false,
  head: { turn: 0, nod: 0, tilt: 0 },
  gaze: { x: 0, y: 0 },
  eyes: { blinkL: 0, blinkR: 0, squintL: 0, squintR: 0 },
  brows: { upL: 0, upR: 0, innerUp: 0, downL: 0, downR: 0 },
  mouth: { smile: 0, frown: 0, open: 0, x: 0, pucker: 0, funnel: 0, sneer: 0, cheek: 0 },
});

/**
 * Loads the vendored wasm + model once. `delegate: 'GPU'` is the fast path and
 * 'CPU' is retried automatically when the browser refuses a WebGL graph.
 */
export async function loadFaceModel({ wasmPath, modelPath }) {
  const fileset = await FilesetResolver.forVisionTasks(wasmPath);
  const options = {
    baseOptions: { modelAssetPath: modelPath, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  };
  try {
    return await FaceLandmarker.createFromOptions(fileset, options);
  } catch (err) {
    return FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
    });
  }
}

// One EMA per signal, so jitter from a compressed video frame never reaches the
// recording. `response` is the fraction of the new sample taken each frame.
function smoother() {
  const state = new Map();
  return (key, value, response) => {
    const prev = state.get(key);
    const next = prev === undefined ? value : prev + (value - prev) * response;
    state.set(key, next);
    return next;
  };
}

// Head pose from the face transform matrix (4x4, row-major). Turning is a rotation
// about the face's Y axis, nodding about X, tilting about Z.
function poseFromMatrix(m) {
  const d = m.data || m.values;
  if (!d || d.length < 12) return null;
  const r = (row, col) => d[row * 4 + col];
  const turn = Math.asin(clamp(-r(2, 0), -1, 1)) * D;
  const nod = Math.atan2(r(2, 1), r(2, 2)) * D;
  const tilt = Math.atan2(r(1, 0), r(0, 0)) * D;
  if (![turn, nod, tilt].every(Number.isFinite)) return null;
  return { turn, nod, tilt };
}

// Fallback when the model has no transform head: nose tip off the eye line, and
// the eye line's own angle. Weaker, but it tracks.
function poseFromLandmarks(lm) {
  if (!lm || lm.length < 264) return null;
  const Nose = 1, EyeOuterA = 33, EyeOuterB = 263, Chin = 152;
  const mid = (a, b, k = 0.5) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
  const eyeMid = mid(lm[EyeOuterA], lm[EyeOuterB]);
  const eyeSpan = Math.abs(lm[EyeOuterB].x - lm[EyeOuterA].x) || 1e-3;
  const faceSpan = Math.abs(lm[Chin].y - eyeMid.y) || 1e-3;
  return {
    turn: clamp(Math.asin(clamp((eyeMid.x - lm[Nose].x) / (eyeSpan * 0.75), -1, 1)) * D, -45, 45),
    nod: clamp(((eyeMid.y - lm[Nose].y) / faceSpan) * 60, -40, 40),
    tilt: Math.atan2(lm[EyeOuterB].y - lm[EyeOuterA].y, lm[EyeOuterB].x - lm[EyeOuterA].x) * D,
  };
}

export function createTracker(lm) {
  const ema = smoother();
  let last = { timeMs: -1, signals: EMPTY() };
  let points = null;   // raw landmark cloud, for the preview overlay only

  /** One camera frame. `tsMs` must increase (video.currentTime*1000 works). */
  function detect(video, tsMs) {
    if (tsMs <= last.timeMs) return last.signals;   // MediaPipe rejects equal stamps
    last.timeMs = tsMs;
    const s = EMPTY();
    let res;
    try {
      res = lm.detectForVideo(video, tsMs);
    } catch (err) {
      s.error = String(err && err.message || err);
      return s;
    }
    const faces = res.faceLandmarks && res.faceLandmarks.length;
    s.present = !!faces;
    points = faces ? res.faceLandmarks[0] : null;
    if (!s.present) { last.signals = s; return s; }

    const pose = (res.facialTransformationMatrixes && res.facialTransformationMatrixes[0] &&
      poseFromMatrix(res.facialTransformationMatrixes[0])) || poseFromLandmarks(res.faceLandmarks[0]);
    if (pose) {
      s.head.turn = ema('turn', pose.turn, 0.3);
      s.head.nod = ema('nod', pose.nod, 0.3);
      s.head.tilt = ema('tilt', pose.tilt, 0.3);
    }

    const b = {};
    for (const c of (res.faceBlendshapes && res.faceBlendshapes[0] ? res.faceBlendshapes[0].categories : [])) {
      b[c.categoryName] = c.score;
    }
    const g = (k) => (b[k] === undefined ? 0 : b[k]);
    const avg = (a, c) => (a + c) / 2;

    s.gaze.x = ema('gazeX', clamp(avg(g('eyeLookOutLeft'), g('eyeLookInRight')) - avg(g('eyeLookInLeft'), g('eyeLookOutRight')), -1, 1), 0.35);
    s.gaze.y = ema('gazeY', clamp(avg(g('eyeLookUpLeft'), g('eyeLookUpRight')) - avg(g('eyeLookDownLeft'), g('eyeLookDownRight')), -1, 1), 0.35);
    s.eyes.blinkL = ema('blinkL', g('eyeBlinkLeft'), 0.55);
    s.eyes.blinkR = ema('blinkR', g('eyeBlinkRight'), 0.55);
    s.eyes.squintL = ema('squintL', g('eyeSquintLeft'), 0.4);
    s.eyes.squintR = ema('squintR', g('eyeSquintRight'), 0.4);
    s.brows.upL = ema('browUpL', g('browOuterUpLeft'), 0.4);
    s.brows.upR = ema('browUpR', g('browOuterUpRight'), 0.4);
    s.brows.innerUp = ema('browInner', g('browInnerUp'), 0.4);
    s.brows.downL = ema('browDownL', g('browDownLeft'), 0.4);
    s.brows.downR = ema('browDownR', g('browDownRight'), 0.4);
    s.mouth.smile = ema('smile', avg(g('mouthSmileLeft'), g('mouthSmileRight')), 0.4);
    s.mouth.frown = ema('frown', avg(g('mouthFrownLeft'), g('mouthFrownRight')), 0.4);
    s.mouth.open = ema('mouthOpen', clamp(g('jawOpen') + g('mouthFunnel') * 0.25, 0, 1), 0.5);
    s.mouth.x = ema('mouthX', clamp(g('mouthLeft') - g('mouthRight'), -1, 1), 0.4);
    s.mouth.pucker = ema('pucker', g('mouthPucker'), 0.4);
    s.mouth.funnel = ema('funnel', g('mouthFunnel'), 0.4);
    s.mouth.sneer = ema('sneer', avg(g('noseSneerLeft'), g('noseSneerRight')), 0.4);
    s.mouth.cheek = ema('cheek', avg(g('cheekSquintLeft'), g('cheekSquintRight')), 0.4);

    last.signals = s;
    return s;
  }

  // The raw cloud is only for drawing the overlay; the parameters come from
  // `detect`, never from these points.
  return { detect, landmarks: () => points };
}

/**
 * No camera, no problem: a scripted performance with the same shape as a real one
 * (a slow look around, blinks on a human cadence, speech-like mouth). Also what
 * lets this page be tested on a machine that has no webcam.
 */
export function simulateSignals(t) {
  const s = EMPTY();
  s.present = true;
  const turn = 24 * Math.sin(t * 0.62) + 6 * Math.sin(t * 1.7);
  s.head.turn = turn;
  s.head.nod = 10 * Math.sin(t * 0.9 + 0.7);
  s.head.tilt = 7 * Math.sin(t * 0.44 + 1.9);
  s.gaze.x = clamp(Math.sin(t * 1.3 + 0.4) * 0.7 - turn / 90, -1, 1);
  s.gaze.y = clamp(Math.sin(t * 1.05) * 0.5, -1, 1);
  const cyc = t % 3.6;
  const blink = cyc < 0.16 ? 1 - Math.abs(cyc / 0.08 - 1) : 0;
  s.eyes.blinkL = blink;
  s.eyes.blinkR = blink;
  s.brows.innerUp = 0.25 + 0.25 * Math.sin(t * 0.8);
  s.brows.upL = s.brows.upR = 0.15 + 0.2 * Math.sin(t * 0.8 + 0.3);
  s.mouth.smile = 0.3 + 0.2 * Math.sin(t * 0.5 + 1.1);
  const talk = Math.max(0, Math.sin(t * 6.1) * 0.5 + Math.sin(t * 9.7) * 0.35 + Math.sin(t * 3.3) * 0.3);
  s.mouth.open = (Math.sin(t * 0.35) > 0.2) ? clamp(talk, 0, 1) : 0.04;
  s.mouth.x = 0.2 * Math.sin(t * 2.2);
  return s;
}
