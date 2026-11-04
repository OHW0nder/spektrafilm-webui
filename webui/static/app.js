'use strict';

const state = {
  manifest: null,
  uploads: [],
  results: [],
  selectedId: null,
  beforeSrc: null,
  beforeImage: null,
  afterUrl: null,
  rotation: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  compare: 0.5,
  compareOn: true,
  extra: {},
  jobs: {},          // uploadId -> {id, status, message}
  timer: null,
  inflight: null,
  seq: 0,
};

const $ = (sel) => document.querySelector(sel);

async function boot() {
  const [health, manifest, uploads, results] = await Promise.all([
    fetch('/api/health').then((r) => r.json()),
    fetch('/api/manifest').then((r) => r.json()),
    fetch('/api/uploads').then((r) => r.json()),
    fetch('/api/results').then((r) => r.json()),
  ]);
  state.manifest = manifest;
  state.uploads = uploads;
  state.results = results;
  renderHealth(health);
  renderProfiles(manifest);
  renderControls(manifest);
  renderFilmstrip();
  renderResults();
  wire();
  if (uploads.length) selectUpload(uploads[0].id);
}

function renderHealth(health) {
  const badge = $('#engine-badge');
  if (health.engine_gpu) {
    badge.textContent = `GPU · ${health.gpu_backend}`;
    badge.className = 'badge gpu';
  } else {
    badge.textContent = 'CPU only';
    badge.className = 'badge cpu';
  }
  const note = health.interrupted_jobs
    ? ` · ${health.interrupted_jobs} 个旧任务已标记中断` : '';
  $('#health').textContent =
    `GPU 预览 ${health.engine_gpu ? '可用' : '不可用（回退 CPU）'} · 缓存预览长边 ${health.preview_edge}px` + note;
}

function renderProfiles(manifest) {
  const film = $('#film');
  const paper = $('#print');
  film.innerHTML = manifest.profiles.films
    .map((f) => `<option value="${f.slug}">${f.label || f.stock}${f.type === 'positive' ? ' · 反转' : ''}</option>`)
    .join('');
  paper.innerHTML = manifest.profiles.papers
    .map((p) => `<option value="${p.slug}">${p.label || p.stock}</option>`)
    .join('');
  film.value = manifest.defaults.film;
  paper.value = manifest.defaults.print;
  film.addEventListener('change', () => {
    const entry = manifest.profiles.films.find((f) => f.slug === film.value);
    if (entry && entry.target_print) paper.value = entry.target_print;
    schedulePreview();
  });
  paper.addEventListener('change', schedulePreview);
}

function renderControls(manifest) {
  const host = $('#sections');
  for (const group of manifest.groups) {
    const controls = manifest.controls.filter((c) => c.group === group.id);
    if (!controls.length) continue;
    const details = document.createElement('details');
    details.className = 'section';
    details.open = ['camera', 'enlarger'].includes(group.id);
    const summary = document.createElement('summary');
    summary.textContent = group.label;
    details.appendChild(summary);
    for (const control of controls) {
      details.appendChild(buildControl(control, manifest.defaults.values[control.path]));
    }
    host.appendChild(details);
  }
}

