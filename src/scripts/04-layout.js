const CanvasLayout = (() => {
  const isTreeMode = mode => mode === 'right' || mode === 'double' || mode === 'down';
  const toneNames = new Map([
    ['topic', '主题'], ['idea', '想法'], ['question', '问题'], ['action', '行动'], ['reference', '素材'],
  ]);
  const priorityNames = new Map([
    ['high', '高优先'], ['medium', '中优先'], ['low', '低优先'], ['star', '星标'],
  ]);

  function orderedByPosition(a, b) {
    const explicitA = Number.isFinite(a.order) ? a.order : Infinity;
    const explicitB = Number.isFinite(b.order) ? b.order : Infinity;
    return explicitA - explicitB || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
  }

  function indexHierarchy(nodes, children, roots) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const compare = (a, b) => orderedByPosition(byId.get(a), byId.get(b));
    const parent = new Map();
    for (const [id, descendants] of children) {
      descendants.sort(compare);
      for (const child of descendants) parent.set(child, id);
    }
    roots.sort(compare);
    const order = [];
    const pending = roots.slice().reverse();
    while (pending.length) {
      const id = pending.pop();
      order.push(id);
      const next = children.get(id);
      for (let i = next.length - 1; i >= 0; i--) pending.push(next[i]);
    }
    return { children, parent, roots, order };
  }

  function tree(nodes, edges) {
    const children = new Map(nodes.map(node => [node.id, []]));
    const parented = new Set();
    const groups = new Map(nodes.map(node => [node.id, node.id]));

    function groupOf(id) {
      while (groups.get(id) !== id) {
        groups.set(id, groups.get(groups.get(id)));
        id = groups.get(id);
      }
      return id;
    }

    for (const kind of ['branch', 'link']) {
      for (const edge of edges) {
        const { from, to } = edge;
        if (edge.kind !== kind || !children.has(from) || !children.has(to) || parented.has(to)) continue;
        const fromGroup = groupOf(from);
        const toGroup = groupOf(to);
        if (fromGroup === toGroup) continue;
        groups.set(toGroup, fromGroup);
        parented.add(to);
        children.get(from).push(to);
      }
    }
    return indexHierarchy(nodes, children, nodes.map(node => node.id).filter(id => !parented.has(id)));
  }

  function subtree(hierarchy, rootId) {
    if (!hierarchy.children.has(rootId)) return [];
    const ids = [];
    const pending = [rootId];
    while (pending.length) {
      const id = pending.pop();
      ids.push(id);
      const next = hierarchy.children.get(id);
      for (let i = next.length - 1; i >= 0; i--) pending.push(next[i]);
    }
    return ids;
  }

  function foldedDescendants(hierarchy, folded) {
    const hidden = new Set();
    const pending = folded.flatMap(id => hierarchy.children.get(id) || []);
    while (pending.length) {
      const id = pending.pop();
      if (hidden.has(id)) continue;
      hidden.add(id);
      for (const child of hierarchy.children.get(id)) pending.push(child);
    }
    return hidden;
  }

  function project(hierarchy, included) {
    const order = hierarchy.order.filter(id => included.has(id));
    const children = new Map();
    const parent = new Map();
    const roots = [];
    for (const id of order) {
      const parentId = hierarchy.parent.get(id);
      if (included.has(parentId)) parent.set(id, parentId);
      else roots.push(id);
      children.set(id, hierarchy.children.get(id).filter(child => included.has(child)));
    }
    return { children, parent, roots, order };
  }

  function orient(nodes, hierarchy, rootId) {
    if (!hierarchy.parent.has(rootId)) return hierarchy;
    const children = new Map([...hierarchy.children].map(([id, next]) => [id, next.slice()]));
    let ancestor = rootId;
    while (hierarchy.parent.has(ancestor)) {
      const next = hierarchy.parent.get(ancestor);
      const siblings = children.get(next);
      siblings.splice(siblings.indexOf(ancestor), 1);
      children.get(ancestor).push(next);
      ancestor = next;
    }
    return indexHierarchy(nodes, children, hierarchy.roots.map(id => id === ancestor ? rootId : id));
  }

  function bounds(positions, byId) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const [id, { x, y }] of positions) {
      const { w, h } = byId.get(id);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + w);
      bottom = Math.max(bottom, y + h);
    }
    return positions.size ? { left, top, right, bottom } : { left: 0, top: 0, right: 0, bottom: 0 };
  }

  function appendPositions(target, source, dx = 0, dy = 0) {
    for (const [id, { x, y }] of source) target.set(id, { x: x + dx, y: y + dy });
  }

  function leafGrid(childIds, hierarchy) {
    const count = childIds?.length || 0;
    if (count < 5 || childIds.some(id => (hierarchy.children.get(id)?.length || 0) > 0)) return null;
    const columns = count >= 10 ? 3 : 2;
    return { columns, rows: Math.ceil(count / columns) };
  }

  function gridMetrics(childItems, grid, byId, spec) {
    const rowHeights = Array(grid.rows).fill(0);
    const colWidths = Array(grid.columns).fill(0);
    for (let index = 0; index < childItems.length; index++) {
      const { w, h } = byId.get(childItems[index].id);
      const col = Math.floor(index / grid.rows);
      const row = index % grid.rows;
      rowHeights[row] = Math.max(rowHeights[row], h);
      colWidths[col] = Math.max(colWidths[col], w);
    }
    const colGap = Math.max(36, Math.round(spec.levelGap * 0.45));
    const rowOffsets = trackStarts(rowHeights, 0, spec.nodeGap);
    const colOffsets = trackStarts(colWidths, 0, colGap);
    return { rowOffsets, colOffsets, height: rowOffsets.at(-1) + rowHeights.at(-1) };
  }

  function layers(roots, hierarchy, byId, spec, vertical = false) {
    const depthSize = node => vertical ? node.h : node.w;
    const laneSize = node => vertical ? node.w : node.h;
    const rootGrid = !vertical ? leafGrid(roots, hierarchy) : null;
    const items = roots.map((id, index) => ({
      id, depth: 0, children: [], gridCol: rootGrid ? Math.floor(index / rootGrid.rows) : 0,
    }));
    const widths = [];
    for (const item of items) {
      if (!item.gridCol) widths[item.depth] = Math.max(widths[item.depth] || 0, depthSize(byId.get(item.id)));
      const childIds = hierarchy.children.get(item.id) || [];
      item.grid = !vertical ? leafGrid(childIds, hierarchy) : null;
      for (let index = 0; index < childIds.length; index++) {
        const child = {
          id: childIds[index], depth: item.depth + 1, children: [],
          gridCol: item.grid ? Math.floor(index / item.grid.rows) : 0,
        };
        item.children.push(child);
        items.push(child);
      }
    }
    const levels = widths.map(() => 0);
    for (let i = 1; i < widths.length; i++) levels[i] = levels[i - 1] + widths[i - 1] + spec.levelGap;

    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.grid) {
        item.gridLayout = gridMetrics(item.children, item.grid, byId, spec);
        item.childSpan = item.gridLayout.height;
      } else {
        item.childSpan = item.children.reduce((height, child, index) => height + child.span + (index ? spec.nodeGap : 0), 0);
      }
      item.span = Math.max(item.childSpan, laneSize(byId.get(item.id)));
    }

    const rootItems = items.slice(0, roots.length);
    if (rootGrid) {
      const rootLayout = gridMetrics(rootItems, rootGrid, byId, spec);
      rootItems.forEach((item, index) => {
        item.start = rootLayout.rowOffsets[index % rootGrid.rows];
        item.xOffset = rootLayout.colOffsets[Math.floor(index / rootGrid.rows)];
      });
    } else {
      let span = 0;
      for (const item of rootItems) {
        item.start = span;
        span += item.span + spec.nodeGap;
      }
    }
    const isTopAligned = item => !vertical && item.children.length > 0 &&
      (item.children.length >= 3 || item.childSpan > laneSize(byId.get(item.id)) * 1.8);
    for (const item of items) {
      const childStart = item.start + (isTopAligned(item) ? 0 : (item.span - item.childSpan) / 2);
      if (item.grid) {
        item.children.forEach((child, index) => {
          child.start = childStart + item.gridLayout.rowOffsets[index % item.grid.rows];
          child.xOffset = item.gridLayout.colOffsets[Math.floor(index / item.grid.rows)];
        });
      } else {
        let cursor = childStart;
        for (const child of item.children) {
          child.start = cursor;
          cursor += child.span + spec.nodeGap;
        }
      }
    }
    const positions = new Map();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const node = byId.get(item.id);
      const size = laneSize(node);
      if (!item.children.length) {
        item.across = item.start + (item.span - size) / 2;
      } else if (isTopAligned(item)) {
        item.across = clamp(item.children[0].across, item.start, item.start + item.span - size);
      } else {
        item.across = item.start + (item.span - size) / 2;
      }
      const level = levels[item.depth] + (item.xOffset || 0);
      positions.set(item.id, vertical ? { x: item.across, y: level } : { x: level, y: item.across });
    }
    return positions;
  }

  function branchLanes(hierarchy, byId, layout) {
    const lanes = new Map();
    if (layout.mode !== 'double') return lanes;
    for (const id of hierarchy.order) {
      const parentId = hierarchy.parent.get(id);
      if (id === layout.rootId || !byId.has(parentId) || !byId.has(id)) continue;
      lanes.set(id, lanes.get(parentId) || (byId.get(id).x < byId.get(parentId).x ? 'left' : 'right'));
    }
    return lanes;
  }

  function reflowBranch(nodes, hierarchy, rootId, layout, branchId = null) {
    const { mode, nodeGap, levelGap } = layout;
    if (!isTreeMode(mode)) return new Map();
    const byId = new Map(nodes.map(node => [node.id, node]));
    const root = byId.get(rootId);
    const children = new Map(subtree(hierarchy, rootId).filter(id => byId.has(id))
      .map(id => [id, hierarchy.children.get(id).filter(child => byId.has(child))]));
    const roots = children.get(rootId) || [];
    const lanes = branchLanes(hierarchy, byId, layout);
    const onlyLane = lanes.get(branchId);
    const buckets = new Map();
    const vertical = mode === 'down';
    for (const id of roots) {
      const side = lanes.get(id) || (vertical ? 'down' : 'right');
      if (onlyLane && onlyLane !== side) continue;
      if (!buckets.has(side)) buckets.set(side, []);
      buckets.get(side).push(id);
    }

    const positions = new Map();
    const gap = Math.max(levelGap, 44);
    for (const [side, ids] of buckets) {
      const layer = layers(ids, { children }, byId, { nodeGap, levelGap: gap }, vertical);
      const { right, bottom } = bounds(layer, byId);
      for (const [id, point] of layer) {
        const x = vertical ? root.x + (root.w - right) / 2 + point.x
          : side === 'left' ? root.x - gap - point.x - byId.get(id).w : root.x + root.w + gap + point.x;
        const y = vertical ? root.y + root.h + gap + point.y : root.y + (root.h - bottom) / 2 + point.y;
        positions.set(id, { x, y });
      }
    }
    const involved = nodes.filter(node => positions.has(node.id));
    const obstacles = nodes.filter(node => !positions.has(node.id));
    return avoidFixed(positions, involved, Math.min(nodeGap, 12), obstacles, vertical);
  }

  function overlappingRevealRoots(nodes, hierarchy, revealed) {
    const owners = new Map();
    for (const id of hierarchy.order) {
      if (!revealed.has(id)) continue;
      const parent = hierarchy.parent.get(id);
      owners.set(id, owners.get(parent) || parent);
    }
    const roots = new Set();
    const byTop = nodes.slice().sort((a, b) => a.y - b.y);
    for (let i = 0; i < byTop.length; i++) {
      const a = byTop[i];
      const owner = owners.get(a.id);
      for (let j = i + 1; j < byTop.length && byTop[j].y < a.y + a.h; j++) {
        const b = byTop[j];
        if (a.pinned && b.pinned || a.x >= b.x + b.w || b.x >= a.x + a.w) continue;
        if (owner && !a.pinned) roots.add(owner);
        const neighborOwner = owners.get(b.id);
        if (neighborOwner && !b.pinned) roots.add(neighborOwner);
      }
    }
    return roots;
  }

  function addLooseGrid(positions, loose, byId, spec) {
    if (!loose.length) return;
    const width = Math.ceil(Math.sqrt(loose.length));
    const columns = Array(width).fill(0);
    const rows = Array(Math.ceil(loose.length / width)).fill(0);
    for (const [i, id] of loose.entries()) {
      const { w, h } = byId.get(id);
      columns[i % width] = Math.max(columns[i % width], w);
      rows[Math.floor(i / width)] = Math.max(rows[Math.floor(i / width)], h);
    }
    const { left, bottom } = bounds(positions, byId);
    const xs = trackStarts(columns, left, spec.levelGap);
    const ys = trackStarts(rows, positions.size ? bottom + spec.levelGap : 0, spec.nodeGap);
    for (const [i, id] of loose.entries()) positions.set(id, { x: xs[i % width], y: ys[Math.floor(i / width)] });
  }

  function trackStarts(sizes, start = 0, gap = 0) {
    return sizes.map(size => {
      const current = start;
      start += size + gap;
      return current;
    });
  }

  function doubles(roots, hierarchy, byId, spec) {
    const positions = new Map();
    let y = 0;
    for (const root of roots) {
      const node = byId.get(root);
      const children = hierarchy.children.get(root).map(id => {
        const leg = layers([id], hierarchy, byId, spec);
        const area = bounds(leg, byId);
        return { id, span: area.bottom - area.top };
      });
      const lane = [[], []];
      const heights = [0, 0];
      const partition = new Map();
      const preferred = spec.preferredSides;
      const unassigned = [];
      for (const item of children) {
        const pref = preferred?.get(item.id);
        if (pref === 'right' || pref === 'left') {
          const side = pref === 'left' ? 1 : 0;
          partition.set(item.id, side);
          heights[side] += item.span + spec.nodeGap;
        } else {
          unassigned.push(item);
        }
      }
      for (const { id, span } of unassigned.sort((a, b) => b.span - a.span)) {
        const side = heights[0] <= heights[1] ? 0 : 1;
        partition.set(id, side);
        heights[side] += span + spec.nodeGap;
      }
      for (const { id } of children) lane[partition.get(id)].push(id);

      const right = layers(lane[0], hierarchy, byId, spec);
      const left = layers(lane[1], hierarchy, byId, spec);
      const boxRight = bounds(right, byId);
      const boxLeft = bounds(left, byId);
      const half = Math.max(node.h, boxRight.bottom, boxLeft.bottom) / 2;
      const center = y + half;
      positions.set(root, { x: 0, y: center - node.h / 2 });
      appendPositions(positions, right, node.w + spec.levelGap, center - boxRight.bottom / 2);
      for (const [id, p] of left) {
        positions.set(id, { x: -p.x - byId.get(id).w - spec.levelGap, y: p.y + center - boxLeft.bottom / 2 });
      }
      y = center + half + spec.levelGap;
    }
    return positions;
  }

  function timeline(hierarchy, byId, spec) {
    const positions = new Map();
    let x = 0;
    for (const [index, id] of hierarchy.order.entries()) {
      const { w, h } = byId.get(id);
      const offset = spec.nodeGap / 2 + 24;
      const y = index % 2 === 0 ? -offset - h : offset;
      positions.set(id, { x, y });
      x += w + Math.max(spec.levelGap / 2, spec.nodeGap);
    }
    return positions;
  }

  function timelineGuides(positions, hierarchy, byId, baseline) {
    const { left, right } = bounds(positions, byId);
    const marks = [{ kind: 'line', x: left - 12, y: baseline, x2: right + 12, y2: baseline }];
    for (const [index, id] of hierarchy.order.entries()) {
      const { x, y } = positions.get(id);
      const { w, h } = byId.get(id);
      const center = x + w / 2;
      const edge = Math.min(y + h, Math.max(y, baseline));
      marks.push({ kind: 'line', x: center, y: baseline, x2: center, y2: edge });
      marks.push({ kind: 'label', x: center + 7, y: baseline + (edge < baseline ? 16 : -8), text: String(index + 1) });
    }
    return marks;
  }

  function axisName(axis, value, options) {
    if (axis === 'tone') return toneNames.get(value) ?? '无类型';
    if (axis === 'priority') return priorityNames.get(value) ?? '无优先级';
    return options.statuses.find(status => status.id === value)?.name ?? '无状态';
  }

  function axisValue(axis, node, spec) {
    const value = node[axis];
    if (axis === 'tone') return toneNames.has(value) ? value : '';
    if (axis === 'priority') return priorityNames.has(value) ? value : '';
    return spec.statuses.some(status => status.id === value) ? value : '';
  }

  function categoryName(axis, node, statuses) {
    const spec = { statuses };
    return axisName(axis, axisValue(axis, node, spec), spec);
  }

  function axisBuckets(axis, spec) {
    if (axis === 'tone') return [...toneNames.keys()];
    if (axis === 'priority') return [...priorityNames.keys(), ''];
    return [...spec.statuses.map(item => item.id), ''];
  }

  function matrixTracks(options, guides, statuses) {
    if (options.mode !== 'matrix' || options.rows === options.columns) return null;
    const lines = guides.filter(guide => guide.kind === 'line');
    const horizontal = lines.filter(line => line.y === line.y2 && line.x < line.x2).sort((a, b) => a.y - b.y);
    const vertical = lines.filter(line => line.x === line.x2 && line.y < line.y2).sort((a, b) => a.x - b.x);
    if (horizontal.length < 2 || vertical.length < 2) return null;
    const { x: left } = vertical[0];
    const { x: right } = vertical.at(-1);
    const { y: top } = horizontal[0];
    const { y: bottom } = horizontal.at(-1);
    if (horizontal.some((line, index) => line.x > left || line.x2 !== right || (index && line.y === horizontal[index - 1].y)) ||
        vertical.some((line, index) => line.y > top || line.y2 !== bottom || (index && line.x === vertical[index - 1].x))) return null;

    const labels = guides.filter(guide => guide.kind === 'label');
    function tracks(axis, dimension, cuts, headings) {
      const spec = { statuses };
      const names = new Map(axisBuckets(axis, spec).map(value => [value, axisName(axis, value, spec)]));
      return cuts.slice(0, -1).map((line, index) => {
        const start = line[dimension];
        const end = cuts[index + 1][dimension];
        const matching = headings.filter(label => label[dimension] >= start && label[dimension] < end);
        const track = { axis, start, end };
        if (matching.length !== 1) return track;
        const label = matching[0];
        if (label.axis !== undefined) {
          if (label.axis !== axis || !names.has(label.value)) return track;
          return { ...track, value: label.value, name: names.get(label.value) };
        }
        const values = [...names].filter(([, name]) => name === label.text);
        return values.length === 1 ? { ...track, value: values[0][0], name: values[0][1] } : track;
      });
    }
    const rows = tracks(options.rows, 'y', horizontal, labels.filter(label => label.x < left));
    const columns = tracks(options.columns, 'x', vertical, labels.filter(label => label.y < top));
    if (!rows.some(track => track.value !== undefined) || !columns.some(track => track.value !== undefined)) return null;
    return { rows, columns };
  }

  function reclassifyCard(node, { row, column }, statuses) {
    const changed = [row, column].filter(track => axisValue(track.axis, node, { statuses }) !== track.value);
    if (!changed.length) return node;
    const draft = { ...node };
    for (const { axis, value } of changed) {
      if (value === '') delete draft[axis];
      else draft[axis] = value;
    }
    return draft;
  }

  function matrixCell(nodes, cardsPerLine, gap) {
    const cards = [];
    let width = 0;
    let y = 0;
    for (let index = 0; index < nodes.length; index += cardsPerLine) {
      const line = nodes.slice(index, index + cardsPerLine);
      let x = 0;
      for (const node of line) {
        cards.push({ id: node.id, x, y });
        x += node.w + gap;
      }
      width = Math.max(width, x - gap);
      y += Math.max(...line.map(node => node.h)) + gap;
    }
    return { cards, width, height: Math.max(0, y - gap) };
  }

  function matrix(hierarchy, byId, spec) {
    const positions = new Map();
    const guides = [];
    const cell = new Map();
    const colValues = new Set();
    const space = Math.max(12, spec.nodeGap / 2);
    for (const id of hierarchy.order) {
      const node = byId.get(id);
      const row = axisValue(spec.rows, node, spec);
      const col = axisValue(spec.columns, node, spec);
      colValues.add(col);
      const key = JSON.stringify([row, col]);
      if (!cell.has(key)) cell.set(key, []);
      cell.get(key).push(node);
    }
    const rows = axisBuckets(spec.rows, spec);
    const cols = axisBuckets(spec.columns, spec);
    const rowNames = rows.map(value => axisName(spec.rows, value, spec));
    const colNames = cols.map(value => axisName(spec.columns, value, spec));
    const labelWidth = text => [...text].length * 15;
    const left = Math.max(86, ...rowNames.map(name => labelWidth(name) + space * 2));
    const top = 34 + space;
    const cardsPerLine = clamp(Math.floor(6 / Math.max(1, colValues.size)), 1, 3);
    const cells = rows.map(row => cols.map(col =>
      matrixCell(cell.get(JSON.stringify([row, col])) ?? [], cardsPerLine, space)));
    const widths = colNames.map((name, col) => colValues.has(cols[col])
      ? Math.max(110, labelWidth(name) + space * 2, ...cells.map(row => row[col].width + space * 2))
      : Math.max(86, labelWidth(name) + 24));
    const heights = cells.map(row => Math.max(48, ...row.map(item => item.cards.length ? item.height + space * 2 : 0)));
    const xs = trackStarts(widths, left);
    const ys = trackStarts(heights, top);
    const right = xs.at(-1) + widths.at(-1);
    const bottom = ys.at(-1) + heights.at(-1);
    for (const x of [...xs, right]) guides.push({ kind: 'line', x, y: top - 24, x2: x, y2: bottom });
    for (const y of [...ys, bottom]) guides.push({ kind: 'line', x: 0, y, x2: right, y2: y });
    const labelInset = Math.min(space, 16);
    for (const [ci, name] of colNames.entries()) {
      guides.push({ kind: 'label', x: xs[ci] + labelInset, y: top - 10, text: name, axis: spec.columns, value: cols[ci] });
    }
    for (const [ri, row] of cells.entries()) {
      guides.push({ kind: 'label', x: labelInset, y: ys[ri] + labelInset + 14, text: rowNames[ri], axis: spec.rows, value: rows[ri] });
      for (const [ci, item] of row.entries()) {
        for (const card of item.cards) {
          positions.set(card.id, { x: xs[ci] + space + card.x, y: ys[ri] + space + card.y });
        }
      }
    }
    return { positions, guides };
  }

  function fishbone(roots, hierarchy, byId, spec) {
    const positions = new Map();
    let nextGroupY = 0;
    for (const root of roots) {
      const rootNode = byId.get(root);
      const group = new Map();
      let x = 0;
      const offset = spec.nodeGap / 2 + 38;
      for (const [index, id] of hierarchy.children.get(root).entries()) {
        const above = index % 2 === 0;
        const branch = layers([id], hierarchy, byId, spec, true);
        const area = bounds(branch, byId);
        for (const [child, point] of branch) {
          group.set(child, { x: x + point.x, y: above ? -offset - point.y - byId.get(child).h : offset + point.y });
        }
        x += area.right + Math.max(spec.levelGap, 38);
      }
      group.set(root, { x, y: -rootNode.h / 2 });
      const area = bounds(group, byId);
      const dy = nextGroupY - area.top;
      appendPositions(positions, group, 0, dy);
      nextGroupY = area.bottom + dy + spec.levelGap;
    }
    return positions;
  }

  function fishboneGuides(positions, roots, hierarchy, byId, gap) {
    const guides = [];
    for (const root of roots) {
      const position = positions.get(root);
      const baseline = position.y + byId.get(root).h / 2;
      const bones = hierarchy.children.get(root).map(id => {
        const { x, y } = positions.get(id);
        const { w, h } = byId.get(id);
        const center = x + w / 2;
        return { kind: 'line', x: center, y: Math.min(y + h, Math.max(y, baseline)),
          x2: center + (center < position.x ? 1 : -1) * Math.max(w / 2, gap / 2), y2: baseline };
      });
      const endpoints = bones.map(bone => bone.x2);
      const left = Math.min(position.x - 12, ...endpoints);
      const right = Math.max(position.x, ...endpoints);
      guides.push({ kind: 'line', x: left, y: baseline, x2: right, y2: baseline }, ...bones);
    }
    return guides;
  }

  function translateGuide(guide, dx, dy) {
    const moved = { ...guide, x: guide.x + dx, y: guide.y + dy };
    return guide.kind === 'line' ? { ...moved, x2: guide.x2 + dx, y2: guide.y2 + dy } : moved;
  }

  function avoidFixed(positions, nodes, gap, obstacles, vertical = false) {
    const fixed = nodes.filter(node => node.pinned);
    if (!fixed.length && !obstacles.length) return positions;
    const active = [...fixed, ...obstacles];
    const result = new Map(fixed.map(node => [node.id, { x: node.x, y: node.y }]));
    const byId = new Map(nodes.map(node => [node.id, node]));
    const [depth, lane, depthSize, laneSize] = vertical ? ['y', 'x', 'h', 'w'] : ['x', 'y', 'w', 'h'];
    for (const [id, point] of positions) {
      const node = byId.get(id);
      if (node.pinned) continue;
      const along = point[depth];
      const intervals = active.filter(other => along < other[depth] + other[depthSize] + gap && along + node[depthSize] + gap > other[depth])
        .map(other => [other[lane] - node[laneSize] - gap, other[lane] + other[laneSize] + gap]).sort((a, b) => a[0] - b[0]);
      let across = point[lane];
      for (const [start, end] of intervals) {
        if (across <= start) break;
        across = Math.max(across, end);
      }
      const placed = { ...point, [lane]: across };
      result.set(id, placed);
      active.push({ ...placed, w: node.w, h: node.h });
    }
    return result;
  }

  function moveMatrixAroundFixed(positions, nodes, byId, guides, obstacles, gap) {
    const grid = bounds(positions, byId);
    for (const guide of guides) {
      grid.left = Math.min(grid.left, guide.x, guide.x2 ?? guide.x);
      grid.top = Math.min(grid.top, guide.y, guide.y2 ?? guide.y);
      grid.right = Math.max(grid.right, guide.x, guide.x2 ?? guide.x);
      grid.bottom = Math.max(grid.bottom, guide.y, guide.y2 ?? guide.y);
    }
    const fixed = [...nodes.filter(node => node.pinned), ...obstacles].sort((a, b) => a.y - b.y);
    let offset = 0;
    for (const other of fixed) {
      if (grid.left >= other.x + other.w + gap || grid.right + gap <= other.x ||
          grid.top + offset >= other.y + other.h + gap || grid.bottom + offset + gap <= other.y) continue;
      offset = other.y + other.h + gap - grid.top;
    }
    const translated = new Map();
    for (const [id, point] of positions) {
      const { x, y, pinned } = byId.get(id);
      translated.set(id, pinned ? { x, y } : { x: point.x, y: point.y + offset });
    }
    return { positions: translated, guides: guides.map(guide => translateGuide(guide, 0, offset)) };
  }

  function compute(nodes, edges, options = {}) {
    const original = new Map(nodes.map(node => [node.id, { x: node.x, y: node.y }]));
    if (!nodes.length || nodes.every(node => node.pinned) || options.mode === 'free') return { positions: original, guides: [] };
    const { nodeGap = 24, levelGap = 76, rows = 'status', columns = 'tone', statuses = [], obstacles = [], preferredSides = null } = options;
    const spec = { nodeGap, levelGap, rows, columns, statuses, preferredSides };
    const byId = new Map(nodes.map(node => [node.id, node]));
    const source = options.hierarchy ? project(options.hierarchy, byId) : tree(nodes, edges);
    const hierarchy = orient(nodes, source, options.rootId);
    const roots = hierarchy.roots.filter(id => hierarchy.children.get(id).length || id === options.rootId);
    const loose = hierarchy.roots.filter(id => !roots.includes(id));
    let positions;
    let guides = [];
    switch (options.mode) {
      case 'timeline':
        positions = timeline(hierarchy, byId, spec);
        break;
      case 'matrix':
        ({ positions, guides } = matrix(hierarchy, byId, spec));
        break;
      case 'fishbone':
        positions = fishbone(roots, hierarchy, byId, spec);
        addLooseGrid(positions, loose, byId, spec);
        break;
      case 'double':
        positions = doubles(roots, hierarchy, byId, spec);
        addLooseGrid(positions, loose, byId, spec);
        break;
      default:
        positions = layers(roots, hierarchy, byId, spec, options.mode === 'down');
        addLooseGrid(positions, loose, byId, spec);
        break;
    }

    const rootId = byId.has(options.rootId) ? options.rootId
      : options.scope === 'branch' ? hierarchy.roots[0] : null;
    const before = bounds(original, byId);
    const after = bounds(positions, byId);
    const dx = rootId ? original.get(rootId).x - positions.get(rootId).x : before.left - after.left;
    const dy = rootId ? original.get(rootId).y - positions.get(rootId).y : before.top - after.top;
    const translated = new Map();
    appendPositions(translated, positions, dx, dy);
    const clearance = Math.min(nodeGap, 12);
    if (options.mode === 'matrix') {
      return moveMatrixAroundFixed(translated, nodes, byId, guides.map(guide => translateGuide(guide, dx, dy)), obstacles, clearance);
    }
    const arranged = avoidFixed(translated, nodes, clearance, obstacles, options.mode === 'down');
    if (options.mode === 'timeline') guides = timelineGuides(arranged, hierarchy, byId, dy);
    if (options.mode === 'fishbone') guides = fishboneGuides(arranged, roots, hierarchy, byId, levelGap);
    return { positions: arranged, guides };
  }

  function align(nodes, command) {
    const positions = new Map(nodes.map(node => [node.id, { x: node.x, y: node.y }]));
    if (nodes.length < 2) return positions;
    if (command === 'distribute-x' || command === 'distribute-y') {
      const axis = command.at(-1);
      const dimension = axis === 'x' ? 'w' : 'h';
      const sorted = nodes.slice().sort((a, b) => a[axis] - b[axis] || orderedByPosition(a, b));
      let start = 0;
      for (let end = 1; end < sorted.length; end++) {
        if (!sorted[end].pinned && end !== sorted.length - 1) continue;
        const inside = sorted.slice(start + 1, end);
        const first = sorted[start];
        let edge = first[axis] + first[dimension];
        const available = sorted[end][axis] - edge;
        const sizes = inside.reduce((sum, node) => sum + node[dimension], 0);
        const gap = (available - sizes) / (inside.length + 1);
        for (const node of inside) {
          positions.get(node.id)[axis] = edge + gap;
          edge += gap + node[dimension];
        }
        start = end;
      }
      return positions;
    }
    const pinned = nodes.filter(node => node.pinned);
    const reference = pinned.length ? pinned : nodes;
    const byId = new Map(reference.map(node => [node.id, node]));
    const area = bounds(new Map(reference.map(node => [node.id, positions.get(node.id)])), byId);
    const adjust = {
      left: p => ({ ...p, x: area.left }), right: (p, n) => ({ ...p, x: area.right - n.w }),
      top: p => ({ ...p, y: area.top }), bottom: (p, n) => ({ ...p, y: area.bottom - n.h }),
      'center-x': (p, n) => ({ ...p, x: (area.left + area.right - n.w) / 2 }),
      'center-y': (p, n) => ({ ...p, y: (area.top + area.bottom - n.h) / 2 }),
    }[command];
    if (adjust) for (const node of nodes) if (!node.pinned) positions.set(node.id, adjust(positions.get(node.id), node));
    return positions;
  }

  return { tree, subtree, project, compute, align, avoidFixed, categoryName, matrixTracks, reclassifyCard, branchLanes, reflowBranch,
    foldedDescendants, isTreeMode, overlappingRevealRoots };
})();

