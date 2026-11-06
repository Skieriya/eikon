// Generic Live2D Cubism model bring-up. Pass a model3.json URL + a WebGL context
// and it loads every referenced asset, builds the model + renderer + effects, and
// returns the handles. It is model-agnostic: physics / pose / motions / expressions
// are only wired up when the model3.json actually references them, so a bare model
// (e.g. Hu Tao: moc3 + textures + physics, no motions) loads cleanly too. Paths are
// URI-encoded, so folders/files with spaces work.
//
// Requires CubismFramework.startUp()/initialize() already called by the host.

import { CubismModelSettingJson } from '../framework/dist/cubismmodelsettingjson.js';
import { CubismMoc } from '../framework/dist/model/cubismmoc.js';
import { CubismRenderer_WebGL } from '../framework/dist/rendering/cubismrenderer_webgl.js';
import { CubismDefaultParameterId } from '../framework/dist/cubismdefaultparameterid.js';
import { CubismBreath, BreathParameterData } from '../framework/dist/effect/cubismbreath.js';
import { CubismEyeBlink } from '../framework/dist/effect/cubismeyeblink.js';
import { CubismLook, LookParameterData } from '../framework/dist/effect/cubismlook.js';
import { CubismPose } from '../framework/dist/effect/cubismpose.js';
import { CubismPhysics } from '../framework/dist/physics/cubismphysics.js';
import { CubismMotion } from '../framework/dist/motion/cubismmotion.js';
import { CubismMotionManager } from '../framework/dist/motion/cubismmotionmanager.js';
import { CubismExpressionMotion } from '../framework/dist/motion/cubismexpressionmotion.js';
import { CubismExpressionMotionManager } from '../framework/dist/motion/cubismexpressionmotionmanager.js';
import { CubismFramework } from '../framework/dist/live2dcubismframework.js';
import { arrayBuffer, decodeTexture, release } from './assets.js';

// GPU upload of an already-decoded texture. Mipmaps are mandatory here: one atlas
// covers the whole character, so on screen it is minified several times over, and
// without a mip chain that minification aliases hard and her face (lashes, eye
// shine, hair edges) breaks up into dots.
function uploadTexture(gl, src, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  // generateMipmap only accepts power-of-two sizes in WebGL1.
  const pot = (n) => (n & (n - 1)) === 0;
  if (pot(w) && pot(h)) gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

// Distinct mask groups in a model. The SDK packs 36 groups into one mask render
// texture (32 per texture once more than one is used); Hu Tao has 41 groups, so
// a single texture overflows the layout and the masked art (her face) renders
// wrong.
function countMaskGroups(model) {
  const masks = model.getDrawableMasks();
  const counts = model.getDrawableMaskCounts();
  const groups = new Set();
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] <= 0) continue;
    groups.add(Array.from(masks[i]).sort((a, b) => a - b).join(','));
  }
  return groups.size;
}

