const app = document.getElementById('app');
const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
const socket = io({ transports: ['websocket', 'polling'] });
let state = null;
const topBar = (right) => h('header', null, brand(), right);
function lobby() {
  app.replaceChildren(topBar(h('span', { class: 'muted' }, `${state.teamCount} / ${state.maxTeams} equipas`)),
    h('div', { class: 'lobby' },
      h('div', { class: 'join' }, h('img', { src: `/qr/${code}.svg`, alt: 'Código QR para entrar no jogo' }), h('div', { class: 'muted', style: 'font-size:3vh' }, 'Lê o código QR para jogar'), h('div', { class: 'code' }, code)),
      h('div', { class: 'names' }, state.teams.map((n) => h('span', null, n)))));
}
function question() {
  const revealed = state.phase === 'reveal';
  const timer = h('span', { class: 'timer' }, '');
  const count = h('span', { id: 'count' }, `${state.answered} / ${state.teamCount} responderam`);
  app.replaceChildren(topBar(h('span', { class: 'muted' }, `Pergunta ${state.qIndex + 1} de ${state.qTotal}`)),
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;font-size:3vh' }, count, timer),
    h('div', { class: 'sq' }, state.question.text),
    h('div', { class: 'sopts' }, state.question.options.map((t, i) =>
      h('div', { class: `opt${i} ${revealed && i !== state.correct ? 'wrong' : ''}` }, h('span', { class: 'letter' }, LETTERS[i]), h('span', null, t),
        revealed ? h('span', { class: 'n' }, String(state.counts[i])) : null))));
  if (revealed) timer.textContent = 'Tempo!';
  countdown(state, (left) => { timer.textContent = Math.ceil(left / 1000) + 's'; });
}
function board(title) {
  const rows = state.ranking.slice(0, 10);
  app.replaceChildren(topBar(h('span', { class: 'muted' }, title)),
    h('div', { class: 'board' }, rows.map((r) => h('div', null, h('span', null, r.rank + '.º'), h('span', { class: 'name' }, r.name), h('span', null, fmt(r.score))))));
}
function render() {
  if (state.phase === 'lobby') lobby();
  else if (['question', 'reveal'].includes(state.phase)) question();
  else board(state.phase === 'finished' ? 'Classificação final' : 'Classificação');
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
document.getElementById('fs').addEventListener('click', (e) => { document.documentElement.requestFullscreen?.(); e.target.remove(); });