const layoutOptions = [
  ['right', '向右逻辑图', 'M5 15H17M17 6V24M17 6H33M17 15H33M17 24H33'],
  ['double', '中心双侧', 'M22 15H12M12 6V24M12 6H4M12 24H4M22 15H32M32 6V24M32 6H40M32 24H40'],
  ['down', '上下树形', 'M22 4V13M8 13H36M8 13V24M22 13V24M36 13V24'],
  ['free', '自由摆放', 'M6 5h10v7H6ZM26 11h12v7H26ZM13 19h10v7H13Z'],
  ['timeline', '时间轴', 'M4 16H39M35 12l4 4-4 4M9 9V22M21 9V22M31 9V22'],
  ['matrix', '分类矩阵', 'M6 4h32v22H6ZM6 14h32M21 4v22'],
  ['fishbone', '鱼骨图', 'M4 15h36M35 10l5 5-5 5M8 6l10 9-10 9M22 6l10 9-10 9'],
];
const gapPresets = {compact:[12,40],standard:[24,76],spacious:[48,132]};
const matrixAxisTitles = { status: '状态', tone: '卡片类型', priority: '优先级' };
let layoutDraft = null;
let hierarchy = null;
let visibility = { hidden: new Set(), dimmed: new Set() };
let inheritedBranches = new Map();