function buildControl(control, value) {
  const wrap = document.createElement('div');
  wrap.className = 'ctrl';

  if (control.kind === 'bool') {
    wrap.classList.add('check');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(value);
    input.dataset.path = control.path;
    input.addEventListener('change', schedulePreview);
    label.append(input, document.createTextNode(control.label));
    wrap.appendChild(label);
    return wrap;
  }
  if (control.kind === 'select') {
    const label = document.createElement('label');
    label.textContent = control.label;
    const select = document.createElement('select');
    select.dataset.path = control.path;
    select.innerHTML = (control.options || [])
      .map((opt) => `<option value="${opt}">${opt}</option>`).join('');
    select.value = value;
    select.addEventListener('change', schedulePreview);
    label.appendChild(select);
    wrap.appendChild(label);
    return wrap;
  }
  if (control.kind === 'vec2') {
    wrap.classList.add('vec');
    const head = document.createElement('div');
    head.className = 'ctrl-head';
    head.innerHTML = `<span>${control.label}</span>`;
    const row = document.createElement('div');
    row.className = 'vec-row';
    (value || [0, 0]).forEach((component, index) => {
      const input = document.createElement('input');
      Object.assign(input, { type: 'number', step: control.step, min: control.min,
                             max: control.max, value: component });
      input.dataset.path = control.path;
      input.dataset.index = index;
      input.dataset.kind = 'vec';
      input.addEventListener('change', schedulePreview);
      row.appendChild(input);
    });
    wrap.append(head, row);
    return wrap;
  }

  const head = document.createElement('div');
  head.className = 'ctrl-head';
  const name = document.createElement('span');
  name.textContent = control.label;
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = formatValue(value, control.kind);
  head.append(name, val);

  const range = document.createElement('input');
  Object.assign(range, { type: 'range', min: control.min, max: control.max,
                         step: control.step, value });
  range.dataset.path = control.path;
  range.dataset.kind = control.kind;
  range.addEventListener('input', () => {
    val.textContent = formatValue(range.value, control.kind);
    schedulePreview();
  });
  wrap.append(head, range);
  return wrap;
}

function formatValue(value, kind) {
  const number = Number(value);
  if (kind === 'int') return String(number);
  return Number.isInteger(number) ? number.toFixed(1) : number.toFixed(2).replace(/0$/, '');
}

function collectValues() {
  const values = {};
  document.querySelectorAll('[data-path]').forEach((input) => {
    if (input.dataset.kind === 'vec') {
      const arr = values[input.dataset.path] || [];
      arr[Number(input.dataset.index)] = Number(input.value);
      values[input.dataset.path] = arr;
      return;
    }
    if (input.type === 'checkbox') values[input.dataset.path] = input.checked;
    else if (input.tagName === 'SELECT') values[input.dataset.path] = input.value;
    else values[input.dataset.path] = input.dataset.kind === 'int'
      ? parseInt(input.value, 10) : Number(input.value);
  });
  return values;
}

function payload() {
  return { film: $('#film').value, print: $('#print').value,
           values: collectValues(), extra: state.extra };
}

function wire() {
  const fileInput = $('#file');
  $('#add').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFiles([...fileInput.files]);
    fileInput.value = '';
  });

  const viewport = $('#viewport');
  ['dragenter', 'dragover'].forEach((name) =>
    viewport.addEventListener(name, (event) => {
      event.preventDefault(); viewport.style.outline = '2px dashed var(--accent)';
    }));
  ['dragleave', 'drop'].forEach((name) =>
    viewport.addEventListener(name, (event) => {
      event.preventDefault(); viewport.style.outline = '';
    }));
  viewport.addEventListener('drop', (event) => {
    const files = [...event.dataTransfer.files];
    if (files.length) uploadFiles(files);
  });

  $('#process-selected').addEventListener('click', () => {
    if (state.selectedId) process([state.selectedId]);
    else status('请先选择一张图片');
  });
  $('#process-all').addEventListener('click', () => {
    if (state.uploads.length) process(state.uploads.map((u) => u.id));
    else status('还没有上传图片');
  });
  $('#apply-extra').addEventListener('click', () => {
    try {
      state.extra = JSON.parse($('#extra').value || '{}');
      schedulePreview();
    } catch (err) { status(`JSON 解析失败: ${err.message}`); }
  });

  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25));
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25));
  $('#zoom-reset').addEventListener('click', () => { state.zoom = 1; state.panX = state.panY = 0; applyTransform(); });
  viewport.addEventListener('wheel', (event) => {
    if (!state.selectedId) return;
    event.preventDefault();
    setZoom(state.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });

  $('#rot-left').addEventListener('click', () => setRotation((state.rotation + 3) % 4));
  $('#rot-right').addEventListener('click', () => setRotation((state.rotation + 1) % 4));

  $('#compare-toggle').addEventListener('click', () => {
    state.compareOn = !state.compareOn;
    $('#compare-toggle').classList.toggle('active', state.compareOn);
    applyCompare();
  });
  $('#compare-range').addEventListener('input', (event) => {
    state.compare = Number(event.target.value) / 100;
    applyCompare();
  });
  wireDivider();
  wirePan();
  window.addEventListener('resize', layoutCanvas);
}

