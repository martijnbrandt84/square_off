// ---- Init ----
const BACKEND = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? '' : 'https://squareoff-production.up.railway.app';
const socket = BACKEND ? io(BACKEND) : io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const params = new URLSearchParams(window.location.search);
const playerName = params.get('name') || 'Don';
const gridSize   = params.get('size') || 'medium';
const vsComputer = !!params.get('vsComputer');
const roomId     = window.location.pathname.split('/').pop();

document.getElementById('roomCode').textContent = roomId;

// ---- Theme ----
const THEME = {
  keyLocations: [
    { id: 'bank',       emoji: '🏦', name: 'De Bank',       glow: '#e8a020' },
    { id: 'casino',     emoji: '🏦', name: 'Het Casino',    glow: '#e8a020' },
    { id: 'haven',      emoji: '🏦', name: 'De Haven',      glow: '#e8a020' },
    { id: 'stadhuis',   emoji: '🏦', name: 'Het Stadhuis',  glow: '#e8a020' },
    { id: 'gevangenis', emoji: '🏦', name: 'De Gevangenis', glow: '#e8a020' },
  ],
};

// ---- Specials info (for reveal popup) ----
const SPECIALS_INFO = {
  hitman: { emoji: '🚓', name: 'Politie-inval', myDesc: 'Tegenstander slaat zijn volgende beurt over', oppDesc: 'Jij slaat je volgende beurt over' },
  bribe:  { emoji: '💸', name: 'Smeergeld',     myDesc: 'Jij speelt direct nog een beurt',             oppDesc: 'Tegenstander speelt nog een extra beurt' },
  sloop:  { emoji: '💥', name: 'Sloop',         myDesc: 'Kies een vakje — alle lijnen eromheen worden verwijderd', oppDesc: 'Tegenstander sloopt alle lijnen rondom een vakje' },
};

// ---- City map palette ----
const MAP = {
  bg:      '#1c2030',   // street / asphalt color
  terrain: {
    alley:    { fill: '#0e1208', emojis: ['🌳','🌲','🌿','🌳','🌲'] },
    street:   { fill: '#12141e', emojis: ['🏠','🏡','🏘️','🏠','🏡'] },
    district: { fill: '#0f1220', emojis: ['🏢','🏬','🏪','🏣','🏨'] },
  },
  dot: '#161928',
};

const SI = 3; // street inset per side (street width = SI*2 = 6px)
const UNPLACED_LINE_COLOR = 'rgba(255,255,255,0.045)';

// ---- State ----
let room     = null;
let myId     = null;
let waitingForSloop    = false;
let hoveredLine        = null;
let hoveredSloopCell   = null;
let rafId          = null;
let lastTouchLine  = null;
let claimedFlashes = []; // {idx, color, t}

