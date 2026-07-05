const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createReviewProxy, STRIPPED_HEADERS } = require('../src/proxy');

function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ echoed: body }));
        });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Content-Security-Policy': "default-src 'self'",
        'X-Custom': 'kept',
      });
      res.end('<html>app</html>');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('review proxy strips blocking headers, keeps the rest, pipes bodies', async () => {
  const upstream = await startUpstream();
  const proxy = createReviewProxy({ targetPort: upstream.address().port });
  const port = await proxy.listen(0);

  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  for (const h of STRIPPED_HEADERS) {
    assert.equal(res.headers.get(h), null, `${h} should be stripped`);
  }
  assert.equal(res.headers.get('x-custom'), 'kept');
  assert.equal(await res.text(), '<html>app</html>');

  const post = await fetch(`http://127.0.0.1:${port}/submit`, { method: 'POST', body: 'hello' });
  assert.deepEqual(await post.json(), { echoed: 'hello' });

  await proxy.close();
  upstream.close();
});

test('review proxy 502s when the app is down', async () => {
  const proxy = createReviewProxy({ targetPort: 1 }); // nothing listens there
  const port = await proxy.listen(0);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 502);
  await proxy.close();
});
