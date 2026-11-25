function cardUnder(event) {
  return document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-card]')?.dataset.card || null;
}

function beginPointer(event) {
  closeContextMenu();
  if (inlineEdit) {
    if (inlineEdit.element.contains(event.target)) return;
    finishInline({ keepFocus: true });
  }
  if (event.button > 2 || modalOpen() || layoutDraft ||
      event.target.closest('[data-card-fold],[data-card-status],[data-card-check],[data-subboard],a[href],.canvas-frame-input')) return;
  const here = point(event);
  lastPointerLocal = here;
  if (event.pointerType === 'touch') {
    touches.set(event.pointerId, here);
    const fingers = [...touches.values()];
    if (fingers.length >= 2) {
      if (fingers.length === 2) {
        cancelCameraAnimation();
        cancelGesture();
        const center = midpoint(...fingers);
        gesture = { kind: 'pinch', anchor: worldPoint(center), distance: Math.max(1, Math.hypot(fingers[1].x - fingers[0].x, fingers[1].y - fingers[0].y)), scale: camera.scale };
      }
      event.preventDefault();
      return;
    }
  }
  if (gesture) return;
  closePopover();
  closeSelectionSubPopovers();
  focusCanvas();
  const cardId = event.target.closest('[data-card]')?.dataset.card;
  const edgeId = event.target.closest('[data-edge]')?.dataset.edge;
  const handleEl = event.target.closest('[data-handle]');
  const handle = handleEl?.dataset.handle;
  const base = { pointerId: event.pointerId, start: here, moved: false };
  const pan = spaceHeld || mode === 'hand' || event.button === 1;
  if (pan) {
    cancelCameraAnimation();
    panVelocity = { vx: 0, vy: 0, t: performance.now(), x: here.x, y: here.y };
    gesture = { ...base, kind: 'pan', camera: { ...camera } };
    event.preventDefault();
    return;
  }
  if (event.button === 2) return;
  if (mode === 'link') {
    gesture = { ...base, kind: 'link-tap', id: cardId };
    event.preventDefault();
    return;
  }
  const frameResizeId = event.target.closest('[data-frame-resize]')?.dataset.frameResize;
  if (frameResizeId) {
    CanvasInspector.close();
    const frame = CanvasViews.selectFrame(frameResizeId);
    const startBox = frame ? CanvasViews.frameRect(frame) : null;
    if (!frame || !startBox) return;
    gesture = { ...base, kind: 'frame-resize', frameId: frameResizeId, startBox };
    event.preventDefault();
    return;
  }
  const frameId = event.target.closest('[data-frame-handle]')?.dataset.frameHandle;
  if (frameId) {
    CanvasInspector.close();
    const frame = CanvasViews.selectFrame(frameId);
    if (!frame) return;
    gesture = {
      ...base, kind: 'drag', keepGroup: true, frame: frameId,
      startBox: frame.box ? { ...frame.box } : null,
      nodes: new Map(frame.members.map(id => [id, nodeBy(id)]).filter(([, node]) => !!node)),
    };
    event.preventDefault();
    return;
  }
  if (cardId) {
    const node = nodeBy(cardId);
    const ids = new Set(noteIds());
    if (handle === 'link') {
      setSelected([cardId]);
      gesture = { ...base, kind: 'port', from: cardId, portSide: handleEl.dataset.portSide || null };
      event.preventDefault();
      return;
    }
    if (handle === 'resize') {
      setSelected([cardId]);
      gesture = { ...base, kind: 'resize', width: cardRect(node).w, nodes: new Map([[cardId, node]]) };
      event.preventDefault();
      return;
    }
    if (event.shiftKey) {
      if (ids.has(cardId)) ids.delete(cardId);
      else ids.add(cardId);
      setSelected(ids);
      if (!ids.has(cardId)) return;
    } else if (!ids.has(cardId)) {
      setSelected([cardId]);
    }
    const { layout, guides, statuses } = board().settings;
    const matrix = CanvasLayout.matrixTracks(layout, guides, statuses);
    gesture = {
      ...base, kind: 'drag', id: cardId, keepGroup: event.shiftKey,
      nodes: new Map(noteIds().map(id => [id, nodeBy(id)])),
      matrix: matrix && { ...matrix, boardId: board().id },
    };
    event.preventDefault();
    return;
  }
  if (edgeId) {
    setSelected([], edgeId);
    gesture = { ...base, kind: 'edge', id: edgeId };
    event.preventDefault();
    return;
  }
  const prior = event.shiftKey ? new Set(noteIds()) : new Set();
  setSelected(prior);
  gesture = event.pointerType === 'touch'
    ? { ...base, kind: 'pan', camera: { ...camera }, blank: true }
    : { ...base, kind: 'marquee', prior };
  event.preventDefault();
}

function previewLink(id, local, target = null, forceRight = false, startSide = null) {
  const from = cardRect(nodeBy(id));
  const here = worldPoint(local);
  const to = target ? cardRect(nodeBy(target)) : { x: here.x, y: here.y, w: 0, h: 0 };
  preview.setAttribute('d', linkCurve(from, to, forceRight, 'curve', undefined, startSide).path);
  preview.hidden = false;
}

function updateDrag(active, dx, dy) {
  const positions = new Map();
  const dirtyIds = new Set(active.nodes.keys());
  for (const [id, node] of active.nodes) {
    const changed = active.kind === 'resize'
      ? { ...node, w: dx === 0 ? node.w : clamp(active.width + dx, 64, 1e6) }
      : { ...node, x: coordinate(node.x + dx), y: coordinate(node.y + dy) };
    positions.set(id, changed);
    const view = cardIndex.get(id);
    if (view) {
      if (active.kind === 'resize') view.size = null;
      if (active.kind === 'drag') view.element.classList.add('is-dragging');
      placeCard(view.element, changed);
    }
  }
  active.positions = positions;
  let frameOverride = null;
  if (active.frame && active.startBox) {
    active.movedBox = {
      ...active.startBox,
      x: coordinate(active.startBox.x + dx),
      y: coordinate(active.startBox.y + dy),
    };
    frameOverride = { id: active.frame, box: active.movedBox };
  }
  renderEdges(positions, dirtyIds);
  CanvasViews.renderFrames(positions, visibility.hidden, frameOverride);
  if (active.kind === 'drag' && !active.matrix) {
    paintSnapLines(active.snap?.lines);
    if (!active.frame) CanvasViews.markDropTargets(positions, dirtyIds);
  }
  positionSelectionBar();
  scheduleMap();
}

