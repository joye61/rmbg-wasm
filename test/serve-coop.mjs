// Static server with cross-origin isolation headers, for the multi-thread test.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, '..'));
const port = Number(process.argv[3] || 8789);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.tf': 'application/octet-stream',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'test/threads.html';
  const file = path.join(root, p);
  fs.readFile(file, (err, data) => {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (err) { res.writeHead(404, headers); res.end('not found: ' + p); return; }
    headers['Content-Type'] = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, headers);
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`coop/coep serving ${root}`);
  console.log(`threads test: http://127.0.0.1:${port}/test/threads.html`);
});
