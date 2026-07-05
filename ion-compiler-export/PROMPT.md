# Ion Compiler — JSX Source Annotation System

> Context prompt: include this file in a project that needs to map rendered DOM elements back to
> their JSX source (file, line, column, component) in the browser — e.g. design review tooling that
> lets a human or agent click/inspect any element and know exactly where it lives in the code.

## What this system is

A three-part pipeline that makes every rendered DOM element self-describing:

1. **A Babel plugin** (`ion-babel-plugin.js`) that stamps three `data-ion-*` attributes onto every
   JSX element at transform time — encoding source file, line/column, enclosing component, and a
   structural path.
2. **A shadow-directory processor + watcher** (`babel-processor.js`, `watch.js`) that clones the
   entire project into a sibling directory with the transform applied, so the original source is
   never touched and the dev server runs from the clone.
3. **A browser script** (`ion-injection.js`) that decodes those attributes at runtime, provides
   click-to-inspect, a full page snapshot (DOM → source map), and re-locates elements from saved
   anchors even after the code has changed.

The result: any DOM node in the running app can answer "what file, what line, what component
rendered me?" — without React DevTools, source maps, or fiber inspection. It works on the plain
DOM, so it also works from screenshots + coordinates, iframes, or headless browsers.

---

## Part 1: The Babel plugin, in detail

The plugin (`ion-babel-plugin.js`) is a standard Babel visitor. It runs with
`@babel/plugin-syntax-jsx` (parse JSX without compiling it away) and, for `.tsx`,
`@babel/preset-typescript` with `ignoreExtensions: true` (strip types, keep JSX). Critically the
transform emits **JSX out**, not `createElement` calls — the output is still a valid source file
that the framework's own toolchain (Next.js/SWC, Vite, etc.) compiles normally afterward.

### The three attributes it injects

Given:

```jsx
// src/components/Hero.tsx
export function Hero() {
  return (
    <section className="hero">
      <h1>Give your website a job</h1>
    </section>
  );
}
```

the `<h1>` becomes (values illustrative):

```jsx
<h1
  data-ion-id="eyJwYXRoIjoi...base64..."
  data-ion-caller-id="eyJjYWxsZXIi...base64..."
  data-ion-path="Hero/section[0]/h1[0]"
>
```

**`data-ion-id`** — base64-encoded JSON, the precise source anchor:

```json
{
  "path": "src/components/Hero.tsx",
  "startTag": {
    "start": { "line": 4, "column": 4 },
    "end": { "line": 4, "column": 42 }
  },
  "component": "Hero"
}
```

Line/column come straight from Babel's `node.loc` on the `JSXElement`. This is the most precise
identifier and the most fragile: any edit above the element in the file shifts the line and
produces a different encoded value on the next transform.

**`data-ion-caller-id`** — base64-encoded JSON `{ "caller": "Hero", "depth": 1 }`. `caller` is the
innermost enclosing component; `depth` is the nesting level of the component stack at that point.
When component A renders component B, B's internal elements carry `caller: "B"` — so two `<Button>`
instances rendered by different parents can be told apart by walking the DOM upward and reading
ancestors' caller attributes (see `getCallStack` in the browser script). `depth` drifts when
intermediate components are added/removed; only `caller` is stable enough to match on.

**`data-ion-path`** — a **plain string** (not base64): the element's structural position inside its
component, e.g. `Hero/section[0]/h1[0]`. Each segment is `tagName[ordinal]` where the ordinal is a
per-tag-name sibling counter at that nesting level. This survives line/column drift entirely (edits
elsewhere in the file don't change it) but breaks if the JSX tree is restructured (wrapper added,
siblings of the same tag reordered).

### How the plugin tracks state

The plugin keeps three pieces of mutable state, reset on every `Program` enter/exit:

- **`currentFilePath`** — from `state.filename`. Babel normalizes `filename` against its `cwd`,
  so the encoded `path` is the **absolute** path of the original source file as seen from where
  the processor ran. Relativize it against the project root when displaying or when matching
  anchors across machines.
- **`componentStack`** — a stack of enclosing component names. Pushed on entering any
  `FunctionDeclaration` or `VariableDeclarator` (arrow/function expression) whose name starts with
  a capital letter (the React component convention), popped on exit. The top of the stack is the
  `component` in `data-ion-id` and the `caller` in `data-ion-caller-id`.
- **`pathStack`** — the structural-path stack. Frames are `{ prefix, counters }`. Entering a
  component pushes a root frame (`prefix: "Hero", counters: {}`); entering a JSX element computes
  its segment from the parent frame's counter (`counters["h1"]++ → "h1[0]"`), then pushes its own
  frame so its children nest under it. Fragments (`<>`, `<Fragment>`, `<React.Fragment>`) are
  **transparent**: they get no attributes and push no frame, so their children's ordinals merge
  into the parent's counters.

### Edge cases handled

- **Fragments** get no attributes (detected as `<Fragment>` or `<React.Fragment>`; note: this does
  not catch renamed imports like `import { Fragment as F }`).
- **Idempotency**: `hasAttribute` guard skips elements that already carry `data-ion-id`, so
  re-transforming already-transformed output is safe.
