/**
 * Interaction event normalization + condensation.
 *
 * Raw overlay events (one JSON object per line in interaction_log.jsonl) are
 * condensed into a readable timeline: exact clicks and page changes are
 * preserved, mouse movement is summarized into clusters, scrolls are merged.
 */

const { formatClock } = require('./util');

const KNOWN_TYPES = new Set([
  'recording_started',
  'recording_stopped',
  'mousemove',
  'mousedown',
  'mouseup',
  'click',
  'scroll',
  'navigation',
  'hashchange',
  'viewport_resize',
  'visibility',
  'page_load',
]);

const MOVE_GAP_MS = 1500;
// A continuous movement cluster is also flushed after this long, so hover
// context stays time-aligned with the speech transcript (one 15s cluster
// would bury which element was hovered while a given sentence was spoken).
const MOVE_CLUSTER_MAX_MS = 1000;
const SCROLL_GAP_MS = 1500;
const JITTER_DISTANCE_PX = 20;
const PAUSE_DISTANCE_PX = 60;
const PAUSE_MIN_MS = 800;
const MIN_SCROLL_DELTA_PX = 40;

/** Validate + whitelist fields of a raw event. Returns null for garbage. */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!KNOWN_TYPES.has(raw.type)) return null;
  if (typeof raw.timestamp_ms !== 'number' || !isFinite(raw.timestamp_ms) || raw.timestamp_ms < 0) return null;

  const ev = {
    type: raw.type,
    timestamp_ms: Math.round(raw.timestamp_ms),
    wall_time: typeof raw.wall_time === 'string' ? raw.wall_time : null,
    url: typeof raw.url === 'string' ? raw.url.slice(0, 500) : null,
    pathname: typeof raw.pathname === 'string' ? raw.pathname.slice(0, 300) : null,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : null,
  };
  for (const k of ['x', 'y', 'x_pct', 'y_pct', 'scroll_x', 'scroll_y']) {
    if (typeof raw[k] === 'number' && isFinite(raw[k])) ev[k] = raw[k];
  }
  if (raw.viewport && typeof raw.viewport === 'object') {
    const { width, height } = raw.viewport;
    if (typeof width === 'number' && typeof height === 'number') ev.viewport = { width, height };
  }
  if (raw.target && typeof raw.target === 'object') {
    ev.target = normalizeTarget(raw.target);
  }
  return ev;
}

function normalizeTarget(t) {
  const out = {};
  const strFields = ['tag', 'role', 'text', 'aria_label', 'id', 'class', 'href', 'placeholder', 'input_type'];
  for (const k of strFields) {
    if (typeof t[k] === 'string' && t[k]) out[k] = t[k].slice(0, 120);
  }
  if (t.rect && typeof t.rect === 'object') {
    const { x, y, width, height } = t.rect;
    if ([x, y, width, height].every((v) => typeof v === 'number')) {
      out.rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    }
  }
  // Source anchor decoded from data-ion-* attributes (file/line/component).
  if (t.source && typeof t.source === 'object') {
    const s = {};
    if (typeof t.source.file === 'string') s.file = t.source.file.slice(0, 300);
    if (typeof t.source.line === 'number') s.line = t.source.line;
    if (typeof t.source.component === 'string') s.component = t.source.component.slice(0, 100);
    if (Object.keys(s).length) out.source = s;
  }
  return out;
}

function normalizeEvents(rawEvents) {
  return rawEvents
    .map(normalizeEvent)
    .filter(Boolean)
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
}

/** Human-friendly label for an event target. */
function targetLabel(target) {
  if (!target) return null;
  const kind = elementKind(target);
  let base = null;
  if (target.text) base = `“${target.text.slice(0, 60)}” ${kind}`;
  else if (target.aria_label) base = `“${target.aria_label.slice(0, 60)}” ${kind}`;
  else if (target.placeholder) base = `${kind} (placeholder “${target.placeholder.slice(0, 40)}”)`;
  else if (target.id) base = `${kind} #${target.id}`;
  else if (target.class) base = `${kind} .${String(target.class).split(/\s+/)[0]}`;
  else base = kind;
  if (target.source && target.source.component) base += ` in <${target.source.component}>`;
  const ref = shortSourceRef(target.source);
  if (ref) base += ` (${ref})`;
  return base;
}

