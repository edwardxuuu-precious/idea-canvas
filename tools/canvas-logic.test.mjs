import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function loadFrontendModules() {
  const richSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/01-rich-text.js', import.meta.url)), 'utf8');
  const dataSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/02-data.js', import.meta.url)), 'utf8');
  const layoutSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/04-layout.js', import.meta.url)), 'utf8');
  const clipSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/10-clipboard.js', import.meta.url)), 'utf8');
  const layoutEnd = layoutSrc.indexOf('const layoutOptions =');
  const layoutModuleSrc = layoutEnd >= 0 ? layoutSrc.slice(0, layoutEnd) : layoutSrc;
  const parseMdStart = clipSrc.indexOf('function parseMarkdownTree(');
  const parseMdEnd = clipSrc.indexOf('function buildInternalClipboard(');
  const parseMdSrc = clipSrc.slice(parseMdStart, parseMdEnd);

  const factory = new Function(
    'clamp',
    'richContent',
    `${richSrc}\n${dataSrc}\n${layoutModuleSrc}\n${parseMdSrc}\nreturn { utf8Slice, safeExternalUrl, cleanSourceUrl, CanvasData, CanvasLayout, parseMarkdownTree };`,
  );
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const richContent = (html) => ({ text: String(html || ''), html: String(html || '') });
  return factory(clamp, richContent);
}

const { utf8Slice, cleanSourceUrl, CanvasData, CanvasLayout, parseMarkdownTree } = loadFrontendModules();

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
    'boundsOf', 'CanvasViews', 'CanvasLayout', 'matrixTrackAt', 'hierarchy', 'edgeStyle', 'linkCurve',
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
    (a, b) => ({ path: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, label: { x: 0, y: 0 }, start: null, end: null }),
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
