function showBoardView() {
  cancelCameraAnimation();
  const current = board();
  if (current.view) {
    camera = { ...current.view };
    paintView();
  } else if (current.id === 'starter' && viewport.clientWidth < 710 && nodeBy('subject')) {
    const subject = cardRect(nodeBy('subject'));
    setCamera(subject.x + subject.w / 2, subject.y + subject.h / 2, .88);
  } else {
    fitView({ instant: true });
  }
}

function paintView() {
  const { width, height } = viewportSize();
  const left = width / 2 - camera.x * camera.scale;
  const top = height / 2 - camera.y * camera.scale;
  world.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0) scale(' + camera.scale + ')';
  viewport.style.setProperty('--canvas-scale', camera.scale);
  const spacing = board().settings.appearance.gridSize * camera.scale * (camera.scale < .5 ? 2 : 1) * (camera.scale < .22 ? 2 : 1);
  viewport.style.backgroundSize = spacing + 'px ' + spacing + 'px';
  viewport.style.backgroundPosition = (left % spacing) + 'px ' + (top % spacing) + 'px';
  viewport.classList.toggle('is-overview', camera.scale < .6);
  viewport.classList.toggle('is-zoomed-out', camera.scale < .48);
  $('#zoom-value').textContent = Math.round(camera.scale * 100) + '%';
  positionSelectionBar();
  positionSourcePopover();
  scheduleMap();
}

function reveal(node, center = false) {
  const rect = cardRect(node);
  const { width, height } = viewportSize();
  const zoom = Math.max(camera.scale, .7);
  const { x, y, w, h } = rect;
  const dx = (x + w / 2 - camera.x) * camera.scale;
  const dy = (y + h / 2 - camera.y) * camera.scale;
  if (center || Math.abs(dx) + w * camera.scale / 2 > width / 2 - 45 ||
      Math.abs(dy) + h * camera.scale / 2 > height / 2 - 68) {
    animateCamera({ x: x + w / 2, y: y + h / 2, scale: zoom }, { duration: 240 });
  }
}

function isInView(node) {
  const { x, y, w, h } = cardRect(node);
  const size = viewportSize();
  const halfWidth = size.width / (2 * camera.scale);
  const halfHeight = size.height / (2 * camera.scale);
  return x < camera.x + halfWidth && x + w > camera.x - halfWidth &&
    y < camera.y + halfHeight && y + h > camera.y - halfHeight;
}