// ---- SFX (Web Audio API — lazy init, iOS-safe) ----
const SFX = (() => {
  let _ctx = null;
  function ctx() {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }
  function beep(freq, type, dur, vol, delay = 0) {
    try {
      const c = ctx(), o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type = type;
      o.frequency.setValueAtTime(freq, c.currentTime + delay);
      g.gain.setValueAtTime(vol, c.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + dur);
      o.start(c.currentTime + delay);
      o.stop(c.currentTime + delay + dur + 0.05);
    } catch(e) {}
  }
  function sweep(f0, f1, type, dur, vol) {
    try {
      const c = ctx(), o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type = type;
      o.frequency.setValueAtTime(f0, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(f1, c.currentTime + dur);
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      o.start(c.currentTime);
      o.stop(c.currentTime + dur + 0.05);
    } catch(e) {}
  }
  return {
    placeLine() { beep(700, 'sine', 0.07, 0.10); },
    oppLine()   { beep(280, 'sine', 0.08, 0.07); },
    claimCell() { beep(320, 'sine', 0.18, 0.28); beep(200, 'sine', 0.14, 0.18, 0.06); },
    claimBank() { [440, 554, 659, 880].forEach((f, i) => beep(f, 'sine', 0.35, 0.28, i * 0.09)); },
    special()   { sweep(200, 900, 'sawtooth', 0.30, 0.16); beep(900, 'sine', 0.18, 0.14, 0.25); },
    win()       { [523, 659, 784, 1047].forEach((f, i) => beep(f, 'sine', 0.4, 0.30, i * 0.10)); },
    lose()      { [392, 349, 311, 262].forEach((f, i) => beep(f, 'sine', 0.38, 0.22, i * 0.12)); },
  };
})();

// ---- Layout ----
const DOT_R = 3;
let CELL_SIZE = 72;
let OFFSET_X  = 24;
let OFFSET_Y  = 24;

// ---- Persistent player ID (survives page refresh) ----
function getPlayerId() {
  let id = localStorage.getItem('squareoff_pid');
  if (!id) { id = Math.random().toString(36).slice(2, 12); localStorage.setItem('squareoff_pid', id); }
  return id;
}
const playerId = getPlayerId();

// ---- Join room ----
socket.on('connect', () => {
  myId = socket.id;
  socket.emit('join-room', { roomId, playerName, gridSize, vsComputer, playerId });
});

// ---- Room updates ----
socket.on('room-update', (updatedRoom) => {
  const wasWaiting = !room || room.status === 'waiting';

  // Detect opponent line placement
  if (room?.lines && updatedRoom.lines) {
    const { hLines: oh, vLines: ov } = room.lines;
    const { hLines: nh, vLines: nv } = updatedRoom.lines;
    let oppPlaced = false;
    outer: for (let r = 0; r < nh.length; r++)
      for (let c = 0; c < nh[r].length; c++)
        if (!oh[r]?.[c] && nh[r][c] && nh[r][c] !== myId) { oppPlaced = true; break outer; }
    if (!oppPlaced) {
      outer2: for (let r = 0; r < nv.length; r++)
        for (let c = 0; c < nv[r].length; c++)
          if (!ov[r]?.[c] && nv[r][c] && nv[r][c] !== myId) { oppPlaced = true; break outer2; }
    }
    if (oppPlaced) SFX.oppLine();
  }

  // Detect newly claimed cells — flashes, sounds, special reveal
  if (room?.grid && updatedRoom.grid) {
    let specialShown = false, anyBank = false, anyCell = false;
    for (let i = 0; i < updatedRoom.grid.length; i++) {
      const cur = updatedRoom.grid[i], prev = room.grid[i];
      if (!prev?.owner && cur?.owner) {
        const owner = updatedRoom.players.find(p => p.id === cur.owner);
        claimedFlashes.push({ idx: i, color: owner?.color || '#fff', t: Date.now() });
        if (cur.isKeyLocation) anyBank = true; else anyCell = true;
        if (cur.special && !specialShown) {
          showSpecialReveal(cur.special, cur.owner === myId);
          setTimeout(() => SFX.special(), 300);
          specialShown = true;
        }
      }
    }
    if (anyBank) SFX.claimBank();
    else if (anyCell) SFX.claimCell();
  }

  updateLog(updatedRoom);
  room = updatedRoom;
  myId = socket.id;
  updateUI();
  drawBoard();

  if (wasWaiting && room.status === 'playing') showToast('De stad ligt open. Maak je zet.', 'info');
  if (room.status === 'finished') showGameOver();

  waitingForSloop = room.sloopTarget === myId;

  if (waitingForSloop) {
    setHint('💥 Kies een vakje — alle lijnen eromheen worden verwijderd.', 'danger');
  } else if (room.turn === myId && room.status === 'playing') {
    setHint('Jouw beurt — trek een grens.', 'my-turn');
  } else if (room.status === 'playing') {
    const opp = room.players.find(p => p.id !== myId && !p.isBot);
    if (opp?.disconnected) setHint('⚠️ Tegenstander verbroken — wacht op reconnect (25s)...', 'wait');
    else setHint(room.vsComputer ? '🤖 Don Kraken denkt na...' : 'Tegenstander is aan zet...', 'wait');
  } else if (room.status === 'waiting') {
    setHint('Wachten op tweede speler...', 'wait');
  } else {
    setHint('', '');
  }

  if (room.status === 'playing' || claimedFlashes.length > 0) startPulse();
  else stopPulse();
});

socket.on('room-full', () => { alert('Kamer vol.'); window.location.href = '/'; });
socket.on('player-disconnected', () => showToast('⚠️ Tegenstander verbroken.', 'warn'));
socket.on('rematch-vote', ({ votes }) => {
  document.getElementById('rematchStatus').textContent = `${votes}/2 willen herspelen...`;
});

// ---- Animation loop ----
function startPulse() {
  if (rafId) return;
  function tick() {
    if (room) drawBoard(); // drawBoard cleans stale flashes
    const hasFlashes = claimedFlashes.length > 0;
    if (room?.status === 'playing' || hasFlashes) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = null;
    }
  }
  rafId = requestAnimationFrame(tick);
}
function stopPulse() {
  if (rafId && claimedFlashes.length === 0) { cancelAnimationFrame(rafId); rafId = null; }
}

