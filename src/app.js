// CHMate — browser UI controller.
//
// Wires the toolbar, the Contents/Index/Files sidebar and the sandboxed topic
// frame to the ChmReader engine. All heavy lifting (parsing, LZX) lives in
// ./chm; this file is pure DOM glue.

import { ChmReader } from './chm/chm-reader.js';
import { renderTopic, BlobCache } from './render.js';

const $ = (id) => document.getElementById(id);
const app = $('app');

// Inline Tabler-style glyphs for the dynamically-built tree, matching the
// static toolbar icons in index.html.
const ICONS = {
  'chevron-down': '<path d="M6 9l6 6l6 -6"/>',
  folder: '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/>',
  file:
    '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2"/><path d="M9 9l1 0"/><path d="M9 13l6 0"/><path d="M9 17l6 0"/>',
  'device-desktop':
    '<path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10"/><path d="M7 20h10"/><path d="M9 16v4"/><path d="M15 16v4"/>',
  sun: '<path d="M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"/>',
  moon: '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454l0 .008"/>',
};

// Document theme (System -> Light -> Dark), applied to the topic frame only.
const THEME_ORDER = ['system', 'light', 'dark'];
const THEME_ICON = { system: 'device-desktop', light: 'sun', dark: 'moon' };
const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
const icon = (name) => `<svg class="gi" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const state = {
  reader: null,
  blobs: null,
  fileName: '',
  current: null, // current topic path
  history: [],
  hpos: -1,
  zoom: 100,
  docTheme: 'system',
  tocRows: new Map(), // path -> row element
  find: { term: '', marks: [], idx: -1 },
};

function applyDocTheme() {
  const doc = frameDoc();
  if (doc && doc.documentElement) doc.documentElement.dataset.theme = state.docTheme;
}

function setDocTheme(mode) {
  state.docTheme = THEME_ORDER.includes(mode) ? mode : 'system';
  try {
    localStorage.setItem('chmate-doctheme', state.docTheme);
  } catch {
    /* storage may be blocked */
  }
  const btn = $('btnTheme');
  btn.innerHTML = icon(THEME_ICON[state.docTheme]);
  btn.title = 'Document theme: ' + THEME_LABEL[state.docTheme] + ' (click to change)';
  applyDocTheme();
}

function cycleDocTheme() {
  const i = THEME_ORDER.indexOf(state.docTheme);
  setDocTheme(THEME_ORDER[(i + 1) % THEME_ORDER.length]);
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

async function openBuffer(buffer, name) {
  showSpinner(true);
  status('Parsing ' + name + '…');
  try {
    // Yield so the spinner can paint before the (sync) decode work.
    await new Promise((r) => setTimeout(r, 16));
    const reader = ChmReader.open(buffer);
    if (state.blobs) state.blobs.revokeAll();
    state.reader = reader;
    state.blobs = new BlobCache(reader);
    state.fileName = name;
    state.history = [];
    state.hpos = -1;
    state.current = null;

    app.classList.remove('no-file');
    $('fileName').textContent = name;
    $('fileName').title = name + (reader.title ? ' — ' + reader.title : '');
    document.title = (reader.title || name) + ' — CHMate';

    buildContents(reader);
    buildIndex(reader);
    buildFiles(reader);
    enableTools(true);

    const start = reader.defaultTopic && reader.hasFile(reader.defaultTopic)
      ? reader.defaultTopic
      : firstHtml(reader);
    if (start) navigate(start);
    else status('Opened ' + name + ' — no HTML topic found');
    status(name + ' — ' + reader.listFiles().length + ' files');
    statusRight(reader.title || '');
  } catch (err) {
    console.error(err);
    dropError('Could not open this file: ' + err.message);
    status('Failed to open ' + name);
  } finally {
    showSpinner(false);
  }
}

function firstHtml(reader) {
  return reader.listFiles().find((p) => /\.html?$/i.test(p)) || null;
}

async function openFile(file) {
  if (!file) return;
  dropError('');
  const buf = await file.arrayBuffer();
  await openBuffer(buf, file.name);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function navigate(path, opts = {}) {
  const reader = state.reader;
  if (!reader) return;
  let target = path;
  let frag = opts.frag || '';
  if (!frag) {
    const h = path.indexOf('#');
    if (h >= 0) {
      frag = path.slice(h + 1);
      target = path.slice(0, h);
    }
  }
  if (!reader.hasFile(target)) {
    status('Missing topic: ' + target);
    return;
  }

  const html = renderTopic(reader, target, state.blobs);
  const frame = $('frame');
  frame.classList.remove('hidden');
  frame.onload = () => onFrameLoad(frag);
  frame.srcdoc = html;

  state.current = target;
  if (opts.push !== false) {
    state.history = state.history.slice(0, state.hpos + 1);
    state.history.push(target + (frag ? '#' + frag : ''));
    state.hpos = state.history.length - 1;
  }
  updateNavButtons();
  highlightToc(target);
  statusRight(target);
}

function onFrameLoad(frag) {
  const doc = frameDoc();
  if (!doc) return;
  applyZoom();
  applyDocTheme();
  // Intercept link clicks (capture phase) — the frame has no scripts of its own.
  doc.addEventListener('click', onFrameClick, true);
  // Re-run an active find against the freshly loaded document.
  if (state.find.term) runFind(state.find.term, 0);
  if (frag) scrollToFragment(doc, frag);
}

function onFrameClick(e) {
  const a = e.target.closest && e.target.closest('a');
  if (!a) return;
  const internal = a.getAttribute('data-chm-href');
  const external = a.getAttribute('data-chm-ext');
  if (internal) {
    e.preventDefault();
    navigate(internal, { frag: a.getAttribute('data-chm-frag') || '' });
  } else if (external) {
    e.preventDefault();
    if (confirm('Open external link?\n\n' + external)) window.open(external, '_blank', 'noopener');
  }
}

function scrollToFragment(doc, frag) {
  try {
    const el = doc.getElementById(frag) || doc.querySelector(`a[name="${CSS.escape(frag)}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
  } catch {
    /* ignore bad fragments */
  }
}

