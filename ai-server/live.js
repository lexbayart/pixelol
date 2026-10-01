#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * pixelol-ai — LIVE TRANSPORT (Level 1, live mode)
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 *   A WebSocket server, written from scratch on Node built-ins, that lets an
 *   OPEN Pixelol tab attach to this process. Once it is attached, the same three
 *   MCP tools (get_canvas_state / draw_run / add_layer) drive the live canvas
 *   instead of only a file on disk: the human watches every stroke appear.
 *   Spec: pixelol-ai-adaptation.md §6.1 ("Живой, через локальный WebSocket").
 *
 * SECURITY BOUNDARY — read this before changing anything here
 *   The listener is bound to 127.0.0.1 ONLY. Never to 0.0.0.0, never to a LAN
 *   address: the protocol has no authentication, and "draw on the user's canvas"
 *   is full control of their project. The static file server (--serve) is on the
 *   same rule. Loopback is enforced twice: by the bind address below, and again
 *   by an Origin check on the upgrade request, so a page on another origin
 *   cannot silently attach.
 *
 * ZERO DEPENDENCIES
 *   Node built-ins only: http, crypto, fs, path. No `ws`, no package.json, no
 *   npm install. The WebSocket handshake and framing below are the RFC 6455
 *   subset a browser client actually uses.
 *
 * PROTOCOL (v1) — one JSON object per text frame, in both directions
 *   page → server
 *     {"t":"hello","protocol":1,"role":"page","app":"Pixelol","appVersion":"v46"}
 *         Page announces itself. Sent on every (re)connect.
 *     {"t":"pull","id":7}
 *         "Give me the document exactly as the human sees it right now."
 *     {"t":"pull_result","id":7,"text":"<AI-JSON as a string>"}
 *         The page's answer. Sent instead of {"t":"state"} — the page is the
 *         authority here, so it must never be told to apply its own document.
 *     {"t":"apply_result","seq":12,"ok":true,"applied":true,"message":"…","stats":{…}}
 *         Answer to a {"t":"state"} push: the page validated the document and
 *         says whether it was applied to the canvas, only proposed for review,
 *         or rejected. ok:false rolls the server's file back.
 *     {"t":"pong"}  Keepalive answer.
 *   server → page
 *     {"t":"welcome","protocol":1,"server":"pixelol-ai","version":"1.1.0","live":true,
 *      "port":8765,"pages":1,"canvas":{…summary…}}
 *         Handshake answer. Attaching NEVER overwrites the canvas.
 *     {"t":"state","protocol":1,"seq":12,"origin":"draw_run","apply":true,"document":{…}}
 *         A complete AI-JSON document for the page to run through its own
 *         validator and import path. It is the whole canvas, not a patch: the
 *         page applies it exactly like «Импорт от ИИ».
 *     {"t":"notice","level":"info","message":"…"}
 *         Something the human should see (agent connected, draw_run failed, …).
 *
 *   Two rules that keep both sides honest:
 *     • the page never applies anything it did not validate itself
 *       (_aiValidateJSON in index.html) — the server's validator is a mirror,
 *       the page's is the real one;
 *     • a write tool answers only after the page answered, and a rejection
 *       restores the file byte-for-byte.
 *
 * EITHER SIDE MAY START FIRST
 *   The server listens whenever it is started. The page retries with a backoff
 *   until the server answers, so it does not matter which one the human starts.
 * =========================================================================== */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PROTOCOL_VERSION = 1;

// A document is at most 1024×1024 cells per layer; 32 MiB of JSON is far above
// any sane drawing and far below anything that would hurt the user's machine.
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

// Default timeouts. The page may defer an apply while the human is mid-stroke
// (index.html waits for state.isDrawing to clear), so the ack window is generous.
const ACK_TIMEOUT_MS = 6000;
const PULL_TIMEOUT_MS = 2500;

// ─── Frame codec (RFC 6455, the subset a browser uses) ────────────────────────
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

