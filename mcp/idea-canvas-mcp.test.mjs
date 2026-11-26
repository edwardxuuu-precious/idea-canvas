import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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
          {
            id: 'c1',
            parentId: 'home',
            title: '卡片一',
            body: '第一行\n[链接](https://example.com)',
            note: '仅做边界说明',
            sources: [{ label: '示例来源', url: 'https://source.example.org/doc' }],
            tone: 'action',
          },
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

    const cards = await runTool('canvas_get_cards', { boardId: 'test-board', query: 'source.example.org' }, cfg);
    expect(cards.count).toBe(1);
    expect(cards.cards[0].id).toBe('c1');
    expect(cards.cards[0].note).toBe('仅做边界说明');
    expect(cards.cards[0].sources).toEqual([{ label: '示例来源', url: 'https://source.example.org/doc' }]);

    const diskAfterUpsert = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, '画布数据.json'), 'utf8'));
    const c1Disk = diskAfterUpsert.boards[0].nodes.find((n) => n.id === 'c1');
    const c2Disk = diskAfterUpsert.boards[0].nodes.find((n) => n.id === 'c2');
    expect(c1Disk.richBody).toContain('<a href="https://example.com/"');
    expect(c2Disk.richBody).toBeUndefined();

    // Clearing note and sources via null / [] works
    await runTool(
      'canvas_upsert_cards',
      { boardId: 'test-board', cards: [{ id: 'c1', note: null, sources: [] }] },
      cfg,
    );
    const afterClear = await runTool('canvas_get_cards', { boardId: 'test-board', cardIds: ['c1'] }, cfg);
    expect(afterClear.cards[0].note).toBeUndefined();
    expect(afterClear.cards[0].sources).toBeUndefined();

    // Restore provenance before mirror sync check
    await runTool(
      'canvas_upsert_cards',
      {
        boardId: 'test-board',
        cards: [
          {
            id: 'c1',
            note: '仅做边界说明',
            sources: [{ label: '示例来源', url: 'https://source.example.org/doc' }],
          },
        ],
      },
      cfg,
    );

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

    // Priority 'star', same-batch sibling ordering, richBody image preservation, and delete cleanup
    await runTool(
      'canvas_upsert_cards',
      {
        boardId: 'test-board',
        cards: [
          { id: 'a', parentId: 'home', title: 'A', priority: 'star' },
          { id: 'b', parentId: 'home', title: 'B', beforeSiblingId: 'a' },
          { id: 'c', parentId: 'home', title: 'C', afterSiblingId: 'b' },
        ],
      },
      cfg,
    );
    const batchOutline = await runTool('canvas_get_outline', { boardId: 'test-board', maxDepth: 2 }, cfg);
    expect(batchOutline.outline[0].children.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    const starRes = await runTool('canvas_get_cards', { boardId: 'test-board', cardIds: ['a'] }, cfg);
    expect(starRes.cards[0].priority).toBe('star');

    // Preserve embedded <img> in richBody when updating body, and preserve custom richBody when body unchanged
    const rawWs = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, '画布数据.json'), 'utf8'));
    const nodeA = rawWs.boards[0].nodes.find((n) => n.id === 'a');
    nodeA.body = '原正文';
    nodeA.richBody = '<img src="data:image/png;base64,AAAA" alt="图"><p><strong>原正文</strong></p>';
    rawWs.boards[0].settings.folded = ['a'];
    rawWs.boards[0].settings.frames = [{ id: 'f1', name: 'F1', color: '#6d9780', members: ['a', 'b'] }];
    fs.writeFileSync(path.join(cfg.dataDir, '画布数据.json'), JSON.stringify(rawWs));

    await runTool('canvas_upsert_cards', { boardId: 'test-board', cards: [{ id: 'a', title: 'A改名', body: '原正文' }] }, cfg);
    let wsAfterSameBody = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, '画布数据.json'), 'utf8'));
    expect(wsAfterSameBody.boards[0].nodes.find((n) => n.id === 'a').richBody).toContain('<strong>原正文</strong>');

    await runTool('canvas_upsert_cards', { boardId: 'test-board', cards: [{ id: 'a', body: '新正文' }] }, cfg);
    let wsAfterNewBody = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, '画布数据.json'), 'utf8'));
    expect(wsAfterNewBody.boards[0].nodes.find((n) => n.id === 'a').richBody).toContain('<img src="data:image/png;base64,AAAA"');

    // Enforce DiskWorkspace byte limits offline
    await expect(
      runTool('canvas_upsert_cards', { boardId: 'test-board', cards: [{ id: 'a', note: 'x'.repeat(16001) }] }, cfg),
    ).rejects.toThrow(/16KB/);
    await expect(
      runTool(
        'canvas_upsert_cards',
        { boardId: 'test-board', cards: [{ id: 'a', sources: Array.from({ length: 65 }, (_, i) => ({ label: `s${i}` })) }] },
        cfg,
      ),
    ).rejects.toThrow(/64/);

    // Deleting a cleans up settings.folded and frames[].members
    await runTool('canvas_delete_cards', { boardId: 'test-board', cardIds: ['a'] }, cfg);
    const wsAfterDeleteA = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, '画布数据.json'), 'utf8'));
    expect(wsAfterDeleteA.boards[0].settings.folded).toEqual([]);
    expect(wsAfterDeleteA.boards[0].settings.frames[0].members).toEqual(['b']);
    await runTool('canvas_delete_cards', { boardId: 'test-board', cardIds: ['b', 'c'] }, cfg);

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
      const sock = net.createConnection({ host: '127.0.0.1', port: 47471 });
      let raw = '';
      sock.setTimeout(3000);
      sock.on('timeout', () => {
        sock.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));
      });
      sock.on('error', reject);
      sock.on('connect', () => {
        const lines = ['GET /api/agent/health HTTP/1.1'];
        for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
        lines.push('Connection: close', '', '');
        sock.write(lines.join('\r\n'));
      });
      sock.on('data', (chunk) => {
        raw += chunk.toString('utf8');
        const m = raw.match(/^HTTP\/1\.[01]\s+(\d{3})/);
        if (m) {
          sock.destroy();
          resolve(Number(m[1]));
        }
      });
      sock.on('end', () => {
        const m = raw.match(/^HTTP\/1\.[01]\s+(\d{3})/);
        if (m) resolve(Number(m[1]));
        else reject(new Error(`Unexpected HTTP response: ${raw}`));
      });
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
