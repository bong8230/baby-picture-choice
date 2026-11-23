import { analyzeDay, preloadModels } from './analyze.js';
import { decodeToBitmap, toFullJpeg } from './decode.js';
import { takeSharedFiles } from './share-inbox.js';
import { babyDayText, babyWeekText, isoWeek, weekLabel } from './week.js';
import { parse } from './vendor/exifr/lite.esm.mjs';

const THUMB_SIDE = 1600;
const THUMB_QUALITY = 0.85;
const PREVIEW_SIDE = 480;
const PREVIEW_QUALITY = 0.8;
const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;
const MAX_PER_WEEK = 16;
const BEFORE_VOTING = '16장 이하로 줄여야 투표를 시작할 수 있어요.';
const SEOUL_DEADLINE = new Intl.DateTimeFormat('ko-KR', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZone: 'Asia/Seoul',
});
const EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const STATUS_LABELS = {
  collecting: '후보 수집 중',
  voting: '투표 중',
  finalizing: '결과 저장 중',
  done: '완료',
};
const FUNNEL_LABELS = {
  funnel: '외부 공개 중',
  tailnet: 'Tailnet 전용',
  off: '꺼짐',
  unknown: '확인할 수 없음',
};
const EXCLUSION_LABELS = {
  blur: '흐린 사진',
  duplicate: '비슷한 사진',
  unsupported: '읽을 수 없는 사진',
  format: '지원하지 않는 파일 형식',
  size: '원본이 50MB를 초과함',
};

const input = document.querySelector('#photo-input');
const inputAny = document.querySelector('#photo-input-any');
const refreshButton = document.querySelector('#refresh');
const funnel = document.querySelector('#funnel');
const progress = document.querySelector('#progress');
const notice = document.querySelector('#notice');
const draftList = document.querySelector('#drafts');
const weekList = document.querySelector('#weeks');
const birthSettings = document.querySelector('#birth-settings');
const birthInput = document.querySelector('#birth-date');
const birthSave = document.querySelector('#save-birth-date');
const drafts = new Map();
const linksByWeek = new Map();
const openPhotoWeeks = new Set();
let weeks = null;
let birthDate = null;
let settingsReady = false;
let busy = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.disabled = busy;
  node.addEventListener('click', action);
  return node;
}

function weekPath(week) {
  return `/api/admin/weeks/${encodeURIComponent(week)}`;
}

function imagePath(week, id) {
  return `/api/admin/img/${encodeURIComponent(week)}/${encodeURIComponent(id)}`;
}

async function request(path, { method = 'GET', body, headers } = {}) {
  const requestHeaders = new Headers(headers);
  if (method !== 'GET') requestHeaders.set('X-Requested-With', 'fetch');
  let response;
  try {
    response = await fetch(path, { method, body, headers: requestHeaders });
  } catch {
    throw new Error('서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도하세요.');
  }
  if (!response.ok) {
    let message = {
      400: '사진 정보나 요청 형식이 올바르지 않습니다.',
      404: '요청한 항목에 접근할 수 없습니다.',
      409: '이미 투표를 시작했거나 현재 상태에서 처리할 수 없습니다.',
      413: '파일이 너무 큽니다.',
    }[response.status];
    if (response.status === 409) {
      const details = await response.json().catch(() => null);
      if (details?.message === BEFORE_VOTING) message = BEFORE_VOTING;
    }
    throw Object.assign(new Error(message ?? `서버 요청 실패 (${response.status})`), { status: response.status });
  }
  return response;
}

async function refreshWeeks() {
  weeks = await (await request('/api/admin/weeks')).json();
}

async function refreshSettings() {
  try {
    const response = await request('/api/admin/settings');
    ({ birthDate } = await response.json());
    birthInput.value = birthDate ?? '';
    settingsReady = true;
  } catch {
    notice.textContent = '아기 생일 설정을 불러오지 못했습니다.';
  }
}

