const http = require('http');

function buildChunk() {
  const size = 64 * 1024;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.random() * 256;
  return buf;
}

const CHUNK = buildChunk();

const server = http.createServer((req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  if (req.method === 'POST') {
    let receivedBytes = 0;
    req.on('data', (chunk) => { receivedBytes += chunk.length; });
    req.on('end', () => {
      res.writeHead(204, corsHeaders);
      res.end();
    });
    req.on('error', (err) => {
      console.error('Request error:', err);
      res.writeHead(500, corsHeaders);
      res.end('Server error');
    });
    return;
  }

  if (req.method === 'GET') {
    const downloadSize = 25 * 1024 * 1024;
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'application/octet-stream',
      'Content-Length': downloadSize,
    });
    let sent = 0;
    const sendChunk = () => {
      if (sent >= downloadSize) return res.end();
      const remaining = downloadSize - sent;
      const next = CHUNK.slice(0, Math.min(CHUNK.length, remaining));
      res.write(next);
      sent += next.length;
      setImmediate(sendChunk);
    };
    sendChunk();
    return;
  }

  res.writeHead(404, corsHeaders);
  res.end('Not found');
});

server.listen(8080, '0.0.0.0', () => {
  console.log('Speed test server listening on http://0.0.0.0:8080');
  console.log('  GET  /download  -> 25 MB random payload');
  console.log('  POST /upload    -> accept streaming upload');
});
