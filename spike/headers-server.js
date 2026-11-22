// Spike: echo request headers as JSON. Delete after Task 5.
import http from 'node:http';

http
  .createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }, null, 2));
  })
  .listen(8790, '127.0.0.1', () => console.log('headers-server on 127.0.0.1:8790'));
