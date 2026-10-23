const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const htmlPath = path.join(__dirname, 'Grandmaster Chess 3D.html');
const stockfishDir = path.join(__dirname, 'vendor', 'stockfish');
const engineAssets = new Map([
  ['/vendor/stockfish/stockfish-19-lite-single.js', {
    path: path.join(stockfishDir, 'stockfish-19-lite-single.js'),
    type: 'text/javascript; charset=utf-8'
  }],
  ['/vendor/stockfish/stockfish-19-lite-single.wasm', {
    path: path.join(stockfishDir, 'stockfish-19-lite-single.wasm'),
    type: 'application/wasm'
  }],
  ['/vendor/stockfish/Copying.txt', {
    path: path.join(stockfishDir, 'Copying.txt'),
    type: 'text/plain; charset=utf-8'
  }]
]);
const dataDir = process.env.CHESS_DATA_DIR || path.join(__dirname, 'data');
const profilesPath = path.join(dataDir, 'profiles.json');
fs.mkdirSync(dataDir, { recursive: true });
const profiles = fs.existsSync(profilesPath)
  ? JSON.parse(fs.readFileSync(profilesPath, 'utf8'))
  : {};
const streams = new Map();
const games = new Map();
const rooms = new Map();
let waitingPlayer = null;

const initialState = () => {
  const board = Array(64).fill(null);
  const backRank = 'RNBQKBNR';
  for (let file = 0; file < 8; file++) {
    board[file] = `b${backRank[file]}`;
    board[8 + file] = 'bP';
    board[48 + file] = 'wP';
    board[56 + file] = `w${backRank[file]}`;
  }
  return { board, turn: 'w', castle: { wK: true, wQ: true, bK: true, bQ: true }, ep: -1 };
};

const knightMoves = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const kingMoves = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function pseudoMoves(state, from, castling = true) {
  const board = state.board;
  const piece = board[from];
  if (!piece) return [];
  const color = piece[0];
  const type = piece[1];
  const row = from >> 3;
  const col = from & 7;
  const moves = [];
  const add = (r, c) => {
    if (r < 0 || r > 7 || c < 0 || c > 7) return false;
    const target = board[r * 8 + c];
    if (!target) {
      moves.push(r * 8 + c);
      return true;
    }
    if (target[0] !== color) moves.push(r * 8 + c);
    return false;
  };

  if (type === 'P') {
    const direction = color === 'w' ? -1 : 1;
    const startRow = color === 'w' ? 6 : 1;
    if (row + direction >= 0 && row + direction < 8 && !board[(row + direction) * 8 + col]) {
      moves.push((row + direction) * 8 + col);
      if (row === startRow && !board[(row + 2 * direction) * 8 + col]) {
        moves.push((row + 2 * direction) * 8 + col);
      }
    }
    for (const dc of [-1, 1]) {
      const targetRow = row + direction;
      const targetCol = col + dc;
      if (targetCol < 0 || targetCol > 7 || targetRow < 0 || targetRow > 7) continue;
      const target = targetRow * 8 + targetCol;
      if ((board[target] && board[target][0] !== color) || target === state.ep) moves.push(target);
    }
  } else if (type === 'N') {
    knightMoves.forEach(([dr, dc]) => add(row + dr, col + dc));
  } else if (type === 'K') {
    kingMoves.forEach(([dr, dc]) => add(row + dr, col + dc));
    if (castling && row === (color === 'w' ? 7 : 0) && col === 4) {
      const opponent = color === 'w' ? 'b' : 'w';
      const base = row * 8;
      if (state.castle[`${color}K`] && board[base + 7] === `${color}R`
          && !board[base + 5] && !board[base + 6]
          && !isAttacked(state, base + 4, opponent)
          && !isAttacked(state, base + 5, opponent)
          && !isAttacked(state, base + 6, opponent)) moves.push(base + 6);
      if (state.castle[`${color}Q`] && board[base] === `${color}R`
          && !board[base + 1] && !board[base + 2] && !board[base + 3]
          && !isAttacked(state, base + 4, opponent)
          && !isAttacked(state, base + 3, opponent)
          && !isAttacked(state, base + 2, opponent)) moves.push(base + 2);
    }
  } else {
    const directions = type === 'R' ? kingMoves.slice(0, 4) : type === 'B' ? kingMoves.slice(4) : kingMoves;
    for (const [dr, dc] of directions) {
      let r = row + dr;
      let c = col + dc;
      while (add(r, c)) {
        r += dr;
        c += dc;
      }
    }
  }
  return moves;
}