async function uploadFiles(files) {
  const body = new FormData();
  files.forEach((file) => body.append('files', file));
  body.append('input_encoding', $('#input-encoding').value);
  body.append('source_space', $('#source-space').value);
  status(`上传并解码 ${files.length} 张…（大图/RAW 首次解码需要几秒）`);
  let response;
  try {
    response = await fetch('/api/upload', { method: 'POST', body });
  } catch (err) { return status(`上传失败: ${err.message}`, true); }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    return status(detail.detail || `上传失败 (${response.status})`, true);
  }
  const data = await response.json();
  state.uploads = [...data.items, ...state.uploads];
  renderFilmstrip();
  selectUpload(data.items[0].id);
  status(`已添加 ${data.items.length} 张`);
}

function viewUrl(id, rotation) {
  return `/api/view/${id}?rotation=${rotation}`;
}

function selectUpload(id) {
  if (!id || !state.uploads.some((u) => u.id === id)) return;
  state.selectedId = id;
  state.zoom = 1;
  state.panX = state.panY = 0;
  state.beforeSrc = viewUrl(id, state.rotation);
  const image = new Image();
  image.onload = () => {
    if (state.selectedId !== id ||
        image.src !== new URL(state.beforeSrc, location.href).href) return;
    state.beforeImage = image;
    $('#img-before').src = state.beforeSrc;
    layoutCanvas();
    applyTransform();
    schedulePreview(0);
  };
  image.src = state.beforeSrc;
  renderFilmstrip();
  updateViewerMeta();
}

function loadBefore(k) {
  const id = state.selectedId;
  if (!id) return;
  const url = viewUrl(id, k);
  const image = new Image();
  image.onload = () => {
    if (state.selectedId !== id || state.rotation !== k) return;
    state.beforeImage = image;
    state.beforeSrc = url;
    $('#img-before').src = url;
    layoutCanvas();
    applyTransform();
  };
  image.src = url;
}

function setRotation(k) {
  state.rotation = k;
  // The old processed half has the previous orientation: hide it until the
  // new GPU preview arrives so the comparison never shows mismatched halves.
  if (state.afterUrl) URL.revokeObjectURL(state.afterUrl);
  state.afterUrl = null;
  $('#img-after').removeAttribute('src');
  applyCompare();
  loadBefore(k);
  updateViewerMeta();
  schedulePreview(0);
}

function updateViewerMeta() {
  const meta = state.uploads.find((u) => u.id === state.selectedId);
  if (!meta) return;
  $('#viewer-meta').textContent =
    `${meta.name} · ${meta.width}×${meta.height}${meta.raw ? ' · RAW' : ''}` +
    (state.rotation ? ` · 旋转 ${state.rotation * 90}°` : '');
}

function layoutCanvas() {
  const canvas = $('#canvas');
  const image = state.beforeImage;
  if (!image) return;
  const vp = $('#viewport').getBoundingClientRect();
  // beforeImage is already the server-rendered rotated view.
  const ratio = image.naturalWidth / image.naturalHeight;
  let width = vp.width - 32, height = width / ratio;
  if (height > vp.height - 32) { height = vp.height - 32; width = height * ratio; }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.left = `${(vp.width - width) / 2}px`;
  canvas.style.top = `${(vp.height - height) / 2}px`;
  canvas.hidden = false;
  $('#empty-hint').hidden = true;
}

