// Turns "look at this element" into a smooth, animated gaze glide. It holds the
// gaze (so mouse-follow stops fighting it), optionally fires a guiding motion,
// then tweens the model's look direction from where it is now to the exact
// screen center of the element over `duration` ms with an ease-in-out curve.
// Because the host drives the head, eyes and arm from the same gaze vector, all
// three sweep toward the target together — that is the "guided movement".

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createGazeController(bridge, opts = {}) {
  const o = Object.assign(
    { duration: 700, holdMs: 1600, holdAfter: 'release', gesture: true },
    opts
  );

  let token = 0;          // bump to cancel an in-flight glide
  let releaseTimer = null;
  let held = false;

  function centerClip(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const c = bridge.screenToClip(cx, cy);
    return { x: c.x, y: c.y, cx, cy };
  }

  function cancel() {
    token++;
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    if (held) { bridge.holdGaze(false); held = false; }
    if (bridge.setTargetElement) bridge.setTargetElement(null);
  }

  // Resolve once the glide settles. `instant` skips the tween (used for tests and
  // for callers that just want an immediate, exact aim).
  function to(node, { instant = false } = {}) {
    if (!node || !node.el || !node.el.isConnected) {
      return Promise.resolve({ ok: false, reason: 'element missing' });
    }
    const target = centerClip(node.el);
    if (!target) return Promise.resolve({ ok: false, reason: 'element not visible' });

    token++;
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    if (!held) { bridge.holdGaze(true); held = true; }
    if (bridge.setTargetElement) bridge.setTargetElement(node.el);
    if (o.gesture && bridge.gesture) bridge.gesture();

    if (instant) {
      bridge.setGazeClip(target.x, target.y);
      return Promise.resolve({ ok: true, at: target });
    }

    const my = token;
    const start = bridge.curClip() || { x: 0, y: 0 };
    const t0 = performance.now();

    return new Promise((resolve) => {
      requestAnimationFrame(function frame(now) {
        if (my !== token) return resolve({ ok: false, cancelled: true });
        const b = centerClip(node.el) || target;   // re-sample in case layout shifted
        const t = Math.min(1, (now - t0) / o.duration);
        const e = easeInOutCubic(t);
        bridge.setGazeClip(start.x + (b.x - start.x) * e, start.y + (b.y - start.y) * e);
        if (t < 1) { requestAnimationFrame(frame); return; }

        if (o.holdAfter === 'keep') return resolve({ ok: true, at: b });
        releaseTimer = setTimeout(() => {
          if (my === token && held) { bridge.holdGaze(false); held = false; if (bridge.setTargetElement) bridge.setTargetElement(null); }
        }, o.holdMs);
        resolve({ ok: true, at: b });
      });
    });
  }

  return { to, cancel, isHeld: () => held, options: o };
}
