// Minimal RFC6455 WebSocket server (server -> client only).
// We only push JSON events to the panel, so we implement the handshake and
// unmasked text frames, and deliberately ignore inbound frames.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();

function frame(payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export function attachWS(server, { path = '/ws' } = {}) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    socket.setNoDelay(true);
    clients.add(socket);
    const drop = () => clients.delete(socket);
    socket.on('close', drop);
    socket.on('error', drop);
    socket.on('data', () => {}); // inbound frames ignored on purpose
  });
}

export function broadcast(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const buf = frame(payload);
  for (const s of [...clients]) {
    try {
      s.write(buf);
    } catch {
      clients.delete(s);
    }
  }
}

export function clientCount() {
  return clients.size;
}
