import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function loadFrontendModules() {
  const richSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/01-rich-text.js', import.meta.url)), 'utf8');
  const dataSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/02-data.js', import.meta.url)), 'utf8');
  const layoutSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/04-layout.js', import.meta.url)), 'utf8');
  const renderSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/07-render.js', import.meta.url)), 'utf8');
  const clipSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/10-clipboard.js', import.meta.url)), 'utf8');
  const layoutEnd = layoutSrc.indexOf('const layoutOptions =');
  const layoutModuleSrc = layoutEnd >= 0 ? layoutSrc.slice(0, layoutEnd) : layoutSrc;
  const curveStart = renderSrc.indexOf('function connectionSide(');
  const curveEnd = renderSrc.indexOf('let nodeDepths =');
  const curveModuleSrc = renderSrc.slice(curveStart, curveEnd);
  const parseMdStart = clipSrc.indexOf('function parseMarkdownTree(');
  const parseMdEnd = clipSrc.indexOf('function buildInternalClipboard(');
  const parseMdSrc = clipSrc.slice(parseMdStart, parseMdEnd);

  const factory = new Function(
    'clamp',
    'richContent',
    `${richSrc}\n${dataSrc}\n${layoutModuleSrc}\n${curveModuleSrc}\n${parseMdSrc}\nreturn { utf8Slice, safeExternalUrl, cleanSourceUrl, CanvasData, CanvasLayout, linkCurve, routedBranchCurve, branchEdgeCurve, parseMarkdownTree };`,
  );
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const richContent = (html) => ({ text: String(html || ''), html: String(html || '') });
  return factory(clamp, richContent);
}

const {
  utf8Slice, cleanSourceUrl, CanvasData, CanvasLayout, linkCurve, routedBranchCurve, branchEdgeCurve, parseMarkdownTree,
} = loadFrontendModules();

test('CanvasData.parse migrates legacy default appearance and preserves valid subBoard links', () => {
  const legacy = {
    version: 3,
    activeId: 'b1',
    boards: [
      {
        id: 'b1',
        name: '主画布',
        view: null,
        nodes: [{ id: 'n1', x: 0, y: 0, w: 200, h: 100, tone: 'topic', title: '主卡', body: '', subBoardId: 'b2' }],
        edges: [],
        settings: {
          appearance: { background: '#f6f6ef', gridColor: '#a7b3a4', gridSize: 23, accent: '#347853', grid: 'dots' },
        },
      },
      {
        id: 'b2',
        name: '子画布',
        view: null,
        nodes: [{ id: 'n2', x: 10, y: 10, w: 200, h: 100, tone: 'idea', title: '子卡', body: '' }],
        edges: [],
        settings: { parentId: 'b1' },
      },
    ],
    themes: [],
  };
  const parsed = CanvasData.parse(JSON.stringify(legacy));
  expect(parsed.boards[0].settings.appearance.background).toBe('#f5f6f8');
  expect(parsed.boards[0].settings.appearance.accent).toBe('#0f766e');
  expect(parsed.boards[0].nodes[0].subBoardId).toBe('b2');
  expect(parsed.boards[1].settings.parentId).toBe('b1');
});

test('CanvasLayout tree, project, align, and compute behave consistently', () => {
  const nodes = [
    { id: 'r', x: 0, y: 0, w: 200, h: 100, tone: 'topic' },
    { id: 'a', x: 300, y: 0, w: 180, h: 80, tone: 'idea', order: 0 },
    { id: 'b', x: 300, y: 140, w: 180, h: 80, tone: 'action', order: 1 },
    { id: 'c', x: 560, y: 140, w: 180, h: 80, tone: 'reference', order: 2 },
  ];
  const edges = [
    { id: 'e1', from: 'r', to: 'a', kind: 'branch', label: '' },
    { id: 'e2', from: 'r', to: 'b', kind: 'branch', label: '' },
    { id: 'e3', from: 'b', to: 'c', kind: 'link', label: '' },
  ];
  const hierarchy = CanvasLayout.tree(nodes, edges);
  expect(hierarchy.roots).toEqual(['r']);
  expect(hierarchy.parent.get('c')).toBe('b');
  expect(CanvasLayout.subtree(hierarchy, 'b')).toEqual(['b', 'c']);

  const sub = CanvasLayout.project(hierarchy, new Set(['b', 'c']));
  expect(sub.roots).toEqual(['b']);
  expect(sub.children.get('b')).toEqual(['c']);

  const aligned = CanvasLayout.align([nodes[1], nodes[2]], 'left');
  expect(aligned.get('a').x).toBe(300);
  expect(aligned.get('b').x).toBe(300);

  const computed = CanvasLayout.compute(nodes, edges, { mode: 'right', nodeGap: 24, levelGap: 76 });
  expect(computed.positions.size).toBe(4);
  expect(computed.positions.get('a').x).toBeGreaterThan(computed.positions.get('r').x);
});

