const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

process.on('uncaughtException',  (err) => console.error('Fout:', err));
process.on('unhandledRejection', (err) => console.error('Promise fout:', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// CORS — allow Vercel frontend to reach Railway backend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));
app.post('/create-room', express.json(), (req, res) => res.json({ roomId: uuidv4().slice(0, 8) }));

// ================================================================
// THEME — Cosa Nostra
// Swap this block to change themes without touching game logic.
// ================================================================
const THEME_SPECIALS = [
  { id: 'bribe', emoji: '💸', name: 'Smeergeld', desc: 'Speel direct een extra beurt' },
];

const KEY_LOCATION_DEFS = [
  { id: 'bank',       emoji: '🏦', name: 'De Bank',       glow: '#e8a020' },
  { id: 'casino',     emoji: '🏦', name: 'Het Casino',    glow: '#e8a020' },
  { id: 'haven',      emoji: '🏦', name: 'De Haven',      glow: '#e8a020' },
  { id: 'stadhuis',   emoji: '🏦', name: 'Het Stadhuis',  glow: '#e8a020' },
  { id: 'gevangenis', emoji: '🏦', name: 'De Gevangenis', glow: '#e8a020' },
];

const WIN_LOCATIONS = 3; // claim this many key locations to win
// ================================================================

const rooms = {};
const pendingDisconnects = {}; // playerId → { roomId, oldSocketId, timer }
const GRID_SIZES = { small: 6, large: 8 };
const RECONNECT_GRACE = 25000; // ms

function getKeyPositions(size) {
  // Shuffle all grid positions and pick 5 that are not too close to each other
  const candidates = [];
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      candidates.push({ row: r, col: c });

  // Fisher-Yates shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const minDist = size <= 5 ? 2 : 3;
  const positions = [];
  for (const cand of candidates) {
    if (positions.length >= 5) break;
    const ok = positions.every(p =>
      Math.abs(p.row - cand.row) + Math.abs(p.col - cand.col) >= minDist
    );
    if (ok) positions.push(cand);
  }
  // Fallback: fill remaining without distance constraint
  for (const cand of candidates) {
    if (positions.length >= 5) break;
    if (!positions.some(p => p.row === cand.row && p.col === cand.col))
      positions.push(cand);
  }
  return positions;
}

function generateGrid(size) {
  const keyPositions = getKeyPositions(size);
  const keySet = new Set(keyPositions.map(p => p.row * size + p.col));

  const nonKeyIndices = [];
  for (let i = 0; i < size * size; i++) if (!keySet.has(i)) nonKeyIndices.push(i);
  const specialCount = Math.floor(nonKeyIndices.length * 0.22);
  const shuffled = [...nonKeyIndices].sort(() => Math.random() - 0.5);
  const specialSet = new Set(shuffled.slice(0, specialCount));

  const cells = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const idx = row * size + col;
      const isKeyLocation = keySet.has(idx);
      const r = Math.random();
      const terrain = r < 0.35 ? 'alley' : r < 0.70 ? 'street' : 'district';
      const ki = isKeyLocation ? keyPositions.findIndex(p => p.row === row && p.col === col) : -1;
      const keyDef = isKeyLocation ? { ...KEY_LOCATION_DEFS[ki] } : null;
      const special = (!isKeyLocation && specialSet.has(idx))
        ? { ...THEME_SPECIALS[Math.floor(Math.random() * THEME_SPECIALS.length)] }
        : null;
      cells.push({ row, col, terrain, isKeyLocation, keyDef, special, owner: null });
    }
  }
  return cells;
}

function generateLines(size) {
  return {
    hLines: Array.from({ length: size + 1 }, () => Array(size).fill(null)),
    vLines: Array.from({ length: size }, () => Array(size + 1).fill(null)),
  };
}