function matrixTargetAt(tracks, event) {
  if (!tracks || !viewport.contains(document.elementFromPoint(event.clientX, event.clientY))) return null;
  const { x, y } = worldPoint(point(event));
  const row = matrixTrackAt(tracks.rows, y);
  const column = matrixTrackAt(tracks.columns, x);
  return row?.value !== undefined && column?.value !== undefined ? { row, column } : null;
}

function paintMatrixDrop(target) {
  const layer = $('#matrix-drop-layer');
  const hint = $('#matrix-drop-hint');
  if (!target) {
    layer.replaceChildren();
    if (hint.hasAttribute('data-target')) {
      hint.removeAttribute('data-target');
      hint.textContent = matrixDropHint;
    }
    return;
  }
  const { row, column } = target;
  layer.replaceChildren(svg('rect', {
    x: column.start, y: row.start, width: column.end - column.start, height: row.end - row.start,
    class: 'matrix-drop-cell',
  }));
  hint.setAttribute('data-target', '');
  hint.textContent = '松手移到「' + row.name + '」行和「' + column.name + '」列';
}

function finishMatrixDrag(active, target) {
  const current = board();
  if (!target) return render();
  const { layout, statuses } = current.settings;
  const { row, column } = target;
  const edits = new Map();
  const placing = new Set();
  for (const node of current.nodes) {
    if (!active.nodes.has(node.id)) continue;
    const draft = CanvasLayout.reclassifyCard(node, target, statuses);
    if (draft !== node) edits.set(node.id, draft);
    const { x, y, w, h } = cardRect(node);
    if (draft !== node || x < column.start || x + w > column.end || y < row.start || y + h > row.end) placing.add(node.id);
  }
  if (!placing.size) return render();
  const draftNodes = current.nodes.map(node => edits.get(node.id) || node);
  renderCards(draftNodes);
  const layoutNodes = draftNodes.map(node => node.pinned && placing.has(node.id) ? { ...node, pinned: false } : node);
  const ids = new Set(layoutNodes.map(node => node.id));
  const options = { ...layout };
  const scope = 'board';
  const result = calculateLayout(ids, options, scope, layoutNodes);
  if (!result) return render();
  applyLayout(ids, { scope, options, result, edits });
}

function updateMarquee(active, end) {
  const { start, prior } = active;
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  Object.assign(box.style, {
    left: left + 'px', top: top + 'px', width: (right - left) + 'px', height: (bottom - top) + 'px',
  });
  box.hidden = false;
  const a = worldPoint({ x: left, y: top });
  const b = worldPoint({ x: right, y: bottom });
  const ids = board().nodes.filter(node => {
    if (visibility.hidden.has(node.id)) return false;
    const { x, y, w, h } = cardRect(node);
    return x < b.x && y < b.y && x + w > a.x && y + h > a.y;
  });
  setSelected([...prior, ...ids.map(node => node.id)]);
}

function movePointer(event) {
  const here = point(event);
  lastPointerLocal = here;
  if (touches.has(event.pointerId)) touches.set(event.pointerId, here);
  if (gesture?.kind === 'pinch') {
    const fingers = [...touches.values()].slice(0, 2);
    if (fingers.length < 2) return;
    const distance = Math.hypot(fingers[1].x - fingers[0].x, fingers[1].y - fingers[0].y);
    zoomTo(gesture.scale * distance / gesture.distance, midpoint(...fingers), gesture.anchor);
    return;
  }
  if (!gesture) {
    if (mode === 'link' && linkSource && !spaceHeld) previewLink(linkSource, here, cardUnder(event));
    return;
  }
  const active = gesture;
  if (active.pointerId !== event.pointerId) return;
  const dx = here.x - active.start.x;
  const dy = here.y - active.start.y;
  if (!active.moved && (active.kind === 'resize' ? Math.abs(dx) : Math.hypot(dx, dy)) < 4) return;
  if (!active.moved) {
    active.moved = true;
    viewport.setPointerCapture(event.pointerId);
    paintMode();
  }
  if (active.kind === 'pan') {
    const now = performance.now();
    const dt = now - panVelocity.t;
    if (dt > 0 && dt < 90) {
      const vx = (here.x - panVelocity.x) / dt;
      const vy = (here.y - panVelocity.y) / dt;
      panVelocity.vx = panVelocity.vx * 0.45 + vx * 0.55;
      panVelocity.vy = panVelocity.vy * 0.45 + vy * 0.55;
    } else if (dt >= 90) {
      panVelocity.vx = 0;
      panVelocity.vy = 0;
    }
    panVelocity.t = now;
    panVelocity.x = here.x;
    panVelocity.y = here.y;
    setCamera(active.camera.x - dx / camera.scale, active.camera.y - dy / camera.scale);
  } else if (active.kind === 'frame-resize') {
    active.nextBox = {
      x: active.startBox.x,
      y: active.startBox.y,
      w: clamp(active.startBox.w + dx / camera.scale, 160, 1e6),
      h: clamp(active.startBox.h + dy / camera.scale, 110, 1e6),
    };
    CanvasViews.renderFrames(null, visibility.hidden, { id: active.frameId, box: active.nextBox });
  } else if (active.kind === 'drag' || active.kind === 'resize') {
    let worldDx = dx / camera.scale;
    let worldDy = dy / camera.scale;
    active.snap = null;
    if (active.kind === 'drag' && !active.matrix && !event.altKey) {
      active.snap = alignmentSnap(active, worldDx, worldDy);
      worldDx += active.snap.dx;
      worldDy += active.snap.dy;
    }
    updateDrag(active, worldDx, worldDy);
    if (active.kind === 'drag' && !active.matrix && !active.frame) trackDropParent(active, event);
    if (active.matrix) {
      const target = matrixTargetAt(active.matrix, event);
      if (active.target?.row !== target?.row || active.target?.column !== target?.column) {
        active.target = target;
        paintMatrixDrop(target);
      }
    }
  } else if (active.kind === 'marquee') {
    updateMarquee(active, here);
  } else if (active.kind === 'port') {
    const target = cardUnder(event);
    const candidate = target !== active.from ? target : null;
    for (const [id, view] of cardIndex) view.element.classList.toggle('link-target', id === candidate);
    previewLink(active.from, here, candidate, !active.portSide, active.portSide);
  }
}

function dropParentCandidate(active, event) {
  active.blockedParents ??= new Set([...active.nodes.keys()].flatMap(id => CanvasLayout.subtree(hierarchy, id)));
  for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
    const id = element.closest?.('[data-card]')?.dataset.card;
    if (!id || active.nodes.has(id)) continue;
    return active.blockedParents.has(id) ? null : id;
  }
  return null;
}

