import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function loadFrontendModules() {
  const dataSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/02-data.js', import.meta.url)), 'utf8');
  const layoutSrc = fs.readFileSync(fileURLToPath(new URL('../src/scripts/04-layout.js', import.meta.url)), 'utf8');
  const layoutEnd = layoutSrc.indexOf('const layoutOptions =');
  const layoutModuleSrc = layoutEnd >= 0 ? layoutSrc.slice(0, layoutEnd) : layoutSrc;

  const factory = new Function(
    'clamp',
    'safeExternalUrl',
    'richContent',
    `${dataSrc}\n${layoutModuleSrc}\nreturn { CanvasData, CanvasLayout };`,
  );
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const safeExternalUrl = (value) => (/^https?:\/\//i.test(String(value || '').trim()) ? String(value).trim() : null);
  const richContent = (html) => ({ text: String(html || ''), html: String(html || '') });
  return factory(clamp, safeExternalUrl, richContent);
}

const { CanvasData, CanvasLayout } = loadFrontendModules();

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