birthSettings.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!settingsReady || busy) return;
  void run(async () => {
    const response = await request('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ birthDate: birthInput.value || null }),
    });
    ({ birthDate } = await response.json());
    notice.textContent = birthDate ? '아기 생일을 저장했습니다.' : '아기 생일 설정을 지웠습니다.';
  });
});

async function refreshFunnel() {
  funnel.textContent = 'Funnel 상태 확인 중';
  try {
    const { state } = await (await request('/api/admin/funnel')).json();
    funnel.textContent = `Funnel · ${FUNNEL_LABELS[state] ?? FUNNEL_LABELS.unknown}`;
  } catch {
    funnel.textContent = `Funnel · ${FUNNEL_LABELS.unknown}`;
  }
}

async function run(action) {
  if (busy) return;
  busy = true;
  notice.textContent = '';
  render();
  try {
    await action();
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    busy = false;
    progress.textContent = '';
    render();
  }
}

async function captureDate(file) {
  try {
    const metadata = await parse(file, ['DateTimeOriginal']);
    const date = metadata?.DateTimeOriginal;
    if (date instanceof Date && Number.isFinite(date.getTime())) return date;
  } catch {
    // Missing or unreadable EXIF falls back to the file date.
  }
  return new Date(file.lastModified);
}

function isHeic(entry) {
  if (!['format', 'unsupported'].includes(entry.reason)) return false;
  const type = entry.original?.type ?? '';
  return /\.(heic|heif)$/i.test(entry.name ?? '') || /hei[cf]/i.test(type);
}

function fileExtension(file) {
  const suffix = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (EXTENSIONS.has(suffix)) return suffix;
  const type = file.type.toLowerCase().replace(/^image\//, '');
  return EXTENSIONS.has(type) ? type : null;
}

function removeDraft(week) {
  const draft = drafts.get(week);
  for (const entry of draft?.entries ?? []) {
    if (entry.preview?.startsWith('blob:')) URL.revokeObjectURL(entry.preview);
  }
  drafts.delete(week);
}

async function existingEntries(week) {
  const photos = await (await request(`${weekPath(week)}/photos`)).json();
  const entries = [];
  for (const photo of photos) {
    const preview = imagePath(week, photo.id);
    const thumbnail = await (await request(preview)).blob();
    entries.push({
      id: photo.id,
      name: photo.originalName,
      preview,
      analysisFile: new File([thumbnail], photo.originalName, { type: 'image/jpeg' }),
      previousScore: photo.score,
      takenAt: photo.takenAt,
    });
  }
  return entries;
}

async function analyzeWeek(week, newEntries) {
  const entries = [...await existingEntries(week), ...newEntries];
  const byFile = new Map(entries.filter(({ reason }) => !reason).map((entry) => [entry.analysisFile, entry]));
  const { kept, excluded, warnings } = await analyzeDay([...byFile.keys()], {
    onProgress({ done, total }) {
      progress.textContent = `${week} 사진 분석 중 ${done}/${total}`;
    },
  });
  for (const { file, score } of kept) {
    Object.assign(byFile.get(file), { included: true, score });
  }
  for (const { file, score, reason, duplicateOf } of excluded) {
    Object.assign(byFile.get(file), { score, reason, duplicate: byFile.get(duplicateOf)?.name });
  }
  let previewDone = 0;
  for (const entry of newEntries) {
    if (!entry.reason || entry.reason === 'blur' || entry.reason === 'duplicate') {
      // Chrome on Android cannot render HEIC in <img>, so HEIC previews are decoded to a small JPEG.
      if (entry.ext === 'heic' || entry.ext === 'heif') {
        progress.textContent = `${week} 미리보기 만드는 중 ${++previewDone}`;
        try {
          entry.preview = URL.createObjectURL(await makeThumbnail(entry.original, PREVIEW_SIDE, PREVIEW_QUALITY));
        } catch (error) {
          console.warn('[admin] preview failed', entry.name, error);
        }
      } else {
        entry.preview = URL.createObjectURL(entry.original);
      }
    }
  }
  drafts.set(week, { entries, warnings });
}

async function analyzeSelection(files) {
  for (const week of drafts.keys()) removeDraft(week);
  await refreshWeeks();
  const groups = new Map();
  for (const [index, file] of files.entries()) {
    progress.textContent = `촬영 날짜 확인 중 ${index + 1}/${files.length}`;
    const date = await captureDate(file);
    const week = isoWeek(date);
    const ext = fileExtension(file);
    const reason = !ext ? 'format' : file.size > MAX_ORIGINAL_BYTES ? 'size' : undefined;
    const entry = { name: file.name, original: file, analysisFile: file, takenAt: date.getTime(), ext, reason };
    if (!groups.has(week)) groups.set(week, []);
    groups.get(week).push(entry);
  }

  const problems = [];
  for (const [week, entries] of [...groups].sort(([a], [b]) => b.localeCompare(a))) {
    const current = weeks.find((item) => item.week === week);
    if (current && current.status !== 'collecting') {
      problems.push(`${week} · 투표를 시작한 주에는 사진을 추가할 수 없습니다.`);
      continue;
    }
    progress.textContent = `${week} 기존 후보 불러오는 중`;
    try {
      await analyzeWeek(week, entries);
    } catch (error) {
      problems.push(`${week} · ${error.message}`);
    }
  }
  notice.textContent = problems.join('\n');
}

async function makeThumbnail(file, side = THUMB_SIDE, quality = THUMB_QUALITY) {
  const bitmap = await decodeToBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('캔버스를 만들 수 없습니다.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    bitmap.draw(context, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('썸네일을 만들 수 없습니다.'));
      }, 'image/jpeg', quality);
    });
  } finally {
    bitmap.close();
    canvas.width = 0;
  }
}

