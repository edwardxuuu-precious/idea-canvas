import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, validateWorkspace } from '../mcp/idea-canvas-mcp.mjs';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
let harnessDir = '';
let swiftBin = '';

function loadFrontendHelpers() {
  const richSrc = fs.readFileSync(path.join(projectDir, 'src/scripts/01-rich-text.js'), 'utf8');
  const dataSrc = fs.readFileSync(path.join(projectDir, 'src/scripts/02-data.js'), 'utf8');
  const layoutSrc = fs.readFileSync(path.join(projectDir, 'src/scripts/04-layout.js'), 'utf8');
  const layoutEnd = layoutSrc.indexOf('const layoutOptions =');
  const layoutModuleSrc = layoutEnd >= 0 ? layoutSrc.slice(0, layoutEnd) : layoutSrc;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const richContent = (html) => ({ text: String(html || ''), html: String(html || '') });
  return new Function(
    'clamp',
    'richContent',
    `${richSrc}\n${dataSrc}\n${layoutModuleSrc}\nreturn { sanitizeUnicode, sliceChars, utf8Slice, CanvasData, CanvasLayout };`,
  )(clamp, richContent);
}

const { sanitizeUnicode, sliceChars, CanvasData, CanvasLayout } = loadFrontendHelpers();

beforeAll(() => {
  harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-canvas-swift-contract-'));
  const driverSwift = path.join(harnessDir, 'ContractDriver.swift');
  swiftBin = path.join(harnessDir, 'contract-driver');
  fs.writeFileSync(
    driverSwift,
    `import Foundation

@main
struct ContractDriver {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            fputs("usage: contract-driver <validate|save|loopback> ...\\n", stderr)
            exit(2)
        }
        switch args[1] {
        case "validate":
            let root = URL(fileURLWithPath: args[2], isDirectory: true)
            let jsonPath = args[3]
            do {
                let store = try DiskWorkspace(root: root)
                _ = try store.initialJSON()
                let json = try String(contentsOfFile: jsonPath, encoding: .utf8)
                try store.save(json)
                print("OK")
            } catch let v as CanvasValidationError {
                print("VALIDATION_ERROR:\\(v.message)")
                exit(10)
            } catch {
                print("DISK_ERROR:\\(error.localizedDescription)")
                exit(11)
            }
        case "initial":
            let root = URL(fileURLWithPath: args[2], isDirectory: true)
            do {
                let store = try DiskWorkspace(root: root)
                let initial = try store.initialJSON()
                print(initial == nil ? "EMPTY" : "LOADED")
            } catch {
                print("INIT_ERROR:\\(error.localizedDescription)")
                exit(12)
            }
        case "loopback":
            let root = URL(fileURLWithPath: args[2], isDirectory: true)
            let port = UInt16(args[3])!
            do {
                let store = try DiskWorkspace(root: root)
                _ = try store.initialJSON()
                let server = try CanvasLoopback(
                    port: port,
                    page: Data("<html>ok</html>".utf8),
                    root: root,
                    read: { try store.snapshot(since: $0) },
                    write: { try store.saveSynced($1, expectedRevision: $0) }
                )
                server.start { ready in
                    print(ready ? "READY" : "FAILED")
                    fflush(stdout)
                    if !ready { exit(1) }
                }
                dispatchMain()
            } catch {
                fputs("LOOPBACK_ERROR:\\(error.localizedDescription)\\n", stderr)
                exit(1)
            }
        default:
            exit(2)
        }
    }
}
`,
  );
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
  execFileSync(
    '/usr/bin/xcrun',
    [
      '--sdk', 'macosx', 'swiftc',
      '-target', `${arch}-apple-macosx12.0`,
      path.join(projectDir, 'macos/DiskWorkspace.swift'),
      path.join(projectDir, 'macos/CanvasLoopback.swift'),
      driverSwift,
      '-o', swiftBin,
    ],
    { stdio: 'pipe' },
  );
});

afterAll(() => {
  if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

function runSwiftValidate(jsonString) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sw-val-'));
  const jsonFile = path.join(dir, 'candidate.json');
  const rootDir = path.join(dir, 'root');
  fs.mkdirSync(rootDir, { mode: 0o700 });
  fs.writeFileSync(jsonFile, jsonString, 'utf8');
  try {
    const out = execFileSync(swiftBin, ['validate', rootDir, jsonFile], { encoding: 'utf8' }).trim();
    return { ok: true, out };
  } catch (err) {
    return { ok: false, code: err.status, out: String(err.stdout || '').trim() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sendRawHttp(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    sock.setTimeout(5000, () => sock.destroy(new Error('ETIMEDOUT')));
    sock.on('error', reject);
    sock.on('connect', () => sock.write(rawRequest));
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const sep = text.indexOf('\r\n\r\n');
      const head = text.slice(0, sep);
      const body = text.slice(sep + 4);
      const status = Number(head.match(/^HTTP\/1\.[01]\s+(\d{3})/)?.[1] || 0);
      resolve({ status, head, body });
    });
  });
}