function setDropParent(active, id) {
  if (active.dropParent === id) return;
  if (active.dropParent) cardIndex.get(active.dropParent)?.element.classList.remove('is-drop-parent');
  active.dropParent = id;
  if (id) cardIndex.get(id)?.element.classList.add('is-drop-parent');
}

function trackDropParent(active, event) {
  const id = dropParentCandidate(active, event);
  if (id === active.hoverParent) return;
  active.hoverParent = id;
  clearTimeout(active.hoverTimer);
  setDropParent(active, null);
  if (id) active.hoverTimer = setTimeout(() => {
    if (gesture === active && active.hoverParent === id) setDropParent(active, id);
  }, 350);
}

function clearDropParent(active) {
  if (!active) return;
  clearTimeout(active.hoverTimer);
  setDropParent(active, null);
}

function touchTap(event, id, local) {
  if (event.pointerType !== 'touch' || mode !== 'select') return;
  const now = performance.now();
  const last = lastTouchTap;
  if (last && now - last.time < 340 && last.id === id && Math.hypot(local.x - last.x, local.y - last.y) < 22) {
    lastTouchTap = null;
    if (id) openNote(nodeBy(id));
    else openNote(blankCard(worldPoint(local)), true);
  } else {
    lastTouchTap = { ...local, id, time: now };
  }
}

function endPointer(event) {
  touches.delete(event.pointerId);
  const active = gesture;
  if (!active) return;
  const canceled = event.type === 'pointercancel';
  if (active.kind === 'pinch') {
    const remaining = [...touches.entries()];
    if (remaining.length >= 2) {
      const center = midpoint(remaining[0][1], remaining[1][1]);
      gesture = { kind: 'pinch', anchor: worldPoint(center), scale: camera.scale,
        distance: Math.max(1, Math.hypot(remaining[1][1].x - remaining[0][1].x, remaining[1][1].y - remaining[0][1].y)) };
    } else {
      gesture = null;
    }
    return;
  }
  if (active.pointerId !== event.pointerId) return;
  if (canceled) {
    cancelGesture();
    return;
  }
  let matrixTarget = null;
  if (active.positions && active.matrix?.boardId === board().id) {
    const { layout, guides, statuses } = board().settings;
    matrixTarget = matrixTargetAt(CanvasLayout.matrixTracks(layout, guides, statuses), event);
  }
  gesture = null;
  const dropParent = active.dropParent;
  clearDropParent(active);
  if (active.nodes) for (const id of active.nodes.keys()) cardIndex.get(id)?.element.classList.remove('is-dragging');
  $('#alignment-layer').replaceChildren();
  CanvasViews.markDropTargets(null, new Set());
  if (active.matrix) paintMatrixDrop(null);
  paintMode();
  box.hidden = true;
  const here = point(event);
  if (active.moved) suppressClickUntil = performance.now() + 180;
  if (active.kind === 'pan' && active.moved) {
    dismissIdleTip();
    const age = performance.now() - panVelocity.t;
    const speed = age < 75 ? Math.hypot(panVelocity.vx, panVelocity.vy) : 0;
    if (speed > 0.25 && !prefersReducedMotion()) {
      let vx = clamp(panVelocity.vx, -3.5, 3.5);
      let vy = clamp(panVelocity.vy, -3.5, 3.5);
      let last = performance.now();
      const glide = now => {
        const dt = clamp(now - last, 4, 32);
        last = now;
        const factor = Math.pow(0.90, dt / 16);
        vx *= factor;
        vy *= factor;
        if (Math.hypot(vx, vy) < 0.04) {
          panInertiaFrame = 0;
          setCamera(camera.x, camera.y);
          return;
        }
        camera = { x: coordinate(camera.x - vx * dt / camera.scale), y: coordinate(camera.y - vy * dt / camera.scale), scale: camera.scale };
        paintView();
        panInertiaFrame = requestAnimationFrame(glide);
      };
      panInertiaFrame = requestAnimationFrame(glide);
    }
    return;
  }
  if (active.kind === 'frame-resize' && active.nextBox) {
    const frame = board().settings.frames.find(f => f.id === active.frameId);
    if (frame) {
      checkpoint();
      frame.box = active.nextBox;
      frame.members = board().nodes.filter(node => {
        const rect = cardRect(node);
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        return cx >= active.nextBox.x && cx <= active.nextBox.x + active.nextBox.w &&
               cy >= active.nextBox.y && cy <= active.nextBox.y + active.nextBox.h;
      }).map(n => n.id);
      render();
      save();
    }
    return;
  }
  if (active.positions) {
    if (active.matrix) return finishMatrixDrag(active, matrixTarget);
    if (dropParent && active.kind === 'drag' && CanvasViews.adoptAsChildren([...active.positions.keys()], dropParent, active.positions)) return;
    checkpoint();
    for (const [id, update] of active.positions) Object.assign(nodeBy(id), update);
    if (active.frame && active.movedBox) {
      const frame = board().settings.frames.find(f => f.id === active.frame);
      if (frame) frame.box = active.movedBox;
    }
    let frameMessages = [];
    if (active.kind === 'drag' && !active.frame && active.moved) {
      frameMessages = CanvasViews.syncMembershipAfterDrag([...active.positions.keys()].map(nodeBy).filter(Boolean));
    }
    render();
    save();
    if (frameMessages.length) toast(frameMessages.slice(0, 2).join(' · '));
  } else if (active.kind === 'drag' && !active.moved) {
    if (!active.keepGroup) setSelected([active.id]);
    if (!active.frame) touchTap(event, active.id, here);
  } else if (active.kind === 'pan' && active.blank && !active.moved) {
    touchTap(event, null, here);
  } else if (active.kind === 'link-tap' && active.id && !active.moved) {
    if (linkSource && linkSource !== active.id) connect(linkSource, active.id);
    else {
      linkSource = active.id;
      setSelected([linkSource]);
    }
  } else if (active.kind === 'port') {
    for (const view of cardIndex.values()) view.element.classList.remove('link-target');
    preview.hidden = true;
    const target = cardUnder(event);
    if (active.moved && target && target !== active.from) connect(active.from, target);
    else if (active.moved && !target && viewport.contains(document.elementFromPoint(event.clientX, event.clientY))) {
      const parent = nodeBy(active.from);
      openInline(blankCard(worldPoint(here), parent), { isNew: true, parent });
    } else if (!active.moved) {
      setMode('link');
      linkSource = active.from;
      renderSelection();
    }
  }
}