// Body = thumb + original (+ full JPEG for HEIC); X-Full-Length is sent only when there is one.
async function uploadPhoto(week, entry, fullJpeg = null) {
  const thumb = await makeThumbnail(entry.original);
  const params = new URLSearchParams({
    ext: entry.ext,
    name: entry.name,
    takenAt: String(entry.takenAt),
    score: String(entry.score),
  });
  const response = await request(`${weekPath(week)}/photos?${params}`, {
    method: 'POST',
    headers: {
      'X-Thumb-Length': String(thumb.size),
      ...(fullJpeg ? { 'X-Full-Length': String(fullJpeg.size) } : {}),
      'Content-Type': 'application/octet-stream',
    },
    body: new Blob(fullJpeg ? [thumb, entry.original, fullJpeg] : [thumb, entry.original], { type: 'application/octet-stream' }),
  });
  const { id } = await response.json();
  entry.id = id;
}

async function applyDraft(week, draft) {
  const included = draft.entries.filter((entry) => entry.included && !entry.removed);
  const deletions = draft.entries.filter((entry) => entry.id && !entry.included && !entry.removed);
  if (!included.length) return;
  if (deletions.length && !window.confirm(`PC에 저장된 후보 ${deletions.length}장을 삭제하고 이 목록을 올릴까요?`)) return;

  await run(async () => {
    const skipped = [];
    try {
      const pending = included.filter((entry) => !entry.id);
      // Same rule as the server: HEIC means ext heic/heif.
      const isHeicEntry = (entry) => entry.ext === 'heic' || entry.ext === 'heif';
      const heicCount = pending.filter(isHeicEntry).length;
      let heicDone = 0;
      for (const [index, entry] of pending.entries()) {
        let fullJpeg = null;
        if (isHeicEntry(entry)) {
          progress.textContent = `${week} JPG 변환 중 ${++heicDone}/${heicCount}`;
          try {
            fullJpeg = await toFullJpeg(entry.original);
          } catch (error) {
            skipped.push(`${entry.name} · ${error.message} 이 사진은 올리지 않았어요.`);
            continue;
          }
          if (!fullJpeg) {
            skipped.push(`${entry.name} · JPG로 변환하지 못했어요. 이 사진은 올리지 않았어요.`);
            continue;
          }
        }
        if (entry.original.size + (fullJpeg?.size ?? 0) > MAX_ORIGINAL_BYTES) {
          skipped.push(`${entry.name} · 원본과 JPG를 합친 크기가 50MB를 넘어요. 이 사진은 올리지 않았어요.`);
          continue;
        }
        progress.textContent = `${week} 올리는 중 ${index + 1}/${pending.length}`;
        try {
          await uploadPhoto(week, entry, fullJpeg);
        } catch (error) {
          // 400/413: only this photo is rejected. Other failures (network, 409, 5xx) abort the batch.
          if (error.status !== 400 && error.status !== 413) throw error;
          skipped.push(`${entry.name} · ${error.message} 이 사진은 올리지 않았어요.`);
        }
      }

      progress.textContent = `${week} 점수 저장 중`;
      const scores = Object.fromEntries(included.flatMap(({ id, score, previousScore }) =>
        id && Number.isFinite(score ?? previousScore) ? [[id, score ?? previousScore]] : []));
      if (Object.keys(scores).length) {
        await request(`${weekPath(week)}/scores`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scores),
        });
      }
      for (const [index, entry] of deletions.entries()) {
        progress.textContent = `${week} 제외 후보 삭제 중 ${index + 1}/${deletions.length}`;
        await request(`${weekPath(week)}/photos/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
        entry.removed = true;
      }
    } catch (error) {
      await refreshWeeks().catch(() => {});
      throw new Error(`${week} · ${error.message} 완료된 작업은 PC에 반영됐습니다.`);
    }
    if (skipped.length) {
      await refreshWeeks();
      notice.textContent = `${week} 후보 ${included.length - skipped.length}장을 저장했고 ${skipped.length}장은 건너뛰었어요.\n${skipped.join('\n')}`;
      return;
    }
    removeDraft(week);
    await refreshWeeks();
    notice.textContent = `${week} 후보 ${included.length}장을 저장했습니다.`;
  });
}

const linksTried = new Set();

// Cached in memory only; otherwise fetched once from the admin links endpoint.
function linksFor(week) {
  if (linksByWeek.has(week)) return linksByWeek.get(week);
  if (!linksTried.has(week)) {
    linksTried.add(week);
    request(`${weekPath(week)}/links`)
      .then((response) => response.json())
      .then(({ links }) => {
        if (links?.me && links?.wife) {
          linksByWeek.set(week, links);
          render();
        }
      })
      .catch(() => {});
  }
  return null;
}

async function startVote(week) {
  await run(async () => {
    const response = await request(`${weekPath(week)}/start`, { method: 'POST' });
    const { links } = await response.json();
    linksByWeek.set(week, links);
    const item = weeks.find((entry) => entry.week === week);
    if (item) item.status = 'voting';
    await refreshWeeks();
  });
}

function linkRow(label, link) {
  const row = element('div', undefined, 'link-row');
  const field = element('input');
  field.type = 'url';
  field.readOnly = true;
  field.value = link;
  field.setAttribute('aria-label', label);
  const copy = button('복사', async () => {
    try {
      await navigator.clipboard.writeText(link);
      notice.textContent = `${label}를 복사했습니다.`;
    } catch {
      field.focus();
      field.select();
      notice.textContent = '선택된 링크를 길게 눌러 복사하세요.';
    }
  }, 'secondary');
  copy.setAttribute('aria-label', `${label} 복사`);
  row.append(element('span', label), field, copy);
  return row;
}

function appendWeekHeading(card, week) {
  card.append(element('h3', weekLabel(week) ?? week));
  card.append(element('small', week, 'week-id'));
  const age = babyWeekText(birthDate, week);
  if (age) card.append(element('p', age, 'week-age'));
}

function overflowText(count, overBy, deleteAt) {
  const message = `${count}장 업로드됨 — ${overBy}장 초과. 16장 이하로 삭제해 주세요.`;
  if (deleteAt == null) return message;
  const parts = Object.fromEntries(SEOUL_DEADLINE.formatToParts(deleteAt).map(({ type, value }) => [type, value]));
  return `${message} ${parts.month}월 ${parts.day}일 ${parts.hour}:${parts.minute}에 점수 낮은 사진부터 자동 삭제돼요.`;
}

function uploadedPhotos(week, status) {
  const details = element('details');
  const content = element('div');
  details.append(element('summary', '업로드한 사진'), content);
  details.open = openPhotoWeeks.has(week);
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    content.textContent = '사진을 불러오는 중입니다.';
    try {
      const photos = await (await request(`${weekPath(week)}/photos`)).json();
      const entries = photos.map(({ id, originalName, takenAt }) => ({
        id, name: originalName, takenAt, preview: imagePath(week, id),
      }));
      const canDelete = status === 'collecting' && !drafts.has(week);
      const onDelete = canDelete ? (entry) => {
        if (busy || !window.confirm(`PC에 저장된 ${entry.name} 사진을 삭제할까요?`)) return;
        void run(async () => {
          await request(`${weekPath(week)}/photos/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
          await refreshWeeks();
          notice.textContent = '사진을 삭제했습니다.';
        });
      } : null;
      content.replaceChildren(photoList(entries, true, { editable: false, onDelete }));
    } catch (error) {
      content.textContent = error.message;
      loaded = false;
    }
  }

  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) {
      openPhotoWeeks.add(week);
      void load();
    } else {
      openPhotoWeeks.delete(week);
    }
  });
  if (details.open) void load();
  return details;
}

