'use strict';

const state = {
  manifest: null,
  uploadId: null,
  inputEncoding: 'auto',
  extra: {},
  timer: null,
  inflight: null,
  seq: 0,
};

const $ = (sel) => document.querySelector(sel);

async function boot() {
  const [manifest, health] = await Promise.all([
    fetch('/api/manifest').then((r) => r.json()),
    fetch('/api/health').then((r) => r.json()),
  ]);
  state.manifest = manifest;
  renderHealth(health);
  renderProfiles(manifest.profiles, manifest.defaults);
  renderControls(manifest);
  wire();
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
  $('#health').textContent =
    `GPU 预览 ${health.engine_gpu ? '可用' : '不可用（回退 CPU）'} · 导出上限 ${(health.max_pixels / 1e6).toFixed(0)} MP`;
}

function renderProfiles(profiles, defaults) {
  const film = $('#film');
  const paper = $('#print');
  film.innerHTML = profiles.films
    .map((f) => `<option value="${f.slug}">${f.label || f.stock}${f.type === 'positive' ? ' · 反转' : ''}</option>`)
    .join('');
  paper.innerHTML = profiles.papers
    .map((p) => `<option value="${p.slug}">${p.label || p.stock}</option>`)
    .join('');
  film.value = defaults.film;
  paper.value = defaults.print;
  film.addEventListener('change', () => {
    const entry = profiles.films.find((f) => f.slug === film.value);
    if (entry && entry.target_print) paper.value = entry.target_print;
    schedulePreview();
  });
  paper.addEventListener('change', schedulePreview);
  $('#input-encoding').addEventListener('change', (event) => {
    state.inputEncoding = event.target.value;
    schedulePreview();
  });
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
      .map((opt) => `<option value="${opt}">${opt}</option>`)
      .join('');
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
      input.type = 'number';
      input.step = control.step;
      input.min = control.min;
      input.max = control.max;
      input.value = component;
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
  range.type = 'range';
  range.min = control.min;
  range.max = control.max;
  range.step = control.step;
  range.value = value;
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
    else {
      const kind = input.dataset.kind;
      values[input.dataset.path] = kind === 'int' ? parseInt(input.value, 10) : Number(input.value);
    }
  });
  return values;
}

function payload() {
  return {
    film: $('#film').value,
    print: $('#print').value,
    values: collectValues(),
    extra: state.extra,
  };
}

function wire() {
  const drop = $('#dropzone');
  const fileInput = $('#file');
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => fileInput.files[0] && upload(fileInput.files[0]));

  ['dragenter', 'dragover'].forEach((name) =>
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.add('over');
    }));
  ['dragleave', 'drop'].forEach((name) =>
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.remove('over');
    }));
  drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (file) upload(file);
  });

  $('#render').addEventListener('click', startRender);
  $('#apply-extra').addEventListener('click', () => {
    try {
      state.extra = JSON.parse($('#extra').value || '{}');
      schedulePreview();
    } catch (err) {
      $('#render-status').textContent = `JSON 解析失败: ${err.message}`;
    }
  });
}

async function upload(file) {
  const body = new FormData();
  body.append('file', file);
  $('#dropzone').hidden = true;
  $('#preview-wrap').hidden = false;
  $('#preview-meta').textContent = `上传中 ${file.name}…`;

  let response;
  try {
    response = await fetch('/api/upload', { method: 'POST', body });
  } catch (err) {
    return fail(`上传失败: ${err.message}`);
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    return fail(detail.detail || `上传失败 (${response.status})`);
  }
  const info = await response.json();
  state.uploadId = info.id;
  $('#render-panel').hidden = false;
  $('#preview-meta').textContent = `${info.filename} · ${info.width}×${info.height} · ${info.format}`;
  schedulePreview(0);
}

function schedulePreview(delay = 220) {
  if (!state.uploadId) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(refreshPreview, delay);
}

async function refreshPreview() {
  if (!state.uploadId) return;
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
      body: JSON.stringify({
        upload_id: state.uploadId,
        input_encoding: state.inputEncoding,
        payload: payload(),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    return fail(`预览失败: ${err.message}`);
  }
  if (seq !== state.seq) return;

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    return fail(detail.detail || `预览失败 (${response.status})`);
  }
  const blob = await response.blob();
  if (seq !== state.seq) return;

  const url = URL.createObjectURL(blob);
  const img = $('#preview');
  const previous = img.dataset.url;
  img.onload = () => previous && URL.revokeObjectURL(previous);
  img.src = url;
  img.dataset.url = url;

  const engine = response.headers.get('X-Engine') || '?';
  const elapsed = performance.now() - started;
  $('#engine-badge').textContent = engine.includes('wgpu') ? 'GPU · Vulkan' : 'CPU';
  $('#engine-badge').className = `badge ${engine.includes('wgpu') ? 'gpu' : 'cpu'}`;
  $('#timing').textContent = `${elapsed.toFixed(0)} ms`;
  $('#render-status').textContent = '';
}

async function startRender() {
  if (!state.uploadId) return;
  const button = $('#render');
  button.disabled = true;
  $('#render-status').textContent = '已入队…';

  const response = await fetch('/api/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_id: state.uploadId,
      input_encoding: state.inputEncoding,
      payload: payload(),
    }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    button.disabled = false;
    return fail(detail.detail || `导出失败 (${response.status})`);
  }
  const job = await response.json();
  pollJob(job.id, button);
}

async function pollJob(id, button) {
  const started = Date.now();
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const response = await fetch(`/api/jobs/${id}`);
    if (!response.ok) break;
    const job = await response.json();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (job.status === 'done') {
      $('#render-status').innerHTML =
        `完成 (${seconds}s) · <a href="/api/files/${job.output}" download>下载 ${job.output}</a>`;
      button.disabled = false;
      return;
    }
    if (job.status === 'failed') {
      button.disabled = false;
      return fail(job.error || '渲染失败');
    }
    $('#render-status').textContent = `${job.status === 'running' ? '渲染中' : '排队中'} ${seconds}s · f64 全分辨率，CPU 满核`;
  }
  button.disabled = false;
  fail('任务状态丢失');
}

function fail(message) {
  $('#render-status').textContent = message;
  $('#render-status').className = 'dim err';
}

boot().catch((err) => fail(`初始化失败: ${err.message}`));