function checkCompletedCells(grid, lines, size) {
  const { hLines, vLines } = lines;
  const completed = [];
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      if (hLines[row][col] && hLines[row+1][col] && vLines[row][col] && vLines[row][col+1])
        if (!grid[row * size + col].owner)
          completed.push({ row, col, idx: row * size + col });
  return completed;
}

function createRoom(roomId, gridSize = 'medium', vsComputer = false) {
  const size = GRID_SIZES[gridSize] || 7;
  return {
    id: roomId, gridSize, size,
    grid: generateGrid(size),
    lines: generateLines(size),
    players: [], scores: {},
    turn: null, turnCount: 0,
    status: 'waiting', vsComputer, winner: null,
    skipNext: null, pendingExtraMove: null, sloopTarget: null,
    lastActivity: Date.now(),
  };
}

function applySpecialPower(room, playerId, special) {
  const opponentId = room.players.find(p => p.id !== playerId)?.id;
  switch (special.id) {
    case 'hitman': room.skipNext = opponentId; break;
    case 'bribe':  room.pendingExtraMove = playerId; break;
    case 'sloop':  room.sloopTarget = playerId; break;
  }
}

// ================================================================
// Bot AI
// ================================================================

function getAvailableMoves(size, lines) {
  const moves = [];
  const { hLines, vLines } = lines;
  for (let row = 0; row <= size; row++)
    for (let col = 0; col < size; col++)
      if (!hLines[row][col]) moves.push({ type: 'h', row, col });
  for (let row = 0; row < size; row++)
    for (let col = 0; col <= size; col++)
      if (!vLines[row][col]) moves.push({ type: 'v', row, col });
  return moves;
}

function getCellSides(lines, size, row, col) {
  const { hLines, vLines } = lines;
  return (hLines[row][col]?1:0) + (hLines[row+1][col]?1:0) +
         (vLines[row][col]?1:0) + (vLines[row][col+1]?1:0);
}

function cloneLines(lines) {
  return { hLines: lines.hLines.map(r=>[...r]), vLines: lines.vLines.map(r=>[...r]) };
}

function applyLineToLines(lines, move) {
  const cl = cloneLines(lines);
  if (move.type === 'h') cl.hLines[move.row][move.col] = 'X';
  else cl.vLines[move.row][move.col] = 'X';
  return cl;
}

function getAdjacentCells(move, size) {
  const cells = [];
  if (move.type === 'h') {
    if (move.row > 0) cells.push({ row: move.row-1, col: move.col });
    if (move.row < size) cells.push({ row: move.row, col: move.col });
  } else {
    if (move.col > 0) cells.push({ row: move.row, col: move.col-1 });
    if (move.col < size) cells.push({ row: move.row, col: move.col });
  }
  return cells;
}

function cellsCompletedByMove(lines, grid, size, move) {
  const newLines = applyLineToLines(lines, move);
  return getAdjacentCells(move, size).filter(({ row, col }) => {
    const cell = grid[row * size + col];
    return cell && !cell.owner && getCellSides(newLines, size, row, col) === 4;
  });
}

function threatsCreatedByMove(lines, grid, size, move) {
  const newLines = applyLineToLines(lines, move);
  return getAdjacentCells(move, size).filter(({ row, col }) => {
    const cell = grid[row * size + col];
    return cell && !cell.owner &&
      getCellSides(lines, size, row, col) < 3 &&
      getCellSides(newLines, size, row, col) === 3;
  }).length;
}

