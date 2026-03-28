const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

process.on('uncaughtException',  (err) => console.error('Error:', err));
process.on('unhandledRejection', (err) => console.error('Promise error:', err));
const SERVER_VERSION = '2026-03-28-v4';
console.log(`[Square Off] server starting — version ${SERVER_VERSION}`);

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
app.get('/version', (req, res) => res.json({ version: SERVER_VERSION, specials: THEME_SPECIALS.map(s => s.emoji) }));

// ================================================================
// THEME — Cosa Nostra
// Swap this block to change themes without touching game logic.
// ================================================================
const THEME_SPECIALS = [
  { id: 'hitman', emoji: '🚓', name: 'Raid',     desc: 'Opponent skips a turn' },
  { id: 'bribe',  emoji: '💸', name: 'Bribery',  desc: 'Play an extra turn immediately' },
  { id: 'bomb',   emoji: '💣', name: 'Grenade',  desc: 'Remove all walls around a chosen cell' },
];

const KEY_LOCATION_DEFS = [
  { id: 'bank',       emoji: '🏦', name: 'The Bank',    glow: '#e8a020' },
  { id: 'casino',     emoji: '🏦', name: 'The Casino',  glow: '#e8a020' },
  { id: 'haven',      emoji: '🏦', name: 'The Harbor',  glow: '#e8a020' },
  { id: 'stadhuis',   emoji: '🏦', name: 'City Hall',   glow: '#e8a020' },
  { id: 'gevangenis', emoji: '🏦', name: 'The Prison',  glow: '#e8a020' },
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
  const specialCount = size <= 6 ? 6 : 8;
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
    skipNext: null, pendingExtraMove: null, bombTarget: null, razziaPenalty: false, bombScoredExtra: false,
    lastActivity: Date.now(),
  };
}

function applySpecialPower(room, playerId, special) {
  switch (special.id) {
    case 'hitman': room.razziaPenalty = true; break;  // cancels own scoring bonus
    case 'bribe':  room.pendingExtraMove = playerId; break;
    case 'bomb':   room.bombTarget = playerId; break;
  }
}

// Remove walls of bombed cell; unclaim adjacent cells that lose a wall they needed.
// Returns list of {row,col} cells that were unclaimed.
function applyBomb(room, bombRow, bombCol) {
  const { size, lines, grid } = room;
  const { hLines, vLines } = lines;
  hLines[bombRow][bombCol]   = null;
  hLines[bombRow+1][bombCol] = null;
  vLines[bombRow][bombCol]   = null;
  vLines[bombRow][bombCol+1] = null;

  const unclaimed = [];
  const neighbors = [
    { row: bombRow-1, col: bombCol },
    { row: bombRow+1, col: bombCol },
    { row: bombRow,   col: bombCol-1 },
    { row: bombRow,   col: bombCol+1 },
  ];
  for (const { row, col } of neighbors) {
    if (row < 0 || row >= size || col < 0 || col >= size) continue;
    const cell = grid[row * size + col];
    if (!cell.owner) continue;
    if (getCellSides(lines, size, row, col) < 4) {
      unclaimed.push({ row, col });
      cell.owner = null;
    }
  }
  return unclaimed;
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
  // Helper: does this move make an unowned bank 3-sided?
  const givesOpponentBank = m => {
    const nl = applyLineToLines(lines, m);
    return getAdjacentCells(m, size).some(({ row, col }) => {
      const cell = grid[row * size + col];
      return cell && !cell.owner && cell.isKeyLocation && getCellSides(nl, size, row, col) === 3;
    });
  };
  const isHitmanCell = ({ row, col }) => grid[row * size + col].special?.id === 'hitman';

  // 3. Claim any cell — prefer bribe/bomb, avoid hitman; but prefer hitman over giving opponent a bank
  const scoringMoves = moves.filter(m => cellsCompletedByMove(lines, grid, size, m).length > 0);
  const nonHitmanScoring = scoringMoves.filter(m => !cellsCompletedByMove(lines, grid, size, m).every(isHitmanCell));
  const hitmanScoring    = scoringMoves.filter(m =>  cellsCompletedByMove(lines, grid, size, m).every(isHitmanCell));

  if (nonHitmanScoring.length > 0) {
    nonHitmanScoring.sort((a, b) => {
      const sp = m => { let s = 0; for (const c of cellsCompletedByMove(lines, grid, size, m)) { const id = grid[c.row * size + c.col].special?.id; if (id === 'bribe' || id === 'bomb') s += 6; } return s; };
      return sp(b) - sp(a);
    });
    return nonHitmanScoring[0];
  }

  // 4. Safe moves (no threats, no bank handed to opponent)
  const safe = moves.filter(m => threatsCreatedByMove(lines, grid, size, m) === 0 && !givesOpponentBank(m));

  // 5. If hitman is available and doesn't give opponent a bank, prefer it over dangerous moves
  const hitmanSafe = hitmanScoring.filter(m => !givesOpponentBank(m));
  if (hitmanSafe.length > 0 && safe.length === 0) return hitmanSafe[0];

  // 6. Safe non-scoring move, or least-bad fallback
  const pool = safe.length > 0 ? safe : moves.filter(m => !givesOpponentBank(m));
  return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : moves[Math.floor(Math.random() * moves.length)];
}

