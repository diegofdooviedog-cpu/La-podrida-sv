const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// ── Estado global de salas ──────────────────────────────────────────────────
const rooms = {};

// ── Baraja española ─────────────────────────────────────────────────────────
const SUITS = [
  { id: 'oros',    label: 'oros',    color: '#c8860a' },
  { id: 'copas',   label: 'copas',   color: '#b52828' },
  { id: 'espadas', label: 'espadas', color: '#1a3a6c' },
  { id: 'bastos',  label: 'bastos',  color: '#2d6b2d' }
];
const ROUNDS_SEQ = [1, 3, 5, 7, 11, 7, 5, 3, 1];

function buildDeck() {
  const deck = [];
  for (const s of SUITS)
    for (let v = 1; v <= 12; v++)
      deck.push({ v, suit: s, isJoker: false });
  deck.push({ v: 0, suit: null, isJoker: true, jokerColor: '#7b2d8b' });
  deck.push({ v: 0, suit: null, isJoker: true, jokerColor: '#1a6b6b' });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardRank(c) {
  if (c.isJoker) return 14;
  if (c.v === 1)  return 13;
  return c.v;
}

// ── Lógica de ronda ─────────────────────────────────────────────────────────
function startRound(roomCode) {
  const room = rooms[roomCode];
  const n  = ROUNDS_SEQ[room.roundIdx];
  const sp = room.roundIdx % room.players.length;

  room.cardsThisRound = n;
  room.startPlayer    = sp;
  room.currentPlayer  = sp;
  room.betOrder       = room.players.map((_, i) => (sp + i) % room.players.length);
  room.betStep        = 0;
  room.bets           = new Array(room.players.length).fill(null);
  room.won            = new Array(room.players.length).fill(0);
  room.handNum        = 1;
  room.tableCards     = [];
  room.phase          = 'betting';

  const deck = shuffle(buildDeck());
  room.hands = room.players.map(() => []);
  for (let i = 0; i < n; i++)
    for (let p = 0; p < room.players.length; p++)
      room.hands[(sp + p) % room.players.length].push(deck.pop());

  broadcastState(roomCode);
}

// ── Enviar estado a cada jugador (solo ve sus propias cartas) ───────────────
function broadcastState(roomCode) {
  const room = rooms[roomCode];
  room.players.forEach((player, pi) => {
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket) return;

    // Para cada jugador, las manos ajenas van ocultas
    const handsForPlayer = room.hands.map((hand, hi) =>
      hi === pi ? hand : hand.map(() => ({ hidden: true }))
    );

    socket.emit('gameState', {
      phase:          room.phase,
      roundIdx:       room.roundIdx,
      cardsThisRound: room.cardsThisRound,
      handNum:        room.handNum,
      players:        room.players.map(p => ({ name: p.name, score: p.score })),
      bets:           room.bets,
      won:            room.won,
      betOrder:       room.betOrder,
      betStep:        room.betStep,
      currentPlayer:  room.currentPlayer,
      tableCards:     room.tableCards,
      myIndex:        pi,
      myHand:         room.hands[pi],
      hands:          handsForPlayer,
      roundPoints:    room.roundPoints || null,
    });
  });
}

