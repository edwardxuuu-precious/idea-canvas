const CanvasData = (() => {
  const tone = {
    topic: { label: '主题' },
    idea: { label: '想法' },
    question: { label: '问题' },
    action: { label: '行动' },
    reference: { label: '素材' },
  };
  const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
  const coordinateLimit = 1_000_000_000;
  const sizeLimit = 1_000_000;

  function uid() {
    const random = globalThis.crypto;
    if (random?.randomUUID) return random.randomUUID();
    const bytes = random.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function makeBoard(name) {
    return { id: uid(), name, nodes: [], edges: [], view: null, settings: newSettings() };
  }

  function requireValue(condition, message) {
    if (!condition) throw new Error(message);
  }

  function isId(value) {
    return typeof value === 'string' && idPattern.test(value);
  }

  function within(value, minimum, maximum) {
    return Number.isFinite(value) && value >= minimum && value <= maximum;
  }

  function isCoordinate(value) {
    return within(value, -coordinateLimit, coordinateLimit);
  }

  const layoutModes = ['right', 'double', 'down', 'free', 'timeline', 'matrix', 'fishbone'];
  const priorities = ['none', 'low', 'medium', 'high', 'star'];
  const axes = ['status', 'tone', 'priority'];
  const statuses = [
    { id: 'pending', name: '待验证', color: '#ad7429', icon: '○' },
    { id: 'watching', name: '观察中', color: '#397aa8', icon: '◐' },
    { id: 'reviewed', name: '已复盘', color: '#3d7c61', icon: '✓' },
  ];
  const isColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const listed = (value, choices, fallback) => choices.includes(value) ? value : fallback;
  const asText = (value, limit) => typeof value === 'string' ? [...value.trim()].slice(0, limit).join('') : '';

  function newAppearance() {
    return { background: '#f5f6f8', grid: 'dots', gridColor: '#94a3b8', gridSize: 24, accent: '#0f766e',
      card: {}, branch: {}, link: {} };
  }

  function newSettings() {
    return {
      layout: { mode: 'right', nodeGap: 24, levelGap: 76, rootId: null, rows: 'status', columns: 'tone' },
      guides: [], appearance: newAppearance(), statuses: structuredClone(statuses), tags: [],
      folded: [], singleBranch: false, detail: 'full', frames: [],
    };
  }

  function parseSources(value) {
    if (!Array.isArray(value)) return [];
    const items = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const label = asText(entry.label, 160);
      if (!label) continue;
      const rawUrl = typeof entry.url === 'string' ? entry.url.trim() : '';
      let url = '';
      if (rawUrl) {
        const ext = safeExternalUrl(rawUrl);
        if (ext) url = ext;
        else if (/^(?:\.\.?\/)?[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._-]+)?$/.test(rawUrl) && rawUrl.length <= 2048) url = rawUrl;
      }
      items.push(url ? { label, url } : { label });
      if (items.length >= 40) break;
    }
    return items;
  }

  function styles(value, kind) {
    const result = {};
    const keys = kind === 'card' ? ['fill', 'border', 'text'] : ['color'];
    for (const key of keys) if (isColor(value?.[key])) result[key] = value[key];
    if (kind === 'card') {
      if (within(value?.size, 10, 32)) result.size = value.size;
      if (['rounded','pill','square','plain'].includes(value?.shape)) result.shape = value.shape;
    } else {
      if (within(value?.width, .75, 8)) result.width = value.width;
      if (['curve','straight','elbow'].includes(value?.shape)) result.shape = value.shape;
      if (['solid','dashed','dotted'].includes(value?.dash)) result.dash = value.dash;
      if (['none','start','end','both'].includes(value?.arrow)) result.arrow = value.arrow;
    }
    return result;
  }

  function appearance(value) {
    const defaults = newAppearance();
    const legacyDefault = value &&
      typeof value.background === 'string' && value.background.toLowerCase() === '#f6f6ef' &&
      typeof value.gridColor === 'string' && value.gridColor.toLowerCase() === '#a7b3a4' &&
      value.gridSize === 23 &&
      typeof value.accent === 'string' && value.accent.toLowerCase() === '#347853';
    if (!legacyDefault) {
      for (const key of ['background','gridColor','accent']) if (isColor(value?.[key])) defaults[key] = value[key];
      if (within(value?.gridSize, 10, 64)) defaults.gridSize = value.gridSize;
    }
    defaults.grid = listed(value?.grid, ['dots','lines','none'], defaults.grid);
    for (const key of ['card','branch','link']) defaults[key] = styles(value?.[key], key === 'card' ? 'card' : 'line');
    return defaults;
  }

  function records(value, map) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.flatMap(item => {
      if (!isId(item?.id) || seen.has(item.id)) return [];
      const record = map(item, asText(item.name, 64));
      if (!record) return [];
      seen.add(item.id);
      return [record];
    });
  }

  function options(value) {
    return records(value, (item, name) => name && {
      id: item.id, name, color: isColor(item.color) ? item.color : '#527963', icon: asText(item.icon, 4),
    });
  }

  function validIds(value, allowed) {
    return Array.isArray(value) ? [...new Set(value.filter(id => allowed.has(id)))] : [];
  }

  function settings(value, nodes) {
    const result = newSettings();
    result.appearance = appearance(value?.appearance);
    if (Array.isArray(value?.statuses)) result.statuses = options(value.statuses);
    result.tags = options(value?.tags);
    const nodeIds = new Set(nodes.map(node => node.id));
    const statusIds = new Set(result.statuses.map(item => item.id));
    const tagIds = new Set(result.tags.map(item => item.id));
    for (const node of nodes) {
      if (!statusIds.has(node.status)) delete node.status;
      if (node.tags) node.tags = validIds(node.tags, tagIds);
    }
    const layout = value?.layout;
    result.layout = {
      mode: listed(layout?.mode, layoutModes, 'right'),
      nodeGap: within(layout?.nodeGap, 8, 240) ? layout.nodeGap : 24,
      levelGap: within(layout?.levelGap, 16, 360) ? layout.levelGap : 76,
      rootId: nodeIds.has(layout?.rootId) ? layout.rootId : null,
      rows: listed(layout?.rows, axes, 'status'),
      columns: listed(layout?.columns, axes, 'tone'),
    };
    result.detail = listed(value?.detail, ['title', 'summary', 'full'], 'full');
    result.folded = validIds(value?.folded, nodeIds);
    result.singleBranch = value?.singleBranch === true;
    result.parentId = isId(value?.parentId) ? value.parentId : null;
    result.frames = records(value?.frames, (item, name) => {
      const members = validIds(item.members, nodeIds);
      const rawBox = item.box;
      const box = rawBox && isCoordinate(rawBox.x) && isCoordinate(rawBox.y) &&
        within(rawBox.w, 120, sizeLimit) && within(rawBox.h, 90, sizeLimit)
        ? { x: rawBox.x, y: rawBox.y, w: rawBox.w, h: rawBox.h } : undefined;
      return name && (members.length || box) && { id: item.id, name, members,
        color: isColor(item.color) ? item.color : '#679077', ...(box ? { box } : {}) };
    });
    if (Array.isArray(value?.guides)) {
      result.guides = value.guides.filter(line => isCoordinate(line?.x) && isCoordinate(line?.y)).flatMap(line => {
        const {kind, x, y, x2, y2, text, axis, value} = line;
        if (kind === 'line' && isCoordinate(x2) && isCoordinate(y2)) return [{kind,x,y,x2,y2}];
        if (kind === 'label' && asText(text,100)) {
          const bucket = axes.includes(axis) && (value === '' || isId(value)) ? { axis, value } : {};
          return [{kind,x,y,text:asText(text,100),...bucket}];
        }
        return [];
      });
    }
    return result;
  }

  function parseView(value) {
    if (value === null) return null;
    requireValue(isCoordinate(value?.x) && isCoordinate(value?.y) && within(value?.scale, 0.08, 3), '视图位置或缩放比例无效。');
    const { x, y, scale } = value;
    return { x, y, scale };
  }

  function parseBoard(value) {
    requireValue(isId(value?.id) && typeof value.name === 'string', '画布名称或标识无效。');
    requireValue(Array.isArray(value.nodes) && Array.isArray(value.edges), '缺少卡片或连线列表。');
    const nodeIds = new Set();
    const nodes = value.nodes.map(node => {
      requireValue(isId(node?.id) && !nodeIds.has(node.id), '卡片标识无效或重复。');
      const { id, x, y, w, h, tone: nodeTone, title, body, richBody } = node;
      requireValue(isCoordinate(x) && isCoordinate(y) && within(w, 64, sizeLimit) && within(h, 36, sizeLimit), '卡片位置或尺寸无效。');
      requireValue(typeof nodeTone === 'string' && Object.hasOwn(tone, nodeTone) && typeof title === 'string' && typeof body === 'string', '卡片类型或文字内容无效。');
      nodeIds.add(id);
      const result = { id, x, y, w, h, tone: nodeTone, title, body };
      if (richBody !== undefined) {
        requireValue(typeof richBody === 'string', '卡片富文本内容无效。');
        const clean = richContent(richBody);
        if (clean.html) Object.assign(result, { body: clean.text, richBody: clean.html });
      }
      if (typeof node.note === 'string' && node.note.trim()) result.note = [...node.note.trim()].slice(0, 2000).join('');
      const sources = parseSources(node.sources);
      if (sources.length) result.sources = sources;
      if (node.style) result.style = styles(node.style, 'card');
      if (node.branchStyle) result.branchStyle = styles(node.branchStyle, 'line');
      if (isId(node.status)) result.status = node.status;
      if (Array.isArray(node.tags)) result.tags = node.tags.filter(isId);
      if (priorities.includes(node.priority)) result.priority = node.priority;
      if (node.pinned === true) result.pinned = true;
      if (within(node.order, -sizeLimit, sizeLimit)) result.order = node.order;
      if (isId(node.subBoardId)) result.subBoardId = node.subBoardId;
      return result;
    });
    const edgeIds = new Set();
    const pairs = new Set();
    const edges = value.edges.map(edge => {
      requireValue(isId(edge?.id) && !edgeIds.has(edge.id), '连线标识无效或重复。');
      const { id, from, to, label, kind } = edge;
      requireValue(nodeIds.has(from) && nodeIds.has(to) && from !== to, '连线必须连接两张不同的卡片。');
      requireValue(typeof label === 'string' && (kind === 'branch' || kind === 'link'), '连线类型或名称无效。');
      const pair = from < to ? `${from}:${to}` : `${to}:${from}`;
      requireValue(!pairs.has(pair), '同两张卡片的连线重复。');
      edgeIds.add(id);
      pairs.add(pair);
      return { id, from, to, label, kind, ...(edge.style ? { style: styles(edge.style, 'line') } : {}) };
    });
    return { id: value.id, name: value.name, nodes, edges, view: parseView(value.view),
      settings: settings(value.settings, nodes) };
  }

  function parse(raw) {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('文件中的 JSON 无法读取。');
    }
    requireValue([1, 2, 3].includes(value?.version), '无法识别此画布文件的版本。');
    requireValue(Array.isArray(value.boards) && value.boards.length > 0, '文件中缺少画布。');
    const boardIds = new Set();
    const boards = value.boards.map(board => {
      const parsed = parseBoard(board);
      requireValue(!boardIds.has(parsed.id), '画布标识重复。');
      boardIds.add(parsed.id);
      return parsed;
    });
    requireValue(boardIds.has(value.activeId), '当前画布在文件中不存在。');
    for (const item of boards) {
      if (item.settings.parentId && (!boardIds.has(item.settings.parentId) || item.settings.parentId === item.id)) {
        item.settings.parentId = null;
      }
      for (const node of item.nodes) {
        if (node.subBoardId && (!boardIds.has(node.subBoardId) || node.subBoardId === item.id)) {
          delete node.subBoardId;
        }
      }
    }
    const themes = records(value.themes, (item, name) => name && { id: item.id, name, appearance: appearance(item.appearance) });
    return { version: 3, activeId: value.activeId, boards, themes };
  }

  function storage(editionId, pathname = location.pathname) {
    const key = `idea-canvas:v1:${JSON.stringify([editionId, pathname])}`;
    return {
      read() {
        return localStorage.getItem(key);
      },
      write(serialized) {
        localStorage.setItem(key, serialized);
      },
    };
  }

  function exportHtml(sourceHtml, value) {
    const marker = /(<script id="canvas-data" type="application\/json">)[\s\S]*?(<\/script>)/;
    requireValue(marker.test(sourceHtml), '无法写入 HTML 中的画布数据。');
    const snapshot = JSON.stringify({ edition: uid(), workspace: value })
      .replaceAll('<', '\\u003c')
      .replaceAll('>', '\\u003e')
      .replaceAll('&', '\\u0026');
    return sourceHtml.replace(marker, (match, opening, closing) => opening + snapshot + closing);
  }

  return { tone, uid, makeBoard, newAppearance, newSettings, parse, storage, exportHtml };
})();
