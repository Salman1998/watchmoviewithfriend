import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { RoomManager } from './room-manager.js';
import { SignalingServer } from './signaling.js';
import { serveStatic } from './static.js';

const WS_PATH = '/ws';

const rooms = new RoomManager(config);

const httpServer = createServer((request, response) => {
  const pathname = (request.url ?? '/').split('?')[0];

  if (pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ status: 'ok', rooms: rooms.roomCount, connections: signaling.connectionCount }));
    return;
  }

  if (config.staticDir) {
    serveStatic(config.staticDir, request, response).catch((error) => {
      console.error('[http] static file error', error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Watch Together signaling server. WebSocket endpoint: /ws');
});

// `noServer` lets us vet the path and Origin before accepting the upgrade.
// maxPayload caps frame size: SDP is a few KB, nothing legitimate is larger.
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const signaling = new SignalingServer(wss, rooms, config);

httpServer.on('upgrade', (request, socket, head) => {
  const pathname = (request.url ?? '/').split('?')[0];
  if (pathname !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const origin = request.headers.origin;
  if (config.allowedOrigins.length > 0 && (!origin || !config.allowedOrigins.includes(origin))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

httpServer.listen(config.port, () => {
  console.log(`Watch Together signaling server listening on :${config.port} (WebSocket path ${WS_PATH})`);
  if (config.allowedOrigins.length === 0) {
    console.log('ALLOWED_ORIGINS is not set: accepting WebSocket connections from any origin (development mode).');
  }
  if (config.turnUrls.length === 0 || !config.turnSecret) {
    console.log('No TURN server configured: people behind strict NATs or firewalls may fail to connect.');
  }
  if (config.staticDir) console.log(`Serving the web app from ${config.staticDir}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down.`);
  signaling.shutdown();
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
