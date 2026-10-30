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

// room code -> { teacherId, prompt, board, answers: Map<socketId, {name, text, ts}> , peers: Map<socketId, {role, name}> }
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (rooms.has(code)) return makeCode();
  return code;
}

function roomStateFor(room, role) {
  return {
    prompt: room.prompt,
    board: room.board,
    answers: role === 'teacher'
      ? Array.from(room.answers.entries()).map(([id, a]) => ({ id, name: a.name, text: a.text }))
      : [],
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
      answers: new Map(),
      peers: new Map(),
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
    room.peers.set(socket.id, { role: myRole, name: name || '' });
    socket.join(myRoom);

    // Tell the new peer who is already here, and tell the others about the new peer.
    const others = Array.from(room.peers.keys()).filter((id) => id !== socket.id);
    socket.emit('existing-peers', others);
    socket.to(myRoom).emit('peer-joined', { id: socket.id, role: myRole, name: name || '' });
    socket.emit('room-state', roomStateFor(room, myRole));
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('set-prompt', (text) => {
    if (!myRoom || myRole !== 'teacher') return;
    const room = rooms.get(myRoom);
    if (!room) return;
    room.prompt = String(text || '').slice(0, 500);
    socket.to(myRoom).emit('prompt', room.prompt);
  });

  socket.on('set-board', (text) => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    room.board = String(text || '').slice(0, 5000);
    socket.to(myRoom).emit('board', room.board);
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
    socket.to(myRoom).emit('peer-left', { id: socket.id });
    if (room.teacherId) io.to(room.teacherId).emit('answer-removed', { id: socket.id });
    if (room.peers.size === 0) rooms.delete(myRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Yuni Live Class listening on port ${PORT}`);
});
