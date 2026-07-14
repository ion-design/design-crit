# ion compiler

<img src="../docs/assets/crit-magnifier.png" alt="Crit, a doodled speech-bubble character, inspecting with a magnifying glass" width="150" align="right">

The Babel pipeline that makes every rendered DOM element traceable back to its JSX source.
Extracted from [ion.design](https://ion.design)'s compiler and slimmed to what design-crit uses.

## Files

| File | Role |
| --- | --- |
| `ion-babel-plugin.js` | Babel visitor that stamps `data-ion-*` attributes on every JSX element and injects script tags into JSX `<body>` elements |
| `babel-processor.js` | Clones a project tree into a target directory, transforming `.jsx`/`.tsx` through the plugin and copying everything else |

`src/mirror.js` drives the processor to build the temporary mirror, and
`overlay/crit-overlay.js` decodes the attributes in the browser to attach
`source.file/line/component` to every event target.

## The attributes

Each non-fragment JSX element gets:

- **`data-ion-id`**: base64 JSON `{ path, startTag: { start, end }, component }`. The exact
  file, line, and column of the element's opening tag, straight from Babel's `node.loc`, plus
  the innermost enclosing component name.
- **`data-ion-caller-id`**: base64 JSON `{ caller, depth }`. The enclosing component at the
  point of render, so two instances of the same component can be told apart by walking up
  the DOM.
- **`data-ion-path`**: plain string like `Hero/section[0]/h1[0]`. A structural path that
  survives line-number drift from edits elsewhere in the file.

The transform emits JSX out, not `createElement` calls, so the app's own toolchain
(Next.js/SWC, Vite) compiles the output normally. `retainLines: true` keeps output line
numbers matching the original source. Elements already carrying `data-ion-id` are skipped,
so re-transforming is safe.

## Script injection

The plugin inserts `<script src="/crit-overlay.js" async />` as the first child of any JSX
`<body>` element (Next.js root layouts). Apps with an `index.html` entrypoint (Vite) get the
tag from `injectOverlay` in `src/mirror.js` instead.

## Known limitations

- Component detection is heuristic (capitalized function/arrow names): HOC-wrapped anonymous
  components and class components may miss the component name.
- Repeated renders of the same JSX (a `.map()`) produce N DOM elements with identical
  attributes.
- Elements rendered outside JSX (`dangerouslySetInnerHTML`, hand-built DOM) carry no
  attributes.
- Fragments are transparent: no attributes, and their children's ordinals merge into the
  parent's counters. Renamed fragment imports (`import { Fragment as F }`) are not detected.