test('utf8Slice, cleanSourceUrl, and CanvasData.parse provenance limits match DiskWorkspace', () => {
  expect(utf8Slice('你好世界', 6)).toBe('你好');
  expect(Buffer.byteLength(utf8Slice('🚀🔥💡', 7), 'utf8')).toBeLessThanOrEqual(7);
  expect(cleanSourceUrl('docs/调研记录/访谈.md#L10')).toBe('docs/调研记录/访谈.md#L10');
  expect(cleanSourceUrl('https://example.com/a?x=1')).toBe('https://example.com/a?x=1');
  expect(cleanSourceUrl('javascript:alert(1)')).toBe('');

  const longNote = '中'.repeat(5000); // 15,000 bytes <= 16,000 limit
  const overNote = '中'.repeat(6000); // 18,000 bytes > 16,000 limit
  const sources64 = Array.from({ length: 64 }, (_, i) => ({
    label: `来源-${i}`,
    url: `docs/调研记录/第${i}份.md`,
  }));
  const ws = {
    version: 3,
    activeId: 'b1',
    boards: [
      {
        id: 'b1',
        name: '边界测试',
        view: null,
        nodes: [
          {
            id: 'n1', x: 0, y: 0, w: 240, h: 120, tone: 'topic', title: 'T1', body: '',
            note: longNote, sources: sources64,
          },
          {
            id: 'n2', x: 300, y: 0, w: 240, h: 120, tone: 'idea', title: 'T2', body: '',
            note: overNote, richBody: null,
          },
        ],
        edges: [],
        settings: {},
      },
    ],
    themes: [],
  };
  const parsed = CanvasData.parse(JSON.stringify(ws));
  expect(parsed.boards[0].nodes[0].note).toBe(longNote);
  expect(parsed.boards[0].nodes[0].sources.length).toBe(64);
  expect(parsed.boards[0].nodes[0].sources[0].url).toBe('docs/调研记录/第0份.md');
  expect(Buffer.byteLength(parsed.boards[0].nodes[1].note, 'utf8')).toBeLessThanOrEqual(16_000);
  expect(parsed.boards[0].nodes[1].richBody).toBeUndefined();
});

test('parseMarkdownTree preserves fenced code blocks and [✓] checklists', () => {
  const md = [
    '# 主题',
    '## 脚本示例',
    '```python',
    '# python comment should not become heading',
    '- not a list item',
    '```',
    '- [✓] 已完成的行动项',
    '  补充验收说明',
  ].join('\n');
  const tree = parseMarkdownTree(md);
  expect(tree).not.toBeNull();
  expect(tree.nodes.length).toBe(3);
  expect(tree.nodes[1].body).toContain('# python comment should not become heading');
  expect(tree.nodes[1].body).toContain('- not a list item');
  expect(tree.nodes[2].tone).toBe('action');
  expect(tree.nodes[2].body).toContain('- [✓] 已完成的行动项');
  expect(tree.nodes[2].body).toContain('补充验收说明');
});

