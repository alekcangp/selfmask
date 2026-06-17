const http = require('http');

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (req.method === 'POST') {
    let receivedBytes = 0;
    req.on('data', (chunk) => { receivedBytes += chunk.length; });
    req.on('end', () => {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
    });
    req.on('error', (err) => {
      console.error('Request error:', err);
      res.writeHead(500);
      res.end('Server error');
    });
    return;
  }

  res.writeHead(200);
  res.end('Upload test endpoint OK');
});

server.listen(8080, '0.0.0.0', () => {
  console.log('Upload test endpoint listening on 0.0.0.0:8080');
});