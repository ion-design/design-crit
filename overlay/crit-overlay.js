/**
 * Crit Overlay — recording widget + event collector, injected into the
 * mirrored app. Vanilla JS, shadow DOM, no dependencies.
 *
 * The CLI bakes the session config into this file at mirror time by replacing
 * the placeholder below with {"sessionId": "...", "collectorUrl": "http://127.0.0.1:PORT"}.
 */

(function () {
  'use strict';

  var CRIT_CONFIG = /*__CRIT_CONFIG__*/ null;

  if (!CRIT_CONFIG || !CRIT_CONFIG.sessionId || !CRIT_CONFIG.collectorUrl) {
    console.warn('[Crit] no session config baked in — overlay disabled');
    return;
  }
  if (window.__critOverlayLoaded) return;
  window.__critOverlayLoaded = true;

  var SESSION_ID = CRIT_CONFIG.sessionId;
  var COLLECTOR = CRIT_CONFIG.collectorUrl.replace(/\/$/, '');

  var MOUSEMOVE_THROTTLE_MS = 120; // ~8 samples/sec
  var SCROLL_THROTTLE_MS = 250;
  var FLUSH_INTERVAL_MS = 1000;

  // ============================================
  // Recording state
  // ============================================

  var state = 'idle'; // idle | requesting-mic | recording | processing | completed | error | cancelled
  var errorMessage = '';
  var micDisabled = false; // user chose to record without audio

  var recStartWall = null; // ms epoch of recording start
  var mediaStream = null;
  var mediaRecorder = null;
  var audioSeq = 0;
  var uploadChain = Promise.resolve();
  var eventQueue = [];
  var flushTimer = null;
  var tickTimer = null;
  var listenersAttached = false;

  function nowMs() {
    return Date.now() - recStartWall;
  }

  // ============================================
  // Collector API
  // ============================================

  function api(path, body) {
    return fetch(COLLECTOR + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ sessionId: SESSION_ID }, body || {})),
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
        throw new Error(j.error || ('collector responded ' + r.status));
      });
      return r.json();
    });
  }

  function flushEvents(useBeacon) {
    if (eventQueue.length === 0) return Promise.resolve();
    var batch = eventQueue;
    eventQueue = [];
    var payload = JSON.stringify({ sessionId: SESSION_ID, events: batch });
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(COLLECTOR + '/crit/events', new Blob([payload], { type: 'application/json' }));
      return Promise.resolve();
    }
    return fetch(COLLECTOR + '/crit/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(function () {
      // re-queue on failure so events aren't lost
      eventQueue = batch.concat(eventQueue);
    });
  }

  function uploadAudioChunk(blob) {
    var seq = audioSeq++;
    uploadChain = uploadChain.then(function () {
      return fetch(COLLECTOR + '/crit/audio-chunk?sessionId=' + encodeURIComponent(SESSION_ID) + '&seq=' + seq, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
        keepalive: true,
      }).catch(function (e) {
        console.warn('[Crit] audio chunk upload failed', e);
      });
    });
    return uploadChain;
  }

  // ============================================
  // Event capture
  // ============================================

  function baseEvent(type) {
    return {
      type: type,
      timestamp_ms: nowMs(),
      wall_time: new Date().toISOString(),
      url: location.href,
      pathname: location.pathname,
      title: document.title,
      scroll_x: Math.round(window.scrollX),
      scroll_y: Math.round(window.scrollY),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  function decodeIonSource(el) {
    try {
      var anchorEl = el.closest && el.closest('[data-ion-id]');
      if (!anchorEl) return null;
      var info = JSON.parse(atob(anchorEl.getAttribute('data-ion-id')));
      var src = { file: info.path };
      if (info.startTag && info.startTag.start) src.line = info.startTag.start.line;
      if (info.component) src.component = info.component;
      return src;
    } catch (_e) {
      return null;
    }
  }

  function describeTarget(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = el.tagName.toLowerCase();
    var t = { tag: tag };

    // Privacy: never capture input values; passwords get nothing but the type.
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      t.input_type = type;
      if (type === 'password') return t;
      if (el.getAttribute('placeholder')) t.placeholder = el.getAttribute('placeholder').slice(0, 80);
      if (el.getAttribute('aria-label')) t.aria_label = el.getAttribute('aria-label').slice(0, 80);
    } else if (tag === 'textarea' || tag === 'select') {
      if (el.getAttribute('placeholder')) t.placeholder = el.getAttribute('placeholder').slice(0, 80);
      if (el.getAttribute('aria-label')) t.aria_label = el.getAttribute('aria-label').slice(0, 80);
    } else {
      // Only leaf-ish elements get a text label — containers (html, wrapper
      // divs, sections) would produce whole-page text blobs.
      var isContainer = tag === 'html' || tag === 'body' || el.childElementCount > 2;
      var text = isContainer ? '' : (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 80) t.text = text;
      if (el.getAttribute('aria-label')) t.aria_label = el.getAttribute('aria-label').slice(0, 80);
    }

    var role = el.getAttribute('role');
    if (role) t.role = role.slice(0, 40);
    if (el.id) t.id = el.id.slice(0, 80);
    if (el.className && typeof el.className === 'string') t.class = el.className.slice(0, 120);
    if (tag === 'a' && el.getAttribute('href')) {
      try {
        t.href = new URL(el.getAttribute('href'), location.href).pathname;
      } catch (_e) { /* ignore */ }
    }
    var rect = el.getBoundingClientRect();
    t.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    var source = decodeIonSource(el);
    if (source) t.source = source;
    return t;
  }

  function isWidgetEvent(ev) {
    var path = ev.composedPath ? ev.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      if (path[i] === host) return true;
    }
    return false;
  }

  function pushEvent(ev) {
    if (state !== 'recording') return;
    eventQueue.push(ev);
  }

  function shortSourceRef(source) {
    if (!source || !source.file) return null;
    var file = source.file;
    var idx = file.lastIndexOf('/src/');
    var short = idx !== -1 ? file.slice(idx + 1) : file.split('/').slice(-2).join('/');
    return source.line ? short + ':' + source.line : short;
  }

  function updateSourceMarker(el) {
    if (!srcEl) return;
    var source = decodeIonSource(el);
    if (source) {
      var ref = shortSourceRef(source) || '';
      srcEl.textContent = (source.component ? '<' + source.component + '> ' : '') + ref;
      srcEl.classList.remove('empty');
    } else if (el && el.tagName) {
      srcEl.textContent = '<' + el.tagName.toLowerCase() + '> (no source annotation)';
      srcEl.classList.add('empty');
    }
  }

  function renderSourcePanel() {
    srcPanel.innerHTML = '';
    srcEl = null;
    var visible = state === 'recording' && !srcDismissed;
    srcPanel.classList.toggle('hidden', !visible);
    if (!visible) return;
    srcPanel.appendChild(el('div', 'src-icon'));
    srcEl = el('div', 'src-text empty', 'Hover the app to inspect source…');
    srcPanel.appendChild(srcEl);
    var dismiss = button('✕', 'subtle', function () {
      srcDismissed = true;
      renderSourcePanel();
    });
    dismiss.title = 'Hide source inspector';
    srcPanel.appendChild(dismiss);
  }

  var lastMove = 0;
  function onMouseMove(e) {
    if (state !== 'recording' || isWidgetEvent(e)) return;
    var now = Date.now();
    if (now - lastMove < MOUSEMOVE_THROTTLE_MS) return;
    lastMove = now;
    updateSourceMarker(e.target);
    var ev = baseEvent('mousemove');
    ev.x = e.clientX;
    ev.y = e.clientY;
    ev.x_pct = round3(e.clientX / window.innerWidth);
    ev.y_pct = round3(e.clientY / window.innerHeight);
    ev.target = describeTarget(e.target);
    pushEvent(ev);
  }

  function onPointerButton(type) {
    return function (e) {
      if (state !== 'recording' || isWidgetEvent(e)) return;
      var ev = baseEvent(type);
      ev.x = e.clientX;
      ev.y = e.clientY;
      ev.x_pct = round3(e.clientX / window.innerWidth);
      ev.y_pct = round3(e.clientY / window.innerHeight);
      ev.target = describeTarget(e.target);
      pushEvent(ev);
    };
  }

  var lastScroll = 0;
  function onScroll() {
    if (state !== 'recording') return;
    var now = Date.now();
    if (now - lastScroll < SCROLL_THROTTLE_MS) return;
    lastScroll = now;
    pushEvent(baseEvent('scroll'));
  }

  var resizeTimer = null;
  function onResize() {
    if (state !== 'recording') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      pushEvent(baseEvent('viewport_resize'));
    }, 300);
  }

  function onVisibility() {
    if (state !== 'recording') return;
    var ev = baseEvent('visibility');
    ev.target = { tag: 'document', text: document.visibilityState };
    pushEvent(ev);
  }

  var lastUrl = location.href;
  function checkNavigation() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (state === 'recording') pushEvent(baseEvent('navigation'));
    }
  }

  function patchHistory() {
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = history[fn];
      history[fn] = function () {
        var out = orig.apply(this, arguments);
        setTimeout(checkNavigation, 0);
        return out;
      };
    });
    window.addEventListener('popstate', function () { setTimeout(checkNavigation, 0); });
    window.addEventListener('hashchange', function () {
      if (state === 'recording') pushEvent(baseEvent('hashchange'));
      lastUrl = location.href;
    });
  }

  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', onPointerButton('mousedown'), true);
    document.addEventListener('mouseup', onPointerButton('mouseup'), true);
    document.addEventListener('click', onPointerButton('click'), true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    patchHistory();
    window.addEventListener('pagehide', function () {
      if (state === 'recording') flushEvents(true);
    });
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  // ============================================
  // Recording control
  // ============================================

  function startRecording() {
    setState('requesting-mic');
    var micPromise = micDisabled
      ? Promise.resolve(null)
      : navigator.mediaDevices.getUserMedia({ audio: true });

    micPromise
      .then(function (stream) {
        mediaStream = stream;
        return api('/crit/start', {});
      })
      .then(function () {
        recStartWall = Date.now();
        audioSeq = 0;
        try { sessionStorage.setItem('crit_rec_start', String(recStartWall)); } catch (_e) {}

        if (mediaStream) {
          var mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
          mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
          mediaRecorder.ondataavailable = function (e) {
            if (e.data && e.data.size > 0) uploadAudioChunk(e.data);
          };
          mediaRecorder.start(1000); // 1s chunks
        }

        attachListeners();
        var ev = baseEvent('recording_started');
        ev.timestamp_ms = 0;
        eventQueue.push(ev);
        flushTimer = setInterval(flushEvents, FLUSH_INTERVAL_MS);
        setState('recording');
        tickTimer = setInterval(renderTime, 250);
      })
      .catch(function (err) {
        console.warn('[Crit] failed to start recording:', err);
        if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
          errorMessage = 'Microphone permission denied.';
        } else if (err && err.name === 'NotFoundError') {
          errorMessage = 'No microphone found.';
        } else {
          errorMessage = 'Could not start recording: ' + (err && err.message ? err.message : err);
        }
        stopTracks();
        setState('error');
      });
  }

  function stopMediaRecorder() {
    return new Promise(function (resolve) {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') return resolve();
      mediaRecorder.onstop = function () { resolve(); };
      try { mediaRecorder.stop(); } catch (_e) { resolve(); }
    });
  }

  function stopTracks() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    mediaRecorder = null;
  }

  function stopRecording() {
    if (state !== 'recording') return;
    var duration = nowMs();
    pushEvent(Object.assign(baseEvent('recording_stopped'), { timestamp_ms: duration }));
    setState('processing');
    clearInterval(flushTimer);
    clearInterval(tickTimer);

    stopMediaRecorder()
      .then(function () {
        stopTracks();
        return flushEvents();
      })
      .then(function () { return uploadChain; })
      .then(function () { return api('/crit/stop', { duration_ms: duration }); })
      .then(function () { pollStatus(); })
      .catch(function (err) {
        errorMessage = 'Failed to finalize: ' + err.message;
        setState('error');
      });
  }

  function restartRecording() {
    clearInterval(flushTimer);
    clearInterval(tickTimer);
    stopMediaRecorder().then(function () {
      stopTracks();
      eventQueue = [];
      return api('/crit/restart', {});
    }).then(function () {
      startRecording();
    }).catch(function (err) {
      errorMessage = 'Restart failed: ' + err.message;
      setState('error');
    });
  }

  function cancelSession() {
    clearInterval(flushTimer);
    clearInterval(tickTimer);
    stopMediaRecorder().then(function () {
      stopTracks();
      return api('/crit/cancel', { reason: 'user_cancelled' });
    }).then(function () {
      setState('cancelled');
    }).catch(function () {
      setState('cancelled');
    });
  }

  var pollFailures = 0;
  function pollStatus() {
    fetch(COLLECTOR + '/crit/status?sessionId=' + encodeURIComponent(SESSION_ID))
      .then(function (r) { return r.json(); })
      .then(function (s) {
        pollFailures = 0;
        if (s.state === 'completed') {
          setState('completed');
        } else if (s.state === 'error') {
          errorMessage = s.error || 'Processing failed.';
          setState('error');
        } else if (s.state === 'cancelled') {
          setState('cancelled');
        } else {
          setTimeout(pollStatus, 1000);
        }
      })
      .catch(function () {
        // Collector gone — the CLI has already finished and shut down.
        pollFailures++;
        if (pollFailures >= 3) {
          setState('completed');
        } else {
          setTimeout(pollStatus, 1500);
        }
      });
  }

  // ============================================
  // Widget UI (shadow DOM, draggable)
  // ============================================

  var host = document.createElement('div');
  host.id = 'crit-overlay-host';
  var shadow = host.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    // Shared glass panel treatment
    '.glass { background: rgba(18, 21, 28, 0.55);',
    '  -webkit-backdrop-filter: blur(20px) saturate(1.7); backdrop-filter: blur(20px) saturate(1.7);',
    '  border: 1px solid rgba(255,255,255,0.14); border-radius: 16px;',
    '  box-shadow: 0 12px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12),',
    '    inset 0 -1px 0 rgba(0,0,0,0.2);',
    '  color: #f2f4f8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
    // Main recording pill
    '.crit { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);',
    '  z-index: 2147483647; padding: 10px 14px;',
    '  display: flex; align-items: center; gap: 10px; user-select: none; cursor: grab; }',
    '.crit.dragging { cursor: grabbing; }',
    '.crit .dot { width: 10px; height: 10px; border-radius: 50%; background: rgba(255,255,255,0.35);',
    '  box-shadow: 0 0 6px rgba(255,255,255,0.15); flex: none; }',
    '.crit.recording .dot { background: #ff4d5e; box-shadow: 0 0 10px rgba(255,77,94,0.8); animation: crit-pulse 1.2s infinite; }',
    '@keyframes crit-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }',
    '.crit .label { font-size: 13px; line-height: 1.3; white-space: nowrap; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }',
    '.crit .time { font-variant-numeric: tabular-nums; font-size: 13px; color: rgba(242,244,248,0.65); }',
    '.crit button, .crit-src button { all: unset; cursor: pointer; font-size: 13px; font-weight: 600; padding: 6px 12px;',
    '  border-radius: 10px; background: rgba(255,255,255,0.10); color: #f2f4f8; white-space: nowrap;',
    '  border: 1px solid rgba(255,255,255,0.08); transition: background .15s ease; }',
    '.crit button:hover, .crit-src button:hover { background: rgba(255,255,255,0.18); }',
    '.crit button.primary { background: rgba(225,29,72,0.85); border-color: rgba(255,255,255,0.18);',
    '  box-shadow: 0 2px 12px rgba(225,29,72,0.35); }',
    '.crit button.primary:hover { background: rgba(244,63,94,0.95); }',
    '.crit button.subtle, .crit-src button.subtle { background: transparent; border: none; color: rgba(242,244,248,0.55); padding: 6px 6px; }',
    '.crit button.subtle:hover, .crit-src button.subtle:hover { color: #f2f4f8; background: transparent; }',
    '.crit .spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #f2f4f8;',
    '  border-radius: 50%; animation: crit-spin .8s linear infinite; flex: none; }',
    '@keyframes crit-spin { to { transform: rotate(360deg); } }',
    // Source inspector panel — fixed size, bottom-left, dismissable
    '.crit-src { position: fixed; bottom: 24px; left: 24px; z-index: 2147483646;',
    '  width: 300px; height: 44px; box-sizing: border-box; padding: 0 6px 0 14px;',
    '  display: flex; align-items: center; gap: 8px; user-select: none; }',
    '.crit-src.hidden { display: none; }',
    '.crit-src .src-icon { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #7ee2a8;',
    '  box-shadow: 0 0 8px rgba(126,226,168,0.7); }',
    '.crit-src .src-text { flex: 1 1 auto; font-size: 11px; color: #7ee2a8;',
    '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;',
    '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.crit-src .src-text.empty { color: rgba(242,244,248,0.45); }',
  ].join('\n');
  shadow.appendChild(style);

  var box = document.createElement('div');
  box.className = 'crit glass';
  shadow.appendChild(box);

  // Source inspector panel (bottom-left): shows the hovered element's
  // component + file:line while recording. Fixed size, dismissable.
  var srcPanel = document.createElement('div');
  srcPanel.className = 'crit-src glass hidden';
  var srcDismissed = false;
  shadow.appendChild(srcPanel);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function button(label, cls, onClick) {
    var b = el('button', cls, label);
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  var timeEl = null;
  var srcEl = null;

  function renderTime() {
    if (timeEl && recStartWall) {
      var s = Math.floor(nowMs() / 1000);
      timeEl.textContent = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
    }
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function setState(next) {
    state = next;
    render();
  }

  function render() {
    box.innerHTML = '';
    box.classList.toggle('recording', state === 'recording');
    timeEl = null;
    renderSourcePanel();

    switch (state) {
      case 'idle': {
        box.appendChild(el('div', 'dot'));
        box.appendChild(el('div', 'label', 'Claude requested a Crit — narrate your review, point with your mouse.'));
        box.appendChild(button('● Start Crit', 'primary', startRecording));
        box.appendChild(button('✕', 'subtle', cancelSession));
        break;
      }
      case 'requesting-mic': {
        box.appendChild(el('div', 'spinner'));
        box.appendChild(el('div', 'label', 'Requesting microphone…'));
        break;
      }
      case 'recording': {
        box.appendChild(el('div', 'dot'));
        timeEl = el('div', 'time', '00:00');
        box.appendChild(timeEl);
        box.appendChild(el('div', 'label', micDisabled ? 'Recording (no mic)' : 'Recording…'));
        box.appendChild(button('■ Stop', 'primary', stopRecording));
        box.appendChild(button('↻ Restart', '', restartRecording));
        box.appendChild(button('✕', 'subtle', cancelSession));
        renderTime();
        break;
      }
      case 'processing': {
        box.appendChild(el('div', 'spinner'));
        box.appendChild(el('div', 'label', 'Processing Crit…'));
        break;
      }
      case 'completed': {
        box.appendChild(el('div', 'label', '✓ Review sent back to the agent. You can close this tab.'));
        break;
      }
      case 'cancelled': {
        box.appendChild(el('div', 'label', 'Crit cancelled. You can close this tab.'));
        break;
      }
      case 'error': {
        box.appendChild(el('div', 'label', errorMessage || 'Something went wrong.'));
        box.appendChild(button('Try Again', 'primary', function () {
          micDisabled = false;
          startRecording();
        }));
        if (/[Mm]icrophone/.test(errorMessage)) {
          box.appendChild(button('Record without mic', '', function () {
            micDisabled = true;
            startRecording();
          }));
        }
        box.appendChild(button('✕', 'subtle', cancelSession));
        break;
      }
    }
  }

  // Dragging
  (function makeDraggable() {
    var dragging = false;
    var offX = 0, offY = 0;
    box.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      box.classList.add('dragging');
      var rect = box.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      box.style.left = Math.max(0, Math.min(window.innerWidth - box.offsetWidth, e.clientX - offX)) + 'px';
      box.style.top = Math.max(0, Math.min(window.innerHeight - box.offsetHeight, e.clientY - offY)) + 'px';
      box.style.bottom = 'auto';
      box.style.transform = 'none';
    });
    window.addEventListener('mouseup', function () {
      dragging = false;
      box.classList.remove('dragging');
    });
  })();

  // ============================================
  // Boot
  // ============================================

  function boot() {
    document.body.appendChild(host);
    // If the page reloaded mid-recording, keep capturing events with the
    // original clock (audio cannot survive a reload — documented limitation).
    fetch(COLLECTOR + '/crit/session?sessionId=' + encodeURIComponent(SESSION_ID))
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var storedStart = null;
        try { storedStart = Number(sessionStorage.getItem('crit_rec_start')) || null; } catch (_e) {}
        if (s.state === 'recording' && storedStart) {
          recStartWall = storedStart;
          micDisabled = true;
          attachListeners();
          flushTimer = setInterval(flushEvents, FLUSH_INTERVAL_MS);
          setState('recording');
          tickTimer = setInterval(renderTime, 250);
          pushEvent(baseEvent('page_load'));
        } else if (s.state === 'completed') {
          setState('completed');
        } else if (s.state === 'cancelled') {
          setState('cancelled');
        } else {
          render();
        }
      })
      .catch(function () {
        // Collector gone (CLI exited) — hide the widget.
        host.remove();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
