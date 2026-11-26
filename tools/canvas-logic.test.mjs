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
