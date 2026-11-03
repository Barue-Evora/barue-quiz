const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const S = process.env.SHOTS, URL = 'http://localhost:3101';
const start = () => spawn('node', ['server.js'], { env: { ...process.env, PORT: 3101 }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let srv = start(); await sleep(1200);
  const b = await chromium.launch();
  const errors = [];
  const watch = (p, n) => { p.on('pageerror', (e) => errors.push(n + ': ' + e.message)); };
  const hc = await b.newContext({ viewport: { width: 1280, height: 800 } }); const host = await hc.newPage(); watch(host, 'host');
  await host.goto(URL); await host.fill('#pin', '1234'); await host.click('form button'); await host.waitForSelector('text=Começar jogo');
  const code = new (require('url').URL)(host.url()).searchParams.get('code');
  const sc = await b.newContext({ viewport: { width: 1920, height: 1080 } }); const screen = await sc.newPage(); watch(screen, 'screen');
  await screen.goto(`${URL}/screen?code=${code}`); await screen.waitForSelector('.code');
  const phones = [];
  for (const [i, n] of ['Os Tascos', 'Quizálidos', 'Mesa 7'].entries()) {
    const c = await b.newContext(i === 1 ? devices['Pixel 7'] : devices['iPhone 13']); const p = await c.newPage(); watch(p, 'phone' + i);
    await p.goto(`${URL}/j/${code}`); await p.fill('#name', n); await p.click('form button'); await p.waitForSelector('text=Estás dentro!'); phones.push(p);
  }
  await sleep(300); await screen.screenshot({ path: S + '/1-lobby.png' });
  await host.click('text=Começar jogo'); await phones[0].waitForSelector('.answers button');
  await sleep(300); await screen.screenshot({ path: S + '/2-question.png' }); await phones[0].screenshot({ path: S + '/3-phone-q.png' }); await host.screenshot({ path: S + '/4-host.png' });
  await phones[0].click('.answers button:nth-child(2)'); await phones[0].waitForSelector('text=Resposta registada');
  // refresh a phone mid-question: must keep its team and locked answer
  await phones[0].reload(); await phones[0].waitForSelector('text=Resposta registada'); console.log('PASS phone refresh kept team and answer');
  await host.reload(); await host.waitForSelector('text=Terminar pergunta agora'); console.log('PASS host refresh kept controls');
  await phones[1].click('.answers button:nth-child(1)');
  // restart the server mid-question
  await sleep(800); srv.kill(); await sleep(400); srv = start();
  await phones[2].waitForSelector('.answers button:not([disabled])', { timeout: 15000 });
  await sleep(3000);
  await phones[2].click('.answers button:nth-child(2)'); await host.waitForSelector('text=A preparar a resposta', { timeout: 15000 });
  console.log('PASS game survived a server restart');
  await screen.waitForSelector('.sopts.scan'); await screen.screenshot({ path: S + '/5-suspense.png' }); console.log('PASS suspense screen shown');
  await phones[0].waitForSelector('text=Certo!');
  await sleep(700); await screen.screenshot({ path: S + '/6-reveal.png' }); await phones[1].screenshot({ path: S + '/6-phone-wrong.png' });
  await screen.waitForSelector('.board'); await sleep(200); await screen.screenshot({ path: S + '/7-board.png' }); console.log('PASS leaderboard shown automatically');
  await phones[0].waitForSelector('.answers button', { timeout: 10000 }); console.log('PASS next question started automatically');
  await phones[0].waitForSelector('text=Sem resposta', { timeout: 25000 }); await screen.waitForSelector('.wrong');
  console.log('PASS timer ended the question by itself');
  await screen.waitForSelector('.podium', { timeout: 10000 }); await phones[0].waitForSelector('text=Pódio!');
  await sleep(8500); await screen.screenshot({ path: S + '/8-podium.png' });
  await phones[0].waitForSelector('text=Terminaste em', { timeout: 5000 }); console.log('PASS podium shown, phones revealed the final place afterwards');
  console.log('page errors:', errors.length ? errors : 'none');
  await b.close(); srv.kill(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