test('CanvasLayout supports all 7 layout modes, edge cases, and orient safely', () => {
  const empty = CanvasLayout.compute([], [], { mode: 'right' });
  expect(empty.positions.size).toBe(0);

  const nodes = [
    { id: 'r', x: 0, y: 0, w: 220, h: 110, tone: 'topic', order: 0 },
    { id: 'a', x: 300, y: -60, w: 180, h: 80, tone: 'idea', status: 'pending', priority: 'high', order: 1 },
    { id: 'b', x: -300, y: 60, w: 180, h: 80, tone: 'action', status: 'reviewed', priority: 'star', order: 2 },
    { id: 'loose', x: 500, y: 300, w: 160, h: 70, tone: 'question', order: 3 },
  ];
  const edges = [
    { id: 'e1', from: 'r', to: 'a', kind: 'branch', label: '' },
    { id: 'e2', from: 'r', to: 'b', kind: 'branch', label: '' },
    { id: 'e3', from: 'a', to: 'b', kind: 'link', label: '' },
  ];
  const statuses = [
    { id: 'pending', name: '待验证', color: '#ad7429', icon: '○' },
    { id: 'reviewed', name: '已复盘', color: '#3d7c61', icon: '✓' },
  ];
  for (const mode of ['right', 'double', 'down', 'free', 'timeline', 'matrix', 'fishbone']) {
    const res = CanvasLayout.compute(nodes, edges, {
      mode, nodeGap: 24, levelGap: 76, rootId: 'r', statuses, rows: 'status', columns: 'tone',
    });
    expect(res.positions.size).toBe(4);
    for (const pos of res.positions.values()) {
      expect(Number.isFinite(pos.x)).toBe(true);
      expect(Number.isFinite(pos.y)).toBe(true);
    }
  }
  const allPinned = nodes.map((n) => ({ ...n, pinned: true }));
  const pinnedRes = CanvasLayout.compute(allPinned, edges, { mode: 'right' });
  expect(pinnedRes.positions.get('a')).toEqual({ x: 300, y: -60 });
});