// ---- UI ----
function updateUI() {
  if (!room) return;
  const p1 = room.players[0], p2 = room.players[1];
  if (p1) {
    document.getElementById('p1name').textContent = p1.name;
    document.getElementById('p1card').style.borderColor = p1.color;
    document.getElementById('p1turn').style.opacity = room.turn === p1.id ? '1' : '0';
    renderLocationBar(p1.id, 'p1locs');
    const p1banks = room.grid.filter(c => c.isKeyLocation && c.owner === p1.id).length;
    document.getElementById('p1score').textContent = p1banks;
  }
  if (p2) {
    document.getElementById('p2name').textContent = p2.name;
    document.getElementById('p2card').style.borderColor = p2.color;
    document.getElementById('p2turn').style.opacity = room.turn === p2.id ? '1' : '0';
    renderLocationBar(p2.id, 'p2locs');
    const p2banks = room.grid.filter(c => c.isKeyLocation && c.owner === p2.id).length;
    document.getElementById('p2score').textContent = p2banks;
  }
  const statusEl = document.getElementById('statusBadge');
  if (room.status === 'waiting')  { statusEl.textContent = '⏳ Wachten';   statusEl.className = 'status-badge waiting'; }
  if (room.status === 'playing')  { statusEl.textContent = '⚔️ In strijd'; statusEl.className = 'status-badge playing'; }
  if (room.status === 'finished') { statusEl.textContent = '🏁 Afgelopen'; statusEl.className = 'status-badge finished'; }

  document.getElementById('powerDisplay').style.display = 'none';
}

function renderLocationBar(playerId, elementId) {
  if (!room) return;
  const el = document.getElementById(elementId);
  if (!el) return;
  const owned = new Set(room.grid.filter(c => c.isKeyLocation && c.owner === playerId).map(c => c.keyDef.id));
  el.innerHTML = THEME.keyLocations.map(kd =>
    `<span class="loc-pip${owned.has(kd.id) ? ' owned' : ''}" title="${kd.name}">${owned.has(kd.id) ? '🏦' : '◌'}</span>`
  ).join('');
}

// ---- Special reveal popup ----
function showSpecialReveal(special, isMySpecial) {
  const info = SPECIALS_INFO[special.id];
  if (!info) return;
  const el = document.getElementById('specialReveal');
  const desc = isMySpecial ? info.myDesc : info.oppDesc;
  el.innerHTML = `
    <div class="sr-emoji">${info.emoji}</div>
    <div class="sr-body">
      <div class="sr-label">${isMySpecial ? 'Jij pakt' : 'Tegenstander pakt'}</div>
      <div class="sr-name">${info.name}</div>
      <div class="sr-desc">${desc}</div>
    </div>
  `;
  el.className = `special-reveal ${isMySpecial ? 'sr-mine' : 'sr-opp'} show`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 4000);
}

