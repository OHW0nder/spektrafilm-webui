'use strict';

const state = {
  tab: 'gallery',
  manifest: null,
  uploads: [],
  results: [],
  presets: [],
  rotations: {},        // uploadId -> quarter turns; rotation belongs to the image
  selectedId: null,
  beforeSrc: null,
  beforeImage: null,
  afterUrl: null,
  afterHidden: false,
  zoom: 1, panX: 0, panY: 0,
  compare: 0.5, compareOn: true,
  extra: {},
  jobs: {},             // uploadId -> job state
  timer: null, inflight: null, seq: 0,
  queueUserToggled: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const isMobile = () => window.matchMedia('(max-width: 1080px)').matches;

/* Boot is deliberately fault-tolerant: one broken panel must never leave the
   view buttons without click handlers (the exact failure behind "点击没反应"). */
async function boot() {
  try {
    const [health, manifest, uploads, results, presets] = await Promise.all([
      fetch('/api/health').then((r) => r.json()),
      fetch('/api/manifest').then((r) => r.json()),
      fetch('/api/uploads').then((r) => r.json()),
      fetch('/api/results').then((r) => r.json()),
      fetch('/api/presets').then((r) => r.json()),
    ]);
    state.manifest = manifest;
    state.uploads = uploads;
    state.results = results;
    state.presets = presets;
    uploads.forEach((u) => { state.rotations[u.id] = u.rotation || 0; });
    const steps = [
      ['health', () => renderHealth(health)],
      ['profiles', () => { renderProfiles(manifest); renderStyleChips(manifest); }],
      ['controls', () => renderControls(manifest)],
      ['presets', () => renderPresets()],
      ['queue', () => renderQueue()],
      ['results', () => renderResults()],
    ];
    for (const [name, fn] of steps) {
      try { fn(); } catch (err) { console.error(`render ${name}`, err); }
    }
    if (uploads.length) selectUpload(uploads[0].id);
  } catch (err) {
    console.error('boot', err);
    status(`部分数据加载失败：${err.message}（界面仍可使用）`, true);
  }
  // Always wire, even if a render step failed.
  try { wire(); } catch (err) { console.error('wire', err); }
  syncLayout();
}

function renderHealth(health) {
  const badge = $('#engine-badge');
  badge.textContent = health.engine_gpu ? `GPU · ${health.gpu_backend}` : 'CPU only';
  badge.className = `badge ${health.engine_gpu ? 'gpu' : 'cpu'}`;
  $('#health').textContent =
    `预览/默认导出：wgpu/Vulkan（f32） · 精确模式：Python f64（CPU，16-bit TIFF） · 预览 ${health.preview_size}px` +
    (health.interrupted_jobs ? ` · ${health.interrupted_jobs} 个旧任务已中断` : '');
}

function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-page').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'work') { layoutCanvas(); syncLayout(); }
  if (name === 'gallery') $('#preset-panel').classList.remove('open');
}

function syncLayout() {
  const panel = $('#queue-panel');
  if (!state.queueUserToggled) panel.open = !isMobile();
  if (!isMobile()) $('#preset-panel').classList.remove('open');
  const setHeaderVar = () => document.documentElement.style.setProperty(
    '--header-h', `${Math.round($('header').getBoundingClientRect().height)}px`);
  setHeaderVar();
  if (state.tab === 'work') layoutCanvas();
}

function currentRotation() {
  return state.selectedId ? (state.rotations[state.selectedId] || 0) : 0;
}

function viewUrl(id, rotation) { return `/api/view/${id}?rotation=${rotation}`; }

/* ---------------- parameters ---------------- */