test('CanvasData.exportHtml preserves clean static shell and escapes embedded workspace JSON', () => {
  const bundled = fs.readFileSync(fileURLToPath(new URL('../想法画布.html', import.meta.url)), 'utf8');
  const ws = {
    version: 3,
    activeId: 'b1',
    boards: [
      {
        id: 'b1',
        name: '导出测试',
        view: null,
        nodes: [{ id: 'n1', x: 0, y: 0, w: 220, h: 100, tone: 'topic', title: '<script>alert(1)</script>&', body: 'ok' }],
        edges: [],
        settings: CanvasData.newSettings(),
      },
    ],
    themes: [],
  };
  const exported = CanvasData.exportHtml(bundled, ws);
  expect(exported.startsWith('<!doctype html>\n<html lang="zh-CN">')).toBe(true);
  const headSlice = exported.slice(0, 240);
  expect(headSlice).not.toContain('data-chrome');
  expect(headSlice).not.toContain('data-desktop');
  expect(headSlice).not.toContain('style=');
  expect(exported).toContain('<!-- LOCAL_CANVAS_SYNC -->');
  expect(exported).not.toContain('<script>alert(1)</script>');
  const m = exported.match(/<script id="canvas-data" type="application\/json">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  const payload = JSON.parse(m[1]);
  const reparsed = CanvasData.parse(JSON.stringify(payload.workspace));
  expect(reparsed.boards[0].nodes[0].title).toBe('<script>alert(1)</script>&');
});

test('writeClipboardText routes desktop IPC, secure navigator.clipboard, and non-secure file:// execCommand fallback', async () => {
  const clipSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/10-clipboard.js', import.meta.url)), 'utf8');
  const start = clipSrc.indexOf('function copyTextWithExecCommand(');
  const end = clipSrc.indexOf('async function copySelectionAsMarkdown(');
  const helperSrc = clipSrc.slice(start, end);

  const loadHelper = (env) => new Function(
    'window', 'navigator', 'document', 'desktop',
    `${helperSrc}\nreturn { writeClipboardText };`,
  )(env.window, env.navigator, env.document, env.desktop);

  // 1. Direct clipboardData (copy/cut DOM event)
  let eventText = '';
  const { writeClipboardText: writeEvent } = loadHelper({ window: { isSecureContext: false }, navigator: {}, document: {}, desktop: null });
  expect(await writeEvent('from-event', { setData: (_t, v) => { eventText = v; } })).toBe(true);
  expect(eventText).toBe('from-event');

  // 2. macOS desktop bridge takes priority over navigator.clipboard on file://
  let ipcPayload = null;
  const { writeClipboardText: writeDesktop } = loadHelper({
    window: { isSecureContext: false },
    navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    document: {},
    desktop: { postMessage: async (msg) => { ipcPayload = msg; return true; } },
  });
  expect(await writeDesktop('# 桌面剪贴板')).toBe(true);
  expect(ipcPayload).toEqual({ operation: 'clipboard-write', text: '# 桌面剪贴板' });

  // 3. Non-secure file:// HTML falls back synchronously to execCommand('copy') and restores focus
  let restoredFocus = false;
  let copiedText = '';
  let removed = false;
  const prevActive = { focus: () => { restoredFocus = true; } };
  const fakeDoc = {
    activeElement: prevActive,
    body: { append: (el) => { fakeDoc._appended = el; } },
    contains: (el) => el === prevActive,
    createElement: () => ({
      value: '',
      style: {},
      setAttribute() {},
      focus() {},
      select() {},
      setSelectionRange() {},
      remove() { removed = true; },
    }),
    execCommand: (cmd) => {
      if (cmd === 'copy') {
        copiedText = fakeDoc._appended.value;
        return true;
      }
      return false;
    },
  };
  let asyncClipCalled = false;
  const { writeClipboardText: writeFile } = loadHelper({
    window: { isSecureContext: false },
    navigator: { clipboard: { writeText: async () => { asyncClipCalled = true; } } },
    document: fakeDoc,
    desktop: null,
  });
  expect(await writeFile('离线 HTML 复制')).toBe(true);
  expect(asyncClipCalled).toBe(false);
  expect(copiedText).toBe('离线 HTML 复制');
  expect(removed).toBe(true);
  expect(restoredFocus).toBe(true);
});

test('CanvasExport includes matrix, timeline, and fishbone guides in full-board SVG export and omits them for single-card export', () => {
  const exportSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/09-export.js', import.meta.url)), 'utf8');
  const exportStart = exportSrc.indexOf('const CanvasExport = (() => {');
  const canvasExportSrc = exportSrc.slice(exportStart);

  const nodes = [
    { id: 'r', x: 0, y: 0, w: 220, h: 100, tone: 'topic', title: '核心主题', body: '', status: 'pending' },
    { id: 'a', x: 320, y: 0, w: 180, h: 80, tone: 'idea', title: '子想法', body: '', status: 'reviewed' },
    { id: 'b', x: 320, y: 120, w: 180, h: 80, tone: 'action', title: '行动项', body: '', status: 'pending' },
  ];
  const edges = [
    { id: 'e1', from: 'r', to: 'a', kind: 'branch', label: '' },
    { id: 'e2', from: 'r', to: 'b', kind: 'branch', label: '' },
  ];
  const statuses = [
    { id: 'pending', name: '待验证', color: '#ad7429', icon: '○' },
    { id: 'reviewed', name: '已复盘', color: '#3d7c61', icon: '✓' },
  ];
  const currentBoard = {
    id: 'b1',
    name: '导图',
    nodes,
    edges,
    settings: {
      ...CanvasData.newSettings(),
      statuses,
      frames: [],
      guides: [],
    },
  };
  let currentLayout = { options: currentBoard.settings.layout, guides: [] };

  const fakeCtx = {
    font: '',
    fillStyle: '',
    measureText: (t) => ({ width: [...String(t)].length * 10 }),
  };
  const fakeDoc = {
    documentElement: {},
    createElement: () => ({ getContext: () => fakeCtx }),
  };
  const fakeViewport = {
    classList: { contains: () => false, remove() {}, toggle() {} },
  };
  const makeCardView = (n) => ({
    element: {
      hidden: false,
      dataset: { profile: 'title', tone: n.tone },
      offsetWidth: n.w,
      offsetHeight: n.h,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: n.w, height: n.h }),
      querySelector: () => null,
    },
    type: { hidden: true },
    title: { hidden: false, textContent: n.title, offsetLeft: 12, offsetTop: 12, offsetWidth: 160, offsetHeight: 24, offsetParent: null },
    body: { hidden: true, childNodes: [], querySelector: () => null, querySelectorAll: () => [] },
    meta: { hidden: true, children: [] },
    cover: { hidden: true, querySelector: () => null },
  });
  const cardIndex = new Map(nodes.map((n) => [n.id, makeCardView(n)]));
  for (const v of cardIndex.values()) v.title.offsetParent = v.element;

  const { CanvasExport } = new Function(
    'document', 'getComputedStyle', 'viewport', 'board', 'displayedLayout', 'visibility', 'cardRect',
    'boundsOf', 'CanvasViews', 'CanvasLayout', 'matrixTrackAt', 'hierarchy', 'edgeStyle', 'branchEdgeCurve',
    'lineDashes', 'cardIndex', 'titleOf',
    `${canvasExportSrc}\nreturn { CanvasExport };`,
  )(
    fakeDoc,
    () => ({
      fontFamily: 'sans-serif', fontStyle: 'normal', fontWeight: '600', fontSize: '14px', lineHeight: '20px',
      color: '#0f172a', backgroundColor: '#ffffff', backgroundImage: 'none', borderTopColor: '#e2e8f0',
      borderTopLeftRadius: '12px', borderTopWidth: '1px', paddingBottom: '12px', paddingLeft: '7px',
      getPropertyValue: (k) => ({ '--ink': '#0f172a', '--ink-soft': '#475569', '--paper': '#ffffff', '--line': '#e2e8f0', '--board-accent': '#0f766e', '--guide-ink': '#0f766e' }[k] || ''),
    }),
    fakeViewport,
    () => currentBoard,
    () => currentLayout,
    { hidden: new Set(), dimmed: new Set() },
    (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }),
    (rects) => ({ left: Math.min(...rects.map((r) => r.x)), top: Math.min(...rects.map((r) => r.y)), right: Math.max(...rects.map((r) => r.x + r.w)), bottom: Math.max(...rects.map((r) => r.y + r.h)), w: 100, h: 100 }),
    { frameRect: () => null },
    CanvasLayout,
    (tracks, value) => tracks.find((t) => value >= t.start && value < t.end),
    CanvasLayout.tree(nodes, edges),
    () => ({ color: '#64748b', width: 1.5, shape: 'curve', dash: 'solid', arrow: 'none' }),
    branchEdgeCurve,
    { dashed: '7 5', dotted: '1 5' },
    cardIndex,
    (n) => n.title,
  );

  for (const mode of ['matrix', 'timeline', 'fishbone']) {
    const opts = { ...currentBoard.settings.layout, mode, rows: 'status', columns: 'tone', statuses };
    const computed = CanvasLayout.compute(nodes, edges, opts);
    expect(computed.guides.length).toBeGreaterThan(0);
    for (const n of nodes) Object.assign(n, computed.positions.get(n.id));
    currentLayout = { options: opts, guides: computed.guides };

    const fullScene = CanvasExport.scene(null);
    const fullSvg = CanvasExport.toSVG(fullScene);
    const guideLines = fullScene.shapes.filter((s) => s.type === 'path' && s.opacity === 0.42);
    expect(guideLines.length).toBe(computed.guides.filter((g) => g.kind === 'line').length);
    if (mode === 'matrix') {
      expect(fullSvg).toContain('待验证');
      expect(fullSvg).toContain('已复盘');
      expect(fullSvg).toContain('主题');
      expect(fullSvg).toContain('paint-order="stroke"');
      expect(fullScene.shapes.some((s) => s.type === 'rect' && s.fillOpacity === 0.045)).toBe(true);
      expect(fullScene.shapes.some((s) => s.type === 'path' && s.opacity === 0.28)).toBe(true);
    } else if (mode === 'timeline') {
      expect(fullSvg).toContain('>1</tspan>');
      expect(fullSvg).toContain('>2</tspan>');
    }
    const singleScene = CanvasExport.scene(['a']);
    expect(singleScene.shapes.some((s) => s.type === 'path' && s.opacity === 0.42)).toBe(false);
  }
});

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function assertNoOverlaps(rects) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(rectsOverlap(rects[i], rects[j])).toBe(false);
    }
  }
}