function goBack() {
  if (state.hpos <= 0) return;
  state.hpos--;
  navigate(state.history[state.hpos], { push: false });
  updateNavButtons();
}
function goForward() {
  if (state.hpos >= state.history.length - 1) return;
  state.hpos++;
  navigate(state.history[state.hpos], { push: false });
  updateNavButtons();
}
function goHome() {
  const r = state.reader;
  if (r && r.defaultTopic) navigate(r.defaultTopic);
}

function updateNavButtons() {
  $('btnBack').disabled = state.hpos <= 0;
  $('btnForward').disabled = state.hpos >= state.history.length - 1;
}

// ---------------------------------------------------------------------------
// Sidebar: Contents tree
// ---------------------------------------------------------------------------

function buildContents(reader) {
  const host = $('toc');
  host.innerHTML = '';
  state.tocRows.clear();
  const tree = reader.getContents();
  if (!tree.length) {
    host.innerHTML = '<div class="empty">No table of contents</div>';
    return;
  }
  host.appendChild(renderNodes(reader, tree));
}

function renderNodes(reader, nodes) {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    const hasKids = node.children && node.children.length > 0;
    const el = document.createElement('div');
    el.className = 'node' + (hasKids ? ' collapsed' : '');

    const row = document.createElement('div');
    row.className = 'row';

    const twist = document.createElement('span');
    twist.className = 'twist' + (hasKids ? '' : ' leaf');
    twist.innerHTML = icon('chevron-down');
    twist.addEventListener('click', (e) => {
      e.stopPropagation();
      el.classList.toggle('collapsed');
    });

    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.innerHTML = icon(hasKids ? 'folder' : 'file');

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.name || '(untitled)';

    row.append(twist, ico, label);

    const target = nodeTarget(reader, node);
    if (target) {
      state.tocRows.set(target, row);
      row.addEventListener('click', () => navigate(target));
    } else if (hasKids) {
      row.addEventListener('click', () => el.classList.toggle('collapsed'));
    }

    el.appendChild(row);
    if (hasKids) {
      const kids = document.createElement('div');
      kids.className = 'children';
      kids.appendChild(renderNodes(reader, node.children));
      el.appendChild(kids);
    }
    frag.appendChild(el);
  }
  return frag;
}

function nodeTarget(reader, node) {
  if (node.url) return null; // external; handled only if it's a real topic
  if (!node.local) return null;
  const abs = reader.resolvePath(reader.contentsPath || '/', node.local);
  return reader.hasFile(stripHash(abs)) ? abs : null;
}

function highlightToc(path) {
  for (const [p, row] of state.tocRows) {
    const on = stripHash(p) === path;
    row.classList.toggle('active', on);
    if (on) {
      // Expand ancestors and reveal.
      let n = row.parentElement;
      while (n && n.classList) {
        if (n.classList.contains('node')) n.classList.remove('collapsed');
        n = n.parentElement;
      }
      row.scrollIntoView({ block: 'nearest' });
    }
  }
}

// ---------------------------------------------------------------------------
// Sidebar: Index + Files
// ---------------------------------------------------------------------------