- **Member-expression tags** (`<Foo.Bar>`) and namespaced tags (`<svg:path>`) get sensible names in
  the structural path.
- **Elements with no `loc`** (synthetically generated nodes) are skipped.
- **Top-level JSX outside any component** gets `data-ion-id` but no caller/path attributes.

### Bonus: script-tag injection into `<body>`

The plugin also injects `<script src="/ion-injection.js" async={true} />` as the **first child of
any `<body>` JSX element** (e.g. a Next.js root layout), unless a script with `ion-injection` in
its `src` is already present. This is done **in the plugin** rather than as a post-processing step
deliberately: the file watcher re-transforms files on every change, which would wipe any
post-processed edits — but the plugin runs on every transform, so the tag always comes back.
For apps with an `index.html` instead of a JSX body (Vite SPAs), inject via the HTML plugin hook
instead (Ion has a `transformIndexHtml` Vite plugin for this).

### React caveat: hydration and DOM-only attributes

The attributes are stamped into the JSX, so they exist in both server-rendered HTML and the client
bundle — hydration sees identical attributes and does not mismatch. Note that "hydrating the DOM
tree" here means the transform enriches the markup itself; there is no runtime React integration,
no fibers, no devtools hooks. Anything React renders through `dangerouslySetInnerHTML`, portals to
hand-built DOM, or third-party non-JSX widgets will not carry attributes.

---

## Part 2: The shadow-directory pipeline

The transform never touches the original source. Instead, the whole project is cloned into a
**sibling** directory with transforms applied, and the dev server runs from the clone.

### Directory layout

```
parent/
├── my-app/                      # original source — never modified
│   ├── src/
│   ├── package.json
│   ├── next.config.ts
│   └── .ion/                    # tooling (git-excluded)
│       ├── babel/
│       │   ├── ion-babel-plugin.js
│       │   └── babel-processor.js
│       ├── scripts/
│       │   ├── watch.js
│       │   ├── injection-script.js   # source of truth for the browser script
│       │   └── inject-entry.js       # copies it into <target>/public/
│       ├── package.json         # {"private": true}
│       └── node_modules/        # @babel/core etc. — self-contained
└── .ion-target/                 # transformed clone — dev server runs HERE
    ├── src/                     # JSX/TSX transformed, everything else copied
    ├── public/ion-injection.js
    ├── node_modules/            # installed directly (see below)
    └── .env -> ../my-app/.env   # symlink
```

Two design decisions worth copying:

1. **Sibling, not nested.** The target sits *next to* the source at the same directory depth
   (`parent/my-app` → `parent/.ion-target`), so `__dirname`-relative paths in configs (e.g.
   `turbopack.root = path.resolve(__dirname, "../..")`) resolve identically. In a monorepo,
   `repo/apps/web` → `repo/apps/.ion-target`.
2. **Self-contained tooling deps.** Babel + chokidar are installed into `.ion/node_modules` with
   their own tiny `package.json` (`{"private":true}`), so the customer project's `package.json`
   and lockfile are never modified. The scripts resolve them from that path explicitly.

### Setup sequence

```bash
cd my-app
mkdir -p .ion/scripts .ion/babel
cd .ion && echo '{"private":true}' > package.json \
  && npm install @babel/core @babel/preset-typescript @babel/plugin-syntax-jsx @babel/types chokidar
cd ..

# keep the clone + tooling out of git without touching .gitignore
printf '%s\n' '.ion-target/' '.ion/' >> .git/info/exclude

# full clone + transform (ION_TARGET_DIR is relative to cwd; default ".ion-target")
ION_TARGET_DIR=../.ion-target node .ion/babel/babel-processor.js

# copy the browser script where the dev server will serve it
mkdir -p ../.ion-target/public && cp .ion/scripts/injection-script.js ../.ion-target/public/ion-injection.js

# node_modules + env in the target (see below)
for f in pnpm-lock.yaml yarn.lock package-lock.json bun.lockb bun.lock; do
  test -f "$f" && cp "$f" ../.ion-target/; done
(cd ../.ion-target && bun install || npm install)
ln -sf "$(pwd)/.env" ../.ion-target/.env

# continuous sync (initial compile + chokidar watch, debounced 100ms)
ION_TARGET_DIR=../.ion-target node .ion/scripts/watch.js &

# run the app from the clone
cd ../.ion-target && bun run dev
```

### What the processor does (`babel-processor.js`)

Recursively walks the source tree:

- **`.jsx`/`.tsx` files** → Babel transform (`retainLines: true` so output line numbers match the
  source — important because the encoded line numbers must point at the *original* file), written
  to the same relative path in the target.
- **Everything else** → byte-for-byte copy (including `.env` / `.env.local`; other dotfiles and
  `node_modules`, `.git`, `.next`, `dist`, `build`, `.turbo`, etc. are skipped).
- Plain `.ts` files are copied, not transformed — they can't contain JSX.

The watcher (`watch.js`) reuses the same processor for incremental syncs: add/change → re-transform
or re-copy the single file; unlink/unlinkDir → mirror the deletion. Operations are debounced and
batched. The framework's own dev server (running in the target) picks the change up via its normal
HMR.