function svg(name, attributes) {
  const element = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function connectionSide(from, to, forceHorizontal = false) {
  const dx = to.x + to.w / 2 - from.x - from.w / 2;
  const dy = to.y + to.h / 2 - from.y - from.h / 2;
  const horizontal = forceHorizontal || Math.abs(dx) - (from.w + to.w) / 2 > 38 || Math.abs(dx) >= Math.abs(dy) * .94;
  if (horizontal) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

const sideVectors = {
  right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, down: { x: 0, y: 1 }, bottom: { x: 0, y: 1 }, up: { x: 0, y: -1 }, top: { x: 0, y: -1 },
};

function unitVector(x, y, fallback) {
  const length = Math.hypot(x, y);
  return length > 0.001 ? { x: x / length, y: y / length } : fallback;
}

function linkCurve(from, to, forceRight = false, shape = "curve", side = connectionSide(from, to, forceRight), startSide = null) {
  const aMid = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const bMid = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const horizontal = side === 'left' || side === 'right';
  const sign = side === 'left' || side === 'up' ? -1 : 1;
  const direction = horizontal ? { x: sign, y: 0 } : { x: 0, y: sign };
  const backward = { x: -direction.x, y: -direction.y };
  const aDir = startSide && sideVectors[startSide] ? sideVectors[startSide] : (forceRight ? { x: 1, y: 0 } : direction);
  const a = { x: aMid.x + aDir.x * (from.w / 2 + 2), y: aMid.y + aDir.y * (from.h / 2 + 2) };
  const b = {
    x: bMid.x - direction.x * (to.w / 2 + (to.w ? 3 : 0)),
    y: bMid.y - direction.y * (to.h / 2 + (to.h ? 3 : 0)),
  };
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const ends = (startDir, endDir) => ({
    start: { x: a.x, y: a.y, dx: startDir.x, dy: startDir.y },
    end: { x: b.x, y: b.y, dx: endDir.x, dy: endDir.y },
  });
  const straight = () => ({
    path: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, label: middle,
    ...ends(unitVector(a.x - b.x, a.y - b.y, backward), unitVector(b.x - a.x, b.y - a.y, direction)),
  });
  if (shape === 'straight') return straight();
  if (shape === 'elbow') {
    const r = Math.min(12, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2);
    if (r < 1) return straight();
    const sx = b.x >= a.x ? 1 : -1;
    const sy = b.y >= a.y ? 1 : -1;
    const path = horizontal
      ? `M ${a.x} ${a.y} H ${middle.x - sx * r} Q ${middle.x} ${a.y} ${middle.x} ${a.y + sy * r} V ${b.y - sy * r} Q ${middle.x} ${b.y} ${middle.x + sx * r} ${b.y} H ${b.x}`
      : `M ${a.x} ${a.y} V ${middle.y - sy * r} Q ${a.x} ${middle.y} ${a.x + sx * r} ${middle.y} H ${b.x - sx * r} Q ${b.x} ${middle.y} ${b.x} ${middle.y + sy * r} V ${b.y}`;
    return horizontal
      ? { path, label: middle, ...ends({ x: -sx, y: 0 }, { x: sx, y: 0 }) }
      : { path, label: middle, ...ends({ x: 0, y: -sy }, { x: 0, y: sy }) };
  }
  const forward = (b.x - a.x) * direction.x + (b.y - a.y) * direction.y;
  const bend = forward > 0 && (!forceRight || sign > 0) && (!startSide || aDir.x === direction.x && aDir.y === direction.y)
    ? Math.min(forward * .56, 280)
    : clamp(Math.hypot(b.x - a.x, b.y - a.y) * .39, 28, 220);
  const c = { x: a.x + aDir.x * bend, y: a.y + aDir.y * bend };
  const d = { x: b.x - direction.x * bend, y: b.y - direction.y * bend };
  return {
    path: 'M ' + a.x + ' ' + a.y + ' C ' + c.x + ' ' + c.y + ' ' + d.x + ' ' + d.y + ' ' + b.x + ' ' + b.y,
    label: { x: (a.x + 3 * c.x + 3 * d.x + b.x) / 8, y: (a.y + 3 * c.y + 3 * d.y + b.y) / 8 },
    ...ends(unitVector(a.x - c.x, a.y - c.y, backward), unitVector(b.x - d.x, b.y - d.y, direction)),
  };
}

let nodeDepths = new Map();

function mixHex(hexA, hexB, ratio) {
  if (!/^#[0-9a-f]{6}$/i.test(hexA || '') || !/^#[0-9a-f]{6}$/i.test(hexB || '')) return hexA || hexB;
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const mix = shift => Math.round(((a >> shift) & 255) * (1 - ratio) + ((b >> shift) & 255) * ratio);
  return '#' + [16, 8, 0].map(shift => clamp(mix(shift), 0, 255).toString(16).padStart(2, '0')).join('');
}

function isDarkHex(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return false;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 0.35;
}

function paintAppearance() {
  const current = board();
  const appearance = current.settings.appearance;
  const dark = isDarkHex(appearance.background);
  document.documentElement.dataset.chrome = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (colorSchemeMeta) colorSchemeMeta.setAttribute('content', dark ? 'dark' : 'light');
  const themeBtn = $('#theme-toggle');
  if (themeBtn) {
    themeBtn.setAttribute('aria-pressed', String(dark));
    themeBtn.title = dark ? '切换为晨雾纸白浅色外观' : '切换为静谧夜色深色外观';
    themeBtn.querySelector('use')?.setAttribute('href', dark ? '#i-sun' : '#i-theme');
  }
  viewport.dataset.grid = appearance.grid;
  viewport.style.setProperty('--grid-dots', appearance.gridColor + (dark ? '60' : '78'));
  viewport.style.setProperty('--grid-ink', appearance.gridColor + (dark ? '44' : '58'));
  const accentHex = /^#[0-9a-f]{6}$/i.test(appearance.accent || '') ? appearance.accent : (dark ? '#10b981' : '#0f766e');
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--board-accent', appearance.accent);
  rootStyle.setProperty('--guide-ink', appearance.accent);
  rootStyle.setProperty('--canvas', appearance.background);
  rootStyle.setProperty('--topic-bg-start', mixHex(accentHex, '#081116', 0.68));
  rootStyle.setProperty('--topic-bg-end', mixHex(accentHex, '#0b171d', 0.54));
  rootStyle.setProperty('--topic-line', mixHex(accentHex, '#081116', 0.62));
  rootStyle.setProperty('--topic-sub', mixHex(accentHex, '#ffffff', 0.80));
  rootStyle.setProperty('--topic-accent', mixHex(accentHex, '#ffffff', 0.52));
  rootStyle.setProperty('--topic-map', mixHex(accentHex, '#0b171d', 0.56));

  inheritedBranches = new Map();
  nodeDepths = new Map();
  const nodes = new Map(current.nodes.map(node => [node.id, node]));
  const queue = hierarchy.roots.map(id => [id, 0]);
  for (const id of hierarchy.roots) nodeDepths.set(id, 0);
  while (queue.length) {
    const [id, depth] = queue.shift();
    const parentId = hierarchy.parent.get(id);
    inheritedBranches.set(id, {
      ...(parentId ? inheritedBranches.get(parentId) : null),
      ...nodes.get(id)?.branchStyle,
    });
    for (const child of hierarchy.children.get(id) || []) {
      if (!nodeDepths.has(child)) {
        nodeDepths.set(child, depth + 1);
        queue.push([child, depth + 1]);
      }
    }
  }
  if (desktop && (dark !== lastDesktopDark || appearance.background !== lastDesktopBg)) {
    lastDesktopDark = dark;
    lastDesktopBg = appearance.background;
    desktop.postMessage({ operation: 'window-chrome', dark, background: appearance.background }).catch(() => {});
  }
}

const lineDashes = { dashed: '7 5', dotted: '1 5' };

function edgeStyle(edge) {
  const { appearance } = board().settings;
  const branch = edge.kind === 'branch';
  const inherited = hierarchy.parent.get(edge.to) === edge.from
    ? inheritedBranches.get(edge.to)
    : { ...inheritedBranches.get(edge.from), ...nodeBy(edge.to)?.branchStyle };
  const dark = isDarkHex(appearance.background);
  const depth = nodeDepths.get(edge.from) ?? 1;
  const defaultWidth = branch ? (depth === 0 ? 2.2 : depth === 1 ? 1.65 : 1.25) : 1.5;
  return {
    color: branch ? (dark ? '#475569' : '#64748b') : (dark ? '#64748b' : '#94a3b8'),
    width: defaultWidth, shape: 'curve', dash: 'solid', arrow: branch ? 'none' : 'end',
    ...(branch ? appearance.branch : appearance.link),
    ...(branch ? inherited : {}),
    ...edge.style,
  };
}

function ensureEdgeMarker(color) {
  const id = 'edge-arrow-' + color.slice(1).toLowerCase();
  if (!markerColors.has(id)) {
    markerColors.add(id);
    const marker = svg('marker', {
      id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    });
    marker.append(svg('path', {
      d: 'M2 1.8L8.2 5L2 8.2', fill: 'none', stroke: color,
      'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
    $('#edge-markers').append(marker);
  }
  return 'url(#' + id + ')';
}

function renderEdges(positions = activeLayoutPositions || gesture?.positions || layoutDraft?.result?.positions, dirtyNodeIds = null) {
  const nodes = new Map(effectiveNodes(positions).filter(node => !visibility.hidden.has(node.id)).map(node => [node.id, cardRect(node)]));
  const downward = displayedLayout().options.mode === 'down';
  const currentEdges = board().edges;
  const visibleEdgeIds = new Set();
  for (const edge of currentEdges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) visibleEdgeIds.add(edge.id);
  }
  for (const [id, view] of edgeIndex) {
    if (!visibleEdgeIds.has(id)) {
      view.element.remove();
      edgeIndex.delete(id);
    }
  }

  for (const edge of currentEdges) {
    if (!visibleEdgeIds.has(edge.id)) continue;
    let view = edgeIndex.get(edge.id);
    const dimmed = visibility.dimmed.has(edge.from) || visibility.dimmed.has(edge.to);
    const active = selection.kind === 'edge' && selection.id === edge.id;
    if (view && dirtyNodeIds && !dirtyNodeIds.has(edge.from) && !dirtyNodeIds.has(edge.to)) {
      view.element.classList.toggle('is-dimmed', dimmed);
      view.path.classList.toggle('selected', active);
      continue;
    }

    const style = edgeStyle(edge);
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    const side = downward && hierarchy.parent.get(edge.to) === edge.from && to.y >= from.y + from.h ? 'down' : undefined;
    const curve = linkCurve(from, to, false, style.shape, side);

    if (!view) {
      const element = svg('g', { 'data-edge': edge.id, role: 'group' });
      const path = svg('path', { class: 'edge ' + edge.kind });
      const hit = svg('path', { class: 'edge-hit', 'aria-hidden': 'true' });
      element.append(path, hit);
      edgeLayer.append(element);
      view = { element, path, hit, labelBg: null, labelText: null };
      edgeIndex.set(edge.id, view);
    }

    view.element.setAttribute('aria-label', edge.label || '卡片连线');
    view.element.classList.toggle('is-dimmed', dimmed);
    view.path.className.baseVal = 'edge ' + edge.kind + (active ? ' selected' : '');
    view.path.setAttribute('d', curve.path);
    view.hit.setAttribute('d', curve.path);
    view.path.style.setProperty('--edge-color', style.color);
    view.path.style.setProperty('--edge-width', style.width + 'px');

    if (style.arrow === 'end' || style.arrow === 'both') view.path.style.setProperty('--edge-end', ensureEdgeMarker(style.color));
    else view.path.style.removeProperty('--edge-end');
    if (style.arrow === 'start' || style.arrow === 'both') view.path.style.setProperty('--edge-start', ensureEdgeMarker(style.color));
    else view.path.style.removeProperty('--edge-start');

    if (lineDashes[style.dash]) view.path.setAttribute('stroke-dasharray', lineDashes[style.dash]);
    else view.path.removeAttribute('stroke-dasharray');
    if (style.dash === 'dotted') view.path.setAttribute('stroke-linecap', 'round');
    else view.path.removeAttribute('stroke-linecap');

    if (edge.label) {
      const label = [...edge.label].length > 20 ? [...edge.label].slice(0, 20).join('') + '…' : edge.label;
      const { x, y } = curve.label;
      const width = [...label].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 12 : 7), 16);
      if (!view.labelBg) {
        view.labelBg = svg('rect', { height: 20, rx: 10, class: 'edge-label-bg' });
        view.labelText = svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'edge-label' });
        view.hit.before(view.labelBg, view.labelText);
      }
      view.labelBg.setAttribute('x', x - width / 2);
      view.labelBg.setAttribute('y', y - 10);
      view.labelBg.setAttribute('width', width);
      view.labelText.setAttribute('x', x);
      view.labelText.setAttribute('y', y);
      view.labelText.textContent = label;
    } else if (view.labelBg) {
      view.labelBg.remove();
      view.labelText.remove();
      view.labelBg = null;
      view.labelText = null;
    }
  }
}

function placeCard(element, node) {
  element.style.transform = 'translate(' + node.x + 'px,' + node.y + 'px)';
  const profile = element.dataset.profile;
  const compact = (profile === 'title' || profile === 'empty') && !element.hasAttribute('data-intrinsic') ? compactCardSize(node, profile) : null;
  element.style.width = compact ? compact.w + 'px' : '';
  element.style.height = compact ? compact.h + 'px' : '';
  element.style.maxWidth = compact ? '' : node.w + 'px';
}

const priorityLabels = {
  star: ['★', '星标'], low: ['↓', '低优先级'], medium: ['●', '中优先级'], high: ['↑', '高优先级'],
};

function cardChip(label, { color, mark, isStatus = false, id, pin = false, subBoardId = null, progress = null, sourcesForId = null, expanded = false } = {}) {
  const chip = document.createElement(isStatus || subBoardId || sourcesForId ? 'button' : 'span');
  chip.className = 'card-chip';
  if (isStatus) {
    chip.type = 'button';
    chip.dataset.cardStatus = id;
    chip.setAttribute('aria-label', '更改状态 · ' + label);
  } else if (subBoardId) {
    chip.type = 'button';
    chip.className += ' is-subboard';
    chip.dataset.subboard = subBoardId;
    chip.setAttribute('aria-label', '进入子画布 · ' + label);
  } else if (sourcesForId) {
    chip.type = 'button';
    chip.className += ' is-sources';
    chip.dataset.cardSources = sourcesForId;
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-expanded', String(expanded));
    chip.setAttribute('aria-label', '查看' + label);
  } else if (progress) {
    chip.className += ' is-progress' + (progress.done === progress.total ? ' is-complete' : '');
    chip.style.setProperty('--progress', Math.round(progress.done / progress.total * 100) + '%');
  }
  chip.title = pin ? '自动布局时保留当前位置' : subBoardId ? '点击进入子画布' : sourcesForId ? '点击查看来源与补充说明' : label;
  if (color || mark) {
    const indicator = document.createElement(mark ? 'span' : 'i');
    indicator.className = 'card-chip-mark';
    indicator.setAttribute('aria-hidden', 'true');
    if (mark) indicator.textContent = mark;
    if (color) indicator.style.setProperty('--chip-ink', color);
    chip.append(indicator);
  }
  if (pin || subBoardId || sourcesForId) {
    const symbol = document.createElement('span');
    symbol.innerHTML = icon(pin ? 'pin' : subBoardId ? 'subboard' : 'source');
    chip.append(symbol.firstElementChild);
  }
  if (!pin) {
    chip.append(document.createTextNode(label));
  }
  if (pin) chip.setAttribute('aria-label', label);
  return chip;
}

function compactUrlLabel(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    if (!path) return host + ' ↗';
    const shortPath = path.length > 18 ? path.slice(0, 17) + '…' : path;
    return host + shortPath + ' ↗';
  } catch {
    return rawUrl;
  }
}