function setZoom(value) {
  state.zoom = Math.min(8, Math.max(0.25, value));
  applyTransform();
}

function applyTransform() {
  $('#canvas').style.transform =
    `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  $('#zoom-label').textContent = `${Math.round(state.zoom * 100)}%`;
}

function applyCompare() {
  const hasAfter = Boolean(state.afterUrl) && state.compareOn;
  $('#after-clip').hidden = !hasAfter;
  $('#divider').hidden = !hasAfter;
  if (!hasAfter) return;
  const percent = (state.compare * 100).toFixed(2);
  $('#after-clip').style.clipPath = `inset(0 0 0 ${percent}%)`;
  $('#divider').style.left = `${percent}%`;
  $('#compare-range').value = Math.round(state.compare * 100);
}

function wireDivider() {
  const divider = $('#divider');
  divider.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    divider.setPointerCapture(event.pointerId);
    const move = (e) => {
      const box = $('#canvas').getBoundingClientRect();
      state.compare = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
      applyCompare();
    };
    const up = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });
}

function wirePan() {
  const viewport = $('#viewport');
  let dragging = false, startX = 0, startY = 0, panStartX = 0, panStartY = 0;
  viewport.addEventListener('pointerdown', (event) => {
    if (event.target.closest('#divider')) return;
    dragging = true;
    startX = event.clientX; startY = event.clientY;
    panStartX = state.panX; panStartY = state.panY;
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const scale = state.zoom;
    state.panX = panStartX + (event.clientX - startX) / scale;
    state.panY = panStartY + (event.clientY - startY) / scale;
    applyTransform();
  });
  ['pointerup', 'pointerleave'].forEach((name) =>
    viewport.addEventListener(name, () => {
      dragging = false; viewport.classList.remove('dragging');
    }));
}

function schedulePreview(delay = 220) {
  if (!state.selectedId) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(refreshPreview, delay);
}

async function refreshPreview() {
  if (!state.selectedId) return;
  const seq = ++state.seq;
  if (state.inflight) state.inflight.abort();
  const controller = new AbortController();
  state.inflight = controller;
  const started = performance.now();
  let response;
  try {
    response = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: state.selectedId, rotation: state.rotation,
                             payload: payload() }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    return status(`预览失败: ${err.message}`, true);
  }
  if (seq !== state.seq) return;
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    return status(detail.detail || `预览失败 (${response.status})`, true);
  }
  const blob = await response.blob();
  if (seq !== state.seq) return;
  if (state.afterUrl) URL.revokeObjectURL(state.afterUrl);
  state.afterUrl = URL.createObjectURL(blob);
  $('#img-after').src = state.afterUrl;
  const engine = response.headers.get('X-Engine') || '?';
  $('#engine-badge').textContent = engine.includes('wgpu') ? 'GPU · Vulkan' : 'CPU';
  $('#engine-badge').className = `badge ${engine.includes('wgpu') ? 'gpu' : 'cpu'}`;
  $('#timing').textContent = `${(performance.now() - started).toFixed(0)} ms`;
  applyCompare();
}

async function process(ids) {
  const body = {
    upload_ids: ids,
    rotation: state.rotation,
    payload: payload(),
    mode: $('#render-mode').value,
    max_edge: Number($('#render-size').value),
  };
  ids.forEach((id) => { state.jobs[id] = { status: 'queued' }; });
  renderFilmstrip();
  let response;
  try {
    response = await fetch('/api/render', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) { return status(`导出失败: ${err.message}`, true); }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    return status(detail.detail || `导出失败 (${response.status})`, true);
  }
  const data = await response.json();
  data.jobs.forEach((job) => {
    state.jobs[job.upload_id] = { id: job.id, status: 'running', message: '排队中' };
  });
  renderFilmstrip();
  status(`已提交 ${data.jobs.length} 张（${data.mode === 'gpu' ? 'GPU 快速' : 'f64 精确'}），逐张处理中…`);
  pollJobs(data.jobs.map((job) => job.id));
}

async function pollJobs(ids) {
  const pending = new Set(ids);
  while (pending.size) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    for (const id of [...pending]) {
      let job;
      try { job = await fetch(`/api/jobs/${id}`).then((r) => r.json()); }
      catch (err) { continue; }
      const entry = Object.values(state.jobs).find((j) => j.id === id);
      if (entry) {
        entry.status = job.status;
        entry.message = job.stage || job.status;
        entry.error = job.error;
      }
      if (['done', 'failed', 'interrupted'].includes(job.status)) {
        pending.delete(id);
        if (job.status === 'done') {
          status(`完成：${job.output}（${job.duration || '?'}s）`);
          await refreshResults();
        } else {
          status(`${job.source || '任务'} 失败：${job.error || job.status}`, true);
        }
      }
    }
    renderFilmstrip();
    updateQueueStatus(pending.size);
  }
  updateQueueStatus(0);
}

function updateQueueStatus(count) {
  $('#queue-status').textContent = count ? `队列 ${count} 张` : '';
}

function renderFilmstrip() {
  const host = $('#filmstrip');
  $('#upload-count').textContent = `(${state.uploads.length})`;
  host.innerHTML = state.uploads.map((item) => {
    const job = state.jobs[item.id] || {};
    const done = state.results.some((r) => r.upload_id === item.id);
    const pill = job.status === 'running' || job.status === 'queued'
      ? `<span class="pill busy">${job.message || '处理中'}</span>`
      : job.status === 'failed' ? '<span class="pill fail">失败</span>'
      : done ? '<span class="pill done">已出图</span>' : '';
    return `<div class="card ${item.id === state.selectedId ? 'selected' : ''}" data-id="${item.id}">
      <img src="/api/view/${item.id}?rotation=${state.rotation}" alt="">
      ${pill}
      <button class="remove" title="从列表移除">×</button>
      <div class="name" title="${item.name}">${item.name}</div>
    </div>`;
  }).join('');
  host.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.classList.contains('remove')) {
        state.uploads = state.uploads.filter((u) => u.id !== card.dataset.id);
        if (state.selectedId === card.dataset.id) state.selectedId = null;
        renderFilmstrip();
        return;
      }
      selectUpload(card.dataset.id);
    });
  });
}

async function refreshResults() {
  try { state.results = await fetch('/api/results').then((r) => r.json()); }
  catch (err) { return; }
  renderResults();
  renderFilmstrip();
}

function renderResults() {
  const host = $('#results-grid');
  $('#result-count').textContent = `(${state.results.length})`;
  if (!state.results.length) {
    host.innerHTML = '<div class="dim">还没有结果。选择「处理选中」或「处理全部」后在这里下载。</div>';
    return;
  }
  host.innerHTML = state.results.map((item) => {
    const size = (item.size / 1024 / 1024).toFixed(1);
    const when = new Date(item.created * 1000).toLocaleString('zh-CN', { hour12: false });
    return `<div class="result-card">
      <img src="/api/result-thumb/${encodeURIComponent(item.name)}" alt="">
      <div class="body">
        <div class="name" title="${item.name}">${item.source}</div>
        <div class="meta">${item.width}×${item.height} · ${item.mode === 'gpu' ? 'GPU' : 'f64'} · ${size} MB · ${item.duration}s<br>${when}</div>
        <a href="${item.download}" download>下载 ${item.name.endsWith('.png') ? 'PNG' : 'TIFF'}</a>
      </div>
    </div>`;
  }).join('');
}

function status(message, isError = false) {
  const node = $('#render-status');
  node.textContent = message;
  node.className = isError ? 'err' : 'dim';
}

boot().catch((err) => status(`初始化失败: ${err.message}`, true));
