function mergeThemes(incoming) {
  const byId = new Map(workspace.themes.map(item => [item.id, item]));
  for (const theme of incoming) {
    const existing = byId.get(theme.id);
    if (JSON.stringify(existing) === JSON.stringify(theme)) continue;
    const entry = existing ? { ...theme, id: CanvasData.uid(), name: theme.name + '（导入）' } : theme;
    workspace.themes.push(entry);
    byId.set(entry.id, entry);
  }
}

function formatNodesAsMarkdown(nodeMap, tree, statuses, tags) {
  const statusMap = new Map((statuses || []).map(s => [s.id, s.name]));
  const tagMap = new Map((tags || []).map(t => [t.id, t.name]));
  const lines = [];
  function emitNode(id, depth) {
    const node = nodeMap.get(id);
    if (!node) return;
    const indent = '  '.repeat(Math.max(0, depth - 1));
    const meta = [];
    if (node.tone !== 'idea') meta.push(CanvasData.tone[node.tone].label);
    if (node.status && statusMap.has(node.status)) meta.push(statusMap.get(node.status));
    if (node.priority && priorityLabels[node.priority]) meta.push(priorityLabels[node.priority][1]);
    if (node.tags?.length) {
      const names = node.tags.map(tid => tagMap.get(tid)).filter(Boolean);
      if (names.length) meta.push(names.map(n => '#' + n).join(' '));
    }
    const suffix = meta.length ? ` _(${meta.join(' · ')})_` : '';
    const heading = depth === 0 ? '# ' : depth === 1 ? '## ' : indent + '- ';
    lines.push(heading + titleOf(node) + suffix);
    const body = (node.body || '').trim();
    if (body) {
      const bodyIndent = depth === 0 ? '' : indent + '  ';
      for (const line of body.split(/\r?\n/)) {
        if (line.trim()) lines.push(bodyIndent + line.trim());
      }
    }
    const extraIndent = depth === 0 ? '' : indent + '  ';
    if (node.note?.trim()) lines.push(extraIndent + '> 备注：' + node.note.trim().replace(/\s+/g, ' '));
    if (node.sources?.length) {
      const sourceText = node.sources.map(s => s.url ? `[${s.label}](${s.url})` : s.label).join(' · ');
      lines.push(extraIndent + '> 来源：' + sourceText);
    }
    for (const child of tree.children.get(id) || []) emitNode(child, depth + 1);
  }
  for (const rootId of tree.roots) emitNode(rootId, 0);
  return lines.join('\n').trim();
}

function selectionToMarkdown(ids = noteIds()) {
  const current = board();
  const chosen = new Set(ids);
  if (!chosen.size) return '';
  let scopeIds = chosen;
  if (chosen.size === 1) {
    const rootId = [...chosen][0];
    const sub = CanvasLayout.subtree(hierarchy, rootId).filter(id => !visibility.hidden.has(id));
    if (sub.length > 1) scopeIds = new Set(sub);
  }
  const nodeMap = new Map(current.nodes.filter(n => scopeIds.has(n.id)).map(n => [n.id, n]));
  const localTree = CanvasLayout.project(hierarchy, scopeIds);
  return formatNodesAsMarkdown(nodeMap, localTree, current.settings.statuses, current.settings.tags);
}

async function copySelectionAsMarkdown() {
  const md = selectionToMarkdown();
  if (!md) return;
  try {
    await navigator.clipboard.writeText(md);
    toast('已复制结构化 Markdown，可直接粘贴给 AI');
  } catch {
    toast('无法写入系统剪贴板', 'error');
  }
}

