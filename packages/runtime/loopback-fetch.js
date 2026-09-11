// HTTP loopback belongs to the guest network, not the browser's host machine.
// Use the existing Node HTTP/TCP byte relay, including streaming responses.
export function isGuestLoopback(input) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export async function loopbackFetch(require, input, init) {
  const request = new Request(input, init);
  if (request.signal.aborted) throw request.signal.reason;
  const url = new URL(request.url);
  const http = require('http');
  // Uploads are buffered here; response bodies (including SSE) remain streaming.
  const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
  if (request.signal.aborted) throw request.signal.reason;
  return new Promise((resolve, reject) => {
    let incoming, controller, settled = false, ended = false;
    const cleanup = () => request.signal.removeEventListener('abort', abort);
    const fail = error => {
      if (ended) return;
      ended = true;
      cleanup();
      if (!settled) reject(error);
      else controller?.error(error);
    };
    const req = http.request({hostname:url.hostname === '[::1]' ? '127.0.0.1' : url.hostname,
      port:Number(url.port || 80), path:url.pathname + url.search, method:request.method,
      headers:Object.fromEntries(request.headers),
    }, response => {
      incoming = response;
      const status = response.statusCode;
      if ([301,302,303,307,308].includes(status) && response.headers.location && request.redirect !== 'manual') {
        fail(new TypeError('Guest loopback fetch redirects are unsupported; use redirect: manual'));
        response.destroy(); req.destroy(); return;
      }
      const headers = new Headers();
      for (const [name,value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name,String(item));
      }
      const stream = new ReadableStream({
        start(c) { controller = c; },
        pull() { response.resume(); },
        cancel() { ended = true; cleanup(); response.destroy(); req.destroy(); },
      });
      response.on('data', chunk => {
        if (ended) return;
        controller.enqueue(new Uint8Array(chunk).slice());
        if (controller.desiredSize <= 0) response.pause();
      });
      response.on('end', () => { if (!ended) { ended = true; cleanup(); controller.close(); } });
      response.on('error', fail);
      response.on('aborted', () => fail(new TypeError('Guest HTTP response aborted')));
      const noBody = request.method === 'HEAD' || [204,205,304].includes(status);
      const result = new Response(noBody ? null : stream, {status, statusText:response.statusMessage || '', headers});
      Object.defineProperty(result, 'url', {value:request.url});
      settled = true;
      resolve(result);
    });
    const abort = () => { fail(request.signal.reason); incoming?.destroy(); req.destroy(); };
    request.signal.addEventListener('abort', abort, {once:true});
    req.on('error', fail);
    if (request.signal.aborted) { abort(); return; }
    if (bytes) req.write(bytes);
    req.end();
  });
}
