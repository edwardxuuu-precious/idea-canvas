const sourceHtml = '<!doctype html>\n' + document.documentElement.outerHTML.replace('<meta id="canvas-browser-sync">', '<!-- LOCAL_CANVAS_SYNC -->');
const $ = selector => document.querySelector(selector);
const controls = Object.fromEntries([...document.querySelectorAll('[data-action]')].map(el => [el.dataset.action, el]));
const viewport = $('#viewport');
const world = $('#world');
const cards = $('#cards');
const edgeLayer = $('#edge-layer');
const preview = $('#edge-preview');
const minimap = $('#minimap');
const box = $('#marquee');
const noteDialog = $('#note-dialog');
const textDialog = $('#text-dialog');
const helpDialog = $('#help-dialog');
const lightboxDialog = $('#image-lightbox');
const lightboxImage = $('#lightbox-image');
const contextMenu = $('#context-menu');
const noteTitle = $('#note-title');
const noteBody = $('#note-body');
const noteExtra = $('#note-extra');
const noteSourcesRows = $('#note-sources-rows');
const noteProvenance = $('#note-provenance');
const noteProvenanceSummary = $('#note-provenance-summary');
const sourcePopover = $('#card-source-popover');
const noteImages = $('#note-image-input');
const formatButtons = [...document.querySelectorAll('[data-format]')];
let editorRange = null;
let pickedImage = null;
const textField = $('#text-field');
const searchInput = $('#search-input');
const searchResults = $('#search-results');
const svgNS = 'http://www.w3.org/2000/svg';
const colors = { topic: '#1f4238', idea: '#0f766e', question: '#7c3aed', action: '#b45309', reference: '#2563eb' };
const modKey = /Mac|iP(ad|hone|od)/.test(navigator.platform) ? '⌘' : 'Ctrl+';
const cardIndex = new Map();
const edgeIndex = new Map();
const markerColors = new Set();
const cardSizes = new ResizeObserver(entries => {
  let changed = false;
  const dirtyIds = new Set();
  for (const entry of entries) {
    const id = entry.target.dataset.card;
    const view = id ? cardIndex.get(id) : null;
    if (!view) continue;
    const boxSize = entry.borderBoxSize?.[0];
    const w = boxSize ? Math.round(boxSize.inlineSize) : entry.target.offsetWidth;
    const h = boxSize ? Math.round(boxSize.blockSize) : entry.target.offsetHeight;
    if (!w || !h) continue;
    if (!view.size || view.size.w !== w || view.size.h !== h) {
      view.size = { w, h };
      dirtyIds.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  renderEdges(activeLayoutPositions || gesture?.positions || layoutDraft?.result?.positions, dirtyIds);
  CanvasViews.renderFrames(activeLayoutPositions || gesture?.positions || layoutDraft?.result?.positions, visibility.hidden);
  scheduleMap();
});
const history = new Map();
const touches = new Map();
const noSelection = () => ({ kind: 'cards', ids: new Set() });
const icon = name => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const clamp = (number, low, high) => Math.max(low, Math.min(high, number));
const coordinate = value => clamp(value, -1e9, 1e9);
const titleOf = node => node.title.trim() || '未命名卡片';
const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const chromeTopLimit = () => Math.round(($('.bar')?.getBoundingClientRect().bottom || 56) + 10);

let selection = noSelection();
let camera = { x: 0, y: 0, scale: 1 };
let mode = 'select';
let spaceHeld = false;
let linkSource = null;
let gesture = null;
let lastTouchTap = null;
let suppressClickUntil = 0;
let modalNote = null;
let modalText = null;
let openPopover = null;
let openSelectionSubPopover = null;
let openSourceCardId = null;
let cameraAnim = null;
let positionAnim = null;
let activeLayoutPositions = null;
let panVelocity = { vx: 0, vy: 0, t: 0 };
let panInertiaFrame = 0;
let quietStatusTimer = 0;
let lastDesktopDark = null;
let lastDesktopBg = null;
let tipDismissed = false;
try { tipDismissed = localStorage.getItem('idea-canvas:tip-seen') === '1'; } catch {}
let mapFrame = 0;
let mapGeometry = null;
let mapDrag = null;
let saveTimer = 0;
let toastTimer = 0;
let diskSignature = null;
let writingToDisk = null;
let savedWorkspace = null;
let loadFailure = false;
let lastSyncedContent = '';
let revision = null;
let unresolved = false;
let polling = false;
let connectionIssue = false;
let retryAt = 0;
let conflict = false;
let matches = [];
let activeMatch = 0;
let inlineEdit = null;
let lastPointerLocal = null;
let hoveredCardId = null;
let hoverFocusTimer = 0;
let internalClipboard = null;
let lightboxScale = 1;
let lastKeyUndoAt = 0;
let lastKeyClip = { name: '', at: 0 };

function demoWorkspace() {
  const notes = [
    ['reason', 0, 65, 244, 139, 'idea', '为什么值得写', '发现一个让我少走弯路的做法，想把它讲给遇到同样问题的人。'],
    ['audience', 18, 330, 247, 145, 'question', '读者最容易卡在哪？', '第一次尝试时，哪一步最容易被省略？把它写清楚。'],
    ['subject', 393, 192, 277, 165, 'topic', '写一篇周末短文', '用一个具体例子，讲清一件读完就能照着试的小事。'],
    ['example', 796, 0, 253, 139, 'reference', '找一个真实例子', '翻翻这周的随手记，找一件做法改变后结果也变了的小事。'],
    ['opening', 862, 203, 246, 140, 'idea', '试着写一个开头', '从当时遇到的问题写起。先写发生了什么，再写自己怎么试。'],
    ['next', 798, 419, 251, 142, 'action', '留出 25 分钟', '记下三个可写的例子，选一个列提纲。'],
    ['check', 392, 451, 247, 134, 'question', '怎么判断写清楚了？', '找一位没参与过的人读一遍，请他复述第一步。'],
  ];
  const links = [
    ['subject', 'reason', ''], ['subject', 'audience', ''], ['subject', 'example', ''],
    ['subject', 'opening', ''], ['subject', 'next', '先做什么'], ['subject', 'check', ''],
  ];
  const board = {
    id: 'starter', name: '写一篇周末短文',
    nodes: notes.map(([id, x, y, w, h, tone, title, body]) => ({ id, x, y, w, h, tone, title, body })),
    edges: links.map(([from, to, label], index) => ({ id: 'demo-' + index, from, to, label, kind: 'branch' })),
    view: null,
  };
  board.settings = CanvasData.newSettings();
  return { version: 3, activeId: board.id, boards: [board], themes: [] };
}

const embedded = JSON.parse($('#canvas-data').textContent);
const desktopState = window.ideaCanvasDesktop;
const desktop = desktopState ? window.webkit?.messageHandlers?.ideaCanvas : null;
if (desktop) document.documentElement.dataset.desktop = 'macos';
const browserSync = location.protocol === 'http:' && !!$('#canvas-browser-sync');
const syncing = !!desktop || browserSync;
const persistence = syncing ? null : CanvasData.storage(embedded.edition);
const draftKey = 'idea-canvas:uncommitted:v1';
if (browserSync) {
  window.addEventListener('hashchange', () => {
    if (!new URLSearchParams(location.hash.slice(1)).has('pair')) return;
    if ($('#sync-gate').hidden) window.history.replaceState(null, '', location.pathname);
    else location.reload();
  });
}
let workspace = embedded.workspace ? CanvasData.parse(JSON.stringify(embedded.workspace)) : demoWorkspace();

async function browserRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(6000), ...options,
    });
  } catch {
    throw new Error('暂时连不到桌面版。双击桌面入口打开画布后会继续同步。');
  }
  if (response.status === 204) return null;
  if (response.status === 401) throw new Error('请在桌面版选「文件 → 复制浏览器同步链接」，粘贴到当前浏览器。');
  const result = await response.json();
  if (response.status === 409) return { conflict: result };
  if (!response.ok) throw new Error(result.message || '本机同步暂时不可用。');
  return result;
}