function renderProfiles(manifest) {
  const film = $('#film'), paper = $('#print');
  film.innerHTML = manifest.profiles.films
    .map((f) => `<option value="${f.slug}">${f.label || f.stock}${f.type === 'positive' ? ' · 反转' : ''}</option>`).join('');
  paper.innerHTML = manifest.profiles.papers
    .map((p) => `<option value="${p.slug}">${p.label || p.stock}</option>`).join('');
  film.value = manifest.defaults.film;
  paper.value = manifest.defaults.print;
  film.addEventListener('change', () => {
    const entry = manifest.profiles.films.find((f) => f.slug === film.value);
    if (entry && entry.target_print) paper.value = entry.target_print;
    schedulePreview();
  });
  paper.addEventListener('change', schedulePreview);
}

function renderStyleChips(manifest) {
  const wanted = ['kodak_portra_400', 'kodak_gold_200', 'kodak_ektar_100', 'fujifilm_velvia_100'];
  const host = $('#style-chips');
  host.innerHTML = wanted.map((slug) => {
    const entry = manifest.profiles.films.find((f) => f.slug === slug);
    if (!entry) return '';
    return `<button data-film="${slug}" data-paper="${entry.target_print || manifest.defaults.print}">${(entry.label || slug).replace(/^Kodak |^Fujifilm /, '')}</button>`;
  }).join('');
  host.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    $('#film').value = button.dataset.film;
    $('#print').value = button.dataset.paper;
    schedulePreview();
    $('#preset-panel').classList.remove('open');
  }));
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
    input.type = 'checkbox'; input.checked = Boolean(value);
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
    select.innerHTML = (control.options || []).map((o) => `<option value="${o}">${o}</option>`).join('');
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
      input.dataset.path = control.path; input.dataset.index = index; input.dataset.kind = 'vec';
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
  range.dataset.path = control.path; range.dataset.kind = control.kind;
  range.addEventListener('input', () => {
    val.textContent = formatValue(range.value, control.kind);
    schedulePreview();
  });
  wrap.append(head, range);
  return wrap;
}

function formatValue(value, kind) {
  const n = Number(value);
  if (kind === 'int') return String(n);
  return Number.isInteger(n) ? n.toFixed(1) : n.toFixed(2).replace(/0$/, '');
}

