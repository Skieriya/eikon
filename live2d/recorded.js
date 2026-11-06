// Recorded clips, as the rest of the demo sees them.
//
// recorder.html writes each take as an ordinary .motion3.json under
// <model folder>/motions/recorded/ and refreshes <model folder>/recorded.json.
// Nothing in the model's own files is touched, and a clip is playable by any
// Live2D runtime - this index is only how the demo learns which ones exist.

// Paths in recorded.json are relative to the model folder, the same convention
// model3.json uses, so loadModel() can resolve them without a second rule.
export function modelDir(model3Url) {
  return model3Url.slice(0, model3Url.lastIndexOf('/') + 1);
}

export async function listRecorded(model3Url) {
  try {
    const r = await fetch(modelDir(model3Url) + 'recorded.json', { cache: 'no-store' });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.clips || []).filter((c) => c && c.file);
  } catch (_) {
    return [];   // no index yet: the model simply has no recordings
  }
}

// The shape loadModel()'s `motions` option wants.
export const asMotionRefs = (clips) => clips.map((c) => ({
  group: c.group || 'Recorded',
  file: c.file,
  name: c.name || c.file.split('/').pop().replace(/\.motion3\.json$/i, ''),
}));

/**
 * Ask serve.py to write the take next to the model. Resolves
 * {ok, file, path, clips} - never rejects, because the caller has to be able to
 * say what went wrong instead of losing the take.
 */
export async function saveRecorded({ model3Url, name, motion, loop = false }) {
  try {
    // The manifest writes './models/...'; serve.py takes the path relative to
    // its own directory, so drop that prefix rather than loosen its checks.
    const r = await fetch('/recordings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model3: model3Url.replace(/^\.\//, ''), name, motion, loop }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      return { ok: false, error: j.error || ('HTTP ' + r.status + ' - saving needs serve.py (a plain static server cannot write files)') };
    }
    // `file` is relative to the model folder, exactly as recorded.json lists it.
    return { ok: true, file: j.file, path: j.path, clips: j.clips };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// The fallback that always works: hand the take to the browser as a file.
export function downloadJson(motion, filename) {
  const blob = new Blob([JSON.stringify(motion, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
