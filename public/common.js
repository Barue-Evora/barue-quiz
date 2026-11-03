function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const fmt = (n) => Number(n).toLocaleString('pt-PT');
const logo = () => {
  const t = document.createElement('template');
  t.innerHTML = '<svg width="1.3em" height="1.3em" viewBox="0 0 200 200" aria-hidden="true"><circle cx="92" cy="92" r="70" fill="none" stroke="#F26B21" stroke-width="28"/><circle cx="92" cy="92" r="30" fill="#F6EFE0"/><line x1="134" y1="134" x2="176" y2="176" stroke="#F26B21" stroke-width="28" stroke-linecap="round"/></svg>';
  return t.content.firstChild;
};
const brand = () => h('div', { class: 'brand' }, logo(), h('span', null, 'BARUE ', h('b', null, 'QUIZ')));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
function countdown(state, onTick) {
  clearInterval(window._cd);
  const end = performance.now() + (state.remainingMs || 0);
  const tick = () => {
    const left = Math.max(0, end - performance.now());
    onTick(left, state.totalMs ? left / state.totalMs : 0);
    if (!left) clearInterval(window._cd);
  };
  if (state.phase === 'question') { window._cd = setInterval(tick, 200); tick(); }
}
