const token = location.pathname.split('/').filter(Boolean)[1] || '';
const base = `/v/${encodeURIComponent(token)}`;
const app = document.getElementById('app');
const banner = document.getElementById('banner');
const bannerText = document.getElementById('banner-text');
const NAMES = { me: '남편', wife: '아내' };
const PARTICLE = { me: { sub: '이', top: '은' }, wife: { sub: '가', top: '는' } };
let gen = 0;

let view = null;
let lastKey = '';
let busy = false;
let timer = null;
let retryFn = null;
let step = 0;
let revealing = false;

class Expired extends Error {}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
}
const imgUrl = (id) => `${base}/img/${encodeURIComponent(id)}`;
const photoImg = (id, alt) => el('img', { src: imgUrl(id), alt: alt || '아기 사진', draggable: 'false' });

function showBanner(msg, fn) {
  bannerText.textContent = msg;
  retryFn = fn || null;
  banner.hidden = false;
}
function hideBanner() { banner.hidden = true; retryFn = null; }
document.getElementById('banner-retry').addEventListener('click', () => { const f = retryFn; hideBanner(); if (f) f(); });

async function api(path, body) {
  const opts = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body), cache: 'no-store' };
  const res = await fetch(`${base}/api/${path}`, opts);
  if (res.status === 404) throw new Expired();
  if (res.status === 200 || res.status === 409) {
    const data = await res.json().catch(() => null);
    if (data && data.week) return data;
  }
  throw new Error(`http ${res.status}`);
}

function schedule() {
  clearTimeout(timer);
  if (!view) { timer = setTimeout(refresh, 3000); return; }
  let ms = 0;
  if (view.status === 'finalizing') ms = 2000;
  else if (view.jointFinal || (!view.match && !view.result)) ms = 5000;
  else if (view.result && view.status !== 'done') ms = 2000;
  if (ms) timer = setTimeout(refresh, ms);
}

async function refresh() {
  if (busy) { schedule(); return; }
  const g = gen;
  try {
    const v = await api('state');
    if (g !== gen || busy) { schedule(); return; }
    hideBanner();
    apply(v);
  } catch (e) {
    if (e instanceof Expired) return expired();
    showBanner('연결이 불안정해요', refresh);
    schedule();
  }
}

async function act(path, body) {
  if (busy) return;
  busy = true;
  gen++;
  clearTimeout(timer);
  try {
    const v = await api(path, body);
    hideBanner();
    busy = false;
    gen++;
    apply(v, true);
  } catch (e) {
    busy = false;
    gen++;
    if (e instanceof Expired) return expired();
    showBanner('전송하지 못했어요. 다시 눌러 주세요', refresh);
    render(true);
    schedule();
  }
}

function apply(v, force) {
  const key = JSON.stringify(v);
  const changed = key !== lastKey;
  lastKey = key;
  const prev = view;
  view = v;
  if (changed && !force && revealing && step === 3 && prev && prev.result && v.result && !v.jointFinal
      && JSON.stringify(prev.result) === JSON.stringify(v.result)) {
    const n = app.querySelector('.saved-note');
    if (n) n.textContent = v.status === 'done' ? '✔ PC에 저장됨' : '저장하는 중이에요…';
    schedule();
    return;
  }
  if (changed || force) render(force || changed);
  schedule();
}

function expired() {
  clearTimeout(timer);
  view = null;
  app.replaceChildren(el('div', { class: 'center' },
    el('div', { class: 'emoji', text: '🔗' }),
    el('h1', { text: '링크가 만료됐어요' }),
    el('p', { text: '이 주소는 더 이상 쓸 수 없어요.\n새 링크를 받아 주세요.', style: 'white-space:pre-line' })));
}

function render() {
  if (!view) return;
  const v = view;
  if (v.jointFinal) { revealing = false; return renderJoint(v); }
  if (v.result) return renderReveal(v);
  revealing = false;
  if (v.match) return renderMatch(v);
  return renderWaiting(v);
}