function parseMarkdownTree(raw) {
  const rawLines = raw.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim());
  if (rawLines.length < 2) return null;
  const items = [];
  let minHeading = 7;
  let hasStructured = false;
  for (const rawLine of rawLines) {
    const headingMatch = rawLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      hasStructured = true;
      const level = headingMatch[1].length;
      minHeading = Math.min(minHeading, level);
      items.push({ kind: 'heading', level, text: headingMatch[2].trim() });
      continue;
    }
    const listMatch = rawLine.match(/^([ \t]*)(?:[-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      hasStructured = true;
      const indent = listMatch[1].replace(/\t/g, '  ').length;
      items.push({ kind: 'list', indent, text: listMatch[2].trim() });
      continue;
    }
    if (items.length) {
      items[items.length - 1].notes = (items[items.length - 1].notes || '') + (items[items.length - 1].notes ? '\n' : '') + rawLine.trim();
    }
  }
  if (!hasStructured || items.length < 2) return null;
  const rootHeadingBase = minHeading <= 6 ? minHeading : 1;
  let lastHeadingDepth = 0;
  const nodes = [];
  const edges = [];
  const stack = [];
  for (const item of items) {
    let depth;
    if (item.kind === 'heading') {
      depth = item.level - rootHeadingBase;
      lastHeadingDepth = depth + 1;
    } else {
      depth = lastHeadingDepth + Math.floor(item.indent / 2);
    }
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const text = item.text;
    const isCheck = /^\[([ xX]?)\]\s+/.test(text);
    const cleanTitle = text.replace(/^\[([ xX]?)\]\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1');
    const tone = nodes.length === 0 ? 'topic'
      : isCheck ? 'action'
      : /[?？]$/.test(cleanTitle) ? 'question' : 'idea';
    const body = isCheck ? `- ${text}` : (item.notes || '');
    const node = {
      id: CanvasData.uid(), x: 0, y: 0, w: 260, h: body ? 140 : 62,
      tone, title: cleanTitle, body,
    };
    nodes.push(node);
    if (stack.length) {
      edges.push({ id: CanvasData.uid(), from: stack.at(-1).id, to: node.id, label: '', kind: 'branch' });
    }
    stack.push({ depth, id: node.id });
  }
  return nodes.length >= 2 ? { nodes, edges } : null;
}

function buildInternalClipboard(ids) {
  const current = board();
  const idSet = new Set(ids);
  const nodes = current.nodes.filter(n => idSet.has(n.id)).map(n => structuredClone(n));
  if (!nodes.length) return null;
  const edges = current.edges.filter(e => idSet.has(e.from) && idSet.has(e.to)).map(e => structuredClone(e));
  const usedStatuses = new Set(nodes.map(n => n.status).filter(Boolean));
  const usedTags = new Set(nodes.flatMap(n => n.tags || []));
  return {
    marker: 'IDEA_CANVAS_CLIPBOARD_V1',
    sourceBoardId: current.id,
    nodes,
    edges,
    statuses: current.settings.statuses.filter(s => usedStatuses.has(s.id)).map(s => structuredClone(s)),
    tags: current.settings.tags.filter(t => usedTags.has(t.id)).map(t => structuredClone(t)),
  };
}

function copySelectionToClipboard(cut = false) {
  const ids = noteIds();
  if (!ids.length) return;
  const payload = buildInternalClipboard(ids);
  if (!payload) return;
  internalClipboard = payload;
  const md = selectionToMarkdown(ids);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(md).catch(() => {});
  }
  if (cut) {
    removeSelected();
    toast(`已剪切 ${payload.nodes.length} 张卡片`);
  } else {
    toast(`已复制 ${payload.nodes.length} 张卡片（支持跨画布粘贴）`);
  }
}

function pasteNodesIntoBoard(payload, anchorWorld) {
  const current = board();
  const statusMap = new Map(current.settings.statuses.map(s => [s.id, s]));
  const tagMap = new Map(current.settings.tags.map(t => [t.id, t]));
  const box = boundsOf(payload.nodes);
  const centerX = box ? (box.left + box.right) / 2 : 0;
  const centerY = box ? (box.top + box.bottom) / 2 : 0;
  const idMap = new Map(payload.nodes.map(n => [n.id, CanvasData.uid()]));
  checkpoint();
  for (const st of payload.statuses || []) {
    if (!statusMap.has(st.id)) current.settings.statuses.push(structuredClone(st));
  }
  for (const tg of payload.tags || []) {
    if (!tagMap.has(tg.id)) current.settings.tags.push(structuredClone(tg));
  }
  const inserted = payload.nodes.map(n => {
    const copy = structuredClone(n);
    copy.id = idMap.get(n.id);
    if (copy.subBoardId === current.id) delete copy.subBoardId;
    copy.x = coordinate(anchorWorld.x + (n.x - centerX));
    copy.y = coordinate(anchorWorld.y + (n.y - centerY));
    return copy;
  });
  const edges = (payload.edges || []).map(e => ({
    ...structuredClone(e), id: CanvasData.uid(), from: idMap.get(e.from), to: idMap.get(e.to),
  }));
  current.nodes.push(...inserted);
  current.edges.push(...edges);
  selection = { kind: 'cards', ids: new Set(inserted.map(n => n.id)) };
  render();
  save();
  toast(`已粘贴 ${inserted.length} 张卡片`);
}

