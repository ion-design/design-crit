const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { normalizeEvent, normalizeEvents, condenseEvents, targetLabel, timelineToText } = require('../src/events');

const fixtureEvents = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'events.json'), 'utf-8'));

test('normalizeEvent drops garbage', () => {
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent({ type: 'nonsense', timestamp_ms: 1 }), null);
  assert.equal(normalizeEvent({ type: 'click' }), null); // no timestamp
  assert.equal(normalizeEvent({ type: 'click', timestamp_ms: -5 }), null);
  assert.equal(normalizeEvent({ type: 'click', timestamp_ms: NaN }), null);
});

test('normalizeEvent whitelists fields and truncates', () => {
  const ev = normalizeEvent({
    type: 'click',
    timestamp_ms: 1000.7,
    url: 'http://x/'.padEnd(600, 'a'),
    x: 10,
    y: 20,
    password: 'should-not-survive',
    target: { tag: 'input', input_type: 'password', value: 'secret!' },
  });
  assert.equal(ev.timestamp_ms, 1001);
  assert.equal(ev.url.length, 500);
  assert.equal(ev.password, undefined);
  assert.equal(ev.target.value, undefined);
  assert.equal(ev.target.input_type, 'password');
});

test('normalizeEvents sorts by timestamp', () => {
  const evs = normalizeEvents([
    { type: 'click', timestamp_ms: 500 },
    { type: 'click', timestamp_ms: 100 },
  ]);
  assert.deepEqual(evs.map((e) => e.timestamp_ms), [100, 500]);
});

test('targetLabel prefers text, mentions component', () => {
  assert.equal(
    targetLabel({ tag: 'button', text: 'Create project', source: { component: 'App' } }),
    '“Create project” button in <App>'
  );
  assert.equal(targetLabel({ tag: 'a', href: '/x' }), 'link');
  assert.equal(targetLabel({ tag: 'input', input_type: 'text', placeholder: 'Project name' }), 'text input (placeholder “Project name”)');
  assert.equal(targetLabel({ tag: 'div', id: 'main' }), 'div #main');
  assert.equal(targetLabel(null), null);
});

test('condenseEvents: clicks and page changes preserved, moves clustered', () => {
  const entries = condenseEvents(normalizeEvents(fixtureEvents));
  const texts = entries.map((e) => e.text);

  // exact click preserved
  assert.ok(texts.some((t) => t.includes('User clicks “Create project” button in <App>')), texts.join('\n'));
  // page change preserved
  assert.ok(texts.some((t) => t.includes('Page changes to /projects/new')));
  // recording start
  assert.ok(texts.some((t) => t.includes('Recording starts on /dashboard')));
  // scroll cluster summarized to one entry
  const scrolls = entries.filter((e) => e.kind === 'scroll');
  assert.equal(scrolls.length, 1);
  assert.ok(scrolls[0].text.includes('scrolls down'));
  // mousemoves are clustered, not one entry per move
  const moves = entries.filter((e) => e.kind === 'pointer');
  const rawMoves = fixtureEvents.filter((e) => e.type === 'mousemove').length;
  assert.ok(moves.length < rawMoves, `expected fewer pointer entries (${moves.length}) than raw moves (${rawMoves})`);
  // dwell over the input field becomes a pause
  assert.ok(texts.some((t) => t.includes('Pointer pauses near text input (placeholder “Project name”)')), texts.join('\n'));
});

test('condenseEvents: no duplicate page entry when pathname unchanged', () => {
  const entries = condenseEvents(
    normalizeEvents([
      { type: 'recording_started', timestamp_ms: 0, pathname: '/a' },
      { type: 'navigation', timestamp_ms: 100, pathname: '/b' },
      { type: 'navigation', timestamp_ms: 200, pathname: '/b' },
      { type: 'navigation', timestamp_ms: 300, pathname: '/c' },
    ])
  );
  const pages = entries.filter((e) => e.kind === 'page');
  assert.equal(pages.length, 3); // start on /a, change to /b, change to /c
});

test('condenseEvents: pointer jitter is dropped', () => {
  const entries = condenseEvents(
    normalizeEvents([
      { type: 'mousemove', timestamp_ms: 100, x: 100, y: 100 },
      { type: 'mousemove', timestamp_ms: 200, x: 102, y: 101 },
    ])
  );
  assert.equal(entries.length, 0);
});

test('targetLabel includes file:line when the source anchor has one', () => {
  assert.equal(
    targetLabel({ tag: 'button', text: 'Create project', source: { component: 'Dashboard', file: '/Users/x/app/src/App.jsx', line: 25 } }),
    '“Create project” button in <Dashboard> (src/App.jsx:25)'
  );
});

test('condenseEvents: long continuous movement is split into time-aligned clusters', () => {
  // 12s of continuous movement (no gaps, no clicks) over changing targets —
  // must NOT collapse into a single cluster that hides later targets.
  const raw = [];
  const targets = [
    { tag: 'p', text: 'Welcome back' },
    { tag: 'h1', text: 'Dashboard' },
    { tag: 'button', text: 'Create project' },
    { tag: 'button', text: 'Projects' },
  ];
  for (let t = 0; t <= 12000; t += 200) {
    raw.push({
      type: 'mousemove',
      timestamp_ms: t,
      x: 100 + t / 10,
      y: 100 + (t % 1000) / 5,
      target: targets[Math.min(Math.floor(t / 3200), targets.length - 1)],
    });
  }
  const entries = condenseEvents(normalizeEvents(raw));
  const pointer = entries.filter((e) => e.kind === 'pointer');
  assert.ok(pointer.length >= 3, `expected >=3 clusters, got ${pointer.length}`);
  // the late-hovered buttons must survive condensation
  const all = pointer.map((e) => e.text).join(' | ');
  assert.ok(all.includes('“Create project” button'), all);
  assert.ok(all.includes('“Projects” button'), all);
  // clusters stay time-aligned: some cluster starts after 9s
  assert.ok(pointer.some((e) => e.start_ms >= 9000), 'expected a late cluster');
});

test('timelineToText formats mm:ss', () => {
  const text = timelineToText([{ start_ms: 63000, end_ms: 63000, kind: 'click', text: 'User clicks X', url: '/' }]);
  assert.equal(text, '[01:03] User clicks X');
});
