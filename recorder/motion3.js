// Cubism .motion3.json, written by hand so a recording is an ordinary Live2D clip:
// the same file the Cubism Editor, VTube Studio and this demo's own motion loader
// read. Nothing custom has to understand it.
//
// A curve is [t0, v0, then one group per segment]: type 0 (linear) adds t, v;
// type 1/2 (bezier) adds tc1, vc1, tc2, vc2, t, v; type 7 (stepped) adds t, v.
// A recording is sampled at a fixed rate, so straight segments between samples are
// exactly what the camera saw - no easing invented on the way out.

const q = (v) => Math.round(v * 1e4) / 1e4;

export const FPS = 30;

/**
 * tracks: [{ id, values: [...] }] - each track sampled every 1/fps second.
 */
export function encodeMotion(tracks, { fps = FPS, loop = false } = {}) {
  const usable = tracks.filter((t) => t.values.length > 1);
  if (!usable.length) throw new Error('encodeMotion: nothing recorded');
  const frames = usable.reduce((m, t) => Math.max(m, t.values.length), 0);

  const curves = [];
  let segments = 0;
  let points = 0;
  for (const t of usable) {
    const curve = [0, q(t.values[0])];
    for (let i = 1; i < t.values.length; i++) curve.push(0, q(i / fps), q(t.values[i]));
    segments += t.values.length - 1;
    points += t.values.length;
    curves.push({ Target: 'Parameter', Id: t.id, Segments: curve });
  }

  return {
    Version: 3,
    Meta: {
      Duration: q((frames - 1) / fps),
      Fps: fps,
      Loop: !!loop,
      AreBeziersRestricted: false,
      CurveCount: curves.length,
      TotalSegmentCount: segments,
      TotalPointCount: points,
      UserDataCount: 0,
      TotalUserDataSize: 0,
    },
    Curves: curves,
  };
}

// Read a clip back the way a player would: needed for the inspector, and it is how
// the page proves its own encoder round-trips before offering a file for saving.
export function readMotion(json) {
  const curves = (json.Curves || []).map((c) => ({ id: c.Id, target: c.Target, points: pointsOf(c.Segments) }));
  return {
    duration: json.Meta ? json.Meta.Duration : 0,
    fps: json.Meta ? json.Meta.Fps : 0,
    loop: !!(json.Meta && json.Meta.Loop),
    curves,
    ids: curves.map((c) => c.id),
    valueAt,
  };

  function valueAt(id, time) {
    const c = curves.find((x) => x.id === id);
    if (!c || !c.points.length) return 0;
    const ps = c.points;
    if (time <= ps[0].t) return ps[0].v;
    for (let i = 1; i < ps.length; i++) {
      if (time <= ps[i].t) {
        const a = ps[i - 1], b = ps[i];
        const k = (time - a.t) / (b.t - a.t || 1e-6);
        // Linear in this writer, cubic in a bezier segment read from elsewhere.
        return a.bezier && a.c2 ? bezier(a, b, k) : a.v + (b.v - a.v) * k;
      }
    }
    return ps[ps.length - 1].v;
  }
}

function pointsOf(segments) {
  const out = [];
  if (!segments || segments.length < 2) return out;
  out.push({ t: segments[0], v: segments[1] });
  let i = 2;
  while (i < segments.length) {
    const type = segments[i];
    if (type === 1 || type === 2) {
      const c1 = segments[i + 1], c1v = segments[i + 2], c2 = segments[i + 3], c2v = segments[i + 4];
      out.push({ t: segments[i + 5], v: segments[i + 6], bezier: type, c1, c1v, c2, c2v });
      const prev = out[out.length - 2];
      if (prev) { prev.c1 = c1; prev.c1v = c1v; prev.c2 = c2; prev.c2v = c2v; prev.bezier = type; }
      i += 7;
    } else {
      out.push({ t: segments[i + 1], v: segments[i + 2], stepped: type === 7 });
      i += 3;
    }
  }
  return out;
}

function bezier(a, b, k) {
  // Cubic in time, matching how Cubism evaluates a bezier segment.
  const mt = 1 - k;
  const p1 = a.c1 !== undefined ? a.c1 : a.t, v1 = a.c1v !== undefined ? a.c1v : a.v;
  const p2 = a.c2 !== undefined ? a.c2 : b.t, v2 = a.c2v !== undefined ? a.c2v : b.v;
  return mt * mt * mt * a.v + 3 * mt * mt * k * v1 + 3 * mt * k * k * v2 + k * k * k * b.v;
}

// Names the recorder writes: filesystem-safe, and stable enough to type in a URL.
export function safeName(name, fallback = 'take') {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || fallback;
}