function collectValues() {
  const values = {};
  $$('[data-path]').forEach((input) => {
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

function applyPayload(newPayload) {
  if (newPayload.film) $('#film').value = newPayload.film;
  if (newPayload.print) $('#print').value = newPayload.print;
  Object.entries(newPayload.values || {}).forEach(([path, value]) => {
    $$(`[data-path="${path}"]`).forEach((input) => {
      if (input.dataset.kind === 'vec') input.value = value[Number(input.dataset.index)];
      else if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = value;
      const head = input.closest('.ctrl')?.querySelector('.val');
      if (head) head.textContent = formatValue(input.value, input.dataset.kind);
    });
  });
  state.extra = newPayload.extra || {};
  $('#extra').value = Object.keys(state.extra).length ? JSON.stringify(state.extra, null, 2) : '';
  schedulePreview(0);
}

/* ---------------- presets ---------------- */

function renderPresets() {
  const select = $('#preset-select');
  select.innerHTML = state.presets
    .map((p) => `<option value="${p.id}">${p.name}${p.builtin ? '（内置）' : ''}</option>`).join('');
  const preset = state.presets.find((p) => p.id === select.value);
  $('#preset-delete').disabled = !preset || preset.builtin;
}

async function refreshPresets() {
  state.presets = await fetch('/api/presets').then((r) => r.json());
  renderPresets();
}

function applyPreset() {
  const preset = state.presets.find((p) => p.id === $('#preset-select').value);
  if (preset) {
    applyPayload(preset.payload);
    status(`已应用预设：${preset.name}`);
    if (isMobile()) $('#preset-panel').classList.remove('open');
  }
}

async function savePreset() {
  const name = $('#preset-name').value.trim();
  if (!name) return status('请先填写预设名称', true);
  const response = await fetch('/api/presets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, payload: payload() }),
  });
  if (!response.ok) return status('保存预设失败', true);
  const entry = await response.json();
  $('#preset-name').value = '';
  await refreshPresets();
  $('#preset-select').value = entry.id;
  renderPresets();
  status('预设已保存');
}

async function deletePreset() {
  const id = $('#preset-select').value;
  const preset = state.presets.find((p) => p.id === id);
  if (!preset || preset.builtin) return;
  await fetch(`/api/presets/${id}`, { method: 'DELETE' });
  await refreshPresets();
  renderPresets();
  status('预设已删除');
}

/* ---------------- viewer ---------------- */

function selectUpload(id) {
  if (!id || !state.uploads.some((u) => u.id === id)) return;
  state.selectedId = id;
  state.zoom = 1; state.panX = state.panY = 0;
  state.beforeSrc = viewUrl(id, currentRotation());
  const image = new Image();
  image.onload = () => {
    if (state.selectedId !== id ||
        image.src !== new URL(state.beforeSrc, location.href).href) return;
    state.beforeImage = image;
    $('#img-before').src = state.beforeSrc;
    layoutCanvas(); applyTransform(); schedulePreview(0);
  };
  image.src = state.beforeSrc;
  updateViewerMeta();
  renderQueue();
}

function loadBefore(k) {
  const id = state.selectedId;
  if (!id) return;
  const url = viewUrl(id, k);
  const image = new Image();
  image.onload = () => {
    if (state.selectedId !== id || currentRotation() !== k) return;
    state.beforeImage = image;
    state.beforeSrc = url;
    $('#img-before').src = url;
    layoutCanvas(); applyTransform();
  };
  image.src = url;
}

function setRotation(k) {
  if (!state.selectedId) return;
  state.rotations[state.selectedId] = k;
  fetch(`/api/rotation/${state.selectedId}?rotation=${k}`, { method: 'POST' }).catch(() => {});
  state.afterHidden = true;
  applyCompare();
  showPreviewState('旋转中…');
  loadBefore(k);
  updateViewerMeta();
  schedulePreview(0);
}

function updateViewerMeta() {
  const meta = state.uploads.find((u) => u.id === state.selectedId);
  if (!meta) return;
  const k = currentRotation();
  $('#viewer-meta').textContent =
    `${meta.name} · ${meta.width}×${meta.height}${meta.raw ? ' · RAW' : ''}` +
    (k ? ` · 旋转 ${k * 90}°` : '');
}

function layoutCanvas() {
  const canvas = $('#canvas'), image = state.beforeImage;
  if (!image) return;
  const vp = $('#viewport').getBoundingClientRect();
  if (!vp.width || !vp.height) return;
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
  const visible = Boolean(state.afterUrl) && state.compareOn && !state.afterHidden;
  $('#after-clip').hidden = !visible;
  $('#divider').hidden = !visible;
  if (!visible) return;
  const percent = (state.compare * 100).toFixed(2);
  $('#after-clip').style.clipPath = `inset(0 0 0 ${percent}%)`;
  $('#divider').style.left = `${percent}%`;
  $('#compare-range').value = Math.round(state.compare * 100);
  $('#compare-label').textContent = `${Math.round(state.compare * 100)}%`;
}

function showPreviewState(text) {
  const node = $('#preview-state');
  node.textContent = text;
  node.hidden = !text;
}

/* ---------------- preview (never blank on failure) ---------------- */

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
  showPreviewState('预览生成中…');
  let response;
  try {
    response = await fetch('/api/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: state.selectedId,
                             rotation: currentRotation(), payload: payload() }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      state.afterHidden = false;
      applyCompare();
      showPreviewState('预览请求失败（保留上一张）');
      status(`预览失败: ${err.message}`, true);
    }
    return;
  }
  if (seq !== state.seq) return;
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    state.afterHidden = false;
    applyCompare();
    showPreviewState('预览失败（保留上一张）');
    return status(detail.detail || `预览失败 (${response.status})`, true);
  }
  const blob = await response.blob();
  if (seq !== state.seq) return;
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.onload = () => {
    if (seq !== state.seq) { URL.revokeObjectURL(url); return; }
    const previous = state.afterUrl;
    state.afterUrl = url;
    state.afterHidden = false;
    $('#img-after').src = url;
    if (previous) URL.revokeObjectURL(previous);
    showPreviewState('');
    const engine = response.headers.get('X-Engine') || '?';
    $('#engine-badge').textContent = engine.includes('wgpu') ? 'GPU · Vulkan' : 'CPU';
    $('#engine-badge').className = `badge ${engine.includes('wgpu') ? 'gpu' : 'cpu'}`;
    $('#timing').textContent = `${(performance.now() - started).toFixed(0)} ms`;
    applyCompare();
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    state.afterHidden = false;
    applyCompare();
    showPreviewState('预览解码失败（保留上一张）');
  };
  image.src = url;
}

