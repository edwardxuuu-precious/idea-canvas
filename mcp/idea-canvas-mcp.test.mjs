import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRpcMessage, readLocalApiToken, runTool } from './idea-canvas-mcp.mjs';

const mcpEntry = fileURLToPath(new URL('./idea-canvas-mcp.mjs', import.meta.url));

function makeTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-canvas-mcp-test-'));
  return { dataDir: dir, port: 59999 };
}

test('offline CRUD, subtree guard, pre-deletion backup, and mirror sync work end-to-end', async () => {
  const cfg = makeTempEnv();
  try {
    const created = await runTool(
      'canvas_create_board',
      { name: '测试画布', boardId: 'test-board', rootTitle: '根主题', rootBody: '说明' },
      cfg,
    );
    expect(created.mode).toBe('offline');
    expect(created.boardId).toBe('test-board');

    const upserted = await runTool(
      'canvas_upsert_cards',
      {
        boardId: 'test-board',
        cards: [
          { id: 'c1', parentId: 'home', title: '卡片一', body: '第一行\n[链接](https://example.com)', tone: 'action' },
          { id: 'c2', parentId: 'c1', title: '子卡二', body: '第二行', tone: 'reference' },
        ],
      },
      cfg,
    );
    expect(upserted.created).toEqual(['c1', 'c2']);
    expect(upserted.nodeCount).toBe(3);

    const outline = await runTool('canvas_get_outline', { boardId: 'test-board', maxDepth: 3 }, cfg);
    expect(outline.outline[0].children[0].id).toBe('c1');
    expect(outline.outline[0].children[0].children[0].id).toBe('c2');

    const cards = await runTool('canvas_get_cards', { boardId: 'test-board', query: 'example.com' }, cfg);
    expect(cards.count).toBe(1);
    expect(cards.cards[0].id).toBe('c1');

    // Deleting non-leaf without deleteSubtree must throw
    await expect(runTool('canvas_delete_cards', { boardId: 'test-board', cardIds: ['c1'] }, cfg)).rejects.toThrow(
      /子卡片/,
    );

    // Deleting subtree succeeds and writes pre-deletion + daily backup
    const deleted = await runTool(
      'canvas_delete_cards',
      { boardId: 'test-board', cardIds: ['c1'], deleteSubtree: true },
      cfg,
    );
    expect(deleted.deleted.sort()).toEqual(['c1', 'c2']);
    expect(deleted.nodeCount).toBe(1);

    const backups = fs.readdirSync(path.join(cfg.dataDir, '历史备份'));
    expect(backups.some((f) => f.startsWith('每日-'))).toBe(true);
    expect(backups.some((f) => f.startsWith('删除前-'))).toBe(true);

    // Mirror sync check / pull / push
    const mirrorPath = path.join(cfg.dataDir, 'mirror.json');
    const disk = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, '画布数据.json'), 'utf8'));
    fs.writeFileSync(
      mirrorPath,
      JSON.stringify({ version: 3, activeId: 'test-board', boards: [disk.boards[0]], themes: [] }, null, 2),
    );
    const chk1 = await runTool('canvas_sync_mirror', { mirrorPath, direction: 'check' }, cfg);
    expect(chk1.alignment).toBe('same');
    // Establish initial baseline via pull when already in sync
    await runTool('canvas_sync_mirror', { mirrorPath, direction: 'pull' }, cfg);

    // Mutate mirror and push back
    const mirrorObj = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
    mirrorObj.boards[0].nodes[0].title = '根主题已更新';
    fs.writeFileSync(mirrorPath, JSON.stringify(mirrorObj, null, 2));
    const pushed = await runTool('canvas_sync_mirror', { mirrorPath, direction: 'push' }, cfg);
    expect(pushed.synced).toBe(true);
    const afterCards = await runTool('canvas_get_cards', { boardId: 'test-board', cardIds: ['home'] }, cfg);
    expect(afterCards.cards[0].title).toBe('根主题已更新');
  } finally {
    fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('MCP stdio framing handles initialize and tools/list over real child process', async () => {
  const cfg = makeTempEnv();
  try {
    const child = spawn('/Users/edward/.local/bin/node', [mcpEntry], {
      env: { ...process.env, IDEA_CANVAS_DATA_DIR: cfg.dataDir, IDEA_CANVAS_PORT: String(cfg.port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const replies = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      for (const line of buf.split('\n')) {
        if (line.trim().startsWith('{')) {
          replies.push(JSON.parse(line));
        }
      }
      const lastNl = buf.lastIndexOf('\n');
      if (lastNl >= 0) buf = buf.slice(lastNl + 1);
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n',
    );
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

    await new Promise((r) => setTimeout(r, 400));
    child.kill();
    expect(replies.length).toBe(2);
    expect(replies[0].result.protocolVersion).toBe('2025-03-26');
    expect(replies[1].result.tools.length).toBe(8);
  } finally {
    fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('live local API rejects unauthenticated and Origin-bearing Bearer requests, accepts bare Bearer', async () => {
  const liveDir = path.join(os.homedir(), 'Library', 'Application Support', '想法画布');
  const { enabled, token } = readLocalApiToken(liveDir);
  if (!enabled || !token) return;

  const probe = (headers) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port: 47471, method: 'GET', path: '/api/agent/health', headers, agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });

  let reachable = true;
  try {
    const ok = await probe({ Host: '127.0.0.1:47471', Authorization: `Bearer ${token}` });
    expect(ok).toBe(200);
  } catch (e) {
    if (e?.code === 'ECONNREFUSED') reachable = false;
    else throw e;
  }
  if (!reachable) return;

  expect(await probe({ Host: '127.0.0.1:47471' })).toBe(401);
  expect(await probe({ Host: '127.0.0.1:47471', Authorization: `Bearer ${token}`, Origin: 'http://evil.test' })).toBe(
    401,
  );
  const rpcInit = await handleRpcMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'canvas_status' } });
  expect(rpcInit.result.structuredContent.mode).toBe('live');
});