async function handleCanvasPaste(clipboardData) {
  const targetLocal = lastPointerLocal || { x: viewportSize().width / 2, y: viewportSize().height / 2 };
  const targetWorld = worldPoint(targetLocal);
  const files = [...(clipboardData?.files || [])].filter(f => imageType.test(f.type));
  if (files.length) {
    const node = blankCard(targetWorld);
    node.title = files[0].name?.replace(/\.[^.]+$/, '') || '图片笔记';
    try {
      const data = await pictureData(files[0]);
      if (!canAddPictureBytes(data.length + 200)) return toast('画布图片存储空间已满', 'error');
      const html = `<img src="${data}" alt="${node.title}">`;
      const clean = richContent(html);
      node.body = clean.text;
      node.richBody = clean.html;
      applyChange(() => {
        board().nodes.push(node);
        selection = { kind: 'cards', ids: new Set([node.id]) };
      });
      toast('已从剪贴板新建图片卡片');
    } catch (error) {
      toast(error.message || '无法读取剪贴板图片', 'error');
    }
    return;
  }
  const text = clipboardData?.getData('text/plain') || '';
  const mdCheck = internalClipboard ? selectionToMarkdownFromPayload(internalClipboard) : null;
  if (internalClipboard && (!text || text.trim() === mdCheck)) {
    pasteNodesIntoBoard(internalClipboard, targetWorld);
    return;
  }
  if (!text.trim()) {
    if (internalClipboard) pasteNodesIntoBoard(internalClipboard, targetWorld);
    return;
  }
  const tree = parseMarkdownTree(text);
  if (tree) {
    const layoutResult = CanvasLayout.compute(tree.nodes, tree.edges, {
      mode: 'right', nodeGap: 24, levelGap: 76, scope: 'board', statuses: board().settings.statuses, obstacles: [],
    });
    for (const n of tree.nodes) {
      const pos = layoutResult.positions.get(n.id);
      if (pos) Object.assign(n, pos);
    }
    const b = boundsOf(tree.nodes);
    const ox = targetWorld.x - (b ? (b.left + b.right) / 2 : 0);
    const oy = targetWorld.y - (b ? (b.top + b.bottom) / 2 : 0);
    for (const n of tree.nodes) {
      n.x = coordinate(n.x + ox);
      n.y = coordinate(n.y + oy);
    }
    applyChange(() => {
      board().nodes.push(...tree.nodes);
      board().edges.push(...tree.edges);
      selection = { kind: 'cards', ids: new Set(tree.nodes.map(n => n.id)) };
    });
    toast(`已自动解析 Markdown 生成 ${tree.nodes.length} 张卡片导图`);
    return;
  }
  const safeUrl = safeExternalUrl(text.trim());
  const node = blankCard(targetWorld);
  if (safeUrl) {
    node.tone = 'reference';
    node.title = new URL(safeUrl).hostname.replace(/^www\./, '');
    node.body = safeUrl;
  } else {
    const lines = text.trim().split(/\r?\n/);
    node.title = lines[0].slice(0, 80);
    node.body = lines.length > 1 ? lines.slice(1).join('\n') : (lines[0].length > 80 ? lines[0] : '');
  }
  applyChange(() => {
    board().nodes.push(node);
    selection = { kind: 'cards', ids: new Set([node.id]) };
  });
  toast('已粘贴新建卡片');
}

function selectionToMarkdownFromPayload(payload) {
  const tempTree = CanvasLayout.tree(payload.nodes, payload.edges);
  const byId = new Map(payload.nodes.map(n => [n.id, n]));
  return formatNodesAsMarkdown(byId, tempTree, payload.statuses, payload.tags);
}