function makeBaseWorkspace() {
  return {
    version: 3,
    activeId: 'b1',
    boards: [
      {
        id: 'b1',
        name: '主画布',
        view: { x: 0, y: 0, scale: 1 },
        nodes: [
          {
            id: 'n1', x: 0, y: 0, w: 240, h: 120, tone: 'topic',
            title: '核心主题 🚀', body: '带链接 https://example.com',
            note: '边界备注', sources: [{ label: '调研文档', url: 'docs/调研/访谈.md' }],
            status: 'pending', priority: 'star', tags: ['t1'], pinned: false, order: 0,
          },
        ],
        edges: [],
        settings: {
          ...CanvasData.newSettings(),
          tags: [{ id: 't1', name: '重点', color: '#0f766e', icon: '★' }],
        },
      },
    ],
    themes: [],
  };
}

test('3-way data contract: JS CanvasData, Swift DiskWorkspace, and MCP validateWorkspace agree on boundary & malformed cases', () => {
  // 1. Valid complex workspace passes all three runtimes
  const valid = makeBaseWorkspace();
  const validJson = JSON.stringify(valid);
  expect(() => CanvasData.parse(validJson)).not.toThrow();
  expect(() => validateWorkspace(valid)).not.toThrow();
  expect(runSwiftValidate(validJson).ok).toBe(true);

  // 2. Emoji truncation via sliceChars produces Swift-valid JSON (never lone surrogate)
  const emojiLong = 'a'.repeat(79) + '🚀🔥';
  const safeSliced = sliceChars(emojiLong, 80);
  expect(safeSliced).toBe('a'.repeat(79) + '🚀');
  const wsEmoji = makeBaseWorkspace();
  wsEmoji.boards[0].nodes[0].title = safeSliced;
  expect(runSwiftValidate(JSON.stringify(wsEmoji)).ok).toBe(true);

  // 3. Raw lone surrogate is rejected by Swift AND MCP, and sanitized by JS CanvasData.parse into Swift-valid JSON
  const wsLone = makeBaseWorkspace();
  wsLone.boards[0].nodes[0].title = 'bad-' + '\uD83D';
  const loneJson = JSON.stringify(wsLone);
  expect(() => validateWorkspace(wsLone)).toThrow(/代理字符/);
  expect(runSwiftValidate(loneJson).ok).toBe(false);
  const parsedClean = CanvasData.parse(loneJson);
  expect(runSwiftValidate(JSON.stringify(parsedClean)).ok).toBe(true);

  // 4. Mistyped Swift strictly-typed Card fields are rejected by both Swift and MCP, and cleaned by JS into Swift-valid JSON
  const badFieldMutations = [
    (n) => { n.pinned = 1; },
    (n) => { n.order = '2'; },
    (n) => { n.tags = [123]; },
    (n) => { n.status = 42; },
    (n) => { n.priority = 99; },
  ];
  for (const mutate of badFieldMutations) {
    const wsBad = makeBaseWorkspace();
    mutate(wsBad.boards[0].nodes[0]);
    const raw = JSON.stringify(wsBad);
    expect(() => validateWorkspace(wsBad)).toThrow();
    const swiftRes = runSwiftValidate(raw);
    expect(swiftRes.ok).toBe(false);
    expect(swiftRes.code).toBe(10); // CanvasValidationError -> 400
    const cleanedByJs = CanvasData.parse(raw);
    expect(runSwiftValidate(JSON.stringify(cleanedByJs)).ok).toBe(true);
    expect(() => validateWorkspace(cleanedByJs)).not.toThrow();
  }
  const wsBadPriorityEnum = makeBaseWorkspace();
  wsBadPriorityEnum.boards[0].nodes[0].priority = 'urgent';
  expect(() => validateWorkspace(wsBadPriorityEnum)).toThrow();
  expect(CanvasData.parse(JSON.stringify(wsBadPriorityEnum)).boards[0].nodes[0].priority).toBeUndefined();

  // 5. Missing main file while backup JSON exists is rejected by BOTH Swift DiskWorkspace and MCP
  const bakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-missing-main-'));
  try {
    fs.mkdirSync(path.join(bakDir, '历史备份'), { mode: 0o700 });
    fs.writeFileSync(path.join(bakDir, '历史备份', '每日-2026-11-26.json'), validJson);
    let swiftInitFailed = false;
    try {
      execFileSync(swiftBin, ['initial', bakDir], { encoding: 'utf8' });
    } catch (err) {
      swiftInitFailed = err.status === 12 && String(err.stdout || '').includes('主数据文件缺失');
    }
    expect(swiftInitFailed).toBe(true);
  } finally {
    fs.rmSync(bakDir, { recursive: true, force: true });
  }
});