const jsonRequest = (method, value) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});

async function browserOpen() {
  $('#sync-gate').hidden = false;
  $('header.bar').inert = true;
  $('main.stage').inert = true;
  const code = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (code) {
    window.history.replaceState(null, '', location.pathname);
    try {
      await browserRequest('/pair', jsonRequest('POST', { code }));
    } catch {
      // A previously paired browser can continue with its existing session.
    }
  }
  const initial = await browserRequest('/api/state');
  $('#sync-gate').hidden = true;
  $('header.bar').inert = false;
  $('main.stage').inert = false;
  return initial;
}

const contentOf = state => JSON.stringify({
  boards: state.boards.map(({ view, ...content }) => content), themes: state.themes,
});
const dirty = () => contentOf(workspace) !== lastSyncedContent;
try {
  if (desktopState?.warning) throw new Error(desktopState.warning);
  const initial = browserSync ? await browserOpen() : desktopState;
  if (syncing) revision = initial.revision;
  const saved = syncing ? initial.json : persistence.read();
  if (saved) {
    workspace = CanvasData.parse(saved);
    diskSignature = saved;
    savedWorkspace = JSON.stringify(workspace);
  }
  if (syncing && saved) lastSyncedContent = contentOf(workspace);
  else if (browserSync) lastSyncedContent = contentOf(workspace);
  if (browserSync) {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey));
      if (draft) {
        workspace = CanvasData.parse(draft.json);
        if (dirty() && (draft.unresolved === true || draft.revision !== revision)) unresolved = true;
      }
    } catch {
      // The disk snapshot is still usable if a browser draft is unavailable.
    }
  }
} catch (error) {
  loadFailure = true;
  if (browserSync) {
    $('#sync-gate-text').textContent = error.message || '暂时无法连接桌面版。';
    const retry = $('#sync-reload');
    retry.hidden = false;
    retry.onclick = () => location.reload();
    return;
  }
}