function sampleSvgPath(d, steps = 40) {
  const tokens = d.match(/[MLQ]|-?\d+(?:\.\d+)?/g) || [];
  const points = [];
  let i = 0;
  let cur = { x: 0, y: 0 };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      cur = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
      points.push(cur);
    } else if (cmd === 'L') {
      const next = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        points.push({ x: cur.x + (next.x - cur.x) * t, y: cur.y + (next.y - cur.y) * t });
      }
      cur = next;
    } else if (cmd === 'Q') {
      const ctrl = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
      const next = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        points.push({
          x: u * u * cur.x + 2 * u * t * ctrl.x + t * t * next.x,
          y: u * u * cur.y + 2 * u * t * ctrl.y + t * t * next.y,
        });
      }
      cur = next;
    }
  }
  return points;
}

function pointInRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function makeStarTree(count, w = 200, h = 80) {
  const nodes = [{ id: 'root', x: 0, y: 0, w, h: 100, tone: 'topic', order: 0 }];
  const edges = [];
  for (let i = 0; i < count; i++) {
    const id = `c${i}`;
    nodes.push({ id, x: 0, y: i * 100, w, h, tone: 'idea', order: i + 1 });
    edges.push({ id: `e${i}`, from: 'root', to: id, kind: 'branch', label: '' });
  }
  return { nodes, edges };
}

