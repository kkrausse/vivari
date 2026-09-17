const http = require('node:http');
const stats = { produced: 0, uploaded: 0, closed: 0 };
const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  res.on('close', () => { stats.closed++; });
  if (req.url === '/shutdown') { res.end('graceful'); server.close(); return; }
  if (req.url === '/stats') return res.end(JSON.stringify(stats));
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<h1>HTTP_PREVIEW_PASS</h1>'); }
  if (req.url === '/json') { res.setHeader('x-repeat', ['one', 'two']); res.setHeader('set-cookie', ['a=1', 'b=2']); return res.end('{"ok":true}'); }
  if (req.url === '/empty') { res.writeHead(204); return res.end(); }
  if (req.url === '/early') return res.end('early');
  if (req.url === '/never') return;
  if (req.url === '/broken') { res.write('first'); return setTimeout(() => res.destroy(), 30); }
  if (req.url === '/echo') { req.pipe(res); return; }
  if (req.url === '/upload') {
    stats.uploaded = 0;
    req.on('data', chunk => { stats.uploaded += chunk.length; req.pause(); setTimeout(() => req.resume(), 10); });
    req.on('end', () => res.end(String(stats.uploaded)));
    return;
  }
  if (req.url === '/sse') {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: first\n\n');
    const timer = setInterval(() => res.write('data: tick\n\n'), 100);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (req.url === '/large') {
    stats.produced = 0;
    const chunk = Buffer.alloc(65536, 173);
    function pump() {
      while (stats.produced < 32 * 1024 * 1024) {
        stats.produced += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    }
    pump();
    return;
  }
  res.writeHead(404); res.end();
}).listen(3187, '127.0.0.1', () => console.log('HTTP_STREAM_LISTENING'));
