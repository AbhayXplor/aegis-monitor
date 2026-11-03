// Minimal RFC 6455 WebSocket server for pushing JSON events to the panel.
//
// Server -> client text frames; inbound frames are parsed only enough to answer ping,
// honour close, and drop everything else. A heartbeat ping every 25 s keeps proxies
// from idling the socket out and reaps dead peers.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Parse as many complete client frames as `buf` holds. Returns { frames, rest }. */
function parseClientFrames(buf) {
  const frames = [];
  let i = 0;
  while (buf.length - i >= 2) {
    const opcode = buf[i] & 0x0f;
    const masked = (buf[i + 1] & 0x80) !== 0;
    let len = buf[i + 1] & 0x7f;
    let off = i + 2;
    if (len === 126) {
      if (buf.length - off < 2) break;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length - off < 8) break;
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - off < maskLen + len) break;
    const mask = masked ? buf.subarray(off, off + 4) : null;
    const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
    if (mask) for (let k = 0; k < payload.length; k++) payload[k] ^= mask[k % 4];
    frames.push({ opcode, payload });
    i = off + maskLen + len;
  }
  return { frames, rest: buf.subarray(i) };
}

/**
 * @param {import('node:http').Server} server
 * @param {{ path?: string, verify?: (req: import('node:http').IncomingMessage, url: URL) => boolean }} opts
 *   verify gates the upgrade (origin / token checks); a falsy result answers 403.
 */
export function attachWS(server, { path = '/ws', verify = () => true } = {}) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key) {
      socket.destroy();
      return;
    }
    if (!verify(req, url)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
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
    socket.alive = true;
    const drop = () => clients.delete(socket);
    socket.on('close', drop);
    socket.on('error', drop);
    // HTTP server sockets are half-open: when the peer sends FIN we must end our side,
    // or the socket (and its slot in the broadcast set) lives forever.
    socket.on('end', () => {
      drop();
      socket.end();
    });

    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 1 << 20) return socket.destroy(); // a client has no business sending this much
      const { frames, rest } = parseClientFrames(pending);
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) {
          socket.end(frame(0x8, Buffer.alloc(0)));
          drop();
        } else if (f.opcode === 0x9) socket.write(frame(0xa, f.payload));
        else if (f.opcode === 0xa) socket.alive = true;
        // text/binary from clients: ignored on purpose
      }
    });
  });
}

const heartbeat = setInterval(() => {
  for (const s of [...clients]) {
    if (s.alive === false) {
      s.destroy();
      clients.delete(s);
      continue;
    }
    s.alive = false;
    try {
      s.write(frame(0x9, Buffer.alloc(0)));
    } catch {
      clients.delete(s);
    }
  }
}, 25_000);
heartbeat.unref();

export function broadcast(obj) {
  const buf = frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
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
