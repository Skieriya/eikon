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
| `discovery.js` | Queries the live DOM and builds a **tree** of UI elements. Landmarks (nav/section/header/footer) hold their controls as **subcontents**, but every control is also its own addressable node. Each node gets a `label`, an `id`, and an `aliases` list (its own words + synonyms like faq↔help↔support). Two passes: the **semantic** one (marked-up controls) and a **behavioural** one, which treats an element with a click handler, focusability or a `pointer` cursor as a control even when it is a plain `<div>`. It also walks **shadow roots** (open, and the closed ones only an add-on can see) and **same-origin frames**, and it judges whether a control opens a level **under the pointer** (a `:hover` rule that reveals something, an inline mouse handler, a caret). |
| `circularQueue.js` | Flattens the tree depth-first and wraps it in a **circular queue**: `next`/`prev` cycle the whole page with no dead ends, `jumpTo(id)` snaps to any node. A panel and its subcontents sit adjacent in the ring. |
| `gazeController.js` | Converts an element's **screen center → clip space** and glides the model's gaze there with an ease-in-out tween while holding mouse-follow. One `bridge.gesture()` kicks off a guiding motion; head, eyes and arm all track the same vector, so they sweep to the target together. |
| `commandRouter.js` | Parses natural language into intents (`goto` / `goal` / `next` / `prev` / `cycle` / `stop` / `list` / `teach` / `done`) and fuzzy-matches the target (exact alias, substring, prefix, Levenshtein), descending into subcontents so "email" finds the field inside the form. It also takes the pleasantries off the front of a request — "I want to …", "how do I …" — so the rest of the engine only sees what names something. |
| `semantics.js` | Reads a request as the **job** it describes — a verb ("edit") and an object ("images") — and scores every discovered control by how well it fits: the verb it uses, a synonym of it, a word that only names the job ("crop", "filters"), the object, or the panel the control sits in ("Photo editor"). A control that says nothing about the job is never offered, so *"i want to edit images"* finds the page's **Adjust** button rather than its **Images** link. |
| `paths.js` | Multi-level routes: a plan is an ordered list of steps, each resolved by fuzzy text matching with a saved-selector fallback. Ships a small table of known flows (`RECIPES`) and matches a question against them or against what the host taught her. |
| `index.js` | Wires it all: waits for the bridge, builds the queue, exposes `window.UIGuide`, re-discovers on DOM changes, runs the route state machine, watches for the press — or the hover — that completes a step, and binds the optional command box / controls. |

## Public API (`window.UIGuide`)

```js
UIGuide.say('where is faq');   // intent -> match -> animated look; returns a promise
UIGuide.say('i want to edit images');  // the same, but by what the control DOES
UIGuide.say('next');           // step the circular queue
UIGuide.startCycle(2200);      // auto-advance every 2.2s
UIGuide.jumpTo('faq');         // go straight to a node by id
UIGuide.clickTarget();         // press the element she is pointing at
UIGuide.heldElement();         // that element, if there is one
UIGuide.status();              // { count, current, cycling, items, path, teaching, known, held }
                                //   path: { name, i, n, awaiting, reveal, reveals, via, steps }
                                //     via: 'click' | 'hover' | 'either' — how the held
                                //          control is worked on this page
                                //     awaiting: 'click' | 'hover' | 'reveal' | 'settle'
UIGuide.elements;              // the discovered tree
```

Every method returns a result object (`{ ok, at }` on success, `{ ok:false, reason }`
otherwise), so callers can react to "not-found" etc.

## Asking by meaning

Nobody knows what a page calls its buttons, so people ask for the **job**:

```
"i want to edit images"     →  the page's Adjust button, not its Images link
"i want to crop an image"   →  whichever control does the cropping
"i want to delete a photo"  →  the destructive one, not the word "photo"
```

`semantics.js` reads the request as a verb and an object, then scores every control
she found by how much the page says about that job — on the control itself
(`Adjust`, `Crop`, `Filters`, a `type="file"` field is the upload whatever it is
called) or on the panel it sits in (a toolbar marked *"Photo editor"* is what makes
its **Crop** button an image editor). A control that says nothing about the job is
never offered, so a wrong-but-confident point stays impossible; and when the request
already names the control ("crop"), the literal match still wins.

The literal match keeps the words you actually said, filler and all: *"my
aadhaar"* finds **My Aadhaar**, not the **Download Aadhaar** link that happens to
carry the same noun.

## Pressing what she points at

`UIGuide.clickTarget()` presses the element she is holding — the whole pointer
sequence, in the element's own document, because some controls act on `pointerdown`
and never emit a `click` at all. It is opt-in: she never presses anything until
asked, and a route still waits for *you* to click unless you press the button for
her — in which case the guide sees that press like any other and the route moves on.

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
2. she says how the control is worked and **waits for you** — a capture-phase
   listener on the document, so a site that stops propagation on its own buttons
   cannot hide the press from her. Most controls are clicked; a level that opens
   **under the pointer** is hovered instead, and she watches for the pointer to
   rest on it rather than for a press. When the page gives no proof either way
   (a caret says *a level opens here*, but not whether the pointer or the click
   does it) she offers the hover and leaves the click standing by;
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

