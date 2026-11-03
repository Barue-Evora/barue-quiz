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
    s.on('state', (st) => { t.latest = st; t.lastAt = performance.now(); });
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

  const latencies = []; const leaked = [];
  for (let q = 0; q < quiz.questions.length; q++) {
    const sent = performance.now();
    const waiting = teams.map((t) => new Promise((res) => {
      if (t.latest?.phase === 'question' && t.latest.qIndex === q) return res();
      const f = (st) => { if (st.phase === 'question' && st.qIndex === q) { t.s.off('state', f); latencies.push(performance.now() - sent); res(); } };
      t.s.on('state', f);
    }));
    const r = await call(host, 'host:action', { type: q === 0 ? 'start' : 'next' });
    if (!r.ok) check(false, `host could not start question ${q}: ${r.error}`);
    await Promise.all(waiting);
    for (const t of teams) if (t.latest.correct != null || JSON.stringify(t.latest).includes('hostCorrect')) leaked.push(t.i);

    // Question 2: ten phones drop mid-question and come back with their saved token.
    if (q === 1) {
      const dropped = teams.slice(0, 10);
      dropped.forEach((t) => t.s.disconnect());
      await sleep(150);
      await Promise.all(dropped.map(async (t) => {
        t.s = await conn(); t.s.on('state', (st) => { t.latest = st; });
        const r2 = await call(t.s, 'hello', { role: 'team', code: g.code, teamToken: t.token });
        t.rejoined = r2.joined && r2.state.team.name === t.name;
      }));
      check(dropped.every((t) => t.rejoined), '10 dropped teams rejoined as the same team');
    }
    // Question 3: the host refreshes in the middle of the question.
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
    await sleep(350);
    await call(host, 'host:action', { type: 'reveal' });
    await sleep(250);
    const before = teams.map((t) => t.latest);
    check(before.every((st) => st.phase === 'reveal' && st.correct === correct), `question ${q + 1}: every phone saw the reveal`);
    teams.forEach((t) => {
      const pts = t.latest.lastPoints;
      const right = t.i % 4 !== 0;
      if (right ? !(pts >= 1000 && pts <= 1200) : pts !== 0) check(false, `bad points for ${t.name}: ${pts}`);
      t.expected += pts;
    });
    await call(host, 'host:action', { type: 'leaderboard' });
    await sleep(150);
  }
  check(leaked.length === 0, 'correct answer never reached phones before reveal');
  await call(host, 'host:action', { type: 'next' });
  await sleep(300);
  check(teams.every((t) => t.latest.phase === 'finished' && t.latest.team.score === t.expected), 'final score on every phone matches the sum of its points');
  const ranks = teams.map((t) => t.latest.team.rank);
  check(Math.min(...ranks) === 1, 'a winner exists');
  latencies.sort((a, b) => a - b);
  const p = (x) => Math.round(latencies[Math.floor(latencies.length * x)] || 0);
  console.log(`Question arrival across phones: median ${p(.5)} ms, 95% ${p(.95)} ms, worst ${p(.999)} ms (${latencies.length} deliveries)`);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
