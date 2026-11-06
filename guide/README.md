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
| `commandRouter.js` | Parses natural language into intents (`goto` / `goal` / `next` / `prev` / `cycle` / `stop` / `list` / `teach` / `done`) and fuzzy-matches the target (exact alias, substring, prefix, Levenshtein), descending into subcontents so "email" finds the field inside the form. |
| `paths.js` | Multi-level routes: a plan is an ordered list of steps, each resolved by fuzzy text matching with a saved-selector fallback. Ships a small table of known flows (`RECIPES`) and matches a question against them or against what the host taught her. |
| `index.js` | Wires it all: waits for the bridge, builds the queue, exposes `window.UIGuide`, re-discovers on DOM changes, runs the route state machine, watches for the click that completes a step, and binds the optional command box / controls. |

## Public API (`window.UIGuide`)

```js
UIGuide.say('where is faq');   // intent -> match -> animated look; returns a promise
UIGuide.say('next');           // step the circular queue
UIGuide.startCycle(2200);      // auto-advance every 2.2s
UIGuide.jumpTo('faq');         // go straight to a node by id
UIGuide.status();              // { count, current, cycling, items, path, teaching, known }
UIGuide.elements;              // the discovered tree
```

Every method returns a result object (`{ ok, at }` on success, `{ ok:false, reason }`
otherwise), so callers can react to "not-found" etc.

## Multi-level routes

A single search can only find what is already in the DOM, and the control you want
is usually inside a panel that does not exist until you open it. A **route** is the
ordered list of places she has to show you, one at a time:

```
"how do I turn off memory"        → a route she knows (bundled, or one you taught her)
"settings → personalization → memory"  → a route spelled out in the sentence
```

How a step works:

1. she resolves the step's words against the live DOM (fuzzy match, plus a saved
   selector as a fallback) and points at what she found;
2. she **waits for your click** — a capture-phase listener on the document, so a site
   that stops propagation on its own buttons cannot hide the click from her;
3. once the click lands she lets the page settle (550 ms quiet, 3 s cap, re-armed by
   DOM changes) and then resolves the *next* step against whatever the page became;
4. a step she cannot find is not fatal — she says so, and retries it whenever the page
   changes, because opening the panel that hides it is exactly what triggers that.

The host supplies two things and nothing else: `mountGuide({ caption, remember })`.
`caption(text, kind)` is how she speaks; `remember(plan)` is how a taught route is
persisted. The engine itself never touches extension APIs, so the same folder serves
the demo page and the add-on.

Teaching her is the same machinery turned around: `UIGuide.say('teach me how to …')`
makes her watch, each click you make becomes a step, and `say('done')` turns the
session into a route she can be asked about by name later.

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