function appendLinkedText(container, text) {
  const tokenRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|([^（()\n；·，。：]+?)（(https?:\/\/[^\s）<>"']+)）|(https?:\/\/[^\s<>"')]+)/gi;
  let lastIndex = 0;
  for (const match of text.matchAll(tokenRe)) {
    const start = match.index;
    if (start > lastIndex) container.append(text.slice(lastIndex, start));
    const label = match[1] || match[3]?.trim() || '';
    const rawUrl = match[2] || match[4] || match[5];
    const href = safeExternalUrl(rawUrl);
    if (href) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = href;
      link.textContent = label ? `${label} ↗` : compactUrlLabel(href);
      container.append(link);
    } else {
      container.append(match[0]);
    }
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) container.append(text.slice(lastIndex));
}

function renderPlainCardBody(container, text) {
  const fragment = document.createDocumentFragment();
  const lines = text.split(/\r?\n/);
  let list = null;
  lines.forEach((line, index) => {
    const match = line.match(checklistLineRe);
    if (match) {
      if (!list) {
        list = document.createElement('ul');
        fragment.append(list);
      }
      const checked = match[2] !== ' ';
      const item = document.createElement('li');
      item.className = 'checklist-item';
      item.dataset.done = String(checked);
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'check-box';
      box.dataset.cardCheck = 'line:' + index;
      box.setAttribute('role', 'checkbox');
      box.setAttribute('aria-checked', String(checked));
      box.setAttribute('aria-label', checked ? '取消完成待办' : '完成待办');
      const copy = document.createElement('span');
      copy.className = 'check-text';
      appendLinkedText(copy, line.replace(/^\s*[-*]\s*\[[ xX✓]\]\s+/, ''));
      item.append(box, copy);
      list.append(item);
      return;
    }
    list = null;
    const row = document.createElement('div');
    if (line) appendLinkedText(row, line);
    else row.append(document.createElement('br'));
    fragment.append(row);
  });
  container.replaceChildren(fragment);
}

function decorateRichChecklists(container) {
  let checkIndex = 0;
  for (const li of container.querySelectorAll('li[data-done]')) {
    const checked = li.getAttribute('data-done') === 'true';
    li.classList.add('checklist-item');
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'check-box';
    box.dataset.cardCheck = 'rich:' + (checkIndex++);
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(checked));
    box.setAttribute('aria-label', checked ? '取消完成待办' : '完成待办');
    const textWrap = document.createElement('span');
    textWrap.className = 'check-text';
    while (li.firstChild) textWrap.append(li.firstChild);
    li.append(box, textWrap);
  }
}