// ---- PRNG ----
function cellPrng(row, col) {
  const seed = (row * 97 + col * 53 + 7) | 0;
  return (n) => (Math.imul(seed + n * 1664525, 1013904223) >>> 0) / 0xffffffff;
}

// ---- Canvas sizing ----
function resizeCanvas() {
  if (!room) return;
  const size    = room.size;
  const mobile  = window.innerWidth < 700;
  const wrapper = canvas.parentElement;
  const maxW    = wrapper.clientWidth  - (mobile ? 16 : 48);
  const maxH    = wrapper.clientHeight - (mobile ? 16 : 48);
  const available = Math.min(maxW, maxH);
  CELL_SIZE = Math.floor(available / size);
  CELL_SIZE = Math.max(38, Math.min(CELL_SIZE, 96));
  OFFSET_X  = mobile ? 6 : 16;
  OFFSET_Y  = mobile ? 6 : 16;
  const dpr  = window.devicePixelRatio || 1;
  const logW = size * CELL_SIZE + OFFSET_X * 2;
  const logH = size * CELL_SIZE + OFFSET_Y * 2;
  canvas.width        = Math.round(logW * dpr);
  canvas.height       = Math.round(logH * dpr);
  canvas.style.width  = logW + 'px';
  canvas.style.height = logH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---- Draw board ----
function drawBoard() {
  if (!room) return;
  resizeCanvas();
  const { size, grid, lines } = room;
  const { hLines, vLines }    = lines;

  // Streets (background) — use logical dimensions (ctx is scaled by DPR)
  ctx.fillStyle = MAP.bg;
  ctx.fillRect(0, 0, size * CELL_SIZE + OFFSET_X * 2, size * CELL_SIZE + OFFSET_Y * 2);

  // City blocks (inset from streets)
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      drawCityBlock(grid[row * size + col], OFFSET_X + col * CELL_SIZE, OFFSET_Y + row * CELL_SIZE, CELL_SIZE);

  // Danger overlay — unclaimed cells with 3 sides (pulsing yellow)
  const pulse = 0.55 + 0.45 * Math.sin(Date.now() / 280);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = grid[row * size + col];
      if (!cell.owner) {
        const sides = (hLines[row][col] ? 1 : 0) + (hLines[row+1][col] ? 1 : 0) +
                      (vLines[row][col] ? 1 : 0) + (vLines[row][col+1] ? 1 : 0);
        if (sides === 3) {
          const dx = OFFSET_X + col * CELL_SIZE, dy = OFFSET_Y + row * CELL_SIZE;
          ctx.fillStyle = `rgba(240,200,20,${(0.18 + 0.22 * pulse).toFixed(3)})`;
          ctx.fillRect(dx + SI, dy + SI, CELL_SIZE - SI * 2, CELL_SIZE - SI * 2);
        }
      }
    }
  }

  // Sloop mode: highlight hoverable cells (unclaimed only)
  if (waitingForSloop) {
    const sloopPulse = 0.55 + 0.45 * Math.sin(Date.now() / 220);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (grid[row * size + col].owner) continue;
        const dx = OFFSET_X + col * CELL_SIZE, dy = OFFSET_Y + row * CELL_SIZE;
        const sloopHov = hoveredSloopCell?.row === row && hoveredSloopCell?.col === col;
        if (sloopHov) {
          ctx.fillStyle = `rgba(255,80,20,${(0.30 + 0.25 * sloopPulse).toFixed(3)})`;
        } else {
          ctx.fillStyle = `rgba(255,80,20,${(0.08 + 0.08 * sloopPulse).toFixed(3)})`;
        }
        ctx.fillRect(dx + SI, dy + SI, CELL_SIZE - SI * 2, CELL_SIZE - SI * 2);
      }
    }
  }

  // Faint indicators for unplaced line positions
  ctx.strokeStyle = UNPLACED_LINE_COLOR;
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'butt';
  ctx.shadowBlur  = 0;
  for (let row = 0; row <= size; row++)
    for (let col = 0; col < size; col++)
      if (!hLines[row]?.[col]) {
        const x = OFFSET_X + col * CELL_SIZE, y = OFFSET_Y + row * CELL_SIZE;
        ctx.beginPath(); ctx.moveTo(x + 4, y); ctx.lineTo(x + CELL_SIZE - 4, y); ctx.stroke();
      }
  for (let row = 0; row < size; row++)
    for (let col = 0; col <= size; col++)
      if (!vLines[row]?.[col]) {
        const x = OFFSET_X + col * CELL_SIZE, y = OFFSET_Y + row * CELL_SIZE;
        ctx.beginPath(); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + CELL_SIZE - 4); ctx.stroke();
      }

  // Owned / hover territory lines
  for (let row = 0; row <= size; row++)
    for (let col = 0; col < size; col++) {
      const owner = hLines[row]?.[col];
      if (owner) {
        drawLine('h', row, col, room.players.find(p => p.id === owner)?.color || '#fff', false);
      } else {
        const isHov = hoveredLine?.type === 'h' && hoveredLine.row === row && hoveredLine.col === col;
        if (isHov) drawLine('h', row, col, getMyColor(), true);
      }
    }
  for (let row = 0; row < size; row++)
    for (let col = 0; col <= size; col++) {
      const owner = vLines[row]?.[col];
      if (owner) {
        drawLine('v', row, col, room.players.find(p => p.id === owner)?.color || '#fff', false);
      } else {
        const isHov = hoveredLine?.type === 'v' && hoveredLine.row === row && hoveredLine.col === col;
        if (isHov) drawLine('v', row, col, getMyColor(), true);
      }
    }

  // Claim flash animations (drawn after lines, before dots)
  const _now = Date.now();
  claimedFlashes = claimedFlashes.filter(f => _now - f.t < 700);
  for (const f of claimedFlashes) {
    const frow = Math.floor(f.idx / size), fcol = f.idx % size;
    const age = (_now - f.t) / 700;
    const fx = OFFSET_X + fcol * CELL_SIZE, fy = OFFSET_Y + frow * CELL_SIZE;
    ctx.fillStyle = hexToRgba(f.color, (1 - age) * 0.65);
    ctx.fillRect(fx + SI, fy + SI, CELL_SIZE - SI * 2, CELL_SIZE - SI * 2);
  }

  // Bank & special emojis — drawn last so lines never cover them
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.globalAlpha = 1;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = grid[row * size + col];
      const cx = OFFSET_X + col * CELL_SIZE + CELL_SIZE / 2;
      const cy = OFFSET_Y + row * CELL_SIZE + CELL_SIZE / 2;
      if (cell.isKeyLocation) {
        ctx.font = `${Math.floor(CELL_SIZE * 0.55)}px serif`;
        ctx.fillText('🏦', cx, cy);
      } else if (cell.special && !cell.owner) {
        ctx.font = `${Math.floor(CELL_SIZE * 0.44)}px serif`;
        ctx.fillText(cell.special.emoji, cx, cy);
      }
    }
  }

  // Intersection dots
  for (let row = 0; row <= size; row++)
    for (let col = 0; col <= size; col++) {
      const x = OFFSET_X + col * CELL_SIZE, y = OFFSET_Y + row * CELL_SIZE;
      ctx.fillStyle = MAP.dot;
      ctx.beginPath(); ctx.arc(x, y, DOT_R, 0, Math.PI * 2); ctx.fill();
    }
}