function cancelGesture() {
  const active = gesture;
  gesture = null;
  clearDropParent(active);
  if (active?.nodes) for (const id of active.nodes.keys()) cardIndex.get(id)?.element.classList.remove('is-dragging');
  CanvasViews.markDropTargets(null, new Set());
  if (active?.positions || active?.kind === 'frame-resize') render();
  if (active?.kind === 'marquee') setSelected(active.prior);
  if (active?.matrix) paintMatrixDrop(null);
  $('#alignment-layer').replaceChildren();
  box.hidden = true;
  preview.hidden = true;
  for (const view of cardIndex.values()) view.element.classList.remove('link-target');
  paintMode();
}

function nudge(key, shift) {
  const amount = shift ? 16 : 2;
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const [x, y] = directions[key];
  const ids = noteIds();
  if (!ids.length) {
    setCamera(camera.x + x * 42 / camera.scale, camera.y + y * 42 / camera.scale);
    return;
  }
  checkpoint();
  for (const id of ids) {
    const node = nodeBy(id);
    node.x = coordinate(node.x + x * amount);
    node.y = coordinate(node.y + y * amount);
  }
  render();
  queueSave();
}

const arrowVectors = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function navigateSelection(key, extend) {
  const ids = noteIds();
  const from = ids.length ? nodeBy(ids.at(-1)) : null;
  if (!from) return nudge(key, false);
  const [dirX, dirY] = arrowVectors[key];
  const origin = cardRect(from);
  const originX = origin.x + origin.w / 2;
  const originY = origin.y + origin.h / 2;
  let best = null;
  for (const node of board().nodes) {
    if (node.id === from.id || visibility.hidden.has(node.id)) continue;
    const rect = cardRect(node);
    const offsetX = rect.x + rect.w / 2 - originX;
    const offsetY = rect.y + rect.h / 2 - originY;
    const along = offsetX * dirX + offsetY * dirY;
    const across = Math.abs(offsetX * dirY - offsetY * dirX);
    if (along <= 4 || across > along * 2.2) continue;
    const score = along + across * 2;
    if (!best || score < best.score) best = { id: node.id, score };
  }
  if (!best) return;
  setSelected(extend ? [...ids.filter(id => id !== best.id), best.id] : [best.id]);
  reveal(nodeBy(best.id));
}

const action = {
  boards: () => togglePopover('boards'),
  files: () => togglePopover('files'),
  search: () => togglePopover('search'),
  'align-menu': () => toggleSelectionSubPopover('align'),
  'selection-more': () => toggleSelectionSubPopover('more'),
  'new-card': () => { dismissIdleTip(); openInline(blankCard(), { isNew: true }); },
  'mode-select': () => { setMode('select'); focusCanvas(); },
  'mode-hand': () => { setMode('hand'); focusCanvas(); },
  'mode-link': () => { setMode(mode === 'link' ? 'select' : 'link'); focusCanvas(); },
  undo: () => undoRedo('undo'),
  redo: () => undoRedo('redo'),
  arrange: () => openLayout(),
  'auto-arrange': autoArrange,
  inspector: () => { cancelLayout(); CanvasViews.close(); CanvasInspector.toggle(); },
  'view-options': () => { cancelLayout(); CanvasInspector.close(); CanvasViews.toggle('view'); },
  outline: () => { cancelLayout(); CanvasInspector.close(); CanvasViews.toggle('outline'); },
  'branch-layout': () => openLayout('branch'),
  'pin-layout': () => {
    const nodes = noteIds().map(nodeBy).filter(Boolean);
    if (!nodes.length) return;
    const pinned = nodes.some(node => !node.pinned);
    applyChange(() => { for (const node of nodes) node.pinned = pinned; });
    toast(pinned ? '已固定所选节点的整理位置' : '已解除位置固定');
  },
  'focus-branch': () => CanvasViews.focus(),
  'frame-add': () => { CanvasInspector.close(); CanvasViews.addFrame(); },
  'dock-frame': () => {
    CanvasInspector.close();
    const loc = noteIds().length ? null : { x: camera.x, y: camera.y };
    CanvasViews.addFrame(loc);
  },
  'toggle-dark': () => {
    const current = board();
    const dark = isDarkHex(current.settings.appearance.background);
    applyChange(() => {
      current.settings.appearance = dark
        ? CanvasData.newAppearance()
        : {
          background: '#101216', grid: 'dots', gridColor: '#334155', gridSize: 24, accent: '#10b981',
          card: {}, branch: { color: '#475569' }, link: { color: '#64748b' },
        };
    });
    toast(dark ? '已切换为晨雾纸白浅色外观' : '已切换为静谧夜色深色外观');
    focusCanvas();
  },
  'extract-subboard': extractToSubBoard,
  'copy-markdown': copySelectionAsMarkdown,
  'board-new': () => openText('board-new'),
  'board-rename': () => openText('board-rename', board().name),
  'board-delete': deleteBoard,
  'edit-selected': editSelection,
  'branch-selected': () => addBranch(),
  duplicate: duplicateSelected,
  remove: removeSelected,
  'zoom-in': () => { zoomTo(camera.scale * 1.22, null, null, { animate: true }); focusCanvas(); },
  'zoom-out': () => { zoomTo(camera.scale / 1.22, null, null, { animate: true }); focusCanvas(); },
  'zoom-reset': () => { zoomTo(1, null, null, { animate: true }); focusCanvas(); },
  fit: () => { fitView(); focusCanvas(); },
  'toggle-map': () => {
    const map = $('#map-panel');
    map.hidden = !map.hidden;
    $('#open-map').hidden = !map.hidden;
    scheduleMap();
    focusCanvas();
  },
  'export-html': () => download('html'),
  'export-json': () => download('json'),
  'export-png': () => exportBoard('png'),
  'export-svg': () => exportBoard('svg'),
  'export-markdown': () => exportBoard('md'),
  'data-folder': () => desktop?.postMessage({ operation: 'data-folder' }),
  'backups-folder': () => desktop?.postMessage({ operation: 'backups-folder' }),
  'sync-link': () => desktop?.postMessage({ operation: 'sync-link' }),
  'sync-copy': saveConflictCopy,
  'import-json': () => { closePopover(); $('#file-input').click(); },
  'close-note': finishNote,
  'close-text': () => textDialog.close(),
  'close-lightbox': () => lightboxDialog.close(),
  help: () => helpDialog.showModal(),
  'close-help': () => helpDialog.close(),
};

const layoutSafeActions = new Set(['arrange', 'fit', 'zoom-in', 'zoom-out', 'zoom-reset', 'toggle-map']);