function renderWeeks() {
  if (weeks === null) return;
  weekList.replaceChildren();
  if (!weeks.length) weekList.append(element('p', '아직 저장한 주차가 없습니다.'));
  for (const { week, status, photoCount, count = photoCount, overBy = Math.max(0, count - MAX_PER_WEEK), deleteAt, voters } of weeks) {
    const card = element('article', undefined, 'week-card');
    appendWeekHeading(card, week);
    card.append(element('p', `${STATUS_LABELS[status] ?? status} · ${count}장`));
    if (status === 'collecting' && overBy > 0) {
      card.append(element('p', overflowText(count, overBy, deleteAt), 'overflow-notice'));
      card.append(element('p', BEFORE_VOTING, 'warning'));
    }
    if (status === 'collecting' && count && !drafts.has(week)) {
      const start = button('투표 시작', () => startVote(week));
      start.disabled = busy || overBy > 0;
      card.append(start);
    }
    if (status === 'voting') {
      card.append(element('p', `나 ${voters?.me?.done ? '완료' : '미완료'} · 아내 ${voters?.wife?.done ? '완료' : '미완료'}`));
      card.append(element('p', 'PC에서 npm run funnel:on 하세요.'));
    }
    if (status === 'done') card.append(element('p', 'PC에서 npm run funnel:off 하세요.'));
    const links = linksFor(week);
    if (links && status !== 'collecting') {
      card.append(linkRow('내 투표 링크', links.me), linkRow('아내 투표 링크', links.wife));
    }
    if (count > 0) card.append(uploadedPhotos(week, status));
    weekList.append(card);
  }
}

