// Drop-in model registry. To add a model: drop its folder under /models and add
// one entry here — nothing else changes. Pick a model by DEFAULT_MODEL or at
// runtime with ?model=id in the URL (no code edit needed).
// Optional `arms`: the joint parameter chain the point rig should steer.
// Omit it and the rig auto-detects one from the model's parameter names.
// Optional `companions`: small models pinned in the host's model-space units
// (see live2d/companions.js) — e.g. Hu Tao's ghost riding beside her hat.

export const MODELS = {
  hutao:  { label: 'Hu Tao', model3: './models/hu_tao/Hu Tao.model3.json',
            // Hu Tao ships no motion clips at all - the only animation the asset
            // has is these expression files, which VTube Studio loads from the
            // folder but model3.json never declares. Listing them here wires
            // them into the runtime (keys 1-8 toggle them).
            expressions: [
              { name: 'Smile', file: 'SmileLock.exp3.json' },
              { name: 'Sad', file: 'SadLock.exp3.json' },
              { name: 'Angry', file: 'Angry.exp3.json' },
              { name: 'Shadow', file: 'Shadow.exp3.json' },
              { name: 'PupilShrink', file: 'PupilShrink.exp3.json' },
              { name: 'EyeshineOff', file: 'EyeshineOff.exp3.json' },
              { name: 'Ghost', file: 'Ghost.exp3.json' },
              { name: 'GhostChange', file: 'GhostChange.exp3.json' },
            ],
            // The two ghosts from the asset's own VTube Studio item set
            // (models/hu_tao/items_pinned_to_model.json), re-anchored in this
            // renderer's model units so they sit right beside her hat.
            // pin: 'ArtMesh6' is her hat crown - the anchor rides that mesh, so
            // the ghosts stay attached while she turns her head.
            // scale: companion art height as a fraction of the host height.
            companions: [{
              label: 'Ghost (Happy)',
              model3: './models/hu_tao/Hu_Tao_asset__Ghost_Happy_/HuTaoGhost.model3.json',
              x: -0.27, y: 0.81, pin: 'ArtMesh6', scale: 0.105, rot: 0.886, follow: true,
            }, {
              label: 'Ghost (Nervous)',
              model3: './models/hu_tao/Hu_Tao_asset__Ghost_Nervous_/HuTaoGhost.model3.json',
              x: 0.26, y: 0.78, pin: 'ArtMesh6', scale: 0.105, rot: -0.024, flip: true, follow: true,
            }] },
  natori: { label: 'Natori', model3: './models/natori/Natori.model3.json',
            arms: ['ParamArmAL01', 'ParamArmAL02', 'ParamArmAL03'] },
  hiyori: { label: 'Hiyori', model3: './models/hiyori/Hiyori.model3.json' },
  wanko:  { label: 'Wanko',  model3: './models/wanko/Wanko.model3.json' },
};

export const DEFAULT_MODEL = 'hutao';

// Resolve an id (or ?model= value) to a registry entry, falling back to the default.
export function resolveModel(id) {
  const key = String(id || DEFAULT_MODEL).toLowerCase();
  const entry = MODELS[key] || MODELS[DEFAULT_MODEL];
  return { id: MODELS[key] ? key : DEFAULT_MODEL, ...entry };
}
