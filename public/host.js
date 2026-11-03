const app = document.getElementById('app');
const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
const hostToken = location.hash.slice(1);
const socket = io({ transports: ['websocket', 'polling'] });
let state = null, error = '';
const act = (type, extra) => socket.emit('host:action', { type, ...extra }, (r) => { error = r.ok ? '' : r.error; render(); });
const NEXT = {
  lobby: ['start', 'Começar jogo'], question: ['lock', 'Terminar pergunta agora'],
  reveal: ['skip', 'Avançar agora'], leaderboard: ['skip', 'Avançar agora'],
};
function render() {
  if (!state) return;
  const step = NEXT[state.phase];
  const showPause = !['lobby', 'finished'].includes(state.phase);
  const qCard = state.question ? h('div', { class: 'card' },
    h('div', { class: 'muted' }, `Pergunta ${state.qIndex + 1} de ${state.qTotal}`),
    h('strong', null, state.question.text),
    h('div', null, 'Certa: ' + LETTERS[state.hostCorrect] + ' · ' + state.question.options[state.hostCorrect]),
    h('div', { id: 'prog', class: 'muted' }, `${state.answered} de ${state.teamCount} responderam`)) : null;
  app.replaceChildren(
    h('header', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' }, brand(), h('strong', null, 'Código ' + code)),
    h('div', { class: 'row' },
      h('a', { href: `/screen?code=${code}`, target: '_blank', style: 'color:var(--cream)' }, 'Abrir ecrã grande'),
      h('span', { class: 'muted' }, `${state.connected} / ${state.teamCount} equipas ligadas`)),
    qCard,
    step ? h('button', { class: 'primary', onclick: () => act(step[0]) }, step[1])
      : h('div', { class: 'card' }, h('strong', null, state.phase === 'suspense' ? 'A preparar a resposta…' : 'Jogo terminado.')),
    showPause ? h('button', { class: 'secondary', onclick: () => act('pause') }, state.paused ? 'Retomar jogo automático' : 'Pausar depois desta pergunta') : null,
    h('div', { class: 'error', role: 'alert' }, error),
    h('div', { class: 'card' }, h('strong', null, 'Equipas'),
      h('div', { class: 'roster' }, state.roster.map((t) => h('div', null,
        h('span', { class: 'dot ' + (t.connected ? '' : 'off'), title: t.connected ? 'Ligada' : 'Desligada' }),
        h('span', { class: 'nm' }, t.name), h('span', null, fmt(t.score)),
        h('button', { 'aria-label': 'Remover ' + t.name, onclick: () => act('kick', { teamId: t.id }) }, 'Remover'))))));
}
socket.on('connect', () => socket.emit('hello', { role: 'host', code, hostToken }, (r) => {
  if (!r.ok) { app.replaceChildren(h('h1', null, r.error)); return; }
  state = r.state; render();
}));
socket.on('state', (s) => { state = s; render(); });
socket.on('progress', (p) => {
  if (!state) return;
  state.answered = p.answered; state.connected = p.connected;
  const el = document.getElementById('prog');
  if (el) el.textContent = `${p.answered} de ${state.teamCount} responderam`;
});