function runAction(name, run = action[name]) {
  if (layoutDraft && !layoutSafeActions.has(name)) cancelLayout();
  if (openPopover && !['boards', 'files', 'search'].includes(name)) closePopover();
  if (openSelectionSubPopover && !['align-menu', 'selection-more'].includes(name)) closeSelectionSubPopovers();
  run();
}

function closeContextMenu() {
  if (contextMenu.hidden) return;
  contextMenu.hidden = true;
  contextMenu.replaceChildren();
}

function addContextItem(label, handler, { shortcut = '', danger = false } = {}) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'menu-item' + (danger ? ' btn-danger' : '');
  item.setAttribute('role', 'menuitem');
  const span = document.createElement('span');
  span.textContent = label;
  item.append(span);
  if (shortcut) {
    const kbd = document.createElement('kbd');
    kbd.textContent = shortcut;
    item.append(kbd);
  }
  item.addEventListener('click', () => {
    closeContextMenu();
    handler();
  });
  contextMenu.append(item);
}

function addContextDivider() {
  const div = document.createElement('div');
  div.className = 'menu-divider';
  contextMenu.append(div);
}

function openContextMenu(event) {
  if (modalOpen() || layoutDraft || inlineEdit) return;
  event.preventDefault();
  closePopover();
  closeContextMenu();
  const cardId = event.target.closest('[data-card]')?.dataset.card;
  const edgeId = event.target.closest('[data-edge]')?.dataset.edge;
  const frameId = event.target.closest('[data-frame-handle]')?.dataset.frameHandle;
  const here = point(event);
  lastPointerLocal = here;
  const hereWorld = worldPoint(here);

  if (cardId) {
    if (!noteIds().includes(cardId)) setSelected([cardId]);
    const selectedNodes = noteIds().map(nodeBy).filter(Boolean);
    const single = selectedNodes.length === 1 ? selectedNodes[0] : null;
    if (single) {
      if (single.subBoardId && workspace.boards.some(b => b.id === single.subBoardId)) {
        addContextItem('进入子画布', () => switchBoard(single.subBoardId));
      }
      addContextItem('原位编辑', () => openInline(single), { shortcut: '双击' });
      addContextItem('大窗富文本 / 插图编辑', () => openNote(single));
      addContextItem('添加子分支', () => addBranch(false), { shortcut: 'Tab' });
      addContextItem('添加同级卡片', () => addBranch(true), { shortcut: 'Enter' });
      addContextDivider();
    }
    const toneRow = document.createElement('div');
    toneRow.className = 'context-tones';
    const toneLabel = document.createElement('span');
    toneLabel.className = 'context-tones-label';
    toneLabel.textContent = '卡片类型';
    const dots = document.createElement('div');
    dots.className = 'context-tone-dots';
    const commonTone = selectedNodes.every(n => n.tone === selectedNodes[0].tone) ? selectedNodes[0].tone : '';
    for (const [key, info] of Object.entries(CanvasData.tone)) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'context-tone-dot';
      dot.title = info.label;
      dot.setAttribute('aria-label', info.label);
      dot.setAttribute('aria-pressed', String(key === commonTone));
      dot.style.background = colors[key];
      dot.addEventListener('click', () => {
        closeContextMenu();
        applyChange(() => { for (const n of selectedNodes) n.tone = key; });
      });
      dots.append(dot);
    }
    toneRow.append(toneLabel, dots);
    contextMenu.append(toneRow);
    addContextDivider();
    if (!single?.subBoardId) addContextItem('提取为子画布', extractToSubBoard);
    addContextItem('复制为 Markdown（给 AI）', copySelectionAsMarkdown, { shortcut: modKey + '⇧C' });
    addContextItem('复制卡片', () => copySelectionToClipboard(false), { shortcut: modKey + 'C' });
    addContextItem('建立分区', () => CanvasViews.addFrame());
    const allPinned = selectedNodes.every(n => n.pinned);
    addContextItem(allPinned ? '解除位置固定' : '整理时固定位置', action['pin-layout']);
    addContextDivider();
    addContextItem('删除', removeSelected, { shortcut: 'Del', danger: true });
  } else if (edgeId) {
    setSelected([], edgeId);
    const edge = edgeBy(edgeId);
    addContextItem('编辑连线说明', () => openText('edge', edge.label, edge.id));
    const currentStyle = edgeStyle(edge);
    addContextItem(currentStyle.dash === 'dashed' ? '切换为实线' : '切换为虚线', () => {
      applyChange(() => {
        edge.style = { ...edge.style, dash: currentStyle.dash === 'dashed' ? 'solid' : 'dashed' };
      });
    });
    addContextItem('调整连线样式', () => CanvasInspector.open(edge.kind === 'branch' ? 'branch' : 'link'));
    addContextDivider();
    addContextItem('删除连线', removeSelected, { shortcut: 'Del', danger: true });
  } else if (frameId) {
    const frame = CanvasViews.selectFrame(frameId);
    if (!frame) return;
    addContextItem('重命名分区', () => CanvasViews.editFrameName(frameId));
    addContextItem('选中成员卡片', () => setSelected(frame.members.filter(id => !!nodeBy(id))));
    addContextDivider();
    addContextItem('移除分区（保留卡片）', () => CanvasViews.removeFrameById(frameId), { danger: true });
  } else {
    addContextItem('在此新建卡片', () => openInline(blankCard(hereWorld), { isNew: true }), { shortcut: '双击' });
    addContextItem('在此新建空白分区', () => CanvasViews.addFrame(hereWorld));
    if (internalClipboard) {
      addContextItem('粘贴已复制卡片', () => pasteNodesIntoBoard(internalClipboard, hereWorld), { shortcut: modKey + 'V' });
    }
    addContextDivider();
    addContextItem('自动整理画布', autoArrange);
    addContextItem('查看全图', () => { fitView(); focusCanvas(); }, { shortcut: 'F' });
    if (board().settings.folded.length) {
      addContextItem('展开全部折叠分支', () => CanvasViews.open('view'));
    }
  }

  contextMenu.hidden = false;
  const menuRect = contextMenu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - menuRect.width - 10);
  const y = Math.min(event.clientY, window.innerHeight - menuRect.height - 10);
  contextMenu.style.left = Math.max(8, x) + 'px';
  contextMenu.style.top = Math.max(8, y) + 'px';
}