function isAttacked(state, square, byColor) {
  for (let from = 0; from < 64; from++) {
    const piece = state.board[from];
    if (!piece || piece[0] !== byColor) continue;
    if (piece[1] === 'P') {
      const direction = byColor === 'w' ? -1 : 1;
      if ((from >> 3) + direction === (square >> 3)
          && Math.abs((from & 7) - (square & 7)) === 1) return true;
    } else if (pseudoMoves(state, from, false).includes(square)) {
      return true;
    }
  }
  return false;
}

function applyMove(state, from, to) {
  const next = {
    board: state.board.slice(),
    turn: state.turn === 'w' ? 'b' : 'w',
    castle: { ...state.castle },
    ep: -1
  };
  const piece = next.board[from];
  const color = piece[0];
  if (piece[1] === 'P' && to === state.ep && !state.board[to]) {
    next.board[(from >> 3) * 8 + (to & 7)] = null;
  }
  if (piece[1] === 'K' && Math.abs((to & 7) - (from & 7)) === 2) {
    const base = (from >> 3) * 8;
    if ((to & 7) === 6) {
      next.board[base + 5] = next.board[base + 7];
      next.board[base + 7] = null;
    } else {
      next.board[base + 3] = next.board[base];
      next.board[base] = null;
    }
  }
  if (piece[1] === 'P' && Math.abs(to - from) === 16) next.ep = (from + to) / 2;
  next.board[to] = piece;
  next.board[from] = null;
  if (piece[1] === 'P' && (to >> 3 === 0 || to >> 3 === 7)) next.board[to] = `${color}Q`;
  if (piece[1] === 'K') {
    next.castle[`${color}K`] = false;
    next.castle[`${color}Q`] = false;
  }
  for (const square of [from, to]) {
    if (square === 63) next.castle.wK = false;
    if (square === 56) next.castle.wQ = false;
    if (square === 7) next.castle.bK = false;
    if (square === 0) next.castle.bQ = false;
  }
  return next;
}

function inCheck(state, color) {
  const king = state.board.indexOf(`${color}K`);
  return king >= 0 && isAttacked(state, king, color === 'w' ? 'b' : 'w');
}

function legalMoves(state, from) {
  const piece = state.board[from];
  if (!piece || piece[0] !== state.turn) return [];
  return pseudoMoves(state, from).filter(to => !inCheck(applyMove(state, from, to), piece[0]));
}

function hasLegalMove(state) {
  return state.board.some((piece, from) => piece && piece[0] === state.turn && legalMoves(state, from).length > 0);
}

function send(playerId, event, data) {
  const clients = streams.get(playerId);
  if (!clients) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of clients) response.write(message);
}

function opponentId(game, playerId) {
  return game.players.w === playerId ? game.players.b : game.players.w;
}

function gameForPlayer(playerId) {
  for (const game of games.values()) {
    if (!game.finished && Object.values(game.players).includes(playerId)) return game;
  }
  return null;
}

function matchPlayers(firstId, secondId, roomCode = null) {
  const game = {
    id: crypto.randomUUID(),
    roomCode,
    players: { w: firstId, b: secondId },
    state: initialState(),
    moves: [],
    finished: false
  };
  games.set(game.id, game);
  for (const [color, playerId] of Object.entries(game.players)) {
    const other = game.players[color === 'w' ? 'b' : 'w'];
    send(playerId, 'matched', {
      gameId: game.id,
      color,
      opponent: publicProfile(profiles[other]),
      moves: [],
      roomCode
    });
  }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function publicProfile(profile) {
  const { tokenHash, ...visible } = profile;
  return visible;
}

function hasValidToken(playerId, token) {
  const profile = profiles[playerId];
  if (!profile || typeof token !== 'string') return false;
  const suppliedHash = crypto.createHash('sha256').update(token).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(profile.tokenHash, 'hex'), Buffer.from(suppliedHash, 'hex'));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw Object.assign(new Error('Request body is too large'), { status: 413 });
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 });
  }
}