function computeBotMove(room) {
  const { size, lines, grid } = room;
  const moves = getAvailableMoves(size, lines);
  if (moves.length === 0) return null;

  // 1. Claim a key location if possible
  for (const move of moves) {
    const done = cellsCompletedByMove(lines, grid, size, move);
    if (done.some(({ row, col }) => grid[row * size + col].isKeyLocation)) return move;
  }
  // 2. Block opponent from completing a key location (3-sided key cells)
  for (const move of moves) {
    const newLines = applyLineToLines(lines, move);
    for (const { row, col } of getAdjacentCells(move, size)) {
      const cell = grid[row * size + col];
      if (cell && !cell.owner && cell.isKeyLocation && getCellSides(lines, size, row, col) === 3) {
        // This move completes a 3-sided key cell → take it
        if (getCellSides(newLines, size, row, col) === 4) return move;
      }
    }
  }
  // 3. Claim any cell
  for (const move of moves) {
    if (cellsCompletedByMove(lines, grid, size, move).length > 0) return move;
  }
  // 4. Safe moves (don't create 3-sided key locations for opponent)
  const safe = moves.filter(m => {
    if (threatsCreatedByMove(lines, grid, size, m) > 0) return false;
    const nl = applyLineToLines(lines, m);
    return !getAdjacentCells(m, size).some(({ row, col }) => {
      const cell = grid[row * size + col];
      return cell && !cell.owner && cell.isKeyLocation && getCellSides(nl, size, row, col) === 3;
    });
  });
  const pool = safe.length > 0 ? safe : moves;
  return pool[Math.floor(Math.random() * pool.length)];
}

function computeBotSloopTarget(room) {
  const { size, lines, grid } = room;
  let best = null, bestScore = -1;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = grid[row * size + col];
      if (cell.owner) continue;
      const sides = getCellSides(lines, size, row, col);
      if (sides === 0) continue;
      let score = sides;
      if (cell.isKeyLocation && sides >= 3) score += 12;
      else if (cell.isKeyLocation) score += 5;
      if (score > bestScore) { bestScore = score; best = { row, col }; }
    }
  }
  return best;
}

// ================================================================
// Shared move processing
// ================================================================

function advanceTurn(room, currentPlayerId) {
  const next = room.players.find(p => p.id !== currentPlayerId);
  if (!next) return;
  if (room.skipNext === next.id) { room.skipNext = null; }
  else { room.turn = next.id; }
}

function processMove(room, roomId, playerId, lineType, row, col) {
  const { size } = room;
  const { hLines, vLines } = room.lines;

  if (lineType === 'h') {
    if (row < 0 || row > size || col < 0 || col >= size || hLines[row][col]) return;
    hLines[row][col] = playerId;
  } else {
    if (row < 0 || row >= size || col < 0 || col > size || vLines[row][col]) return;
    vLines[row][col] = playerId;
  }

  room.lastActivity = Date.now();

  // Snapshot whether player already had a pending extra move BEFORE scoring
  const hadPendingExtraBefore = room.pendingExtraMove === playerId;

  const completed = checkCompletedCells(room.grid, room.lines, size);
  let scored = false;

  for (const { idx } of completed) {
    const cell = room.grid[idx];
    cell.owner = playerId;
    if (cell.special) {
      applySpecialPower(room, playerId, cell.special);
    }
    scored = true;
  }
  room.turnCount++;

  // Win condition: 3 key locations
  const keyCount = room.grid.filter(c => c.isKeyLocation && c.owner === playerId).length;
  if (keyCount >= WIN_LOCATIONS) {
    room.status = 'finished';
    room.winner = playerId;
    io.to(roomId).emit('room-update', sanitizeRoom(room));
    return;
  }

  // Bot auto-resolves sloop
  if (room.vsComputer && room.sloopTarget === playerId) {
    const bot = room.players.find(p => p.isBot);
    if (bot && playerId === bot.id) {
      const target = computeBotSloopTarget(room);
      if (target) {
        const { hLines, vLines } = room.lines;
        const { row, col } = target;
        hLines[row][col] = null; hLines[row+1][col] = null;
        vLines[row][col] = null; vLines[row][col+1] = null;
      }
      room.sloopTarget = null;
      advanceTurn(room, playerId);
      io.to(roomId).emit('room-update', sanitizeRoom(room));
      scheduleBotMove(room, roomId);
      return;
    }
  }

  if (room.sloopTarget === playerId) {
    // stay — waiting for human to pick a cell
  } else if (hadPendingExtraBefore) {
    // consume a pre-existing extra turn (stay on turn)
    room.pendingExtraMove = null;
  } else if (!scored) {
    advanceTurn(room, playerId);
  }
  // If scored AND bribe just activated: pendingExtraMove stays set for the next move

  io.to(roomId).emit('room-update', sanitizeRoom(room));
  if (room.vsComputer) scheduleBotMove(room, roomId);
}