document.addEventListener('click', async event => {
  if (!contextMenu.hidden && !contextMenu.contains(event.target)) closeContextMenu();
  if (openSourceCardId) {
    if (event.target.closest('[data-source-close]')) { closeSourcePopover(); return; }
    const copySrc = event.target.closest('[data-copy-source]')?.dataset.copySource;
    if (copySrc) {
      try { await navigator.clipboard.writeText(copySrc); toast('已复制来源地址'); }
      catch { toast('无法写入系统剪贴板', 'error'); }
      return;
    }
    if (!sourcePopover.contains(event.target) && !event.target.closest('[data-card-sources]')) closeSourcePopover();
  }
  const button = event.target.closest('button');
  if (button?.dataset.action) {
    runAction(button.dataset.action);
    return;
  }
  if (openSelectionSubPopover && !selectionSubPopovers[openSelectionSubPopover].panel.contains(event.target)) {
    closeSelectionSubPopovers();
  }
  if (button?.dataset.board) {
    switchBoard(button.dataset.board);
    return;
  }
  if (button?.dataset.match !== undefined) {
    goToMatch(Number(button.dataset.match));
    return;
  }
  if (button?.dataset.tone && modalNote) {
    modalNote.tone = button.dataset.tone;
    paintToneChoices();
    syncNote();
    return;
  }
  if (openPopover && !popovers[openPopover].panel.contains(event.target)) closePopover();
});

viewport.addEventListener('pointerdown', beginPointer);
viewport.addEventListener('pointermove', movePointer);
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
viewport.addEventListener('pointerleave', () => {
  if (!gesture) preview.hidden = true;
  clearTimeout(hoverFocusTimer);
  if (hoveredCardId) { hoveredCardId = null; updateHoverHighlight(); }
});
viewport.addEventListener('pointerover', event => {
  const id = event.target.closest('[data-card]')?.dataset.card || null;
  if (id === hoveredCardId) return;
  clearTimeout(hoverFocusTimer);
  if (!id) {
    hoveredCardId = null;
    updateHoverHighlight();
    return;
  }
  hoverFocusTimer = setTimeout(() => {
    hoveredCardId = id;
    updateHoverHighlight();
  }, 160);
});
viewport.addEventListener('pointerout', event => {
  const next = event.relatedTarget?.closest?.('[data-card]')?.dataset.card || null;
  if (!next) {
    clearTimeout(hoverFocusTimer);
    if (hoveredCardId) { hoveredCardId = null; updateHoverHighlight(); }
  }
});
$('#palette-backdrop')?.addEventListener('click', closePopover);
viewport.addEventListener('contextmenu', openContextMenu);
viewport.addEventListener('focusin', event => {
  const id = event.target.dataset.card;
  if (id && !noteIds().includes(id)) setSelected([id]);
});
viewport.addEventListener('click', event => {
  if (inlineEdit && inlineEdit.element.contains(event.target)) return;
  const checkBtn = event.target.closest('[data-card-check]');
  if (checkBtn && !layoutDraft) {
    const id = checkBtn.closest('[data-card]')?.dataset.card;
    const node = id ? nodeBy(id) : null;
    if (node) {
      applyChange(() => { toggleChecklistItem(node, checkBtn.dataset.cardCheck); });
    }
    return;
  }
  const subBoardBtn = event.target.closest('[data-subboard]');
  if (subBoardBtn && !layoutDraft) {
    const targetId = subBoardBtn.dataset.subboard;
    if (workspace.boards.some(b => b.id === targetId)) switchBoard(targetId);
    return;
  }
  const clickedImg = event.target.closest('.card-cover img, .card-body img');
  if (clickedImg && performance.now() >= suppressClickUntil && !layoutDraft) {
    openLightbox(clickedImg.src, clickedImg.alt);
    return;
  }
  const sourcesBtn = event.target.closest('[data-card-sources]');
  if (sourcesBtn && !layoutDraft) {
    openSourcePopover(sourcesBtn.dataset.cardSources);
    return;
  }
  const button = event.target.closest('[data-card-fold],[data-card-status]');
  if (!button || layoutDraft) return;
  const id = button.closest('[data-card]').dataset.card;
  if (button.hasAttribute('data-card-fold')) {
    CanvasViews.toggleFold(id, false, event.altKey);
    button.focus({ preventScroll: true });
  } else {
    setSelected([id]);
    CanvasViews.close();
    CanvasInspector.open('state');
  }
});
viewport.addEventListener('dblclick', event => {
  if (mode !== 'select' || spaceHeld || modalOpen() || layoutDraft ||
      event.target.closest('[data-handle],[data-card-fold],[data-card-status],[data-card-sources],[data-card-check],[data-subboard],a[href],.card.is-editing') ||
      performance.now() < suppressClickUntil) return;
  const frameHandleId = event.target.closest('[data-frame-handle]')?.dataset.frameHandle;
  if (frameHandleId) {
    CanvasViews.editFrameName(frameHandleId);
    return;
  }
  const id = event.target.closest('[data-card]')?.dataset.card;
  const edgeId = event.target.closest('[data-edge]')?.dataset.edge;
  if (id) openInline(nodeBy(id));
  else if (edgeId) openText('edge', edgeBy(edgeId).label, edgeId);
  else openInline(blankCard(worldPoint(point(event))), { isNew: true });
});
viewport.addEventListener('wheel', event => {
  event.preventDefault();
  if (gesture) return;
  cancelCameraAnimation();
  const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
  if (event.ctrlKey || event.metaKey) {
    zoomTo(camera.scale * Math.exp(-event.deltaY * units * .008), point(event));
  } else {
    const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
    const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
    setCamera(camera.x + dx * units / camera.scale, camera.y + dy * units / camera.scale);
  }
}, { passive: false });

let nativeGesture = null;
viewport.addEventListener('gesturestart', event => {
  event.preventDefault();
  cancelCameraAnimation();
  const { width, height } = viewportSize();
  const local = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? point(event) : { x: width / 2, y: height / 2 };
  nativeGesture = { scale: camera.scale, local, anchor: worldPoint(local) };
});
viewport.addEventListener('gesturechange', event => {
  event.preventDefault();
  if (nativeGesture && Number.isFinite(event.scale) && event.scale > 0) {
    zoomTo(nativeGesture.scale * event.scale, nativeGesture.local, nativeGesture.anchor);
  }
});
viewport.addEventListener('gestureend', event => {
  event.preventDefault();
  nativeGesture = null;
});

function navigateMap(event, geometry) {
  const rect = minimap.getBoundingClientRect();
  setCamera((event.clientX - rect.left - geometry.offsetX) / geometry.scale,
    (event.clientY - rect.top - geometry.offsetY) / geometry.scale);
}
minimap.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !mapGeometry) return;
  cancelCameraAnimation();
  mapDrag = { id: event.pointerId, geometry: { ...mapGeometry } };
  minimap.setPointerCapture(event.pointerId);
  navigateMap(event, mapDrag.geometry);
  focusCanvas();
});
minimap.addEventListener('pointermove', event => {
  if (mapDrag?.id === event.pointerId) navigateMap(event, mapDrag.geometry);
});
for (const type of ['pointerup', 'pointercancel']) {
  minimap.addEventListener(type, event => { if (mapDrag?.id === event.pointerId) mapDrag = null; });
}