function extractToSubBoard() {
  const current = board();
  const ids = noteIds();
  if (!ids.length) return toast('先选中要提取的卡片或分支');
  const singleRoot = ids.length === 1 ? nodeBy(ids[0]) : null;
  if (singleRoot?.subBoardId && workspace.boards.some(b => b.id === singleRoot.subBoardId)) {
    switchBoard(singleRoot.subBoardId);
    return;
  }
  let movedSet;
  let portalNode;
  if (singleRoot) {
    const subIds = CanvasLayout.subtree(hierarchy, singleRoot.id);
    if (subIds.length <= 1) {
      // Single leaf card: create an empty linked sub-board seeded with a copy of this card
      movedSet = new Set([singleRoot.id]);
      portalNode = singleRoot;
    } else {
      movedSet = new Set(subIds);
      portalNode = singleRoot;
    }
  } else {
    movedSet = new Set(ids);
    portalNode = null;
  }
  const subNameBase = portalNode ? titleOf(portalNode) : titleOf(nodeBy(ids[0])) + ' 子画布';
  const existingNames = new Set(workspace.boards.map(b => b.name));
  let subName = subNameBase;
  for (let i = 2; existingNames.has(subName); i++) subName = `${subNameBase} (${i})`;

  checkpoint(true, false, true);
  const subBoard = CanvasData.makeBoard(subName);
  subBoard.settings.parentId = current.id;
  subBoard.settings.appearance = structuredClone(current.settings.appearance);
  subBoard.settings.statuses = structuredClone(current.settings.statuses);
  subBoard.settings.tags = structuredClone(current.settings.tags);

  const subNodes = current.nodes.filter(n => movedSet.has(n.id)).map(n => {
    const clone = structuredClone(n);
    delete clone.subBoardId;
    return clone;
  });
  const subEdges = current.edges.filter(e => movedSet.has(e.from) && movedSet.has(e.to)).map(e => structuredClone(e));
  subBoard.nodes = subNodes;
  subBoard.edges = subEdges;
  workspace.boards.push(subBoard);

  if (portalNode) {
    const removeIds = new Set([...movedSet].filter(id => id !== portalNode.id));
    portalNode.subBoardId = subBoard.id;
    current.nodes = current.nodes.filter(n => !removeIds.has(n.id));
    current.edges = current.edges.filter(e => !removeIds.has(e.from) && !removeIds.has(e.to));
    current.settings.folded = current.settings.folded.filter(id => !removeIds.has(id));
    for (const frame of current.settings.frames) frame.members = frame.members.filter(id => !removeIds.has(id));
    selection = { kind: 'cards', ids: new Set([portalNode.id]) };
  } else {
    const selectedNodes = current.nodes.filter(n => movedSet.has(n.id));
    const box = boundsOf(selectedNodes);
    const portal = {
      id: CanvasData.uid(),
      x: coordinate(box ? (box.left + box.right) / 2 - 130 : camera.x - 130),
      y: coordinate(box ? (box.top + box.bottom) / 2 - 64 : camera.y - 64),
      w: 260, h: 128, tone: 'topic',
      title: subName, body: `包含 ${subNodes.length} 张卡片的子画布`, subBoardId: subBoard.id,
    };
    const rewired = [];
    const seenPairs = new Set();
    for (const e of current.edges) {
      const fromIn = movedSet.has(e.from);
      const toIn = movedSet.has(e.to);
      if (fromIn && toIn) continue;
      if (!fromIn && !toIn) {
        rewired.push(e);
        const pair = e.from < e.to ? `${e.from}:${e.to}` : `${e.to}:${e.from}`;
        seenPairs.add(pair);
        continue;
      }
      const nf = fromIn ? portal.id : e.from;
      const nt = toIn ? portal.id : e.to;
      if (nf === nt) continue;
      const pair = nf < nt ? `${nf}:${nt}` : `${nt}:${nf}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      rewired.push({ ...e, from: nf, to: nt });
    }
    current.nodes = current.nodes.filter(n => !movedSet.has(n.id));
    current.nodes.push(portal);
    current.edges = rewired;
    current.settings.folded = current.settings.folded.filter(id => !movedSet.has(id));
    for (const frame of current.settings.frames) frame.members = frame.members.filter(id => !movedSet.has(id));
    selection = { kind: 'cards', ids: new Set([portal.id]) };
  }
  current.settings.frames = current.settings.frames.filter(frame => frame.members.length || frame.box);
  render();
  save();
  toast(`已提取到子画布「${subName}」，可按 ${modKey}Z 撤销`);
}

function openLightbox(src, alt) {
  lightboxScale = 1;
  lightboxImage.src = src;
  lightboxImage.alt = alt || '图片预览';
  lightboxImage.style.transform = 'scale(1)';
  $('#lightbox-caption').textContent = (alt || '图片预览') + ' · 滚轮可缩放';
  lightboxDialog.showModal();
}

async function importFile(file) {
  if (!file) return;
  try {
    const incoming = CanvasData.parse(await file.text());
    mergeThemes(incoming.themes);
    const names = new Set(workspace.boards.map(item => item.name));
    const active = incoming.boards.find(item => item.id === incoming.activeId);
    for (const item of incoming.boards) {
      const base = item.name || '未命名画布';
      let unique = base;
      for (let index = 2; names.has(unique); index++) unique = base + ' (' + index + ')';
      names.add(unique);
      item.name = unique;
      item.id = CanvasData.uid();
      workspace.boards.push(item);
    }
    switchBoard(active.id);
    toast('已导入 ' + incoming.boards.length + ' 张画布');
  } catch (error) {
    toast('导入失败。' + error.message, 'error');
  }
}