function buildIndex(reader) {
  const host = $('indexList');
  host.innerHTML = '';
  const tree = reader.getIndex();
  const items = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      items.push({ name: n.name, local: n.local, url: n.url, depth });
      if (n.children && n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  if (!items.length) {
    host.innerHTML = '<div class="empty">No index</div>';
    return;
  }
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'item' + (it.depth ? ' sub' : '');
    div.textContent = it.name || it.local || '(untitled)';
    div.dataset.search = (it.name || '').toLowerCase();
    if (it.local) {
      const abs = reader.resolvePath(reader.indexPath || '/', it.local);
      if (reader.hasFile(stripHash(abs))) div.addEventListener('click', () => navigate(abs));
    }
    host.appendChild(div);
  }
}

function buildFiles(reader) {
  const host = $('filesList');
  host.innerHTML = '';
  const files = reader
    .listFiles()
    .filter((p) => !p.startsWith('::') && !p.startsWith('/#') && !p.startsWith('/$'))
    .sort();
  for (const p of files) {
    const div = document.createElement('div');
    div.className = 'item';
    div.textContent = p;
    div.dataset.search = p.toLowerCase();
    div.addEventListener('click', () => {
      if (/\.html?$/i.test(p)) navigate(p);
      else openResource(p);
    });
    host.appendChild(div);
  }
}

function openResource(path) {
  const url = state.blobs.urlFor(path);
  if (url) window.open(url, '_blank', 'noopener');
}

function filterList(hostId, term) {
  const t = term.toLowerCase();
  for (const item of $(hostId).children) {
    if (item.classList.contains('item')) {
      item.style.display = !t || item.dataset.search.includes(t) ? '' : 'none';
    }
  }
}

// ---------------------------------------------------------------------------
// Zoom / find / print
// ---------------------------------------------------------------------------

function frameDoc() {
  try {
    return $('frame').contentDocument;
  } catch {
    return null;
  }
}

function setZoom(z) {
  state.zoom = Math.max(40, Math.min(300, Math.round(z)));
  $('btnZoomReset').textContent = state.zoom + '%';
  applyZoom();
}
function applyZoom() {
  const doc = frameDoc();
  if (doc && doc.body) doc.body.style.zoom = state.zoom / 100;
}

function runFind(term, dir) {
  const doc = frameDoc();
  state.find.term = term;
  if (!doc) return;
  clearFind(doc);
  if (!term) {
    $('findCount').textContent = '';
    return;
  }
  const marks = [];
  const lc = term.toLowerCase();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const tag = node.parentNode && node.parentNode.nodeName;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'MARK') return NodeFilter.FILTER_REJECT;
      return node.nodeValue.toLowerCase().includes(lc) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  for (const node of targets) {
    const text = node.nodeValue;
    const frag = doc.createDocumentFragment();
    let i = 0;
    let lci = text.toLowerCase();
    let pos;
    while ((pos = lci.indexOf(lc, i)) !== -1) {
      if (pos > i) frag.appendChild(doc.createTextNode(text.slice(i, pos)));
      const mark = doc.createElement('mark');
      mark.className = 'chm-find';
      mark.textContent = text.slice(pos, pos + term.length);
      frag.appendChild(mark);
      marks.push(mark);
      i = pos + term.length;
    }
    if (i < text.length) frag.appendChild(doc.createTextNode(text.slice(i)));
    node.parentNode.replaceChild(frag, node);
  }
  state.find.marks = marks;
  state.find.idx = marks.length ? 0 : -1;
  if (dir === 0) focusMark(0);
  updateFindCount();
}

function clearFind(doc) {
  for (const m of doc.querySelectorAll('mark.chm-find')) {
    const parent = m.parentNode;
    parent.replaceChild(doc.createTextNode(m.textContent), m);
    parent.normalize();
  }
  state.find.marks = [];
  state.find.idx = -1;
}

function stepFind(delta) {
  const { marks } = state.find;
  if (!marks.length) return;
  state.find.idx = (state.find.idx + delta + marks.length) % marks.length;
  focusMark(state.find.idx);
}

function focusMark(i) {
  const { marks } = state.find;
  marks.forEach((m, k) => m.classList.toggle('chm-active', k === i));
  if (marks[i]) marks[i].scrollIntoView({ block: 'center' });
  updateFindCount();
}

function updateFindCount() {
  const { marks, idx } = state.find;
  $('findCount').textContent = marks.length ? `${idx + 1}/${marks.length}` : '0/0';
  $('findPrev').disabled = $('findNext').disabled = marks.length === 0;
}