document.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  if (modalOpen()) {
    if (noteDialog.open && mod && key === 'enter') {
      event.preventDefault();
      finishNote();
    }
    return;
  }
  if (mod && key === 'k') {
    event.preventDefault();
    togglePopover('search', true);
    return;
  }
  if (!contextMenu.hidden && key === 'escape') {
    event.preventDefault();
    closeContextMenu();
    focusCanvas();
    return;
  }
  if (inlineEdit) return;
  if (openSourceCardId && key === 'escape') {
    event.preventDefault();
    const trigger = cardIndex.get(openSourceCardId)?.element.querySelector('[data-card-sources]');
    closeSourcePopover();
    trigger?.focus();
    return;
  }
  if (openPopover && key === 'escape') {
    event.preventDefault();
    const toggle = popovers[openPopover].toggle;
    closePopover();
    toggle.focus();
    return;
  }
  if (openSelectionSubPopover && key === 'escape') {
    event.preventDefault();
    const toggle = selectionSubPopovers[openSelectionSubPopover].toggle;
    closeSelectionSubPopovers();
    toggle?.focus();
    return;
  }
  if (key === 'escape' && gesture?.matrix) {
    event.preventDefault();
    cancelGesture();
    focusCanvas();
    return;
  }
  if (key === 'escape' && (cancelLayout() || CanvasViews.exitFocus())) {
    event.preventDefault();
    focusCanvas();
    return;
  }
  if (layoutDraft || event.target.closest('button:not([data-card-fold]), input, textarea, select, summary, [contenteditable], a')) return;
  if (mod) {
    if (key === 'z') {
      event.preventDefault();
      lastKeyUndoAt = performance.now();
      undoRedo(event.shiftKey ? 'redo' : 'undo');
    } else if (key === 'y') {
      event.preventDefault();
      lastKeyUndoAt = performance.now();
      undoRedo('redo');
    } else if (key === 's') {
      event.preventDefault();
      download('html');
    } else if (key === 'c' && event.shiftKey && noteIds().length) {
      event.preventDefault();
      copySelectionAsMarkdown();
    } else if (key === 'c' && noteIds().length) {
      event.preventDefault();
      copySelectionToClipboard(false);
    } else if (key === 'x' && noteIds().length) {
      event.preventDefault();
      copySelectionToClipboard(true);
    } else if (key === 'a' && document.activeElement === viewport) {
      event.preventDefault();
      setSelected(board().nodes.filter(node => !visibility.hidden.has(node.id)).map(node => node.id));
    }
    return;
  }
  if (event.key.startsWith('Arrow') && !event.target.closest('[data-card-fold]')) {
    event.preventDefault();
    if (event.altKey) nudge(event.key, event.shiftKey);
    else navigateSelection(event.key, event.shiftKey);
    return;
  }
  if (event.altKey || event.target.closest('[data-card-fold]')) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      paintMode();
    }
    return;
  }
  if (event.repeat) return;
  if (key === 'tab' && !event.shiftKey && event.target === viewport && chosenCard()) {
    event.preventDefault();
    addBranch();
  } else if (key === 'enter' && chosenCard()) {
    event.preventDefault();
    if (event.target === viewport) addBranch(true);
    else editSelection();
  } else if (key === 'escape') {
    cancelGesture();
    setMode('select');
    setSelected([]);
  } else if (key === 'delete' || key === 'backspace') {
    event.preventDefault();
    removeSelected();
  } else {
    const shortcuts = {
      n: action['new-card'], v: action['mode-select'], h: action['mode-hand'], c: action['mode-link'],
      f: action.fit, e: editSelection, m: action['toggle-map'], '+': action['zoom-in'], '=': action['zoom-in'],
      '-': action['zoom-out'], '0': action['zoom-reset'],
    };
    if (shortcuts[key]) {
      event.preventDefault();
      shortcuts[key]();
    }
  }
});

function releaseSpace() {
  spaceHeld = false;
  paintMode();
}
document.addEventListener('keyup', event => { if (event.code === 'Space') releaseSpace(); });
window.addEventListener('blur', () => {
  touches.clear();
  cancelGesture();
  releaseSpace();
});
window.addEventListener('resize', paintView);
window.addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
function checkOtherWindows() {
  if (syncing || loadFailure || conflict) return;
  try {
    if (persistence.read() !== diskSignature) markConflict();
  } catch {
    markConflict();
  }
}
window.addEventListener('storage', checkOtherWindows);
window.addEventListener('focus', checkOtherWindows);

for (const element of document.querySelectorAll('[data-mod]')) element.textContent = modKey + element.textContent;
searchInput.setAttribute('role', 'combobox');
searchInput.setAttribute('aria-controls', 'search-results');
searchInput.setAttribute('aria-expanded', 'true');
searchInput.setAttribute('aria-autocomplete', 'list');
searchInput.addEventListener('input', renderResults);
searchInput.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || !matches.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    selectMatch((activeMatch + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length, true);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    goToMatch(activeMatch);
  }
});
const inputFile = $('#file-input');
inputFile.addEventListener('change', async () => {
  const file = inputFile.files[0];
  inputFile.value = '';
  await importFile(file);
});
const toneButtons = Object.entries(CanvasData.tone).map(([id, { label }]) => {
  const tone = document.createElement('button');
  tone.type = 'button';
  tone.className = 'tone-btn';
  tone.dataset.tone = id;
  tone.innerHTML = '<span class="tone-dot" aria-hidden="true"></span>';
  tone.style.setProperty('--tone-dot', colors[id]);
  tone.append(label);
  return tone;
});
$('#tone-options').append(...toneButtons);
const quickToneButtons = Object.entries(CanvasData.tone).map(([id, { label }]) => {
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'selection-tone-dot';
  dot.dataset.quickTone = id;
  dot.title = '切换为' + label;
  dot.setAttribute('aria-label', '切换为' + label);
  dot.style.background = colors[id];
  dot.addEventListener('click', () => {
    const selectedNodes = noteIds().map(nodeBy).filter(Boolean);
    if (!selectedNodes.length) return;
    applyChange(() => { for (const n of selectedNodes) n.tone = id; });
  });
  return dot;
});
$('#selection-tones').append(...quickToneButtons);