### node_modules: symlink vs. install

Two options for giving the clone its dependencies:

- **Symlink** (`ln -s ../my-app/node_modules .ion-target/node_modules`) — instant, and fine for
  webpack- and Vite-based apps.
- **Real install in the target** — required for **Next.js with Turbopack**, which panics on
  symlinked `node_modules` crossing project boundaries. Copy the lockfile from the source, run the
  package manager in the target. This is what Ion does in production.

`.env` can always be a symlink (nothing inspects it structurally), which keeps secrets in one
place and live-updates.

---

## Part 3: The browser script (decoding the hydrated data)

`ion-injection.js` runs inside the served page. Core pieces:

### Decoding

```js
function decodeIonAttr(raw) {
  try { return JSON.parse(atob(raw)); } catch { return null; }
}

const el = event.target.closest('[data-ion-id]');
const nodeInfo   = decodeIonAttr(el.getAttribute('data-ion-id'));        // {path, startTag, component}
const callerInfo = decodeIonAttr(el.getAttribute('data-ion-caller-id')); // {caller, depth}
const structural = el.getAttribute('data-ion-path');                     // "Hero/section[0]/h1[0]"
```

An approximate render stack comes from walking up the DOM and collecting ancestors' decoded
`caller` values (`getCallStack`).

### Page snapshot (the design-review primitive)

`window.__ion.snapshot()` decodes **every** annotated element and pairs it with its bounding box,
visibility, and trimmed text. That gives you a complete `DOM → source` map of the rendered page in
one call — e.g. feed it to an agent alongside a screenshot so review comments like "the hero
heading is too small" can be attributed to `src/components/Hero.tsx:4` automatically.

### Anchors and the three-tier lookup

To persist a reference to an element (a review comment, a finding), store an **anchor** — the raw
attribute values plus their decoded plaintext fields:

```ts
type NodeAnchor = {
  dataIonId: string;            // raw base64
  dataIonCallerId: string | null;
  dataIonPath: string | null;
  tagName: string;              // decoded — for soft matching
  componentName: string | null;
  filePath: string;
  line: number;
  column: number;
  callStack: string[];
};
```

To re-find the element later (page reloaded, code edited), `findElementByAnchor` tries three tiers:

1. **Exact**: `querySelectorAll('[data-ion-id="<raw>"]')` + caller-id equality. Constant-time; hits
   while the source file is unchanged.
2. **Structural**: match `data-ion-path` + caller-id. Survives line/column drift from edits
   elsewhere in the file; breaks on tree restructure.
3. **Soft**: scan all annotated elements, decode each, match the stable triple
   `(filePath, componentName, tagName)` plus caller name; among multiple candidates pick the one
   whose source line is closest to the anchor's original line.

Non-recoverable cases (treat as orphaned): file renamed/moved, component renamed, same-tag siblings
reordered, wrapper element inserted in between.

### Interaction + parent-window protocol

The script exposes select mode (hover overlay, click → decode + `postMessage` to `window.parent`)
so the app can run inside an iframe of a review tool. Channels: parent sends `enter-select-mode` /
`exit-select-mode` / `get-snapshot` / `find-anchor`; the page posts `ion-injection-ready`,
`select-node` (full decoded payload + anchor + click position), `snapshot`, `anchor-result`. All
messages are `{ channel, data, source: 'ion-injection' }`. Everything also works standalone via
`window.__ion` and console output.

---

## Files in this kit

| File | Role |
| --- | --- |
| `ion-babel-plugin.js` | The Babel plugin — attribute stamping + `<body>` script injection |
| `babel-processor.js` | Clone + transform the project into `ION_TARGET_DIR` (CLI: full run, `process-file <p>`, `clean`) |
| `watch.js` | Initial compile + chokidar watcher for continuous source → target sync |
| `ion-injection.js` | Browser-side decoder: `window.__ion`, select mode, snapshot, three-tier anchor lookup |

Wiring: `babel-processor.js` requires `./ion-babel-plugin.js` from the same directory; both resolve
Babel/chokidar from `../node_modules` first (the self-contained `.ion/` layout), falling back to
normal resolution. `ion-injection.js` must be served at `/ion-injection.js` (put it in the target's
`public/`), matching the src the plugin injects.

## Known limitations

- Every JSX element is annotated (host tags and component tags alike — attributes on component
  tags land on whatever the component spreads its props onto, or nowhere); text nodes and
  fragments are not.
- Component detection is heuristic (capitalized function/arrow names) — HOC-wrapped anonymous
  components, `forwardRef`/`memo` wrappers, and class components register the inner element's
  attributes but may miss the component name.
- `data-ion-id` values change on any edit above the element; always store the full anchor, not just
  the id, and rely on the tiered lookup.
- Repeated renders of the same JSX (a `.map()`) produce N DOM elements with the **same** attributes;
  disambiguate with `elementIndex` (position within `querySelectorAll` results) if needed.
- The extra attributes bloat the DOM slightly and are visible in devtools — this is a dev-server
  tool, not something to ship to production.
