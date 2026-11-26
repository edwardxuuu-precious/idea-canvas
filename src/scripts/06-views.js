function foldLabel(node, expanded, count) {
  const action = expanded ? '收起分支' : `展开下一层（${count} 项）`;
  return action + ' · ' + titleOf(node);
}

const CanvasViews = (() => {
  const defaultFrameColor = '#6d9780';
  const frameViews = new Map();
  const validTabs = ['view', 'outline', 'frames'];
  let activeTab = 'view';
  let filter = freshFilter();
  let focused = null;
  let activeFrame = null;
  let dragging = null;
  let dropTarget = null;

  function freshFilter() {
    return { status: '', tag: '', mode: 'dim' };
  }

  function graph() {
    return hierarchy;
  }

  function isFocused() {
    return !!focused && focused.boardId === board().id && !!nodeBy(focused.id);
  }

  function visibility(tree) {
    const current = board();
    const { folded, statuses, tags } = current.settings;
    const hidden = CanvasLayout.foldedDescendants(tree, folded);
    const dimmed = new Set();
    const matched = new Set();
    const status = statuses.some(item => item.id === filter.status) ? filter.status : '';
    const tag = tags.some(item => item.id === filter.tag) ? filter.tag : '';
    const filtering = !!(status || tag);
    if (filtering) {
      const retained = new Set();
      for (const node of current.nodes) {
        if ((status && node.status !== status) || (tag && !node.tags?.includes(tag))) continue;
        matched.add(node.id);
        let id = node.id;
        while (id && !retained.has(id)) {
          retained.add(id);
          id = tree.parent.get(id);
        }
      }
      for (const node of current.nodes) {
        if (retained.has(node.id)) hidden.delete(node.id);
        else if (filter.mode === 'hide') hidden.add(node.id);
        else dimmed.add(node.id);
      }
    }

    if (isFocused() && hidden.has(focused.id)) focused = null;
    if (isFocused()) {
      const branch = new Set(CanvasLayout.subtree(tree, focused.id));
      for (const node of current.nodes) {
        if (!branch.has(node.id)) hidden.add(node.id);
      }
    }

    return { hidden, dimmed, matched, filtering };
  }

  function followOpenedBranch(root, children, fromOutline) {
    const scale = fromOutline ? Math.max(camera.scale, .78) : Math.max(camera.scale, .5);
    const { width, height } = viewportSize();
    const drawer = document.querySelector(':is(#views-panel,#inspector-panel):not([hidden])');
    const left = Math.min(78, width * .115);
    const top = chromeTopLimit();
    const bottom = height - Math.min(82, height * .14);
    const drawerEdge = drawer ? drawer.offsetLeft - 12 : width - 26;
    const rootBounds = boundsOf([root]);
    const firstNear = children.length ? boundsOf([root, children[0]]) : rootBounds;
    const hideOutline = fromOutline && drawer?.id === 'views-panel' && firstNear.w * scale > drawerEdge - left;
    if (hideOutline) {
      close();
      focusCanvas();
    }
    const right = !hideOutline && width > 720 ? drawerEdge : width - 26;
    const spanX = (right - left) / scale;
    const spanY = (bottom - top) / scale;

    const candidates = [];
    for (let k = children.length; k >= 1; k--) candidates.push(boundsOf([root, ...children.slice(0, k)]));
    candidates.push(rootBounds);
    const target = candidates.find(b => b.w <= spanX && b.h <= spanY) || rootBounds;

    const viewLeft = camera.x - width / (2 * scale);
    const viewTop = camera.y - height / (2 * scale);
    const screenLeft = viewLeft + left / scale;
    const screenRight = viewLeft + right / scale;
    const screenTop = viewTop + top / scale;
    const screenBottom = viewTop + bottom / scale;
    const alreadyVisible = scale === camera.scale &&
      target.left >= screenLeft && target.right <= screenRight &&
      target.top >= screenTop && target.bottom <= screenBottom;
    if (alreadyVisible) return;

    function followAxis(start, end, leading, trailing, size, currentCoord) {
      const low = target[end] - (trailing - size / 2) / scale;
      const high = target[start] - (leading - size / 2) / scale;
      return low <= high ? clamp(currentCoord, low, high) : (low + high) / 2;
    }

    animateCamera({
      x: followAxis('left', 'right', left, right, width, camera.x),
      y: followAxis('top', 'bottom', top, bottom, height, camera.y),
      scale,
    }, { duration: 250 });
  }

  function applyBranchPositions(byId, positions) {
    if ([...positions.values()].some(({ x, y }) => x !== coordinate(x) || y !== coordinate(y))) return false;
    let moved = false;
    for (const [id, position] of positions) {
      const node = byId.get(id);
      if (node.x === position.x && node.y === position.y) continue;
      Object.assign(node, position);
      moved = true;
    }
    return moved;
  }

  function toggleFold(id, fromOutline = false, invertSingle = false) {
    const current = board();
    const byId = new Map(current.nodes.map(node => [node.id, node]));
    const root = byId.get(id);
    const tree = graph();
    const children = tree.children.get(id);
    if (!root || !children?.length) return;
    const beforePositions = capturePositions();
    const anchorBefore = { x: root.x, y: root.y };
    const priorLanes = CanvasLayout.branchLanes(tree, byId, current.settings.layout);
    const folded = new Set(current.settings.folded);
    const opening = folded.delete(id);
    const useSingle = invertSingle ? !current.settings.singleBranch : !!current.settings.singleBranch;
    if (opening) {
      for (const child of children) if (tree.children.get(child).length) folded.add(child);
      if (useSingle) {
        const parentId = tree.parent.get(id);
        if (parentId) {
          for (const sibling of tree.children.get(parentId) || []) {
            if (sibling !== id && tree.children.get(sibling)?.length) folded.add(sibling);
          }
        }
      }
    } else folded.add(id);
    const layout = current.settings.layout;
    const rearrange = CanvasLayout.isTreeMode(layout.mode);
    let moved = false;

    applyChange(() => {
      current.settings.folded = [...folded];
      if (!opening && !rearrange) return;
      const { hidden } = visibility(tree);
      const shown = opening ? children.filter(child => !hidden.has(child)) : [];
      for (const child of shown) cardIndex.get(child).element.hidden = false;
      const foldedOut = CanvasLayout.foldedDescendants(tree, current.settings.folded);

      if (rearrange) {
        if (opening) {
          viewport.classList.remove('is-zoomed-out', 'is-overview');
        }
        let topRoot = id;
        while (tree.parent.has(topRoot)) topRoot = tree.parent.get(topRoot);
        const componentIds = new Set(CanvasLayout.subtree(tree, topRoot));
        const treeRootId = layout.rootId && componentIds.has(layout.rootId) && !foldedOut.has(layout.rootId) ? layout.rootId : topRoot;
        const visibleNodes = current.nodes.filter(node => !foldedOut.has(node.id)).map(cardRect);
        const componentNodes = visibleNodes.filter(node => componentIds.has(node.id));
        const externalObstacles = visibleNodes.filter(node => !componentIds.has(node.id));
        const raw = CanvasLayout.compute(componentNodes, current.edges, {
          ...layout, rootId: treeRootId, hierarchy: tree, preferredSides: priorLanes, obstacles: [],
        }).positions;
        const nextAnchor = raw.get(id);
        const dx = nextAnchor ? coordinate(anchorBefore.x - nextAnchor.x) : 0;
        const dy = nextAnchor ? coordinate(anchorBefore.y - nextAnchor.y) : 0;
        const anchored = new Map();
        for (const node of componentNodes) {
          const p = raw.get(node.id);
          if (!p) continue;
          anchored.set(node.id, node.pinned ? { x: node.x, y: node.y } : { x: coordinate(p.x + dx), y: coordinate(p.y + dy) });
        }
        const finalPositions = externalObstacles.length || componentNodes.some(node => node.pinned)
          ? CanvasLayout.avoidFixed(anchored, componentNodes, Math.min(layout.nodeGap, 12), externalObstacles, layout.mode === 'down')
          : anchored;
        moved = applyBranchPositions(byId, finalPositions);
      }
      if (opening && !hidden.has(id)) {
        followOpenedBranch(cardRect(root), shown.map(child => cardRect(byId.get(child))), fromOutline);
      }
    }, { view: opening && !isFocused() });
    if (moved) animatePositions(beforePositions);
  }

  function expandAll() {
    const current = board();
    const { folded, layout } = current.settings;
    if (!folded.length) return;
    const beforePositions = capturePositions();
    const tree = graph();
    const arranged = CanvasLayout.isTreeMode(layout.mode);
    const revealed = arranged ? CanvasLayout.foldedDescendants(tree, folded) : null;
    const anchor = arranged ? layoutAnchor(tree.children, noteIds()) : null;
    let moved = false;
    applyChange(() => {
      current.settings.folded = [];
      if (!revealed?.size) return;
      for (const id of revealed) cardIndex.get(id).element.hidden = false;
      const rects = current.nodes.map(cardRect);
      const roots = CanvasLayout.overlappingRevealRoots(rects, tree, revealed);
      if (!roots.size) return;
      const byId = new Map(current.nodes.map(node => [node.id, node]));
      for (const id of roots) {
        const positions = CanvasLayout.reflowBranch(current.nodes.map(cardRect), tree, id, layout);
        if (applyBranchPositions(byId, positions)) moved = true;
      }
      if (moved && anchor && !visibility(tree).hidden.has(anchor)) followOpenedBranch(cardRect(byId.get(anchor)), [], false);
    }, { view: arranged && !isFocused() });
    if (moved) animatePositions(beforePositions);
  }

  function focus(id = noteIds()[0]) {
    if (!nodeBy(id)) return toast('先选中要查看的分支');
    if (inlineEdit) finishInline({ keepFocus: true });
    if (!isFocused()) focused = { boardId: board().id, id, camera: { ...camera } };
    focused.id = id;
    close();
    if (board().settings.folded.includes(id)) toggleFold(id);
    const tree = graph();
    const { hidden } = visibility(tree);
    const branch = CanvasLayout.subtree(tree, id).filter(member => !hidden.has(member));
    render();
    fitNodes(branch.length ? branch : [id], true, id);
  }

  function renderFocusPath(id) {
    const path = [];
    for (let cursor = id; cursor; cursor = graph().parent.get(cursor)) path.unshift(cursor);
    const crumbs = path.slice(-4);
    const parts = [];
    if (crumbs.length < path.length) parts.push(Object.assign(document.createElement('span'), { className: 'focus-path-sep', textContent: '…' }));
    crumbs.forEach((nodeId, index) => {
      if (parts.length) parts.push(Object.assign(document.createElement('span'), { className: 'focus-path-sep', textContent: '›' }));
      const label = titleOf(nodeBy(nodeId));
      if (index === crumbs.length - 1) {
        parts.push(Object.assign(document.createElement('strong'), { className: 'focus-path-current', textContent: label, title: label }));
        return;
      }
      const crumb = Object.assign(document.createElement('button'), { type: 'button', className: 'focus-path-crumb', textContent: label, title: '只看「' + label + '」' });
      crumb.dataset.viewAction = 'focus-node';
      crumb.dataset.viewId = nodeId;
      parts.push(crumb);
    });
    $('#view-focus-name').replaceChildren(...parts);
  }

  function exitFocus() {
    if (!focused) return false;
    const previous = focused;
    focused = null;
    if (previous.boardId === board().id) {
      render();
      animateCamera(previous.camera, { duration: 240, temporary: true });
    }
    return true;
  }

  function readOptions(select, entries, first, current) {
    const options = [new Option(first, '')];
    for (const entry of entries) options.push(new Option(entry.name, entry.id));
    const value = entries.some(item => item.id === current) ? current : '';
    const changed = select.options.length !== options.length || options.some((item, index) => (
      item.value !== select.options[index].value || item.text !== select.options[index].text
    ));
    if (changed) select.replaceChildren(...options);
    select.value = value;
  }

  function refresh() {
    const current = board();
    if (focused && focused.boardId === current.id && !nodeBy(focused.id)) focused = null;
    const active = isFocused();
    const strip = $('#view-focus-strip');
    strip.hidden = !active;
    if (active) renderFocusPath(focused.id);

    const graphNow = graph();
    const { filtering, matched } = visibility(graphNow);
    const filterStrip = $('#view-filter-strip');
    if (filterStrip) {
      filterStrip.hidden = !filtering;
      if (filtering) $('#view-filter-strip-text').textContent = '筛选中 · 匹配 ' + matched.size + ' 张';
    }

    const panel = $('#views-panel');
    if (panel.hidden) return;
    for (const item of panel.querySelectorAll('[data-view-tab]')) {
      item.setAttribute('aria-selected', String(item.dataset.viewTab === activeTab));
    }
    for (const pane of panel.querySelectorAll('[data-view-pane]')) pane.hidden = pane.dataset.viewPane !== activeTab;

    for (const item of panel.querySelectorAll('[data-view-detail]')) {
      item.setAttribute('aria-pressed', String(item.dataset.viewDetail === current.settings.detail));
    }
    readOptions($('#view-status'), current.settings.statuses, '全部状态', filter.status);
    readOptions($('#view-tag'), current.settings.tags, '全部标签', filter.tag);
    $('#view-filter-mode').value = filter.mode;
    $('#view-filter-summary').textContent = filtering ? '匹配 ' + matched.size + ' 张卡片' : '';
    panel.querySelector('[data-view-action="clear-filter"]').hidden = !filtering;
    panel.querySelector('[data-view-action="focus"]').disabled = noteIds().length !== 1;
    for (const button of panel.querySelectorAll('[data-view-action="expand-all"]')) button.disabled = !current.settings.folded.length;
    const singleBtn = panel.querySelector('[data-view-action="single-branch"]');
    if (singleBtn) singleBtn.setAttribute('aria-pressed', String(!!current.settings.singleBranch));

    if (activeTab === 'outline' && !dragging) renderOutline(graphNow);
    if (activeTab === 'frames') refreshFrames();
  }

  function open(tab = 'view') {
    if (!validTabs.includes(tab)) return;
    activeTab = tab;
    $('#views-panel').hidden = false;
    controls['view-options'].setAttribute('aria-expanded', String(tab !== 'outline'));
    controls.outline.setAttribute('aria-expanded', String(tab === 'outline'));
    refresh();
  }

  function close() {
    $('#views-panel').hidden = true;
    controls['view-options'].setAttribute('aria-expanded', 'false');
    controls.outline.setAttribute('aria-expanded', 'false');
    clearDrag();
  }

  function toggle(tab = 'view') {
    if (!$('#views-panel').hidden && activeTab === tab) close();
    else open(tab);
  }

  function reset() {
    filter = freshFilter();
    focused = null;
    activeFrame = null;
    clearDrag();
  }

  function revealFromOutline(id) {
    const node = nodeBy(id);
    if (!node) return;
    const tree = graph();
    const state = visibility(tree);
    if (state.hidden.has(id)) {
      const ancestors = new Set();
      let parent = tree.parent.get(id);
      while (parent && !ancestors.has(parent)) {
        ancestors.add(parent);
        parent = tree.parent.get(parent);
      }
      if (state.filtering && filter.mode === 'hide') filter = freshFilter();
      const folded = board().settings.folded.filter(item => !ancestors.has(item));
      if (folded.length !== board().settings.folded.length) {
        applyChange(() => { board().settings.folded = folded; });
      } else {
        render();
      }
    }
    setSelected([id]);
    reveal(node, true);
    refresh();
  }

  function control(action, text, label, className, id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.viewAction = action;
    button.dataset.viewId = id;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = text;
    return button;
  }

  function renderOutline(tree) {
    const list = $('#view-outline-list');
    const scroll = list.closest('[data-view-pane]').scrollTop;
    const folded = new Set(board().settings.folded);
    const selectedIds = new Set(noteIds());
    const nodes = new Map(board().nodes.map(node => [node.id, node]));
    const fragment = document.createDocumentFragment();
    const pending = tree.roots.map((id, index) => ({ id, depth: 0, index, count: tree.roots.length })).reverse();
    const active = document.activeElement;
    let toFocus = null;

    while (pending.length) {
      const { id, depth, index, count } = pending.pop();
      const node = nodes.get(id);
      if (!node) continue;
      const row = document.createElement('li');
      row.className = 'canvas-outline-row';
      row.dataset.viewRow = id;
      row.style.setProperty('--view-depth', Math.min(depth, 10));
      if (selectedIds.has(id)) row.setAttribute('aria-current', 'true');
      const children = tree.children.get(id) || [];
      const closed = folded.has(id);

      if (children.length) {
        const fold = control('fold', closed ? '▸' : '▾', foldLabel(node, !closed, children.length), 'canvas-outline-fold', id);
        fold.setAttribute('aria-expanded', String(!closed));
        row.append(fold);
      } else {
        const indent = document.createElement('span');
        indent.className = 'canvas-outline-blank';
        row.append(indent);
      }

      const jump = control('jump', '', '定位 ' + titleOf(node), 'canvas-outline-jump', id);
      const title = document.createElement('span');
      title.textContent = titleOf(node);
      jump.append(title);
      if (closed && children.length) {
        const count = document.createElement('span');
        count.className = 'canvas-outline-count';
        count.textContent = '+' + children.length;
        jump.append(count);
      }
      row.append(jump);

      const shifts = document.createElement('span');
      shifts.className = 'canvas-outline-shifts';
      const parentId = tree.parent.get(id);
      const sibs = parentId ? tree.children.get(parentId) || [] : tree.roots;
      if (parentId) {
        shifts.append(control('outdent', '←', '提升一级', 'canvas-outline-shift', id));
      }
      if (index > 0) {
        shifts.append(control('indent', '→', '缩进为上一项子级', 'canvas-outline-shift', id));
      }
      if (count > 1) {
        const up = control('up', '↑', '上移同级顺序', 'canvas-outline-shift', id);
        const down = control('down', '↓', '下移同级顺序', 'canvas-outline-shift', id);
        up.disabled = index === 0;
        down.disabled = index === count - 1;
        shifts.append(up, down);
      }
      if (shifts.childNodes.length) row.append(shifts);
      const grip = document.createElement('span');
      grip.className = 'canvas-outline-grip';
      grip.dataset.viewDrag = id;
      grip.draggable = true;
      grip.title = '拖动调整层级或同级顺序';
      grip.textContent = '⋮⋮';
      row.append(grip);

      if (active?.dataset.viewId === id) {
        toFocus = Array.from(row.querySelectorAll('button')).find(button => button.dataset.viewAction === active.dataset.viewAction);
        if (toFocus?.disabled) toFocus = jump;
      }
      fragment.append(row);
      if (!closed) {
        for (let i = children.length - 1; i >= 0; i--) pending.push({ id: children[i], depth: depth + 1, index: i, count: children.length });
      }
    }

    if (!fragment.childNodes.length) {
      const placeholder = document.createElement('li');
      placeholder.className = 'canvas-outline-empty';
      placeholder.textContent = '当前画布还没有卡片。';
      fragment.append(placeholder);
    }

    list.replaceChildren(fragment);
    list.closest('[data-view-pane]').scrollTop = scroll;
    if (toFocus) toFocus.focus({ preventScroll: true });
  }

  function siblings(tree, id) {
    const parent = tree.parent.get(id);
    return parent ? tree.children.get(parent) || [] : tree.roots;
  }

  function commitOrder(ids) {
    applyChange(() => {
      ids.forEach((id, index) => { const node = nodeBy(id); if (node) node.order = index; });
    });
  }

  function shift(id, delta) {
    const order = [...siblings(graph(), id)];
    const index = order.indexOf(id);
    const other = index + delta;
    if (index < 0 || other < 0 || other >= order.length) return;
    [order[index], order[other]] = [order[other], order[index]];
    const current = board();
    const before = capturePositions();
    applyChange(() => {
      order.forEach((itemId, idx) => { const node = nodeBy(itemId); if (node) node.order = idx; });
      if (CanvasLayout.isTreeMode(current.settings.layout.mode)) relayoutAround(current, [id]);
    });
    animatePositions(before);
  }

  function clearDrag() {
    if (dragging?.row) dragging.row.classList.remove('is-drag-source');
    if (dropTarget) delete dropTarget.dataset.dropSide;
    dragging = null;
    dropTarget = null;
  }

  function startDrag(event) {
    const grip = event.target.closest('[data-view-drag]');
    if (!grip || !event.dataTransfer) return;
    clearDrag();
    const id = grip.dataset.viewDrag;
    const tree = graph();
    const row = grip.closest('[data-view-row]');
    const blocked = new Set(CanvasLayout.subtree(tree, id));
    dragging = { id, parent: tree.parent.get(id), row, blocked };
    row.classList.add('is-drag-source');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }

  function dragOver(event) {
    if (!dragging) return;
    const row = event.target.closest('[data-view-row]');
    const id = row?.dataset.viewRow;
    if (dropTarget) delete dropTarget.dataset.dropSide;
    dropTarget = null;
    if (!id || id === dragging.id || dragging.blocked.has(id)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropTarget = row;
    const rect = row.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
    row.dataset.dropSide = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
  }

  function setParentEdge(source, newParent) {
    const current = board();
    const tree = graph();
    const oldParent = tree.parent.get(source);
    if (oldParent && oldParent !== newParent) {
      current.edges = current.edges.filter(edge =>
        !(edge.from === oldParent && edge.to === source && (edge.kind === 'branch' || !newParent)));
    }
    if (newParent && oldParent !== newParent) {
      const existing = current.edges.find(edge =>
        (edge.from === newParent && edge.to === source) || (edge.from === source && edge.to === newParent)
      );
      if (existing) {
        existing.from = newParent;
        existing.to = source;
        existing.kind = 'branch';
      } else {
        current.edges.push({ id: CanvasData.uid(), from: newParent, to: source, label: '', kind: 'branch' });
      }
      current.settings.folded = current.settings.folded.filter(id => id !== newParent);
    }
  }

  function relayoutAround(current, anchorIds) {
    const layout = current.settings.layout;
    if (!CanvasLayout.isTreeMode(layout.mode)) return;
    const tree = CanvasLayout.tree(current.nodes, current.edges);
    const foldedOut = CanvasLayout.foldedDescendants(tree, current.settings.folded);
    const visible = current.nodes.filter(node => !foldedOut.has(node.id)).map(cardRect);
    const tops = new Set();
    for (let id of anchorIds) {
      if (!tree.children.has(id)) continue;
      while (tree.parent.has(id)) id = tree.parent.get(id);
      tops.add(id);
    }
    for (const top of tops) {
      const componentIds = new Set(CanvasLayout.subtree(tree, top));
      const componentNodes = visible.filter(node => componentIds.has(node.id));
      if (componentNodes.length < 2) continue;
      const others = visible.filter(node => !componentIds.has(node.id));
      const rootId = layout.rootId && componentIds.has(layout.rootId) && !foldedOut.has(layout.rootId) ? layout.rootId : top;
      const lanes = CanvasLayout.branchLanes(tree, new Map(visible.map(node => [node.id, node])), layout);
      const raw = CanvasLayout.compute(componentNodes, current.edges, {
        ...layout, rootId, hierarchy: tree, preferredSides: lanes, obstacles: [],
      }).positions;
      const placed = others.length
        ? CanvasLayout.avoidFixed(raw, componentNodes, Math.min(layout.nodeGap, 12), others, layout.mode === 'down')
        : raw;
      for (const [id, position] of placed) {
        const node = nodeBy(id);
        if (node && !node.pinned && position.x === coordinate(position.x) && position.y === coordinate(position.y)) Object.assign(node, position);
      }
    }
  }

  function reparentAndOrder(source, newParent, orderedSiblings) {
    const current = board();
    const before = capturePositions();
    const oldParent = graph().parent.get(source);
    applyChange(() => {
      setParentEdge(source, newParent);
      orderedSiblings.forEach((id, idx) => { const node = nodeBy(id); if (node) node.order = idx; });
      relayoutAround(current, [source, newParent, oldParent].filter(Boolean));
    });
    animatePositions(before);
  }

  function adoptAsChildren(ids, targetId, dropped) {
    const current = board();
    const target = nodeBy(targetId);
    const tree = graph();
    if (!target || ids.some(id => CanvasLayout.subtree(tree, id).includes(targetId))) return false;
    const roots = ids.filter(id => !ids.includes(tree.parent.get(id)));
    if (roots.every(id => tree.parent.get(id) === targetId)) return false;
    const before = capturePositions(dropped);
    const preDragCoords = new Map(ids.map(id => {
      const n = nodeBy(id);
      return n ? [id, { x: n.x, y: n.y }] : null;
    }).filter(Boolean));
    const foldedMovedIds = ids.filter(id => current.settings.folded.includes(id));
    const hiddenMoved = foldedMovedIds.length ? CanvasLayout.foldedDescendants(tree, foldedMovedIds) : new Set();
    const oldParents = roots.map(id => tree.parent.get(id)).filter(Boolean);
    applyChange(() => {
      for (const [id, position] of dropped) Object.assign(nodeBy(id), { x: position.x, y: position.y });
      const siblings = (tree.children.get(targetId) || []).filter(id => !roots.includes(id));
      for (const id of roots) setParentEdge(id, targetId);
      [...siblings, ...roots].forEach((id, index) => { const node = nodeBy(id); if (node) node.order = index; });
      if (CanvasLayout.isTreeMode(current.settings.layout.mode)) {
        relayoutAround(current, [targetId, ...oldParents]);
      } else {
        const group = ids.map(nodeBy).filter(Boolean);
        const box = boundsOf(group);
        const anchor = cardRect(target);
        const placedSiblings = siblings.filter(id => !visibility.hidden.has(id)).map(nodeBy).filter(Boolean);
        const below = boundsOf(placedSiblings);
        const left = below ? below.left : anchor.x + anchor.w + 76;
        const top = below ? below.bottom + 24 : anchor.y + anchor.h / 2 - box.h / 2;
        for (const node of group) {
          Object.assign(node, { x: coordinate(node.x + left - box.left), y: coordinate(node.y + top - box.top) });
        }
      }
      if (hiddenMoved.size) {
        const movedHidden = new Set();
        for (const id of foldedMovedIds) {
          const orig = preDragCoords.get(id);
          const nowNode = nodeBy(id);
          if (!orig || !nowNode) continue;
          const dx = nowNode.x - orig.x;
          const dy = nowNode.y - orig.y;
          if (!dx && !dy) continue;
          for (const subId of CanvasLayout.subtree(tree, id)) {
            if (subId === id || !hiddenMoved.has(subId) || preDragCoords.has(subId) || movedHidden.has(subId)) continue;
            movedHidden.add(subId);
            const subNode = nodeBy(subId);
            if (subNode && !subNode.pinned) {
              subNode.x = coordinate(subNode.x + dx);
              subNode.y = coordinate(subNode.y + dy);
            }
          }
        }
      }
    });
    animatePositions(before);
    toast((roots.length > 1 ? `已把 ${roots.length} 张卡片` : '已') + `挂到「${titleOf(target)}」下，可撤销`);
    return true;
  }

  function reparentStep(id, delta) {
    const tree = graph();
    const parentId = tree.parent.get(id);
    if (delta < 0) {
      if (!parentId) return;
      const grandParent = tree.parent.get(parentId) || null;
      const targetSiblings = (grandParent ? tree.children.get(grandParent) || [] : tree.roots).filter(item => item !== id);
      const insertAt = targetSiblings.indexOf(parentId) + 1;
      targetSiblings.splice(insertAt >= 0 ? insertAt : targetSiblings.length, 0, id);
      reparentAndOrder(id, grandParent, targetSiblings);
      return;
    }
    const sibs = parentId ? tree.children.get(parentId) || [] : tree.roots;
    const index = sibs.indexOf(id);
    if (index <= 0) return;
    const newParent = sibs[index - 1];
    const targetSiblings = [...(tree.children.get(newParent) || []).filter(item => item !== id), id];
    reparentAndOrder(id, newParent, targetSiblings);
  }

  function drop(event) {
    if (!dragging) return;
    const row = event.target.closest('[data-view-row]');
    if (!row || row !== dropTarget) return clearDrag();
    event.preventDefault();
    const source = dragging.id;
    const blocked = dragging.blocked;
    const target = row.dataset.viewRow;
    const side = row.dataset.dropSide;
    clearDrag();
    if (blocked?.has(target)) return;
    const tree = graph();
    if (side === 'inside') {
      const targetChildren = (tree.children.get(target) || []).filter(id => id !== source);
      targetChildren.push(source);
      reparentAndOrder(source, target, targetChildren);
      return;
    }
    const newParent = tree.parent.get(target) || null;
    const next = (newParent ? tree.children.get(newParent) || [] : tree.roots).filter(id => id !== source);
    const index = next.indexOf(target);
    if (index < 0) return;
    next.splice(index + (side === 'after' ? 1 : 0), 0, source);
    reparentAndOrder(source, newParent, next);
  }

  function currentFrame() {
    return board().settings.frames.find(frame => frame.id === activeFrame) || null;
  }

  function paddedBounds(members) {
    const box = boundsOf(members);
    if (!box) return null;
    return { x: box.left - 18, y: box.top - 45, w: Math.max(120, box.w + 36), h: Math.max(90, box.h + 64) };
  }

  function unionBox(a, b) {
    if (!a) return b;
    if (!b) return a;
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.w, b.x + b.w);
    const bottom = Math.max(a.y + a.h, b.y + b.h);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  function frameRect(frame, positions = null, hidden = null) {
    const members = frame.members.filter(id => !hidden?.has(id)).map(id => {
      const node = nodeBy(id);
      if (!node) return null;
      const pos = positions?.get(id);
      return pos ? { ...node, ...pos } : node;
    }).filter(Boolean);
    if (hidden && frame.members.length > 0 && !frame.box && !members.length) return null;
    const memberBox = paddedBounds(members);
    return unionBox(frame.box || null, memberBox);
  }

  function addFrame(worldLocation = null) {
    const members = [...new Set(noteIds())].filter(id => !!nodeBy(id));
    const frames = board().settings.frames;
    let number = frames.length + 1;
    let name = '分区 ' + number;
    while (frames.some(frame => frame.name === name)) name = '分区 ' + (++number);
    let box;
    if (members.length) {
      box = paddedBounds(members.map(nodeBy));
    } else {
      const center = worldLocation || { x: camera.x, y: camera.y };
      box = { x: coordinate(center.x - 180), y: coordinate(center.y - 120), w: 360, h: 240 };
    }
    const frame = { id: CanvasData.uid(), name, color: defaultFrameColor, members, box };
    activeFrame = frame.id;
    applyChange(() => { frames.push(frame); });
    open('frames');
    return frame;
  }

  function editFrameName(id) {
    const view = frameViews.get(id);
    const frame = board().settings.frames.find(item => item.id === id);
    if (!view || !frame || view.element.querySelector('.canvas-frame-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'canvas-frame-input';
    input.maxLength = 80;
    input.value = frame.name;
    view.handle.hidden = true;
    view.element.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = saveName => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      input.remove();
      view.handle.hidden = false;
      if (saveName && next) {
        const current = board().settings.frames.find(item => item.id === id);
        if (current && next !== current.name) {
          applyChange(() => { current.name = next; });
        }
      }
    };
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { finish(true); return; }
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('pointerdown', event => event.stopPropagation());
    input.addEventListener('blur', () => finish(true));
  }

  function framesAtPoint(worldPt) {
    const matches = [];
    for (const frame of board().settings.frames) {
      const box = frameRect(frame);
      if (box && worldPt.x >= box.x && worldPt.x <= box.x + box.w && worldPt.y >= box.y && worldPt.y <= box.y + box.h) {
        matches.push(frame);
      }
    }
    return matches;
  }

  function markDropTargets(positions, draggedIds) {
    const targets = new Set();
    if (positions && draggedIds.size) {
      for (const [id, node] of positions) {
        if (!draggedIds.has(id)) continue;
        const rect = cardRect(node);
        const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
        for (const frame of framesAtPoint(center)) targets.add(frame.id);
      }
    }
    for (const [id, view] of frameViews) view.element.classList.toggle('is-drop-target', targets.has(id));
  }

  function syncMembershipAfterDrag(movedNodes, preDragBoxes = null) {
    const frames = board().settings.frames;
    if (!frames.length || !movedNodes.length) return [];
    const changes = [];
    const frameBoxes = preDragBoxes || new Map(frames.map(frame => [frame.id, frameRect(frame)]));
    for (const node of movedNodes) {
      const rect = cardRect(node);
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const insideIds = new Set();
      for (const frame of frames) {
        const box = frameBoxes.get(frame.id);
        if (box && center.x >= box.x && center.x <= box.x + box.w && center.y >= box.y && center.y <= box.y + box.h) {
          insideIds.add(frame.id);
        }
      }
      for (const frame of frames) {
        const wasMember = frame.members.includes(node.id);
        const isInside = insideIds.has(frame.id);
        if (!wasMember && isInside) {
          frame.members.push(node.id);
          frame.box = unionBox(frame.box || frameBoxes.get(frame.id), { x: rect.x - 18, y: rect.y - 45, w: Math.max(120, rect.w + 36), h: Math.max(90, rect.h + 64) });
          changes.push(`已加入「${frame.name}」`);
        } else if (wasMember && !isInside) {
          if (!frame.box) {
            const oldBox = frameBoxes.get(frame.id);
            if (oldBox) frame.box = oldBox;
          }
          frame.members = frame.members.filter(id => id !== node.id);
          changes.push(`已移出「${frame.name}」`);
        }
      }
    }
    return [...new Set(changes)];
  }

  function selectFrame(id) {
    CanvasInspector.close();
    const frame = board().settings.frames.find(item => item.id === id);
    if (!frame) return null;
    activeFrame = id;
    setSelected(frame.members.filter(member => !!nodeBy(member)));
    open('frames');
    return frame;
  }

  function refreshFrames() {
    const frames = board().settings.frames;
    if (!currentFrame()) activeFrame = frames[0]?.id || null;
    const frame = currentFrame();
    const panel = $('#views-panel');
    readOptions($('#view-frame-select'), frames, '选择分区', activeFrame);
    $('#view-frame-edit').hidden = !frame;
    panel.querySelector('[data-view-action="add-frame"]').disabled = !noteIds().length;
    if (!frame) return;
    const name = $('#view-frame-name');
    if (document.activeElement !== name) name.value = frame.name;
    $('#view-frame-color').value = frame.color;
    const frameColor = (frame.color || '').toLowerCase();
    for (const swatch of document.querySelectorAll('[data-frame-swatch]')) {
      swatch.setAttribute('aria-pressed', String(swatch.dataset.frameSwatch.toLowerCase() === frameColor));
    }
    $('#view-frame-summary').textContent = frame.members.filter(member => !!nodeBy(member)).length + ' 张卡片，拖入卡片自动归组，双击名称可改名。';
  }

  function updateFrame(field, value) {
    const frame = currentFrame();
    if (!frame) return;
    if (field === 'name' && !value.trim()) { $('#view-frame-name').value = frame.name; return; }
    if (frame[field] === value) return;
    applyChange(() => { frame[field] = value; });
  }

  function removeFrame() {
    if (!currentFrame()) return;
    const id = activeFrame;
    activeFrame = null;
    applyChange(() => { board().settings.frames = board().settings.frames.filter(frame => frame.id !== id); });
  }

  function renderFrames(positions = null, hidden = new Set(), frameOverride = null) {
    const container = $('#frames');
    const nodes = new Map(board().nodes.map(node => [node.id, node]));
    const frames = board().settings.frames;
    const present = new Set(frames.map(frame => frame.id));
    for (const [id, view] of frameViews) {
      if (present.has(id)) continue;
      view.element.remove();
      frameViews.delete(id);
    }

    for (const frame of frames) {
      if (!frameViews.has(frame.id)) {
        const element = document.createElement('div');
        element.className = 'canvas-frame';
        element.dataset.frame = frame.id;
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'canvas-frame-label';
        handle.dataset.frameHandle = frame.id;
        handle.title = '拖动名称整体移动，双击可改名';
        const resize = document.createElement('button');
        resize.type = 'button';
        resize.className = 'canvas-frame-resize';
        resize.dataset.frameResize = frame.id;
        resize.title = '拖动调整分区大小';
        resize.setAttribute('aria-label', '调整分区大小');
        resize.innerHTML = icon('resize');
        element.append(handle, resize);
        container.append(element);
        frameViews.set(frame.id, { element, handle });
      }
      const { element, handle } = frameViews.get(frame.id);
      element.classList.toggle('is-selected', frame.id === activeFrame && !$('#views-panel').hidden);
      const members = frame.members.filter(id => nodes.has(id) && !hidden.has(id)).map(id => {
        const node = nodes.get(id);
        const position = positions?.get(id);
        return position ? { ...node, ...position } : node;
      });
      const memberBox = paddedBounds(members);
      const isOverride = frameOverride?.id === frame.id;
      const baseBox = isOverride ? frameOverride.box : frame.box;
      const box = unionBox(baseBox || null, isOverride && frameOverride.resize ? null : memberBox);
      const allHidden = frame.members.length > 0 && !frame.box && members.length === 0;
      element.hidden = !box || allHidden;
      if (!box) continue;
      element.style.transform = 'translate(' + box.x + 'px,' + box.y + 'px)';
      element.style.width = box.w + 'px';
      element.style.height = box.h + 'px';
      element.style.setProperty('--frame-tint', frame.color);
      handle.textContent = frame.name;
      handle.setAttribute('aria-label', '分区 ' + frame.name);
    }
  }

  const actions = {
    close,
    'clear-filter': () => { filter = freshFilter(); render(); },
    focus: () => { if (noteIds().length === 1) { focus(noteIds()[0]); focusCanvas(); } },
    'exit-focus': () => { if (inlineEdit) finishInline({ keepFocus: true }); exitFocus(); focusCanvas(); },
    'focus-node': id => { focus(id); focusCanvas(); },
    'expand-all': expandAll,
    'single-branch': () => applyChange(() => { board().settings.singleBranch = !board().settings.singleBranch; }),
    fold: id => toggleFold(id, true),
    jump: revealFromOutline,
    up: id => shift(id, -1),
    down: id => shift(id, 1),
    indent: id => reparentStep(id, 1),
    outdent: id => reparentStep(id, -1),
    'add-frame': () => addFrame(),
    'delete-frame': removeFrame,
    'locate-frame': () => {
      const frame = currentFrame();
      if (!frame) return;
      const members = frame.members.filter(id => !!nodeBy(id));
      setSelected(members);
      if (members.length) fitNodes(members, true);
      else if (frame.box) animateCamera({ x: frame.box.x + frame.box.w / 2, y: frame.box.y + frame.box.h / 2, scale: Math.max(camera.scale, .8) }, { duration: 240 });
      refresh();
    },
  };

  function mount() {
    const panel = $('#views-panel');
    const listener = event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.frameSwatch) {
        updateFrame('color', button.dataset.frameSwatch);
        return;
      }
      if (button.dataset.viewTab) return open(button.dataset.viewTab);
      const detail = button.dataset.viewDetail;
      if (detail && board().settings.detail !== detail) {
        applyChange(() => { board().settings.detail = detail; });
        return;
      }
      actions[button.dataset.viewAction]?.(button.dataset.viewId);
    };
    panel.addEventListener('click', listener);
    $('#view-focus-strip').addEventListener('click', listener);
    $('#view-filter-strip')?.addEventListener('click', listener);
    panel.addEventListener('change', event => {
      const { id, value } = event.target;
      switch (id) {
        case 'view-status': filter.status = value; render(); break;
        case 'view-tag': filter.tag = value; render(); break;
        case 'view-filter-mode': filter.mode = value; render(); break;
        case 'view-frame-select': activeFrame = value || null; refreshFrames(); break;
        case 'view-frame-name': updateFrame('name', value.trim()); break;
        case 'view-frame-color': updateFrame('color', value); break;
      }
    });
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isFocused()) {
        event.preventDefault();
        event.stopPropagation();
        exitFocus();
        focusCanvas();
      }
    });
    $('#frames').addEventListener('click', event => {
      const id = event.target.closest('[data-frame-handle]')?.dataset.frameHandle;
      if (id && event.detail === 0) selectFrame(id);
    });
    const outline = $('#view-outline-list');
    outline.addEventListener('dragstart', startDrag);
    outline.addEventListener('dragover', dragOver);
    outline.addEventListener('drop', drop);
    outline.addEventListener('dragend', clearDrag);
  }

  return {
    mount, open, close, toggle, refresh, reset, visibility, expandAll, adoptAsChildren,
    toggleFold, focus, exitFocus, isFocused, addFrame, selectFrame, renderFrames, revealFromOutline,
    editFrameName, frameRect, markDropTargets, syncMembershipAfterDrag, removeFrameById: id => {
      if (activeFrame === id) activeFrame = null;
      applyChange(() => { board().settings.frames = board().settings.frames.filter(frame => frame.id !== id); });
    },
  };
})();

