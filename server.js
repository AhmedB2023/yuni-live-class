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

// room code -> { teacherId, prompt, board, answers: Map<socketId, {name, text, ts}> , peers: Map<socketId, {role, name}>,
//                attOn, attTimer, attCloseTimer, attRound, attOpen,
//                attResults: Map<socketId, {name, status, at}>, attLog: [{round, at, results}] }
const rooms = new Map();

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
    } else {
      room.attTargets.add(id);
      io.to(id).emit('att-open', { round: room.attRound, seconds: ATT_ROUND_SECONDS });
    }
  }
  if (room.teacherId) {
    io.to(room.teacherId).emit('att-status', { round: room.attRound, list: attList(room) });
  }
  room.attCloseTimer = setTimeout(() => closeAttRound(io, code), ATT_ROUND_SECONDS * 1000);
}

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (rooms.has(code)) return makeCode();
  return code;
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
    board: room.board,
    boardBy: room.boardBy,
    answers: role === 'teacher'
      ? Array.from(room.answers.entries()).map(([id, a]) => ({ id, name: a.name, text: a.text }))
      : [],
    att,
  };
}

io.on('connection', (socket) => {
  let myRoom = null;
  let myRole = null;

  socket.on('create-room', (cb) => {
    const code = makeCode();
    rooms.set(code, {
      teacherId: socket.id,
      prompt: '',
      board: '',
      boardBy: '',
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
    });
    if (typeof cb === 'function') cb({ code });
  });

  socket.on('join-room', ({ code, role, name }, cb) => {
    const room = rooms.get((code || '').toUpperCase().trim());
    if (!room) {
      if (typeof cb === 'function') cb({ error: 'Room not found. Check the link or code.' });
      return;
    }
    myRoom = (code || '').toUpperCase().trim();
    myRole = role === 'teacher' ? 'teacher' : 'student';
    if (myRole === 'teacher') room.teacherId = socket.id;
    room.peers.set(socket.id, { role: myRole, name: name || '', camOn: false });
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

  // One shared whiteboard page, like before — the broadcast carries WHO is writing.
  socket.on('set-board', (text) => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    const peer = room.peers.get(socket.id);
    room.board = String(text || '').slice(0, 5000);
    room.boardBy = myRole === 'teacher' ? 'Teacher' : ((peer && peer.name) || 'Student');
    socket.to(myRoom).emit('board', { text: room.board, by: room.boardBy });
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
      const mins = [5, 10, 15].includes(parseInt(minutes, 10)) ? parseInt(minutes, 10) : 5;
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
    const mins = [5, 10, 15].includes(parseInt(minutes, 10)) ? parseInt(minutes, 10) : 5;
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
    socket.emit('att-feedback', { ok: true, round: room.attRound });
    if (room.teacherId) io.to(room.teacherId).emit('att-status', { round: room.attRound, list: attList(room) });
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
    room.peers.delete(socket.id);
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