const board = () => workspace.boards.find(item => item.id === workspace.activeId);
const nodeBy = id => board().nodes.find(node => node.id === id);
const edgeBy = id => board().edges.find(edge => edge.id === id);
const noteIds = () => selection.kind === 'cards' ? [...selection.ids] : [];
const chosenCard = () => selection.kind === 'cards' && selection.ids.size === 1
  ? nodeBy(selection.ids.values().next().value) : null;
const chosenEdge = () => selection.kind === 'edge' ? edgeBy(selection.id) : null;
const modalOpen = () => noteDialog.open || textDialog.open || helpDialog.open || lightboxDialog.open;

function scheduleQuietStatus() {
  clearTimeout(quietStatusTimer);
  const el = $('#storage-status');
  if (!el) return;
  delete el.dataset.quiet;
  if (el.dataset.state === 'ok') {
    quietStatusTimer = setTimeout(() => {
      if (el.dataset.state === 'ok') el.dataset.quiet = 'true';
    }, 1800);
  }
}

function dismissIdleTip() {
  if (tipDismissed) return;
  tipDismissed = true;
  const tip = $('#idle-tip');
  if (tip) tip.hidden = true;
  try { localStorage.setItem('idea-canvas:tip-seen', '1'); } catch {}
}

function storageState(label, error = false, message = '内容保存在当前浏览器。换浏览器或移动文件前可导出可编辑 HTML。') {
  $('#storage-label').textContent = label;
  $('#storage-status').dataset.state = error ? 'error' : 'ok';
  $('#storage-status').setAttribute('aria-label', label);
  $('#storage-status').title = message;
  scheduleQuietStatus();
}

function toast(message, kind = '') {
  clearTimeout(toastTimer);
  const element = $('#toast');
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 3400);
}

function markConflict() {
  if (!conflict) toast('另一窗口已有新版。导出此窗口的 HTML 可保留当前内容。', 'error');
  conflict = true;
  storageState('此窗口未保存', true, '另一窗口有更新。可导出此窗口的 HTML，或重新打开原文件。');
}