class WSConnection {
  constructor(socket, log) {
    this.socket = socket;
    this.log = log || function () {};
    this.buf = Buffer.alloc(0);
    this.fragOp = 0;
    this.fragParts = [];
    this.fragBytes = 0;
    this.closed = false;
    this.id = ++WSConnection.counter;
    this.onMessage = null;   // (text) => void
    this.onClose = null;     // (code, reason) => void

    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => this._finish(1006, 'socket closed'));
    socket.on('error', err => { this.log('socket error: ' + (err && err.message)); this._finish(1006, 'socket error'); });
    socket.on('end', () => this._finish(1006, 'socket ended'));
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try { this._drain(); }
    catch (err) { this.log('frame error: ' + (err && err.message)); this.close(1002, 'protocol error'); }
  }

  _drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (rsv !== 0) { this.close(1002, 'rsv bits must be zero'); return; }

      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const big = b.readBigUInt64BE(off); off += 8;
        if (big > BigInt(MAX_MESSAGE_BYTES)) { this.close(1009, 'message too large'); return; }
        len = Number(big);
      }
      if (len > MAX_MESSAGE_BYTES) { this.close(1009, 'message too large'); return; }
      if (!masked) { this.close(1002, 'client frames must be masked'); return; }  // RFC 6455 §5.1
      if (b.length < off + 4 + len) return;

      const mask = b.subarray(off, off + 4); off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
      this.buf = b.subarray(off + len);

      // Control frames: never fragmented, never longer than 125 bytes.
      if (opcode >= 0x8) {
        if (!fin || len > 125) { this.close(1002, 'bad control frame'); return; }
        if (opcode === OP_CLOSE) {
          const code = len >= 2 ? payload.readUInt16BE(0) : 1005;
          this.close(code === 1005 || code === 1006 ? 1000 : code, payload.subarray(2).toString('utf8'));
          return;
        }
        if (opcode === OP_PING) { this._frame(OP_PONG, payload); }
        continue;   // OP_PONG needs no answer
      }

      // Data frames: 1 = text, 2 = binary, 0 = continuation.
      if (opcode === OP_BIN) { this.close(1003, 'binary frames are not part of this protocol'); return; }
      if (opcode === OP_CONT) {
        if (!this.fragOp) { this.close(1002, 'unexpected continuation frame'); return; }
        this.fragParts.push(payload);
        this.fragBytes += payload.length;
      } else {
        if (this.fragOp) { this.close(1002, 'new data frame inside a fragmented message'); return; }
        if (fin) { this._deliver(opcode, payload); continue; }
        this.fragOp = opcode;
        this.fragParts = [payload];
        this.fragBytes = payload.length;
      }
      if (this.fragBytes > MAX_MESSAGE_BYTES) { this.close(1009, 'message too large'); return; }
      if (fin && this.fragOp) {
        const whole = Buffer.concat(this.fragParts, this.fragBytes);
        const op = this.fragOp;
        this.fragOp = 0; this.fragParts = []; this.fragBytes = 0;
        this._deliver(op, whole);
      }
    }
  }

  _deliver(opcode, payload) {
    if (opcode !== OP_TEXT) { this.close(1003, 'binary frames are not part of this protocol'); return; }
    const text = payload.toString('utf8');
    if (this.onMessage) { try { this.onMessage(text); } catch (err) { this.log('onMessage crashed: ' + err.stack); } }
  }

  _frame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2); header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4); header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;   // server → client frames are never masked
    try { this.socket.write(Buffer.concat([header, payload])); return true; }
    catch (err) { this.log('write failed: ' + (err && err.message)); return false; }
  }

  send(text) {
    return this._frame(OP_TEXT, Buffer.from(String(text), 'utf8'));
  }

  sendJSON(obj) {
    try { return this.send(JSON.stringify(obj)); }
    catch (err) { this.log('sendJSON failed: ' + (err && err.message)); return false; }
  }

  ping() { return this._frame(OP_PING, Buffer.alloc(0)); }

  close(code, reason) {
    if (this.closed) { try { this.socket.destroy(); } catch (e) { /* already gone */ } return; }
    const c = (typeof code === 'number' && code >= 1000 && code <= 4999 && code !== 1004 && code !== 1005 && code !== 1006)
      ? code : 1000;
    const reasonText = String(reason == null ? '' : reason).slice(0, 120);
    const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reasonText));
    payload.writeUInt16BE(c, 0);
    payload.write(reasonText, 2, 'utf8');
    this._frame(OP_CLOSE, payload);
    this._finish(c, reasonText);
    // Give the close frame a moment to flush, then drop the socket.
    setTimeout(() => { try { this.socket.destroy(); } catch (e) { /* already gone */ } }, 50).unref();
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) { const fn = this.onClose; this.onClose = null; try { fn(code, reason); } catch (e) { /* hub cleanup must not throw */ } }
    try { this.socket.destroy(); } catch (e) { /* already gone */ }
  }
}
WSConnection.counter = 0;