function cardDefaultsFor(id, settings) {
  const branchColor = inheritedBranches.get(id)?.color;
  const dark = isDarkHex(settings.appearance.background);
  const border = branchColor ? mixHex(branchColor, dark ? '#2a303c' : '#e2e8f0', 0.52) : undefined;
  const base = nodeBy(id)?.tone === 'topic'
    ? (({ fill, border: _b, text, ...rest }) => rest)(settings.appearance.card || {})
    : settings.appearance.card;
  return { ...base, ...(border ? { border } : {}) };
}

function decorateCard(view, node, settings, statusBy, tagBy) {
  const element = view.element;
  element.hidden = visibility.hidden.has(node.id);
  element.classList.toggle('is-dimmed', visibility.dimmed.has(node.id));
  element.dataset.detail = settings.detail;
  const style = { ...cardDefaultsFor(node.id, settings), ...node.style };
  const properties = {
    '--card-bg': style.fill, '--card-line': style.border, '--card-ink': style.text, '--card-sub': style.text,
    '--empty-fill': style.fill, '--empty-border': style.border, '--empty-text': style.text,
    '--plain-ink': style.text, '--card-font-size': style.size ? style.size + 'px' : '',
  };
  for (const [name, value] of Object.entries(properties)) {
    if (value) element.style.setProperty(name, value);
    else element.style.removeProperty(name);
  }
  if (style.shape) element.dataset.shape = style.shape;
  else delete element.dataset.shape;
  element.toggleAttribute('data-custom-fill', !!style.fill);
  element.toggleAttribute('data-sized', !!style.size);
  const status = statusBy.get(node.status);
  const tags = (node.tags || []).map(id => tagBy.get(id)).filter(Boolean);
  const priority = priorityLabels[node.priority];
  const progress = checklistStats(node);
  const subBoard = node.subBoardId ? workspace.boards.find(item => item.id === node.subBoardId) : null;
  const subBoardInfo = subBoard ? [subBoard.id, subBoard.nodes.length] : null;
  const sourceCount = node.sources?.length || 0;
  const hasNote = !!node.note?.trim();
  const sourcesExpanded = openSourceCardId === node.id;
  const metaKey = JSON.stringify([status, tags, priority, node.pinned, progress, subBoardInfo, sourceCount, hasNote, sourcesExpanded]);
  if (view.metaKey !== metaKey) {
    const chips = [];
    if (subBoard) chips.push(cardChip(`子画布 · ${subBoard.nodes.length} 张卡`, { subBoardId: subBoard.id }));
    if (progress) chips.push(cardChip(`✓ ${progress.done}/${progress.total}`, { progress }));
    if (status) chips.push(cardChip(status.name, { color: status.color, mark: status.icon, isStatus: true, id: node.id }));
    for (const tag of tags) chips.push(cardChip(tag.name, { color: tag.color }));
    if (priority) chips.push(cardChip(priority[1], { mark: priority[0] }));
    if (node.pinned) chips.push(cardChip('已固定', { pin: true }));
    if (sourceCount || hasNote) {
      const label = sourceCount && hasNote ? `来源 ${sourceCount} · 备注` : sourceCount ? `来源 ${sourceCount}` : '备注';
      chips.push(cardChip(label, { sourcesForId: node.id, expanded: sourcesExpanded }));
    }
    view.meta.replaceChildren(...chips);
    view.meta.hidden = !chips.length;
    view.metaKey = metaKey;
  }
  element.toggleAttribute('data-intrinsic',
    (element.dataset.profile === 'title' || element.dataset.profile === 'empty') && (!view.meta.hidden || !!style.size));
}

function foldSide(node, children, byId, lanes, mode) {
  if (mode === 'right' || mode === 'down') return mode;
  if (lanes.has(node.id)) return lanes.get(node.id);
  const counts = { right: 0, left: 0, down: 0, up: 0 };
  for (const child of children) {
    const side = lanes.get(child) || connectionSide(node, byId.get(child));
    counts[side] += 1;
  }
  return Object.keys(counts).reduce((best, side) => counts[side] > counts[best] ? side : best);
}