function desktopStateLabel(label, state = 'ok', tip = '内容写入本机画布数据。可在「文件」菜单中打开数据文件夹和历史备份。') {
  storageState(label, state === 'error', tip);
  $('#storage-status').dataset.state = state;
  scheduleQuietStatus();
}

function rememberDraft() {
  if (!browserSync) return;
  try {
    if (dirty()) sessionStorage.setItem(draftKey, JSON.stringify({ revision, unresolved, json: JSON.stringify(workspace) }));
    else sessionStorage.removeItem(draftKey);
  } catch {
    // A dirty tab still has the exit prompt and its file export.
  }
}

function syncAlert(message = '', canKeepCopy = false) {
  $('#sync-alert').hidden = !message;
  $('#sync-alert-text').textContent = message;
  controls['sync-copy'].hidden = !canKeepCopy;
}

function statusSaved() {
  connectionIssue = false;
  desktopStateLabel('已保存到本机');
  syncAlert();
}

function handleSyncConflict() {
  unresolved = true;
  desktopStateLabel('有未同步的草稿', 'error');
  syncAlert('另一处也有更新。本次编辑保留在草稿中。', true);
  rememberDraft();
}

function handleSyncFailure(error) {
  connectionIssue = true;
  retryAt = Date.now() + 3000;
  desktopStateLabel(dirty() ? '草稿待同步' : '本机连接中断', 'error');
  syncAlert(error.message || '本机保存遇到问题。可用「文件」导出当前内容。');
  rememberDraft();
}

function saveToDisk() {
  if (writingToDisk) return writingToDisk;
  if (loadFailure) return Promise.resolve(false);
  if (!dirty()) {
    unresolved = false;
    rememberDraft();
    if (!connectionIssue) statusSaved();
    return Promise.resolve(true);
  }
  if (unresolved) return Promise.resolve(false);
  const json = JSON.stringify(workspace);
  const stamp = contentOf(workspace);
  const request = { operation: 'save', expectedRevision: revision, json };
  desktopStateLabel('正在保存到本机', 'pending');
  let succeeded = false;
  writingToDisk = Promise.resolve()
    .then(() => desktop
      ? desktop.postMessage(request)
      : browserRequest('/api/state', jsonRequest('PUT', request)))
    .then(result => {
      if (result.conflict) {
        handleSyncConflict();
        return false;
      }
      revision = result.revision;
      lastSyncedContent = stamp;
      succeeded = true;
      rememberDraft();
      if (!dirty()) statusSaved();
      return true;
    })
    .catch(error => {
      handleSyncFailure(error);
      return false;
    })
    .finally(() => {
      writingToDisk = null;
      if (succeeded && dirty()) queueSave();
    });
  return writingToDisk;
}

function readShared(since) {
  return desktop
    ? desktop.postMessage({ operation: 'sync-state', since })
    : browserRequest('/api/state' + (since ? '?since=' + encodeURIComponent(since) : ''));
}

const nodeSignature = node => JSON.stringify([
  node.x, node.y, node.w, node.h, node.tone, node.title, node.body, node.richBody || '', node.note || '',
  node.sources || [], node.status || '', node.priority || '', node.tags || [], !!node.pinned,
  node.style || null, node.branchStyle || null, node.subBoardId || '',
]);

function flashRemoteCards(ids) {
  for (const id of ids.slice(0, 40)) {
    const element = cardIndex.get(id)?.element;
    if (!element || element.hidden) continue;
    element.classList.remove('is-remote-updated');
    void element.offsetWidth;
    element.classList.add('is-remote-updated');
    setTimeout(() => element.classList.remove('is-remote-updated'), 1900);
  }
}

