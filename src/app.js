const API = 'http://127.0.0.1:8765';
const STORAGE_KEY = 'cctv-viewer.config.v1';
const DEFAULT = { layout: 4, cameras: [], focus: null, fitMode: 'fill', uiVersion: 2 };

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const fitMode = (saved.uiVersion || 1) < 2 ? 'fill' : (saved.fitMode || 'fill');
    return { ...DEFAULT, ...saved, fitMode, uiVersion: 2, cameras: Array.isArray(saved.cameras) ? saved.cameras : [] };
  } catch {
    return { ...DEFAULT };
  }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let state = load();
let serverReady = false;
let streamToken = Date.now();
let openMenuNode = null;
let openMenuIndex = null;
let cameraStatus = new Map();
let cameraAspects = new Map();
let cameraZooms = new Map();

const conn = document.getElementById('conn');
const summary = document.getElementById('summary');
const grid = document.getElementById('grid');
const layoutButtons = document.getElementById('layoutButtons');
const viewButtons = document.getElementById('viewButtons');
const modalBackdrop = document.getElementById('modalBackdrop');
const modalTitle = document.getElementById('modalTitle');
const cameraList = document.getElementById('cameraList');
const cameraForm = document.getElementById('cameraForm');
const cameraName = document.getElementById('cameraName');
const cameraUrl = document.getElementById('cameraUrl');
const cameraAspectSelect = document.getElementById('cameraAspect');
const updateBtn = document.getElementById('updateBtn');
const updateBanner = document.getElementById('updateBanner');
const editIndex = document.getElementById('editIndex');
const saveCameraBtn = document.getElementById('saveCameraBtn');

function aspectForCamera(camera) {
  if (!camera) return 16 / 9;
  const manual = String(camera.aspect || '').trim();
  if (manual && manual !== 'auto') {
    const [width, height] = manual.split(':').map(Number);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return width / height;
    }
  }
  return cameraAspects.get(camera.url) || 16 / 9;
}

function noteCameraAspect(image, index) {
  const camera = state.cameras[index];
  if (!camera?.url || (camera.aspect && camera.aspect !== 'auto')) return;
  if (!image?.naturalWidth || !image?.naturalHeight) return;
  const ratio = image.naturalWidth / image.naturalHeight;
  if (!Number.isFinite(ratio) || ratio < 0.3 || ratio > 4) return;
  const previous = cameraAspects.get(camera.url);
  if (previous && Math.abs(previous - ratio) < 0.01) return;
  cameraAspects.set(camera.url, ratio);
  layoutTiles();
}

function zoomFor(index) {
  const camera = state.cameras[index];
  return (camera?.url && cameraZooms.get(camera.url)) || { scale: 1, x: 0, y: 0 };
}

function saveZoom(index, zoom) {
  const camera = state.cameras[index];
  if (camera?.url) cameraZooms.set(camera.url, { ...zoom });
}

function applyZoom(image, index) {
  if (!image) return;
  const zoom = zoomFor(index);
  image.style.transformOrigin = 'center center';
  image.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}

function zoomLabelText(index) {
  return `${Math.round(zoomFor(index).scale * 100)}%`;
}

function adjustZoom(index, delta) {
  const tile = grid.querySelector(`.camera-tile[data-index="${index}"]`);
  if (!tile) return;
  const zoom = zoomFor(index);
  zoom.scale = Math.max(1, Math.min(6, Math.round((zoom.scale + delta) * 100) / 100));
  if (zoom.scale === 1) {
    zoom.x = 0;
    zoom.y = 0;
  }
  saveZoom(index, zoom);
  applyZoom(tile.querySelector('img'), index);
  const label = tile.querySelector('.zoom-label');
  if (label) label.textContent = zoomLabelText(index);
}

function columnsFor(count) {
  return count === 1 ? 1 : count === 2 ? 2 : count === 3 ? 3 : count <= 4 ? 2 : 3;
}