function effectiveNodes(positions = layoutDraft?.result?.positions) {
  return board().nodes.map(node => positions?.has(node.id) ? { ...node, ...positions.get(node.id) } : node);
}

function layoutSelectionIds() {
  const { scope, selected } = layoutDraft;
  const ids = scope === 'branch' ? CanvasLayout.subtree(hierarchy, selected[0])
    : scope === 'selection' ? selected : hierarchy.order;
  const hidden = board().settings.folded.length ? CanvasLayout.foldedDescendants(hierarchy, board().settings.folded) : null;
  return new Set(hidden ? ids.filter(id => !hidden.has(id)) : ids);
}

function syncLayoutFields() {
  const {options, scope, selected, result} = layoutDraft;
  $('#layout-scope').value = scope;
  $('#layout-scope').querySelector('[value="branch"]').disabled = selected.length !== 1 || !(hierarchy.children.get(selected[0])?.length);
  $('#layout-scope').querySelector('[value="selection"]').disabled = selected.length < 2;
  const ids = layoutSelectionIds();
  const root = $('#layout-root');
  root.replaceChildren(new Option('自动选择', ''));
  for (const node of board().nodes.filter(node => ids.has(node.id))) root.add(new Option(titleOf(node), node.id));
  root.value = ids.has(options.rootId) ? options.rootId : '';
  root.disabled = options.mode === 'free';
  for (const button of $('#layout-modes').children) button.setAttribute('aria-pressed', String(button.dataset.layoutMode === options.mode));
  $('#layout-matrix').hidden = options.mode !== 'matrix';
  $('#layout-rows').value = options.rows;
  $('#layout-columns').value = options.columns;
  for (const [field, value] of [['node',options.nodeGap],['level',options.levelGap]]) {
    $('#layout-' + field + '-gap').value = value;
    $('#layout-' + field + '-gap-value').value = value + ' px';
  }
  for (const button of $('#layout-density').children) {
    const [nodeGap, levelGap] = gapPresets[button.dataset.layoutDensity];
    button.setAttribute('aria-pressed', String(nodeGap === options.nodeGap && levelGap === options.levelGap));
  }
  $('#layout-apply').disabled = !result;
  $('#layout-hint').textContent = result
    ? '预览 ' + result.positions.size + ' 张卡片 · 应用后可撤销'
    : '选择布局或调整间距，先在画布上查看预览。';
}