function adoptShared(snapshot) {
  const received = snapshot.json ? CanvasData.parse(snapshot.json) : demoWorkspace();
  const activeId = workspace.activeId;
  const previous = new Map(workspace.boards.map(item => [item.id, item]));
  const contentKey = ({ view, ...content }) => JSON.stringify(content);
  let changedAny = false;
  for (const item of received.boards) {
    const old = previous.get(item.id);
    if (old) item.view = old.view;
    if (!old || contentKey(old) !== contentKey(item)) {
      history.delete(item.id);
      changedAny = true;
    }
  }
  for (const id of previous.keys()) {
    if (!received.boards.some(item => item.id === id)) {
      history.delete(id);
      changedAny = true;
    }
  }
  if (changedAny) {
    for (const stack of history.values()) {
      stack.past = stack.past.filter(entry => !entry.workspaceBoards);
      stack.future = stack.future.filter(entry => !entry.workspaceBoards);
    }
  }
  const sameBoard = received.boards.some(item => item.id === activeId);
  const before = sameBoard ? capturePositions() : null;
  const signatures = sameBoard ? new Map(board().nodes.map(node => [node.id, nodeSignature(node)])) : null;
  if (sameBoard) received.activeId = activeId;
  workspace = received;
  revision = snapshot.revision;
  lastSyncedContent = contentOf(received);
  if (!sameBoard) {
    cancelPositionAnimation();
    CanvasViews.reset();
    selection = noSelection();
    setMode('select');
    render();
    showBoardView();
    return;
  }
  if (selection.kind === 'cards') selection = { kind: 'cards', ids: new Set([...selection.ids].filter(id => nodeBy(id))) };
  else if (!edgeBy(selection.id)) selection = noSelection();
  if (linkSource && !nodeBy(linkSource)) linkSource = null;
  render();
  animatePositions(before);
  flashRemoteCards(board().nodes.filter(node => signatures.get(node.id) !== nodeSignature(node)).map(node => node.id));
}

async function pullShared() {
  if (polling || loadFailure || unresolved || gesture || layoutDraft || inlineEdit || document.querySelector('.canvas-frame-input') || Date.now() < retryAt) return;
  if (writingToDisk) return;
  if (dirty()) {
    if (!saveTimer) await saveToDisk();
    return;
  }
  if (modalOpen()) return;
  polling = true;
  try {
    const since = revision;
    const current = await readShared(since);
    if (writingToDisk || dirty() || modalOpen() || gesture || layoutDraft || inlineEdit || document.querySelector('.canvas-frame-input') || unresolved || revision !== since) return;
    if (current && current.revision !== since) adoptShared(current);
    statusSaved();
  } catch (error) {
    handleSyncFailure(error);
  } finally {
    polling = false;
  }
}

