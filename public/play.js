const app = document.getElementById('app');
const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
const key = 'barue-team-' + code;
const socket = io({ transports: ['websocket', 'polling'] });
let state = null, error = '', offline = false, sending = false;

const header = () => h('header', null, brand(), state && state.team
  ? h('div', { style: 'text-align:right' }, h('strong', null, state.team.name), h('div', { class: 'muted' }, fmt(state.team.score) + ' pts'))
  : null);

function joinForm() {
  const input = h('input', { id: 'name', maxlength: 24, autocomplete: 'off', required: true, 'aria-label': 'Nome da equipa', placeholder: 'Nome da equipa' });
  const err = h('div', { class: 'error', role: 'alert' }, error);
  const form = h('form', { style: 'display:grid;gap:12px', onsubmit: (e) => {
    e.preventDefault();
    socket.emit('team:join', { name: input.value }, (r) => {
      if (!r.ok) { err.textContent = r.error; return; }
      store.set(key, r.token);
      state = r.state; render();
    });
  } }, input, h('button', null, 'Entrar no jogo'));
  app.replaceChildren(h('div', { class: 'center' }, brand(), h('h1', { class: 'big' }, 'Como se chama a tua equipa?'), form, err));
}
function message(title, sub) {
  app.replaceChildren(header(), h('div', { class: 'center' }, h('h1', { class: 'big' }, title), sub ? h('p', { class: 'muted' }, sub) : null,
    offline ? h('p', { class: 'error' }, 'A voltar a ligar…') : null));
}
function choose(i) {
  if (sending || state.myChoice != null) return;
  sending = true;
  socket.emit('team:answer', { qIndex: state.qIndex, choice: i }, (r) => {
    sending = false;
    if (r.ok) state = r.state; else error = r.error;
    render();
  });
}
function questionView() {
  const answered = state.myChoice != null;
  const fill = h('i', { style: 'width:100%' });
  countdown(state, (_left, ratio) => { fill.style.width = (ratio * 100) + '%'; });
  app.replaceChildren(header(),
    h('div', { class: 'muted' }, `Pergunta ${state.qIndex + 1} de ${state.qTotal}`),
    h('div', { class: 'bar' }, fill),
    h('div', { class: 'qtext' }, state.question.text),
    h('div', { class: 'answers' }, state.question.options.map((text, i) =>
      h('button', { class: `opt${i} ${answered && state.myChoice !== i ? 'dim' : ''}`, disabled: answered, onclick: () => choose(i) },
        h('span', { class: 'letter' }, LETTERS[i]), text))),
    h('div', { class: 'error', role: 'alert' }, error || (answered ? 'Resposta registada. Boa sorte!' : '')));
}
function render() {
  if (!state) return joinForm();
  switch (state.phase) {
    case 'lobby': return message('Estás dentro!', 'Fica atento ao ecrã. O jogo vai começar.');
    case 'question': return questionView();
    case 'locked': return message(state.myChoice != null ? 'Resposta fechada' : 'Tempo esgotado', 'Vê a resposta certa no ecrã.');
    case 'reveal': {
      if (state.myChoice == null) return message('Sem resposta', 'Certa: ' + state.question.options[state.correct]);
      return state.lastPoints
        ? message('Certo! +' + fmt(state.lastPoints), `Estás em ${state.team.rank}.º lugar.`)
        : message('Errado', 'Certa: ' + state.question.options[state.correct]);
    }
    case 'leaderboard': return message(`${state.team.rank}.º lugar`, fmt(state.team.score) + ' pontos');
    case 'finished': return message(`Terminaste em ${state.team.rank}.º`, fmt(state.team.score) + ' pontos. Obrigado por jogares!');
  }
}
function hello() {
  socket.emit('hello', { role: 'team', code, teamToken: store.get(key) }, (r) => {
    if (!r.ok) { app.replaceChildren(h('div', { class: 'center' }, brand(), h('h1', { class: 'big' }, r.error))); return; }
    offline = false;
    if (r.joined) state = r.state;
    render();
  });
}
socket.on('connect', hello);
socket.on('disconnect', () => { offline = true; if (state) { sending = false; if (state.phase !== 'question') render(); } });
socket.on('state', (s) => { error = ''; state = s; render(); });
socket.on('kicked', () => { store.del(key); state = null; error = 'A tua equipa foi removida pelo anfitrião.'; render(); });
if (!code) app.replaceChildren(h('div', { class: 'center' }, brand(), h('h1', { class: 'big' }, 'Lê o código QR da mesa.')));