/** Compact file:line reference, e.g. "src/App.jsx:25". */
function shortSourceRef(source) {
  if (!source || !source.file) return null;
  const file = source.file;
  const idx = file.lastIndexOf('/src/');
  const short = idx !== -1 ? file.slice(idx + 1) : file.split('/').slice(-2).join('/');
  return source.line ? `${short}:${source.line}` : short;
}

function elementKind(target) {
  const tag = (target.tag || '').toLowerCase();
  const role = (target.role || '').toLowerCase();
  if (role === 'button' || tag === 'button') return 'button';
  if (tag === 'a' || role === 'link') return 'link';
  if (tag === 'input') return target.input_type ? `${target.input_type} input` : 'input';
  if (tag === 'textarea') return 'text area';
  if (tag === 'select') return 'dropdown';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'img') return 'image';
  if (tag === 'nav') return 'navigation';
  return tag || 'element';
}

/**
 * Condense normalized events into timeline entries:
 *   { start_ms, end_ms, kind, text, url }
 */
function condenseEvents(events) {
  const entries = [];
  let moveBuffer = [];
  let scrollBuffer = [];
  let lastPath = null;

  const flushMoves = () => {
    const entry = summarizeMoves(moveBuffer);
    if (entry) entries.push(entry);
    moveBuffer = [];
  };
  const flushScrolls = () => {
    const entry = summarizeScrolls(scrollBuffer);
    if (entry) entries.push(entry);
    scrollBuffer = [];
  };
  const flushAll = () => {
    flushMoves();
    flushScrolls();
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'recording_started':
        lastPath = ev.pathname || null;
        entries.push(entry(ev, 'page', `Recording starts on ${ev.pathname || ev.url || 'the app'}`));
        break;
      case 'recording_stopped':
        flushAll();
        entries.push(entry(ev, 'meta', 'Recording stops'));
        break;
      case 'page_load':
      case 'navigation':
      case 'hashchange': {
        flushAll();
        const p = ev.pathname || ev.url || 'unknown page';
        if (p !== lastPath) {
          entries.push(entry(ev, 'page', `Page changes to ${p}`));
          lastPath = p;
        }
        break;
      }
      case 'click': {
        flushAll();
        const label = targetLabel(ev.target);
        entries.push(entry(ev, 'click', label ? `User clicks ${label}` : 'User clicks the page'));
        break;
      }
      case 'scroll': {
        flushMoves();
        if (scrollBuffer.length && ev.timestamp_ms - scrollBuffer[scrollBuffer.length - 1].timestamp_ms > SCROLL_GAP_MS) {
          flushScrolls();
        }
        scrollBuffer.push(ev);
        break;
      }
      case 'mousemove': {
        if (moveBuffer.length) {
          const gap = ev.timestamp_ms - moveBuffer[moveBuffer.length - 1].timestamp_ms;
          const span = ev.timestamp_ms - moveBuffer[0].timestamp_ms;
          if (gap > MOVE_GAP_MS) {
            flushMoves();
          } else if (span > MOVE_CLUSTER_MAX_MS) {
            // Time-cap flush: carry the boundary event into the next cluster
            // so dwells spanning several caps keep their continuity (identical
            // consecutive entries are merged afterwards).
            const carry = moveBuffer[moveBuffer.length - 1];
            flushMoves();
            moveBuffer.push(carry);
          }
        }
        moveBuffer.push(ev);
        break;
      }
      case 'viewport_resize':
        flushAll();
        if (ev.viewport) entries.push(entry(ev, 'meta', `Viewport resized to ${ev.viewport.width}×${ev.viewport.height}`));
        break;
      default:
        // mousedown/mouseup/visibility: kept in the raw log, not in the condensed timeline
        break;
    }
  }
  flushAll();
  entries.sort((a, b) => a.start_ms - b.start_ms);

  // Merge consecutive pointer entries with identical text (a dwell split by
  // the cluster time cap) into one entry spanning the whole period.
  const merged = [];
  for (const e of entries) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.kind === 'pointer' &&
      e.kind === 'pointer' &&
      prev.text === e.text &&
      e.start_ms - prev.end_ms <= MOVE_GAP_MS
    ) {
      prev.end_ms = Math.max(prev.end_ms, e.end_ms);
    } else {
      merged.push(e);
    }
  }
  return merged;
}

