// Yuni Live Class — test version.
// One link = one classroom: teacher shares her screen + voice,
// students join with no account, see her screen, and type answers
// on a shared board that the teacher sees live.
//
// State is in memory only. Nothing is recorded or stored.
// A room dies when the server restarts or the teacher leaves.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Feature requests from teachers (typed in their own words in the class).
// In memory: they clear when the service sleeps/restarts — fine for the test.
const featureRequests = [];
const REQUESTS_KEY = process.env.REQUESTS_KEY || 'ylc-builder-2026';
function escHtml(x) {
  return String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
app.get('/requests', async (req, res) => {
  if (req.query.key !== REQUESTS_KEY) { res.status(403).send('Wrong key.'); return; }
  const stored = await storeListRequests();
  const list = stored || featureRequests.slice().reverse();
  const items = list.map((r) =>
    '<li style="margin:10px 0;"><b>' + escHtml(r.at) + '</b> — room <b>' + escHtml(r.room) + '</b><br>' + escHtml(r.text) + '</li>').join('');
  res.send('<html><head><meta charset="utf-8"><title>Feature requests</title></head><body style="font-family:sans-serif;max-width:700px;margin:30px auto;padding:0 16px;">'
    + '<h2>✨ Feature requests from teachers (' + list.length + ')</h2>'
    + (items ? '<ul>' + items + '</ul>' : '<p>No requests yet.</p>')
    + '</body></html>');
});

// room code -> { teacherId, prompt, board, answers: Map<socketId, {name, text, ts}> , peers: Map<socketId, {role, name}>,
//                attOn, attTimer, attCloseTimer, attRound, attOpen,
//                attResults: Map<socketId, {name, status, at}>, attLog: [{round, at, results}] }
// Builder-only: clear a room registration so the teacher can claim the name
// again with a new PIN (e.g. a test PIN was set, or she forgot hers).
app.get('/reset-room', async (req, res) => {
  if (req.query.key !== REQUESTS_KEY) { res.status(403).send('Wrong key.'); return; }
  const name = cleanRoomName(req.query.room || '');
  if (!name) { res.status(400).send('Give ?room=NAME'); return; }
  roomRegistry.delete(name);
  const live = rooms.get(name);
  if (live) live.pinHash = null;
  const p = getPgPool();
  if (p) { try { await pgInit(); await p.query('DELETE FROM ylc_kv WHERE key = $1', ['ylc:room:' + name]); } catch (e) {} }
  res.send('Room ' + name + ' registration cleared. The teacher can claim it again with a new PIN.');
});

const rooms = new Map();

// ---- Small permanent memory (his existing Render Postgres, DATABASE_URL) ----
// Holds: room registry (name -> {pinHash, lang}) and the feature-request list.
// The database instance is paid, so it never expires and never sleeps.
// This app's tables are prefixed ylc_ and never touch the other app's tables.
// Without DATABASE_URL it falls back to plain memory (local tests).
const crypto = require('crypto');
let pgPool = null;
let pgReady = null;
function getPgPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pgPool) {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pgPool.on('error', (e) => console.error('[db:ERROR]', e.message));
  }
  return pgPool;
}
async function pgInit() {
  const p = getPgPool();
  if (!p) return false;
  if (!pgReady) {
    pgReady = (async () => {
      await p.query('CREATE TABLE IF NOT EXISTS ylc_kv (key TEXT PRIMARY KEY, value TEXT)');
      await p.query('CREATE TABLE IF NOT EXISTS ylc_requests (id SERIAL PRIMARY KEY, body TEXT)');
      return true;
    })().catch((e) => { console.error('[db] init failed:', e.message); pgReady = null; return false; });
  }
  return pgReady;
}
async function storeGet(key) {
  const p = getPgPool(); if (!p) return null;
  try {
    if (!(await pgInit())) return null;
    const r = await p.query('SELECT value FROM ylc_kv WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].value : null;
  } catch (e) { return null; }
}
async function storeSet(key, value) {
  const p = getPgPool(); if (!p) return;
  try {
    if (!(await pgInit())) return;
    await p.query('INSERT INTO ylc_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  } catch (e) {}
}
async function storePushRequest(entry) {
  const p = getPgPool(); if (!p) return;
  try {
    if (!(await pgInit())) return;
    await p.query('INSERT INTO ylc_requests (body) VALUES ($1)', [JSON.stringify(entry)]);
  } catch (e) {}
}
async function storeListRequests() {
  const p = getPgPool(); if (!p) return null;
  try {
    if (!(await pgInit())) return null;
    const r = await p.query('SELECT body FROM ylc_requests ORDER BY id DESC LIMIT 200');
    if (!r.rows.length) return null;
    return r.rows.map((row) => { try { return JSON.parse(row.body); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return null; }
}
const roomRegistry = new Map();
async function loadRoomReg(name) {
  if (roomRegistry.has(name)) return roomRegistry.get(name);
  const raw = await storeGet('ylc:room:' + name);
  if (raw) {
    try { const d = JSON.parse(raw); roomRegistry.set(name, d); return d; } catch (e) {}
  }
  return null;
}
function saveRoomReg(name, data) {
  roomRegistry.set(name, data);
  storeSet('ylc:room:' + name, JSON.stringify(data));
}
function pinHash(name, pin) {
  return crypto.createHash('sha256').update(name + ':' + String(pin || '')).digest('hex');
}
function cleanRoomName(x) {
  return String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
}

const ATT_ROUND_SECONDS = 60;

function timeNow() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function attList(room) {
  const list = [];
  for (const [id, r] of room.attResults.entries()) {
    list.push({ id, name: r.name, status: r.status, at: r.at });
  }
  if (room.attOpen) {
    for (const id of room.attTargets) {
      if (!room.attResults.has(id)) {
        const p = room.peers.get(id);
        list.push({ id, name: (p && p.name) || 'Student', status: 'waiting', at: '' });
      }
    }
  }
  return list;
}

function closeAttRound(io, code) {
  const room = rooms.get(code);
  if (!room || !room.attOpen) return;
  const entry = { round: room.attRound, at: timeNow(), results: attList(room) };
  room.attOpen = false;
  if (room.attCloseTimer) { clearTimeout(room.attCloseTimer); room.attCloseTimer = null; }
  room.attLog.push(entry);
  if (room.teacherId) io.to(room.teacherId).emit('att-closed', entry);
  io.to(code).emit('att-done', { round: room.attRound });
}

function startAttRound(io, code) {
  const room = rooms.get(code);
  if (!room || !room.attOn) return;
  closeAttRound(io, code);
  room.attRound += 1;
  room.attResults = new Map();
  room.attTargets = new Set();
  room.attOpen = true;
  // Camera ON = she can see them = present. Camera OFF = they get the balloon.
  for (const [id, p] of room.peers.entries()) {
    if (p.role !== 'student') continue;
    if (p.camOn) {
      room.attResults.set(id, { name: p.name || 'Student', status: 'camera', at: timeNow() });
      const partSweep = room.participants.get(id);
      if (partSweep) partSweep.presentCamera += 1;
    } else {
      room.attTargets.add(id);
      io.to(id).emit('att-open', { round: room.attRound, seconds: ATT_ROUND_SECONDS });
    }
  }
  if (room.teacherId) {
    io.to(room.teacherId).emit('att-status', { round: room.attRound, list: attList(room) });
  }
  sendParticipants(room);
  room.attCloseTimer = setTimeout(() => closeAttRound(io, code), ATT_ROUND_SECONDS * 1000);
}

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (rooms.has(code)) return makeCode();
  return code;
}

function participantsList(room) {
  return Array.from(room.participants.values()).map((p) => ({
    name: p.name, role: p.role, joinedAt: p.joinedAt, leftAt: p.leftAt,
    presentBalloon: p.presentBalloon, presentCamera: p.presentCamera,
  }));
}

function sendParticipants(room) {
  const t = room.peers.get(room.teacherId);
  if (t) io.to(room.teacherId).emit('participants', participantsList(room));
}

function groupsPayload(room, forId) {
  if (!room.groups) return { active: false, mine: null, groups: [] };
  return {
    active: true,
    mine: room.groupOf.get(forId) || null,
    groups: room.groups.map((g) => ({
      id: g.id,
      members: g.members.map((id) => {
        const p = room.peers.get(id);
        return { id, name: (p && p.name) || 'Student' };
      }),
    })),
  };
}

function broadcastGroups(io, room) {
  for (const [id] of room.peers.entries()) {
    io.to(id).emit('groups', groupsPayload(room, id));
  }
}

function roomStateFor(room, role, socketId) {
  const att = {
    on: room.attOn,
    open: room.attOpen && (role === 'teacher' || room.attTargets.has(socketId)),
    round: room.attRound,
    answered: null,
    list: [],
    log: [],
  };
  const mine = room.attResults.get(socketId);
  if (mine) att.answered = mine.status;
  if (role === 'teacher') {
    att.list = room.attOpen ? attList(room) : [];
    att.log = room.attLog;
  }
  return {
    prompt: room.prompt,
    boardSegs: room.boardSegs,
    boardBy: room.boardBy,
    lang: room.lang,
    drawStrokes: room.drawStrokes,
    groups: groupsPayload(room, socketId),
    chat: role === 'teacher'
      ? Object.fromEntries(room.chats.entries())
      : (room.chats.get(socketId) || []),
    requests: role === 'teacher' ? room.requests : undefined,
    participants: role === 'teacher' ? participantsList(room) : undefined,
    answers: role === 'teacher'
      ? Array.from(room.answers.entries()).map(([id, a]) => ({ id, name: a.name, text: a.text }))
      : [],
    att,
  };
}

io.on('connection', (socket) => {
  let myRoom = null;
  let myRole = null;

  function newRoomState() {
    return {
      teacherId: socket.id,
      prompt: '',
      boardSegs: [],
      segSeq: 0,
      boardBy: '',
      participants: new Map(),
      answers: new Map(),
      peers: new Map(),
      attOn: false,
      attTimer: null,
      attCloseTimer: null,
      attRound: 0,
      attOpen: false,
      attTargets: new Set(),
      attEveryMs: 5 * 60 * 1000,
      attResults: new Map(),
      attLog: [],
      lang: 'en',
      drawStrokes: [],
      chats: new Map(),
      requests: [],
      groups: null,
      groupOf: new Map(),
      pinHash: null,
    };
  }

  // Semester room: the teacher claims her room NAME once, guarded by her PIN.
  // The same name is her link for the whole semester (students open ?room=NAME).
  socket.on('create-room', async (data, cb) => {
    const roomName = cleanRoomName(data && data.name);
    if (roomName.length < 3) { if (typeof cb === 'function') cb({ error: 'NAME_BAD' }); return; }
    const hash = pinHash(roomName, data && data.pin);
    const reg = await loadRoomReg(roomName);
    if (reg && reg.pinHash !== hash) { if (typeof cb === 'function') cb({ error: 'PIN_WRONG' }); return; }
    if (!reg) saveRoomReg(roomName, { pinHash: hash, lang: 'en' });
    if (!rooms.has(roomName)) {
      const room = newRoomState();
      room.pinHash = hash;
      const reg2 = await loadRoomReg(roomName);
      if (reg2 && reg2.lang) room.lang = reg2.lang;
      rooms.set(roomName, room);
    }
    if (typeof cb === 'function') cb({ code: roomName });
  });

  socket.on('join-room', async ({ code, role, name, pin }, cb) => {
    const codeUp = (code || '').toUpperCase().trim();
    let room = rooms.get(codeUp);
    if (!room) {
      // A registered semester room wakes up on demand — students can wait inside.
      const reg = await loadRoomReg(cleanRoomName(codeUp));
      if (!reg) {
        if (typeof cb === 'function') cb({ error: 'Room not found. Check the link or code.' });
        return;
      }
      room = newRoomState();
      room.pinHash = reg.pinHash;
      if (reg.lang) room.lang = reg.lang;
      rooms.set(codeUp, room);
    }
    if (role === 'teacher' && room.pinHash && pinHash(codeUp, pin) !== room.pinHash) {
      if (typeof cb === 'function') cb({ error: 'PIN_WRONG' });
      return;
    }
    myRoom = codeUp;
    myRole = role === 'teacher' ? 'teacher' : 'student';
    if (myRole === 'teacher') room.teacherId = socket.id;
    room.peers.set(socket.id, { role: myRole, name: name || '', camOn: false });
    room.participants.set(socket.id, {
      name: myRole === 'teacher' ? 'Teacher' : (name || 'Student'), role: myRole,
      joinedAt: Date.now(), leftAt: null, presentBalloon: 0, presentCamera: 0,
    });
    sendParticipants(room);
    socket.join(myRoom);

    // Tell the new peer who is already here (with names, for the Zoom-style boxes),
    // and tell the others about the new peer.
    const others = Array.from(room.peers.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, p]) => ({ id, role: p.role, name: p.name }));
    socket.emit('existing-peers', others);
    socket.to(myRoom).emit('peer-joined', { id: socket.id, role: myRole, name: name || '' });
    socket.emit('room-state', roomStateFor(room, myRole, socket.id));

    // A student who joins while a balloon check is open gets the balloon too.
    if (room.attOpen && myRole === 'student') {
      room.attTargets.add(socket.id);
      socket.emit('att-open', { round: room.attRound, seconds: ATT_ROUND_SECONDS });
      if (room.teacherId) io.to(room.teacherId).emit('att-status', { round: room.attRound, list: attList(room) });
    }
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('set-prompt', (text) => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    room.prompt = String(text || '').slice(0, 500);
    socket.to(myRoom).emit('prompt', room.prompt);
  });

  // Whiteboard: the page is a list of named pieces. Whoever types, their NAME
  // goes before their words. Typing more extends your current piece; when
  // someone else starts, your piece is finished and a new named piece begins.
  socket.on('set-board', (text) => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const peer = room.peers.get(socket.id);
    const by = myRole === 'teacher' ? 'Teacher' : ((peer && peer.name) || 'Student');
    const t = String(text || '').slice(0, 2000);
    const segs = room.boardSegs;
    const last = segs[segs.length - 1];
    if (last && last.byId === socket.id) {
      if (t) last.text = t; else segs.pop();
    } else if (t) {
      segs.push({ id: ++room.segSeq, byId: socket.id, by, role: myRole, text: t });
    }
    room.boardBy = by;
    io.to(myRoom).emit('board-segs', { segs: room.boardSegs, by });
  });

  socket.on('answer', ({ name, text }) => {
    if (!myRoom || myRole !== 'student') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const clean = String(text || '').slice(0, 1000);
    room.answers.set(socket.id, { name: String(name || 'Student').slice(0, 40), text: clean, ts: Date.now() });
    io.to(room.teacherId).emit('answer-update', { id: socket.id, name: room.answers.get(socket.id).name, text: clean });
  });

  socket.on('clear-answers', () => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    room.answers.clear();
    io.to(myRoom).emit('answers-cleared');
  });

  // ---- Attendance check: every 5 minutes a pink balloon pops up; students tap it ----
  socket.on('att-toggle', ({ on, minutes }) => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    if (on && !room.attOn) {
      const mins = Math.min(180, Math.max(1, parseInt(minutes, 10) || 5));
      room.attEveryMs = mins * 60 * 1000;
      room.attOn = true;
      startAttRound(io, myRoom);
      room.attTimer = setInterval(() => {
        if (!rooms.has(myRoom)) return;
        startAttRound(io, myRoom);
      }, room.attEveryMs);
    } else if (!on && room.attOn) {
      room.attOn = false;
      if (room.attTimer) { clearInterval(room.attTimer); room.attTimer = null; }
      closeAttRound(io, myRoom);
    }
    io.to(room.teacherId).emit('att-state', { on: room.attOn });
  });

  socket.on('att-set-minutes', ({ minutes }) => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const mins = Math.min(180, Math.max(1, parseInt(minutes, 10) || 5));
    room.attEveryMs = mins * 60 * 1000;
    if (room.attOn && room.attTimer) {
      clearInterval(room.attTimer);
      room.attTimer = setInterval(() => {
        if (!rooms.has(myRoom)) return;
        startAttRound(io, myRoom);
      }, room.attEveryMs);
    }
  });

  socket.on('cam-state', ({ on }) => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const peer = room.peers.get(socket.id);
    if (!peer) return;
    peer.camOn = !!on;
    // Turning the camera ON during an open check = present by camera.
    if (on && room.attOpen && myRole === 'student' && room.attTargets.has(socket.id) && !room.attResults.has(socket.id)) {
      room.attResults.set(socket.id, { name: peer.name || 'Student', status: 'camera', at: timeNow() });
      const partCam = room.participants.get(socket.id);
      if (partCam) { partCam.presentCamera += 1; sendParticipants(room); }
      socket.emit('att-done', { round: room.attRound });
      if (room.teacherId) io.to(room.teacherId).emit('att-status', { round: room.attRound, list: attList(room) });
    }
  });

  socket.on('att-pop', () => {
    if (!myRoom || myRole !== 'student') return;
    const room = rooms.get(myRoom);
    if (!room || !room.attOpen) return;
    const peer = room.peers.get(socket.id);
    room.attResults.set(socket.id, {
      name: (peer && peer.name) || 'Student',
      status: 'ok',
      at: timeNow(),
    });
    const part = room.participants.get(socket.id);
    if (part) { part.presentBalloon += 1; sendParticipants(room); }
    socket.emit('att-feedback', { ok: true, round: room.attRound });
    if (room.teacherId) io.to(room.teacherId).emit('att-status', { round: room.attRound, list: attList(room) });
  });

  // ---- Reactions: anyone taps an emoji, it flies up everyone's screen with their name ----
  socket.on('react', (data) => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const peer = room.peers.get(socket.id);
    const name = myRole === 'teacher' ? 'Teacher' : ((peer && peer.name) || 'Student');
    const raw = data && typeof data.emoji === 'string' ? data.emoji : '❤️';
    const emoji = Array.from(raw).slice(0, 4).join('') || '❤️';
    io.to(myRoom).emit('react', { name, emoji });
  });

  // ---- Private chat: student <-> teacher only, never student <-> student ----
  socket.on('chat', ({ to, text }) => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const clean = String(text || '').slice(0, 500).trim();
    if (!clean) return;
    const peer = room.peers.get(socket.id);
    const myName2 = myRole === 'teacher' ? 'Teacher' : ((peer && peer.name) || 'Student');
    if (myRole === 'student') {
      const msg = { from: socket.id, name: myName2, text: clean, at: timeNow(), mine: false };
      if (!room.chats.has(socket.id)) room.chats.set(socket.id, []);
      room.chats.get(socket.id).push(msg);
      io.to(room.teacherId).emit('chat', { thread: socket.id, msg });
      socket.emit('chat', { thread: socket.id, msg: { ...msg, mine: true } });
    } else {
      // Teacher addressing: "@Maria text" goes only to Maria; "@everyone text" goes to all students.
      const deliver = (target, body, viaAt) => {
        const msg = { from: socket.id, name: 'Teacher', text: body, at: timeNow(), mine: false };
        if (!room.chats.has(target)) room.chats.set(target, []);
        room.chats.get(target).push(msg);
        io.to(target).emit('chat', { thread: target, msg });
        socket.emit('chat', { thread: target, msg: { ...msg, mine: true }, viaAt: !!viaAt });
      };
      const at = clean.match(/^@(\S+)\s+([\s\S]+)$/);
      if (at) {
        const who = at[1].toLowerCase();
        const body = at[2];
        if (who === 'everyone') {
          room.peers.forEach((p, id) => { if (p.role === 'student') deliver(id, body, true); });
          return;
        }
        let hit = null;
        room.peers.forEach((p, id) => {
          if (hit || p.role !== 'student') return;
          const nm = (p.name || '').toLowerCase();
          if (nm === who || nm.split(' ')[0] === who) hit = id;
        });
        if (!hit) { socket.emit('chat-note', { text: 'No student named "' + at[1] + '" in this class.' }); return; }
        deliver(hit, body, true);
        return;
      }
      const target = String(to || '');
      if (!room.peers.has(target) || target === socket.id) return;
      deliver(target, clean, false);
    }
  });

  // ---- Feature request: the teacher types what she wants; it lands on the builder list ----
  socket.on('feature-request', ({ text }) => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const clean = String(text || '').trim().slice(0, 500);
    if (!clean) return;
    const entry = { at: timeNow(), room: myRoom, text: clean };
    room.requests.push(entry);
    featureRequests.push(entry);
    storePushRequest(entry);
    socket.emit('feature-request-ack', { ok: true });
  });

  // ---- Platform language: the teacher sets it for the whole class ----
  socket.on('set-lang', ({ lang }) => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const ok = ['en', 'es', 'pt', 'fr', 'ar', 'id', 'vi', 'zh'];
    room.lang = ok.includes(lang) ? lang : 'en';
    io.to(myRoom).emit('lang', { lang: room.lang });
    loadRoomReg(myRoom).then((reg) => { if (reg) { reg.lang = room.lang; saveRoomReg(myRoom, reg); } });
  });

  // ---- Drawing on the shared screen (teacher draws, everyone sees) ----
  socket.on('draw-seg', (seg) => {
    if (!myRoom || myRole !== 'teacher') return;
    socket.to(myRoom).emit('draw-seg', seg);
  });
  socket.on('draw-stroke', (stroke) => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    if (stroke && Array.isArray(stroke.pts) && stroke.pts.length) {
      room.drawStrokes.push({ color: String(stroke.color || '#ef4444').slice(0, 12), pts: stroke.pts.slice(0, 400) });
      if (room.drawStrokes.length > 600) room.drawStrokes.shift();
    }
  });
  socket.on('draw-clear', () => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    room.drawStrokes = [];
    io.to(myRoom).emit('draw-clear');
  });

  // ---- Split rooms (breakout groups). The teacher stays connected to everyone,
  // so her screen, prompt and board reach every group. ----
  socket.on('groups-split', ({ size }) => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const per = [2, 3, 4].includes(parseInt(size, 10)) ? parseInt(size, 10) : 2;
    const students = Array.from(room.peers.entries())
      .filter(([, p]) => p.role === 'student')
      .map(([id]) => id);
    // Shuffle, then chunk.
    for (let i = students.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [students[i], students[j]] = [students[j], students[i]];
    }
    room.groups = [];
    room.groupOf = new Map();
    students.forEach((id, idx) => {
      const gi = Math.floor(idx / per);
      if (!room.groups[gi]) room.groups[gi] = { id: 'G' + (gi + 1), members: [] };
      room.groups[gi].members.push(id);
      room.groupOf.set(id, room.groups[gi].id);
    });
    broadcastGroups(io, room);
  });
  socket.on('groups-end', () => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    room.groups = null;
    room.groupOf = new Map();
    broadcastGroups(io, room);
  });

  // ---- Attendance + media relays ----
  socket.on('stream-kind', ({ streamId, kind }) => {
    if (!myRoom) return;
    socket.to(myRoom).emit('stream-kind', { from: socket.id, streamId, kind });
  });
  socket.on('media-off', ({ kind }) => {
    if (!myRoom) return;
    socket.to(myRoom).emit('media-off', { from: socket.id, kind });
  });

  // ---- WebRTC signaling relay (screen + voice, peer to peer) ----
  socket.on('rtc-offer', ({ to, sdp }) => {
    io.to(to).emit('rtc-offer', { from: socket.id, sdp });
  });
  socket.on('rtc-answer', ({ to, sdp }) => {
    io.to(to).emit('rtc-answer', { from: socket.id, sdp });
  });
  socket.on('rtc-ice', ({ to, candidate }) => {
    io.to(to).emit('rtc-ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const partLeft = room.participants.get(socket.id);
    if (partLeft && !partLeft.leftAt) partLeft.leftAt = Date.now();
    if (room.groups) {
      room.groups.forEach((g) => { g.members = g.members.filter((id) => id !== socket.id); });
      room.groupOf.delete(socket.id);
      broadcastGroups(io, room);
    }
    room.peers.delete(socket.id);
    sendParticipants(room);
    room.answers.delete(socket.id);
    room.attTargets.delete(socket.id);
    socket.to(myRoom).emit('peer-left', { id: socket.id });
    if (room.teacherId) io.to(room.teacherId).emit('answer-removed', { id: socket.id });
    if (room.peers.size === 0) {
      if (room.attTimer) clearInterval(room.attTimer);
      if (room.attCloseTimer) clearTimeout(room.attCloseTimer);
      rooms.delete(myRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Yuni Live Class listening on port ${PORT}`);
});