// ─── Origin check (second lock on the localhost boundary) ─────────────────────
// Accept: no Origin at all (non-browser client, e.g. the test harness), "null"
// (a file:// page), and any http://127.0.0.1 | localhost | [::1] origin. Anything
// else — a page from the internet — is refused before the upgrade completes.
function originAllowed(origin) {
  if (!origin) return true;
  const o = String(origin).trim().toLowerCase();
  if (o === 'null') return true;
  try {
    const u = new URL(o);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch (err) {
    return false;
  }
}

// ─── The hub: which pages are attached, and how to talk to them ───────────────
class LiveHub {
  constructor(opts) {
    opts = opts || {};
    this.log = opts.log || function () {};
    this.ackTimeoutMs = opts.ackTimeoutMs || ACK_TIMEOUT_MS;
    this.pullTimeoutMs = opts.pullTimeoutMs || PULL_TIMEOUT_MS;
    this.pages = new Set();          // WSConnection
    this.meta = new Map();           // WSConnection -> {app, appVersion, origin, since}
    this.seq = 0;
    this.pullId = 0;
    this.pendingPush = null;         // one document push in flight at a time
    this.pendingPull = null;         // one pull in flight at a time
    this.serverInfo = opts.serverInfo || {};
  }

  attached() { return this.pages.size > 0; }
  count() { return this.pages.size; }

  add(conn, info) {
    this.pages.add(conn);
    this.meta.set(conn, Object.assign({ since: Date.now() }, info || {}));
    this.log('page attached (' + this.pages.size + ' open, ' + (info && info.app ? info.app : 'unknown app') +
      ' ' + (info && info.appVersion ? info.appVersion : '') + ', origin ' + (info && info.origin ? info.origin : 'none') + ')');
    conn.onMessage = text => this._onPageMessage(conn, text);
    conn.onClose = () => this._remove(conn);
  }

  _remove(conn) {
    if (!this.pages.delete(conn)) return;
    const info = this.meta.get(conn) || {};
    this.meta.delete(conn);
    this.log('page detached (' + this.pages.size + ' still open)');
    // Never leave a tool waiting on a page that just went away.
    if (this.pendingPush && this.pendingPush.pageIds.indexOf(conn.id) >= 0) {
      this.pendingPush.replies.delete(conn.id);
      this._maybeFinishPush(conn.id, 'detached');
    }
    if (this.pendingPull && this.pendingPull.pageId === conn.id) {
      this.pendingPull.resolve(null);
      this.pendingPull = null;
    }
    if (this.pages.size === 0 && info.app) {
      this.notice('info', 'Вкладка Pixelol закрыта — агент работает с файлом, рисунок не меняется.');
    }
  }

  broadcast(msg) {
    let n = 0;
    for (const conn of this.pages) if (conn.sendJSON(msg)) n++;
    return n;
  }

  notice(level, message) {
    return this.broadcast({ t: 'notice', protocol: PROTOCOL_VERSION, level: level, message: message });
  }

  // ── handshake answer. Never pushes a document: attaching must not overwrite
  //    whatever the human has on screen.
  welcome(conn, canvas) {
    return conn.sendJSON({
      t: 'welcome', protocol: PROTOCOL_VERSION,
      server: this.serverInfo.name || 'pixelol-ai',
      version: this.serverInfo.version || '',
      live: true,
      pages: this.pages.size,
      file: this.serverInfo.file || '',
      canvas: canvas || null,
      modes: {
        // What the page may do with a {"t":"state"} push.
        applyIfLiveModeOn: true,
        // What the server does with a {"t":"apply_result"}.
        rejectRollsBackTheFile: true,
      },
    });
  }

  // ── pull: ask the attached page for the document as the human sees it ───────
  pull(timeoutMs) {
    const wait = timeoutMs || this.pullTimeoutMs;
    if (!this.attached()) return Promise.resolve(null);
    if (this.pendingPull) return this.pendingPull.promise;
    const conn = Array.from(this.pages)[0];
    const id = ++this.pullId;
    let settle;
    const promise = new Promise(resolve => { settle = resolve; });
    const timer = setTimeout(() => {
      if (this.pendingPull && this.pendingPull.id === id) this.pendingPull = null;
      settle(null);
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
    this.pendingPull = {
      id: id, pageId: conn.id, resolve: (text) => {
        clearTimeout(timer);
        if (this.pendingPull && this.pendingPull.id === id) this.pendingPull = null;
        settle(text);
      }, promise: promise,
    };
    if (!conn.sendJSON({ t: 'pull', protocol: PROTOCOL_VERSION, id: id })) {
      this.pendingPull.resolve(null);
    }
    return promise;
  }

  // ── push: hand a finished document to the page and wait for its verdict ────
  // Resolves {status, message}:
  //   'no-page'  nobody is attached — file mode, nothing was pushed
  //   'applied'  the page validated it and put it on the canvas
  //   'proposed' the page validated it but only offers it for review (live off)
  //   'rejected' the page's own validator refused it — caller must roll back
  //   'timeout' / 'detached' — no answer; the file stays as written
  push(doc, origin, timeoutMs) {
    const wait = timeoutMs || this.ackTimeoutMs;
    if (!this.attached()) return Promise.resolve({ status: 'no-page', message: '' });
    const seq = ++this.seq;
    const pageIds = Array.from(this.pages).map(c => c.id);
    const message = {
      t: 'state', protocol: PROTOCOL_VERSION, seq: seq, origin: origin || 'server',
      apply: true, document: doc,
    };
    const entry = { id: seq, pageIds: pageIds, replies: new Map(), resolve: null, timer: null };
    const promise = new Promise(resolve => { entry.resolve = resolve; });
    entry.timer = setTimeout(() => this._maybeFinishPush(seq, 'timeout'), wait);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    this.pendingPush = entry;
    for (const conn of this.pages) {
      if (!conn.sendJSON(message)) entry.replies.set(conn.id, { ok: false, applied: false, message: 'page socket is closed' });
    }
    this._maybeFinishPush(seq, null);
    return promise;
  }

  _maybeFinishPush(seq, forced) {
    const p = this.pendingPush;
    if (!p || p.id !== seq) return;
    if (!forced && p.replies.size < p.pageIds.length) return;
    clearTimeout(p.timer);
    this.pendingPush = null;
    const replies = Array.from(p.replies.values());
    let result;
    if (!replies.length) {
      result = { status: forced === 'detached' ? 'detached' : 'timeout', message: 'the page did not answer' };
    } else {
      const bad = replies.find(r => !r.ok);
      if (bad) {
        result = { status: 'rejected', message: bad.message || 'the page rejected the document' };
      } else if (replies.some(r => r.applied)) {
        result = { status: 'applied', message: replies[0].message || '' };
      } else {
        result = { status: 'proposed', message: replies[0].message || 'waiting for the human to confirm' };
      }
    }
    if (forced && forced !== 'timeout' && replies.length) {
      // A page that left mid-flight AFTER answering is not a rejection — the
      // verdict of the pages that did answer stands.
    }
    p.resolve(result);
  }

  _onPageMessage(conn, text) {
    let msg;
    try { msg = JSON.parse(text); }
    catch (err) { this.log('page sent invalid JSON, ignored'); return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    switch (msg.t) {
      case 'hello': {
        this.meta.set(conn, Object.assign({}, this.meta.get(conn), {
          app: typeof msg.app === 'string' ? msg.app : 'unknown',
          appVersion: typeof msg.appVersion === 'string' ? msg.appVersion : '',
          protocol: msg.protocol,
        }));
        const info = this.meta.get(conn);
        this.welcome(conn, info.canvas || null);
        this.notice('info', 'Агент подключился к этой вкладке. Рисунок обновляется сам.');
        return;
      }
      case 'pull_result': {
        if (this.pendingPull && this.pendingPull.pageId === conn.id) {
          this.pendingPull.resolve(typeof msg.text === 'string' ? msg.text : null);
        }
        return;
      }
      case 'apply_result': {
        const p = this.pendingPush;
        if (!p || p.id !== msg.seq) return;   // a late answer to a finished push
        p.replies.set(conn.id, {
          ok: msg.ok === true,
          applied: msg.applied === true,
          message: typeof msg.message === 'string' ? msg.message.slice(0, 500) : '',
          stats: msg.stats || null,
        });
        this._maybeFinishPush(p.id, null);
        return;
      }
      case 'pong':
        return;
      default:
        this.log('page sent unknown message type: ' + JSON.stringify(msg.t));
    }
  }
}

// ─── Static files (--serve) — same localhost-only rule as the socket ─────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.lol': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function makeStaticHandler(rootDir, log) {
  const root = path.resolve(rootDir);
  return function serve(req, res) {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch (err) { res.writeHead(400); res.end('Bad request'); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(path.join(root, rel));
    // path.resolve collapses "..", so a resolved path outside the root is refused.
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 — вне папки проекта');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 — ' + rel);
        return;
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        // The page is served locally and edited while it is open; a cached copy
        // would be the most confusing possible failure.
        'Cache-Control': 'no-store',
      });
      if ((req.method || 'GET').toUpperCase() === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(file);
      stream.on('error', err => { log('static read failed: ' + err.message); try { res.destroy(); } catch (e) { /* gone */ } });
      stream.pipe(res);
    });
  };
}