function printTopic() {
  const frame = $('frame');
  try {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch {
    window.print();
  }
}

// ---------------------------------------------------------------------------
// Chrome: tabs, resizer, fullscreen, status
// ---------------------------------------------------------------------------

function enableTools(on) {
  ['btnBack', 'btnForward', 'btnHome', 'btnZoomOut', 'btnZoomReset', 'btnZoomIn', 'btnPrint', 'findInput', 'findPrev', 'findNext'].forEach(
    (id) => ($(id).disabled = !on),
  );
  if (on) updateNavButtons();
}

function showSpinner(on) {
  $('spinner').classList.toggle('hidden', !on);
}
function status(msg) {
  $('statusLeft').textContent = msg;
}
function statusRight(msg) {
  $('statusRight').textContent = msg;
}
function dropError(msg) {
  $('dropErr').textContent = msg || '';
}
function stripHash(p) {
  const i = p.indexOf('#');
  return i >= 0 ? p.slice(0, i) : p;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.rail-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
}

function initResizer() {
  const resizer = $('resizer');
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(180, Math.min(560, e.clientX));
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    resizer.classList.remove('dragging');
  });
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

function init() {
  const picker = $('filePicker');
  $('btnOpen').addEventListener('click', () => picker.click());
  $('btnOpen2').addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => openFile(picker.files[0]));

  $('btnBack').addEventListener('click', goBack);
  $('btnForward').addEventListener('click', goForward);
  $('btnHome').addEventListener('click', goHome);
  $('btnZoomIn').addEventListener('click', () => setZoom(state.zoom + 10));
  $('btnZoomOut').addEventListener('click', () => setZoom(state.zoom - 10));
  $('btnZoomReset').addEventListener('click', () => setZoom(100));
  $('btnPrint').addEventListener('click', printTopic);
  $('btnFull').addEventListener('click', toggleFullscreen);
  $('btnTheme').addEventListener('click', cycleDocTheme);

  // Restore the saved document theme (default: follow the OS).
  let savedTheme = 'system';
  try {
    savedTheme = localStorage.getItem('chmate-doctheme') || 'system';
  } catch {
    /* storage may be blocked */
  }
  setDocTheme(savedTheme);

  $('btnHideSidebar').addEventListener('click', () => app.classList.add('sidebar-hidden'));
  $('btnExpandSidebar').addEventListener('click', () => app.classList.remove('sidebar-hidden'));
  document.querySelectorAll('.rail-tab').forEach((t) =>
    t.addEventListener('click', () => {
      app.classList.remove('sidebar-hidden');
      switchTab(t.dataset.tab);
    }),
  );
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('indexFilter').addEventListener('input', (e) => filterList('indexList', e.target.value));
  $('filesFilter').addEventListener('input', (e) => filterList('filesList', e.target.value));

  const findInput = $('findInput');
  findInput.addEventListener('input', () => runFind(findInput.value, 0));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      findInput.value = '';
      runFind('', 0);
    }
  });
  $('findNext').addEventListener('click', () => stepFind(1));
  $('findPrev').addEventListener('click', () => stepFind(-1));

  // Drag & drop
  const dz = $('dropzone');
  const viewer = document.querySelector('.viewer');
  ['dragenter', 'dragover'].forEach((ev) =>
    viewer.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    viewer.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && e.target !== dz && dz.contains(e.target)) return;
      dz.classList.remove('dragover');
    }),
  );
  viewer.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  });

  // Sample
  $('btnSample').addEventListener('click', async (e) => {
    e.preventDefault();
    dropError('');
    status('Loading sample…');
    try {
      const res = await fetch('samples/putty.chm');
      if (!res.ok) throw new Error('sample not found (' + res.status + ')');
      await openBuffer(await res.arrayBuffer(), 'putty.chm');
    } catch (err) {
      dropError('Could not load sample: ' + err.message + '. Open a local .chm instead.');
    }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      picker.click();
    } else if (meta && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      setZoom(state.zoom + 10);
    } else if (meta && e.key === '-') {
      e.preventDefault();
      setZoom(state.zoom - 10);
    } else if (meta && e.key === '0') {
      e.preventDefault();
      setZoom(100);
    } else if (meta && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('findInput').focus();
    } else if (e.altKey && e.key === 'ArrowLeft') {
      goBack();
    } else if (e.altKey && e.key === 'ArrowRight') {
      goForward();
    }
  });

  initResizer();

  // Allow ?file=URL to auto-load a CHM (same-origin).
  const url = new URLSearchParams(location.search).get('file');
  if (url) {
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => openBuffer(b, url.split('/').pop()))
      .catch((err) => dropError('Could not load ' + url + ': ' + err.message));
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

init();
