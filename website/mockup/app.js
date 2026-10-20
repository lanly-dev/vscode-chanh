/* Chanh VS Code extension — interactive mockup
 * No build step, no dependencies. All data is local and simulated.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const escAttr = esc;
  const svg = (name, cls = 'icon') => `<svg class="${cls}"><use href="#i-${name}"></use></svg>`;
  const capImg = (name, cls = 'row-icon cap') => `<img class="${cls}" src="assets/capabilities/${name}.svg" alt="" />`;
  const now = () => 'just now';
  const cssEscape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

  const CAP_ORDER = ['chat', 'image', 'transcription', 'embeddings', 'tts', 'omni', 'audio-generation', 'classification', 'reranking', '3d', 'custom'];
  const CAP_TITLES = {
    omni: 'Omni', chat: 'Chat', embeddings: 'Embedding', reranking: 'Reranking', classification: 'Classification',
    transcription: 'Transcription', tts: 'Text-to-Speech', 'audio-generation': 'Audio generation', image: 'Image', '3d': '3D', custom: 'Custom', other: 'Other'
  };

  const fmtSize = (gb) => {
    if (typeof gb !== 'number' || gb <= 0) return '';
    return gb < 1 ? `${Math.max(1, Math.round(gb * 1024))} MB` : `${gb.toFixed(2)} GB`;
  };
  const fmtGB = (gb) => (gb < 1 ? `${Math.round(gb * 1024)} MB` : `${gb.toFixed(1)} GB`);
  const fmtNumber = (n) => Number(n).toLocaleString('en-US');

  /* ------------------------------------------------------------------ */
  /* Seed data                                                           */
  /* ------------------------------------------------------------------ */
  function makeModel(id, size, labels, extra = {}) {
    const base = {
      id, size, labels,
      ctx: 4096,
      maxCtx: 131072,
      recipe: 'llamacpp',
      type: 'chat',
      ownedBy: 'lemonade',
      registry: 'huggingface',
      checkpoint: `lemonade/${id}`,
      created: '2025-09-14',
      savedCtx: undefined,
      loaded: false,
      hot: false
    };
    return { ...base, ...extra };
  }

  const INSTALLED_SEED = [
    makeModel('Qwen3.5-4B-MTP-GGUF', 3.41, ['chat', 'vision', 'tool-calling', 'mtp'], {
      loaded: true, ctx: 4096, maxCtx: 262144, savedCtx: 49152,
      checkpoint: 'unsloth/Qwen3.5-4B-MTP-GGUF:Qwen3.5-4B-UD-Q4_K_XL.gguf',
      created: '2009-02-13', createdValue: 1234567890, backendUrl: 'http://127.0.0.1:8012/v1',
      type: 'chat', registry: 'huggingface'
    }),
    makeModel('Bonsai-1.7B-gguf', 0.23, ['chat', 'tool-calling']),
    makeModel('Bonsai-4B-gguf', 0.53, ['chat', 'tool-calling']),
    makeModel('Bonsai-8B-gguf', 1.08, ['chat', 'tool-calling']),
    makeModel('LFM2-1.2B-GGUF', 0.68, ['chat']),
    makeModel('LFM2.5-1.2B-Instruct-GGUF', 0.68, ['chat', 'tool-calling']),
    makeModel('user.LMX-Omni-5.5B-Lite-Custom', 9.30, ['omni', 'chat', 'vision'], { recipe: 'collection.omni', type: 'omni', loaded: true }),
    makeModel('MiniCPM-V-4-GGUF', 2.04, ['chat', 'vision', 'image', 'tool-calling']),
    makeModel('MiniCPM-V-4.6-GGUF', 1.53, ['chat', 'vision', 'image', 'tool-calling'], { hot: true }),
    makeModel('Qwen3-0.6B-GGUF', 0.36, ['chat', 'tool-calling']),
    makeModel('SDXL-Turbo', 6.94, ['image'], { recipe: 'sd.cpp', type: 'image', hot: true, checkpoint: 'stabilityai/sdxl-turbo' }),
    makeModel('FLUX.1-schnell', 11.90, ['image'], { recipe: 'sd.cpp', type: 'image', checkpoint: 'black-forest-labs/FLUX.1-schnell' }),
    makeModel('SD-Turbo', 4.86, ['image'], { recipe: 'sd.cpp', type: 'image', loaded: true }),
    makeModel('RealESRGAN-x4', 0.07, ['image'], { recipe: 'sd.cpp', type: 'image' }),
    makeModel('Whisper-Large-v3', 1.55, ['transcription'], { recipe: 'whisper.cpp', type: 'transcription' }),
    makeModel('Whisper-Small', 0.48, ['transcription'], { recipe: 'whisper.cpp', type: 'transcription' }),
    makeModel('Whisper-Tiny', 0.07, ['transcription'], { recipe: 'whisper.cpp', type: 'transcription', loaded: true }),
    makeModel('kokoro-v1', 0.33, ['tts'], { recipe: 'onnx', type: 'tts', loaded: true }),
    makeModel('nomic-embed-text-v1.5', 0.55, ['embeddings'], { recipe: 'llamacpp', type: 'embeddings' }),
    makeModel('all-MiniLM-L6-v2', 0.09, ['embeddings'], { recipe: 'llamacpp', type: 'embeddings' }),
    makeModel('bge-reranker-v2-m3', 0.57, ['reranking'], { recipe: 'llamacpp', type: 'reranking' }),
    makeModel('TripoSR', 1.70, ['3d'], { recipe: 'onnx', type: '3d' })
  ];

  const DOWNLOADABLE_SEED = [
    makeModel('Qwen3.5-8B-MTP-GGUF', 5.12, ['chat', 'vision', 'tool-calling', 'mtp'], { hot: true, maxCtx: 262144 }),
    makeModel('Qwen3.5-14B-MTP-GGUF', 8.94, ['chat', 'vision', 'tool-calling', 'mtp'], { hot: true, maxCtx: 262144 }),
    makeModel('Gemma-3-4B-it-GGUF', 2.42, ['chat', 'vision', 'tool-calling']),
    makeModel('Gemma-3-12B-it-GGUF', 7.31, ['chat', 'vision']),
    makeModel('Llama-3.2-3B-Instruct-GGUF', 2.02, ['chat', 'tool-calling']),
    makeModel('DeepSeek-R1-Distill-Qwen-7B-GGUF', 4.68, ['chat', 'tool-calling'], { hot: true }),
    makeModel('Phi-4-mini-instruct-GGUF', 2.49, ['chat', 'tool-calling']),
    makeModel('Mistral-7B-Instruct-v0.3-GGUF', 4.37, ['chat']),
    makeModel('MiniCPM-V-4.5-GGUF', 1.62, ['chat', 'vision', 'image', 'tool-calling']),
    makeModel('LMX-Omni-7B', 12.80, ['omni', 'chat', 'vision', 'audio-generation'], { recipe: 'collection.omni', type: 'omni' }),
    makeModel('SDXL-Lightning', 6.94, ['image'], { recipe: 'sd.cpp', type: 'image', hot: true }),
    makeModel('Kolors', 11.20, ['image'], { recipe: 'sd.cpp', type: 'image' }),
    makeModel('Playground-v2.5', 6.60, ['image'], { recipe: 'sd.cpp', type: 'image' }),
    makeModel('Sana-1.6B', 3.20, ['image'], { recipe: 'sd.cpp', type: 'image' }),
    makeModel('Whisper-Medium', 0.77, ['transcription'], { recipe: 'whisper.cpp', type: 'transcription' }),
    makeModel('Whisper-Large-v3-Turbo', 0.81, ['transcription'], { recipe: 'whisper.cpp', type: 'transcription' }),
    makeModel('Piper-en_US-amy', 0.06, ['tts'], { recipe: 'onnx', type: 'tts' }),
    makeModel('F5-TTS', 1.35, ['tts'], { recipe: 'onnx', type: 'tts' }),
    makeModel('bge-large-en-v1.5', 0.67, ['embeddings'], { type: 'embeddings' }),
    makeModel('E5-Mistral-7B', 14.20, ['embeddings'], { type: 'embeddings' }),
    makeModel('jina-reranker-v2', 1.10, ['reranking'], { type: 'reranking' }),
    makeModel('Stable-Fast-3D', 2.40, ['3d'], { recipe: 'onnx', type: '3d' }),
    makeModel('FLUX.1-dev', 23.80, ['image'], { recipe: 'sd.cpp', type: 'image', hot: true }),
    makeModel('Qwen3-4B-Thinking-GGUF', 2.50, ['chat', 'tool-calling'])
  ];

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  const SERVER_PRESETS = {
    LEMONADE: { name: 'Lemonade Server (System)', url: 'http://localhost:13305', version: '11.8.1', managed: false },
    LEMOND: { name: 'lemond (Managed by Chanh)', url: 'http://localhost:8000', version: '11.8.1', managed: true },
    CUSTOM: { name: 'Custom Server', url: 'http://192.168.1.20:13305', version: '11.8.1', managed: false }
  };

  const state = {
    serverMode: 'LEMONADE',
    customUrl: 'http://192.168.1.20:13305',
    status: 'RUNNING',
    models: INSTALLED_SEED.map(m => ({ ...m })),
    downloadable: DOWNLOADABLE_SEED.map(m => ({ ...m })),
    downloads: new Map(),
    partials: new Map(),
    selectedId: 'Qwen3.5-4B-MTP-GGUF',
    infoModelId: 'Qwen3.5-4B-MTP-GGUF',
    chatModelId: 'Qwen3.5-4B-MTP-GGUF',
    tabs: [
      { id: 'model-info', label: 'Qwen3.5-4B-MTP-GGUF', icon: 'info', closable: true }
    ],
    activeTab: 'model-info',
    expanded: {
      server: true,
      system: true,
      loaded: true,
      downloads: true,
      installed: true,
      downloadable: false,
      backends: false,
      pinned: false,
      capIns: new Set(['chat']),
      capDl: new Set()
    },
    hideSections: false,
    groupIns: true,
    groupDl: true,
    hotOnly: false,
    capFilters: {},
    pinnedBackend: 'Vulkan',
    showTokenStats: true,
    sampleInterval: 5,
    modelPickerOpen: false,
    stream: null,
    tokens: { prompt: 1284, completion: 312, tps: 38.4 },
    chatMessages: [],
    tour: { active: false, step: 0 },
    palette: null,
    quickPick: null
  };

  const sys = { cpu: 18, gpu: 6, ram: 41 };
  let toastSeq = 0;
  let chatBuilt = false;
  let streamTimer = null;
  let downloadTimer = null;

  /* ------------------------------------------------------------------ */
  /* Model helpers                                                       */
  /* ------------------------------------------------------------------ */
  function allModels() { return [...state.models, ...state.downloadable]; }
  function getModel(id) { return allModels().find(m => m.id === id); }
  function isDownloaded(id) { return state.models.some(m => m.id === id); }
  function categoriesOf(model) {
    const cats = [];
    for (const label of model.labels || []) {
      const l = String(label).toLowerCase();
      if (CAP_ORDER.includes(l) && !cats.includes(l)) cats.push(l);
    }
    if (model.id.toLowerCase().includes('omni') && !cats.includes('omni')) cats.push('omni');
    return cats.length ? cats : ['other'];
  }
  function hasCap(model, cap) { return categoriesOf(model).includes(cap); }
  function chatModels() { return state.models.filter(m => hasCap(m, 'chat')); }
  function isHotOnlyFiltered(model) { return !state.hotOnly || model.hot; }

  function groupModels(models, downloadable = false) {
    const source = downloadable && state.hotOnly ? models.filter(m => m.hot) : models;
    const map = new Map();
    for (const model of source) {
      for (const cat of categoriesOf(model)) {
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat).push(model);
      }
    }
    const order = [...CAP_ORDER, 'other'];
    return order.filter(c => map.has(c)).map(c => ({ category: c, models: map.get(c) }));
  }

  function subFilterKey(category, downloadable) { return `${downloadable ? 'dl' : 'ins'}:${category}`; }
  function subFilterOptions(category, downloadable) {
    const source = (downloadable ? state.downloadable : state.models).filter(m => categoriesOf(m).includes(category));
    const labels = new Set();
    let hasGeneral = false;
    for (const m of source) {
      const extras = (m.labels || []).map(l => l.toLowerCase()).filter(l => l !== category && l !== 'hot');
      if (extras.length === 0) hasGeneral = true;
      for (const l of extras) labels.add(l);
    }
    return { labels: [...labels], hasGeneral };
  }
  function matchesSubFilter(model, category, filter) {
    if (!filter) return true;
    const extras = (model.labels || []).map(l => l.toLowerCase()).filter(l => l !== category && l !== 'hot');
    if (filter === '__single__') return extras.length === 0;
    return extras.includes(filter);
  }

  /* ------------------------------------------------------------------ */
  /* Toasts                                                              */
  /* ------------------------------------------------------------------ */
  function showToast(title, message = '', type = 'info', actions = []) {
    const root = $('#toastRoot');
    const el = document.createElement('div');
    const id = ++toastSeq;
    el.className = 'toast';
    el.dataset.toastId = String(id);
    const iconName = type === 'success' ? 'check-circle' : type === 'warn' ? 'warning' : 'info';
    el.innerHTML = `
      <svg class="toast-icon ${type}"><use href="#i-${iconName}"></use></svg>
      <div class="toast-body">
        <div><b>${esc(title)}</b>${message ? ` ${message}` : ''}</div>
        ${actions.length ? `<div class="toast-actions">${actions.map((a, i) => `<button data-toast-action="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
      </div>
      <button class="toast-close" aria-label="Dismiss">${svg('close')}</button>`;
    root.appendChild(el);
    const dismiss = () => {
      if (!el.isConnected) return;
      el.classList.add('out');
      setTimeout(() => el.remove(), 180);
    };
    el.querySelector('.toast-close').addEventListener('click', dismiss);
    actions.forEach((action, i) => {
      el.querySelector(`[data-toast-action="${i}"]`).addEventListener('click', () => {
        dismiss();
        action.run();
      });
    });
    setTimeout(dismiss, 5200);
    while (root.children.length > 3) root.firstElementChild.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Server                                                              */
  /* ------------------------------------------------------------------ */
  function serverInfo() {
    const p = SERVER_PRESETS[state.serverMode] || SERVER_PRESETS.LEMONADE;
    return { ...p, url: state.serverMode === 'CUSTOM' ? state.customUrl : p.url };
  }
  function serverLabel() { return serverInfo().name; }

  function switchServerMode(mode, announce = true) {
    state.serverMode = mode;
    state.status = 'RUNNING';
    if (mode === 'CUSTOM') state.customUrl = state.customUrl || SERVER_PRESETS.CUSTOM.url;
    renderTree();
    updateStatusbar();
    if (state.activeTab === 'settings') renderSettings();
    if (announce) {
      const info = serverInfo();
      showToast('Active server switched', `to <b>${esc(info.name)}</b> — ${esc(info.url.replace('http://', ''))}`, 'success');
    }
  }

  function toggleServer() {
    if (state.status === 'RUNNING') {
      state.status = 'STOPPED';
      for (const m of state.models) m.loaded = false;
      showToast('Server stopped', 'The local model server is no longer listening.', 'warn');
    } else {
      state.status = 'RUNNING';
      showToast('Server started', `Listening on <code>${esc(serverInfo().url.replace('http://', ''))}</code>`, 'success');
    }
    renderTree();
    updateStatusbar();
  }

  /* ------------------------------------------------------------------ */
  /* Tree rendering                                                      */
  /* ------------------------------------------------------------------ */
  const rowIcon = (name, cls) => `<svg class="row-icon ${cls || ''}"><use href="#i-${name}"></use></svg>`;
  const chevron = (open) => `<span class="chevron">${svg(open ? 'chevron-down' : 'chevron-right')}</span>`;
  const leafIndent = '<span class="chevron empty"></span>';
  const pad = (depth) => `padding-left:${6 + depth * 12}px`;

  function actionsHtml(actions) {
    return `<span class="row-actions">${actions.map(a =>
      `<button class="row-action" data-action="${a.action}" ${a.model ? `data-model="${escAttr(a.model)}"` : ''} ${a.extra || ''} title="${escAttr(a.title)}">${svg(a.icon)}</button>`
    ).join('')}</span>`;
  }

  function sectionRow({ key, depth, open, iconHtml, label, desc = '', cls = '', tour = '', actions = [] }) {
    return `<div class="tree-row group ${cls}" style="${pad(depth)}" data-toggle="${key}" ${tour ? `data-tour="${tour}"` : ''}>
      ${chevron(open)}${iconHtml}<span class="label">${esc(label)}</span>
      ${desc ? `<span class="desc">${desc}</span>` : ''}${actionsHtml(actions)}
    </div>`;
  }

  function modelRow(model, depth, downloadable = false, grouped = false) {
    const loaded = !downloadable && model.loaded;
    const icon = downloadable
      ? (model.hot ? rowIcon('flame', 'hot') : rowIcon('cloud', 'idle'))
      : (loaded ? rowIcon('check-circle', 'loaded') : (grouped && model.hot ? rowIcon('flame', 'hot') : rowIcon('circle-fill', 'idle')));
    const desc = fmtSize(model.size);
    const selected = state.selectedId === model.id ? ' selected' : '';
    const tooltip = `${model.id}\n${model.labels.join(', ')}\n${fmtSize(model.size)}`;
    const actions = downloadable
      ? [{ action: 'download', model: model.id, icon: 'download', title: 'Download Model' }]
      : [
        { action: 'info', model: model.id, icon: 'info', title: 'Show Model Info' },
        { action: 'backend', model: model.id, icon: 'circuit', title: 'Select Backend' },
        loaded
          ? { action: 'unload', model: model.id, icon: 'run-below', title: 'Unload Model' }
          : { action: 'load', model: model.id, icon: 'run-above', title: 'Load Model' }
      ];
    return `<div class="tree-row model${selected}${loaded ? ' loaded' : ''}" style="${pad(depth)}"
      data-model-id="${escAttr(model.id)}" data-downloadable="${downloadable}" data-tour="${downloadable ? '' : `model-${escAttr(model.id)}`}" title="${escAttr(tooltip)}">
      ${leafIndent}${icon}<span class="label ${loaded ? 'green' : ''}">${esc(model.id)}</span>
      <span class="desc">${esc(desc)}</span>${actionsHtml(actions)}
    </div>`;
  }

  function sysRow(depth, label, key) {
    return `<div class="tree-row sys-row" style="${pad(depth)}" title="${label} utilization">
      ${leafIndent}${rowIcon('layout', 'idle')}<span class="label">${label}</span>
      <span class="desc" data-sys-val="${key}">${sys[key]}%</span>
    </div>`;
  }

  function statusRow(depth) {
    const running = state.status === 'RUNNING';
    const icon = running ? rowIcon('play', 'loaded') : rowIcon('stop', 'idle');
    const color = running ? 'green' : '';
    return `<div class="tree-row" style="${pad(depth)}">${leafIndent}${icon}
      <span class="label ${color}">Status: ${running ? 'Running' : 'Stopped'}</span>
      <span class="desc">${running ? 'healthy' : 'offline'}</span>
      <span class="row-actions">
        <button class="row-action" data-action="${running ? 'stopServer' : 'startServer'}" title="${running ? 'Stop Server' : 'Start Server'}">${svg(running ? 'stop' : 'play')}</button>
      </span>
    </div>`;
  }

  function serverSection() {
    const info = serverInfo();
    let html = `<div class="tree-row header" style="${pad(0)}" data-toggle="server" data-tour="server">
      ${chevron(state.expanded.server)}${rowIcon('server', '')}<span class="label">${esc(info.name)}</span>
      <span class="row-actions">
        <button class="row-action" data-action="switchServer" title="Switch Server">${svg('swap')}</button>
        ${info.managed ? `<button class="row-action" data-action="reveal" title="Reveal Binary Folder">${svg('folder')}</button>` : ''}
        <button class="row-action" data-action="refresh" title="Refresh Server Status">${svg('refresh')}</button>
      </span>
    </div>`;

    if (state.expanded.server) {
      html += statusRow(1);
      html += `<div class="tree-row" style="${pad(1)}">${leafIndent}${rowIcon('link', 'idle')}
        <span class="label">${esc(info.url)}</span>
        <span class="row-actions"><button class="row-action" data-action="openUrl" title="Open Server URL">${svg('link')}</button>
        <button class="row-action" data-action="editPort" title="Edit Server Port / URL">${svg('gear')}</button></span></div>`;
      html += `<div class="tree-row" style="${pad(1)}">${leafIndent}${rowIcon('versions', 'idle')}<span class="label">Version: v${info.version}</span></div>`;
      html += `<div class="tree-row" style="${pad(1)}">${leafIndent}${rowIcon('hash', 'idle')}<span class="label">Max Loaded Models: Unlimited</span></div>`;

      const backends = [
        { name: 'llamacpp', desc: 'Vulkan · running' },
        { name: 'whisper.cpp', desc: 'CPU · installed' },
        { name: 'sd.cpp', desc: 'Vulkan · installed' }
      ];
      html += sectionRow({
        key: 'backends', depth: 1, open: state.expanded.backends,
        iconHtml: rowIcon('circuit', 'idle'), label: `Backends/Recipes (${backends.length})`
      });
      if (state.expanded.backends) {
        for (const b of backends) {
          html += `<div class="tree-row" style="${pad(2)}">${leafIndent}${rowIcon('circuit', 'idle')}
            <span class="label">${b.name}</span><span class="desc">${b.desc}</span></div>`;
        }
      }

      html += sectionRow({
        key: 'pinned', depth: 1, open: state.expanded.pinned,
        iconHtml: rowIcon('pin', 'idle'), label: 'Pinned Models (0)'
      });
      if (state.expanded.pinned) {
        html += `<div class="tree-row" style="${pad(2)}">${leafIndent}${rowIcon('circle', 'idle')}<span class="label" style="color:#9d9d9d">No pinned models</span></div>`;
      }
    }
    return html;
  }

  function systemSection() {
    let html = sectionRow({
      key: 'system', depth: 0, open: state.expanded.system,
      iconHtml: rowIcon('layout', ''), label: 'System', desc: 'live'
    });
    if (state.expanded.system) {
      html += sysRow(1, 'CPU', 'cpu', 'cpu');
      html += sysRow(1, 'GPU', 'gpu', 'gpu');
      html += sysRow(1, 'RAM', 'ram', 'ram');
    }
    return html;
  }

  function loadedSection() {
    if (state.status !== 'RUNNING') return '';
    const loaded = state.models.filter(m => m.loaded);
    let html = sectionRow({
      key: 'loaded', depth: 0, open: state.expanded.loaded,
      iconHtml: rowIcon(loaded.length ? 'zap' : 'zap', loaded.length ? 'hot' : 'idle'),
      label: `Loaded Models (${loaded.length})`
    });
    if (state.expanded.loaded) {
      if (loaded.length === 0) {
        html += `<div class="tree-row" style="${pad(1)}">${leafIndent}${rowIcon('circle', 'idle')}<span class="label" style="color:#9d9d9d">No loaded models</span></div>`;
      } else {
        for (const m of loaded) {
          html += `<div class="tree-row model${state.selectedId === m.id ? ' selected' : ''}" style="${pad(1)}" data-model-id="${escAttr(m.id)}" data-downloadable="false" title="${escAttr(m.id)}">
            ${leafIndent}${rowIcon('check-circle', 'loaded')}<span class="label green">${esc(m.id)}</span>
            <span class="desc">idle</span>
            <span class="row-actions">
              <button class="row-action" data-action="info" data-model="${escAttr(m.id)}" title="Show Model Info">${svg('info')}</button>
              <button class="row-action" data-action="endpoint" data-model="${escAttr(m.id)}" title="Add Entry to VS Code’s Chat Custom Endpoints">${svg('plug')}</button>
              <button class="row-action" data-action="unload" data-model="${escAttr(m.id)}" title="Unload Model">${svg('run-below')}</button>
            </span>
          </div>`;
        }
      }
    }
    return html;
  }

  function downloadProgressText(d) {
    return `${d.pct.toFixed(1)}%  ${fmtGB(d.total * d.pct / 100)} / ${fmtGB(d.total)}`;
  }

  function downloadsSection() {
    const total = state.downloads.size + state.partials.size;
    if (total === 0) return '';
    let html = sectionRow({
      key: 'downloads', depth: 0, open: state.expanded.downloads,
      iconHtml: `<span class="row-icon spin">${svg('spinner')}</span>`,
      label: 'Downloading Models', desc: `(${total})`
    });
    if (state.expanded.downloads) {
      for (const d of state.downloads.values()) {
        html += `<div class="tree-row model" style="${pad(1)}" data-download-row="${escAttr(d.id)}">
          ${leafIndent}<span class="row-icon spin">${svg('spinner')}</span>
          <span class="label">${esc(d.id)}</span>
          <span class="desc">${downloadProgressText(d)}</span>
          <span class="row-actions"><button class="row-action" data-action="cancelDownload" data-model="${escAttr(d.id)}" title="Cancel Download">${svg('close')}</button></span>
        </div>`;
      }
      for (const p of state.partials.values()) {
        html += `<div class="tree-row model" style="${pad(1)}" title="Not fully downloaded. Retry, or Remove to delete the partial file.">
          ${leafIndent}${rowIcon('warning', 'warn')}<span class="label">${esc(p.id)}</span>
          <span class="desc">${esc(p.message)}</span>
          <span class="row-actions">
            <button class="row-action" data-action="download" data-model="${escAttr(p.id)}" title="Retry Download">${svg('refresh')}</button>
            <button class="row-action" data-action="removePartial" data-model="${escAttr(p.id)}" title="Remove Partial File">${svg('trash')}</button>
          </span>
        </div>`;
      }
    }
    return html;
  }

  function capGroupSection(group, downloadable, depth) {
    const filtered = state.capFilters[subFilterKey(group.category, downloadable)];
    const { labels, hasGeneral } = subFilterOptions(group.category, downloadable);
    const options = labels.length + (hasGeneral ? 1 : 0);
    const models = filtered
      ? group.models.filter(m => matchesSubFilter(m, group.category, filtered))
      : group.models;
    const set = downloadable ? state.expanded.capDl : state.expanded.capIns;
    const open = set.has(group.category);
    const desc = filtered
      ? `filter: ${filtered === '__single__' ? 'No sub-capability' : filtered} (${models.length})`
      : options > 1 ? `${options} filters` : '';
    const actions = options > 1
      ? [{ action: 'filterGroup', extra: `data-cap="${escAttr(group.category)}" data-dl="${downloadable}"`, icon: 'filter', title: filtered ? 'Clear Sub-Capability Filter' : 'Filter by Sub-Capability' }]
      : [];
    let html = sectionRow({
      key: `cap:${downloadable ? 'dl' : 'ins'}:${group.category}`,
      depth, open,
      iconHtml: group.category === 'other' ? rowIcon('circle-fill', 'idle') : capImg(group.category),
      label: `${CAP_TITLES[group.category] || group.category} (${models.length})`,
      desc, cls: 'cap-group', actions
    });
    if (open) {
      for (const m of models) html += modelRow(m, depth + 1, downloadable, true);
      if (models.length === 0) {
        html += `<div class="tree-row" style="${pad(depth + 1)}">${leafIndent}<span class="label" style="color:#9d9d9d">No models match this filter</span></div>`;
      }
    }
    return html;
  }

  function installedSection() {
    if (state.hideSections) return '';
    const models = state.models;
    let html = sectionRow({
      key: 'installed', depth: 0, open: state.expanded.installed,
      iconHtml: rowIcon('list', ''),
      label: `Installed Models (${models.length})`,
      desc: fmtSize(models.reduce((sum, m) => sum + (m.size || 0), 0)),
      tour: 'installed',
      actions: [{ action: 'toggleGrouping', icon: 'group', title: 'Toggle Model Grouping by Capability' }]
    });
    if (state.expanded.installed) {
      if (state.groupIns) {
        for (const g of groupModels(models)) html += capGroupSection(g, false, 1);
      } else {
        const ordered = [...models].sort((a, b) => Number(b.loaded) - Number(a.loaded));
        for (const m of ordered) html += modelRow(m, 1, false);
      }
    }
    return html;
  }

  function downloadableSection() {
    if (state.hideSections) return '';
    const models = state.hotOnly ? state.downloadable.filter(m => m.hot) : state.downloadable;
    let html = sectionRow({
      key: 'downloadable', depth: 0, open: state.expanded.downloadable,
      iconHtml: state.hotOnly ? rowIcon('flame', 'hot') : rowIcon('cloud', ''),
      label: `Downloadable Models (${models.length})`,
      tour: 'downloadable',
      actions: [
        { action: 'toggleHot', icon: 'flame', title: 'Toggle Downloadable Hot Models Only' },
        { action: 'toggleDlGrouping', icon: 'group', title: 'Toggle Downloadable Grouping by Capability' }
      ]
    });
    if (state.expanded.downloadable) {
      if (state.groupDl) {
        for (const g of groupModels(state.downloadable, true)) html += capGroupSection(g, true, 1);
      } else {
        for (const m of models) html += modelRow(m, 1, true);
      }
    }
    return html;
  }

  function renderTree() {
    const tree = $('#tree');
    if (!tree) return;
    const scroll = tree.scrollTop;
    let html = '';
    html += serverSection();
    html += systemSection();
    html += loadedSection();
    html += downloadsSection();
    html += installedSection();
    html += downloadableSection();
    if (!html.trim()) html = '<div style="padding:18px;color:#888">No server data.</div>';
    tree.innerHTML = html;
    tree.scrollTop = scroll;
    paintSystem();
    syncTreeActionIcons();
  }

  function paintSystem() {
    for (const key of ['cpu', 'gpu', 'ram']) {
      $$(`[data-sys-val="${key}"]`).forEach(el => { el.textContent = `${sys[key]}%`; });
      $$(`[data-sys-bar="${key}"]`).forEach(el => { el.style.width = `${sys[key]}%`; });
    }
  }

  function syncTreeActionIcons() {
    const btn = $('#toggleHideBtn');
    if (!btn) return;
    btn.innerHTML = svg(state.hideSections ? 'eye-off' : 'eye');
    btn.title = state.hideSections ? 'Show Installed & Downloadable Sections' : 'Hide Installed & Downloadable Sections';
  }

  /* ------------------------------------------------------------------ */
  /* Tabs                                                                */
  /* ------------------------------------------------------------------ */
  const TAB_ICONS = { 'model-info': 'info', chat: 'chat', settings: 'gear', json: 'file-text' };

  function tabFor(id) {
    if (id === 'model-info') return { id, label: state.infoModelId || 'Model Info', icon: 'info', closable: true };
    if (id === 'chat') return { id, label: 'Chanh Chat', icon: 'chat', closable: true };
    if (id === 'settings') return { id, label: 'Settings', icon: 'gear', closable: true };
    if (id === 'json') return { id, label: 'settings.json', icon: 'file-text', closable: true };
    return { id, label: id, icon: 'file-text', closable: true };
  }

  function renderTabs() {
    const bar = $('#tabbar');
    if (!bar) return;
    if (!state.tabs.some(t => t.id === 'model-info') && state.infoModelId) {
      // model-info tab is optional; selection re-opens it
    }
    const tabs = state.tabs.map(t => {
      if (t.id === 'model-info') t.label = state.infoModelId || 'Model Info';
      return t;
    });
    bar.innerHTML = tabs.map(t => `
      <button class="tab ${state.activeTab === t.id ? 'active' : ''}" data-tab-id="${t.id}" role="tab" aria-selected="${state.activeTab === t.id}">
        <span class="tab-icon">${svg(TAB_ICONS[t.id] || 'file-text')}</span>
        <span class="tab-label">${esc(t.label)}</span>
        ${t.closable ? `<span class="tab-close" data-close-tab="${t.id}" role="button" aria-label="Close">${svg('close')}</span>` : ''}
      </button>`).join('') +
      `<div class="tabbar-fill"></div>
       <div class="tabbar-actions">
         <button class="icon-button" data-open-tab="chat" title="Open Chat">${svg('chat')}</button>
         <button class="icon-button" data-open-tab="settings" title="Open Settings">${svg('gear')}</button>
         <button class="icon-button" id="paletteBtn" title="Command Palette (Ctrl+Shift+P)">${svg('search')}</button>
       </div>`;
  }

  function updateActiveView() {
    for (const view of $$('.view')) view.classList.toggle('active', view.dataset.view === state.activeTab);
    const empty = $('#emptyEditor');
    if (empty) empty.classList.toggle('active', !state.activeTab || !state.tabs.some(t => t.id === state.activeTab));
    const tab = state.tabs.find(t => t.id === state.activeTab);
    if (tab && tab.id === 'model-info') renderModelInfo();
    if (tab && tab.id === 'settings') renderSettings();
    if (tab && tab.id === 'json') renderJson();
    if (tab && tab.id === 'chat') ensureChatView();
  }

  function openTab(id, opts = {}) {
    if (!state.tabs.some(t => t.id === id)) state.tabs.push(tabFor(id));
    state.activeTab = id;
    if (id === 'model-info') { renderModelInfo(); }
    if (id === 'chat') { ensureChatView(); renderChatMessages(); updateChatHeader(); }
    if (id === 'settings') renderSettings();
    if (id === 'json') renderJson();
    renderTabs();
    updateActiveView();
    if (id === 'chat' && !opts.keepInput) setTimeout(() => $('#chatInput')?.focus(), 30);
  }

  function closeTab(id) {
    const index = state.tabs.findIndex(t => t.id === id);
    if (index < 0) return;
    state.tabs.splice(index, 1);
    if (state.activeTab === id) {
      const next = state.tabs[Math.max(0, index - 1)] || state.tabs[0];
      state.activeTab = next ? next.id : null;
    }
    renderTabs();
    updateActiveView();
  }

  /* ------------------------------------------------------------------ */
  /* Model info                                                          */
  /* ------------------------------------------------------------------ */
  function chipsFor(model) {
    const labels = [...(model.labels || [])];
    if (model.hot) labels.push('hot');
    return labels.map(label => `<span class="chip">${esc(label)}</span>`).join('');
  }

  function renderModelInfo() {
    const view = $('#view-model-info');
    if (!view) return;
    const model = getModel(state.infoModelId);
    if (!model) {
      view.innerHTML = `<div style="padding:40px;color:#888">Select a model in the Chanh sidebar.</div>`;
      return;
    }
    const downloaded = isDownloaded(model.id);
    const loaded = downloaded && model.loaded;
    const effective = model.savedCtx === -1 ? -1 : (model.savedCtx ?? model.ctx);
    const fmtCtx = (n) => n === -1 ? 'Automatic' : (typeof n === 'number' && n > 0 ? `${fmtNumber(n)} tokens` : '');
    const labels = [...(model.labels || [])];
    if (model.hot) labels.push('hot');
    const status = loaded ? 'Loaded — idle' : downloaded ? 'Downloaded (not loaded)' : 'Not downloaded — pull to install';
    const rows = [
      ['Capabilities', labels.join(', ')],
      ['Status', status],
      ['Size', fmtSize(model.size)],
      ['Context (effective)', fmtCtx(effective)],
      ['Context (reported)', fmtCtx(model.ctx)],
      ['Max context window', fmtCtx(model.maxCtx)],
      ['Context (saved override)', model.savedCtx === undefined ? '' : fmtCtx(model.savedCtx)],
      ['Context (default)', fmtCtx(model.ctx)],
      ['Checkpoint', model.checkpoint],
      ['Registry', model.registry],
      ['Recipe/backend', model.recipe],
      ['Type', model.type],
      ['Owned by', model.ownedBy],
      ['Created', model.created],
      ['Created value', model.createdValue?.toString()],
      ['Backend', loaded ? model.backendUrl : '']
    ].filter(([, value]) => value);

    view.innerHTML = `<div class="info-page">
      <h2>${esc(model.id)}</h2>
      <div class="info-sub">${chipsFor(model)}</div>
      ${rows.map(([label, value]) => `<div class="info-row"><span class="info-label">${esc(label)}</span><span class="info-value">${esc(value)}</span></div>`).join('')}
    </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */
  function renderSettings() {
    const view = $('#view-settings');
    if (!view) return;
    view.innerHTML = `
      <div class="settings-page">
        <div class="settings-search">${svg('search')}<input id="settingsSearch" placeholder="Search settings (Chanh)" autocomplete="off" /></div>
        <div class="settings-crumbs"><b>User</b><span class="sep">›</span><b>Chanh</b><span class="sep">›</span>Server &amp; chat</div>
        <div class="settings-group-title"><img src="assets/chanh.svg" alt="" />Chanh</div>

        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Server Mode</div>
            <div class="setting-desc">Which Lemonade Server to use. <code>LEMONADE</code> connects to the system install, <code>LEMOND</code> manages the bundled binary, and <code>CUSTOM</code> points at another URL.</div>
          </div>
          <div class="setting-control">
            <select class="vs-select" data-setting="serverMode">
              <option value="LEMONADE" ${state.serverMode === 'LEMONADE' ? 'selected' : ''}>LEMONADE</option>
              <option value="LEMOND" ${state.serverMode === 'LEMOND' ? 'selected' : ''}>LEMOND</option>
              <option value="CUSTOM" ${state.serverMode === 'CUSTOM' ? 'selected' : ''}>CUSTOM</option>
            </select>
          </div>
        </div>

        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Custom Server URL</div>
            <div class="setting-desc">Used when <code>chanh.serverMode</code> is <code>CUSTOM</code>.</div>
          </div>
          <div class="setting-control"><input class="vs-input" style="width:210px" data-setting="customUrl" value="${escAttr(state.customUrl)}" /></div>
        </div>

        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Lemonade Port</div>
            <div class="setting-desc">Port for the system-installed Lemonade Server.</div>
          </div>
          <div class="setting-control"><input class="vs-input" data-setting="lemonadePort" value="13305" /></div>
        </div>

        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">lemond Port</div>
            <div class="setting-desc">Port for the bundled <code>lemond</code> binary managed by Chanh.</div>
          </div>
          <div class="setting-control"><input class="vs-input" data-setting="lemondPort" value="8000" /></div>
        </div>

        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Max Loaded Models</div>
            <div class="setting-desc">Maximum number of models loaded at once. Use <code>-1</code> for unlimited.</div>
          </div>
          <div class="setting-control"><input class="vs-input" data-setting="maxLoaded" value="-1" /></div>
        </div>

        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Show Token Stats</div>
            <div class="setting-desc">Show per-turn token usage in the chat footer, taken from the model's <code>usage</code> block.</div>
          </div>
          <div class="setting-control"><input class="checkbox" type="checkbox" data-setting="showTokenStats" ${state.showTokenStats ? 'checked' : ''} /></div>
        </div>

        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">System Sample Interval</div>
            <div class="setting-desc">Seconds between CPU / GPU / RAM samples in the sidebar's System group.</div>
          </div>
          <div class="setting-control"><input class="vs-input" style="width:80px" data-setting="sampleInterval" value="${state.sampleInterval}" /></div>
        </div>

        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Chat Model</div>
            <div class="setting-desc">Model used by the <code>@chanh</code> participant. Leave auto to be prompted.</div>
          </div>
          <div class="setting-control">
            <select class="vs-select" data-setting="chatModel">
              ${chatModels().map(m => `<option value="${escAttr(m.id)}" ${state.chatModelId === m.id ? 'selected' : ''}>${esc(m.id)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:20px">
          <button class="btn" data-action="openSettingsJson">${svg('file-text')}Open settings.json</button>
          <button class="btn" data-action="resetDemo">${svg('refresh')}Reset mockup</button>
        </div>
        <div class="local-note" style="margin-top:18px">${svg('info')}<div>Settings here are simulated. They mirror the real keys contributed by Chanh in <code style="font-family:var(--mono);color:#c9c9c9">package.json</code>.</div></div>
      </div>`;
    const search = $('#settingsSearch');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        $$('.setting', view).forEach(row => {
          row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
    }
  }

  function handleSettingChange(el) {
    const key = el.dataset.setting;
    if (key === 'serverMode') {
      if (el.value === 'CUSTOM' && state.serverMode !== 'CUSTOM') {
        const previous = state.serverMode;
        openInputDialog({
          title: 'Custom Lemonade Server URL',
          label: 'Server URL',
          value: state.customUrl,
          placeholder: 'http://192.168.1.20:13305',
          confirmLabel: 'Use server',
          onApply: (value) => {
            state.customUrl = value || SERVER_PRESETS.CUSTOM.url;
            switchServerMode('CUSTOM');
          },
          onCancel: () => { state.serverMode = previous; renderSettings(); }
        });
        return;
      }
      switchServerMode(el.value);
      return;
    }
    if (key === 'customUrl') {
      state.customUrl = el.value.trim() || SERVER_PRESETS.CUSTOM.url;
      renderTree();
      updateStatusbar();
      showToast('Custom URL saved', `<code>${esc(state.customUrl)}</code>`, 'success');
      return;
    }
    if (key === 'showTokenStats') {
      state.showTokenStats = el.checked;
      showToast('Token stats ' + (el.checked ? 'enabled' : 'disabled'), 'The chat footer updates immediately.', 'success');
      updateComposeFoot();
      return;
    }
    if (key === 'sampleInterval') {
      const value = Math.max(1, Math.min(600, Number(el.value) || 5));
      state.sampleInterval = value;
      showToast('Sample interval set', `to ${value}s (demo refreshes every 2.5s)`, 'success');
      return;
    }
    if (key === 'maxLoaded') {
      showToast('Max loaded models set', `to <b>${esc(el.value || 'unlimited')}</b>`, 'success');
      return;
    }
    if (key === 'chatModel') {
      state.chatModelId = el.value;
      updateChatHeader();
      renderChatMessages();
      showToast('Chat model set', `to <b>${esc(el.value)}</b>`, 'success');
      return;
    }
    showToast('Setting saved', `(mockup) <code>${esc(key)}</code>`, 'success');
  }

  /* ------------------------------------------------------------------ */
  /* JSON / custom endpoint                                              */
  /* ------------------------------------------------------------------ */
  function endpointConfig() {
    const model = getModel(state.infoModelId) || getModel(state.chatModelId);
    const ctx = model ? model.maxCtx : 262144;
    const labels = (model?.labels || []).map(l => l.toLowerCase());
    return {
      'chat.customEndpoints': [{
        id: model?.id || 'local-model',
        name: model?.id || 'local-model',
        url: serverInfo().url,
        agent: true,
        toolCalling: labels.includes('tool-calling') || labels.includes('chat'),
        vision: labels.includes('vision'),
        maxInputTokens: ctx,
        maxOutputTokens: Math.min(Math.max(Math.floor((model?.ctx || 8192) / 2), 256), 4096)
      }]
    };
  }

  function highlightJSON(text) {
    const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|\b(-?\d+(?:\.\d+)?)\b/g;
    let out = '';
    let last = 0;
    for (const match of text.matchAll(re)) {
      out += esc(text.slice(last, match.index));
      const [all, str, colon, literal, num] = match;
      if (str) out += colon ? `<span class="tok-key">${str}</span>${colon}` : `<span class="tok-str">${str}</span>`;
      else if (literal) out += `<span class="tok-key">${literal}</span>`;
      else if (num) out += `<span class="tok-num">${num}</span>`;
      last = match.index + all.length;
    }
    out += esc(text.slice(last));
    return out;
  }

  function renderJson() {
    const view = $('#view-json');
    if (!view) return;
    const json = JSON.stringify(endpointConfig(), null, 2);
    view.innerHTML = `
      <div class="json-page">
        <div class="json-head">
          <span class="json-path">.vscode <span>›</span> settings.json</span>
          <button class="btn" data-action="copyJson">${svg('copy')}Copy</button>
        </div>
        <div class="json-body">
          <div class="json-note">${svg('check-circle')}<span>Added <code>chat.customEndpoints</code> entry for <code>${esc(state.infoModelId)}</code></span></div>
          <pre>${highlightJSON(json)}</pre>
          <p style="max-width:680px;color:#8f8f8f;font-size:11.5px;line-height:1.6;margin-top:18px">
            Chanh's native model provider already exposes tool-calling chat models to the picker. This optional entry wires a single
            loaded model into VS Code’s custom-endpoint chat surface as well.
          </p>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Chat                                                                */
  /* ------------------------------------------------------------------ */
  function seedChat() {
    state.chatMessages = [
      {
        role: 'user',
        text: '/explain',
        context: { file: 'src/serverManager.ts', lines: '1–42' },
        meta: 'You'
      },
      {
        role: 'assistant',
        meta: 'Chanh 🍋',
        html: `<p><code>Chanh</code> is a thin VS Code layer over a local <strong>Lemonade Server</strong>. Three pieces do the work:</p>
          <ul>
            <li><strong>ServerManager</strong> owns the lifecycle — it starts the managed <code>lemond</code> binary, watches its health endpoint, and stops it on deactivate.</li>
            <li><strong>ModelManager</strong> talks to the OpenAI-compatible API to pull, load, unload and configure models.</li>
            <li><strong>ChanhLmcProvider</strong> exposes those models to VS Code’s native picker, so agent mode can stream text and tool calls.</li>
          </ul>
          <div class="code-block">
            <div class="code-head"><span><span class="lang">ts</span> serverManager.ts</span><button data-copy-code>${svg('copy')}Copy</button></div>
            <pre><span class="tok-kw">async</span> <span class="tok-fn">start</span>(): <span class="tok-type">Promise</span>&lt;<span class="tok-type">void</span>&gt; {
  <span class="tok-kw">if</span> (<span class="tok-kw">this</span>.server?.status === <span class="tok-str">'RUNNING'</span>) <span class="tok-kw">return</span>
  <span class="tok-kw">await</span> <span class="tok-kw">this</span>.binary.<span class="tok-fn">ensure</span>()
  <span class="tok-kw">this</span>.server = <span class="tok-kw">await</span> <span class="tok-kw">this</span>.<span class="tok-fn">spawn</span>(<span class="tok-str">'lemond'</span>, [<span class="tok-str">'--port'</span>, <span class="tok-str">'8000'</span>])
}</pre>
          </div>
          <p>Nothing is sent to a cloud: the server listens on <code>127.0.0.1:13305</code> and the weights live on this machine.</p>`
      }
    ];
  }

  function ensureChatView() {
    if (chatBuilt) { updateChatHeader(); return; }
    const view = $('#view-chat');
    if (!view) return;
    view.innerHTML = `
      <div class="chat-shell">
        <div class="chat-head">
          <div class="chat-head-title"><img src="assets/chanh.svg" alt="" />Chanh Chat</div>
          <span class="chat-local-pill">${svg('lock')}Local</span>
          <span class="chat-head-spacer"></span>
          <button class="model-pill" id="modelPill" title="Select chat model">
            <img src="assets/chanh.svg" alt="" />
            <span class="mp-name" id="chatModelName">${esc(state.chatModelId)}</span>
            <span class="mp-provider">Chanh 🍋</span>
            <span class="mp-gear" data-action="openModelSettings" title="Model settings">${svg('gear')}</span>
            ${svg('chevron-down')}
          </button>
          <div class="chat-head-actions">
            <button class="icon-button" data-chat-action="new" title="New Chat">${svg('plus')}</button>
            <button class="icon-button" data-chat-action="history" title="Chat History">${svg('history')}</button>
            <button class="icon-button" data-chat-action="more" title="More">${svg('more')}</button>
          </div>
          <div id="modelPickerMount"></div>
        </div>
        <div class="chat-messages" id="chatMessages"><div class="chat-thread" id="chatThread"></div></div>
        <div class="chat-compose">
          <div class="compose-inner">
            <div class="compose-context" id="composeContext">
              <span class="compose-chip">${svg('file-text')}src/serverManager.ts <button data-chat-action="clearContext" title="Remove context">${svg('close')}</button></span>
              <span class="compose-chip">${svg('code')}lines 1–42</span>
            </div>
            <div class="composer">
              <textarea id="chatInput" rows="2" placeholder="Ask Chanh…  Use /fix or /explain, or @chanh in any chat"></textarea>
              <div class="composer-tools">
                <button class="tool-btn slash" data-insert="/fix " title="Generate a fix for the selected code">/fix</button>
                <button class="tool-btn slash" data-insert="/explain " title="Explain the selected code">/explain</button>
                <button class="tool-btn" data-chat-action="attach" title="Add context">${svg('plus')}Context</button>
                <span class="spacer"></span>
                <button class="tool-btn" data-chat-action="agent" title="Agent mode uses tool calling">${svg('sparkle')}Agent</button>
                <button class="send-btn" id="sendBtn" data-chat-action="send" title="Send (Enter)">${svg('send')}</button>
              </div>
            </div>
            <div class="compose-foot ${state.showTokenStats ? '' : 'hidden'}" id="composeFoot">
              <span class="local">${svg('lock')}Runs locally · no data leaves this device</span>
              <span class="spacer"></span>
              <span class="tokens" id="tokenStats"></span>
            </div>
          </div>
        </div>
      </div>`;
    chatBuilt = true;
    if (state.chatMessages.length === 0) seedChat();
    updateChatHeader();
    renderChatMessages();
    updateComposeFoot();
    const input = $('#chatInput');
    input.addEventListener('input', () => autoGrow(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
    $('#modelPill').addEventListener('click', (e) => {
      if (e.target.closest('[data-action="openModelSettings"]')) return;
      toggleModelPicker();
    });
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(150, el.scrollHeight)}px`;
  }

  function updateChatHeader() {
    const name = $('#chatModelName');
    if (name) name.textContent = state.chatModelId;
  }

  function msgActions(index) {
    return `<div class="msg-actions">
      <button data-copy-msg="${index}" title="Copy">${svg('copy')}</button>
      <button data-thumb="up" title="Good response">${svg('check')}</button>
      <button data-thumb="down" title="Bad response">${svg('warning')}</button>
    </div>`;
  }

  function renderChatMessages() {
    const thread = $('#chatThread');
    if (!thread) return;
    const messages = state.chatMessages;
    thread.innerHTML = messages.map((m, i) => {
      if (m.role === 'user') {
        return `<div class="msg user">
          <div class="msg-avatar">${svg('account')}</div>
          <div class="msg-main">
            <div class="msg-meta"><span class="msg-author">${esc(m.meta || 'You')}</span><span>${esc(m.time || 'just now')}</span></div>
            <div class="msg-bubble">
              <p style="white-space:pre-wrap;margin:0">${esc(m.text)}</p>
              ${m.context ? `<div class="context-card">${svg('file-text')}<span><b>${esc(m.context.file)}</b>${m.context.lines ? ` · lines ${esc(m.context.lines)}` : ''}</span></div>` : ''}
            </div>
          </div>
        </div>`;
      }
      const body = m.pending
        ? `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span>Thinking locally…</div>`
        : (m.html || `<p>${esc(m.text || '')}</p>`);
      return `<div class="msg assistant">
        <div class="msg-avatar"><img src="assets/chanh.svg" alt="" /></div>
        <div class="msg-main">
          <div class="msg-meta"><span class="msg-author">${esc(m.meta || 'Chanh 🍋')}</span><span>${esc(state.chatModelId)}</span><span>${m.pending ? 'streaming' : 'just now'}</span></div>
          <div class="msg-bubble">${body}</div>
          ${m.pending ? '' : msgActions(i)}
        </div>
      </div>`;
    }).join('') || `<div style="text-align:center;color:#777;padding:40px 0">Start a conversation with your local model.</div>`;
    scrollChatToBottom();
    updateComposeFoot();
  }

  function scrollChatToBottom() {
    const el = $('#chatMessages');
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function updateComposeFoot() {
    const stats = $('#tokenStats');
    const foot = $('#composeFoot');
    if (foot) foot.classList.toggle('hidden', !state.showTokenStats);
    if (stats) stats.innerHTML = `<b>${fmtNumber(state.tokens.prompt)}</b> prompt · <b>${fmtNumber(state.tokens.completion)}</b> completion · ${state.tokens.tps.toFixed(1)} tok/s`;
    const statusTokens = $('#statusTokens');
    if (statusTokens) statusTokens.textContent = `${fmtNumber(state.tokens.prompt + state.tokens.completion)} tokens`;
  }

  function answerFor(text) {
    const lower = text.toLowerCase();
    if (lower.includes('/fix') || lower.includes('fix')) {
      return `<p>Here's a small fix for the unchecked endpoint path in <code>serverManager.ts</code>:</p>
        <div class="code-block">
          <div class="code-head"><span><span class="lang">diff</span> src/serverManager.ts</span><button data-copy-code>${svg('copy')}Copy</button></div>
          <pre><span class="tok-com">- const url = server?.url</span>
<span class="tok-com">- await fetch(url + '/v1/health')</span>
<span class="tok-str">+ const url = server?.url ?? await this.promptForUrl()</span>
<span class="tok-str">+ if (!url) return</span>
<span class="tok-str">+ await fetch(new URL('/v1/health', url))</span></pre>
        </div>
        <p>It also resolves the URL relative to the configured base so a custom server with a path prefix still works. Want me to apply it to the working tree?</p>`;
    }
    if (lower.includes('agent') || lower.includes('tool')) {
      return `<p>Agent mode uses the same local models, exposed through VS Code’s native picker under <strong>Chanh 🍋</strong>. The provider forwards your tools untouched and translates tool calls back into <code>LanguageModelToolCallPart</code>s.</p>
        <ul>
          <li>Only chat models that advertise <code>tool-calling</code> appear in the native picker.</li>
          <li>A <code>vision</code> label enables image attachments in the picker.</li>
          <li>The agent loop itself stays in VS Code — no provider-side tool execution.</li>
        </ul>
        <p>Nothing about that loop leaves the machine: the tool calls are sent to <code>127.0.0.1</code>.</p>`;
    }
    if (lower.includes('offline') || lower.includes('private') || lower.includes('local')) {
      return `<p>Yes — after the model is downloaded, Chanh needs no network at all. The server binds to loopback, the weights are cached on disk, and the chat UI talks only to that local endpoint.</p>
        <p>You can verify it by stopping the server in the Chanh sidebar: the status row turns to <strong>Stopped</strong> and chat requests fail fast, with no cloud fallback.</p>`;
    }
    return `<p>I'm running <code>${esc(state.chatModelId)}</code> locally through Lemonade. I can help with this workspace without sending any of it to a cloud service.</p>
      <ul>
        <li>Ask me to <strong>explain</strong> a file or the selected lines.</li>
        <li>Use <code>/fix</code> to propose a patch for a bug.</li>
        <li>Switch models from the picker — loaded models stay warm in memory.</li>
      </ul>
      <p>What would you like to look at?</p>`;
  }

  function sendChat(forced) {
    if (state.stream) return;
    const input = $('#chatInput');
    const text = (forced || input?.value || '').trim();
    if (!text) {
      showToast('Nothing to send', 'Type a message or pick a suggested prompt.', 'warn');
      return;
    }
    if (input) { input.value = ''; autoGrow(input); }
    state.chatMessages.push({ role: 'user', text, meta: 'You', time: 'just now' });
    const index = state.chatMessages.length;
    state.chatMessages.push({ role: 'assistant', pending: true, meta: 'Chanh 🍋' });
    state.tokens.prompt = 620 + Math.round(text.length * 1.4);
    state.tokens.completion = 0;
    renderChatMessages();
    updateComposeFoot();
    const token = { cancelled: false };
    state.stream = token;
    const sendBtn = $('#sendBtn');
    if (sendBtn) { sendBtn.classList.add('stop'); sendBtn.innerHTML = svg('stop'); sendBtn.title = 'Stop'; }
    clearTimeout(streamTimer);
    streamTimer = setTimeout(() => {
      if (!state.stream) return;
      const msg = state.chatMessages[index];
      if (token.cancelled) {
        msg.pending = false;
        msg.html = '<p class="stopped" style="color:#cca700;font-style:italic">Generation stopped.</p>';
      } else {
        msg.pending = false;
        msg.html = answerFor(text);
        state.tokens.completion = 180 + Math.round(140 * Math.random());
        state.tokens.tps = 28 + Math.random() * 18;
      }
      state.stream = null;
      const btn = $('#sendBtn');
      if (btn) { btn.classList.remove('stop'); btn.innerHTML = svg('send'); btn.title = 'Send (Enter)'; }
      renderChatMessages();
      updateComposeFoot();
    }, 1250 + Math.random() * 500);
  }

  function stopChat() {
    if (!state.stream) return;
    state.stream.cancelled = true;
  }

  function toggleModelPicker(force) {
    const mount = $('#modelPickerMount');
    if (!mount) return;
    const open = typeof force === 'boolean' ? force : !state.modelPickerOpen;
    state.modelPickerOpen = open;
    if (!open) { mount.innerHTML = ''; return; }
    const models = chatModels();
    const current = state.chatModelId;
    mount.innerHTML = `
      <div class="model-picker" id="modelPicker">
        <div class="picker-search">${svg('search')}<input id="pickerSearch" placeholder="Search models" autocomplete="off" /></div>
        <div class="picker-list">
          <div class="picker-section">Auto</div>
          <div class="picker-item ${current === 'auto' ? 'selected' : ''}" data-pick-model="auto">
            <span class="pi-main"><span class="pi-name">Auto</span></span>
            <span class="pi-sub">10% discount</span>
            <span class="pi-check ${current === 'auto' ? '' : 'empty'}">${svg('check')}</span>
          </div>
          <div class="picker-section">Chanh 🍋 · pinned locally</div>
          ${models.map(m => {
            const tool = m.labels.some(l => l.toLowerCase() === 'tool-calling');
            const vision = m.labels.some(l => l.toLowerCase() === 'vision');
            return `<div class="picker-item ${current === m.id ? 'selected' : ''}" data-pick-model="${escAttr(m.id)}" data-search="${escAttr(m.id.toLowerCase())}">
              <span class="pi-main"><img src="assets/chanh.svg" alt="" style="width:14px;height:14px" /><span class="pi-name">${esc(m.id)}</span>
                <span class="pi-sub">(llamacpp)</span></span>
              ${tool ? '<span class="pi-badge">tools</span>' : ''}${vision ? '<span class="pi-badge">vision</span>' : ''}
              <span class="pi-provider"><img src="assets/chanh.svg" alt="" />Chanh 🍋</span>
              <button class="pi-gear" data-action="openModelSettings" title="Model settings">${svg('gear')}</button>
            </div>`;
          }).join('')}
          <div class="picker-sep"></div>
          <div class="picker-section">Other Models</div>
          <div class="picker-item" data-other-model="copilot"><span class="pi-main"><span class="pi-name">GPT-5.6 Terra</span></span><span class="pi-sub">Copilot</span></div>
          <div class="picker-item" data-other-model="claude"><span class="pi-main"><span class="pi-name">Claude Sonnet 5</span></span><span class="pi-sub">Copilot</span></div>
          <div class="picker-item" data-other-model="ollama"><span class="pi-main"><span class="pi-name">qwen3.8:latest</span></span><span class="pi-sub">Ollama</span></div>
        </div>
        <div class="picker-footer"><span>Only chat-capable models from the active server</span><span class="link" data-action="openModelSettings">Model settings</span></div>
      </div>`;
    const search = $('#pickerSearch');
    search?.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      $$('.picker-item[data-search]', mount).forEach(item => {
        item.style.display = !q || item.dataset.search.includes(q) ? '' : 'none';
      });
    });
    setTimeout(() => search?.focus(), 30);
    mount.querySelectorAll('[data-pick-model]').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="openModelSettings"]')) return;
        selectChatModel(item.dataset.pickModel);
      });
    });
    mount.querySelectorAll('[data-other-model]').forEach(item => {
      item.addEventListener('click', () => {
        toggleModelPicker(false);
        showToast('Cloud model not used', 'This mockup keeps inference on the Chanh provider only.', 'warn');
      });
    });
  }

  function selectChatModel(id) {
    if (id === 'auto') {
      state.chatModelId = chatModels()[0]?.id || state.chatModelId;
      showToast('Auto model selected', 'Chanh will pick the best loaded local model (mocked).', 'success');
    } else {
      state.chatModelId = id;
      const model = state.models.find(m => m.id === id);
      if (model && !model.loaded) {
        model.loaded = true;
        renderTree();
        showToast('Model loaded', `<b>${esc(id)}</b> is ready for chat.`, 'success');
      } else {
        showToast('Chat model set', `to <b>${esc(id)}</b>`, 'success');
      }
    }
    updateChatHeader();
    renderChatMessages();
    toggleModelPicker(false);
  }

  /* ------------------------------------------------------------------ */
  /* Quick pick / dialogs                                                */
  /* ------------------------------------------------------------------ */
  function closeOverlays() {
    $('#overlayRoot').innerHTML = '';
    state.quickPick = null;
    state.palette = null;
  }

  function openOverlay(html) {
    const root = $('#overlayRoot');
    root.innerHTML = `<div class="overlay">${html}</div>`;
    const overlay = root.firstElementChild;
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) { closeOverlays(); }
    });
    return overlay;
  }

  function quickPickItemsHtml(items, activeIndex) {
    return items.map((item, i) => {
      if (item.separator) return '<div class="qp-sep"></div>';
      if (item.title) return `<div class="quickpick-title">${esc(item.title)}</div>`;
      return `<div class="qp-item ${i === activeIndex ? 'active' : ''}" data-qp-index="${i}">
        <span class="qp-check ${item.current ? '' : 'empty'}">${svg('check')}</span>
        <span class="qp-main"><span class="qp-label">${esc(item.label)}</span>${item.detail ? `<span class="qp-detail">${esc(item.detail)}</span>` : ''}</span>
        ${item.description ? `<span class="qp-desc">${esc(item.description)}</span>` : ''}
      </div>`;
    }).join('');
  }

  function openQuickPick({ title, placeholder = '', items, onPick, filterable = true }) {
    const filtered = items.slice();
    let active = Math.max(0, filtered.findIndex(i => i.current));
    state.quickPick = { items: filtered, onPick, active };
    const overlay = openOverlay(`
      <div class="quickpick" role="dialog" aria-label="${escAttr(title)}">
        <input class="quickpick-input" id="qpInput" placeholder="${escAttr(placeholder || title)}" autocomplete="off" ${filterable ? '' : 'readonly'} />
        <div class="quickpick-title">${esc(title)}</div>
        <div class="quickpick-list" id="qpList">${quickPickItemsHtml(filtered, active)}</div>
      </div>`);
    const input = $('#qpInput', overlay);
    const list = $('#qpList', overlay);
    const renderList = () => {
      list.innerHTML = quickPickItemsHtml(state.quickPick.items, state.quickPick.active);
      $$('.qp-item', list).forEach(el => {
        el.addEventListener('mouseenter', () => {
          state.quickPick.active = Number(el.dataset.qpIndex);
        });
        el.addEventListener('click', () => choose(Number(el.dataset.qpIndex)));
      });
    };
    const choose = (index) => {
      const item = state.quickPick?.items[index];
      if (!item || item.separator || item.title) return;
      closeOverlays();
      onPick(item);
    };
    const filter = () => {
      const q = input.value.trim().toLowerCase();
      const all = items.filter(i => i.separator || i.title || !q || `${i.label} ${i.description || ''}`.toLowerCase().includes(q));
      state.quickPick.items = all;
      state.quickPick.active = Math.max(0, all.findIndex(i => i.current && !i.separator));
      renderList();
    };
    if (filterable) input.addEventListener('input', filter);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const pickable = state.quickPick.items.map((it, i) => (!it.separator && !it.title ? i : -1)).filter(i => i >= 0);
        if (!pickable.length) return;
        const at = pickable.indexOf(state.quickPick.active);
        const next = e.key === 'ArrowDown' ? (at + 1) % pickable.length : (at - 1 + pickable.length) % pickable.length;
        state.quickPick.active = pickable[next];
        renderList();
        $$('.qp-item')[state.quickPick.active]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(state.quickPick.active);
      }
    });
    renderList();
    setTimeout(() => input.focus(), 30);
    return overlay;
  }

  function openInputDialog({ title, label, value = '', placeholder = '', confirmLabel = 'OK', onApply, onCancel }) {
    const overlay = openOverlay(`
      <div class="dialog" role="dialog" aria-label="${escAttr(title)}">
        <h3>${esc(title)}</h3>
        <label class="dialog-label">${esc(label)}</label>
        <input class="vs-input dialog-input" id="dialogInput" value="${escAttr(value)}" placeholder="${escAttr(placeholder)}" />
        <div class="dialog-actions">
          <button class="btn" data-dialog="cancel">Cancel</button>
          <button class="btn primary" data-dialog="apply">${esc(confirmLabel)}</button>
        </div>
      </div>`);
    const input = $('#dialogInput', overlay);
    const apply = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      closeOverlays();
      onApply?.(v);
    };
    $('[data-dialog="apply"]', overlay).addEventListener('click', apply);
    $('[data-dialog="cancel"]', overlay).addEventListener('click', () => { closeOverlays(); onCancel?.(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  function openConfirm({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
    const overlay = openOverlay(`
      <div class="dialog" role="dialog" aria-label="${escAttr(title)}">
        <h3>${esc(title)}</h3>
        <p class="dialog-message">${message}</p>
        <div class="dialog-actions">
          <button class="btn" data-dialog="cancel">Cancel</button>
          <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-dialog="apply">${esc(confirmLabel)}</button>
        </div>
      </div>`);
    $('[data-dialog="apply"]', overlay).addEventListener('click', () => { closeOverlays(); onConfirm?.(); });
    $('[data-dialog="cancel"]', overlay).addEventListener('click', closeOverlays);
  }

  /* ------------------------------------------------------------------ */
  /* Model actions                                                       */
  /* ------------------------------------------------------------------ */
  function requireModel(el) { return getModel(el.dataset.model); }

  function selectModel(id) {
    state.selectedId = id;
    state.infoModelId = id;
    const tab = state.tabs.find(t => t.id === 'model-info');
    if (!tab) state.tabs.unshift(tabFor('model-info'));
    state.activeTab = 'model-info';
    renderTree();
    renderTabs();
    updateActiveView();
  }

  function loadModel(id) {
    const model = state.models.find(m => m.id === id);
    if (!model) {
      showToast('Model not installed', 'Download it first from the catalog.', 'warn');
      return;
    }
    if (model.loaded) return;
    model.loaded = true;
    state.tokens.tps = 28 + Math.random() * 18;
    renderTree();
    renderModelInfo();
    updateComposeFoot();
    showToast('Model loaded', `<b>${esc(id)}</b> loaded successfully.`, 'success', [
      { label: 'Chat now', run: () => { state.chatModelId = id; openTab('chat'); updateChatHeader(); } }
    ]);
  }

  function unloadModel(id) {
    const model = state.models.find(m => m.id === id);
    if (!model) return;
    model.loaded = false;
    renderTree();
    renderModelInfo();
    showToast('Model unloaded', `<b>${esc(id)}</b> was removed from memory.`, 'info');
  }

  function openContextPicker(modelId) {
    const model = getModel(modelId);
    if (!model) return;
    const current = model.savedCtx;
    const items = [
      { label: '8K — 8,192 tokens', current: current === 8192, value: 8192 },
      { label: '16K — 16,384 tokens', current: current === 16384, value: 16384 },
      { label: '32K — 32,768 tokens', current: current === 32768, value: 32768 },
      { label: '48K — 49,152 tokens', current: current === 49152, value: 49152 },
      { label: '64K — 65,536 tokens', current: current === 65536, value: 65536 },
      { label: '128K — 131,072 tokens', current: current === 131072, value: 131072 },
      { label: 'Automatic — Server decides the context size', current: current === -1, value: -1 },
      { label: 'Custom… — any value from 4K up to 262,144 tokens', value: 'custom' }
    ];
    openQuickPick({
      title: `Context size for ${model.id}`,
      placeholder: 'Choose the context size to apply',
      items,
      onPick: (item) => {
        if (item.value === 'custom') {
          openInputDialog({
            title: 'Custom context size',
            label: 'Context size in tokens (4,096 – 262,144)',
            value: current && current > 0 ? String(current) : '49152',
            confirmLabel: 'Apply',
            onApply: (value) => {
              const n = Number(value);
              if (!Number.isFinite(n) || n < 4096 || n > model.maxCtx) {
                showToast('Invalid context size', `Choose a value between 4,096 and ${fmtNumber(model.maxCtx)}.`, 'warn');
                return;
              }
              model.savedCtx = Math.round(n);
              afterContextChange(model);
            }
          });
          return;
        }
        model.savedCtx = item.value;
        afterContextChange(model);
      }
    });
  }

  function afterContextChange(model) {
    renderTree();
    renderModelInfo();
    const text = model.savedCtx === undefined ? 'server default' : model.savedCtx === -1 ? 'Automatic' : `${fmtNumber(model.savedCtx)} tokens`;
    showToast('Context size updated', `<b>${esc(model.id)}</b> → ${text}`, 'success');
  }

  function resetModelContext(id) {
    const model = getModel(id);
    if (!model) return;
    model.savedCtx = undefined;
    renderTree();
    renderModelInfo();
    showToast('Context size reset', `<b>${esc(id)}</b> now uses the server default.`, 'info');
  }

  function openBackendPicker(modelId) {
    const model = getModel(modelId);
    if (!model) return;
    const items = [
      { title: 'llamacpp', separator: false, label: '', skip: true },
      { label: 'Vulkan', description: 'installed · running', current: state.pinnedBackend === 'Vulkan', detail: model.recipe, value: 'Vulkan' },
      { label: 'CUDA', description: 'installed', current: state.pinnedBackend === 'CUDA', value: 'CUDA' },
      { label: 'ROCm', description: 'installable', value: 'ROCm' },
      { label: 'CPU', description: 'installed', current: state.pinnedBackend === 'CPU', value: 'CPU' }
    ].filter(i => !i.skip);
    openQuickPick({
      title: `Select backend for ${model.id}`,
      placeholder: 'Choose an inference backend',
      items,
      onPick: (item) => {
        state.pinnedBackend = item.value;
        renderTree();
        renderModelInfo();
        if (item.value === 'ROCm') {
          showToast('Backend installation started', 'ROCm is being installed by the server (mock).', 'warn');
        } else {
          showToast('Backend selected', `<b>${item.value}</b> will serve <b>${esc(model.id)}</b>.`, 'success');
        }
      }
    });
  }

  function openSwitchServer() {
    const items = [
      { label: 'Lemonade Server (System)', description: 'localhost:13305', current: state.serverMode === 'LEMONADE', value: 'LEMONADE', detail: 'LEMONADE' },
      { label: 'lemond (Managed by Chanh)', description: 'localhost:8000', current: state.serverMode === 'LEMOND', value: 'LEMOND', detail: 'LEMOND' },
      { label: 'Custom Server URL…', description: state.customUrl.replace('http://', ''), current: state.serverMode === 'CUSTOM', value: 'CUSTOM', detail: 'CUSTOM' }
    ];
    openQuickPick({
      title: 'Switch Lemonade Server',
      placeholder: 'Select a server to connect to',
      items,
      onPick: (item) => {
        if (item.value === 'CUSTOM') {
          openInputDialog({
            title: 'Custom Lemonade Server URL',
            label: 'Server URL',
            value: state.customUrl,
            confirmLabel: 'Connect',
            onApply: (value) => { state.customUrl = value; switchServerMode('CUSTOM'); }
          });
        } else {
          switchServerMode(item.value);
        }
      }
    });
  }

  function addEndpoint(modelId) {
    state.infoModelId = modelId;
    if (!state.tabs.some(t => t.id === 'json')) state.tabs.push(tabFor('json'));
    openTab('json');
    showToast('Custom endpoint added', `Entry written to <code>chat.customEndpoints</code> (mock).`, 'success', [
      { label: 'Copy JSON', run: copyJson }
    ]);
  }

  function copyJson() {
    const json = JSON.stringify(endpointConfig(), null, 2);
    copyText(json).then(() => showToast('Copied to clipboard', 'The endpoint entry is ready to paste.', 'success'));
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* noop */ }
      ta.remove();
    }
  }

  function removeModel(id) {
    const model = state.models.find(m => m.id === id) || state.downloadable.find(m => m.id === id);
    if (!model) return;
    openConfirm({
      title: `Remove ${id}?`,
      message: `This deletes <b>${esc(id)}</b> (${esc(fmtSize(model.size))}) from disk. The catalog entry stays available to download again.`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => {
        state.models = state.models.filter(m => m.id !== id);
        state.downloadable = state.downloadable.filter(m => m.id !== id);
        if (state.selectedId === id) state.selectedId = state.models[0]?.id || null;
        if (state.infoModelId === id) state.infoModelId = state.models[0]?.id || null;
        if (state.chatModelId === id) state.chatModelId = state.models.find(m => hasCap(m, 'chat'))?.id || '';
        renderTree();
        renderModelInfo();
        updateChatHeader();
        showToast('Model removed', `<b>${esc(id)}</b> was deleted from disk.`, 'info');
      }
    });
  }

  function startDownload(id) {
    if (state.downloads.has(id)) return;
    const model = state.downloadable.find(m => m.id === id);
    if (!model) return;
    state.partials.delete(id);
    state.downloads.set(id, { id, pct: 0, total: model.size, started: Date.now() });
    state.expanded.downloads = true;
    renderTree();
    showToast('Download started', `<b>${esc(id)}</b> — ${fmtSize(model.size)}`, 'info');
  }

  function cancelDownload(id) {
    const d = state.downloads.get(id);
    if (!d) return;
    state.downloads.delete(id);
    state.partials.set(id, { id, message: `${d.pct.toFixed(0)}% · cancelled` });
    renderTree();
    showToast('Download cancelled', `Partial file kept for <b>${esc(id)}</b>.`, 'warn', [
      { label: 'Retry', run: () => startDownload(id) }
    ]);
  }

  function removePartial(id) {
    state.partials.delete(id);
    renderTree();
    showToast('Partial file removed', esc(id), 'info');
  }

  function tickDownloads() {
    if (state.downloads.size === 0) return;
    const completed = [];
    for (const d of state.downloads.values()) {
      d.pct = Math.min(100, d.pct + 0.8 + Math.random() * 2.6);
      const row = $(`[data-download-row="${cssEscape(d.id)}"]`);
      const desc = row?.querySelector('.desc');
      if (desc) desc.textContent = downloadProgressText(d);
      if (d.pct >= 100) completed.push(d.id);
    }
    for (const id of completed) {
      state.downloads.delete(id);
      const idx = state.downloadable.findIndex(m => m.id === id);
      if (idx >= 0) {
        const [model] = state.downloadable.splice(idx, 1);
        state.models.push({ ...model, loaded: false, savedCtx: undefined });
        showToast('Model downloaded', `<b>${esc(id)}</b> is ready to load.`, 'success', [
          { label: 'Load now', run: () => loadModel(id) }
        ]);
      }
    }
    if (completed.length) {
      renderTree();
      if (state.infoModelId && completed.includes(state.infoModelId)) renderModelInfo();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Context menu / command palette                                      */
  /* ------------------------------------------------------------------ */
  function showContextMenu(x, y, items) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = items.map((item, i) => item.separator
      ? '<div class="menu-sep"></div>'
      : `<div class="menu-item" data-menu-index="${i}">${item.icon ? svg(item.icon) : '<span style="width:14px"></span>'}<span>${esc(item.label)}</span>${item.shortcut ? `<span class="shortcut">${esc(item.shortcut)}</span>` : ''}</div>`
    ).join('');
    document.body.appendChild(menu);
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, vw - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, vh - rect.height - 8)}px`;
    menu.querySelectorAll('.menu-item').forEach(el => {
      el.addEventListener('click', () => {
        const item = items[Number(el.dataset.menuIndex)];
        closeMenus();
        item.run?.();
      });
    });
    state.menuOpen = true;
  }

  function closeMenus() {
    $$('.context-menu').forEach(el => el.remove());
    state.menuOpen = false;
  }

  function modelContextMenu(id, x, y) {
    const model = getModel(id);
    if (!model) return;
    const downloaded = isDownloaded(id);
    const items = downloaded ? [
      { label: 'Set Context Size…', icon: 'hash', run: () => openContextPicker(id) },
      ...(model.savedCtx !== undefined
        ? [{ label: 'Reset Context Size to Default', icon: 'refresh', run: () => resetModelContext(id) }]
        : []),
      { separator: true },
      { label: 'Remove Model', icon: 'trash', run: () => removeModel(id) }
    ] : [
      { label: 'Show Model Info', icon: 'info', run: () => selectModel(id) },
      { label: 'Download Model', icon: 'download', run: () => startDownload(id) },
      { separator: true },
      { label: 'Copy Model ID', icon: 'copy', run: () => copyText(id).then(() => showToast('Copied', id, 'success')) }
    ];
    showContextMenu(x, y, items);
  }

  const COMMANDS = [
    { label: 'Chanh: Select Chat Model', icon: 'chat', run: () => { openTab('chat'); setTimeout(() => toggleModelPicker(true), 60); } },
    { label: 'Chanh: Open Chat', icon: 'chat', run: () => openTab('chat') },
    { label: 'Chanh: Switch Server…', icon: 'swap', run: openSwitchServer },
    { label: 'Chanh: Start Server', icon: 'play', run: () => { if (state.status !== 'RUNNING') toggleServer(); } },
    { label: 'Chanh: Stop Server', icon: 'stop', run: () => { if (state.status === 'RUNNING') toggleServer(); } },
    { label: 'Chanh: Refresh Server Status', icon: 'refresh', run: refreshServer },
    { label: 'Chanh: Set Max Loaded Models…', icon: 'hash', run: setMaxLoadedModels },
    { label: 'Chanh: Download/Update Binary', icon: 'download', run: () => showToast('Binary up to date', 'lemond v11.8.1 is installed.', 'success') },
    { label: 'Chanh: Open Settings', icon: 'gear', run: () => openTab('settings') },
    { label: 'Chanh: Open chatLanguageModels.json', icon: 'file-text', run: () => { openTab('json'); showToast('Opened chatLanguageModels.json', 'A sample endpoint is shown in the editor.', 'info'); } },
    { label: 'Chanh: Add Loaded Model to Chat Endpoints', icon: 'plug', run: () => addEndpoint(state.infoModelId || state.chatModelId) },
    { label: 'Chanh: Hide Installed & Downloadable Sections', icon: 'eye-off', run: toggleHideSections },
    { label: 'Chanh: Toggle Model Grouping by Capability', icon: 'group', run: toggleGrouping },
    { label: 'Chanh: Toggle Downloadable Hot Models Only', icon: 'flame', run: toggleHot },
    { label: 'Developer: Reset Mockup', icon: 'refresh', run: () => location.reload() }
  ];

  function openPalette() {
    closeOverlays();
    toggleModelPicker(false);
    closeMenus();
    let active = 0;
    const overlay = openOverlay(`
      <div class="palette" role="dialog" aria-label="Command Palette">
        <input class="palette-input" id="paletteInput" placeholder="Type the name of a command to run" autocomplete="off" />
        <div class="palette-list" id="paletteList"></div>
      </div>`);
    const input = $('#paletteInput', overlay);
    const list = $('#paletteList', overlay);
    let visible = COMMANDS.slice();
    const render = () => {
      list.innerHTML = visible.map((cmd, i) => `<div class="palette-item ${i === active ? 'active' : ''}" data-palette-index="${i}">
        ${svg(cmd.icon || 'chevron-right')}<span>${esc(cmd.label)}</span><span class="pi-cat">Chanh</span></div>`).join('')
        || '<div class="palette-empty">No matching commands.</div>';
      $$('.palette-item', list).forEach(el => {
        el.addEventListener('click', () => run(Number(el.dataset.paletteIndex)));
      });
    };
    const run = (index) => {
      const cmd = visible[index];
      if (!cmd) return;
      closeOverlays();
      setTimeout(() => cmd.run(), 20);
    };
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      visible = COMMANDS.filter(c => c.label.toLowerCase().includes(q));
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(visible.length - 1, active + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(active); }
    });
    render();
    setTimeout(() => input.focus(), 30);
  }

  function setMaxLoadedModels() {
    openInputDialog({
      title: 'Maximum loaded models',
      label: 'Use -1 for unlimited',
      value: '-1',
      confirmLabel: 'Apply',
      onApply: (value) => showToast('Max loaded models set', `to <b>${esc(value)}</b>`, 'success')
    });
  }

  function refreshServer() {
    const btn = $('[data-view-action="refresh"]');
    btn?.classList.add('spinning');
    setTimeout(() => {
      btn?.classList.remove('spinning');
      renderTree();
      updateStatusbar();
      showToast('Server refreshed', `${state.models.length} installed · ${state.downloadable.length} downloadable`, 'success');
    }, 550);
  }

  function toggleHideSections() {
    state.hideSections = !state.hideSections;
    renderTree();
    showToast(state.hideSections ? 'Model sections hidden' : 'Model sections shown', 'Toggle this any time with the eye button.', 'info');
  }

  function toggleGrouping() {
    state.groupIns = !state.groupIns;
    renderTree();
    showToast('Model grouping ' + (state.groupIns ? 'enabled' : 'disabled'), 'Installed models regroup by capability.', 'info');
  }

  function toggleDlGrouping() {
    state.groupDl = !state.groupDl;
    renderTree();
    showToast('Downloadable grouping ' + (state.groupDl ? 'enabled' : 'disabled'), '', 'info');
  }

  function toggleHot() {
    state.hotOnly = !state.hotOnly;
    renderTree();
    showToast(state.hotOnly ? 'Showing hot models only' : 'Showing all downloadable models', '', 'info');
  }

  function filterGroup(category, downloadable) {
    const key = subFilterKey(category, downloadable);
    const current = state.capFilters[key];
    const { labels, hasGeneral } = subFilterOptions(category, downloadable);
    const items = [
      { label: 'All models', current: !current, value: '' },
      ...labels.map(l => ({ label: l, current: current === l, value: l, description: 'label' })),
      ...(hasGeneral ? [{ label: 'No sub-capability', current: current === '__single__', value: '__single__' }] : [])
    ];
    openQuickPick({
      title: `Filter ${CAP_TITLES[category] || category} by sub-capability`,
      placeholder: 'Choose a sub-capability',
      items,
      onPick: (item) => {
        if (item.value) state.capFilters[key] = item.value;
        else delete state.capFilters[key];
        renderTree();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Status bar                                                          */
  /* ------------------------------------------------------------------ */
  function updateStatusbar() {
    const info = serverInfo();
    const text = $('#statusServerText');
    const url = $('#statusServerUrl');
    if (text) text.textContent = `Chanh: ${state.status === 'RUNNING' ? 'Running' : 'Stopped'}`;
    if (url) url.textContent = info.url.replace('http://', '');
    const model = $('#statusModel');
    if (model) model.textContent = state.chatModelId || 'No model';
    updateComposeFoot();
  }

  /* ------------------------------------------------------------------ */
  /* Tour                                                                */
  /* ------------------------------------------------------------------ */
  const TOUR_STEPS = [
    {
      target: '[data-tour="server"]',
      title: 'A local AI server, managed for you',
      text: 'Chanh boots the <b>Lemonade Server</b> on this machine. Pick the system install, the binary it manages for you, or any custom URL — start, stop and inspect it right here.',
      setup: () => { state.expanded.server = true; renderTree(); openTab('model-info'); }
    },
    {
      target: '[data-tour="installed"]',
      title: 'The model catalog, by capability',
      text: 'Installed and downloadable models are grouped into <b>Chat, Image, Transcription, TTS</b> and more. Hot models wear a flame; the eye button hides the catalog when you need space.',
      setup: () => {
        state.expanded.installed = true;
        state.expanded.capIns.add('chat');
        state.hideSections = false;
        renderTree();
        updateStatusbar();
        syncTreeActionIcons();
      }
    },
    {
      target: '[data-tour="model-Qwen3.5-4B-MTP-GGUF"]',
      title: 'Load, tune, and inspect in place',
      text: 'Loaded models turn green. Hover a row to <b>load</b>, open <b>model info</b> or choose a backend. Right-click for context size and removal.',
      setup: () => {
        state.expanded.installed = true;
        state.expanded.capIns.add('chat');
        state.selectedId = 'Qwen3.5-4B-MTP-GGUF';
        renderTree();
        document.querySelector('[data-tour="model-Qwen3.5-4B-MTP-GGUF"]')?.scrollIntoView({ block: 'center' });
      }
    },
    {
      target: '.info-page',
      title: 'Everything the server reports',
      text: 'Open a model to see the same metadata the server returns: <b>capabilities, context windows, checkpoint, registry, recipe and backend</b>.',
      setup: () => {
        state.infoModelId = state.selectedId || 'Qwen3.5-4B-MTP-GGUF';
        openTab('model-info');
      }
    },
    {
      target: '#modelPill',
      title: 'Chat with @chanh — fully offline',
      text: 'The <b>@chanh</b> participant supports <code>/fix</code> and <code>/explain</code>. Responses stream from the local model, and the footer shows real token usage. Switch models from the picker.',
      setup: () => {
        openTab('chat');
        toggleModelPicker(false);
      }
    },
    {
      target: '.model-picker',
      title: 'Native model picker and agent mode',
      text: 'Models also appear in VS Code’s own picker under <b>Chanh 🍋</b>. Chat models that advertise tool calling work in agent mode — streaming, tools and vision included.',
      setup: () => {
        openTab('chat');
        toggleModelPicker(true);
      }
    },
    {
      target: '#statusServer',
      title: 'Private by design',
      text: 'Once a model is downloaded, everything runs on <b>127.0.0.1</b> — no account, no cloud round-trip, no data leaving the machine. The status bar keeps the local endpoint in view.',
      setup: () => { toggleModelPicker(false); }
    }
  ];

  function startTour() {
    closeOverlays();
    toggleModelPicker(false);
    closeMenus();
    state.tour = { active: true, step: 0 };
    document.body.classList.add('tour-active');
    runTourStep();
  }

  function endTour(completed) {
    state.tour.active = false;
    document.body.classList.remove('tour-active');
    $('#tourRoot').innerHTML = '';
    toggleModelPicker(false);
    if (completed) showToast('Demo complete', 'Explore the sidebar, chat and settings freely — every control is clickable.', 'success');
  }

  function runTourStep() {
    if (!state.tour.active) return;
    const step = TOUR_STEPS[state.tour.step];
    if (!step) { endTour(true); return; }
    try { step.setup?.(); } catch (err) { console.error(err); }
    requestAnimationFrame(() => requestAnimationFrame(() => drawTourStep(step)));
  }

  function drawTourStep(step) {
    const root = $('#tourRoot');
    root.innerHTML = '';
    const target = document.querySelector(step.target);
    if (!target) { nextTour(); return; }
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    const pad = 4;
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    spot.style.left = `${rect.left - pad}px`;
    spot.style.top = `${rect.top - pad}px`;
    spot.style.width = `${rect.width + pad * 2}px`;
    spot.style.height = `${rect.height + pad * 2}px`;
    root.appendChild(spot);

    const pop = document.createElement('div');
    pop.className = 'tour-popover';
    const total = TOUR_STEPS.length;
    pop.innerHTML = `
      <div class="tour-step"><span>Demo · ${state.tour.step + 1} of ${total}</span>
        <span class="tour-dots">${TOUR_STEPS.map((_, i) => `<i class="${i === state.tour.step ? 'on' : ''}"></i>`).join('')}</span></div>
      <h3>${esc(step.title)}</h3>
      <p>${step.text}</p>
      <div class="tour-actions">
        <button class="btn" data-tour="back" ${state.tour.step === 0 ? 'disabled' : ''}>Back</button>
        <button class="btn primary" data-tour="next">${state.tour.step === total - 1 ? 'Finish' : 'Next'}</button>
        <span class="spacer"></span>
        <button class="tour-skip" data-tour="skip">Skip tour</button>
      </div>
      <div class="tour-keys"><kbd>←</kbd><kbd>→</kbd> navigate &nbsp;·&nbsp; <kbd>Esc</kbd> exit</div>`;
    root.appendChild(pop);

    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const gap = 14;
    const wideTarget = rect.width > 520;
    let left, top;
    if (!wideTarget && rect.right + gap + pw < vw) {
      left = rect.right + gap;
      top = rect.top;
    } else if (!wideTarget && rect.left - gap - pw > 0) {
      left = rect.left - gap - pw;
      top = rect.top;
    } else if (rect.bottom + gap + ph < vh) {
      left = rect.left;
      top = rect.bottom + gap;
    } else {
      left = rect.left;
      top = Math.max(12, rect.top - gap - ph);
    }
    left = Math.max(12, Math.min(vw - pw - 12, left));
    top = Math.max(12, Math.min(vh - ph - 12, top));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    pop.querySelector('[data-tour="next"]').addEventListener('click', nextTour);
    pop.querySelector('[data-tour="back"]').addEventListener('click', prevTour);
    pop.querySelectorAll('[data-tour="skip"]').forEach(el => el.addEventListener('click', () => endTour(false)));
  }

  function nextTour() {
    if (!state.tour.active) return;
    state.tour.step += 1;
    if (state.tour.step >= TOUR_STEPS.length) { endTour(true); return; }
    runTourStep();
  }
  function prevTour() {
    if (!state.tour.active) return;
    state.tour.step = Math.max(0, state.tour.step - 1);
    runTourStep();
  }

  /* ------------------------------------------------------------------ */
  /* Event wiring                                                        */
  /* ------------------------------------------------------------------ */
  function actionFrom(el) {
    const actionEl = el.closest('[data-action]');
    if (!actionEl) return null;
    return { action: actionEl.dataset.action, model: actionEl.dataset.model, el: actionEl };
  }

  function handleAction(name, el) {
    const model = requireModel(el);
    switch (name) {
      case 'refresh': refreshServer(); break;
      case 'reveal': showToast('Binary folder', '<code>%USERPROFILE%\\.chanh\\bin</code>', 'info'); break;
      case 'switchServer': openSwitchServer(); break;
      case 'openUrl': showToast('Opening server URL', `<code>${esc(serverInfo().url)}</code>`, 'info'); break;
      case 'editPort': openTab('settings'); break;
      case 'startServer': if (state.status !== 'RUNNING') toggleServer(); break;
      case 'stopServer': if (state.status === 'RUNNING') toggleServer(); break;
      case 'info': selectModel(el.dataset.model); break;
      case 'load': loadModel(el.dataset.model); break;
      case 'unload': unloadModel(el.dataset.model); break;
      case 'context': openContextPicker(el.dataset.model); break;
      case 'backend': openBackendPicker(el.dataset.model); break;
      case 'endpoint': addEndpoint(el.dataset.model); break;
      case 'remove': removeModel(el.dataset.model); break;
      case 'download': startDownload(el.dataset.model); break;
      case 'cancelDownload': cancelDownload(el.dataset.model); break;
      case 'removePartial': removePartial(el.dataset.model); break;
      case 'filterGroup': filterGroup(el.dataset.cap, el.dataset.dl === 'true'); break;
      case 'toggleGrouping': toggleGrouping(); break;
      case 'toggleDlGrouping': toggleDlGrouping(); break;
      case 'toggleHot': toggleHot(); break;
      case 'chatModel': {
        const id = el.dataset.model;
        const m = state.models.find(x => x.id === id);
        if (m && !m.loaded) loadModel(id);
        state.chatModelId = id;
        openTab('chat');
        updateChatHeader();
        renderChatMessages();
        showToast('Chatting with ' + id, 'The model is loaded locally.', 'success');
        break;
      }
      case 'chatPrompt': {
        const id = el.dataset.model;
        const m = state.models.find(x => x.id === id);
        if (m && !m.loaded) loadModel(id);
        state.chatModelId = id;
        openTab('chat');
        updateChatHeader();
        const input = $('#chatInput');
        if (input) { input.value = el.dataset.prompt; autoGrow(input); input.focus(); }
        break;
      }
      case 'copyJson': copyJson(); break;
      case 'openSettingsJson': openTab('json'); break;
      case 'resetDemo': location.reload(); break;
      case 'openModelSettings': openTab('settings'); break;
      default: break;
    }
    if (model) { /* noop; keeps linter quiet */ }
  }

  document.addEventListener('click', (e) => {
    const act = actionFrom(e.target);
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      handleAction(act.action, act.el);
      return;
    }

    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      if (key.startsWith('cap:')) {
        const [, kind, category] = key.split(':');
        const set = kind === 'dl' ? state.expanded.capDl : state.expanded.capIns;
        if (set.has(category)) set.delete(category); else set.add(category);
      } else if (key in state.expanded) {
        state.expanded[key] = !state.expanded[key];
      }
      renderTree();
      return;
    }

    const modelEl = e.target.closest('[data-model-id]');
    if (modelEl) {
      selectModel(modelEl.dataset.modelId);
      return;
    }

    const tabEl = e.target.closest('.tab');
    if (tabEl) {
      const close = e.target.closest('[data-close-tab]');
      if (close) { e.stopPropagation(); closeTab(close.dataset.closeTab); return; }
      openTab(tabEl.dataset.tabId);
      return;
    }

    if (e.target.closest('[data-open-tab]')) {
      const btn = e.target.closest('[data-open-tab]');
      openTab(btn.dataset.openTab);
      return;
    }
    if (e.target.closest('#paletteBtn')) { openPalette(); return; }

    const viewAction = e.target.closest('[data-view-action]');
    if (viewAction) {
      const action = viewAction.dataset.viewAction;
      if (action === 'refresh') refreshServer();
      else if (action === 'toggleHide') toggleHideSections();
      else if (action === 'settings') openTab('settings');
      else if (action === 'more') {
        const rect = viewAction.getBoundingClientRect();
        showContextMenu(rect.right - 230, rect.bottom + 2, [
          { label: 'Switch Server…', icon: 'swap', run: openSwitchServer },
          { label: state.status === 'RUNNING' ? 'Stop Server' : 'Start Server', icon: state.status === 'RUNNING' ? 'stop' : 'play', run: toggleServer },
          { label: 'Download/Update Binary', icon: 'download', run: () => showToast('Binary up to date', 'lemond v11.8.1 is installed.', 'success') },
          { label: 'Set Max Loaded Models…', icon: 'hash', run: setMaxLoadedModels },
          { separator: true },
          { label: 'Open Settings', icon: 'gear', run: () => openTab('settings') },
          { label: 'Open Server URL', icon: 'link', run: () => showToast('Opening server URL', `<code>${esc(serverInfo().url)}</code>`, 'info') }
        ]);
      }
      return;
    }

    const chatAction = e.target.closest('[data-chat-action]');
    if (chatAction) {
      const action = chatAction.dataset.chatAction;
      if (action === 'send') { if (state.stream) stopChat(); else sendChat(); }
      else if (action === 'new') { state.chatMessages = []; seedChat(); renderChatMessages(); showToast('New chat', 'Started a fresh local conversation.', 'info'); }
      else if (action === 'history') showToast('Chat history', 'Local sessions would be listed here (mockup).', 'info');
      else if (action === 'more') showToast('More actions', 'Export, clear and rename chat (mockup).', 'info');
      else if (action === 'agent') showToast('Agent mode', 'Use this model in VS Code’s native agent mode — it advertises tool calling.', 'info');
      else if (action === 'attach') showToast('Add context', 'Pick files or use # to reference the workspace (mockup).', 'info');
      else if (action === 'clearContext') { $('#composeContext')?.remove(); }
      return;
    }

    const insert = e.target.closest('[data-insert]');
    if (insert) {
      const input = $('#chatInput');
      if (input) { input.value = insert.dataset.insert + input.value; autoGrow(input); input.focus(); }
      return;
    }

    const copyMsg = e.target.closest('[data-copy-msg]');
    if (copyMsg) {
      const index = Number(copyMsg.dataset.copyMsg);
      const bubble = copyMsg.closest('.msg-main')?.querySelector('.msg-bubble');
      if (bubble) copyText(bubble.innerText).then(() => showToast('Copied', 'Message copied to clipboard.', 'success'));
      return;
    }
    if (e.target.closest('[data-copy-code]')) {
      const pre = e.target.closest('.code-block')?.querySelector('pre');
      if (pre) copyText(pre.innerText).then(() => showToast('Copied', 'Code copied to clipboard.', 'success'));
      return;
    }
    if (e.target.closest('[data-thumb]')) {
      const thumb = e.target.closest('[data-thumb]');
      showToast(thumb.dataset.thumb === 'up' ? 'Thanks!' : 'Feedback noted', 'This is a mockup, so nothing is sent.', 'info');
      return;
    }

    const modelItem = e.target.closest('[data-pick-model], [data-other-model]');
    if (modelItem) {
      if (e.target.closest('[data-action]')) return;
      if (modelItem.dataset.pickModel) selectChatModel(modelItem.dataset.pickModel);
      return;
    }

    // Clicking outside the model picker closes it — except while the tour is
    // pointing at the picker, where the Next click must not dismiss the target.
    if (!state.tour.active && state.modelPickerOpen && !e.target.closest('#modelPicker') && !e.target.closest('#modelPill')) {
      toggleModelPicker(false);
    }
    if (state.menuOpen && !e.target.closest('.context-menu')) closeMenus();
  });

  document.addEventListener('contextmenu', (e) => {
    const modelEl = e.target.closest('[data-model-id]');
    if (!modelEl) return;
    e.preventDefault();
    modelContextMenu(modelEl.dataset.modelId, e.clientX, e.clientY);
  });

  document.addEventListener('change', (e) => {
    const setting = e.target.closest('[data-setting]');
    if (setting) handleSettingChange(setting);
  });

  document.addEventListener('keydown', (e) => {
    if (state.tour.active) {
      if (e.key === 'Escape') { e.preventDefault(); endTour(false); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nextTour(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prevTour(); }
      return;
    }
    if (e.key === 'Escape') {
      if ($('#overlayRoot').children.length) { closeOverlays(); return; }
      if (state.modelPickerOpen) { toggleModelPicker(false); return; }
      if (state.menuOpen) { closeMenus(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault();
      openPalette();
    }
    if (e.key === 'F1') { e.preventDefault(); openPalette(); }
  });

  window.addEventListener('resize', () => {
    if (state.tour.active) {
      const step = TOUR_STEPS[state.tour.step];
      if (step) drawTourStep(step);
    }
  });

  $('#startTourBtn')?.addEventListener('click', startTour);

  // Status bar interactions
  $('#statusServer')?.addEventListener('click', () => showToast('Chanh server', `<code>${esc(serverInfo().url)}</code> · ${state.status.toLowerCase()}`, 'info'));
  $('#statusModel')?.addEventListener('click', () => openTab('chat'));
  $('#statusTokens')?.addEventListener('click', () => showToast('Token usage', `<b>${fmtNumber(state.tokens.prompt)}</b> prompt + <b>${fmtNumber(state.tokens.completion)}</b> completion tokens this turn.`, 'info'));

  // Activity bar: keep the mockup focused.
  $$('.activity').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.activity === 'chanh') return;
      showToast('Chanh mockup', 'This prototype only implements the Chanh view.', 'info');
    });
  });

  /* ------------------------------------------------------------------ */
  /* Loops / init                                                        */
  /* ------------------------------------------------------------------ */
  function tickSystem() {
    const jitter = (value, min, max, step) => Math.max(min, Math.min(max, value + (Math.random() - 0.5) * step));
    sys.cpu = Math.round(jitter(sys.cpu, 6, 74, 12));
    sys.gpu = Math.round(jitter(sys.gpu, 2, 58, 9));
    sys.ram = Math.round(jitter(sys.ram, 26, 68, 5));
    paintSystem();
  }

  function init() {
    renderTabs();
    renderTree();
    ensureChatView();
    renderModelInfo();
    renderSettings();
    renderJson();
    updateStatusbar();
    updateActiveView();
    setInterval(tickSystem, 2500);
    setInterval(tickDownloads, 700);
  }

  init();
})();