document.addEventListener('paste', event => {
  if (modalOpen() || inlineEdit || layoutDraft) return;
  if (event.target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  void handleCanvasPaste(event.clipboardData);
});

lightboxDialog.addEventListener('click', event => {
  if (event.target === lightboxDialog) lightboxDialog.close();
});
lightboxDialog.addEventListener('wheel', event => {
  event.preventDefault();
  lightboxScale = clamp(lightboxScale * Math.exp(-event.deltaY * 0.002), 0.5, 4);
  lightboxImage.style.transform = `scale(${lightboxScale})`;
}, { passive: false });

noteTitle.addEventListener('input', event => { if (!event.isComposing) syncNote(); });
noteTitle.addEventListener('compositionend', syncNote);
noteExtra.addEventListener('input', () => { updateNoteProvenanceSummary(); syncNote(); });
$('#note-source-add').addEventListener('click', () => {
  appendNoteSourceRow('', '');
  noteProvenance.open = true;
  noteSourcesRows.lastElementChild?.querySelector('input')?.focus();
});
noteBody.addEventListener('input', event => {
  if (!event.isComposing) {
    repairSplitChecklist(noteBody, event);
    maybeConvertChecklistShortcut(noteBody, editNoteBody);
    editNoteBody();
  }
});
noteBody.addEventListener('compositionend', editNoteBody);
noteBody.addEventListener('keydown', event => { handleChecklistEnter(event, noteBody, editNoteBody); });
document.addEventListener('selectionchange', () => {
  if (!modalNote) return;
  const range = editorSelection();
  if (range) editorRange = range.cloneRange();
  paintFormat();
});
for (const button of formatButtons) {
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    focusEditor();
    const command = button.dataset.format;
    if (command === 'checklist') {
      toggleChecklistCommand(noteBody, editNoteBody);
      editorRange = editorSelection()?.cloneRange() ?? null;
      return;
    }
    const value = command === 'formatBlock'
      ? (document.queryCommandValue(command).toLowerCase() === 'h3' ? 'div' : 'h3') : null;
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(command, false, value);
    editorRange = editorSelection()?.cloneRange() ?? null;
    editNoteBody();
  });
}
noteBody.addEventListener('paste', event => {
  event.preventDefault();
  editorRange = editorSelection()?.cloneRange() ?? editorRange;
  transferNoteContent(event.clipboardData);
});
noteBody.addEventListener('dragover', event => event.preventDefault());
noteBody.addEventListener('drop', event => {
  event.preventDefault();
  transferNoteContent(event.dataTransfer);
});
noteBody.addEventListener('click', event => {
  handleChecklistClickInEditor(event, noteBody, editNoteBody);
  const image = event.target.closest('img');
  selectImage(image);
  if (!image) return;
  editorRange = document.createRange();
  editorRange.selectNode(image);
  focusEditor();
});
$('#note-image-add').addEventListener('click', () => {
  editorRange = editorSelection()?.cloneRange() ?? editorRange;
  noteImages.click();
});
noteImages.addEventListener('change', () => {
  const files = [...noteImages.files];
  noteImages.value = '';
  void addPictures(files);
});
$('#note-image-remove').addEventListener('click', () => {
  if (!pickedImage || !noteBody.contains(pickedImage)) return;
  editorRange = document.createRange();
  editorRange.selectNode(pickedImage);
  focusEditor();
  const image = pickedImage;
  document.execCommand('delete');
  if (noteBody.contains(image)) image.remove();
  selectImage(null);
  editNoteBody();
});
$('#note-form').addEventListener('submit', event => {
  event.preventDefault();
  finishNote();
});
noteDialog.addEventListener('cancel', event => { if (modalNote?.imageJob) event.preventDefault(); });
noteDialog.addEventListener('close', () => {
  syncNote();
  modalNote = null;
  save();
  focusCanvas();
});
textField.addEventListener('input', () => textField.setCustomValidity(''));
$('#text-form').addEventListener('submit', event => {
  event.preventDefault();
  commitText();
});
textDialog.addEventListener('close', () => {
  modalText = null;
  textField.setCustomValidity('');
  focusCanvas();
});
helpDialog.addEventListener('close', focusCanvas);

mountLayout();
CanvasInspector.mount();
CanvasViews.mount();
render();
showBoardView();
if (desktop) {
  for (const selector of ['#desktop-file-divider', '[data-action="data-folder"]', '[data-action="backups-folder"]', '[data-action="sync-link"]']) {
    $(selector).hidden = false;
  }
  $('#help-save-note').textContent = '桌面版和已连接的浏览器共用本机画布。收起窗口可以继续同步。用「文件」可复制同步链接、查看历史备份或导出 HTML。';
  const openingWorkspace = JSON.stringify(workspace);
  window.ideaCanvasCommand = name => {
    if (name === 'undo' || name === 'redo') {
      if (document.activeElement?.closest?.('input, textarea, [contenteditable="true"]')) return 'native';
      if (!modalOpen() && performance.now() - lastKeyUndoAt > 400) undoRedo(name);
      return 'done';
    }
    if (!action[name] || modalOpen()) return 'ignored';
    if (inlineEdit) finishInline({ keepFocus: true });
    runAction(name);
    return 'done';
  };
  window.ideaCanvasBeforeQuit = async () => {
    if (modalNote?.imageJob) await modalNote.imageJob;
    if (modalNote) syncNote();
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (loadFailure) return JSON.stringify(workspace) === openingWorkspace;
    while (writingToDisk || dirty()) {
      if (!await saveToDisk()) return false;
    }
    return true;
  };
  if (loadFailure) {
    desktopStateLabel('本机数据读取失败', 'error', desktopState.warning || '无法读取画布数据。');
    toast(desktopState.warning || '无法读取画布数据。请检查历史备份。', 'error');
  } else if (savedWorkspace) {
    statusSaved();
  }
} else if (browserSync) {
  $('#help-save-note').textContent = '编辑自动写到这台 Mac 的桌面画布。需要同步时让桌面版继续运行，可以收起窗口。';
} else if (loadFailure) {
  storageState('浏览器存储不可用', true, '可继续编辑，并在「文件」中导出可编辑 HTML。');
  toast('浏览器存储读取失败。请用「文件」导出当前内容。', 'error');
} else if (diskSignature) {
  storageState('已保存到浏览器');
}
if (syncing && !loadFailure) {
  if (unresolved) handleSyncConflict();
  else if (dirty()) save();
  else statusSaved();
  setInterval(pullShared, 1100);
  window.addEventListener('focus', pullShared);
  if (browserSync) {
    window.addEventListener('beforeunload', event => {
      rememberDraft();
      if (dirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }
} else if (!loadFailure) {
  save();
}