export async function loadModel({
  model3Url,
  gl,
  shadersPath = './framework/shaders/',
  expressions = [],
  motions = [],
  onProgress = () => {},
  onLog = () => {},
} = {}) {
  if (!model3Url || !gl) throw new Error('loadModel: model3Url and gl are required');

  // Folder that holds the model3.json — all its asset paths are relative to this.
  const dir = model3Url.slice(0, model3Url.lastIndexOf('/') + 1);

  onProgress('Loading model3.json...', 10);
  const m3 = await arrayBuffer(model3Url);
  const setting = new CubismModelSettingJson(m3, m3.byteLength);
  onLog('[LIVE2D] model3.json loaded');

  const mocFileName = setting.getModelFileName();
  const physicsFileName = setting.getPhysicsFileName();
  const poseFileName = setting.getPoseFileName();

  // --- build the asset list from whatever the model references ---
  // Textures are deliberately not in here: they are decoded on their own track
  // further down, so the transfer and the SDK work overlap instead of queueing.
  const assetList = [{ name: mocFileName, url: dir + mocFileName, type: 'ab' }];
  const texNames = [];
  for (let i = 0; i < setting.getTextureCount(); i++) texNames.push(setting.getTextureFileName(i));
  if (physicsFileName) assetList.push({ name: physicsFileName, url: dir + physicsFileName, type: 'ab' });
  if (poseFileName) assetList.push({ name: poseFileName, url: dir + poseFileName, type: 'ab' });

  const motionRefs = [];
  for (let g = 0; g < setting.getMotionGroupCount(); g++) {
    const groupName = setting.getMotionGroupName(g);
    for (let i = 0; i < setting.getMotionCount(groupName); i++) {
      const mn = setting.getMotionFileName(groupName, i);
      motionRefs.push({ group: groupName, index: i, name: mn });
      assetList.push({ name: mn, url: dir + mn, type: 'ab' });
    }
  }
  // Recordings from recorder.html arrive through a sidecar index (see
  // models/<id>/recorded.json) instead of being written into the imported
  // model3.json, so the original asset stays exactly as it shipped.
  for (const m of motions) {
    const file = typeof m === 'string' ? m : m.file;
    if (!file) continue;
    motionRefs.push({ group: (m && m.group) || 'Recorded', index: 0, name: file, extra: true, label: (m && m.name) || file });
    assetList.push({ name: file, url: dir + file, type: 'ab' });
  }
  // --- expressions ---
  // Standard models declare them in model3.json (FileReferences.Expressions).
  // VTS-style assets (Hu Tao) keep their .exp3.json files next to the model3.json
  // without declaring them, so the manifest can list them explicitly.
  const expressionRefs = [];
  if (expressions && expressions.length) {
    for (const e of expressions) {
      const file = typeof e === 'string' ? e : e.file;
      if (!file) continue;
      expressionRefs.push({ name: (typeof e === 'string' ? e : (e.name || e.label)) || file, file });
      assetList.push({ name: file, url: dir + file, type: 'ab' });
    }
  } else {
    for (let i = 0; i < setting.getExpressionCount(); i++) {
      const file = setting.getExpressionFileName(i);
      if (!file) continue;
      expressionRefs.push({ name: setting.getExpressionName(i) || file, file });
      assetList.push({ name: file, url: dir + file, type: 'ab' });
    }
  }
  // The SDK's own renderer.loadShaders() fetches these 13 files, so they are not
  // fetched here as well (that was 12 wasted requests per model, ghosts included).

  onProgress('Fetching ' + (assetList.length + texNames.length) + ' assets...', 15);
  // The textures were already fetched and decoded by the prefetch; this hands back
  // those same promises. Only what the prefetch could not have known about (an
  // unlisted .exp3.json, a second model sharing the folder) starts here.
  const decodes = texNames.map((tn) => decodeTexture(dir + tn));
  // The SDK cannot work without the .moc3, so only the small files gate it.
  const results = await Promise.allSettled(assetList.map(async (a) => ({
    name: a.name, data: await arrayBuffer(a.url),
  })));
  const assetMap = {};
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') assetMap[r.value.name] = r.value.data;
    else { failed++; onLog('[LIVE2D] Failed to load', r.reason && r.reason.message); }
  }

  // Bring-up timing, so a slow load says which part of itself is slow.
  let tMark = performance.now();
  const lap = () => { const now = performance.now(); const d = Math.round(now - tMark); tMark = now; return d; };

  // --- model ---
  onProgress('Creating Live2D model...', 90);
  const moc = CubismMoc.create(assetMap[mocFileName]);
  const model = moc.createModel();

  // --- renderer (initialize before startUp: startUp reads model mask/blend state) ---
  const renderer = new CubismRenderer_WebGL();
  const maskGroups = countMaskGroups(model);
  const maskBufferCount = Math.max(1, Math.ceil(maskGroups / 32));
  renderer.initialize(model, maskBufferCount);
  if (maskBufferCount > 1) onLog('[LIVE2D] ' + maskGroups + ' mask groups -> ' + maskBufferCount + ' mask textures');
  renderer.setClippingMaskBufferSize(1024);
  renderer.setIsPremultipliedAlpha(true);
  renderer.startUp(gl);

  const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
    || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
    || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
  if (anisoExt) renderer.setAnisotropy(gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));

  renderer.loadShaders(shadersPath);
  const modelMs = lap();

  onLog('[LIVE2D] Loading textures...');
  // Decoding started above; each result is uploaded in declaration order as it lands.
  const settled = await Promise.allSettled(decodes);
  const decodeMs = lap();
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled') { failed++; onLog('[LIVE2D] Texture decode failed: ' + texNames[i]); continue; }
    const d = r.value;
    renderer.bindTexture(i, uploadTexture(gl, d.src, d.w, d.h));
    d.close();
    release(dir + texNames[i]);
  }
  const uploadMs = lap();

  // --- standard effects (default Cubism parameter ids) ---
  const idm = CubismFramework.getIdManager();
  const idAngleX = idm.getId(CubismDefaultParameterId.ParamAngleX);
  const idAngleY = idm.getId(CubismDefaultParameterId.ParamAngleY);
  const idAngleZ = idm.getId(CubismDefaultParameterId.ParamAngleZ);
  const idEyeBallX = idm.getId(CubismDefaultParameterId.ParamEyeBallX);
  const idEyeBallY = idm.getId(CubismDefaultParameterId.ParamEyeBallY);

  const eyeBlink = CubismEyeBlink.create(setting);

  const breath = CubismBreath.create();
  breath.setParameters([
    new BreathParameterData(idAngleX, 0, 15, 6.5345, 0.5),
    new BreathParameterData(idAngleY, 0, 8, 3.5345, 0.5),
    new BreathParameterData(idAngleZ, 0, 10, 5.5345, 0.5),
  ]);

  const look = CubismLook.create();
  look.setParameters([
    new LookParameterData(idAngleX, 30, 0, 0),
    new LookParameterData(idAngleY, 0, 30, 0),
    new LookParameterData(idAngleZ, 0, 0, -30),
    new LookParameterData(idEyeBallX, 1, 0, 0),
    new LookParameterData(idEyeBallY, 0, 1, 0),
  ]);

  let physics = null;
  if (physicsFileName && assetMap[physicsFileName]) {
    const p = assetMap[physicsFileName];
    physics = CubismPhysics.create(p, p.byteLength);
  }
  let pose = null;
  if (poseFileName && assetMap[poseFileName]) {
    pose = CubismPose.create(assetMap[poseFileName], assetMap[poseFileName].byteLength);
  }

  // --- motions ---
  const motionGroups = {};
  const eyeBlinkIds = [];
  for (let i = 0; i < setting.getEyeBlinkParameterCount(); i++) eyeBlinkIds.push(setting.getEyeBlinkParameterId(i));
  const lipSyncIds = [];
  for (let i = 0; i < setting.getLipSyncParameterCount(); i++) lipSyncIds.push(setting.getLipSyncParameterId(i));

  const motionClips = [];
  for (const ref of motionRefs) {
    const buf = assetMap[ref.name];
    if (!buf) continue;
    const motion = CubismMotion.create(buf, buf.byteLength);
    motion.setEffectIds(eyeBlinkIds, lipSyncIds);
    if (ref.extra) {
      // A recording has no entry in model3.json to read fades from; a short one
      // keeps a take from snapping onto the rig when it starts.
      motion.setFadeInTime(0.35);
      motion.setFadeOutTime(0.35);
    } else {
      const fi = setting.getMotionFadeInTimeValue(ref.group, ref.index);
      const fo = setting.getMotionFadeOutTimeValue(ref.group, ref.index);
      if (fi >= 0) motion.setFadeInTime(fi);
      if (fo >= 0) motion.setFadeOutTime(fo);
    }
    (motionGroups[ref.group] = motionGroups[ref.group] || []).push(motion);
    motionClips.push({ group: ref.group, name: ref.label || ref.name, file: ref.name, motion });
  }

  const motionManager = new CubismMotionManager();

  // --- expressions ---
  const expressionList = [];
  for (const ref of expressionRefs) {
    const buf = assetMap[ref.file];
    if (!buf) { failed++; onLog('[LIVE2D] Failed to load expression', ref.file); continue; }
    expressionList.push({ name: ref.name, file: ref.file, motion: CubismExpressionMotion.create(buf, buf.byteLength) });
  }
  const expressionManager = expressionList.length ? new CubismExpressionMotionManager() : null;

  const baseName = (model3Url.split('/').pop() || '').replace(/\.model3\.json$/i, '');
  onLog('[LIVE2D] Model "' + baseName + '" ready — motions: '
    + (Object.keys(motionGroups).map((k) => k + '(' + motionGroups[k].length + ')').join(', ') || 'none')
    + ' | expressions: ' + expressionList.length
    + ' | physics:' + !!physics + ' pose:' + !!pose + (failed ? ' | ' + failed + ' asset(s) failed' : '')
    + ' | model ' + modelMs + 'ms, decode ' + decodeMs + 'ms, upload ' + uploadMs + 'ms, effects ' + lap() + 'ms');

  return {
    setting, model, renderer, moc, eyeBlink, breath, look, physics, pose, motionManager, motionGroups, motionClips,
    expressionManager, expressionList,
    paramIds: { angleX: idAngleX, angleY: idAngleY, angleZ: idAngleZ, eyeBallX: idEyeBallX, eyeBallY: idEyeBallY },
    idManager: idm,
    failedAssets: failed,
  };
}