test('CanvasLayout wraps ≥5 leaf children into 2–3 column-major grids in right mode and keeps exceptions single-column', () => {
  const opts = { mode: 'right', nodeGap: 24, levelGap: 76, rootId: 'root' };

  const tree6 = makeStarTree(6, 200, 80);
  const res6 = CanvasLayout.compute(tree6.nodes, tree6.edges, opts);
  const placed6 = tree6.nodes.map((n) => ({ ...n, ...res6.positions.get(n.id) }));
  assertNoOverlaps(placed6);
  const kids6 = placed6.slice(1);
  const xs6 = [...new Set(kids6.map((n) => n.x))].sort((a, b) => a - b);
  expect(xs6.length).toBe(2);
  expect(kids6.slice(0, 3).every((n) => n.x === xs6[0])).toBe(true);
  expect(kids6.slice(3, 6).every((n) => n.x === xs6[1])).toBe(true);
  expect(kids6[0].y).toBeLessThan(kids6[1].y);
  expect(kids6[1].y).toBeLessThan(kids6[2].y);
  expect(kids6[3].y).toBeLessThan(kids6[4].y);
  expect(kids6[4].y).toBeLessThan(kids6[5].y);

  const tree4 = makeStarTree(4, 200, 80);
  const res4 = CanvasLayout.compute(tree4.nodes, tree4.edges, opts);
  const xs4 = new Set(tree4.nodes.slice(1).map((n) => res4.positions.get(n.id).x));
  expect(xs4.size).toBe(1);

  const treeGrand = makeStarTree(6, 200, 80);
  treeGrand.nodes.push({ id: 'g0', x: 0, y: 0, w: 200, h: 80, tone: 'action', order: 99 });
  treeGrand.edges.push({ id: 'eg', from: 'c0', to: 'g0', kind: 'branch', label: '' });
  const resGrand = CanvasLayout.compute(treeGrand.nodes, treeGrand.edges, opts);
  const xsGrand = new Set(treeGrand.nodes.slice(1, 7).map((n) => resGrand.positions.get(n.id).x));
  expect(xsGrand.size).toBe(1);

  const tree10 = makeStarTree(10, 200, 80);
  const res10 = CanvasLayout.compute(tree10.nodes, tree10.edges, opts);
  const placed10 = tree10.nodes.map((n) => ({ ...n, ...res10.positions.get(n.id) }));
  assertNoOverlaps(placed10);
  const kids10 = placed10.slice(1);
  const xs10 = [...new Set(kids10.map((n) => n.x))].sort((a, b) => a - b);
  expect(xs10.length).toBe(3);
  expect(kids10.slice(0, 4).every((n) => n.x === xs10[0])).toBe(true);
  expect(kids10.slice(4, 8).every((n) => n.x === xs10[1])).toBe(true);
  expect(kids10.slice(8, 10).every((n) => n.x === xs10[2])).toBe(true);

  const resDown = CanvasLayout.compute(tree6.nodes, tree6.edges, { ...opts, mode: 'down' });
  const ysDown = new Set(tree6.nodes.slice(1).map((n) => resDown.positions.get(n.id).y));
  expect(ysDown.size).toBe(1);

  const mixedNodes = [
    { id: 'r', x: 0, y: 0, w: 200, h: 100, tone: 'topic', order: 0 },
    { id: 'a', x: 0, y: 0, w: 180, h: 80, tone: 'idea', order: 1 },
    { id: 'b', x: 0, y: 0, w: 180, h: 80, tone: 'idea', order: 2 },
    { id: 'b1', x: 0, y: 0, w: 180, h: 80, tone: 'idea', order: 3 },
    { id: 'b2', x: 0, y: 0, w: 180, h: 80, tone: 'action', order: 4 },
  ];
  const mixedEdges = [
    { id: 'ea', from: 'r', to: 'a', kind: 'branch', label: '' },
    { id: 'eb', from: 'r', to: 'b', kind: 'branch', label: '' },
    { id: 'eb1', from: 'b', to: 'b1', kind: 'branch', label: '' },
    { id: 'eb2', from: 'b1', to: 'b2', kind: 'branch', label: '' },
  ];
  for (let i = 0; i < 6; i++) {
    const id = `al${i}`;
    mixedNodes.push({ id, x: 0, y: 0, w: i >= 3 ? 500 : 160, h: 80, tone: 'idea', order: 10 + i });
    mixedEdges.push({ id: `eal${i}`, from: 'a', to: id, kind: 'branch', label: '' });
  }
  const mixedRes = CanvasLayout.compute(mixedNodes, mixedEdges, { mode: 'right', nodeGap: 24, levelGap: 76, rootId: 'r' });
  expect(mixedRes.positions.get('b2').x).toBe(788);

  const tree6Hierarchy = CanvasLayout.tree(tree6.nodes, tree6.edges);
  const reflow6 = CanvasLayout.reflowBranch(tree6.nodes, tree6Hierarchy, 'root', opts);
  expect(new Set([...reflow6.values()].map((p) => p.x)).size).toBe(2);
});