// ── Conexiones Socket.io ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

  // Crear sala
  socket.on('createRoom', ({ playerName }) => {
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[code] = {
      code,
      phase: 'lobby',
      players: [{ name: playerName, socketId: socket.id, score: 0 }],
      roundIdx: 0,
      hands: [], bets: [], won: [], betOrder: [],
      betStep: 0, cardsThisRound: 0, currentPlayer: 0,
      handNum: 1, tableCards: [], roundPoints: null,
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerIndex = 0;
    socket.emit('roomCreated', { code, playerIndex: 0 });
    io.to(code).emit('lobbyUpdate', { players: rooms[code].players.map(p => p.name) });
    console.log(`Sala creada: ${code}`);
  });

  // Unirse a sala
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error', 'Sala no encontrada');
    if (room.phase !== 'lobby') return socket.emit('error', 'El juego ya comenzó');
    if (room.players.length >= 4) return socket.emit('error', 'Sala llena (máx 4)');

    const idx = room.players.length;
    room.players.push({ name: playerName, socketId: socket.id, score: 0 });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerIndex = idx;
    socket.emit('roomJoined', { code: roomCode, playerIndex: idx });
    io.to(roomCode).emit('lobbyUpdate', { players: room.players.map(p => p.name) });
  });

  // Iniciar juego (solo el host, jugador 0)
  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.playerIndex !== 0) return;
    if (room.players.length < 2) return socket.emit('error', 'Se necesitan al menos 2 jugadores');
    room.phase = 'playing';
    room.roundIdx = 0;
    room.players.forEach(p => p.score = 0);
    startRound(socket.roomCode);
  });

  // Apostar
  socket.on('placeBet', ({ bet }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'playing') return;
    const pi = room.betOrder[room.betStep];
    if (socket.playerIndex !== pi) return;

    // Validar apuesta prohibida (último jugador)
    if (room.betStep === room.players.length - 1) {
      const sumSoFar = room.bets.reduce((s, b) => s + (b ?? 0), 0);
      const forbidden = room.cardsThisRound - sumSoFar;
      if (bet === forbidden) return socket.emit('error', `No puedes apostar ${forbidden}`);
    }

    room.bets[pi] = bet;
    room.betStep++;

    if (room.betStep >= room.players.length) {
      room.phase = 'playing';
      broadcastState(socket.roomCode);
    } else {
      broadcastState(socket.roomCode);
    }
  });

  // Jugar carta
  socket.on('playCard', ({ cardIndex }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    if (socket.playerIndex !== room.currentPlayer) return;
    if (room.tableCards.some(e => e.player === socket.playerIndex)) return;

    const card = room.hands[socket.playerIndex][cardIndex];
    if (!card) return;

    room.hands[socket.playerIndex].splice(cardIndex, 1);
    room.tableCards.push({ player: socket.playerIndex, card, order: room.tableCards.length });

    if (room.tableCards.length === room.players.length) {
      resolveHand(socket.roomCode);
    } else {
      room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
      broadcastState(socket.roomCode);
    }
  });

  // Resolver mano
  function resolveHand(roomCode) {
    const room = rooms[roomCode];
    let best = room.tableCards[0];
    for (let i = 1; i < room.tableCards.length; i++) {
      const e = room.tableCards[i];
      const br = cardRank(best.card), er = cardRank(e.card);
      if (er > br || (er === br && e.order < best.order)) best = e;
    }
    room.won[best.player]++;
    io.to(roomCode).emit('handResult', { winner: best.player, winnerName: room.players[best.player].name });

    setTimeout(() => {
      room.handNum++;
      room.tableCards = [];
      if (room.handNum > room.cardsThisRound) {
        endRound(roomCode);
      } else {
        room.currentPlayer = best.player;
        broadcastState(roomCode);
      }
    }, 2000);
  }

  // Fin de ronda
  function endRound(roomCode) {
    const room = rooms[roomCode];
    room.roundPoints = room.players.map((pl, pi) => {
      const pts = room.bets[pi] === room.won[pi] ? 5 + room.won[pi] : 0;
      pl.score += pts;
      return pts;
    });
    room.phase = 'roundEnd';
    broadcastState(roomCode);
  }

  // Siguiente ronda
  socket.on('nextRound', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.playerIndex !== 0) return;
    room.roundIdx++;
    if (room.roundIdx >= ROUNDS_SEQ.length) {
      room.phase = 'gameOver';
      broadcastState(socket.roomCode);
    } else {
      room.phase = 'playing';
      startRound(socket.roomCode);
    }
  });

  // Desconexión
  socket.on('disconnect', () => {
    console.log('Desconectado:', socket.id);
    const room = rooms[socket.roomCode];
    if (room) {
      io.to(socket.roomCode).emit('playerDisconnected', {
        name: room.players[socket.playerIndex]?.name
      });
    }
  });
});

app.get('/', (req, res) => res.send('La Podrida — servidor activo'));

server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
