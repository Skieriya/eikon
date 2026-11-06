# Hu Tao as a Firefox add-on

She sits in the bottom-right corner of **every** page, follows your cursor, and points
at the element you ask about — the same guide engine the demo page uses, but no longer
trapped inside it.

```
"where is the email field?"   →  she scrolls to it and points
"next" / "previous"           →  walk the page in reading order
"cycle"                       →  she tours it by herself until you press Esc
"how do I turn off memory"    →  she walks you there, one click at a time
```

The add-on is Hu Tao plus the guide. `index.html` (the demo) and `recorder.html` (the
webcam capture window) are **not** in the package and are not loaded by it.

## Build

```bash
python tools/make_webp.py       # once: the textures the package ships
python tools/build_extension.py # -> build/firefox/ + build/hutao-guide-firefox.xpi
```

`build_extension.py` does three things the browser cannot do for itself:

1. concatenates `guide/*.js` plus `extension/src/content-glue.js` into one classic
   `content.js`, because content scripts have no `import` in any browser — the source
   files in `guide/` stay the single definition of the engine, shared with the demo page;
2. derives Hu Tao's file list from `models/manifest.js` and each `model3.json`, and
   copies the `.webp` textures instead of the 18–28 MB PNG atlases they were made from
   (it stops with an error if `make_webp.py` has not been run rather than shipping PNGs);
3. zips the result into `build/hutao-guide-firefox.xpi`, leaving the test fixture out.

Run `python tools/build_extension.py --no-zip` while iterating — the unpacked folder is
what Firefox loads anyway.

## Install (Firefox)

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `build/firefox/manifest.json`

Temporary add-ons vanish when Firefox restarts, which is the right trade while she is
still changing. For a permanent install, use
`about:profiles` → open the profile folder → drop `build/firefox/` into
`extensions/` inside the profile, or sign the `.xpi` with an AMO self-distribution
certificate (unsigned `.xpi` files only load in Developer Edition/Nightly).

## Use

| What | How |
|------|-----|
| Ask her something | popup → **Ask her**, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> |
| Next / previous element | **Next** / **Back**, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> / <kbd>P</kbd> |
| Tour the page | **Walk the page**, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>; <kbd>Esc</kbd> stops her |
| Find a setting by name | ask "how do I …" — she walks you there, a step at a time |
| Teach her a route | **Teach her a route** in the ask bar, do it yourself, then say **done** |
| Move her | press on her and drag |
| Resize her | drag her bottom-right corner, or spin the wheel over her |
| Lost her? | double-click her — back to the bottom-right corner at the default size |
| Off | popup → **Hide her** (**Bring her back** puts her on again) |

## Multi-level routes

The control you are looking for is usually inside a panel that does not exist until
you open it, so a single search cannot reach it. A **route** is the ordered list of
places she has to show you:

1. she points at the first one and **waits for your click** — she does not click it
   for you, and a site that swallows its own clicks cannot hide the press from her;
2. when the click lands she lets the page settle, then resolves the next step
   against whatever the page has become;
3. a step that is not in the DOM yet is not a failure: she says so and retries it
   whenever the page changes, because opening the panel that hides it is what
   triggers that.

Ask for a route by naming it — *"how do I turn off memory"* — and she answers with
the route she knows. You can also spell one out: *"settings → personalization →
memory"*.

She comes with a small table of routes for common sites (ChatGPT's memory and
account settings, GitHub notifications, YouTube autoplay, Google activity), and she
learns the rest from you:

- **Teach her a route** in the ask bar, do it the way you would, and say **done**.
  She remembers the words of each control, so the route survives a redesign of
  everything around it.
- Learned routes are kept in the add-on's own storage, per site — a page must not be
  able to read or poison what she knows about it. The popup lists the routes she has
  for the current site and **Forget them** removes them, in the open page as well.

The ask bar shows the route as it goes: which step you are on, which are done, and
**Skip** / **Back** / **Stop** if you would rather not take her advice.

