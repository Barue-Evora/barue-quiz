'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const QUIZ_FILE = process.env.QUIZ_FILE || path.join(__dirname, 'data', 'sample-quiz.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'games-snapshot.json');
const MAX_TEAMS = Number(process.env.MAX_TEAMS || 50);
const BASE_POINTS = 1000;
const MAX_SPEED_BONUS = 200;
const GAME_TTL_MS = 12 * 60 * 60 * 1000;
const SUSPENSE_MS = Number(process.env.SUSPENSE_MS || 3500);
const REVEAL_MS = Number(process.env.REVEAL_MS || 8000);
const BOARD_MS = Number(process.env.BOARD_MS || 8000);
const PODIUM_MS = 10000; // keep in step with the podium animation on the big screen

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e4, pingInterval: 10000, pingTimeout: 8000 });

const games = new Map();
const socketCounts = new Map(); // teamId -> open sockets
const timers = new Map();

const token = () => crypto.randomBytes(16).toString('hex');
function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const bytes = crypto.randomBytes(4);
    const code = [...bytes].map((b) => letters[b % letters.length]).join('');
    if (!games.has(code)) return code;
  }
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}
function loadQuiz() {
  const quiz = JSON.parse(fs.readFileSync(QUIZ_FILE, 'utf8'));
  if (!quiz.questions || !quiz.questions.length) throw new Error('Quiz has no questions');
  return quiz;
}

// ---------- persistence: a restart of the process does not lose a running game ----------
let snapshotPending = false;
function saveSoon() {
  if (snapshotPending) return;
  snapshotPending = true;
  setTimeout(() => {
    snapshotPending = false;
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    fs.writeFile(tmp, JSON.stringify([...games.values()]), (err) => {
      if (err) return console.error('snapshot failed', err);
      fs.rename(tmp, SNAPSHOT_FILE, (e) => e && console.error('snapshot rename failed', e));
    });
  }, 500);
}
function restore() {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return;
    for (const g of JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'))) {
      if (Date.now() - g.createdAt > GAME_TTL_MS) continue;
      games.set(g.code, g);
      if (g.phase === 'locked' || g.phase === 'suspense') reveal(g);
      else if (g.phase === 'question') {
        const left = g.endsAt - Date.now();
        if (left <= 0) lock(g);
        else timers.set(g.code, setTimeout(() => lock(g), left));
      } else scheduleStage(g);
    }
    console.log(`restored ${games.size} game(s)`);
  } catch (e) {
    console.error('could not restore snapshot', e);
  }
}

// ---------- game logic ----------
const currentQuestion = (g) => g.quiz.questions[g.qIndex] || null;
const teamsArray = (g) => Object.values(g.teams);
const connectedTeams = (g) => teamsArray(g).filter((t) => (socketCounts.get(t.id) || 0) > 0);
const answersFor = (g) => g.answers[g.qIndex] || {};

function ranking(g) {
  const sorted = teamsArray(g).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'pt'));
  let rank = 0, last = null;
  return sorted.map((t, i) => {
    if (t.score !== last) { rank = i + 1; last = t.score; }
    return { id: t.id, name: t.name, score: t.score, rank, connected: (socketCounts.get(t.id) || 0) > 0 };
  });
}
// The game runs itself: question -> suspense -> reveal -> leaderboard -> next question.
// A pause holds the game on the reveal or leaderboard until the host resumes or skips.
const isLast = (g) => g.qIndex >= g.quiz.questions.length - 1;
function clearStage(g) {
  clearTimeout(timers.get(g.code));
  g.autoAt = null;
}
function scheduleStage(g) {
  clearStage(g);
  const ms = { suspense: SUSPENSE_MS, reveal: REVEAL_MS, leaderboard: BOARD_MS }[g.phase];
  if (!ms || (g.paused && g.phase !== 'suspense')) return;
  g.autoAt = Date.now() + ms;
  timers.set(g.code, setTimeout(() => advance(g), ms));
}
function advance(g) {
  if (g.phase === 'suspense') return reveal(g);
  if (g.phase === 'reveal' && isLast(g)) {
    clearStage(g);
    g.phase = 'finished';
    g.finishedAt = Date.now();
    return broadcast(g);
  }
  if (g.phase === 'reveal') {
    g.phase = 'leaderboard';
    scheduleStage(g);
    return broadcast(g);
  }
  if (g.phase === 'leaderboard') startQuestion(g, g.qIndex + 1);
}
// Timer ran out, every connected team answered, or the host ended the question early.
function lock(g) {
  if (g.phase !== 'question') return;
  g.endsAt = null;
  g.phase = 'suspense';
  scheduleStage(g);
  broadcast(g);
}
function everyoneAnswered(g) {
  const connected = connectedTeams(g);
  const answers = answersFor(g);
  return g.phase === 'question' && connected.length > 0 && connected.every((t) => answers[t.id]);
}
function reveal(g) {
  const q = currentQuestion(g);
  const counts = q.options.map(() => 0);
  for (const a of Object.values(answersFor(g))) {
    counts[a.choice]++;
    const team = g.teams[a.teamId];
    a.points = a.choice === q.correct ? BASE_POINTS + Math.round(MAX_SPEED_BONUS * a.timeLeftRatio) : 0;
    if (team) team.score += a.points;
  }
  g.revealCounts = counts;
  g.phase = 'reveal';
  scheduleStage(g);
  broadcast(g);
}
function startQuestion(g, index) {
  g.qIndex = index;
  g.answers[index] = {};
  g.revealCounts = null;
  const ms = (currentQuestion(g).timeLimit || 20) * 1000;
  g.phase = 'question';
  g.startedAt = Date.now();
  g.endsAt = g.startedAt + ms;
  clearStage(g);
  timers.set(g.code, setTimeout(() => lock(g), ms));
  broadcast(g);
}
function answer(g, team, qIndex, choice) {
  if (g.phase !== 'question' || qIndex !== g.qIndex) return 'A resposta já fechou.';
  const q = currentQuestion(g);
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return 'Resposta inválida.';
  const answers = answersFor(g);
  if (answers[team.id]) return 'A tua equipa já respondeu.';
  const now = Date.now();
  if (now >= g.endsAt) return 'A resposta já fechou.';
  answers[team.id] = {
    teamId: team.id, choice, timeLeftRatio: (g.endsAt - now) / (g.endsAt - g.startedAt), points: 0,
  };
  saveSoon();
  if (everyoneAnswered(g)) lock(g);
  else progressSoon(g);
  return null;
}