/* ---------------- queue / jobs ---------------- */

function pendingUploads() {
  return state.uploads.filter((item) => {
    const job = state.jobs[item.id];
    if (job && job.status === 'done') return false;
    if (job && ['running', 'queued', 'failed'].includes(job.status)) return true;
    return !state.results.some((r) => r.upload_id === item.id);
  });
}

function renderQueue() {
  const items = pendingUploads();
  $('#queue-badge').textContent = items.length;
  const busy = Object.values(state.jobs).filter((j) => j.status === 'running' || j.status === 'queued').length;
  $('#queue-summary').textContent = `${items.length} 张待处理 · ${busy} 张处理中 · 完成后自动移入图库`;
  const host = $('#queue-list');
  if (!items.length) {
    host.innerHTML = '<div class="dim">队列为空。点右上角「导入图片」添加。</div>';
    return;
  }
  host.innerHTML = items.map((item) => {
    const job = state.jobs[item.id] || { status: 'idle', progress: 0, stage: '待处理' };
    const active = job.status === 'running' || job.status === 'queued';
    const pill = job.status === 'failed' ? '<span class="pill fail">失败</span>'
      : active ? `<span class="pill busy">${job.stage || '处理中'}</span>` : '';
    const detail = active
      ? `${job.stage || '处理中'} · ${job.progress || 0}% · ${job.elapsed || 0}s` +
        (job.queue_position ? ` · 队列 ${job.queue_position}/${job.queue_total}` : '')
      : (job.status === 'failed' ? (job.error || '失败') : '等待处理');
    return `<div class="queue-item" data-id="${item.id}">
      <img src="${viewUrl(item.id, state.rotations[item.id] || 0)}" alt="">
      <div class="info">
        <div class="name" title="${item.name}">${item.name} ${pill}</div>
        <div class="detail">${item.width}×${item.height}${item.raw ? ' · RAW' : ''} · ${detail}</div>
        <div class="progress ${active ? 'busy' : ''}"><div style="width:${active ? (job.progress || 0) : 0}%"></div></div>
      </div>
      <div class="actions">
        <button data-act="preview">预览</button>
        <button data-act="process">处理</button>
        <button data-act="remove">移除</button>
      </div>
    </div>`;
  }).join('');
  host.querySelectorAll('.queue-item').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
      const act = button.dataset.act;
      if (act === 'preview') { selectUpload(id); switchTab('work'); }
      else if (act === 'process') process([id]);
      else {
        state.uploads = state.uploads.filter((u) => u.id !== id);
        delete state.jobs[id];
        if (state.selectedId === id) state.selectedId = null;
        renderQueue();
      }
    }));
  });
}