function layoutTiles() {
  if (state.focus != null) {
    grid.querySelectorAll('.tile-row').forEach(row => {
      row.style.height = '';
      row.style.gap = '';
    });
    grid.querySelectorAll('.camera-tile').forEach(tile => {
      tile.style.width = '';
      tile.style.height = '';
    });
    return;
  }
  const rows = [...grid.querySelectorAll('.tile-row')];
  if (!rows.length) return;
  const rect = grid.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return;
  const gap = 10;
  if (state.fitMode === 'fill') {
    const columns = Math.max(...rows.map(row => row.querySelectorAll('.camera-tile').length));
    const tileWidth = Math.max(40, Math.floor((rect.width - gap * (columns - 1)) / columns));
    const tileHeight = Math.max(30, Math.floor((rect.height - gap * (rows.length - 1)) / rows.length));
    rows.forEach(row => {
      row.style.height = `${tileHeight}px`;
      row.style.gap = `${gap}px`;
      row.querySelectorAll('.camera-tile').forEach(tile => {
        tile.style.width = `${tileWidth}px`;
        tile.style.height = `${tileHeight}px`;
      });
    });
    return;
  }
  const data = rows.map(row => {
    const tiles = [...row.querySelectorAll('.camera-tile')];
    const aspects = tiles.map(tile => aspectForCamera(state.cameras[Number(tile.dataset.index)]));
    const aspectSum = aspects.reduce((sum, aspect) => sum + aspect, 0) || tiles.length;
    return {
      row,
      tiles,
      aspects,
      maxHeight: (rect.width - gap * (tiles.length - 1)) / aspectSum,
    };
  });
  const heights = data.map(item => Math.max(1, item.maxHeight));
  const totalHeight = heights.reduce((sum, height) => sum + height, 0) + gap * (rows.length - 1);
  const scale = totalHeight > rect.height ? rect.height / totalHeight : 1;
  data.forEach((item, rowIndex) => {
    const height = Math.max(30, Math.floor(heights[rowIndex] * scale));
    item.row.style.height = `${height}px`;
    item.row.style.gap = `${gap}px`;
    item.tiles.forEach((tile, tileIndex) => {
      const width = Math.max(30, Math.floor(height * item.aspects[tileIndex]));
      tile.style.width = `${width}px`;
      tile.style.height = `${height}px`;
    });
  });
}

function setConn(text, tone) {
  conn.textContent = text;
  conn.className = `status-pill ${tone}`;
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${API}/health`, { cache: 'no-store' });
      if (res.ok) {
        serverReady = true;
        setConn('Ready', 'live');
        await pushConfig();
        void refreshStatuses();
        return;
      }
    } catch { /* sidecar still starting */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  setConn('Offline', 'error');
}

async function pushConfig() {
  if (!serverReady) return;
  try {
    const res = await fetch(`${API}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cameras: state.cameras }),
    });
    if (!res.ok) throw new Error('Engine rejected camera configuration');
    setTimeout(() => void refreshStatuses(), 400);
  } catch {
    setConn('Offline', 'error');
  }
}