function createCardView(id) {
  const element = document.createElement('article');
  element.className = 'card';
  element.tabIndex = 0;
  element.dataset.card = id;
  element.innerHTML = '<div class="card-copy"><div class="card-type"></div><h2 class="card-title"></h2><div class="card-cover" hidden></div><div class="card-body flow-text"></div><div class="card-meta" hidden></div></div>' +
    '<button type="button" tabindex="-1" class="card-port" data-handle="link" data-port-side="top" aria-label="从上方连线" title="拖动连线"></button>' +
    '<button type="button" tabindex="-1" class="card-port" data-handle="link" data-port-side="right" aria-label="从右侧连线" title="拖动连线"></button>' +
    '<button type="button" tabindex="-1" class="card-port" data-handle="link" data-port-side="bottom" aria-label="从下方连线" title="拖动连线"></button>' +
    '<button type="button" tabindex="-1" class="card-port" data-handle="link" data-port-side="left" aria-label="从左侧连线" title="拖动连线"></button>' +
    '<button type="button" class="card-fold" data-card-fold hidden></button>' +
    '<button type="button" tabindex="-1" class="card-size" data-handle="resize" aria-label="调整卡片宽度" title="拖动调整换行宽度">' + icon('resize') + '</button>';
  cards.append(element);
  cardSizes.observe(element);
  const view = {
    element,
    type: element.querySelector('.card-type'),
    title: element.querySelector('.card-title'),
    cover: element.querySelector('.card-cover'),
    body: element.querySelector('.card-body'),
    meta: element.querySelector('.card-meta'),
    fold: element.querySelector('.card-fold'),
  };
  cardIndex.set(id, view);
  return view;
}

function renderCards(nodes = board().nodes) {
  const { settings } = board();
  const statusBy = new Map(settings.statuses.map(status => [status.id, status]));
  const tagBy = new Map(settings.tags.map(tag => [tag.id, tag]));
  const positions = layoutDraft?.result?.positions;
  const drawn = new Map(nodes.map(node => [node.id, positions?.has(node.id) ? { ...node, ...positions.get(node.id) } : node]));
  const layout = displayedLayout().options;
  const lanes = CanvasLayout.branchLanes(hierarchy, drawn, layout);
  const folded = new Set(settings.folded);
  for (const [id, view] of cardIndex) {
    if (!drawn.has(id)) {
      cardSizes.unobserve(view.element);
      view.element.remove();
      cardIndex.delete(id);
    }
  }
  for (const node of drawn.values()) {
    if (!cardIndex.has(node.id)) {
      createCardView(node.id);
    }
    const view = cardIndex.get(node.id);
    const content = cardProfile(node);
    const profile = settings.detail === 'title' && content !== 'empty' ? 'title' : content;
    const prevProfile = view.element.dataset.profile;
    const prevDetail = view.element.dataset.detail;
    const prevTitle = view.title.textContent;
    const prevWidth = view.element.style.maxWidth;
    if (view.element.dataset.tone !== node.tone) {
      view.element.dataset.tone = node.tone;
      view.type.innerHTML = icon(node.tone) + '<span>' + CanvasData.tone[node.tone].label + '</span>';
    }
    view.element.dataset.profile = profile;
    view.element.setAttribute('aria-label', titleOf(node));
    view.type.hidden = profile === 'empty' || (node.tone === 'idea' && profile !== 'title');
    view.title.hidden = !node.title.trim() && (profile === 'note' || profile === 'image');
    view.title.textContent = profile === 'empty' ? '待补充' : titleOf(node);
    const contentChanged = view.plain !== node.body || view.rich !== node.richBody;
    if (contentChanged) {
      view.plain = node.body;
      view.rich = node.richBody;
      view.cover.replaceChildren();
      view.cover.hidden = content !== 'image';
      view.body.classList.toggle('is-plain', false);
      if (node.richBody) {
        const fragment = richFragment(node.richBody);
        const images = fragment.querySelectorAll('img');
        if (images.length) view.cover.append(images[0]);
        view.body.replaceChildren(fragment);
        decorateRichChecklists(view.body);
      } else if (node.body.trim()) {
        renderPlainCardBody(view.body, node.body);
      } else {
        view.body.replaceChildren();
      }
    }
    view.body.hidden = !node.body.trim() && !view.body.querySelector('img');
    const prevMetaKey = view.metaKey;
    decorateCard(view, node, settings, statusBy, tagBy);
    const children = hierarchy.children.get(node.id) || [];
    view.fold.hidden = !children.length;
    if (children.length) {
      const expanded = !folded.has(node.id);
      const label = foldLabel(node, expanded, children.length);
      view.element.dataset.foldSide = foldSide(node, children, drawn, lanes, layout.mode);
      view.fold.textContent = expanded ? '−' : '+' + children.length;
      view.fold.setAttribute('aria-expanded', String(expanded));
      view.fold.setAttribute('aria-label', label);
      view.fold.title = label;
    } else delete view.element.dataset.foldSide;
    placeCard(view.element, node);
    if (contentChanged || prevProfile !== profile || prevDetail !== settings.detail ||
        prevTitle !== view.title.textContent || prevMetaKey !== view.metaKey || prevWidth !== view.element.style.maxWidth) {
      view.size = null;
    }
  }
}

function updateHoverHighlight() {
  const focusId = hoveredCardId || (selection.kind === 'cards' && selection.ids.size === 1 ? [...selection.ids][0] : null);
  const activeHover = !!(hoveredCardId && !gesture && !layoutDraft && !inlineEdit);
  viewport.classList.toggle('has-hover-focus', activeHover);
  const neighborIds = new Set();
  const connectedEdgeIds = new Set();
  if (focusId && nodeBy(focusId)) {
    for (const edge of board().edges) {
      if (edge.from === focusId || edge.to === focusId) {
        connectedEdgeIds.add(edge.id);
        neighborIds.add(edge.from === focusId ? edge.to : edge.from);
      }
    }
  }
  for (const [id, view] of cardIndex) {
    view.element.classList.toggle('is-neighbor', neighborIds.has(id) && id !== focusId);
  }
  for (const item of edgeLayer.querySelectorAll('[data-edge]')) {
    const connected = connectedEdgeIds.has(item.dataset.edge);
    item.classList.toggle('is-connected', connected);
    item.firstElementChild?.classList.toggle('is-connected', connected);
  }
}