async function process(ids) {
  if (!ids.length) return status('没有可处理的图片', true);
  const rotations = {};
  ids.forEach((id) => { rotations[id] = state.rotations[id] || 0; });
  const body = {
    upload_ids: ids, rotation: 0, rotations, payload: payload(),
    mode: $('#render-mode').value, max_edge: Number($('#render-size').value),
  };
  ids.forEach((id) => { state.jobs[id] = { status: 'queued', progress: 0, stage: '排队中' }; });
  renderQueue();
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
    state.jobs[job.upload_id] = { id: job.id, status: 'running', progress: 0, stage: '排队中' };
  });
  renderQueue();
  status(`已提交 ${data.jobs.length} 张（${data.mode === 'gpu' ? 'GPU 快速' : 'f64 精确'}），可继续调参数`);
  pollJobs(data.jobs.map((job) => job.id));
}

async function pollJobs(ids) {
  const pending = new Set(ids);
  while (pending.size) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const id of [...pending]) {
      let job;
      try { job = await fetch(`/api/jobs/${id}`).then((r) => r.json()); }
      catch (err) { continue; }
      const entry = Object.values(state.jobs).find((j) => j.id === id);
      if (entry) Object.assign(entry, {
        status: job.status, stage: job.stage, progress: job.progress || 0,
        elapsed: job.elapsed, queue_position: job.queue_position,
        queue_total: job.queue_total, error: job.error,
      });
      if (['done', 'failed', 'interrupted'].includes(job.status)) {
        pending.delete(id);
        if (job.status === 'done') {
          status(`完成：${job.output}（${job.duration || '?'}s）已存入图库`);
          await refreshResults();
        } else {
          status(`${job.source || '任务'} 失败：${job.error || job.status}`, true);
        }
      }
    }
    renderQueue();
  }
}

async function refreshResults() {
  try { state.results = await fetch('/api/results').then((r) => r.json()); }
  catch (err) { return; }
  renderResults();
  renderQueue();
}

function renderResults() {
  const host = $('#results-grid');
  $('#result-count').textContent = `共 ${state.results.length} 张`;
  if (!state.results.length) {
    host.innerHTML = '<div class="dim">还没有结果。点上方「导入图片 / 批量处理」开始。</div>';
    return;
  }
  host.innerHTML = state.results.map((item) => {
    const size = (item.size / 1024 / 1024).toFixed(1);
    const when = new Date(item.created * 1000).toLocaleString('zh-CN', { hour12: false });
    return `<div class="result-card">
      <img src="/api/result-thumb/${encodeURIComponent(item.name)}" alt="">
      <div class="body">
        <div class="name" title="${item.name}">${item.source}</div>
        <div class="meta">${item.width}×${item.height} · ${item.mode === 'gpu' ? 'GPU 8-bit PNG' : 'f64 16-bit TIFF'} · ${size} MB · ${item.duration}s<br>${when}</div>
        <a href="${item.download}" download>下载 ${item.name.endsWith('.png') ? 'PNG' : 'TIFF'}</a>
      </div>
    </div>`;
  }).join('');
}

/* ---------------- upload / wiring ---------------- */

async function uploadFiles(files) {
  const body = new FormData();
  files.forEach((file) => body.append('files', file));
  body.append('input_encoding', $('#input-encoding').value);
  body.append('source_space', $('#source-space').value);
  status(`上传并解码 ${files.length} 张…（大图/RAW 首次解码几秒）`);
  let response;
  try { response = await fetch('/api/upload', { method: 'POST', body }); }
  catch (err) { return status(`上传失败: ${err.message}`, true); }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    return status(detail.detail || `上传失败 (${response.status})`, true);
  }
  const data = await response.json();
  state.uploads = [...data.items, ...state.uploads];
  data.items.forEach((item) => { state.rotations[item.id] = 0; });
  renderQueue();
  selectUpload(data.items[0].id);
  switchTab('work');
  status(`已导入 ${data.items.length} 张 · 调好参数后点「处理全部」，结果自动进图库`);
}

