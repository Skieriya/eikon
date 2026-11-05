# guide — UI-aware gaze guidance for the Live2D model

This folder is a self-contained module that lets the character **look at** and
**guide you to** any UI element on the page, driven either by stepping a circular
queue or by natural-language commands like `where is faq`.

It has **no rendering logic of its own** — it drives the model through a small
bridge the host page publishes on `window.__live2dGuide`. All the discovery,
queue, matching and animation logic lives here.

## Files

| file | role |
| --- | --- |
| `discovery.js` | Queries the live DOM and builds a **tree** of UI elements. Landmarks (nav/section/header/footer) hold their controls as **subcontents**, but every control is also its own addressable node. Each node gets a `label`, an `id`, and an `aliases` list (its own words + synonyms like faq↔help↔support). |
| `circularQueue.js` | Flattens the tree depth-first and wraps it in a **circular queue**: `next`/`prev` cycle the whole page with no dead ends, `jumpTo(id)` snaps to any node. A panel and its subcontents sit adjacent in the ring. |
| `gazeController.js` | Converts an element's **screen center → clip space** and glides the model's gaze there with an ease-in-out tween while holding mouse-follow. One `bridge.gesture()` kicks off a guiding motion; head, eyes and arm all track the same vector, so they sweep to the target together. |
| `commandRouter.js` | Parses natural language into intents (`goto` / `next` / `prev` / `cycle` / `stop` / `list`) and fuzzy-matches the target (exact alias, substring, prefix, Levenshtein), descending into subcontents so "email" finds the field inside the form. |
| `index.js` | Wires it all: waits for the bridge, builds the queue, exposes `window.UIGuide`, re-discovers on DOM changes, and binds the optional command box / controls. |

## Public API (`window.UIGuide`)

```js
UIGuide.say('where is faq');   // intent -> match -> animated look; returns a promise
UIGuide.say('next');           // step the circular queue
UIGuide.startCycle(2200);      // auto-advance every 2.2s
UIGuide.jumpTo('faq');         // go straight to a node by id
UIGuide.status();              // { count, current, cycling, items }
UIGuide.elements;              // the discovered tree
```

Every method returns a result object (`{ ok, at }` on success, `{ ok:false, reason }`
otherwise), so callers can react to "not-found" etc.

## Host bridge contract

The page must publish `window.__live2dGuide` with:

```js
{
  canvasEl(),                     // the GL canvas element
  screenToClip(clientX, clientY), // -> { x, y } clip space (x -1..1 right, y -1..1 up)
  curClip(),                      // -> { x, y } current gaze in clip space
  setGazeClip(x, y),              // aim head/eyes/arm at that clip point (exact)
  holdGaze(bool),                 // stop mouse-follow from overriding while guiding
  gaze(),                         // -> { mouseX, mouseY, dragX, dragY }
  gesture(),                      // play a guiding motion
}
```

`screenToClip` is the single source of truth for geometry, so the "look exactly
here" math is identical to the one the mouse cursor already uses — a target at
the cursor position produces the same gaze, guaranteeing alignment.

## Using it on another site (drop-in, not tied to this page)

Nothing in `discovery / circularQueue / gazeController / commandRouter` knows
about this page — they only use the bridge contract above and the live DOM. The
page-specific glue is produced by **`live2dBridge.js`**, a generic factory. Any
site can mount in ~3 lines:

```js
import { mountGuide } from './guide/index.js';

// Pass the handles you already have; `canvas` is the full-screen model viewport
// (it is only used to map an element's page position to a gaze direction).
const bridge = mountGuide({ canvas, model, look, onGesture: () => playTap() });

// then, in your existing render loop where you drove the look:
bridge.tick(dt);   // eases the gaze and calls look.updateParameters(model, x, -y)
```

That's the whole integration: `mountGuide({ canvas, model, look })` + one
`bridge.tick(dt)` per frame. If your app drives the look itself (this repo does),
omit `model`/`look` and read `bridge.gaze()` instead — the factory only eases.

- `sensitivity` / `smoothing` / `lookYSign` are tunable; defaults match a typical Cubism look feel.
- `exclude` can hide subtrees (e.g. a control panel) from discovery; elements with `data-guide-exclude` are always skipped, and the `canvas` is skipped automatically.
- Give any element a stable name/keywords with `data-guide-label` and `data-guide-alias` so commands like "where is support" hit exactly what you want.

### Live example

[`embed-demo/index.html`](./embed-demo/index.html) is a deliberately *different*
site (its own header, hero button, cards, ids) that imports the same module with
`mountGuide` and drives a stand-in model through the factory. Open it directly —
it proves the folder works with zero changes when the page changes.