function renderBreadcrumbs() {
  const container = $('#board-breadcrumbs');
  const chain = [];
  const seen = new Set();
  let cursor = board();
  while (cursor?.settings?.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parent = workspace.boards.find(item => item.id === cursor.settings.parentId);
    if (!parent) break;
    chain.unshift(parent);
    cursor = parent;
  }
  container.hidden = !chain.length;
  if (!chain.length) {
    container.replaceChildren();
    return;
  }
  const nodes = [];
  const immediateParent = chain.at(-1);
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'crumb-btn';
  backBtn.dataset.board = immediateParent.id;
  backBtn.title = '返回上级画布：' + immediateParent.name;
  backBtn.innerHTML = icon('back') + '<span>返回上级</span>';
  nodes.push(backBtn);
  const shown = chain.slice(-3);
  for (const ancestor of shown) {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'crumb-btn';
    crumb.dataset.board = ancestor.id;
    crumb.title = ancestor.name;
    const label = document.createElement('span');
    label.textContent = ancestor.name;
    crumb.append(label);
    nodes.push(sep, crumb);
  }
  container.replaceChildren(...nodes);
}

function renderSourcePopoverContent(node) {
  const head = document.createElement('div');
  head.className = 'source-popover-head';
  const heading = document.createElement('h3');
  heading.className = 'source-popover-title';
  heading.textContent = titleOf(node);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-btn';
  closeBtn.dataset.sourceClose = 'true';
  closeBtn.setAttribute('aria-label', '关闭来源面板');
  closeBtn.innerHTML = icon('close');
  head.append(heading, closeBtn);

  const parts = [head];
  if (node.note?.trim()) {
    const noteEl = document.createElement('p');
    noteEl.className = 'source-popover-note';
    noteEl.textContent = node.note.trim();
    parts.push(noteEl);
  }
  if (node.sources?.length) {
    const list = document.createElement('ul');
    list.className = 'source-popover-list';
    for (const src of node.sources) {
      const li = document.createElement('li');
      li.className = 'source-popover-item';
      const href = src.url ? safeExternalUrl(src.url) : null;
      const link = document.createElement(href ? 'a' : 'div');
      link.className = 'source-popover-link';
      if (href) {
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = href;
      } else if (src.url) {
        link.title = src.url;
      }
      const lbl = document.createElement('span');
      lbl.className = 'source-popover-label';
      lbl.textContent = src.label;
      link.append(lbl);
      if (href) {
        const dom = document.createElement('span');
        dom.className = 'source-popover-domain';
        try { dom.textContent = new URL(href).hostname.replace(/^www\./, '') + ' ↗'; } catch { dom.textContent = '↗'; }
        link.append(dom);
      } else if (src.url) {
        const doc = document.createElement('span');
        doc.className = 'source-popover-domain';
        doc.textContent = src.url;
        link.append(doc);
      }
      li.append(link);
      if (src.url) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'icon-btn source-popover-copy';
        copyBtn.dataset.copySource = src.url;
        copyBtn.title = '复制来源地址';
        copyBtn.setAttribute('aria-label', '复制来源地址');
        copyBtn.innerHTML = icon('copy');
        li.append(copyBtn);
      }
      list.append(li);
    }
    parts.push(list);
  }
  sourcePopover.replaceChildren(...parts);
}

function positionSourcePopover() {
  if (!openSourceCardId || sourcePopover.hidden) return;
  const view = cardIndex.get(openSourceCardId);
  const trigger = view?.element.querySelector('[data-card-sources]');
  if (!view || view.element.hidden || !trigger) {
    closeSourcePopover();
    return;
  }
  const rect = trigger.getBoundingClientRect();
  const popW = sourcePopover.offsetWidth || 340;
  const popH = sourcePopover.offsetHeight || 160;
  const left = clamp(rect.left, 16, Math.max(16, window.innerWidth - popW - 16));
  const topMin = chromeTopLimit();
  const below = rect.bottom + 8;
  const above = rect.top - popH - 8;
  const top = below + popH <= window.innerHeight - 16 || above < topMin
    ? clamp(below, topMin, Math.max(topMin, window.innerHeight - popH - 16))
    : above;
  sourcePopover.style.left = Math.round(left) + 'px';
  sourcePopover.style.top = Math.round(top) + 'px';
}