// ---------- what each screen may see (the correct answer stays on the server until reveal) ----------
function publicView(g) {
  const q = currentQuestion(g);
  const showQ = q && ['question', 'suspense', 'reveal'].includes(g.phase);
  const revealed = g.phase === 'reveal';
  return {
    code: g.code, phase: g.phase, title: g.quiz.title,
    qIndex: g.qIndex, qTotal: g.quiz.questions.length,
    question: showQ ? { text: q.text, options: q.options } : null,
    remainingMs: g.phase === 'question' ? Math.max(0, g.endsAt - Date.now()) : 0,
    totalMs: g.phase === 'question' ? g.endsAt - g.startedAt : 0,
    autoMs: g.autoAt ? Math.max(0, g.autoAt - Date.now()) : null,
    paused: !!g.paused,
    podiumMs: g.phase === 'finished' ? Math.max(0, g.finishedAt + PODIUM_MS - Date.now()) : 0,
    answered: Object.keys(answersFor(g)).length,
    teamCount: teamsArray(g).length, maxTeams: MAX_TEAMS,
    teams: teamsArray(g).map((t) => t.name),
    correct: revealed ? q.correct : null,
    counts: revealed ? g.revealCounts : null,
    ranking: ['leaderboard', 'finished'].includes(g.phase) ? ranking(g) : null,
  };
}
function teamView(g, team) {
  const base = publicView(g);
  const mine = answersFor(g)[team.id];
  const rank = ranking(g).find((r) => r.id === team.id);
  return {
    ...base, teams: undefined, ranking: undefined, counts: undefined,
    team: { name: team.name, score: team.score, rank: rank && rank.rank },
    myChoice: mine ? mine.choice : null,
    lastPoints: g.phase === 'reveal' && mine ? mine.points : null,
  };
}
function hostView(g) {
  const v = publicView(g);
  const q = currentQuestion(g);
  return {
    ...v,
    hostCorrect: q ? q.correct : null,
    roster: ranking(g),
    connected: connectedTeams(g).length,
  };
}
function broadcast(g) {
  saveSoon();
  io.to(`${g.code}:screen`).emit('state', publicView(g));
  io.to(`${g.code}:host`).emit('state', hostView(g));
  for (const t of teamsArray(g)) io.to(`team:${t.id}`).emit('state', teamView(g, t));
}
const progressTimers = new Map();
function progressSoon(g) {
  if (progressTimers.has(g.code)) return;
  progressTimers.set(g.code, setTimeout(() => {
    progressTimers.delete(g.code);
    const p = { answered: Object.keys(answersFor(g)).length, connected: connectedTeams(g).length };
    io.to(`${g.code}:screen`).to(`${g.code}:host`).emit('progress', p);
  }, 250));
}

// ---------- pages and HTTP API ----------
app.get('/health', (_req, res) => res.json({ ok: true, games: games.size }));
app.get('/j/:code', (req, res) => res.redirect(`/play?code=${encodeURIComponent(req.params.code.toUpperCase())}`));
app.post('/api/games', (req, res) => {
  if (ADMIN_PIN && !safeEqual((req.body || {}).pin || '', ADMIN_PIN)) {
    return res.status(403).json({ error: 'PIN incorreto.' });
  }
  const g = {
    code: newCode(), hostToken: token(), createdAt: Date.now(), quiz: loadQuiz(),
    phase: 'lobby', qIndex: -1, teams: {}, answers: {}, revealCounts: null, startedAt: null, endsAt: null,
  };
  games.set(g.code, g);
  saveSoon();
  res.json({ code: g.code, hostToken: g.hostToken });
});
app.get('/qr/:code.svg', async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!games.has(code)) return res.sendStatus(404);
  const url = `${req.protocol}://${req.get('host')}/j/${code}`;
  res.type('image/svg+xml').send(await QRCode.toString(url, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#12372AFF', light: '#F6EFE0FF' },
  }));
});

