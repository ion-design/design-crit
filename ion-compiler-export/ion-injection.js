/**
 * Ion Injection / Decoder Script (browser side)
 *
 * Runs inside the page served from the transformed target directory. Decodes the
 * data-ion-* attributes the Babel plugin stamped onto every JSX element, exposes
 * a click-to-inspect mode, and can re-locate an element from a saved anchor even
 * after the source code has shifted (three-tier lookup).
 *
 * Serve it from public/ (the Babel plugin injects <script src="/ion-injection.js" async />
 * into every <body>), or paste it into a devtools console for ad-hoc use.
 *
 * Everything is also exposed on window.__ion for programmatic use:
 *   __ion.decode(el)          → { nodeInfo, callerInfo, structuralPath, callStack, tagName }
 *   __ion.snapshot()          → array describing every annotated element on the page
 *   __ion.find(anchor)        → element for a saved anchor (exact → structural → soft)
 *   __ion.enterSelectMode()   → hover highlight + click posts 'select-node' to parent
 */

(function () {
  'use strict';

  const ATTRIBUTE_NAME = 'data-ion-id';
  const CALLER_ATTRIBUTE_NAME = 'data-ion-caller-id';
  const PATH_ATTRIBUTE_NAME = 'data-ion-path';

  // ============================================
  // Decoding
  // ============================================

  // data-ion-id and data-ion-caller-id are base64(JSON). data-ion-path is plain text.
  // Defensive: returns null on any failure so malformed attrs never crash the page.
  function decodeIonAttr(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
      return JSON.parse(atob(raw));
    } catch (_e) {
      return null;
    }
  }

  // Walk up the DOM collecting the enclosing component names — an approximate
  // React render stack derived purely from the stamped attributes.
  function getCallStack(element) {
    const stack = [];
    let current = element;
    while (current && current !== document.body) {
      const callerInfo = decodeIonAttr(current.getAttribute(CALLER_ATTRIBUTE_NAME));
      if (callerInfo && callerInfo.caller) stack.push(callerInfo.caller);
      current = current.parentElement;
    }
    return stack;
  }

  // Full decode of a single element. nodeInfo is the source anchor:
  //   { path: "src/components/Hero.tsx",
  //     startTag: { start: {line, column}, end: {line, column} },
  //     component: "Hero" }
  function decodeElement(el) {
    const rawId = el.getAttribute(ATTRIBUTE_NAME);
    if (!rawId) return null;
    return {
      tagName: el.tagName.toLowerCase(),
      nodeInfo: decodeIonAttr(rawId),
      callerInfo: decodeIonAttr(el.getAttribute(CALLER_ATTRIBUTE_NAME)),
      structuralPath: el.getAttribute(PATH_ATTRIBUTE_NAME),
      callStack: getCallStack(el),
      rawDataIonId: rawId,
      rawDataIonCallerId: el.getAttribute(CALLER_ATTRIBUTE_NAME),
      rawDataIonPath: el.getAttribute(PATH_ATTRIBUTE_NAME),
    };
  }

  // Decode every annotated element on the page — a full DOM → source map.
  // For design reviews: pair this with bounding boxes and screenshot coordinates.
  function snapshot() {
    return Array.from(document.querySelectorAll('[' + ATTRIBUTE_NAME + ']')).map((el) => {
      const decoded = decodeElement(el);
      const rect = el.getBoundingClientRect();
      return {
        ...decoded,
        text: (el.textContent || '').trim().slice(0, 120),
        bounds: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        visible: rect.width > 0 && rect.height > 0,
      };
    });
  }

  // ============================================
  // Anchor lookup (three-tier fallback)
  // ============================================
  //
  // An "anchor" is what you persist when a user attaches feedback to an element:
  //   { dataIonId, dataIonCallerId, dataIonPath,       ← raw attribute values
  //     tagName, componentName, filePath, line }       ← decoded, for soft matching
  //
  // Tier 1: exact attribute match — works while the source file is unchanged.
  // Tier 2: structural path — survives line/column drift from edits elsewhere in the file.
  // Tier 3: soft match on (filePath, componentName, tagName, caller), closest line wins.

  function getCallerComponentName(callerIdRaw) {
    const decoded = decodeIonAttr(callerIdRaw);
    return decoded && typeof decoded.caller === 'string' ? decoded.caller : null;
  }

  function findElementExact(anchor) {
    const candidates = document.querySelectorAll('[' + ATTRIBUTE_NAME + '="' + anchor.dataIonId + '"]');
    for (const el of candidates) {
      const callerId = el.getAttribute(CALLER_ATTRIBUTE_NAME);
      if (anchor.dataIonCallerId == null && !callerId) return el;
      if (callerId === anchor.dataIonCallerId) return el;
    }
    return null;
  }

  function findElementByStructuralPath(anchor) {
    if (!anchor.dataIonPath) return null;
    const all = document.querySelectorAll('[' + PATH_ATTRIBUTE_NAME + ']');
    for (const el of all) {
      if (el.getAttribute(PATH_ATTRIBUTE_NAME) !== anchor.dataIonPath) continue;
      const callerId = el.getAttribute(CALLER_ATTRIBUTE_NAME);
      if (anchor.dataIonCallerId == null && !callerId) return el;
      if (callerId === anchor.dataIonCallerId) return el;
    }
    return null;
  }

  function findElementByAnchorSoft(anchor) {
    if (!anchor || !anchor.filePath) return null;
    const expectedCaller = getCallerComponentName(anchor.dataIonCallerId);
    const anchorComponent = anchor.componentName == null ? null : anchor.componentName;
    const anchorTagName = String(anchor.tagName || '').toLowerCase();
    if (!anchorTagName) return null;

    const all = document.querySelectorAll('[' + ATTRIBUTE_NAME + ']');
    const candidates = [];
    for (const el of all) {
      const decoded = decodeIonAttr(el.getAttribute(ATTRIBUTE_NAME));
      if (!decoded) continue;
      if (decoded.path !== anchor.filePath) continue;
      const elComponent = decoded.component == null ? null : decoded.component;
      if (elComponent !== anchorComponent) continue;
      if (el.tagName.toLowerCase() !== anchorTagName) continue;
      const elCaller = getCallerComponentName(el.getAttribute(CALLER_ATTRIBUTE_NAME));
      if (elCaller !== expectedCaller) continue;
      const line =
        decoded.startTag && decoded.startTag.start
          ? Number(decoded.startTag.start.line)
          : Number.MAX_SAFE_INTEGER;
      candidates.push({ el, line });
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].el;
    const targetLine = Number(anchor.line) || 0;
    candidates.sort((a, b) => Math.abs(a.line - targetLine) - Math.abs(b.line - targetLine));
    return candidates[0].el;
  }

  function findElementByAnchor(anchor) {
    return findElementExact(anchor) || findElementByStructuralPath(anchor) || findElementByAnchorSoft(anchor);
  }

  // Build a persistable anchor from a live element.
  function makeAnchor(el) {
    const decoded = decodeElement(el);
    if (!decoded || !decoded.nodeInfo) return null;
    return {
      dataIonId: decoded.rawDataIonId,
      dataIonCallerId: decoded.rawDataIonCallerId,
      dataIonPath: decoded.rawDataIonPath,
      tagName: decoded.tagName,
      componentName: decoded.nodeInfo.component || null,
      filePath: decoded.nodeInfo.path,
      line: decoded.nodeInfo.startTag.start.line,
      column: decoded.nodeInfo.startTag.start.column,
      callStack: decoded.callStack,
    };
  }

  // ============================================
  // Select mode (hover highlight + click to inspect)
  // ============================================

  let selectMode = false;
  let hoverOverlay = null;

  function ensureOverlay() {
    if (hoverOverlay) return hoverOverlay;
    hoverOverlay = document.createElement('div');
    hoverOverlay.style.cssText =
      'position:fixed;pointer-events:none;z-index:999999;border:2px solid #0066ff;' +
      'background:rgba(0,102,255,0.1);transition:all 0.1s ease-out;display:none;';
    document.body.appendChild(hoverOverlay);
    return hoverOverlay;
  }

  function moveOverlayTo(el) {
    const overlay = ensureOverlay();
    if (!el) {
      overlay.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    overlay.style.display = 'block';
  }

  function sendEvent(channel, data) {
    try {
      window.parent.postMessage({ channel, data, source: 'ion-injection' }, '*');
    } catch (_e) {
      /* standalone page — parent may be same window; console output below still fires */
    }
  }

  function handleMouseMove(event) {
    if (!selectMode) return;
    moveOverlayTo(event.target.closest('[' + ATTRIBUTE_NAME + ']'));
  }

  function handleClick(event) {
    if (!selectMode) return;
    const target = event.target.closest('[' + ATTRIBUTE_NAME + ']');
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();

    const decoded = decodeElement(target);
    const anchor = makeAnchor(target);

    console.log('[Ion] selected element →', decoded);
    sendEvent('select-node', {
      ...decoded,
      anchor,
      clickPos: { x: event.clientX, y: event.clientY },
    });
  }

  function enterSelectMode() {
    selectMode = true;
  }

  function exitSelectMode() {
    selectMode = false;
    moveOverlayTo(null);
  }

  // Parent window can drive select mode over postMessage.
  window.addEventListener('message', (event) => {
    if (!event.data || !event.data.channel) return;
    if (event.data.channel === 'enter-select-mode') enterSelectMode();
    if (event.data.channel === 'exit-select-mode') exitSelectMode();
    if (event.data.channel === 'get-snapshot') sendEvent('snapshot', { nodes: snapshot() });
    if (event.data.channel === 'find-anchor') {
      const el = findElementByAnchor(event.data.data.anchor);
      sendEvent('anchor-result', {
        found: !!el,
        bounds: el ? el.getBoundingClientRect().toJSON() : null,
      });
    }
  });

  function initialize() {
    document.addEventListener('click', handleClick, true);
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && selectMode) exitSelectMode();
    });

    window.__ion = {
      decode: decodeElement,
      snapshot,
      find: findElementByAnchor,
      makeAnchor,
      enterSelectMode,
      exitSelectMode,
    };

    sendEvent('ion-injection-ready', { url: window.location.href, timestamp: Date.now() });
    console.log('[Ion] decoder ready — window.__ion available');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