function calculateLayout(ids, options, scope, draftNodes = board().nodes) {
  if (options.rows === options.columns) options.columns = options.rows === 'tone' ? 'status' : 'tone';
  const tree = CanvasLayout.isTreeMode(options.mode) ? hierarchy : null;
  const hidden = board().settings.folded.length ? CanvasLayout.foldedDescendants(hierarchy, board().settings.folded) : null;
  const rects = (hidden ? draftNodes.filter(node => !hidden.has(node.id)) : draftNodes).map(cardRect);
  const nodes = rects.filter(node => ids.has(node.id));
  if (!nodes.length) return null;
  const result = CanvasLayout.compute(nodes, board().edges, {
    ...options, scope, hierarchy: tree, statuses: board().settings.statuses, obstacles: rects.filter(node => !ids.has(node.id)),
  });
  if ([...result.positions.values(), ...result.guides].some(({x,y,x2 = x,y2 = y}) =>
    [x,y,x2,y2].some(value => coordinate(value) !== value))) {
    toast('当前布局超出画布范围。', 'error');
    return null;
  }
  return result;
}

function layoutAnchor(ids, preferred, view = camera) {
  const shown = board().nodes.filter(node => ids.has(node.id) && !visibility.hidden.has(node.id));
  const chosen = preferred.find(id => shown.some(node => node.id === id));
  if (chosen) return chosen;
  let nearest = null;
  let distance = Infinity;
  for (const node of shown) {
    const { x, y, w, h } = cardRect(node);
    const next = Math.hypot(x + w / 2 - view.x, y + h / 2 - view.y);
    if (next >= distance) continue;
    nearest = node.id;
    distance = next;
  }
  return nearest;
}