function computeBotBombTarget(room) {
  const { size, lines, grid } = room;
  const humanId = room.players.find(p => !p.isBot)?.id;
  let best = null, bestScore = -Infinity;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = grid[row * size + col];
      if (cell.owner) continue; // can only bomb unowned cells

      // Simulate removing all 4 walls of this cell
      const sim = cloneLines(lines);
      sim.hLines[row][col]     = null;
      sim.hLines[row + 1][col] = null;
      sim.vLines[row][col]     = null;
      sim.vLines[row][col + 1] = null;

      let score = 0;
      const neighbors = [
        [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1],
      ];
      for (const [nr, nc] of neighbors) {
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const nb = grid[nr * size + nc];
        const before = getCellSides(lines, size, nr, nc);
        const after  = getCellSides(sim, size, nr, nc);
        if (nb.owner === humanId && after < 4 && before === 4) {
          // Human-owned cell gets unclaimed
          score += nb.isKeyLocation ? 25 : 8;
        } else if (!nb.owner && before === 3 && after < 3) {
          // Human's 3-sided cell gets pushed back (harder to complete)
          score += nb.isKeyLocation ? 12 : 4;
        }
      }
      // Tiebreaker: walls on the bombed cell itself
      score += getCellSides(lines, size, row, col) * 0.5;

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

  const razziaPenalty = room.razziaPenalty;
  room.razziaPenalty = false;

  if (room.bombTarget === playerId) {
    if (scored) room.bombScoredExtra = true; // remember scoring bonus for after bomb resolves
    // stay — waiting for human to pick a bomb target
  } else if (razziaPenalty) {
    // Razzia: cancel scoring bonus, turn ends immediately
    advanceTurn(room, playerId);
  } else if (scored) {
    // Normal scoring bonus: keep turn; steekpenning preserved for later
  } else if (room.pendingExtraMove === playerId) {
    room.pendingExtraMove = null; // consume steekpenning extra turn
  } else {
    advanceTurn(room, playerId);
  }

  io.to(roomId).emit('room-update', sanitizeRoom(room));
  if (room.vsComputer) scheduleBotMove(room, roomId);
}

function scheduleBotMove(room, roomId) {
  if (!room.vsComputer || room.status !== 'playing') return;
  const bot = room.players.find(p => p.isBot);
  if (!bot || room.turn !== bot.id) return;
  if (room.bombTarget && room.bombTarget !== bot.id) return;
  setTimeout(() => {
    try {
      const r = rooms[roomId];
      if (!r || r.status !== 'playing' || r.turn !== bot.id) return;

      // Resolve pending bomb BEFORE making a line move (prevents loop)
      if (r.bombTarget === bot.id) {
        const target = computeBotBombTarget(r);
        let unclaimed = [];
        if (target) unclaimed = applyBomb(r, target.row, target.col);
        r.bombTarget = null;
        if (r.bombScoredExtra) {
          r.bombScoredExtra = false; // bot keeps turn — it scored when it got the bomb
        } else {
          advanceTurn(r, bot.id);
        }
        const bombUpdate = sanitizeRoom(r);
        if (target) bombUpdate.bombedCell = { row: target.row, col: target.col, unclaimed };
        io.to(roomId).emit('room-update', bombUpdate);
        scheduleBotMove(r, roomId);
        return;
      }

      const move = computeBotMove(r);
      if (move) processMove(r, roomId, bot.id, move.type, move.row, move.col);
    } catch (err) { console.error('Bot error:', err); }
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
          if (r.bombTarget === oldId)       r.bombTarget = socket.id;
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

    const colors = ['#ff2244', '#00aaff'];
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
    if (room.bombTarget) return;
    processMove(room, roomId, socket.id, lineType, row, col);
  });

  socket.on('bomb-cell', ({ roomId, row, col }) => {
    const room = rooms[roomId];
    if (!room || room.bombTarget !== socket.id) return;
    const { size } = room;
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    if (room.grid[row * size + col].owner) return;
    const unclaimed = applyBomb(room, row, col);
    room.bombTarget = null;
    if (room.bombScoredExtra) {
      room.bombScoredExtra = false; // keep turn — player scored when they got the bomb
    } else {
      advanceTurn(room, socket.id);
    }
    const bombUpdate = sanitizeRoom(room);
    bombUpdate.bombedCell = { row, col, unclaimed };
    io.to(roomId).emit('room-update', bombUpdate);
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
        newRoom.players.push({ id: 'BOT', name: 'Don Kraken', color: '#00aaff', num: 2, isBot: true });
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
    bombTarget: room.bombTarget, skipNext: room.skipNext,
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
server.listen(PORT, () => console.log(`Square Off running on http://localhost:${PORT}`));