function saveProfiles() {
  const tempPath = `${profilesPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(profiles, null, 2), 'utf8');
  fs.renameSync(tempPath, profilesPath);
}

function removeFromQueue(playerId) {
  if (waitingPlayer === playerId) waitingPlayer = null;
}

function roomHostedBy(playerId) {
  for (const [code, room] of rooms) {
    if (room.hostId === playerId) return code;
  }
  return null;
}

function removeHostedRoom(playerId) {
  const code = roomHostedBy(playerId);
  if (!code) return;
  rooms.delete(code);
  send(playerId, 'roomCancelled', { code });
}

function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), byte => alphabet[byte % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json(response, 200, { status: 'ok' });
    }

    const engineAsset = request.method === 'GET' && engineAssets.get(url.pathname);
    if (engineAsset) {
      if (!fs.existsSync(engineAsset.path)) return json(response, 404, { error: 'Chess engine asset not found' });
      response.writeHead(200, {
        'Content-Type': engineAsset.type,
        'Cache-Control': 'public, max-age=31536000, immutable'
      });
      fs.createReadStream(engineAsset.path).pipe(response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      const playerId = url.searchParams.get('playerId');
      if (!hasValidToken(playerId, url.searchParams.get('token'))) return json(response, 401, { error: 'Player authentication failed' });
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      response.write('retry: 2000\n\n');
      const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 25_000);
      heartbeat.unref();
      if (!streams.has(playerId)) streams.set(playerId, new Set());
      streams.get(playerId).add(response);
      response.write(`event: connected\ndata: {}\n\n`);
      const activeGame = gameForPlayer(playerId);
      if (activeGame) {
        const color = activeGame.players.w === playerId ? 'w' : 'b';
        const opponent = publicProfile(profiles[opponentId(activeGame, playerId)]);
        response.write(`event: matched\ndata: ${JSON.stringify({
          gameId: activeGame.id, color, opponent, moves: activeGame.moves, roomCode: activeGame.roomCode
        })}\n\n`);
      } else if (waitingPlayer === playerId) {
        response.write('event: searching\ndata: {}\n\n');
      } else {
        const code = roomHostedBy(playerId);
        if (code) response.write(`event: roomWaiting\ndata: ${JSON.stringify({ code })}\n\n`);
      }
      response.on('close', () => {
        clearInterval(heartbeat);
        const clients = streams.get(playerId);
        clients?.delete(response);
        if (!clients?.size) {
          streams.delete(playerId);
          removeFromQueue(playerId);
          removeHostedRoom(playerId);
        }
      });
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/profile/')) {
      const playerId = decodeURIComponent(url.pathname.slice('/api/profile/'.length));
      if (!hasValidToken(playerId, url.searchParams.get('token'))) return json(response, 401, { error: 'Player authentication failed' });
      return json(response, 200, publicProfile(profiles[playerId]));
    }

    if (request.method === 'POST' && url.pathname === '/api/profile') {
      const body = await readJson(request);
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (displayName.length < 2 || displayName.length > 40) {
        return json(response, 400, { error: 'Display name must be 2 to 40 characters long' });
      }
      if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
        return json(response, 400, { error: 'Username must be 3 to 16 characters using letters, numbers, or underscores' });
      }
      if (Object.values(profiles).some(profile => profile.username.toLowerCase() === username.toLowerCase())) {
        return json(response, 409, { error: 'That username is already taken' });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const profile = {
        id: crypto.randomUUID(),
        displayName,
        username,
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        createdAt: new Date().toISOString()
      };
      profiles[profile.id] = profile;
      saveProfiles();
      return json(response, 201, { ...publicProfile(profile), token });
    }

    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readJson(request);
      const playerId = body.playerId;
      if (!hasValidToken(playerId, body.token)) return json(response, 401, { error: 'Player authentication failed' });
      if (!streams.get(playerId)?.size) return json(response, 409, { error: 'Connect to the online service before creating or joining a room' });
      if (gameForPlayer(playerId)) return json(response, 409, { error: 'You are already in an online game' });

      if (body.action === 'create') {
        removeFromQueue(playerId);
        const existingCode = roomHostedBy(playerId);
        if (existingCode) return json(response, 200, { status: 'waiting', code: existingCode });
        const code = createRoomCode();
        rooms.set(code, { hostId: playerId, createdAt: Date.now() });
        send(playerId, 'roomWaiting', { code });
        return json(response, 201, { status: 'waiting', code });
      }

      if (body.action === 'cancel') {
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : roomHostedBy(playerId);
        const waitingRoom = rooms.get(code);
        if (waitingRoom?.hostId === playerId) {
          rooms.delete(code);
          send(playerId, 'roomCancelled', { code });
        }
        return json(response, 200, { status: 'cancelled' });
      }

      if (body.action !== 'join') return json(response, 400, { error: 'Unknown room action' });
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      const waitingRoom = rooms.get(code);
      if (!waitingRoom) return json(response, 404, { error: 'Room not found. Check the code or ask the host to create a new room.' });
      if (waitingRoom.hostId === playerId) return json(response, 409, { error: 'You cannot join your own room. Share the code with a friend.' });
      if (!streams.get(waitingRoom.hostId)?.size) {
        rooms.delete(code);
        return json(response, 410, { error: 'The host disconnected. Ask them to create a new room.' });
      }
      removeFromQueue(playerId);
      removeHostedRoom(playerId);
      rooms.delete(code);
      matchPlayers(waitingRoom.hostId, playerId, code);
      return json(response, 200, { status: 'matched', code });
    }

    if (request.method === 'POST' && url.pathname === '/api/matchmaking') {
      const body = await readJson(request);
      const playerId = body.playerId;
      if (!hasValidToken(playerId, body.token)) return json(response, 401, { error: 'Player authentication failed' });
      if (!streams.get(playerId)?.size) return json(response, 409, { error: 'Connect to the online service before matchmaking' });
      if (gameForPlayer(playerId)) return json(response, 200, { status: 'in_game' });
      if (body.action === 'cancel') {
        removeFromQueue(playerId);
        send(playerId, 'cancelled', {});
        return json(response, 200, { status: 'cancelled' });
      }
      if (body.action !== 'join') return json(response, 400, { error: 'Unknown matchmaking action' });
      if (waitingPlayer === playerId) return json(response, 200, { status: 'searching' });
      if (roomHostedBy(playerId)) return json(response, 409, { error: 'Cancel your hosted room before entering quick matchmaking' });
      if (waitingPlayer && streams.get(waitingPlayer)?.size) {
        const opponentId = waitingPlayer;
        waitingPlayer = null;
        matchPlayers(opponentId, playerId);
        return json(response, 200, { status: 'matched' });
      }
      waitingPlayer = playerId;
      send(playerId, 'searching', {});
      return json(response, 200, { status: 'searching' });
    }

    const moveMatch = url.pathname.match(/^\/api\/games\/([a-f0-9-]+)\/move$/);
    if (request.method === 'POST' && moveMatch) {
      const body = await readJson(request);
      const playerId = body.playerId;
      if (!hasValidToken(playerId, body.token)) return json(response, 401, { error: 'Player authentication failed' });
      const game = games.get(moveMatch[1]);
      if (!game || game.finished) return json(response, 404, { error: 'Game is no longer active' });
      const color = game.players.w === playerId ? 'w' : game.players.b === playerId ? 'b' : null;
      if (!color) return json(response, 403, { error: 'You are not a player in this game' });
      if (game.state.turn !== color) return json(response, 409, { error: 'It is not your turn' });
      const { from, to } = body;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 63 || to < 0 || to > 63
          || !legalMoves(game.state, from).includes(to)) {
        return json(response, 400, { error: 'That move is not legal' });
      }
      game.state = applyMove(game.state, from, to);
      game.moves.push({ from, to });
      const move = { from, to };
      send(opponentId(game, playerId), 'move', move);
      const canMove = hasLegalMove(game.state);
      if (!canMove) {
        game.finished = true;
        const checked = inCheck(game.state, game.state.turn);
        const winner = color;
        const result = { winner, reason: checked ? 'checkmate' : 'stalemate' };
        for (const player of Object.values(game.players)) send(player, 'gameover', result);
      }
      return json(response, 200, { status: 'accepted' });
    }

    const resignMatch = url.pathname.match(/^\/api\/games\/([a-f0-9-]+)\/resign$/);
    if (request.method === 'POST' && resignMatch) {
      const body = await readJson(request);
      if (!hasValidToken(body.playerId, body.token)) return json(response, 401, { error: 'Player authentication failed' });
      const game = games.get(resignMatch[1]);
      if (!game || game.finished) return json(response, 404, { error: 'Game is no longer active' });
      const color = game.players.w === body.playerId ? 'w' : game.players.b === body.playerId ? 'b' : null;
      if (!color) return json(response, 403, { error: 'You are not a player in this game' });
      game.finished = true;
      const result = { winner: color === 'w' ? 'b' : 'w', reason: 'resignation' };
      for (const player of Object.values(game.players)) send(player, 'gameover', result);
      return json(response, 200, { status: 'resigned' });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/Grandmaster%20Chess%203D.html')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(response);
      return;
    }
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    json(response, error.status || 500, { error: error.status ? error.message : 'The server could not complete the request' });
    if (!error.status) console.error(error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Grandmaster Chess server listening at http://localhost:${PORT}`);
});