function photoList(entries, included, { editable = true, onDelete = null } = {}) {
  const list = element('ul', undefined, 'photo-list');
  if (!entries.length) list.append(element('li', '해당 사진이 없습니다.'));
  for (const entry of entries) {
    const item = element('li', undefined, 'photo-card');
    if (entry.preview) {
      const photo = element('img');
      photo.src = entry.preview;
      photo.loading = 'lazy';
      photo.alt = '';
      item.append(photo);
    }
    item.append(element('span', entry.name));
    const age = babyDayText(birthDate, entry.takenAt);
    if (age) item.append(element('small', age, 'photo-age'));
    if (entry.id) item.append(element('small', 'PC에 저장됨'));
    if (!included && entry.reason) {
      item.append(element('small', [
        EXCLUSION_LABELS[entry.reason], entry.duplicate,
      ].filter(Boolean).join(' · ')));
    }
    const canRestore = entry.id || !['unsupported', 'format', 'size'].includes(entry.reason);
    if (onDelete) {
      const remove = button('삭제', () => onDelete(entry), 'secondary');
      remove.setAttribute('aria-label', `${entry.name} 삭제`);
      item.append(remove);
    } else if (editable && (included || canRestore)) {
      const toggle = button(included ? '제외' : '되살리기', () => {
        entry.included = !included;
        renderDrafts();
      }, 'secondary');
      toggle.setAttribute('aria-label', `${entry.name} ${toggle.textContent}`);
      item.append(toggle);
    }
    list.append(item);
  }
  return list;
}