function scheduleBotMove(room, roomId) {
  if (!room.vsComputer || room.status !== 'playing') return;
  const bot = room.players.find(p => p.isBot);
  if (!bot || room.turn !== bot.id) return;
  if (room.sloopTarget && room.sloopTarget !== bot.id) return;
  setTimeout(() => {
    try {
      const r = rooms[roomId];
      if (!r || r.status !== 'playing' || r.turn !== bot.id) return;
      const move = computeBotMove(r);
      if (move) processMove(r, roomId, bot.id, move.type, move.row, move.col);
    } catch (err) { console.error('Bot fout:', err); }
  }, 700);
}

// ================================================================
// Socket.io
// ================================================================

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, playerName, gridSize, vsComputer, playerId }) => {
    let room = rooms[roomId];
    if (!room) { room = createRoom(roomId, gridSize || 'small', !!vsComputer); rooms[roomId] = room; }

    // Reconnect via playerId (grace period nog actief of slot al bezet)
    if (playerId && pendingDisconnects[playerId]) {
      const pending = pendingDisconnects[playerId];
      clearTimeout(pending.timer);
      delete pendingDisconnects[playerId];
      const r = rooms[pending.roomId];
      if (r) {
        const p = r.players.find(pl => pl.playerId === playerId);
        if (p) {
          const oldId = p.id;
          p.id = socket.id;
          p.disconnected = false;
          r.scores[socket.id] = r.scores[oldId] ?? 0;
          delete r.scores[oldId];
          if (r.turn === oldId)             r.turn = socket.id;
          if (r.skipNext === oldId)         r.skipNext = socket.id;
          if (r.shieldedPlayer === oldId)   r.shieldedPlayer = socket.id;
          if (r.sloopTarget === oldId)      r.sloopTarget = socket.id;
          if (r.ratTarget === oldId)        r.ratTarget = socket.id;
          if (r.pendingExtraMove === oldId) r.pendingExtraMove = socket.id;
          socket.join(pending.roomId);
          socket.data.roomId = pending.roomId;
          io.to(pending.roomId).emit('room-update', sanitizeRoom(r));
          return;
        }
      }
    }

    // Kamer vol?
    if (room.players.length >= 2) { socket.emit('room-full'); return; }
    if (room.players.find(p => p.id === socket.id)) return;

    const colors = ['#c0392b', '#2475a8'];
    const player = { id: socket.id, playerId: playerId || null, name: playerName || 'Don', color: colors[room.players.length], num: room.players.length + 1 };
    room.players.push(player);
    room.scores[socket.id] = 0;
    socket.join(roomId);
    socket.data.roomId = roomId;

    if (room.vsComputer && room.players.length === 1) {
      const bot = { id: 'BOT', name: 'Don Kraken', color: colors[1], num: 2, isBot: true };
      room.players.push(bot);
      room.scores['BOT'] = 0;
      room.turn = socket.id;
      room.status = 'playing';
    } else if (room.players.length === 2) {
      room.turn = room.players[0].id;
      room.status = 'playing';
    }
    io.to(roomId).emit('room-update', sanitizeRoom(room));
  });

  socket.on('place-line', ({ roomId, lineType, row, col }) => {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;
    if (room.turn !== socket.id) return;
    if (room.sloopTarget) return;
    processMove(room, roomId, socket.id, lineType, row, col);
  });

  socket.on('sloop-cell', ({ roomId, row, col }) => {
    const room = rooms[roomId];
    if (!room || room.sloopTarget !== socket.id) return;
    const { size } = room;
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    if (room.grid[row * size + col].owner) return; // geen owned cellen
    const { hLines, vLines } = room.lines;
    hLines[row][col]   = null; hLines[row+1][col] = null;
    vLines[row][col]   = null; vLines[row][col+1] = null;
    room.sloopTarget = null;
    advanceTurn(room, socket.id);
    io.to(roomId).emit('room-update', sanitizeRoom(room));
    if (room.vsComputer) scheduleBotMove(room, roomId);
  });

  socket.on('request-rematch', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id);
    const needed = room.vsComputer ? 1 : 2;
    if (room.rematchVotes.size >= needed) {
      const newRoom = createRoom(roomId, room.gridSize, room.vsComputer);
      const humans = room.players.filter(p => !p.isBot);
      newRoom.players = humans.map(p => ({ ...p }));
      newRoom.players.forEach(p => { newRoom.scores[p.id] = 0; });
      if (room.vsComputer) {
        newRoom.players.push({ id: 'BOT', name: 'Don Kraken', color: '#2475a8', num: 2, isBot: true });
        newRoom.scores['BOT'] = 0;
        newRoom.turn = humans[0]?.id || null;
      } else {
        newRoom.turn = room.players[Math.floor(Math.random() * 2)].id;
      }
      newRoom.status = 'playing';
      rooms[roomId] = newRoom;
      io.to(roomId).emit('room-update', sanitizeRoom(newRoom));
    } else {
      io.to(roomId).emit('rematch-vote', { votes: room.rematchVotes.size });
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const player = room.players.find(p => p.id === socket.id && !p.isBot);

    if (player?.playerId) {
      // Grace period: markeer als verbroken, wacht op reconnect
      player.disconnected = true;
      io.to(roomId).emit('room-update', sanitizeRoom(room));
      pendingDisconnects[player.playerId] = {
        roomId,
        timer: setTimeout(() => {
          delete pendingDisconnects[player.playerId];
          const r = rooms[roomId];
          if (!r) return;
          r.players = r.players.filter(p => p.id !== socket.id && !p.isBot);
          r.status = r.players.length === 0 ? 'empty' : 'waiting';
          if (r.players.length === 0)
            setTimeout(() => { if (rooms[roomId]?.players.length === 0) delete rooms[roomId]; }, 60000);
          io.to(roomId).emit('room-update', sanitizeRoom(r));
        }, RECONNECT_GRACE),
      };
    } else {
      // Geen playerId (bijv. oude client) — meteen verwijderen
      room.players = room.players.filter(p => p.id !== socket.id && !p.isBot);
      room.status = room.players.length === 0 ? 'empty' : 'waiting';
      if (room.players.length === 0)
        setTimeout(() => { if (rooms[roomId]?.players.length === 0) delete rooms[roomId]; }, 60000);
      io.to(roomId).emit('room-update', sanitizeRoom(room));
    }
  });
});

function sanitizeRoom(room) {
  return {
    id: room.id, gridSize: room.gridSize, size: room.size,
    grid: room.grid, lines: room.lines,
    players: room.players.map(({ playerId: _pid, ...p }) => p), scores: room.scores,
    turn: room.turn, status: room.status, vsComputer: room.vsComputer, winner: room.winner,
    sloopTarget: room.sloopTarget, skipNext: room.skipNext,
    pendingExtraMove: room.pendingExtraMove,
  };
}

// Room cleanup: finished rooms after 30 min, any stale room after 3 hours
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    const idle = now - (room.lastActivity || 0);
    if (room.status === 'finished' && idle > 30 * 60 * 1000) { delete rooms[id]; continue; }
    if (idle > 3 * 60 * 60 * 1000) delete rooms[id];
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => console.log(`Square Off draait op http://localhost:${PORT}`));