function wire() {
  $$('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  $('#back-gallery').addEventListener('click', () => switchTab('gallery'));
  $('#add').addEventListener('click', () => $('#file').click());
  $('#import-more').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', () => {
    if ($('#file').files.length) uploadFiles([...$('#file').files]);
    $('#file').value = '';
  });

  // Drag & drop anywhere: an overlay appears only while a file is being dragged,
  // so there is no leftover "drop images here" block at the bottom of the page.
  const overlay = document.createElement('div');
  overlay.id = 'drop-overlay';
  overlay.textContent = '松开即可导入图片';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:80;display:none;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,.78);color:#d9a441;font-size:18px;' +
    'border:4px dashed #d9a441';
  document.body.appendChild(overlay);
  document.addEventListener('dragover', (e) => { e.preventDefault(); overlay.style.display = 'flex'; });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) overlay.style.display = 'none';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); overlay.style.display = 'none';
    const files = [...e.dataTransfer.files];
    if (files.length) uploadFiles(files);
  });

  $('#process-all').addEventListener('click', () => process(pendingUploads().map((u) => u.id)));
  $('#process-current').addEventListener('click', () =>
    state.selectedId ? process([state.selectedId]) : status('请先选择一张图片', true));
  $('#clear-done').addEventListener('click', () => {
    const pending = new Set(pendingUploads().map((u) => u.id));
    state.uploads = state.uploads.filter((u) => pending.has(u.id));
    renderQueue();
  });

  $('#queue-panel > summary').addEventListener('click', () => { state.queueUserToggled = true; });
  $('#preset-open').addEventListener('click', () => $('#preset-panel').classList.add('open'));
  $('#preset-close').addEventListener('click', () => $('#preset-panel').classList.remove('open'));
  $('#preset-select').addEventListener('change', renderPresets);
  $('#preset-apply').addEventListener('click', applyPreset);
  $('#preset-save').addEventListener('click', savePreset);
  $('#preset-delete').addEventListener('click', deletePreset);
  $('#apply-extra').addEventListener('click', () => {
    try { state.extra = JSON.parse($('#extra').value || '{}'); schedulePreview(); }
    catch (err) { status(`JSON 解析失败: ${err.message}`, true); }
  });

  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25));
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25));
  $('#zoom-reset').addEventListener('click', () => {
    state.zoom = 1; state.panX = state.panY = 0; applyTransform();
  });
  $('#viewport').addEventListener('wheel', (event) => {
    if (!state.selectedId) return;
    event.preventDefault();
    setZoom(state.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });
  $('#rot-left').addEventListener('click', () => setRotation((currentRotation() + 3) % 4));
  $('#rot-right').addEventListener('click', () => setRotation((currentRotation() + 1) % 4));
  $('#compare-toggle').addEventListener('click', () => {
    state.compareOn = !state.compareOn;
    $('#compare-toggle').classList.toggle('active', state.compareOn);
    applyCompare();
  });
  $('#compare-range').addEventListener('input', (event) => {
    state.compare = Number(event.target.value) / 100;
    applyCompare();
  });
  wirePan();
  window.addEventListener('resize', syncLayout);
}

function wirePan() {
  const viewport = $('#viewport');
  let dragging = false, startX = 0, startY = 0, panStartX = 0, panStartY = 0;
  viewport.addEventListener('pointerdown', (event) => {
    if (!state.selectedId) return;
    dragging = true;
    startX = event.clientX; startY = event.clientY;
    panStartX = state.panX; panStartY = state.panY;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const scale = state.zoom;
    state.panX = panStartX + (event.clientX - startX) / scale;
    state.panY = panStartY + (event.clientY - startY) / scale;
    applyTransform();
  });
  const end = () => { dragging = false; viewport.classList.remove('dragging'); };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
}

function status(message, isError = false) {
  const node = $('#render-status');
  node.textContent = message;
  node.className = isError ? 'err status-bar' : 'dim status-bar';
}

boot().catch((err) => status(`界面初始化异常：${err.message}`, true));