// ─── Start everything ────────────────────────────────────────────────────────
function startLiveServer(opts) {
  opts = opts || {};
  const host = '127.0.0.1';   // localhost ONLY — never 0.0.0.0 (see the header)
  const port = Number(opts.port || 8765);
  const log = opts.log || function () {};
  const hub = new LiveHub({ log: log, serverInfo: opts.serverInfo || {} });

  const server = http.createServer((req, res) => {
    const serve = opts.serveDir ? makeStaticHandler(opts.serveDir, log) : null;
    if (!serve) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('pixelol-ai live transport. Open the page in a browser to attach, ' +
        'or start the server with --serve <folder> to also serve index.html.');
      return;
    }
    serve(req, res);
  });

  server.on('upgrade', (req, socket) => {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      log('upgrade REFUSED from origin ' + origin + ' (only loopback origins may attach)');
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n' +
        'Connection: close\r\n\r\n403 — pixelol-ai принимает только страницы с этого же компьютера (127.0.0.1)');
      socket.destroy();
      return;
    }
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n400 — expected a WebSocket upgrade');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers['sec-websocket-version'] || '') !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n400 — bad WebSocket handshake');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    try { socket.setNoDelay(true); } catch (err) { /* not fatal */ }
    const conn = new WSConnection(socket, log);
    hub.add(conn, { origin: origin || '', remote: req.socket.remoteAddress || '' });
  });

  // A half-open client must not take the server down with it.
  server.on('clientError', (err, socket) => {
    try { socket.destroy(); } catch (e) { /* gone */ }
  });

  return new Promise((resolve, reject) => {
    server.once('error', err => reject(err));
    server.listen(port, host, () => {
      resolve({
        server: server,
        hub: hub,
        host: host,
        port: server.address().port,
        url: 'ws://' + host + ':' + server.address().port,
        httpUrl: 'http://' + host + ':' + server.address().port + '/',
        close: () => new Promise(done => {
          hub.notice('info', 'Сервер агента выключается. Рисунок остаётся как есть.');
          for (const conn of Array.from(hub.pages)) conn.close(1001, 'server shutting down');
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = {
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  LiveHub: LiveHub,
  WSConnection: WSConnection,
  originAllowed: originAllowed,
  makeStaticHandler: makeStaticHandler,
  startLiveServer: startLiveServer,
};