test('CanvasLayout double mode mirrors leaf-grid columns leftwards without overlap', () => {
  const nodes = [
    { id: 'root', x: 0, y: 0, w: 200, h: 100, tone: 'topic', order: 0 },
    { id: 'rightLeg', x: 280, y: 0, w: 180, h: 80, tone: 'idea', order: 1 },
    { id: 'leftLeg', x: -280, y: 0, w: 180, h: 80, tone: 'idea', order: 2 },
  ];
  const edges = [
    { id: 'er', from: 'root', to: 'rightLeg', kind: 'branch', label: '' },
    { id: 'el', from: 'root', to: 'leftLeg', kind: 'branch', label: '' },
  ];
  for (let i = 0; i < 6; i++) {
    const id = `lc${i}`;
    nodes.push({ id, x: -500, y: i * 90, w: 200, h: 80, tone: 'action', order: 10 + i });
    edges.push({ id: `elc${i}`, from: 'leftLeg', to: id, kind: 'branch', label: '' });
  }
  const preferredSides = new Map([['rightLeg', 'right'], ['leftLeg', 'left']]);
  const res = CanvasLayout.compute(nodes, edges, {
    mode: 'double', nodeGap: 24, levelGap: 76, rootId: 'root', preferredSides,
  });
  const placed = nodes.map((n) => ({ ...n, ...res.positions.get(n.id) }));
  assertNoOverlaps(placed);
  const byId = new Map(placed.map((n) => [n.id, n]));
  const root = byId.get('root');
  const leg = byId.get('leftLeg');
  expect(leg.x + leg.w).toBeLessThan(root.x);
  const leaves = placed.filter((n) => n.id.startsWith('lc'));
  const xs = [...new Set(leaves.map((n) => n.x))].sort((a, b) => b - a);
  expect(xs.length).toBe(2);
  expect(xs[0] + 200).toBeLessThan(leg.x);
  expect(xs[1] + 200).toBeLessThan(xs[0]);
});