Where she stands and how big she is are stored in her own frame's `localStorage`,
which belongs to the add-on rather than to the site, so she is still in the spot you
left her in on the next page. She is never more than a quarter off screen, and a
narrower window pulls her back into it.

The keys are gated on <kbd>Alt</kbd>+<kbd>Shift</kbd>, a chord no keyboard layout produces
a character with, so they do not steal a site's own shortcuts; <kbd>Esc</kbd> is only
claimed while she is actually holding a target, so a site's modal gets it first.

## How it is put together

```
manifest.json          MV2, <all_urls>, one content script
content.js             page: guide engine + glue (generated bundle)
background.js          add-on: the routes she has learned, per site
hutao.html + overlay.js  her frame: WebGL stage, ring, caption
panel.html + panel.js    ask bar: input, queue chips, route strip, shortcuts
action.html + action.js  the browserAction popup
```

Three documents on the page side, because one cannot do all of it:

- **content scripts are isolated worlds.** The guide needs the page's real DOM, so the
  engine runs there as a generated bundle; `window.UIGuide` is the same object the demo
  page installs.
- **her frame is a real iframe** (`hutao.html`), full-viewport and
  `pointer-events: none`. An iframe escapes the site's CSP and its CSS, and a
  full-viewport layer is what lets the highlight ring light up anywhere on the page.
  The page side aims through a fake canvas bridge whose "canvas" is that frame's own
  rect — which *is* the viewport — so the clip-space math stays identical to the demo,
  with no second geometry implementation.
- **the ask bar is a second, small iframe** (`panel.html`) because it needs a real
  cursor: pointer events there, none on her layer.

Messages are `postMessage` with a per-load nonce that rides in each frame's URL query,
checked against `event.source === window.parent` — page scripts cannot read the content
script's world, so they cannot forge the handshake or drive her.

The one thing that outlives a page is what she has learned, and that deliberately
does **not** live in the page: `background.js` keeps the routes in
`browser.storage.local`, keyed per host, and the content script asks for the current
host's routes once per page. A page can neither read what she knows about another
site nor write a route of its own.

Four behaviours worth knowing, all deliberate:

- **She scrolls to a target that is off screen** (`reveal()` in the glue) and then
  follows the element down, because the rect is re-sampled from the live element every
  frame. Scrolling is the only thing the add-on does to a page: it never clicks, types,
  hides, or rewrites anything. Waiting for *you* to click is the same rule seen from
  the other side.
- **A press on her art is hers, not the site's.** Her layer stays click-through
  everywhere else; the page side hit-tests the box she reports (`{t:'dock'}`) and
  swallows the press in capture phase only inside it. That is what makes dragging work
  without a second interactive frame — the cost is that whatever sits under her corner
  needs her moved first, which is why double-click sends her back to the corner.
- **Nothing pumps when she is idle.** The page-side rAF loop only runs while she holds a
  target, so a tab with her in the corner costs no per-frame work until you ask.
- **She waits for the click, she does not make it.** The click listener is in capture
  phase on the document, so it sees presses the site tries to intercept, and a step
  only completes when the press actually landed on the control she was pointing at.

## Test it without installing

`tools/build_extension.py` also copies `extension/test/fixture.html` to
`build/firefox/_test/`, where `../content.js` is the same bundle the manifest loads:

```bash
python serve.py
# http://127.0.0.1:8000/build/firefox/_test/fixture.html
```

The fixture is a deliberately messy page (fixed header, cookie banner, panels nested
three deep, a hidden upsell that must *not* be discovered, two buttons sharing a word),
and it sets `window.__hutaoRaf = 'manual'` so a harness with no rAF can still step her.
That mode is only reachable when the page itself sets the flag; nothing ships it.

It also carries a settings dialog that **builds itself one level at a time** — the
deepest control has no DOM at all until you have been walked down to it — which is
the case multi-level guidance exists to serve. And it stands in for the add-on's
background page, so the whole learn → remember → recall loop can be exercised over
http without installing anything.
