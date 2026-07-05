// Minimal static dev server for the crit e2e fixture app.
// Serves index.html at "/" and files from public/ at the root path.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 5199);
const ROOT = __dirname;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = url.pathname === '/' || url.pathname === '/dashboard' ? 'index.html' : url.pathname.slice(1);
    let full = path.join(ROOT, 'public', file);
    if (!fs.existsSync(full)) full = path.join(ROOT, file);
    if (!fs.existsSync(full) || !full.startsWith(ROOT)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  })
  .listen(PORT, () => console.log(`demo app on http://localhost:${PORT}`));