async function refreshStatuses() {
  if (!serverReady) return;
  try {
    const res = await fetch(`${API}/status`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const next = new Map();
    for (const camera of data.cameras || []) {
      next.set(camera.index, camera);
      const tile = grid.querySelector(`.camera-tile[data-index="${camera.index}"]`);
      if (!tile) continue;
      const dot = tile.querySelector('.stream-dot');
      if (dot) dot.className = `stream-dot ${camera.state || 'connecting'}`;
      const overlay = tile.querySelector('.tile-state');
      if (overlay) {
        if (camera.state === 'live') {
          overlay.classList.add('hidden');
        } else {
          overlay.classList.remove('hidden');
          overlay.querySelector('.tile-state-title').textContent =
            camera.state === 'offline' || camera.state === 'reconnecting' ? 'No video' : 'Connecting…';
          overlay.querySelector('.tile-state-detail').textContent =
            camera.error || 'Waiting for the camera stream…';
        }
      }
      const image = tile.querySelector('img');
      if (image && camera.state === 'live') noteCameraAspect(image, camera.index);
      if (image && camera.state === 'live' && image.dataset.failed) {
        delete image.dataset.failed;
        image.classList.remove('stream-failed');
        image.src = `${API}/camera/${camera.index}.mjpg?token=${Date.now()}`;
      }
    }
    cameraStatus = next;
  } catch { /* keep the last known state */ }
}

function cameraLabel(camera, index) {
  return String(camera?.name || `Camera ${index + 1}`).trim();
}

function visibleIndices() {
  if (state.focus != null && state.cameras[state.focus]?.url) return [state.focus];
  return Array.from({ length: Math.min(state.layout, state.cameras.length) }, (_, i) => i);
}

function renderLayoutButtons() {
  layoutButtons.replaceChildren();
  for (const count of [1, 2, 4, 6]) {
    layoutButtons.append(el('button', {
      type: 'button',
      class: state.focus == null && state.layout === count ? 'active' : '',
      text: String(count),
      onclick: () => {
        state.layout = count;
        state.focus = null;
        save();
        render();
      },
    }));
  }
}

function renderViewButtons() {
  viewButtons.replaceChildren();
  for (const [mode, label] of [['fill', 'Fill'], ['contain', 'Fit']]) {
    viewButtons.append(el('button', {
      type: 'button',
      class: state.fitMode === mode ? 'active' : '',
      text: label,
      onclick: () => {
        state.fitMode = mode;
        save();
        render();
      },
    }));
  }
}

function tileFor(index) {
  const camera = state.cameras[index];
  const hasUrl = Boolean(camera?.url);
  const tile = el('article', {
    class: 'camera-tile',
    dataset: { index: String(index) },
    title: hasUrl ? 'Click to maximize' : 'Camera not configured',
    onclick: event => {
      if (event.target.closest('button') || event.target.closest('.tile-menu')) return;
      if (!hasUrl) { openModal(index); return; }
      closeTileMenu();
      state.focus = state.focus === index ? null : index;
      save();
      render();
    },
  });
  const more = el('button', {
    class: 'tile-more',
    type: 'button',
    title: 'Camera details',
    'aria-label': `Details for ${camera ? name(camera) : `Camera ${index + 1}`}`,
    text: '⋮',
  });
  more.addEventListener('click', event => {
    event.stopPropagation();
    if (openMenuIndex === index) closeTileMenu();
    else openTileMenu(index, tile);
  });
  if (hasUrl) {
    tile.addEventListener('wheel', event => {
      event.preventDefault();
      adjustZoom(index, event.deltaY < 0 ? 0.25 : -0.25);
    }, { passive: false });
    let drag = null;
    let dragMoved = false;
    tile.addEventListener('click', event => {
      if (!dragMoved) return;
      dragMoved = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    tile.addEventListener('pointerdown', event => {
      const zoom = zoomFor(index);
      if (zoom.scale <= 1 || event.button !== 0 || event.target.closest('button') || event.target.closest('.tile-menu')) return;
      drag = { startX: event.clientX, startY: event.clientY, originX: zoom.x, originY: zoom.y };
      dragMoved = false;
      tile.setPointerCapture(event.pointerId);
    });
    tile.addEventListener('pointermove', event => {
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
      if (!dragMoved) return;
      const zoom = zoomFor(index);
      const maxX = (zoom.scale - 1) * tile.clientWidth / 2;
      const maxY = (zoom.scale - 1) * tile.clientHeight / 2;
      zoom.x = Math.max(-maxX, Math.min(maxX, drag.originX + dx));
      zoom.y = Math.max(-maxY, Math.min(maxY, drag.originY + dy));
      saveZoom(index, zoom);
      applyZoom(tile.querySelector('img'), index);
    });
    const endDrag = () => { drag = null; };
    tile.addEventListener('pointerup', endDrag);
    tile.addEventListener('pointercancel', endDrag);
  }
  const zoomControls = state.focus === index && hasUrl
    ? el('div', { class: 'zoom-controls' },
        el('button', { class: 'zoom-btn', type: 'button', title: 'Zoom out', text: '−', onclick: event => { event.stopPropagation(); adjustZoom(index, -0.25); } }),
        el('span', { class: 'zoom-label', text: zoomLabelText(index) }),
        el('button', { class: 'zoom-btn', type: 'button', title: 'Zoom in', text: '+', onclick: event => { event.stopPropagation(); adjustZoom(index, 0.25); } }),
        el('button', { class: 'zoom-btn zoom-reset', type: 'button', title: 'Reset zoom', text: '1×', onclick: event => { event.stopPropagation(); const zoom = { scale: 1, x: 0, y: 0 }; saveZoom(index, zoom); applyZoom(tile.querySelector('img'), index); const label = tile.querySelector('.zoom-label'); if (label) label.textContent = '100%'; } }),
      )
    : null;
  const back = state.focus === index
    ? el('button', { class: 'tile-back', type: 'button', text: 'Back to grid', onclick: event => { event.stopPropagation(); state.focus = null; save(); render(); } })
    : null;
  tile.append(el('div', { class: 'tile-head' },
    el('div', { class: 'tile-name min-w-0' },
      el('span', { class: 'stream-dot' }),
      el('span', { class: 'tile-title', text: camera ? name(camera) : `Camera ${index + 1}` }),
    ),
    el('div', { class: 'tile-actions' }, zoomControls, back, more),
  ));
  if (hasUrl) {
    const image = el('img', {
      alt: name(camera),
      src: `${API}/camera/${index}.mjpg?token=${streamToken}`,
      draggable: 'false',
    });
    image.addEventListener('error', () => {
      image.dataset.failed = '1';
      image.classList.add('stream-failed');
    });
    image.addEventListener('load', () => noteCameraAspect(image, index));
    tile.append(image);
    applyZoom(image, index);
    tile.append(el('div', { class: 'tile-state hidden' },
      el('span', { class: 'tile-state-title', text: 'Connecting…' }),
      el('span', { class: 'tile-state-detail', text: 'Waiting for the camera stream…' }),
    ));
  } else {
    tile.append(el('div', { class: 'tile-empty' }, el('div', {}, el('strong', { text: 'Camera not configured' }), el('p', { class: 'muted', text: 'Add an RTSP URL to start watching.' }))));
  }
  return tile;
}

function closeTileMenu() {
  if (openMenuNode) openMenuNode.remove();
  openMenuNode = null;
  openMenuIndex = null;
}

function openTileMenu(index, tile) {
  closeTileMenu();
  const camera = state.cameras[index];
  if (!camera) return;
  const menu = el('div', { class: 'tile-menu' });
  const status = cameraStatus.get(index);
  const stateText = !camera.url ? 'Not configured'
    : cameraStatus.size === 0 ? 'Checking…'
    : cameraStatus.has(index) ? (cameraStatus.get(index).state === 'live' ? 'Live' : cameraStatus.get(index).state) : 'Connecting…';
  menu.append(el('div', { class: 'tile-menu-details' },
    el('p', { class: 'tile-menu-kicker', text: 'Camera details' }),
    el('strong', { text: cameraLabel(camera, index) }),
    el('span', { class: `tile-menu-state ${status?.state || 'connecting'}`, text: stateText.charAt(0).toUpperCase() + stateText.slice(1) }),
    el('span', { class: 'tile-menu-url', text: camera.url || 'No RTSP URL configured' }),
  ));
  menu.append(el('div', { class: 'tile-menu-actions' },
    el('button', { class: 'menu-action', type: 'button', text: 'Edit camera', onclick: () => { closeTileMenu(); openModal(index); } }),
    el('button', { class: 'menu-action', type: 'button', text: state.focus === index ? 'Back to grid' : 'Maximize camera', onclick: () => { closeTileMenu(); state.focus = state.focus === index ? null : index; save(); render(); } }),
    el('button', { class: 'menu-action', type: 'button', text: state.fitMode === 'fill' ? 'Fit full camera view' : 'Fill screen', onclick: () => { closeTileMenu(); state.fitMode = state.fitMode === 'fill' ? 'contain' : 'fill'; save(); render(); } }),
    el('button', { class: 'menu-action', type: 'button', text: 'Reset zoom', onclick: () => { closeTileMenu(); saveZoom(index, { scale: 1, x: 0, y: 0 }); adjustZoom(index, 0); } }),
    el('button', { class: 'menu-action danger', type: 'button', text: 'Remove camera', onclick: () => { closeTileMenu(); void deleteCamera(index); } }),
  ));
  tile.append(menu);
  openMenuNode = menu;
  openMenuIndex = index;
}

function name(camera) {
  return cameraLabel(camera, state.cameras.indexOf(camera));
}

function render() {
  closeTileMenu();
  document.body.classList.toggle('focus-mode', state.focus != null);
  renderLayoutButtons();
  renderViewButtons();
  const count = state.cameras.length;
  summary.textContent = count
    ? `${count} camera${count === 1 ? '' : 's'} configured · showing ${state.focus != null ? 1 : Math.min(state.layout, count)}`
    : 'No cameras configured';
  const indices = visibleIndices();
  grid.className = `camera-grid ${indices.length === 1 ? 'single' : indices.length === 2 ? 'two' : indices.length === 3 ? 'three' : indices.length <= 4 ? 'four' : 'six'} ${state.fitMode === 'fill' ? 'fill-mode' : 'fit-mode'}`;
  grid.replaceChildren();
  if (!count) {
    const icon = el('div', { class: 'empty-icon' });
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7.5h3l1.4-2h7.2l1.4 2h3a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13.5" r="3.5"/></svg>';
    grid.append(el('div', { class: 'empty-state card' },
      icon,
      el('h2', { text: 'No cameras yet' }),
      el('p', { text: 'Add your first RTSP camera to start watching.' }),
      el('button', { class: 'btn primary', type: 'button', text: 'Add camera', onclick: openModal }),
    ));
    return;
  }
  if (state.focus != null) {
    grid.append(tileFor(state.focus));
  } else {
    const columns = columnsFor(indices.length);
    for (let start = 0; start < indices.length; start += columns) {
      const row = el('div', { class: 'tile-row' });
      for (const index of indices.slice(start, start + columns)) row.append(tileFor(index));
      grid.append(row);
    }
  }
  requestAnimationFrame(layoutTiles);
  void refreshStatuses();
}

function openModal(edit = null) {
  modalBackdrop.classList.remove('hidden');
  modalTitle.textContent = edit == null ? 'Manage cameras' : 'Edit camera';
  renderCameraList();
  if (edit != null) editCamera(edit);
  else resetForm();
  setTimeout(() => cameraName.focus(), 30);
}

function closeModal() {
  modalBackdrop.classList.add('hidden');
  resetForm();
}

function renderCameraList() {
  cameraList.replaceChildren();
  if (!state.cameras.length) {
    cameraList.append(el('p', { class: 'form-hint', text: 'No cameras yet. Use the form to add one.' }));
    return;
  }
  state.cameras.forEach((camera, index) => {
    cameraList.append(el('div', { class: 'camera-row' },
      el('div', { class: 'min-w-0' },
        el('strong', { text: cameraLabel(camera, index) }),
        el('span', { text: camera.url }),
      ),
      el('div', { class: 'camera-row-actions' },
        el('button', { class: 'btn ghost small', type: 'button', text: 'Edit', onclick: () => editCamera(index) }),
        el('button', { class: 'btn danger small', type: 'button', text: 'Delete', onclick: () => deleteCamera(index) }),
      ),
    ));
  });
}

function editCamera(index) {
  const camera = state.cameras[index];
  if (!camera) return;
  editIndex.value = String(index);
  cameraName.value = camera.name || '';
  cameraUrl.value = camera.url || '';
  cameraAspectSelect.value = camera.aspect || 'auto';
  saveCameraBtn.textContent = 'Update camera';
  cameraName.focus();
}

function resetForm() {
  editIndex.value = '';
  cameraName.value = '';
  cameraUrl.value = '';
  cameraAspectSelect.value = 'auto';
  saveCameraBtn.textContent = 'Add camera';
}

async function deleteCamera(index) {
  const camera = state.cameras[index];
  if (!camera) return;
  if (!confirm(`Remove "${cameraLabel(camera, index)}"?`)) return;
  state.cameras.splice(index, 1);
  if (state.focus === index) state.focus = null;
  else if (state.focus != null && state.focus > index) state.focus -= 1;
  save();
  renderCameraList();
  await pushConfig();
  streamToken = Date.now();
  render();
}

cameraForm.addEventListener('submit', async event => {
  event.preventDefault();
  const url = cameraUrl.value.trim();
  if (!url) { cameraUrl.focus(); return; }
  const camera = {
    name: cameraName.value.trim() || `Camera ${state.cameras.length + 1}`,
    url,
    aspect: cameraAspectSelect.value || 'auto',
  };
  const index = Number(editIndex.value);
  if (Number.isInteger(index) && editIndex.value !== '') state.cameras[index] = camera;
  else state.cameras.push(camera);
  save();
  resetForm();
  renderCameraList();
  await pushConfig();
  streamToken = Date.now();
  render();
});

document.getElementById('addBtn').addEventListener('click', () => openModal());
document.getElementById('manageBtn').addEventListener('click', () => openModal());
document.getElementById('closeModalBtn').addEventListener('click', closeModal);
document.getElementById('resetFormBtn').addEventListener('click', resetForm);
modalBackdrop.addEventListener('click', event => { if (event.target === modalBackdrop) closeModal(); });

let updateBusy = false;

function tauriBridge() {
  return window.__TAURI__ || null;
}

function renderUpdateBanner(message) {
  updateBanner.replaceChildren();
  if (!message) {
    updateBanner.classList.add('hidden');
    return;
  }
  updateBanner.classList.remove('hidden');
  const action = el('button', { class: 'btn primary', type: 'button', text: message.action || 'OK' });
  action.addEventListener('click', message.onAction || (() => renderUpdateBanner(null)));
  updateBanner.append(el('div', { class: 'update-inner' },
    el('div', {},
      el('p', { class: 'update-title', text: message.title }),
      el('p', { class: 'update-body', text: message.body || '' }),
    ),
    el('div', { class: 'update-actions' }, action),
  ));
}

async function checkForUpdates(manual = false) {
  const bridge = tauriBridge();
  if (!bridge?.core?.invoke) {
    if (manual) renderUpdateBanner({ title: 'Update check unavailable', body: 'Run the installed desktop app to check for updates.', action: 'Close' });
    return;
  }
  if (manual) {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Checking…';
  }
  try {
    const update = await bridge.core.invoke('check_update');
    if (update) {
      renderUpdateBanner({
        title: `Update available: ${update.version}`,
        body: `Installed: ${update.currentVersion}. Download and install, then the app restarts automatically.`,
        action: 'Download & install',
        onAction: () => void installUpdate(),
      });
    } else if (manual) {
      renderUpdateBanner({ title: 'You are up to date', body: 'This is the latest available version.', action: 'Close' });
    }
  } catch (error) {
    if (manual) renderUpdateBanner({ title: 'Update check failed', body: error?.message || String(error), action: 'Close' });
  } finally {
    if (manual) {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update';
    }
  }
}

async function installUpdate() {
  if (updateBusy) return;
  const bridge = tauriBridge();
  if (!bridge?.core?.invoke) return;
  updateBusy = true;
  renderUpdateBanner({
    title: 'Installing update…',
    body: 'The signed update is downloading. The app will restart when it is ready.',
    action: 'Installing…',
  });
  try {
    await bridge.core.invoke('install_update');
  } catch (error) {
    updateBusy = false;
    renderUpdateBanner({ title: 'Update failed', body: error?.message || String(error), action: 'Close' });
  }
}

updateBtn.addEventListener('click', () => void checkForUpdates(true));
setTimeout(() => void checkForUpdates(false), 4000);

document.getElementById('fullscreenBtn').addEventListener('click', toggleFullscreen);
document.addEventListener('click', event => {
  if (!openMenuNode) return;
  if (event.target.closest('.tile-menu') || event.target.closest('.tile-more')) return;
  closeTileMenu();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (document.fullscreenElement) return;
    if (openMenuNode) { closeTileMenu(); return; }
    if (!modalBackdrop.classList.contains('hidden')) { closeModal(); return; }
    if (state.focus != null) { state.focus = null; save(); render(); }
  }
  if (state.focus != null) {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); adjustZoom(state.focus, 0.25); }
    else if (event.key === '-') { event.preventDefault(); adjustZoom(state.focus, -0.25); }
    else if (event.key === '0') { event.preventDefault(); saveZoom(state.focus, { scale: 1, x: 0, y: 0 }); adjustZoom(state.focus, 0); }
  }
  if (event.key === 'F11') {
    event.preventDefault();
    void toggleFullscreen();
  }
});

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* WebView may manage fullscreen itself */ }
}

document.addEventListener('fullscreenchange', () => {
  document.getElementById('fullscreenBtn').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
});

window.addEventListener('resize', () => requestAnimationFrame(layoutTiles));
new ResizeObserver(() => requestAnimationFrame(layoutTiles)).observe(grid);

render();
void waitForServer();
setInterval(() => { if (serverReady) void refreshStatuses(); }, 2000);
