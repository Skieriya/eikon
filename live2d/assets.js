// Every model asset, downloaded once and keyed by the exact URL its model3.json
// declares.
//
// The host page calls prefetch() straight from the manifest — plain data, no SDK
// needed — so the heavy bytes (.moc3 + textures) transfer, and the textures decode,
// while the browser is still resolving the framework's module graph, instead of
// starting after it. loadModel() asks for the same URLs and gets the work already
// in flight back, so nothing is fetched twice and the order the two run in does not
// matter.

// tools/make_webp.py writes a display-sized .webp next to each declared texture;
// trying the sibling first and remembering the miss per folder means an
// unconverted model costs one 404 total, not one per texture.
const PREFER_WEBP = true;
const MIME = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const noWebp = new Set();
const downloads = new Map();   // declared url -> Promise<{ bytes, mime }>
const textures = new Map();    // declared url -> Promise<{ src, w, h, close }>

// encodeURI leaves structure chars intact but escapes spaces in folder/file names.
const enc = (u) => encodeURI(u);
const folderOf = (u) => u.slice(0, u.lastIndexOf('/') + 1);
const extOf = (u) => { const m = /\.([a-z0-9]+)$/i.exec(u); return m ? '.' + m[1].toLowerCase() : ''; };

async function download(url) {
  if (PREFER_WEBP && /\.png$/i.test(url)) {
    const dir = folderOf(url);
    if (!noWebp.has(dir)) {
      try {
        const w = await fetch(enc(url.replace(/\.png$/i, '.webp')));
        if (w.ok) return { bytes: await w.arrayBuffer(), mime: 'image/webp' };
      } catch (_) {}
      noWebp.add(dir);
    }
  }
  const r = await fetch(enc(url));
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return { bytes: await r.arrayBuffer(), mime: MIME[extOf(url)] || 'application/octet-stream' };
}

// The one entry point: the same url always resolves to the same single download,
// whether it was started by the prefetch or by the loader.
function load(url) {
  let p = downloads.get(url);
  if (!p) {
    p = download(url);
    downloads.set(url, p);
    // A failed download must not be cached, or a retry would never fetch again.
    p.catch(() => { downloads.delete(url); });
  }
  return p;
}

export const arrayBuffer = (url) => load(url).then((a) => a.bytes);

// Decoding is the longest single step of bring-up — longer than the download it
// waits on — so it happens here, the moment the bytes land, while the page is
// still importing the SDK. The blob's type is what tells the decoder the bytes are
// an image: Windows servers often label .webp as octet-stream. createImageBitmap
// decodes off the main thread; the object-URL path is the fallback without it.
function decodeTextureBytes(a) {
  const blob = new Blob([a.bytes], { type: a.mime });
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob, { premultiplyAlpha: 'premultiply' })
      .then((bmp) => ({ src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() }));
  }
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ src: img, w: img.width, h: img.height, close: () => URL.revokeObjectURL(img.src) });
    img.onerror = () => rej(new Error('image decode failed'));
    img.src = URL.createObjectURL(blob);
  });
}

// The same rule as load(): one url, one decode, no matter who asked first.
export function decodeTexture(url) {
  let p = textures.get(url);
  if (!p) {
    p = load(url).then(decodeTextureBytes);
    textures.set(url, p);
    p.catch(() => { textures.delete(url); });
  }
  return p;
}

// Bytes are dead weight once the texture is on the GPU, so hand them back.
export const release = (url) => { downloads.delete(url); textures.delete(url); };

// Exactly the files a model3.json points at. Parsing the JSON here (rather than
// through CubismModelSettingJson) is what lets this run before the SDK exists.
function assetUrls(model3Url, json) {
  const dir = folderOf(model3Url);
  const fr = json.FileReferences || {};
  const urls = [fr.Moc, fr.Physics, fr.Pose].filter(Boolean).map((f) => dir + f);
  const tex = fr.Textures || [];
  const textures = (Array.isArray(tex) ? tex : [tex]).map((t) => dir + t);
  urls.push(...textures);
  const motions = fr.Motions || {};
  for (const group in motions) for (const m of (motions[group] || [])) if (m && m.File) urls.push(dir + m.File);
  for (const e of (fr.Expressions || [])) if (e && e.File) urls.push(dir + e.File);
  return { urls, textures };
}

async function queueModel(model3Url, expressions, decodeTexturesNow) {
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(await arrayBuffer(model3Url)));
  } catch (err) {
    // Nothing to prefetch — the loader will report the real failure later.
    console.warn('[LIVE2D] prefetch skipped', model3Url, err && err.message);
    return;
  }
  const dir = folderOf(model3Url);
  const { urls, textures } = assetUrls(model3Url, json);
  // VTS-style assets keep .exp3.json files the model3.json never declares; the
  // manifest lists those explicitly.
  for (const e of expressions || []) urls.push(dir + (typeof e === 'string' ? e : e.file));
  for (const u of urls) load(u).catch(() => {});
  // The character on screen decodes straight out of the download. The ghosts wait:
  // a decoded 2048 atlas is 16 MB and they are not needed until she is already
  // pointing, so holding theirs warm across the calibration would cost memory for
  // nothing.
  if (decodeTexturesNow) for (const u of textures) decodeTexture(u).catch(() => {});
}

// Start downloading a manifest entry and everything it references. Never rejects:
// a missing file is the loader's news to report, not a prefetch error.
export function prefetch(entry) {
  const jobs = [queueModel(entry.model3, entry.expressions, true)];
  for (const c of (entry.companions || [])) jobs.push(queueModel(c.model3, c.expressions, false));
  return Promise.all(jobs);
}