function drawCityBlock(cell, x, y, cs) {
  const prng = cellPrng(cell.row, cell.col);
  const tm   = MAP.terrain[cell.terrain] || MAP.terrain.district;

  // Block fill (inset = visible street around edge)
  ctx.fillStyle = tm.fill;
  ctx.fillRect(x + SI, y + SI, cs - SI * 2, cs - SI * 2);

  // Owner wash — strong color fill
  if (cell.owner) {
    const owner = room.players.find(p => p.id === cell.owner);
    if (owner) {
      ctx.fillStyle = hexToRgba(owner.color, 0.52);
      ctx.fillRect(x + SI, y + SI, cs - SI * 2, cs - SI * 2);
      // subtle inner border
      ctx.strokeStyle = hexToRgba(owner.color, 0.70);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + SI + 1, y + SI + 1, cs - SI * 2 - 2, cs - SI * 2 - 2);
    }
  }

  // Dimmed background emoji
  if (!cell.isKeyLocation && !cell.special) {
    const em = tm.emojis[Math.floor(prng(1) * tm.emojis.length)];
    ctx.globalAlpha = cell.owner ? 0.20 : 0.07;
    ctx.font = `${Math.floor(cs * 0.42)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(em, x + cs / 2, y + cs / 2);
    ctx.globalAlpha = 1;
  }

  // Key location — golden background only (emoji drawn in separate pass)
  if (cell.isKeyLocation) {
    if (cell.owner) {
      const owner = room.players.find(p => p.id === cell.owner);
      if (owner) {
        ctx.fillStyle = hexToRgba(owner.color, 0.55);
        ctx.fillRect(x + SI, y + SI, cs - SI * 2, cs - SI * 2);
        ctx.strokeStyle = hexToRgba(owner.color, 0.80);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + SI + 1, y + SI + 1, cs - SI * 2 - 2, cs - SI * 2 - 2);
      }
    } else {
      ctx.fillStyle = 'rgba(210, 150, 10, 0.30)';
      ctx.fillRect(x + SI, y + SI, cs - SI * 2, cs - SI * 2);
    }
  }
}

function drawLine(type, row, col, color, ghost) {
  const x1 = OFFSET_X + col * CELL_SIZE;
  const y1 = OFFSET_Y + row * CELL_SIZE;

  // Ghost (hover) = same thickness as placed, just lower opacity
  ctx.strokeStyle = ghost ? hexToRgba(color, 0.5) : color;
  ctx.lineWidth   = 6;
  ctx.lineCap     = 'square';
  ctx.shadowColor = ghost ? 'transparent' : color;
  ctx.shadowBlur  = ghost ? 0 : 12;

  ctx.beginPath();
  if (type === 'h') {
    ctx.moveTo(x1, y1); ctx.lineTo(x1 + CELL_SIZE, y1);
  } else {
    ctx.moveTo(x1, y1); ctx.lineTo(x1, y1 + CELL_SIZE);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ---- Canvas interaction ----
function snapZone() { return CELL_SIZE * (isTouchDevice() ? 0.44 : 0.30); }
function isTouchDevice() { return window.matchMedia('(pointer: coarse)').matches; }

canvas.addEventListener('mousemove', (e) => {
  if (!room || room.status !== 'playing') return;
  if (room.turn !== myId && !waitingForSloop) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  if (waitingForSloop) {
    const prev = JSON.stringify(hoveredSloopCell);
    hoveredSloopCell = getCellAt(mx, my);
    if (JSON.stringify(hoveredSloopCell) !== prev && !rafId) drawBoard();
  } else {
    const prev = JSON.stringify(hoveredLine);
    hoveredLine = getLineAt(mx, my);
    if (JSON.stringify(hoveredLine) !== prev && !rafId) drawBoard();
  }
});

canvas.addEventListener('mouseleave', () => { hoveredLine = null; hoveredSloopCell = null; if (!rafId) drawBoard(); });

// Touch support
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!room || room.status !== 'playing') return;
  if (room.turn !== myId && !waitingForSloop) return;
  const touch = e.touches[0];
  const rect  = canvas.getBoundingClientRect();
  const mx = touch.clientX - rect.left;
  const my = touch.clientY - rect.top;
  if (waitingForSloop) {
    const prev = JSON.stringify(hoveredSloopCell);
    hoveredSloopCell = getCellAt(mx, my);
    lastTouchLine = null;
    if (JSON.stringify(hoveredSloopCell) !== prev && !rafId) drawBoard();
  } else {
    const prev = JSON.stringify(hoveredLine);
    hoveredLine   = getLineAt(mx, my);
    lastTouchLine = hoveredLine;
    if (JSON.stringify(hoveredLine) !== prev && !rafId) drawBoard();
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  const line = lastTouchLine;
  const sloopCell = hoveredSloopCell;
  lastTouchLine    = null;
  hoveredLine      = null;
  hoveredSloopCell = null;
  if (!room || room.status !== 'playing') { if (!rafId) drawBoard(); return; }

  if (waitingForSloop) {
    const touch = e.changedTouches[0];
    const rect  = canvas.getBoundingClientRect();
    const cell  = sloopCell || getCellAt(touch.clientX - rect.left, touch.clientY - rect.top);
    if (cell) {
      socket.emit('sloop-cell', { roomId, row: cell.row, col: cell.col });
      waitingForSloop = false;
    }
    if (!rafId) drawBoard(); return;
  }

  if (!line) { if (!rafId) drawBoard(); return; }
  if (room.turn !== myId) { if (!rafId) drawBoard(); return; }
  const { hLines, vLines } = room.lines;
  if (line.type === 'h' && hLines[line.row]?.[line.col]) { if (!rafId) drawBoard(); return; }
  if (line.type === 'v' && vLines[line.row]?.[line.col]) { if (!rafId) drawBoard(); return; }
  if (!socket.connected) return;
  SFX.placeLine();
  socket.emit('place-line', { roomId, lineType: line.type, row: line.row, col: line.col });
  if (!rafId) drawBoard();
}, { passive: false });

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  const rect  = canvas.getBoundingClientRect();
  const mx = touch.clientX - rect.left;
  const my = touch.clientY - rect.top;
  if (waitingForSloop) {
    hoveredSloopCell = getCellAt(mx, my);
  } else {
    hoveredLine   = getLineAt(mx, my);
    lastTouchLine = hoveredLine;
  }
  if (!rafId) drawBoard();
}, { passive: false });

function handleBoardClick(e) {
  if (!room || room.status !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  if (room.turn !== myId && !waitingForSloop) return;

  if (waitingForSloop) {
    const cell = getCellAt(mx, my);
    if (cell) {
      socket.emit('sloop-cell', { roomId, row: cell.row, col: cell.col });
      waitingForSloop = false;
    }
    return;
  }

  const line = hoveredLine || getLineAt(mx, my, CELL_SIZE * 0.44);
  if (!line) return;

  if (room.turn !== myId) return;
  const { hLines, vLines } = room.lines;
  if (line.type === 'h' && hLines[line.row]?.[line.col]) return;
  if (line.type === 'v' && vLines[line.row]?.[line.col]) return;
  if (!socket.connected) return;
  SFX.placeLine();
  socket.emit('place-line', { roomId, lineType: line.type, row: line.row, col: line.col });
}

document.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  if (e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top  && e.clientY <= rect.bottom) handleBoardClick(e);
});

function getLineAt(mx, my, snapOverride) {
  if (!room) return null;
  const size = room.size;
  const SNAP = snapOverride || snapZone();
  let best = null, bestDist = SNAP;

  for (let row = 0; row <= size; row++)
    for (let col = 0; col < size; col++) {
      const lx = OFFSET_X + col * CELL_SIZE, ly = OFFSET_Y + row * CELL_SIZE;
      const dy = Math.abs(my - ly);
      if (dy < bestDist && mx > lx && mx < lx + CELL_SIZE) { best = { type: 'h', row, col }; bestDist = dy; }
    }
  for (let row = 0; row < size; row++)
    for (let col = 0; col <= size; col++) {
      const lx = OFFSET_X + col * CELL_SIZE, ly = OFFSET_Y + row * CELL_SIZE;
      const dx = Math.abs(mx - lx);
      if (dx < bestDist && my > ly && my < ly + CELL_SIZE) { best = { type: 'v', row, col }; bestDist = dx; }
    }
  return best;
}

function getCellAt(mx, my) {
  if (!room) return null;
  const col = Math.floor((mx - OFFSET_X) / CELL_SIZE);
  const row = Math.floor((my - OFFSET_Y) / CELL_SIZE);
  if (row < 0 || row >= room.size || col < 0 || col >= room.size) return null;
  if (room.grid[row * room.size + col].owner) return null;
  return { row, col };
}

function getMyColor() {
  return room?.players.find(p => p.id === myId)?.color || '#c0392b';
}

// ---- Game Over ----
function showGameOver() {
  if (!room) return;
  document.getElementById('gameOverModal').style.display = 'flex';
  stopPulse();
  const winner = room.winner ? room.players.find(p => p.id === room.winner) : null;
  if (winner?.id === myId) SFX.win();
  else if (winner) SFX.lose();
  document.getElementById('modalIcon').textContent  = winner ? '🏆' : '🤝';
  document.getElementById('modalTitle').textContent = winner ? `${winner.name} heerst de stad!` : 'Gelijkspel.';
  const p1 = room.players[0], p2 = room.players[1];
  const loc = (id) => room.grid.filter(c => c.isKeyLocation && c.owner === id).length;
  document.getElementById('modalScores').innerHTML = `
    <div class="score-row" style="color:${p1?.color}">${p1?.name}: ${loc(p1?.id)} / 5 banken</div>
    ${p2 ? `<div class="score-row" style="color:${p2.color}">${p2.name}: ${loc(p2?.id)} / 5 banken</div>` : ''}
  `;
}

document.getElementById('rematchBtn').addEventListener('click', () => {
  socket.emit('request-rematch', { roomId });
  document.getElementById('rematchStatus').textContent = 'Wachten op tegenstander...';
});

document.getElementById('copyLink').addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.origin + `/room/${roomId}`)
    .then(() => showToast('🔗 Link gekopieerd.', 'info'));
});

// ---- Log ----
let prevGrid = null;
function updateLog(newRoom) {
  if (!prevGrid || !newRoom) { prevGrid = newRoom?.grid ? [...newRoom.grid] : null; return; }
  const entries = document.getElementById('logEntries');
  for (let i = 0; i < newRoom.grid.length; i++) {
    const old = prevGrid[i], cur = newRoom.grid[i];
    if (!old?.owner && cur?.owner) {
      const owner = newRoom.players.find(p => p.id === cur.owner);
      const entry = document.createElement('div');
      if (cur.isKeyLocation) {
        entry.className = 'log-entry log-key';
        entry.innerHTML = `🏦 <span style="color:${owner?.color}">${owner?.name}</span> nam <strong>${cur.keyDef.name}</strong>`;
      } else {
        entry.className = 'log-entry';
        entry.innerHTML = `<span style="color:${owner?.color}">${owner?.name}</span> claimde blok${cur.special ? ' ' + cur.special.emoji : ''}`;
      }
      entries.prepend(entry);
      if (entries.children.length > 30) entries.lastChild.remove();
    }
  }
  prevGrid = [...newRoom.grid];
}

// ---- Toast & Hint ----
function showToast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3000);
}

function setHint(text, type) {
  const el = document.getElementById('actionHint');
  el.textContent = text;
  el.className = `action-hint hint-${type}`;
}

// ---- Helpers ----
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

window.addEventListener('resize', () => { if (room && !rafId) drawBoard(); });