function renderDrafts() {
  draftList.replaceChildren();
  for (const [week, draft] of drafts) {
    const card = element('article', undefined, 'week-card');
    const live = draft.entries.filter((entry) => !entry.removed);
    const included = live.filter((entry) => entry.included);
    const excluded = live.filter((entry) => !entry.included);
    const deletions = excluded.filter((entry) => entry.id).length;
    appendWeekHeading(card, week);
    card.append(element('p', `후보 ${included.length}장`));
    if (draft.warnings.length) card.append(element('p', '얼굴 분석 없이 진행했습니다.', 'warning'));
    if (included.length > MAX_PER_WEEK) {
      card.append(element('p', `이대로 올리면 ${included.length}장으로 ${included.length - MAX_PER_WEEK}장 초과해요. 초과 상태가 48시간 지나면 점수 낮은 사진부터 자동 삭제돼요.`, 'overflow-notice'));
    }
    if (deletions) card.append(element('p', `올리면 PC에 저장된 후보 ${deletions}장을 삭제합니다.`, 'warning'));
    if (excluded.some(isHeic)) {
      card.append(element('p', "HEIC 사진은 지원되지 않아요. 갤럭시 카메라 설정에서 'HEIF 사진'을 끄면 JPEG로 저장돼요.", 'warning'));
    }
    card.append(element('h4', `선택한 사진 ${included.length}장`), photoList(included, true));
    const details = element('details');
    details.open = excluded.length > 0;
    details.append(element('summary', `제외된 사진 ${excluded.length}장`), photoList(excluded, false));
    card.append(details);
    const actions = element('div', undefined, 'admin-actions');
    const upload = button('올리기', () => applyDraft(week, draft));
    upload.disabled = busy || included.length === 0;
    actions.append(upload, button('취소', () => {
      removeDraft(week);
      render();
    }, 'secondary'));
    card.append(actions);
    draftList.append(card);
  }
}

function render() {
  input.disabled = busy || weeks === null;
  inputAny.disabled = input.disabled;
  refreshButton.disabled = busy;
  birthInput.disabled = busy || !settingsReady;
  birthSave.disabled = birthInput.disabled;
  renderDrafts();
  renderWeeks();
}

// "다른 앱으로 선택" has no accept filter, so Chrome may offer an app chooser (e.g. Gallery) instead of the photo picker.
for (const picker of [input, inputAny]) {
  picker.addEventListener('change', () => {
    const files = [...picker.files];
    picker.value = '';
    if (files.length) void run(() => analyzeSelection(files));
  });
}

async function refresh() {
  await run(() => Promise.all([refreshWeeks(), refreshFunnel(), refreshSettings()]));
  if (weeks === null || new URLSearchParams(location.search).get('shared') !== '1') return;

  await run(async () => {
    const pending = await takeSharedFiles();
    history.replaceState(history.state, '', '/admin');
    const files = pending?.files ?? [];
    if (!files.length) {
      notice.textContent = '공유된 사진을 찾지 못했습니다. 다시 공유해 주세요.';
      return;
    }
    await analyzeSelection(files);
    const received = `공유된 사진 ${files.length}장을 불러왔습니다.`;
    notice.textContent = [received, notice.textContent].filter(Boolean).join('\n');
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'module' })
    .catch((error) => console.warn('Could not register the share target worker', error));
}

refreshButton.addEventListener('click', refresh);
void refresh();
void preloadModels().catch(() => {});