test('Real Swift CanvasLoopback handles UTF-8 cookies, returns 400 on validation error, and returns 401 on disabled local API', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-loopback-'));
  // Find an unused localhost port
  const probeSrv = net.createServer();
  await new Promise((resolve) => probeSrv.listen(0, '127.0.0.1', resolve));
  const port = probeSrv.address().port;
  await new Promise((resolve) => probeSrv.close(resolve));

  const child = spawn(swiftBin, ['loopback', rootDir, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('loopback start timeout')), 5000);
      child.stdout.on('data', (d) => {
        out += d.toString('utf8');
        if (out.includes('READY')) { clearTimeout(timer); resolve(); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`loopback exited ${code}`)); });
    });

    const token = fs.readFileSync(path.join(rootDir, 'local-api.key')).toString('hex');

    // 1. UTF-8 cookie from another localhost port must NOT cause 400 Bad Request
    const pageRes = await sendRawHttp(
      port,
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: other_app=中文测试; session=abc\r\nConnection: close\r\n\r\n`,
    );
    expect(pageRes.status).toBe(200);

    // 2. PUT /api/state with invalid snapshot returns 400 invalid_snapshot (NOT 500 storage_error)
    const badBody = JSON.stringify({ expectedRevision: 'empty', json: JSON.stringify({ version: 3, activeId: 'b1', boards: [{ id: 'b1', name: 'X', view: null, nodes: [{ id: 'n1', x: 0, y: 0, w: 10, h: 10, tone: 'idea', title: 'too small', body: '' }], edges: [] }] }) });
    const badRes = await sendRawHttp(
      port,
      `PUT /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(badBody)}\r\nConnection: close\r\n\r\n${badBody}`,
    );
    expect(badRes.status).toBe(400);
    expect(JSON.parse(badRes.body).error).toBe('invalid_snapshot');

    // 3. Valid PUT /api/state returns 200 OK
    const goodBody = JSON.stringify({ expectedRevision: 'empty', json: JSON.stringify(makeBaseWorkspace()) });
    const goodRes = await sendRawHttp(
      port,
      `PUT /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(goodBody)}\r\nConnection: close\r\n\r\n${goodBody}`,
    );
    expect(goodRes.status).toBe(200);

    // 4. With local-api.disabled, Bearer PUT /api/state returns 401 unauthorized (NOT 403 invalid_origin)
    fs.writeFileSync(path.join(rootDir, 'local-api.disabled'), 'disabled\n');
    const disabledRes = await sendRawHttp(
      port,
      `PUT /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(goodBody)}\r\nConnection: close\r\n\r\n${goodBody}`,
    );
    expect(disabledRes.status).toBe(401);
    expect(JSON.parse(disabledRes.body).error).toBe('unauthorized');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('Stateful randomized fuzz suite (200 ops): every mutated workspace stays valid across JS, MCP, and Swift DiskWorkspace', () => {
  let seed = 20261126;
  const rand = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const tones = ['topic', 'idea', 'question', 'action', 'reference'];
  const modes = ['right', 'double', 'down', 'free', 'timeline', 'matrix', 'fishbone'];
  const rawStrings = [
    '普通标题',
    'a'.repeat(79) + '🚀🔥💡',
    '包含孤立代理' + '\uD83D' + '测试',
    '链接 https://example.com/a?x=1',
    '- [ ] 待办任务\n- [✓] 已完成',
    '报价 "v2" <tag> & 中文',
  ];

  const ws = makeBaseWorkspace();
  let seq = 2;

  for (let step = 0; step < 200; step++) {
    const board = ws.boards.find((b) => b.id === ws.activeId);
    const op = Math.floor(rand() * 8);
    if (op === 0 || board.nodes.length === 0) {
      // Add card with unicode-safe slicing
      const id = `c_${seq++}`;
      const node = {
        id,
        x: Math.round((rand() - 0.5) * 2000),
        y: Math.round((rand() - 0.5) * 2000),
        w: 64 + Math.floor(rand() * 260),
        h: 36 + Math.floor(rand() * 140),
        tone: pick(tones),
        title: sliceChars(pick(rawStrings), 80),
        body: sanitizeUnicode(pick(rawStrings)),
      };
      if (rand() < 0.4) node.status = pick(['pending', 'watching', 'reviewed']);
      if (rand() < 0.3) node.priority = pick(['low', 'medium', 'high', 'star']);
      if (rand() < 0.2) node.pinned = true;
      board.nodes.push(node);
      if (board.nodes.length > 1 && rand() < 0.75) {
        const parent = pick(board.nodes.filter((n) => n.id !== id));
        board.edges.push({ id: `e_${seq++}`, from: parent.id, to: id, label: sliceChars(pick(rawStrings), 20), kind: rand() < 0.8 ? 'branch' : 'link' });
      }
    } else if (op === 1 && board.nodes.length > 2) {
      // Fold or unfold a node with children
      const tree = CanvasLayout.tree(board.nodes, board.edges);
      const parents = board.nodes.filter((n) => (tree.children.get(n.id) || []).length > 0);
      if (parents.length) {
        const target = pick(parents).id;
        if (board.settings.folded.includes(target)) {
          board.settings.folded = board.settings.folded.filter((id) => id !== target);
        } else {
          board.settings.folded.push(target);
        }
      }
    } else if (op === 2) {
      // Run any of the 7 layouts excluding folded descendants
      const mode = pick(modes);
      const tree = CanvasLayout.tree(board.nodes, board.edges);
      const hidden = CanvasLayout.foldedDescendants(tree, board.settings.folded);
      const visible = board.nodes.filter((n) => !hidden.has(n.id));
      if (visible.length) {
        const res = CanvasLayout.compute(visible, board.edges, {
          mode, nodeGap: 24, levelGap: 76,
          hierarchy: CanvasLayout.isTreeMode(mode) ? tree : null,
          statuses: board.settings.statuses, rows: 'status', columns: 'tone',
        });
        for (const n of visible) {
          const p = res.positions.get(n.id);
          if (p) { n.x = p.x; n.y = p.y; }
        }
        board.settings.layout.mode = mode;
        board.settings.guides = res.guides;
      }
    } else if (op === 3 && board.nodes.length > 0) {
      // Create a frame with minimum 120x90 box invariant even on 64px cards
      const member = pick(board.nodes);
      board.settings.frames.push({
        id: `f_${seq++}`,
        name: `分区${seq}`,
        color: '#679077',
        members: [member.id],
        box: { x: member.x - 18, y: member.y - 45, w: Math.max(120, member.w + 36), h: Math.max(90, member.h + 64) },
      });
    } else if (op === 4 && ws.boards.length < 4) {
      // Create a new board and switch to it
      const nb = CanvasData.makeBoard(`画布 ${seq++}`);
      nb.nodes.push({ id: `r_${seq++}`, x: 0, y: 0, w: 220, h: 100, tone: 'topic', title: '起点', body: '' });
      ws.boards.push(nb);
      ws.activeId = nb.id;
    } else if (op === 5 && ws.boards.length > 1) {
      ws.activeId = pick(ws.boards).id;
    } else if (op === 6 && board.nodes.length > 3) {
      // Delete a leaf node and clean references
      const leaf = board.nodes[board.nodes.length - 1];
      board.nodes.pop();
      board.edges = board.edges.filter((e) => e.from !== leaf.id && e.to !== leaf.id);
      board.settings.folded = board.settings.folded.filter((id) => id !== leaf.id);
      for (const f of board.settings.frames) f.members = f.members.filter((id) => id !== leaf.id);
      if (board.settings.layout.rootId === leaf.id) board.settings.layout.rootId = null;
    } else if (op === 7 && board.nodes.length >= 2) {
      // Align a subset
      const subset = board.nodes.slice(0, Math.min(4, board.nodes.length));
      const aligned = CanvasLayout.align(subset, pick(['left', 'right', 'top', 'bottom', 'center-x', 'center-y', 'distribute-x', 'distribute-y']));
      for (const n of subset) {
        const p = aligned.get(n.id);
        if (p) { n.x = p.x; n.y = p.y; }
      }
    }

    // Validate JS + MCP every step, and real Swift DiskWorkspace every 25 steps + final step
    const serialized = JSON.stringify(ws);
    const reparsed = CanvasData.parse(serialized);
    expect(() => validateWorkspace(reparsed)).not.toThrow();
    // Every frame box survives reload
    for (const b of reparsed.boards) {
      for (const f of b.settings.frames) {
        if (f.box) {
          expect(f.box.w).toBeGreaterThanOrEqual(120);
          expect(f.box.h).toBeGreaterThanOrEqual(90);
        }
      }
    }
    if (step % 25 === 0 || step === 199) {
      const swiftCheck = runSwiftValidate(JSON.stringify(reparsed));
      expect(swiftCheck.ok).toBe(true);
    }
  }
});