function closeSourcePopover() {
  if (!openSourceCardId && sourcePopover.hidden) return;
  const prevId = openSourceCardId;
  openSourceCardId = null;
  sourcePopover.hidden = true;
  sourcePopover.replaceChildren();
  const trigger = prevId ? cardIndex.get(prevId)?.element.querySelector('[data-card-sources]') : null;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function openSourcePopover(cardId) {
  if (openSourceCardId === cardId && !sourcePopover.hidden) {
    closeSourcePopover();
    return;
  }
  const node = nodeBy(cardId);
  if (!node || (!node.sources?.length && !node.note?.trim())) {
    closeSourcePopover();
    return;
  }
  closePopover();
  if (openSourceCardId && openSourceCardId !== cardId) closeSourcePopover();
  openSourceCardId = cardId;
  renderSourcePopoverContent(node);
  sourcePopover.hidden = false;
  const trigger = cardIndex.get(cardId)?.element.querySelector('[data-card-sources]');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  positionSourcePopover();
}

const selectionSubPopovers = {
  align: { panel: $('#align-popover'), toggle: $('#align-menu-btn') },
  more: { panel: $('#selection-more-popover'), toggle: $('#selection-more-btn') },
};

function closeSelectionSubPopovers() {
  if (!openSelectionSubPopover) return;
  const { panel, toggle } = selectionSubPopovers[openSelectionSubPopover];
  panel.hidden = true;
  toggle?.setAttribute('aria-expanded', 'false');
  openSelectionSubPopover = null;
}

function toggleSelectionSubPopover(key) {
  const prev = openSelectionSubPopover;
  closeSelectionSubPopovers();
  if (prev === key) return;
  const entry = selectionSubPopovers[key];
  if (!entry || $('#selection-tools').hidden) return;
  openSelectionSubPopover = key;
  entry.panel.hidden = false;
  entry.toggle?.setAttribute('aria-expanded', 'true');
  const anchorRect = entry.toggle.getBoundingClientRect();
  const popW = entry.panel.offsetWidth || 224;
  const popH = entry.panel.offsetHeight || 180;
  const left = clamp(anchorRect.left + anchorRect.width / 2 - popW / 2, 16, Math.max(16, window.innerWidth - popW - 16));
  const topMin = chromeTopLimit();
  const above = anchorRect.top - popH - 8;
  const below = anchorRect.bottom + 8;
  const top = above >= topMin ? above : clamp(below, topMin, Math.max(topMin, window.innerHeight - popH - 16));
  entry.panel.style.left = Math.round(left) + 'px';
  entry.panel.style.top = Math.round(top) + 'px';
}

function positionSelectionBar() {
  const bar = $('#selection-tools');
  if (bar.hidden) return;
  if (gesture?.moved && (gesture.kind === 'drag' || gesture.kind === 'resize' || gesture.kind === 'marquee')) {
    closeSelectionSubPopovers();
    bar.style.opacity = '0';
    bar.style.pointerEvents = 'none';
    return;
  }
  bar.style.opacity = '';
  bar.style.pointerEvents = '';
  const vpRect = viewport.getBoundingClientRect();
  const toScreenX = wx => vpRect.left + vpRect.width / 2 + (wx - camera.x) * camera.scale;
  const toScreenY = wy => vpRect.top + vpRect.height / 2 + (wy - camera.y) * camera.scale;
  let boxLeft, boxRight, boxTop, boxBottom;
  const ids = selection.kind === 'cards' ? [...selection.ids].map(nodeBy).filter(Boolean) : [];
  if (ids.length) {
    const b = boundsOf(ids);
    if (!b) return;
    boxLeft = toScreenX(b.left);
    boxRight = toScreenX(b.right);
    boxTop = toScreenY(b.top);
    boxBottom = toScreenY(b.bottom);
  } else {
    const edge = chosenEdge();
    if (!edge) return;
    const from = nodeBy(edge.from);
    const to = nodeBy(edge.to);
    if (!from || !to) return;
    const f = cardRect(from);
    const t = cardRect(to);
    const mx = (f.x + f.w / 2 + t.x + t.w / 2) / 2;
    const my = (f.y + f.h / 2 + t.y + t.h / 2) / 2;
    boxLeft = boxRight = toScreenX(mx);
    boxTop = boxBottom = toScreenY(my);
  }
  const barW = bar.offsetWidth || 240;
  const barH = bar.offsetHeight || 40;
  const centerX = (boxLeft + boxRight) / 2;
  const left = clamp(centerX - barW / 2, 16, Math.max(16, window.innerWidth - barW - 16));
  const topMin = chromeTopLimit();
  const preferAbove = boxTop - barH - 12;
  const fallbackBelow = boxBottom + 12;
  const maxTop = Math.max(topMin, window.innerHeight - barH - 80);
  let top = preferAbove >= topMin ? preferAbove : (fallbackBelow <= maxTop ? fallbackBelow : clamp(preferAbove, topMin, maxTop));
  bar.style.left = Math.round(left) + 'px';
  bar.style.top = Math.round(top) + 'px';
}

function renderSelection() {
  const current = board();
  const ids = selection.kind === 'cards' ? selection.ids : new Set();
  for (const [id, view] of cardIndex) view.element.classList.toggle('selected', ids.has(id));
  const edge = chosenEdge();
  const hasSelection = !!edge || ids.size > 0;
  const showActions = hasSelection && mode !== 'link' && !layoutDraft && !inlineEdit;
  if (!showActions) closeSelectionSubPopovers();
  $('#selection-tools').hidden = !showActions;
  $('#idle-tip').hidden = tipDismissed || showActions || mode === 'link' || current.nodes.length === 0 || !!inlineEdit;
  $('#link-tip').hidden = mode !== 'link';
  if (mode === 'link') {
    $('#link-tip').textContent = linkSource ? '点击目标卡片完成连线' : '点击一张卡片作为连线起点';
  }
  controls['edit-selected'].hidden = ids.size > 1;
  const editTitle = edge ? '编辑连线说明' : '编辑卡片 (E)';
  controls['edit-selected'].title = editTitle;
  controls['edit-selected'].setAttribute('aria-label', editTitle);
  controls['branch-selected'].hidden = ids.size !== 1;
  $('#selection-tones').hidden = !ids.size;
  if (ids.size) {
    const selectedNodes = [...ids].map(nodeBy).filter(Boolean);
    const commonTone = selectedNodes.length && selectedNodes.every(n => n.tone === selectedNodes[0].tone) ? selectedNodes[0].tone : '';
    for (const dot of $('#selection-tones').children) {
      dot.setAttribute('aria-pressed', String(dot.dataset.quickTone === commonTone));
    }
  }
  controls.duplicate.hidden = !ids.size;
  controls['pin-layout'].hidden = !ids.size;
  controls['pin-layout'].setAttribute('aria-pressed', String(ids.size > 0 && [...ids].every(id => nodeBy(id)?.pinned)));
  controls['focus-branch'].hidden = ids.size !== 1;
  controls['frame-add'].hidden = !ids.size;
  controls['extract-subboard'].hidden = !ids.size;
  controls['copy-markdown'].hidden = !ids.size;
  controls['branch-layout'].hidden = ids.size !== 1 || !hierarchy?.children.get([...ids][0])?.length;
  $('#selection-more-btn').hidden = !ids.size;
  $('#align-menu-btn').hidden = ids.size < 2;
  for (const option of $('#align-popover').querySelectorAll('[data-align-cmd^="distribute"]')) option.disabled = ids.size < 3;
  $('#selected-count').hidden = ids.size <= 1;
  $('#selected-count').textContent = '已选 ' + ids.size + ' 张';
  for (const item of edgeLayer.querySelectorAll('[data-edge]')) {
    const active = item.dataset.edge === edge?.id;
    item.firstElementChild.classList.toggle('selected', active);
  }
  if (showActions) positionSelectionBar();
  updateHoverHighlight();
}

function setSelected(ids, edgeId = null) {
  closeSelectionSubPopovers();
  selection = edgeId ? { kind: 'edge', id: edgeId } : { kind: 'cards', ids: new Set(ids) };
  renderSelection();
  CanvasInspector.refresh();
  CanvasViews.refresh();
}

function setMode(next) {
  mode = next;
  linkSource = null;
  preview.hidden = true;
  for (const tool of ['select', 'hand', 'link']) controls['mode-' + tool].setAttribute('aria-pressed', tool === next);
  paintMode();
  renderSelection();
}

function paintMode() {
  viewport.classList.toggle('is-hand', spaceHeld || mode === 'hand');
  viewport.classList.toggle('is-link', !spaceHeld && mode === 'link');
  viewport.classList.toggle('is-moving', !!gesture?.moved && (gesture.kind === 'pan' || gesture.kind === 'drag'));
  viewport.classList.toggle('is-matrix-dragging', !!gesture?.moved && !!gesture.matrix);
}

function render() {
  cancelPositionAnimation();
  const current = board();
  $('#board-title').textContent = current.name;
  document.title = current.name + ' · 想法画布';
  renderBreadcrumbs();
  $('#sample-hint').hidden = current.id !== 'starter';
  $('#empty-state').hidden = current.nodes.length !== 0;
  $('#counts').textContent = current.nodes.length + ' 张卡片 · ' + current.edges.length + ' 条连线';
  const { past, future } = selectedBoardHistory();
  controls.undo.disabled = !past.length;
  controls.redo.disabled = !future.length;
  hierarchy = CanvasLayout.tree(current.nodes, current.edges);
  visibility = CanvasViews.visibility(hierarchy);
  if (selection.kind === 'cards') selection.ids = new Set([...selection.ids].filter(id => !visibility.hidden.has(id)));
  else {
    const edge = chosenEdge();
    if (edge && (visibility.hidden.has(edge.from) || visibility.hidden.has(edge.to))) selection = noSelection();
  }
  controls.arrange.disabled = !current.nodes.length;
  controls['auto-arrange'].disabled = !current.nodes.length;
  paintAppearance();
  renderCards();
  renderEdges();
  CanvasViews.renderFrames(layoutDraft?.result?.positions, visibility.hidden);
  paintLayoutGuides();
  renderSelection();
  CanvasInspector.refresh();
  CanvasViews.refresh();
  paintView();
  if (openSourceCardId) {
    const activeNode = nodeBy(openSourceCardId);
    if (!activeNode || (!activeNode.sources?.length && !activeNode.note?.trim())) closeSourcePopover();
    else {
      renderSourcePopoverContent(activeNode);
      positionSourcePopover();
    }
  }
}

function scheduleMap() {
  if (!mapFrame) mapFrame = requestAnimationFrame(paintMap);
}

function paintMap() {
  mapFrame = 0;
  const width = minimap.clientWidth;
  const height = minimap.clientHeight;
  if (!width || !height) return;
  const density = Math.min(window.devicePixelRatio || 1, 3);
  minimap.width = Math.round(width * density);
  minimap.height = Math.round(height * density);
  const ctx = minimap.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.scale(density, density);
  const current = board();
  const dark = isDarkHex(current.settings.appearance.background);
  const accent = current.settings.appearance.accent || (dark ? '#10b981' : '#0f766e');
  const topicColor = mixHex(accent, '#0b171d', 0.56);
  const viewportSizeNow = viewportSize();
  const visibleWidth = viewportSizeNow.width / camera.scale;
  const visibleHeight = viewportSizeNow.height / camera.scale;
  const positions = activeLayoutPositions || gesture?.positions || layoutDraft?.result?.positions;
  const shown = effectiveNodes(positions).filter(node => !visibility.hidden.has(node.id));
  const frameBoxes = current.settings.frames
    .map(frame => ({ frame, box: CanvasViews.frameRect(frame, positions, visibility.hidden) }))
    .filter(item => item.box);
  const bounds = boundsOf([
    ...shown,
    ...frameBoxes.map(({ box }) => box),
  ]);
  const margin = 85;
  const scale = bounds
    ? Math.min((width - 12) / (bounds.w + margin * 2), (height - 10) / (bounds.h + margin * 2))
    : Math.min((width - 14) / visibleWidth, (height - 14) / visibleHeight);
  const left = bounds ? (bounds.left + bounds.right) / 2 : camera.x;
  const top = bounds ? (bounds.top + bounds.bottom) / 2 : camera.y;
  const display = {
    scale, offsetX: width / 2 - left * scale, offsetY: height / 2 - top * scale,
  };
  mapGeometry = display;
  const x = value => value * scale + display.offsetX;
  const y = value => value * scale + display.offsetY;
  for (const { frame, box } of frameBoxes) {
    ctx.beginPath();
    const fw = Math.max(4, box.w * scale);
    const fh = Math.max(4, box.h * scale);
    if (ctx.roundRect) ctx.roundRect(x(box.x), y(box.y), fw, fh, 3);
    else ctx.rect(x(box.x), y(box.y), fw, fh);
    ctx.fillStyle = frame.color || '#6d9780';
    ctx.globalAlpha = 0.14;
    ctx.fill();
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.strokeStyle = frame.color || '#6d9780';
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.strokeStyle = dark ? 'rgba(148, 163, 184, 0.35)' : 'rgba(100, 116, 139, 0.35)';
  ctx.beginPath();
  const nodes = new Map(shown.map(node => [node.id, cardRect(node)]));
  for (const { from, to } of current.edges) {
    const a = nodes.get(from);
    const b = nodes.get(to);
    if (!a || !b) continue;
    ctx.moveTo(x(a.x + a.w / 2), y(a.y + a.h / 2));
    ctx.lineTo(x(b.x + b.w / 2), y(b.y + b.h / 2));
  }
  ctx.stroke();
  const selectedSet = selection.kind === 'cards' ? selection.ids : null;
  for (const node of nodes.values()) {
    const customFill = node.style?.fill || inheritedBranches.get(node.id)?.color || current.settings.appearance.card.fill;
    ctx.fillStyle = customFill || (node.tone === 'topic' ? topicColor : dark ? '#334155' : '#cbd5e1');
    ctx.globalAlpha = visibility.dimmed.has(node.id) ? .28 : .92;
    const rw = Math.max(3, node.w * scale);
    const rh = Math.max(2.5, node.h * scale);
    const rx = x(node.x);
    const ry = y(node.y);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(rx, ry, rw, rh, Math.min(2.5, rw / 3, rh / 3));
    else ctx.rect(rx, ry, rw, rh);
    ctx.fill();
    if (selectedSet?.has(node.id)) {
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = accent;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  const viewW = visibleWidth * scale;
  const viewH = visibleHeight * scale;
  const viewX = x(camera.x) - viewW / 2;
  const viewY = y(camera.y) - viewH / 2;
  const boxLeft = clamp(viewX, 1.5, width - 1.5);
  const boxTop = clamp(viewY, 1.5, height - 1.5);
  const boxRight = clamp(viewX + viewW, 1.5, width - 1.5);
  const boxBottom = clamp(viewY + viewH, 1.5, height - 1.5);
  if (boxRight - boxLeft > 2 && boxBottom - boxTop > 2) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop, 3);
    else ctx.rect(boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop);
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.14;
    ctx.fill();
    ctx.globalAlpha = 0.72;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = accent;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