function capturePositions(positions = activeLayoutPositions || layoutDraft?.result?.positions) {
  const map = new Map();
  for (const node of board().nodes) {
    const pos = positions?.get(node.id);
    map.set(node.id, { x: pos ? pos.x : node.x, y: pos ? pos.y : node.y });
  }
  return map;
}

function cancelPositionAnimation() {
  if (positionAnim?.frame) cancelAnimationFrame(positionAnim.frame);
  positionAnim = null;
  activeLayoutPositions = null;
}

function animatePositions(beforeMap, targetPositions = null, { duration = 230 } = {}) {
  cancelPositionAnimation();
  if (prefersReducedMotion() || duration <= 0 || !beforeMap?.size) return;
  const targets = new Map();
  const movingIds = new Set();
  for (const node of board().nodes) {
    if (visibility.hidden.has(node.id)) continue;
    const from = beforeMap.get(node.id);
    const to = targetPositions?.get(node.id) || { x: node.x, y: node.y };
    if (!from) continue;
    targets.set(node.id, { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
    if (Math.abs(to.x - from.x) > 0.5 || Math.abs(to.y - from.y) > 0.5) movingIds.add(node.id);
  }
  if (!movingIds.size) return;
  const currentPos = new Map();
  for (const [id, p] of targets) currentPos.set(id, { x: p.fromX, y: p.fromY });
  activeLayoutPositions = currentPos;
  const t0 = performance.now();
  const step = now => {
    const p = clamp((now - t0) / duration, 0, 1);
    const ease = 1 - Math.pow(1 - p, 4);
    for (const id of movingIds) {
      const t = targets.get(id);
      const x = t.fromX + (t.toX - t.fromX) * ease;
      const y = t.fromY + (t.toY - t.fromY) * ease;
      currentPos.set(id, { x, y });
      const view = cardIndex.get(id);
      if (view) placeCard(view.element, { ...nodeBy(id), x, y });
    }
    renderEdges(currentPos, movingIds);
    CanvasViews.renderFrames(currentPos, visibility.hidden);
    positionSelectionBar();
    scheduleMap();
    if (p < 1) {
      positionAnim.frame = requestAnimationFrame(step);
    } else {
      positionAnim = null;
      activeLayoutPositions = null;
      const settled = layoutDraft?.result?.positions;
      for (const id of movingIds) {
        const node = nodeBy(id);
        const view = cardIndex.get(id);
        if (node && view) placeCard(view.element, settled?.has(id) ? { ...node, ...settled.get(id) } : node);
      }
      renderEdges(settled);
      CanvasViews.renderFrames(settled, visibility.hidden);
      positionSelectionBar();
      scheduleMap();
    }
  };
  for (const id of movingIds) {
    const t = targets.get(id);
    const view = cardIndex.get(id);
    if (view) placeCard(view.element, { ...nodeBy(id), x: t.fromX, y: t.fromY });
  }
  renderEdges(currentPos, movingIds);
  CanvasViews.renderFrames(currentPos, visibility.hidden);
  positionAnim = { frame: requestAnimationFrame(step) };
}

function previewLayout(animate = true) {
  const before = animate ? capturePositions() : null;
  const {options, scope} = layoutDraft;
  const ids = layoutSelectionIds();
  if (scope !== 'board' && !ids.has(options.rootId)) options.rootId = scope === 'branch' ? layoutDraft.selected[0] : null;
  const result = calculateLayout(ids, options, scope);
  layoutDraft.result = result;
  layoutDraft.anchorId = result && CanvasLayout.isTreeMode(options.mode)
    ? layoutAnchor(result.positions, layoutDraft.selected, layoutDraft.camera) : null;
  if (result) viewport.dataset.preview = 'true';
  else delete viewport.dataset.preview;
  render();
  if (animate && result) animatePositions(before, result.positions);
  if (result && options.mode !== 'free') fitNodes(result.positions.keys(), true, layoutDraft.anchorId);
  syncLayoutFields();
}

function openLayout(scope = 'board') {
  if (layoutDraft) return cancelLayout();
  closePopover();
  closeSelectionSubPopovers();
  CanvasInspector.close();
  CanvasViews.close();
  CanvasViews.exitFocus();
  if (!board().nodes.length) return;
  layoutDraft = { scope, selected: noteIds(), options: { ...board().settings.layout }, camera: { ...camera }, result: null };
  $('#layout-panel').hidden = false;
  renderSelection();
  controls.arrange.setAttribute('aria-expanded', 'true');
  syncLayoutFields();
  $('#layout-modes').querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
}

function dismissLayout() {
  cancelPositionAnimation();
  const draft = layoutDraft;
  layoutDraft = null;
  $('#layout-panel').hidden = true;
  controls.arrange.setAttribute('aria-expanded', 'false');
  delete viewport.dataset.preview;
  return draft;
}

function cancelLayout() {
  if (!layoutDraft) return false;
  const before = capturePositions();
  const draft = dismissLayout();
  render();
  animatePositions(before);
  animateCamera(draft.camera, { duration: 240, temporary: true });
  focusCanvas();
  return true;
}

function commitLayout() {
  if (!layoutDraft?.result) return;
  const before = capturePositions();
  const previewCamera = { ...camera };
  const ids = layoutSelectionIds();
  const draft = dismissLayout();
  camera = draft.camera;
  applyLayout(ids, draft, previewCamera, before);
}

function autoArrange() {
  const current = board();
  const options = { ...current.settings.layout };
  if (options.mode === 'free') return toast('请先在「布局」中选择一种自动布局');
  if (!current.nodes.length) return;
  if (current.nodes.every(node => node.pinned)) return toast('这张画布的卡片都已固定');
  cancelGesture();
  CanvasInspector.close();
  CanvasViews.close();
  CanvasViews.exitFocus();
  const ids = new Set(current.nodes.map(node => node.id));
  const scope = 'board';
  const result = calculateLayout(ids, options, scope);
  if (result) applyLayout(ids, { options, scope, result });
}

function applyLayout(ids, { scope, options, result, edits, anchorId }, targetCamera = camera, beforeOverride = null) {
  const before = beforeOverride || capturePositions();
  const current = board();
  const settings = current.settings;
  const tree = CanvasLayout.isTreeMode(options.mode);
  const anchor = tree ? anchorId || layoutAnchor(result.positions, noteIds()) : null;
  const nextLayout = scope === 'board' ? options : settings.layout;
  const nextGuides = scope === 'board' ? result.guides : settings.guides;
  const moved = current.nodes.filter(node => {
    const position = result.positions.get(node.id);
    return position && (position.x !== node.x || position.y !== node.y);
  });
  const changedFreeView = options.mode === 'free' && ['x', 'y', 'scale'].some(key => targetCamera[key] !== camera[key]);
  if (!moved.length && !edits?.size && !changedFreeView && JSON.stringify(nextLayout) === JSON.stringify(settings.layout) &&
      JSON.stringify(nextGuides) === JSON.stringify(settings.guides)) {
    render();
    if (anchor && camera.scale < .8) {
      fitNodes(result.positions.keys(), true, anchor);
      current.view = { ...camera };
      save();
    }
    focusCanvas();
    toast('卡片已按当前布局排好');
    return;
  }
  checkpoint(true);
  for (const node of moved) Object.assign(edits?.get(node.id) || node, result.positions.get(node.id));
  if (edits?.size) current.nodes = current.nodes.map(node => edits.get(node.id) || node);
  settings.layout = nextLayout;
  settings.guides = nextGuides;
  camera = targetCamera;
  render();
  animatePositions(before);
  if (options.mode !== 'free') fitNodes(tree ? result.positions.keys() : ids, true, anchor);
  current.view = { ...camera };
  save();
  focusCanvas();
  toast(edits?.size ? '已更新分类，可撤销' : '已整理，可撤销');
}

function alignSelection(command) {
  const nodes = noteIds().map(nodeBy).filter(Boolean).map(cardRect);
  if (!command || nodes.length < 2) return;
  const result = CanvasLayout.align(nodes, command);
  if (nodes.every(node => result.get(node.id).x === node.x && result.get(node.id).y === node.y)) return;
  const before = capturePositions();
  applyChange(() => {
    for (const [id, position] of result) {
      Object.assign(nodeBy(id), { x: coordinate(position.x), y: coordinate(position.y) });
    }
  });
  animatePositions(before);
  focusCanvas();
}

function mountLayout() {
  for (const [key, name, drawing] of layoutOptions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layout-mode';
    button.dataset.layoutMode = key;
    const glyph = svg('svg', { viewBox: '0 0 44 30', 'aria-hidden':'true' });
    glyph.append(svg('path', {d:drawing}));
    button.append(glyph, name);
    $('#layout-modes').append(button);
  }
  $('#layout-panel').addEventListener('click', event => {
    if (!layoutDraft) return;
    const option = event.target.closest('[data-layout-mode],[data-layout-density]');
    if (!option) return;
    if (option.dataset.layoutMode) layoutDraft.options.mode = option.dataset.layoutMode;
    else [layoutDraft.options.nodeGap, layoutDraft.options.levelGap] = gapPresets[option.dataset.layoutDensity];
    previewLayout(true);
  });
  for (const id of ['layout-scope','layout-root','layout-rows','layout-columns']) {
    $('#' + id).addEventListener('change', event => {
      const value = event.target.value;
      const key = id.slice(7);
      if (key === 'scope') layoutDraft.scope = value;
      else layoutDraft.options[key === 'root' ? 'rootId' : key] = value || null;
      previewLayout(true);
    });
  }
  for (const [suffix, key] of [['node','nodeGap'],['level','levelGap']]) {
    $('#layout-' + suffix + '-gap').addEventListener('input', event => {
      layoutDraft.options[key] = Number(event.target.value);
      previewLayout(false);
    });
  }
  $('#layout-close').addEventListener('click', cancelLayout);
  $('#layout-cancel').addEventListener('click', cancelLayout);
  $('#layout-apply').addEventListener('click', commitLayout);
  $('#align-popover').addEventListener('click', event => {
    const item = event.target.closest('[data-align-cmd]');
    if (!item || item.disabled) return;
    const cmd = item.dataset.alignCmd;
    closeSelectionSubPopovers();
    alignSelection(cmd);
  });
}

function displayedLayout() {
  if (layoutDraft?.result) return { options: layoutDraft.options, guides: layoutDraft.result.guides };
  const { layout, guides } = board().settings;
  return { options: layout, guides };
}

const matrixDropHint = '拖到其他格子更改分类';
const matrixTrackAt = (tracks, value) => tracks.find(track => value >= track.start && value < track.end);

function paintMatrixKey(options, tracks) {
  const current = board();
  const key = $('#matrix-key');
  key.hidden = options.mode !== 'matrix' || !current.nodes.length;
  if (key.hidden) return;
  $('#matrix-axes').textContent = '行按' + matrixAxisTitles[options.rows] + ' · 列按' + matrixAxisTitles[options.columns];
  const hint = $('#matrix-drop-hint');
  hint.hidden = !!layoutDraft;
  hint.removeAttribute('data-target');
  hint.textContent = tracks ? matrixDropHint : '点「自动整理」生成可拖放的格子';
  const positions = layoutDraft?.result?.positions;
  const cards = current.nodes.filter(node => !node.pinned && !visibility.hidden.has(node.id) && (!positions || positions.has(node.id)));
  const example = cards.find(node => node.status) || cards[0];
  const description = $('#matrix-example');
  description.hidden = !example;
  if (!example) return;
  const title = [...titleOf(example)];
  const name = title.length <= 20 ? title.join('') : title.slice(0, 19).join('') + '…';
  const row = CanvasLayout.categoryName(options.rows, example, current.settings.statuses);
  const column = CanvasLayout.categoryName(options.columns, example, current.settings.statuses);
  description.textContent = '「' + name + '」对应「' + row + '」行和「' + column + '」列';
}

function paintLayoutGuides() {
  const { options, guides } = displayedLayout();
  const fragment = document.createDocumentFragment();
  const matrix = options.mode === 'matrix' && guides.length > 0;
  const tracks = matrix ? CanvasLayout.matrixTracks(options, guides, board().settings.statuses) : null;
  viewport.classList.toggle('is-matrix', matrix);
  paintMatrixKey(options, tracks);
  const columns = matrix ? guides.filter(guide => guide.kind === 'line' && guide.x === guide.x2) : [];
  const matrixLeft = Math.min(...columns.map(guide => guide.x));
  if (columns.length >= 2) {
    const rowLines = guides.filter(guide => guide.kind === 'line' && guide.y === guide.y2).sort((a, b) => a.y - b.y);
    const right = Math.max(...columns.map(guide => guide.x));
    for (let index = 0; index < rowLines.length - 1; index += 2) {
      const y = rowLines[index].y;
      fragment.append(svg('rect', {
        x: matrixLeft, y, width: right - matrixLeft, height: rowLines[index + 1].y - y, class: 'matrix-row-band',
      }));
    }
  }
  for (const guide of guides) {
    const {kind,x,y,x2,y2,text} = guide;
    if (kind === 'line') {
      fragment.append(svg('line', { x1:x, y1:y, x2,y2, class:'layout-guide' }));
      continue;
    }
    const label = { x, y, class: matrix ? 'layout-guide-label matrix-guide-label' : 'layout-guide-label' };
    const rowLabel = matrix && columns.length && x < matrixLeft;
    if (rowLabel) {
      label.x = matrixLeft - 12;
      label['text-anchor'] = 'end';
      label['dominant-baseline'] = 'middle';
    }
    const element = svg('text', label);
    const track = tracks && (rowLabel ? matrixTrackAt(tracks.rows,y) : matrixTrackAt(tracks.columns,x));
    element.textContent = track?.name ?? text;
    fragment.append(element);
  }
  $('#layout-guide-layer').replaceChildren(fragment);
}

function alignmentSnap(active, dx, dy) {
  const box = boundsOf([...active.nodes.values()]);
  if (!box) return { dx: 0, dy: 0, lines: [] };
  const threshold = 7 / camera.scale;
  const moving = [
    [box.left + dx, (box.left + box.right) / 2 + dx, box.right + dx],
    [box.top + dy, (box.top + box.bottom) / 2 + dy, box.bottom + dy],
  ];
  const best = [null, null];
  for (const node of board().nodes) {
    if (active.nodes.has(node.id) || visibility.hidden.has(node.id)) continue;
    const { x, y, w, h } = cardRect(node);
    const candidates = [[[x, x + w / 2, x + w], y, y + h], [[y, y + h / 2, y + h], x, x + w]];
    for (const axis of [0, 1]) {
      const [targets, min, max] = candidates[axis];
      for (const target of targets) {
        for (const value of moving[axis]) {
          const offset = target - value;
          if (Math.abs(offset) > threshold || (best[axis] && Math.abs(offset) >= Math.abs(best[axis].offset))) continue;
          best[axis] = { offset, target, min, max };
        }
      }
    }
  }
  const snapX = best[0]?.offset || 0;
  const snapY = best[1]?.offset || 0;
  const lines = [];
  if (best[0]) {
    const { target, min, max } = best[0];
    lines.push({ x1: target, x2: target, y1: Math.min(min, box.top + dy + snapY) - 10, y2: Math.max(max, box.bottom + dy + snapY) + 10 });
  }
  if (best[1]) {
    const { target, min, max } = best[1];
    lines.push({ y1: target, y2: target, x1: Math.min(min, box.left + dx + snapX) - 10, x2: Math.max(max, box.right + dx + snapX) + 10 });
  }
  return { dx: snapX, dy: snapY, lines };
}

function paintSnapLines(lines = []) {
  $('#alignment-layer').replaceChildren(...lines.map(line => svg('line', { ...line, class: 'snap-guide' })));
}