test('routedBranchCurve routes around column-1 cards without entering them on both right and left sides', () => {
  const tree6 = makeStarTree(6, 200, 80);
  const resRight = CanvasLayout.compute(tree6.nodes, tree6.edges, { mode: 'right', nodeGap: 24, levelGap: 76, rootId: 'root' });
  const rightRects = tree6.nodes.map((n) => ({ ...n, ...resRight.positions.get(n.id) }));
  const rootRight = rightRects[0];
  const col1Right = rightRects.slice(1, 4);
  const col2Right = rightRects.slice(4, 7);

  for (const child of col1Right) {
    const siblings = rightRects.slice(1).filter((n) => n.id !== child.id);
    expect(routedBranchCurve(rootRight, child, siblings, 24)).toBeNull();
  }
  for (const child of col2Right) {
    const siblings = rightRects.slice(1).filter((n) => n.id !== child.id);
    const curve = routedBranchCurve(rootRight, child, siblings, 24);
    expect(curve).not.toBeNull();
    expect(curve.start).toEqual({ x: rootRight.x + rootRight.w + 2, y: rootRight.y + rootRight.h / 2, dx: -1, dy: 0 });
    expect(curve.end).toEqual({ x: child.x - 3, y: child.y + child.h / 2, dx: 1, dy: 0 });
    expect(curve.label).toBeDefined();
    for (const pt of sampleSvgPath(curve.path)) {
      for (const blocker of col1Right) expect(pointInRect(pt, blocker)).toBe(false);
    }
  }

  const leftParent = { id: 'lp', x: -256, y: 0, w: 180, h: 80 };
  const leftSiblings = [
    { id: 'l0', x: -532, y: 0, w: 200, h: 80 },
    { id: 'l1', x: -532, y: 104, w: 200, h: 80 },
    { id: 'l2', x: -532, y: 208, w: 200, h: 80 },
    { id: 'l3', x: -768, y: 0, w: 200, h: 80 },
    { id: 'l4', x: -768, y: 104, w: 200, h: 80 },
    { id: 'l5', x: -768, y: 208, w: 200, h: 80 },
  ];
  for (const child of leftSiblings.slice(3)) {
    const curve = routedBranchCurve(leftParent, child, leftSiblings.filter((s) => s.id !== child.id), 24);
    expect(curve).not.toBeNull();
    expect(curve.start).toEqual({ x: leftParent.x - 2, y: leftParent.y + leftParent.h / 2, dx: 1, dy: 0 });
    expect(curve.end).toEqual({ x: child.x + child.w + 3, y: child.y + child.h / 2, dx: -1, dy: 0 });
    for (const pt of sampleSvgPath(curve.path)) {
      for (const blocker of leftSiblings.slice(0, 3)) expect(pointInRect(pt, blocker)).toBe(false);
    }
  }

  const tree10 = makeStarTree(10, 200, 80);
  const res10 = CanvasLayout.compute(tree10.nodes, tree10.edges, { mode: 'right', nodeGap: 24, levelGap: 76, rootId: 'root' });
  const rects10 = tree10.nodes.map((n) => ({ ...n, ...res10.positions.get(n.id) }));
  const col3Blockers = rects10.slice(1, 9);
  for (const child of rects10.slice(9)) {
    const siblings = rects10.slice(1).filter((n) => n.id !== child.id);
    const curve = routedBranchCurve(rects10[0], child, siblings, 24);
    expect(curve).not.toBeNull();
    for (const pt of sampleSvgPath(curve.path)) {
      for (const blocker of col3Blockers) expect(pointInRect(pt, blocker)).toBe(false);
    }
  }

  const rectMap = new Map(rightRects.map((r) => [r.id, r]));
  const tree6H = CanvasLayout.tree(tree6.nodes, tree6.edges);
  const edgeCol2 = tree6.edges[4];
  const routedCurveMode = branchEdgeCurve(edgeCol2, rootRight, rightRects[5], rectMap, tree6H, { mode: 'right', nodeGap: 24 }, 'curve');
  expect(routedCurveMode.path).toContain(' Q ');
  const timelineCurve = branchEdgeCurve(edgeCol2, rootRight, rightRects[5], rectMap, tree6H, { mode: 'timeline', nodeGap: 24 }, 'curve');
  expect(timelineCurve.path).not.toContain(' Q ');
  expect(timelineCurve.path).toContain(' C ');
  const linkEdgeCurve = branchEdgeCurve({ ...edgeCol2, kind: 'link' }, rootRight, rightRects[5], rectMap, tree6H, { mode: 'right', nodeGap: 24 }, 'curve');
  expect(linkEdgeCurve.path).toContain(' C ');
});
