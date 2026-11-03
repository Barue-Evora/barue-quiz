// Plays complete games with 50 simulated teams against a running server.
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3100';
const TEAMS = 50;
const quiz = require(process.env.QUIZ_FILE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const call = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const conn = () => new Promise((res) => { const s = io(URL, { transports: ['websocket'], forceNew: true }); s.once('connect', () => res(s)); });

(async () => {
  const g = await (await fetch(`${URL}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: process.env.ADMIN_PIN }) })).json();
  let host = await conn();
  await call(host, 'hello', { role: 'host', code: g.code, hostToken: g.hostToken });
  const bad = await conn();
  check(!(await call(bad, 'hello', { role: 'host', code: g.code, hostToken: 'wrong' })).ok, 'wrong host token rejected');
  await call(bad, 'hello', { role: 'team', code: g.code });
  check(!(await call(bad, 'host:action', { type: 'start' })).ok, 'a team cannot use host controls');

  const teams = await Promise.all(Array.from({ length: TEAMS }, async (_, i) => {
    const s = await conn();
    const t = { i, s, name: `Equipa ${i + 1}`, expected: 0, latest: null };
    s.on('state', (st) => { t.latest = st; });
    await call(s, 'hello', { role: 'team', code: g.code });
    const r = await call(s, 'team:join', { name: t.name });
    t.ok = r.ok; t.token = r.token;
    return t;
  }));
  check(teams.every((t) => t.ok), '50 teams joined at the same moment');
  const extra = await conn(); await call(extra, 'hello', { role: 'team', code: g.code });
  check(!(await call(extra, 'team:join', { name: 'Equipa 51' })).ok, '51st team refused');
  const dup = await call(bad, 'team:join', { name: 'EQUIPA 1' });
  check(!dup.ok, 'duplicate name refused');

  const spreads = []; const leaked = [];
  const waitPhase = (t, ok) => new Promise((res) => {
    if (t.latest && ok(t.latest)) return res(performance.now());
    const f = (st) => { if (ok(st)) { t.s.off('state', f); res(performance.now()); } };
    t.s.on('state', f);
  });
  const watch = (t) => t.s.on('state', (st) => {
    t.latest = st;
    if (st.phase !== 'reveal' && st.correct != null) leaked.push(t.i);
  });
  teams.forEach(watch);
  for (let q = 0; q < quiz.questions.length; q++) {
    const arrivals = teams.map((t) => waitPhase(t, (st) => st.phase === 'question' && st.qIndex === q));
    if (q === 0) await call(host, 'host:action', { type: 'start' });
    const times = await Promise.all(arrivals);
    spreads.push(Math.max(...times) - Math.min(...times));

    if (q === 1) {
      const dropped = teams.slice(0, 10);
      dropped.forEach((t) => t.s.disconnect());
      await sleep(150);
      await Promise.all(dropped.map(async (t) => {
        t.s = await conn(); watch(t);
        const r2 = await call(t.s, 'hello', { role: 'team', code: g.code, teamToken: t.token });
        t.rejoined = r2.joined && r2.state.team.name === t.name;
      }));
      check(dropped.every((t) => t.rejoined), '10 dropped teams rejoined as the same team');
    }
    if (q === 2) {
      host.disconnect(); host = await conn();
      const r3 = await call(host, 'hello', { role: 'host', code: g.code, hostToken: g.hostToken });
      check(r3.ok && r3.state.phase === 'question' && r3.state.qIndex === 2, 'host refresh kept the game running');
    }

    const correct = quiz.questions[q].correct;
    const results = await Promise.all(teams.map(async (t) => {
      await sleep(Math.random() * 200);
      const choice = t.i % 4 === 0 ? (correct + 1) % 4 : correct;
      const r4 = await call(t.s, 'team:answer', { qIndex: q, choice });
      if (t.i === 5 && q === 0) t.double = await call(t.s, 'team:answer', { qIndex: q, choice: (correct + 1) % 4 });
      return r4.ok;
    }));
    check(results.filter(Boolean).length === TEAMS, `question ${q + 1}: all 50 answers accepted`);
    if (q === 0) check(!teams[5].double.ok, 'second answer from one team refused');
    await Promise.all(teams.map((t) => waitPhase(t, (st) => st.phase === 'reveal' && st.qIndex === q)));
    check(teams.every((t) => t.latest.correct === correct), `question ${q + 1}: showed the result automatically once everyone answered`);
    teams.forEach((t) => {
      const pts = t.latest.lastPoints;
      const right = t.i % 4 !== 0;
      if (right ? !(pts >= 1000 && pts <= 1200) : pts !== 0) check(false, `bad points for ${t.name}: ${pts}`);
      t.expected += pts;
    });
    if (q === 3) {
      await call(host, 'host:action', { type: 'pause' });
      await sleep(Number(process.env.REVEAL_MS) + 300);
      check(teams.every((t) => t.latest.phase === 'reveal'), 'host pause held the game on the result');
      await call(host, 'host:action', { type: 'pause' });
    }
  }
  await Promise.all(teams.map((t) => waitPhase(t, (st) => st.phase === 'finished')));
  check(leaked.length === 0, 'correct answer never reached phones before reveal');
  check(teams.every((t) => t.latest.phase === 'finished' && t.latest.team.score === t.expected), 'final score on every phone matches the sum of its points');
  const ranks = teams.map((t) => t.latest.team.rank);
  check(Math.min(...ranks) === 1, 'a winner exists');
  console.log(`Gap between first and last phone getting each question: worst ${Math.round(Math.max(...spreads))} ms`);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
