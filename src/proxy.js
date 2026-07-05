/**
 * Review proxy — sits between the browser and the mirrored app's dev server.
 *
 * The browser talks to this (stable) port; the app runs on an internal port.
 * We strip response headers that would break a Crit review of an otherwise
 * well-secured app:
 *   - Permissions-Policy / Feature-Policy  (microphone=() blocks getUserMedia
 *     no matter what the user allows in the browser)
 *   - Content-Security-Policy              (connect-src could block event/audio
 *     uploads to the collector; script-src could block the overlay)
 *
 * WebSocket upgrades (HMR) are piped through untouched.
 */

const http = require('http');
const net = require('net');

const STRIPPED_HEADERS = [
  'permissions-policy',
  'feature-policy',
  'content-security-policy',
  'content-security-policy-report-only',
];

function createReviewProxy({ targetPort, targetHost = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: targetHost, port: targetPort, path: req.url, method: req.method, headers: req.headers },
      (ur) => {
        const headers = { ...ur.headers };
        for (const h of STRIPPED_HEADERS) delete headers[h];
        res.writeHead(ur.statusCode, ur.statusMessage, headers);
        ur.pipe(res);
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('crit proxy: app dev server not reachable');
    });
    req.pipe(upstream);
  });

  // Pipe WebSocket upgrades raw (Next/Vite HMR).
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetPort, targetHost, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      raw += '\r\n';
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
  }

  return {
    server,
    listen,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}

module.exports = { createReviewProxy, STRIPPED_HEADERS };