// ---------- real-time ----------
const fail = (ack, error) => typeof ack === 'function' && ack({ ok: false, error });
const done = (ack, extra) => typeof ack === 'function' && ack({ ok: true, ...extra });

function attachTeam(socket, g, team) {
  socket.data.team = team.id;
  socket.join(`team:${team.id}`);
  socketCounts.set(team.id, (socketCounts.get(team.id) || 0) + 1);
}
function releaseTeam(socket) {
  const id = socket.data.team;
  if (!id) return;
  socketCounts.set(id, Math.max(0, (socketCounts.get(id) || 1) - 1));
  socket.data.team = null;
}

io.on('connection', (socket) => {
  socket.on('hello', ({ role, code, hostToken, teamToken } = {}, ack) => {
    const g = games.get(String(code || '').toUpperCase());
    if (!g) return fail(ack, 'Jogo não encontrado.');
    socket.data.code = g.code;
    if (role === 'host') {
      if (!hostToken || !safeEqual(hostToken, g.hostToken)) return fail(ack, 'Sem permissão.');
      socket.data.host = true;
      socket.join(`${g.code}:host`);
      return done(ack, { state: hostView(g) });
    }
    if (role === 'screen') {
      socket.join(`${g.code}:screen`);
      return done(ack, { state: publicView(g) });
    }
    const team = teamToken && teamsArray(g).find((t) => safeEqual(t.token, teamToken));
    if (team) {
      attachTeam(socket, g, team);
      progressSoon(g);
      return done(ack, { joined: true, state: teamView(g, team) });
    }
    return done(ack, { joined: false, teamCount: teamsArray(g).length });
  });

  socket.on('team:join', ({ name } = {}, ack) => {
    const g = games.get(socket.data.code);
    if (!g) return fail(ack, 'Jogo não encontrado.');
    if (socket.data.team) return fail(ack, 'Já estás numa equipa.');
    if (g.phase === 'finished') return fail(ack, 'Este jogo já terminou.');
    const clean = normalizeName(name);
    if (clean.length < 2) return fail(ack, 'Escolhe um nome com pelo menos 2 letras.');
    const key = clean.toLocaleLowerCase('pt');
    if (teamsArray(g).some((t) => t.name.toLocaleLowerCase('pt') === key)) return fail(ack, 'Esse nome já existe.');
    if (teamsArray(g).length >= MAX_TEAMS) return fail(ack, `O jogo está cheio (${MAX_TEAMS} equipas).`);
    const team = { id: token(), token: token(), name: clean, score: 0 };
    g.teams[team.id] = team;
    attachTeam(socket, g, team);
    broadcast(g);
    done(ack, { token: team.token, state: teamView(g, team) });
  });

  socket.on('team:answer', ({ qIndex, choice } = {}, ack) => {
    const g = games.get(socket.data.code);
    const team = g && g.teams[socket.data.team];
    if (!team) return fail(ack, 'A equipa não está ligada.');
    const error = answer(g, team, qIndex, choice);
    return error ? fail(ack, error) : done(ack, { state: teamView(g, team) });
  });

  socket.on('host:action', ({ type, teamId } = {}, ack) => {
    const g = games.get(socket.data.code);
    if (!g || !socket.data.host) return fail(ack, 'Sem permissão.');
    if (type === 'start' && g.phase === 'lobby') {
      if (!teamsArray(g).length) return fail(ack, 'Ainda não há equipas.');
      startQuestion(g, 0);
    } else if (type === 'lock' && g.phase === 'question') lock(g);
    else if (type === 'skip' && ['reveal', 'leaderboard'].includes(g.phase)) advance(g);
    else if (type === 'pause' && g.phase !== 'finished') {
      g.paused = !g.paused;
      if (['reveal', 'leaderboard'].includes(g.phase)) scheduleStage(g);
      broadcast(g);
    } else if (type === 'kick' && g.teams[teamId]) {
      io.to(`team:${teamId}`).emit('kicked');
      io.in(`team:${teamId}`).socketsLeave(`team:${teamId}`);
      for (const s of io.of('/').sockets.values()) if (s.data.team === teamId) releaseTeam(s);
      delete g.teams[teamId];
      delete answersFor(g)[teamId];
      if (everyoneAnswered(g)) lock(g);
      broadcast(g);
    } else return fail(ack, 'Essa ação não está disponível agora.');
    done(ack);
  });

  socket.on('disconnect', () => {
    const g = games.get(socket.data.code);
    const had = socket.data.team;
    releaseTeam(socket);
    if (!g || !had) return;
    progressSoon(g);
    if (everyoneAnswered(g)) lock(g);
  });
});

setInterval(() => {
  for (const [code, g] of games) if (Date.now() - g.createdAt > GAME_TTL_MS) games.delete(code);
}, 60 * 60 * 1000).unref();

restore();
server.listen(PORT, () => console.log(`Barue Quiz on :${PORT}`));
