const app = document.getElementById('app');
const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
const socket = io({ transports: ['websocket', 'polling'] });
let state = null;
// Small synthesized sounds. Browsers only allow audio after the "Ecrã inteiro e som" click.
const sound = {
  ctx: null, played: '',
  unlock() { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this.ctx.resume(); } catch {} },
  beep(at, freq, len, vol = 0.12, type = 'triangle') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + at, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + len);
  },
  once(key, fn) { if (this.played !== key) { this.played = key; fn(); } },
  suspense() { this.once('s' + state.qIndex, () => { for (let i = 0; i < 26; i++) this.beep(i * (3.3 / 26), 110 + i * 9, 0.09, 0.05 + i * 0.004, 'square'); }); },
  reveal() { this.once('r' + state.qIndex, () => [523, 659, 784].forEach((f, i) => this.beep(i * 0.09, f, 0.5))); },
  podium() { this.once('p', () => [[1, 392], [3.5, 523], [6.5, 523], [6.65, 659], [6.8, 784], [6.95, 1047]].forEach(([at, f]) => this.beep(at, f, 0.8, 0.16))); },
};
const topBar = (right) => h('header', null, brand(), right);
function lobby() {
  app.replaceChildren(topBar(h('span', { class: 'muted' }, `${state.teamCount} / ${state.maxTeams} equipas`)),
    h('div', { class: 'lobby' },
      h('div', { class: 'join' }, h('img', { src: `/qr/${code}.svg`, alt: 'Código QR para entrar no jogo' }), h('div', { class: 'muted', style: 'font-size:3vh' }, 'Lê o código QR para jogar'), h('div', { class: 'code' }, code)),
      h('div', { class: 'names' }, state.teams.map((n) => h('span', null, n)))));
}
function question() {
  const revealed = state.phase === 'reveal';
  const suspense = state.phase === 'suspense';
  const timer = h('span', { class: 'timer' }, '');
  const count = h('span', { id: 'count' }, `${state.answered} / ${state.teamCount} responderam`);
  app.replaceChildren(topBar(h('span', { class: 'muted' }, `Pergunta ${state.qIndex + 1} de ${state.qTotal}`)),
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;font-size:3vh' }, count, timer),
    h('div', { class: 'sq' }, suspense ? 'E a resposta certa é…' : state.question.text),
    h('div', { class: `sopts ${suspense ? 'scan' : ''}` }, state.question.options.map((t, i) =>
      h('div', { class: `opt${i} ${revealed ? (i === state.correct ? 'right' : 'wrong') : ''}`, style: `--i:${i}` }, h('span', { class: 'letter' }, LETTERS[i]), h('span', null, t),
        revealed ? h('span', { class: 'n' }, String(state.counts[i])) : null))));
  if (suspense) { timer.textContent = ''; count.textContent = `${state.answered} / ${state.teamCount} responderam`; sound.suspense(); }
  if (revealed) { timer.textContent = state.paused ? 'Em pausa' : ''; sound.reveal(); }
  countdown(state, (left) => { timer.textContent = Math.ceil(left / 1000) + 's'; });
}
function board(title) {
  const rows = state.ranking.slice(0, 10);
  const next = h('div', { class: 'muted', style: 'font-size:2.6vh' }, 'Em pausa');
  clearInterval(window._cd);
  if (!state.paused) {
    const end = performance.now() + (state.autoMs || 0);
    const tick = () => { next.textContent = `Próxima pergunta dentro de ${Math.max(0, Math.ceil((end - performance.now()) / 1000))} s`; };
    tick(); window._cd = setInterval(tick, 250);
  }
  app.replaceChildren(topBar(h('span', { class: 'muted' }, title)),
    next,
    h('div', { class: 'board' }, rows.map((r) => h('div', null, h('span', null, r.rank + '.º'), h('span', { class: 'name' }, r.name), h('span', null, fmt(r.score))))));
}
function podium() {
  const [first, second, third] = state.ranking;
  const step = (team, place, cls, delay) => team ? h('div', { class: `step ${cls}`, style: `--d:${delay}s` },
    h('div', { class: 'who' }, h('div', { class: 'name' }, team.name), h('div', null, fmt(team.score) + ' pts')),
    h('div', { class: 'block' }, place + '.º')) : h('div', null);
  const confetti = Array.from({ length: 60 }, (_, i) => h('i', {
    class: `opt${i % 4}`, style: `left:${(i * 37) % 100}%;--c:${6.5 + (i % 12) / 8}s;--f:${2.5 + (i % 5) / 2}s`,
  }));
  app.replaceChildren(topBar(h('span', { class: 'muted' }, 'Pódio')),
    h('div', { class: 'podium' }, step(second, 2, 'second', 3.5), step(first, 1, 'first', 6.5), step(third, 3, 'third', 1)),
    h('div', { class: 'confetti', 'aria-hidden': 'true' }, confetti));
  sound.podium();
}
let shown = '';
function render() {
  const key = state.phase + state.qIndex;
  if (key === shown && !['lobby', 'question', 'leaderboard', 'reveal'].includes(state.phase)) return;
  shown = key;
  if (state.phase === 'lobby') lobby();
  else if (['question', 'suspense', 'reveal'].includes(state.phase)) question();
  else if (state.phase === 'finished') podium();
  else board('Classificação');
}
socket.on('connect', () => socket.emit('hello', { role: 'screen', code }, (r) => {
  if (!r.ok) { app.replaceChildren(h('h1', null, r.error)); return; }
  state = r.state; render();
}));
socket.on('state', (s) => { state = s; render(); });
socket.on('progress', (p) => {
  if (!state) return;
  state.answered = p.answered;
  const el = document.getElementById('count');
  if (el) el.textContent = `${p.answered} / ${state.teamCount} responderam`;
});
document.getElementById('fs').addEventListener('click', (e) => { document.documentElement.requestFullscreen?.(); sound.unlock(); e.target.remove(); });