async function saveConflictCopy() {
  if (!unresolved || polling) return;
  polling = true;
  controls['sync-copy'].disabled = true;
  try {
    const current = await readShared(null);
    const last = lastSyncedContent ? JSON.parse(lastSyncedContent) : { boards: [], themes: [] };
    const prior = new Map(last.boards.map(item => [item.id, JSON.stringify(item)]));
    const pending = JSON.parse(contentOf(workspace));
    const local = pending.boards.filter(item => JSON.stringify(item) !== prior.get(item.id));
    adoptShared(current);
    if (JSON.stringify(last.themes) !== JSON.stringify(pending.themes)) mergeThemes(pending.themes);
    unresolved = false;
    const names = new Set(workspace.boards.map(item => item.name));
    const localIdMap = new Map(local.map(item => [item.id, CanvasData.uid()]));
    for (const item of local) {
      const base = item.name + '（同步草稿）';
      let name = base;
      for (let number = 2; names.has(name); number++) name = base + ' ' + number;
      names.add(name);
      const copy = structuredClone(item);
      copy.id = localIdMap.get(item.id);
      copy.name = name;
      copy.view = null;
      if (copy.settings) {
        copy.settings.parentId = copy.settings.parentId && localIdMap.has(copy.settings.parentId)
          ? localIdMap.get(copy.settings.parentId) : null;
      }
      for (const node of copy.nodes || []) {
        if (node.subBoardId) {
          if (localIdMap.has(node.subBoardId) && localIdMap.get(node.subBoardId) !== copy.id) {
            node.subBoardId = localIdMap.get(node.subBoardId);
          } else {
            delete node.subBoardId;
          }
        }
      }
      workspace.boards.push(copy);
      workspace.activeId = copy.id;
    }
    render();
    showBoardView();
    await save();
  } catch (error) {
    handleSyncFailure(error);
    if (unresolved) handleSyncConflict();
  } finally {
    controls['sync-copy'].disabled = false;
    polling = false;
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (syncing) return saveToDisk();
  if (loadFailure || conflict) return;
  const desired = JSON.stringify(workspace);
  if (desired === savedWorkspace) return;
  try {
    const current = persistence.read();
    if (current !== diskSignature && current !== desired) {
      markConflict();
      return;
    }
    persistence.write(desired);
    diskSignature = desired;
    savedWorkspace = desired;
    storageState('已保存到浏览器');
  } catch {
    storageState('自动保存失败', true, '请从文件菜单导出可编辑 HTML 保存当前内容。');
    toast('浏览器暂时无法保存。可通过「文件」导出当前 HTML。', 'error');
  }
}

function queueSave() {
  if (loadFailure || conflict) return;
  if (syncing) {
    rememberDraft();
    if (!dirty() && !unresolved) return;
    if (unresolved && dirty()) return;
    desktopStateLabel('正在保存到本机', 'pending');
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 160);
}

function changeView() {
  paintView();
  if (layoutDraft || CanvasViews.isFocused()) return;
  board().view = { ...camera };
  if (!syncing) queueSave();
}

function selectedBoardHistory() {
  const id = workspace.activeId;
  if (!history.has(id)) history.set(id, { past: [], future: [] });
  return history.get(id);
}

function snapshot(withView = false, withThemes = false, withWorkspace = false) {
  if (withWorkspace) {
    return structuredClone({
      workspaceBoards: workspace.boards,
      workspaceActiveId: workspace.activeId,
      themes: workspace.themes,
    });
  }
  const { name, nodes, edges, settings } = board();
  return structuredClone({ name, nodes, edges, settings, ...(withView ? { view: camera } : {}),
    ...(withThemes ? { themes: workspace.themes } : {}) });
}

function checkpoint(withView = false, withThemes = false, withWorkspace = false) {
  const { past, future } = selectedBoardHistory();
  past.push(snapshot(withView, withThemes, withWorkspace));
  if (past.length > 60) past.shift();
  future.length = 0;
}

function undoRedo(which) {
  if (inlineEdit) finishInline();
  if (gesture) cancelGesture();
  if (layoutDraft) cancelLayout();
  const { past, future } = selectedBoardHistory();
  const [from, to] = which === 'undo' ? [past, future] : [future, past];
  if (!from.length) return;
  const entry = from.pop();
  if (entry.workspaceBoards) {
    to.push(snapshot(false, false, true));
    workspace.boards = entry.workspaceBoards;
    workspace.activeId = entry.workspaceActiveId;
    if (entry.themes) workspace.themes = entry.themes;
    CanvasViews.reset();
    selection = noSelection();
    linkSource = null;
    render();
    showBoardView();
    save();
    focusCanvas();
    return;
  }
  const before = capturePositions();
  const { themes, ...previous } = entry;
  to.push(snapshot(!!previous.view, !!themes));
  if (themes) workspace.themes = themes;
  Object.assign(board(), previous);
  selection = noSelection();
  linkSource = null;
  render();
  animatePositions(before);
  if (previous.view) {
    animateCamera(previous.view, { duration: 240 });
  }
  save();
  focusCanvas();
}

function applyChange(update, options = {}) {
  if (layoutDraft) cancelLayout();
  checkpoint(!!options.view, !!options.themes);
  update();
  render();
  save();
}

function focusCanvas() {
  viewport.focus({ preventScroll: true });
}

function viewportSize() {
  return { width: Math.max(1, viewport.clientWidth), height: Math.max(1, viewport.clientHeight) };
}

function point(event) {
  const rect = viewport.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function worldPoint(local) {
  const { width, height } = viewportSize();
  return {
    x: camera.x + (local.x - width / 2) / camera.scale,
    y: camera.y + (local.y - height / 2) / camera.scale,
  };
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function cancelCameraAnimation() {
  if (cameraAnim?.frame) cancelAnimationFrame(cameraAnim.frame);
  cameraAnim = null;
  if (panInertiaFrame) cancelAnimationFrame(panInertiaFrame);
  panInertiaFrame = 0;
}

function setCamera(x, y, scale = camera.scale) {
  camera = { x: coordinate(x), y: coordinate(y), scale: clamp(scale, .08, 3) };
  changeView();
}

function animateCamera(target, { duration = 250, temporary = false } = {}) {
  cancelCameraAnimation();
  const end = {
    x: coordinate(target.x),
    y: coordinate(target.y),
    scale: clamp(target.scale ?? camera.scale, .08, 3),
  };
  const smallChange = Math.hypot(end.x - camera.x, end.y - camera.y) < 0.5 && Math.abs(end.scale - camera.scale) < 0.002;
  if (prefersReducedMotion() || duration <= 0 || smallChange) {
    if (temporary) {
      camera = end;
      paintView();
    } else {
      setCamera(end.x, end.y, end.scale);
    }
    return;
  }
  if (!temporary && !layoutDraft && !CanvasViews.isFocused()) {
    board().view = { ...end };
    if (!syncing) queueSave();
  }
  const start = { ...camera };
  const t0 = performance.now();
  const step = now => {
    const p = clamp((now - t0) / duration, 0, 1);
    const ease = 1 - Math.pow(1 - p, 3.6);
    camera = {
      x: start.x + (end.x - start.x) * ease,
      y: start.y + (end.y - start.y) * ease,
      scale: start.scale + (end.scale - start.scale) * ease,
    };
    paintView();
    if (p < 1) {
      cameraAnim.frame = requestAnimationFrame(step);
    } else {
      cameraAnim = null;
      camera = end;
      paintView();
    }
  };
  cameraAnim = { frame: requestAnimationFrame(step) };
}

function zoomTo(scale, local = null, anchor = null, { animate = false } = {}) {
  const { width, height } = viewportSize();
  const center = local || { x: width / 2, y: height / 2 };
  const target = anchor || worldPoint(center);
  const next = clamp(scale, .08, 3);
  const destX = target.x - (center.x - width / 2) / next;
  const destY = target.y - (center.y - height / 2) / next;
  if (animate) animateCamera({ x: destX, y: destY, scale: next }, { duration: 180 });
  else {
    cancelCameraAnimation();
    setCamera(destX, destY, next);
  }
}

function cardProfile(node) {
  if (node.richBody?.includes('<img ')) return 'image';
  if (node.body.trim()) return 'note';
  return node.title.trim() ? 'title' : 'empty';
}

function cardRect(node) {
  const view = cardIndex.get(node.id);
  if (!view) return node;
  if (!view.size && view.element.offsetWidth) {
    view.size = { w: view.element.offsetWidth, h: view.element.offsetHeight };
  }
  return view.size ? { ...node, ...view.size } : node;
}

function compactCardSize(node, profile) {
  if (profile === 'empty') return { w: 124, h: 38 };
  const topic = node.tone === 'topic';
  const wide = topic ? 24 : 20;
  const narrow = topic ? 13 : 11;
  const textWidth = [...node.title.trim()].reduce((width, char) => width + (char.codePointAt(0) > 255 ? wide : narrow), 0);
  const width = textWidth + 56;
  return { w: clamp(width, topic ? 136 : 106, 254), h: (topic ? 52 : 42) + (width > 254 ? 18 : 0) };
}

function boundsOf(nodes) {
  if (!nodes.length) return null;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const node of nodes) {
    const { x, y, w, h } = cardRect(node);
    left = Math.min(left, x);
    right = Math.max(right, x + w);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y + h);
  }
  return { left, right, top, bottom, w: right - left, h: bottom - top };
}

function fitView(options = {}) {
  fitNodes(null, !!layoutDraft || CanvasViews.isFocused(), null, options);
}

function fitNodes(ids, temporary = false, anchorId = null, { instant = false } = {}) {
  const wanted = ids && new Set(ids);
  const nodes = effectiveNodes().filter(node => (!wanted || wanted.has(node.id)) && !visibility.hidden.has(node.id));
  const bounds = boundsOf(nodes);
  if (!bounds) {
    if (!temporary) {
      if (instant) setCamera(0, 0, 1);
      else animateCamera({ x: 0, y: 0, scale: 1 }, { duration: 240 });
    }
    return;
  }
  const { options, guides } = displayedLayout();
  const includeMatrix = options.mode === 'matrix' && guides.length > 0 &&
    (!wanted || wanted.size === board().nodes.length || !!layoutDraft?.result);
  if (includeMatrix) {
    for (const guide of guides) {
      bounds.left = Math.min(bounds.left, guide.x, guide.x2 ?? guide.x);
      bounds.top = Math.min(bounds.top, guide.y, guide.y2 ?? guide.y);
      bounds.right = Math.max(bounds.right, guide.x, guide.x2 ?? guide.x);
      bounds.bottom = Math.max(bounds.bottom, guide.y, guide.y2 ?? guide.y);
    }
    bounds.w = bounds.right - bounds.left;
    bounds.h = bounds.bottom - bounds.top;
  }
  const { width, height } = viewportSize();
  const drawerWidth = layoutDraft && width > 760 ? $('#layout-panel').offsetWidth + 32 : 0;
  const usefulWidth = width - drawerWidth;
  const marginX = width < 710 ? 76 : Math.min(usefulWidth * .2, 240);
  const marginY = height < 490 ? 104 : Math.min(height * .16, 150);
  const key = $('#matrix-key');
  const topInset = includeMatrix ? key.offsetTop + key.offsetHeight + 18 : 0;
  const bottomInset = includeMatrix ? 58 : 0;
  const usableHeight = height - (includeMatrix ? topInset + bottomInset : marginY);
  let scale = clamp(Math.min((usefulWidth - marginX) / bounds.w, usableHeight / bounds.h), .08, 1.15);
  if (anchorId && scale < .8) {
    const anchor = nodes.find(node => node.id === anchorId) || nodes[0];
    const childIds = new Set(hierarchy.children.get(anchor.id));
    const group = [anchor, ...nodes.filter(node => childIds.has(node.id))].map(cardRect);
    const area = boundsOf(group);
    const anchorBounds = boundsOf([anchor]);
    const roomWidth = (usefulWidth - 54) / .8;
    const roomHeight = (usableHeight - 28) / .8;
    // Keep the anchor in frame and use the remaining room for its nearest cards.
    const center = (start, end, room) => {
      const middle = (area[start] + area[end]) / 2;
      const half = room / 2;
      const low = anchorBounds[end] - half;
      const high = anchorBounds[start] + half;
      return low <= high ? clamp(middle, low, high) : (low + high) / 2;
    };
    const horizontal = center('left', 'right', roomWidth);
    const vertical = center('top', 'bottom', roomHeight);
    bounds.left = bounds.right = horizontal;
    bounds.top = bounds.bottom = vertical;
    scale = .8;
  }
  const x = coordinate((bounds.left + bounds.right) / 2 + drawerWidth / (2 * scale));
  const verticalOffset = includeMatrix ? (bottomInset - topInset) / 2 : 12;
  const y = coordinate((bounds.top + bounds.bottom) / 2 + verticalOffset / scale);
  if (instant) {
    cancelCameraAnimation();
    if (temporary) {
      camera = { x, y, scale };
      paintView();
    } else setCamera(x, y, scale);
  } else {
    animateCamera({ x, y, scale }, { duration: 260, temporary });
  }
}