function renderMatch(v) {
  const m = v.match;
  const photos = el('div', { class: 'photos' });
  const lock = () => { photos.classList.add('locked'); for (const b of app.querySelectorAll('button')) b.disabled = true; };
  const choose = (id, btn) => {
    if (busy) return;
    btn.classList.add('picked');
    lock();
    act('pick', { matchId: m.id, winnerId: id });
  };
  for (const [id, tag] of [[m.a, '위'], [m.b, '아래']]) {
    const btn = el('button', { class: 'photo', type: 'button', 'aria-label': `${tag} 사진 고르기` }, photoImg(id, `${tag} 사진`));
    btn.addEventListener('click', () => choose(id, btn));
    photos.append(btn);
  }
  const undo = el('button', { class: 'ghost', type: 'button', text: '되돌리기', disabled: !v.canUndo });
  undo.addEventListener('click', () => { lock(); act('undo', { matchId: m.id }); });
  const pct = Math.round(((m.index - 1) / Math.max(1, m.total)) * 100);
  app.replaceChildren(el('div', { class: 'screen' },
    el('div', { class: 'top' },
      el('div', { class: 'label', text: m.label }),
      el('div', { class: 'count', text: `${m.index} / ${m.total} · 더 마음에 드는 사진을 탭하세요` }),
      el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` }))),
    photos,
    el('div', { class: 'foot' }, undo)));
}

function renderWaiting(v) {
  const otherKey = v.voter === 'me' ? 'wife' : 'me';
  const other = NAMES[otherKey];
  const done = v.myRanks != null;
  const undo = el('button', { class: 'ghost', type: 'button', text: '마지막 선택 되돌리기', disabled: !v.canUndo });
  undo.addEventListener('click', () => { undo.disabled = true; act('undo', { matchId: null }); });
  app.replaceChildren(el('div', { class: 'screen' }, el('div', { class: 'center' },
    el('div', { class: 'pulse' }),
    el('h1', { text: v.otherDone ? '잠시만요, 결과를 모으는 중' : `${other}${PARTICLE[otherKey].sub} 투표 중이에요` }),
    el('p', { text: done ? '내 선택은 끝났어요. 상대의 선택은 모두 끝나면 함께 공개돼요.' : '잠시 후 다시 확인해요.' }),
    v.canUndo ? undo : null)));
}

function renderJoint(v) {
  const [meTop, wifeTop] = v.jointFinal;
  const photos = el('div', { class: 'photos' });
  const lock = () => { for (const b of app.querySelectorAll('button')) b.disabled = true; };
  for (const [id, who] of [[meTop, '남편의 1위'], [wifeTop, '아내의 1위']]) {
    const btn = el('button', { class: 'photo', type: 'button', 'aria-label': `${who} 사진 고르기` }, photoImg(id, who), el('span', { class: 'who', text: who }));
    btn.addEventListener('click', () => { btn.classList.add('picked'); photos.classList.add('locked'); lock(); act('joint', { winnerId: id }); });
    photos.append(btn);
  }
  app.replaceChildren(el('div', { class: 'screen' },
    el('div', { class: 'top' },
      el('div', { class: 'label', text: '둘이 같이 골라요' }),
      el('div', { class: 'count', text: '겹친 사진이 없었어요. 함께 보면서 한 장을 탭해 주세요' })),
    photos));
}

/* ---- reveal ---- */
function renderReveal(v) {
  if (!revealing) { revealing = true; step = 0; }
  const r = v.result;
  const me = v.voter;
  const other = me === 'me' ? 'wife' : 'me';
  const mine = r[me], theirs = r[other];
  const overlap = mine.filter((id) => theirs.includes(id));
  const finalDone = v.status === 'done';
  const steps = 4;

  const card = (id, i, rank, extra) => el('div', { class: `card ${rank ? 'r' + rank : ''} ${extra || ''}`, style: `--i:${i}` },
    el('div', { class: 'frame' }, photoImg(id)),
    rank ? el('div', { class: 'badge', text: `${rank}위` }) : null,
    extra && r.files[i] ? el('div', { class: 'fname', text: r.files[i] }) : null);

  let title, sub, note = null;
  const stage = el('div', { class: 'stage' });
  if (step === 0) {
    title = '내가 고른 1~3위';
    sub = '두근두근, 탭해서 다음으로';
    mine.forEach((id, i) => stage.append(card(id, i, i + 1)));
  } else if (step === 1) {
    title = `${NAMES[other]}의 1~3위`;
    sub = `${NAMES[other]}${PARTICLE[other].top} 이렇게 골랐어요`;
    theirs.forEach((id, i) => stage.append(card(id, i, i + 1)));
  } else if (step === 2) {
    title = '둘 다 고른 사진';
    if (overlap.length) {
      sub = `${overlap.length}장이 겹쳤어요!`;
      overlap.forEach((id, i) => stage.append(card(id, i, 0)));
    } else {
      sub = '이번엔 하나도 안 겹쳤어요';
      stage.append(el('div', { class: 'empty', text: '그래서 서로의 1위 사진으로\n함께 결승을 했어요.', style: 'white-space:pre-line' }));
    }
  } else {
    title = '우리 아이 최고의 사진';
    sub = r.joint ? '함께 결승에서 뽑힌 사진이에요' : '두 사람의 순위를 합쳐 정했어요';
    const big = r.saved.length === 1;
    r.saved.forEach((id, i) => stage.append(card(id, i, i + 1, big ? 'big' : '')));
    note = el('div', { class: 'saved-note', text: finalDone ? '✔ PC에 저장됨' : '저장하는 중이에요…' });
    const colors = ['#f5c542', '#ff8f6b', '#ffb38a', '#9ad1d4', '#e7a5ff'];
    stage.append(el('div', { class: 'confetti', 'aria-hidden': 'true' },
      ...Array.from({ length: 18 }, (_, i) => el('i', { style: `--x:${(i * 37) % 100};--d:${((i * 53) % 20) / 10}s;--k:${colors[i % 5]}` }))));
  }
  stage.addEventListener('click', () => go(1));

  const dots = el('div', { class: 'dots' }, ...Array.from({ length: steps }, (_, i) => el('i', { class: i === step ? 'on' : '' })));
  const next = step < steps - 1
    ? el('button', { class: 'primary', type: 'button', text: '다음', onclick: () => go(1) })
    : el('button', { class: 'ghost', type: 'button', text: '처음부터 다시 보기', onclick: () => { step = 0; render(); } });

  app.replaceChildren(el('div', { class: 'screen' }, el('div', { class: 'reveal' },
    el('h2', { text: title }),
    el('div', { class: 'sub', text: sub }),
    stage, note, el('div', { class: 'nav' }, dots, next))));
}

function go(d) {
  if (!view || !view.result || step >= 3) return;
  step += d;
  render();
}

app.replaceChildren(el('div', { class: 'center' }, el('div', { class: 'pulse' }), el('p', { text: '불러오는 중…' })));
refresh();
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refresh(); });