function entry(ev, kind, text) {
  return { start_ms: ev.timestamp_ms, end_ms: ev.timestamp_ms, kind, text, url: ev.pathname || ev.url || null };
}

function summarizeMoves(buffer) {
  if (buffer.length === 0) return null;
  const first = buffer[0];
  const last = buffer[buffer.length - 1];
  const duration = last.timestamp_ms - first.timestamp_ms;

  let distance = 0;
  for (let i = 1; i < buffer.length; i++) {
    const a = buffer[i - 1];
    const b = buffer[i];
    if (typeof a.x === 'number' && typeof b.x === 'number') {
      distance += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  if (distance < JITTER_DISTANCE_PX && duration < PAUSE_MIN_MS) return null; // jitter

  const labels = [];
  for (const ev of buffer) {
    const l = targetLabel(ev.target);
    if (l && !labels.includes(l)) labels.push(l);
  }
  const interesting = labels.filter((l) => !/^(element|div|span|section|main|body)/.test(l)).slice(0, 3);

  let text;
  if (distance < PAUSE_DISTANCE_PX && duration >= PAUSE_MIN_MS) {
    const near = interesting[interesting.length - 1] || labels[labels.length - 1];
    text = near ? `Pointer pauses near ${near}` : `Pointer pauses ${regionOf(last)}`;
  } else if (interesting.length > 0) {
    text = `Pointer moves over ${interesting.join(', ')}`;
  } else {
    text = `Pointer moves around ${regionOf(last)}`;
  }
  return { start_ms: first.timestamp_ms, end_ms: last.timestamp_ms, kind: 'pointer', text, url: last.pathname || null };
}

function regionOf(ev) {
  if (typeof ev.y_pct !== 'number' || typeof ev.x_pct !== 'number') return 'the page';
  const v = ev.y_pct < 0.34 ? 'top' : ev.y_pct < 0.67 ? 'middle' : 'bottom';
  const h = ev.x_pct < 0.34 ? 'left' : ev.x_pct < 0.67 ? 'center' : 'right';
  return `the ${v}-${h} of the page`;
}

function summarizeScrolls(buffer) {
  if (buffer.length === 0) return null;
  const first = buffer[0];
  const last = buffer[buffer.length - 1];
  const from = typeof first.scroll_y === 'number' ? first.scroll_y : 0;
  const to = typeof last.scroll_y === 'number' ? last.scroll_y : 0;
  const delta = to - from;
  if (Math.abs(delta) < MIN_SCROLL_DELTA_PX) return null;
  const dir = delta > 0 ? 'down' : 'up';
  return {
    start_ms: first.timestamp_ms,
    end_ms: last.timestamp_ms,
    kind: 'scroll',
    text: `User scrolls ${dir} (${Math.round(from)}px → ${Math.round(to)}px)`,
    url: last.pathname || null,
  };
}

/** Render condensed entries as "[mm:ss] ..." lines. */
function timelineToText(entries) {
  return entries.map((e) => `[${formatClock(e.start_ms)}] ${e.text}`).join('\n');
}

module.exports = {
  normalizeEvent,
  normalizeEvents,
  condenseEvents,
  targetLabel,
  shortSourceRef,
  timelineToText,
};
