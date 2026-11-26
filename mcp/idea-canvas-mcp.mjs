#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_TONES = new Set(['topic', 'idea', 'question', 'action', 'reference']);
const VALID_EDGE_KINDS = new Set(['branch', 'link']);
const VALID_PRIORITIES = new Set(['none', 'high', 'medium', 'low', 'star']);
const SIZE_LIMIT = 1_000_000;
const COORD_LIMIT = 1_000_000_000;

export class CanvasToolError extends Error {
  constructor(message, code = 'canvas_error') {
    super(message);
    this.code = code;
  }
}

export function getConfig(overrides = {}) {
  const dataDir =
    overrides.dataDir ??
    process.env.IDEA_CANVAS_DATA_DIR ??
    path.join(os.homedir(), 'Library', 'Application Support', '想法画布');
  const port = Number(overrides.port ?? process.env.IDEA_CANVAS_PORT ?? 47471);
  return { dataDir, port };
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function boardDigest(board) {
  const { view: _view, ...rest } = board;
  return sha256Hex(canonicalJSON(rest));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function safeLinkHref(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function renderInlineLinksHtml(text) {
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|([^（()\n；·，。：]+?)（(https?:\/\/[^\s）<>"']+)）/g;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(linkRe)) {
    out += escapeHtml(text.slice(last, m.index));
    const label = (m[1] || m[3] || '').trim();
    const href = safeLinkHref(m[2] || m[4]);
    if (href && label) {
      out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    } else {
      out += escapeHtml(m[0]);
    }
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function bodyToRichHtml(body) {
  if (!body) return '';
  const lines = body.split('\n');
  const checklistRe = /^(\s*[-*]\s*\[)([ xX✓])(\]\s+)(.*)$/;
  const out = [];
  let inList = false;
  for (const line of lines) {
    const cm = line.match(checklistRe);
    if (cm) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      const done = cm[2] === ' ' ? 'false' : 'true';
      out.push(`<li data-done="${done}">${renderInlineLinksHtml(cm[4])}</li>`);
    } else {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(`<p>${renderInlineLinksHtml(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

export function makeRichBody(body) {
  if (!body) return undefined;
  const hasInlineLink =
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|([^（()\n；·，。：]+?)（(https?:\/\/[^\s）<>"']+)）/.test(body);
  if (!hasInlineLink) return undefined;
  return bodyToRichHtml(body);
}

function estimateCardHeight(title, body, hasMeta = false) {
  const wrapCount = (text, perLine) =>
    (text || '')
      .split('\n')
      .reduce((sum, line) => sum + Math.max(1, Math.ceil([...line.trim()].length / perLine)), 0);
  const titleLines = title?.trim() ? wrapCount(title, 14) : 1;
  const bodyLines = body?.trim() ? wrapCount(body, 19) : 0;
  return Math.max(96, 54 + titleLines * 24 + bodyLines * 23 + (hasMeta ? 34 : 0));
}

export function isValidId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

export function validateWorkspace(space, label = '画布工作区') {
  if (!space || typeof space !== 'object' || ![1, 2, 3].includes(space.version)) {
    throw new CanvasToolError(`${label}版本号无效。`, 'invalid_workspace');
  }
  if (!Array.isArray(space.boards) || space.boards.length === 0) {
    throw new CanvasToolError(`${label}缺少画布列表。`, 'invalid_workspace');
  }
  const boardIds = new Set();
  for (const board of space.boards) {
    if (!board || !isValidId(board.id) || boardIds.has(board.id)) {
      throw new CanvasToolError(`${label}画布 ID 无效或重复。`, 'invalid_workspace');
    }
    boardIds.add(board.id);
    if (typeof board.name !== 'string') {
      throw new CanvasToolError(`${label}画布名称无效。`, 'invalid_workspace');
    }
    if (board.view !== null) {
      if (!board.view || typeof board.view !== 'object' || Array.isArray(board.view)) {
        throw new CanvasToolError(`${label}画布视图格式无效。`, 'invalid_workspace');
      }
      const { x, y, scale } = board.view;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(scale) ||
        x < -COORD_LIMIT ||
        x > COORD_LIMIT ||
        y < -COORD_LIMIT ||
        y > COORD_LIMIT ||
        scale < 0.08 ||
        scale > 3
      ) {
        throw new CanvasToolError(`${label}画布视图位置或缩放无效。`, 'invalid_workspace');
      }
    }
    if (!Array.isArray(board.nodes) || !Array.isArray(board.edges)) {
      throw new CanvasToolError(`${label}缺少节点或连线数组。`, 'invalid_workspace');
    }
    const cardIds = new Set();
    for (const card of board.nodes) {
      if (!card || !isValidId(card.id) || cardIds.has(card.id)) {
        throw new CanvasToolError(`${label}卡片 ID 无效或重复：${card?.id}`, 'invalid_workspace');
      }
      cardIds.add(card.id);
      if (
        !Number.isFinite(card.x) ||
        !Number.isFinite(card.y) ||
        !Number.isFinite(card.w) ||
        !Number.isFinite(card.h) ||
        card.x < -COORD_LIMIT ||
        card.x > COORD_LIMIT ||
        card.y < -COORD_LIMIT ||
        card.y > COORD_LIMIT ||
        card.w < 64 ||
        card.w > SIZE_LIMIT ||
        card.h < 36 ||
        card.h > SIZE_LIMIT
      ) {
        throw new CanvasToolError(`${label}卡片坐标或尺寸无效：${card.id}`, 'invalid_workspace');
      }
      if (!VALID_TONES.has(card.tone) || typeof card.title !== 'string' || typeof card.body !== 'string') {
        throw new CanvasToolError(`${label}卡片类型或文本无效：${card.id}`, 'invalid_workspace');
      }
      if (card.richBody !== undefined && card.richBody !== null && typeof card.richBody !== 'string') {
        throw new CanvasToolError(`${label}卡片富文本无效：${card.id}`, 'invalid_workspace');
      }
      if (card.subBoardId !== undefined && card.subBoardId !== null && !isValidId(card.subBoardId)) {
        throw new CanvasToolError(`${label}子画布 ID 无效：${card.id}`, 'invalid_workspace');
      }
      if (card.note !== undefined && card.note !== null) {
        if (typeof card.note !== 'string') {
          throw new CanvasToolError(`${label}卡片备注无效：${card.id}`, 'invalid_workspace');
        }
        if (Buffer.byteLength(card.note, 'utf8') > 16_000) {
          throw new CanvasToolError(`${label}卡片备注超出 16KB 限制：${card.id}`, 'note_too_long');
        }
      }
      if (card.sources !== undefined && card.sources !== null) {
        if (!Array.isArray(card.sources)) {
          throw new CanvasToolError(`${label}卡片来源列表无效：${card.id}`, 'invalid_workspace');
        }
        if (card.sources.length > 64) {
          throw new CanvasToolError(`${label}卡片来源数量超出 64 条限制：${card.id}`, 'too_many_sources');
        }
        for (const src of card.sources) {
          const trimmedLabel = typeof src?.label === 'string' ? src.label.trim() : '';
          if (
            !src ||
            typeof src !== 'object' ||
            !trimmedLabel ||
            Buffer.byteLength(trimmedLabel, 'utf8') > 600 ||
            (src.url !== undefined && src.url !== null && (typeof src.url !== 'string' || Buffer.byteLength(src.url, 'utf8') > 4096))
          ) {
            throw new CanvasToolError(`${label}卡片来源项无效或超出长度限制：${card.id}`, 'invalid_workspace');
          }
        }
      }
    }
    const edgeIds = new Set();
    const pairs = new Set();
    for (const edge of board.edges) {
      if (!edge || !isValidId(edge.id) || edgeIds.has(edge.id)) {
        throw new CanvasToolError(`${label}连线 ID 无效或重复：${edge?.id}`, 'invalid_workspace');
      }
      edgeIds.add(edge.id);
      if (!VALID_EDGE_KINDS.has(edge.kind) || typeof edge.label !== 'string') {
        throw new CanvasToolError(`${label}连线类型或标签无效：${edge.id}`, 'invalid_workspace');
      }
      if (!cardIds.has(edge.from) || !cardIds.has(edge.to) || edge.from === edge.to) {
        throw new CanvasToolError(`${label}连线端点无效：${edge.id}`, 'invalid_workspace');
      }
      const pair = edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`;
      if (pairs.has(pair)) {
        throw new CanvasToolError(`${label}存在重复连线：${pair}`, 'invalid_workspace');
      }
      pairs.add(pair);
    }
  }
  if (!boardIds.has(space.activeId)) {
    throw new CanvasToolError(`${label}找不到当前激活画布。`, 'invalid_workspace');
  }
  return space;
}

export function readLocalApiToken(dataDir) {
  const disabledMarker = path.join(dataDir, 'local-api.disabled');
  if (fs.existsSync(disabledMarker)) {
    return { enabled: false, token: null };
  }
  const keyPath = path.join(dataDir, 'local-api.key');
  if (!fs.existsSync(keyPath)) {
    return { enabled: true, token: null };
  }
  const stat = fs.lstatSync(keyPath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== 32) {
    throw new CanvasToolError('local-api.key 权限或格式无效（需为当前用户 0600 权限的 32 字节密钥）。', 'invalid_key');
  }
  const buf = fs.readFileSync(keyPath);
  if (buf.length !== 32) {
    throw new CanvasToolError('local-api.key 长度无效。', 'invalid_key');
  }
  return { enabled: true, token: buf.toString('hex') };
}

function parseHttpResponse(chunks, expectedStatuses) {
  const buf = Buffer.concat(chunks);
  const sep = buf.indexOf('\r\n\r\n');
  if (sep === -1) return { incomplete: true };
  const headText = buf.subarray(0, sep).toString('utf8');
  const [statusLine, ...rawHeaders] = headText.split('\r\n');
  const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
  if (!m) {
    return { error: new CanvasToolError(`无法解析 HTTP 状态行：${statusLine}`, 'http_error') };
  }
  const statusCode = Number(m[1]);
  let isChunked = false;
  let contentLength = null;
  for (const h of rawHeaders) {
    const idx = h.indexOf(':');
    if (idx <= 0) continue;
    const name = h.slice(0, idx).trim().toLowerCase();
    const val = h.slice(idx + 1).trim();
    if (name === 'transfer-encoding' && val.toLowerCase().includes('chunked')) isChunked = true;
    if (name === 'content-length' && /^\d+$/.test(val)) contentLength = Number(val);
  }
  let bodyBuf = buf.subarray(sep + 4);
  if (isChunked) {
    const parts = [];
    let pos = 0;
    let sawZero = false;
    while (pos < bodyBuf.length) {
      const nl = bodyBuf.indexOf('\r\n', pos);
      if (nl === -1) return { incomplete: true };
      const sizeHex = bodyBuf.subarray(pos, nl).toString('ascii').split(';')[0].trim();
      if (!/^[0-9a-fA-F]+$/.test(sizeHex)) {
        return { error: new CanvasToolError('本机服务分块响应格式无效。', 'http_error') };
      }
      const size = parseInt(sizeHex, 16);
      if (size === 0) {
        sawZero = true;
        break;
      }
      const chunkEnd = nl + 2 + size;
      if (chunkEnd + 2 > bodyBuf.length) return { incomplete: true };
      parts.push(bodyBuf.subarray(nl + 2, chunkEnd));
      pos = chunkEnd + 2;
    }
    if (!sawZero) return { incomplete: true };
    bodyBuf = Buffer.concat(parts);
  } else if (contentLength !== null && bodyBuf.length < contentLength) {
    return { incomplete: true };
  } else if (contentLength !== null && bodyBuf.length > contentLength) {
    bodyBuf = bodyBuf.subarray(0, contentLength);
  }
  const text = bodyBuf.toString('utf8');
  if (!expectedStatuses.includes(statusCode)) {
    return {
      error: new CanvasToolError(
        `想法画布本机服务返回 HTTP ${statusCode}: ${text}`,
        statusCode === 401 ? 'unauthorized' : statusCode === 409 ? 'conflict' : 'http_error',
      ),
    };
  }
  return { result: { status: statusCode, body: text } };
}

function httpCall(port, method, reqPath, { bearer, body, expectedStatuses }) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const host = port === 80 ? '127.0.0.1' : `127.0.0.1:${port}`;
  const headerLines = [`${method} ${reqPath} HTTP/1.1`, `Host: ${host}`, 'Connection: close'];
  if (bearer) headerLines.push(`Authorization: Bearer ${bearer}`);
  if (payload !== undefined) {
    headerLines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(payload, 'utf8')}`);
  }
  const rawRequest = `${headerLines.join('\r\n')}\r\n\r\n${payload ?? ''}`;

  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    let settled = false;
    const settleOk = (res) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(res);
    };
    const settleErr = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(10_000, () => {
      settleErr(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    });
    sock.on('error', (err) => {
      const parsed = chunks.length ? parseHttpResponse(chunks, expectedStatuses) : null;
      if (parsed?.error) return settleErr(parsed.error);
      if (parsed?.result) return settleOk(parsed.result);
      settleErr(err);
    });
    sock.on('connect', () => {
      sock.write(rawRequest);
    });
    sock.on('data', (chunk) => {
      chunks.push(chunk);
      const parsed = parseHttpResponse(chunks, expectedStatuses);
      if (parsed.error) return settleErr(parsed.error);
      if (parsed.result) return settleOk(parsed.result);
    });
    sock.on('end', () => {
      if (settled) return;
      const parsed = parseHttpResponse(chunks, expectedStatuses);
      if (parsed.error) return settleErr(parsed.error);
      if (parsed.result) return settleOk(parsed.result);
      settleErr(new CanvasToolError('本机服务 HTTP 响应不完整。', 'http_error'));
    });
  });
}

function checkDirectoryLock(dataDir) {
  if (!fs.existsSync(dataDir)) return false;
  const stat = fs.lstatSync(dataDir);
  if (!stat.isDirectory()) {
    throw new CanvasToolError(`画布数据路径不是有效目录（或为符号链接）：${dataDir}`, 'invalid_data_dir');
  }
  const py = [
    'import fcntl, os, sys',
    'fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    'try:',
    '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    '    fcntl.flock(fd, fcntl.LOCK_UN)',
    '    print("UNLOCKED")',
    'except BlockingIOError:',
    '    print("LOCKED")',
    'finally:',
    '    os.close(fd)',
  ].join('\n');
  const out = execFileSync('python3', ['-c', py, dataDir], { encoding: 'utf8' }).trim();
  return out === 'LOCKED';
}

function sameWorkspaceContent(a, b) {
  if (!a || !b) return false;
  if (canonicalJSON(a.themes ?? []) !== canonicalJSON(b.themes ?? [])) return false;
  if (a.boards.length !== b.boards.length) return false;
  return a.boards.every((ba, i) => {
    const bb = b.boards[i];
    return (
      ba.id === bb.id &&
      ba.name === bb.name &&
      canonicalJSON(ba.nodes) === canonicalJSON(bb.nodes) &&
      canonicalJSON(ba.edges) === canonicalJSON(bb.edges) &&
      canonicalJSON(ba.settings ?? null) === canonicalJSON(bb.settings ?? null)
    );
  });
}

function deletesContent(nextSpace, prevSpace) {
  if (!prevSpace) return false;
  const nextBoards = new Map(nextSpace.boards.map((b) => [b.id, b]));
  return prevSpace.boards.some((oldBoard) => {
    const nb = nextBoards.get(oldBoard.id);
    if (!nb) return true;
    const nodeIds = new Set(nb.nodes.map((n) => n.id));
    const edgeIds = new Set(nb.edges.map((e) => e.id));
    return oldBoard.nodes.some((n) => !nodeIds.has(n.id)) || oldBoard.edges.some((e) => !edgeIds.has(e.id));
  });
}

function offlineRead(dataDir) {
  const filePath = path.join(dataDir, '画布数据.json');
  if (!fs.existsSync(filePath)) {
    return { mode: 'offline', revision: 'empty', space: null };
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) {
    throw new CanvasToolError('画布数据.json 必须是普通文件，且不能是符号链接。', 'invalid_workspace');
  }
  const bytes = fs.readFileSync(filePath);
  const space = validateWorkspace(JSON.parse(bytes.toString('utf8')), '离线画布数据');
  return { mode: 'offline', revision: `sha256-${sha256Hex(bytes)}`, space };
}

function offlineWrite(dataDir, nextJson, expectedRevision) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const nextSpace = validateWorkspace(JSON.parse(nextJson), '待写入画布数据');
  const backupDir = path.join(dataDir, '历史备份');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const py = [
    'import errno, fcntl, hashlib, os, stat, sys, uuid',
    'data_dir, expected_rev, next_file, backup_daily, backup_del = sys.argv[1:6]',
    'def write_all(fd, payload):',
    '    mv = memoryview(payload)',
    '    written = 0',
    '    while written < len(mv):',
    '        n = os.write(fd, mv[written:])',
    '        if n <= 0: raise OSError(errno.EIO, "short write")',
    '        written += n',
    'def safe_stage(directory, filename, payload):',
    '    tmp = os.path.join(directory, ".写入-" + str(uuid.uuid4()) + ".tmp")',
    '    sfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)',
    '    try:',
    '        write_all(sfd, payload); os.fsync(sfd)',
    '        os.close(sfd); sfd = -1',
    '        os.replace(tmp, os.path.join(directory, filename))',
    '    except:',
    '        if sfd >= 0: os.close(sfd)',
    '        try: os.unlink(tmp)',
    '        except OSError: pass',
    '        raise',
    'with open(next_file, "rb") as f: next_bytes = f.read()',
    'fd = os.open(data_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    'try:',
    '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    '    main_path = os.path.join(data_dir, "画布数据.json")',
    '    prev_bytes = None',
    '    try:',
    '        rfd = os.open(main_path, os.O_RDONLY | os.O_NOFOLLOW)',
    '        try:',
    '            st = os.fstat(rfd)',
    '            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1:',
    '                raise RuntimeError("画布数据.json 必须是当前用户拥有的普通文件，且不能是链接。")',
    '            chunks = []',
    '            while True:',
    '                part = os.read(rfd, 1048576)',
    '                if not part: break',
    '                chunks.append(part)',
    '            prev_bytes = b"".join(chunks)',
    '        finally: os.close(rfd)',
    '    except FileNotFoundError:',
    '        prev_bytes = None',
    '    cur_rev = "empty" if prev_bytes is None else "sha256-" + hashlib.sha256(prev_bytes).hexdigest()',
    '    if expected_rev and cur_rev != expected_rev:',
    '        print("CONFLICT:" + cur_rev)',
    '        sys.exit(2)',
    '    if prev_bytes is not None and backup_daily:',
    '        daily_path = os.path.join(data_dir, "历史备份", backup_daily)',
    '        if not os.path.exists(daily_path):',
    '            safe_stage(os.path.join(data_dir, "历史备份"), backup_daily, prev_bytes)',
    '    if prev_bytes is not None and backup_del:',
    '        safe_stage(os.path.join(data_dir, "历史备份"), backup_del, prev_bytes)',
    '    safe_stage(data_dir, "画布数据.json", next_bytes)',
    '    os.fsync(fd)',
    '    print("sha256-" + hashlib.sha256(next_bytes).hexdigest())',
    'finally:',
    '    os.close(fd)',
  ].join('\n');

  const filePath = path.join(dataDir, '画布数据.json');
  const prevBytes = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const prevSpace = prevBytes ? validateWorkspace(JSON.parse(prevBytes.toString('utf8')), '旧画布数据') : null;
  const changed = prevSpace && !sameWorkspaceContent(nextSpace, prevSpace);
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const day = `${yyyy}-${mm}-${dd}`;
  const backupDaily = changed ? `每日-${day}.json` : '';
  const backupDel = changed && deletesContent(nextSpace, prevSpace) ? `删除前-${day}-${randomUUID()}.json` : '';

  const stageFile = path.join(os.tmpdir(), `idea-canvas-stage-${randomUUID()}.json`);
  fs.writeFileSync(stageFile, nextJson, { mode: 0o600 });
  try {
    const rev = execFileSync(
      'python3',
      ['-c', py, dataDir, expectedRevision ?? '', stageFile, backupDaily, backupDel],
      { encoding: 'utf8' },
    ).trim();
    return { mode: 'offline', revision: rev, space: nextSpace };
  } catch (err) {
    const stdout = String(err?.stdout ?? '');
    if (stdout.startsWith('CONFLICT:')) {
      throw new CanvasToolError('离线画布数据在读取后已变化，请重试。', 'conflict');
    }
    if (String(err?.stderr ?? '').includes('BlockingIOError')) {
      throw new CanvasToolError('画布数据目录正被运行中的「想法画布」锁定，无法直接写磁盘。', 'locked');
    }
    throw err;
  } finally {
    fs.rmSync(stageFile, { force: true });
  }
}

export async function loadWorkspace(cfg) {
  const { enabled, token } = readLocalApiToken(cfg.dataDir);
  if (!enabled) {
    throw new CanvasToolError(
      '已在「想法画布 → 文件 → 允许本机 AI / MCP 接入」关闭接入，请重新勾选后再操作。',
      'api_disabled',
    );
  }
  if (token) {
    try {
      const res = await httpCall(cfg.port, 'GET', '/api/state', {
        bearer: token,
        expectedStatuses: [200],
      });
      const parsed = JSON.parse(res.body);
      const space = parsed.json ? validateWorkspace(JSON.parse(parsed.json), '运行中画布') : null;
      return { mode: 'live', revision: parsed.revision, space, token };
    } catch (err) {
      if (err instanceof CanvasToolError) throw err;
      if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code)) {
        throw err;
      }
    }
  }
  if (checkDirectoryLock(cfg.dataDir)) {
    throw new CanvasToolError(
      '「想法画布」正在运行但无法通过本机 API 连接。请确认应用已升级到支持本机 AI / MCP 接入的版本并已开启该选项。',
      'locked',
    );
  }
  return offlineRead(cfg.dataDir);
}

export async function saveWorkspace(cfg, expectedRevision, nextSpace, stateContext = null) {
  validateWorkspace(nextSpace, '待保存画布');
  const nextJson = JSON.stringify(nextSpace);
  const { enabled, token } = stateContext?.token ? { enabled: true, token: stateContext.token } : readLocalApiToken(cfg.dataDir);
  if (!enabled) {
    throw new CanvasToolError(
      '已在「想法画布 → 文件 → 允许本机 AI / MCP 接入」关闭接入，请重新勾选后再操作。',
      'api_disabled',
    );
  }
  if (stateContext?.mode === 'live' || (token && stateContext?.mode !== 'offline')) {
    try {
      const res = await httpCall(cfg.port, 'PUT', '/api/state', {
        bearer: token,
        body: { expectedRevision, json: nextJson },
        expectedStatuses: [200],
      });
      const parsed = JSON.parse(res.body);
      return {
        mode: 'live',
        revision: parsed.revision,
        space: validateWorkspace(JSON.parse(parsed.json), '保存后画布'),
      };
    } catch (err) {
      if (err instanceof CanvasToolError) throw err;
      if (!['ECONNREFUSED', 'ECONNRESET'].includes(err?.code)) throw err;
    }
  }
  if (checkDirectoryLock(cfg.dataDir)) {
    throw new CanvasToolError('「想法画布」正在锁定数据目录，拒绝绕过应用写入磁盘。', 'locked');
  }
  return offlineWrite(cfg.dataDir, nextJson, expectedRevision);
}

async function mutateWorkspace(cfg, mutator) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await loadWorkspace(cfg);
    if (!state.space) {
      throw new CanvasToolError('当前尚无画布工作区，请先用 canvas_create_board 创建画布。', 'empty_workspace');
    }
    const working = structuredClone(state.space);
    const result = mutator(working);
    if (result?.unchanged) {
      return { mode: state.mode, revision: state.revision, space: state.space, result };
    }
    try {
      const saved = await saveWorkspace(cfg, state.revision, working, state);
      return { ...saved, result };
    } catch (err) {
      if (err instanceof CanvasToolError && err.code === 'conflict' && attempt === 0) continue;
      throw err;
    }
  }
}

export function resolveBoard(space, { boardId, boardName } = {}) {
  if (!space || !space.boards.length) {
    throw new CanvasToolError('工作区没有任何画布。', 'no_boards');
  }
  if (boardId) {
    const found = space.boards.find((b) => b.id === boardId);
    if (!found) throw new CanvasToolError(`找不到画布 ID：${boardId}`, 'board_not_found');
    return found;
  }
  if (boardName) {
    const matches = space.boards.filter((b) => b.name === boardName || b.name.includes(boardName));
    if (matches.length === 0) throw new CanvasToolError(`找不到名称匹配「${boardName}」的画布。`, 'board_not_found');
    if (matches.length > 1) {
      throw new CanvasToolError(
        `名称「${boardName}」匹配多张画布：${matches.map((b) => `${b.name}(${b.id})`).join(', ')}，请改传 boardId。`,
        'ambiguous_board',
      );
    }
    return matches[0];
  }
  return space.boards.find((b) => b.id === space.activeId) ?? space.boards[0];
}

function buildBranchChildrenMap(board) {
  const nodeMap = new Map(board.nodes.map((n) => [n.id, n]));
  const children = new Map();
  const parentOf = new Map();
  for (const e of board.edges) {
    if (e.kind !== 'branch') continue;
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from).push(e.to);
    if (!parentOf.has(e.to)) parentOf.set(e.to, e.from);
  }
  for (const [, list] of children) {
    list.sort((a, b) => (nodeMap.get(a)?.order ?? 0) - (nodeMap.get(b)?.order ?? 0));
  }
  return { nodeMap, children, parentOf };
}

function findRootIds(board, parentOf) {
  const configuredRoot = board.settings?.layout?.rootId;
  const roots = [];
  if (configuredRoot && board.nodes.some((n) => n.id === configuredRoot)) {
    roots.push(configuredRoot);
  }
  for (const n of [...board.nodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (!parentOf.has(n.id) && !roots.includes(n.id)) roots.push(n.id);
  }
  if (roots.length === 0 && board.nodes.length > 0) roots.push(board.nodes[0].id);
  return roots;
}

function recomputeBoardOrder(board) {
  const { nodeMap, children, parentOf } = buildBranchChildrenMap(board);
  const roots = findRootIds(board, parentOf);
  let nextOrder = 0;
  const visited = new Set();
  function walk(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const n = nodeMap.get(id);
    if (!n) return;
    n.order = nextOrder++;
    for (const c of children.get(id) || []) walk(c);
  }
  for (const r of roots) walk(r);
  for (const n of board.nodes) {
    if (!visited.has(n.id)) n.order = nextOrder++;
  }
}

function buildOutlineTree(board) {
  const nodeMap = new Map(board.nodes.map((n) => [n.id, n]));
  const children = new Map(board.nodes.map((n) => [n.id, []]));
  const parentOf = new Map();
  const groups = new Map(board.nodes.map((n) => [n.id, n.id]));
  const groupOf = (id) => {
    while (groups.get(id) !== id) {
      groups.set(id, groups.get(groups.get(id)));
      id = groups.get(id);
    }
    return id;
  };
  for (const kind of ['branch', 'link']) {
    for (const e of board.edges) {
      if (e.kind !== kind || !children.has(e.from) || !children.has(e.to) || parentOf.has(e.to)) continue;
      const gFrom = groupOf(e.from);
      const gTo = groupOf(e.to);
      if (gFrom === gTo) continue;
      groups.set(gTo, gFrom);
      parentOf.set(e.to, e.from);
      children.get(e.from).push(e.to);
    }
  }
  for (const [, list] of children) {
    list.sort((a, b) => (nodeMap.get(a)?.order ?? 0) - (nodeMap.get(b)?.order ?? 0));
  }
  return { nodeMap, children, parentOf };
}

function defaultSettings(rootId = 'home') {
  return {
    layout: { mode: 'double', nodeGap: 24, levelGap: 76, rootId, rows: 'status', columns: 'tone' },
    guides: [],
    appearance: {
      background: '#f5f6f8',
      grid: 'dots',
      gridColor: '#94a3b8',
      gridSize: 24,
      accent: '#0f766e',
      card: {},
      branch: {},
      link: {},
    },
    statuses: [
      { id: 'pending', name: '待验证', color: '#ad7429', icon: '○' },
      { id: 'watching', name: '观察中', color: '#397aa8', icon: '◐' },
      { id: 'reviewed', name: '已复盘', color: '#3d7c61', icon: '✓' },
    ],
    tags: [],
    folded: [],
    singleBranch: false,
    detail: 'full',
    frames: [],
  };
}

export async function runTool(name, args = {}, cfgOverrides = {}) {
  const cfg = getConfig(cfgOverrides);

  switch (name) {
    case 'canvas_status': {
      const { enabled, token } = readLocalApiToken(cfg.dataDir);
      let mode = 'offline';
      let health = null;
      if (!enabled) {
        mode = 'disabled';
      } else if (token) {
        try {
          const h = await httpCall(cfg.port, 'GET', '/api/agent/health', {
            bearer: token,
            expectedStatuses: [200],
          });
          health = JSON.parse(h.body);
          mode = 'live';
        } catch (err) {
          mode = checkDirectoryLock(cfg.dataDir) ? 'locked_or_unauthorized' : 'offline';
        }
      } else if (checkDirectoryLock(cfg.dataDir)) {
        mode = 'locked_or_unauthorized';
      }
      let state = null;
      if (mode === 'live' || mode === 'offline') {
        state = await loadWorkspace(cfg);
      }
      return {
        mode,
        dataDir: cfg.dataDir,
        port: cfg.port,
        apiEnabled: enabled,
        health,
        revision: state?.revision ?? null,
        activeId: state?.space?.activeId ?? null,
        boards: (state?.space?.boards ?? []).map((b) => ({
          id: b.id,
          name: b.name,
          isActive: b.id === state?.space?.activeId,
          nodeCount: b.nodes.length,
          edgeCount: b.edges.length,
        })),
      };
    }

    case 'canvas_list_boards': {
      const state = await loadWorkspace(cfg);
      if (!state.space) return { mode: state.mode, activeId: null, boards: [] };
      return {
        mode: state.mode,
        revision: state.revision,
        activeId: state.space.activeId,
        boards: state.space.boards.map((b) => {
          const { parentOf } = buildOutlineTree(b);
          const roots = findRootIds(b, parentOf)
            .map((id) => b.nodes.find((n) => n.id === id))
            .filter(Boolean);
          return {
            id: b.id,
            name: b.name,
            isActive: b.id === state.space.activeId,
            nodeCount: b.nodes.length,
            edgeCount: b.edges.length,
            roots: roots.map((r) => ({ id: r.id, title: r.title })),
          };
        }),
      };
    }

    case 'canvas_get_outline': {
      const state = await loadWorkspace(cfg);
      const board = resolveBoard(state.space, args);
      const { nodeMap, children, parentOf } = buildOutlineTree(board);
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 3;
      const startIds = args.rootNodeId ? [args.rootNodeId] : findRootIds(board, parentOf);
      for (const id of startIds) {
        if (!nodeMap.has(id)) throw new CanvasToolError(`找不到根节点：${id}`, 'node_not_found');
      }
      const seen = new Set();
      function visit(id, depth) {
        if (seen.has(id)) return null;
        seen.add(id);
        const n = nodeMap.get(id);
        const kids = children.get(id) || [];
        const firstLine = (n.body || '').split('\n')[0]?.slice(0, 120) || '';
        const item = {
          id: n.id,
          title: n.title,
          tone: n.tone,
          ...(n.status ? { status: n.status } : {}),
          ...(n.tags?.length ? { tags: n.tags } : {}),
          childCount: kids.length,
          ...(firstLine ? { preview: firstLine } : {}),
        };
        if (depth < maxDepth && kids.length > 0) {
          item.children = kids.map((cid) => visit(cid, depth + 1)).filter(Boolean);
        }
        return item;
      }
      return {
        mode: state.mode,
        boardId: board.id,
        boardName: board.name,
        maxDepth,
        outline: startIds.map((id) => visit(id, 0)).filter(Boolean),
      };
    }

    case 'canvas_get_cards': {
      const state = await loadWorkspace(cfg);
      const board = resolveBoard(state.space, args);
      const { nodeMap, children, parentOf } = buildBranchChildrenMap(board);
      const limit = Number.isInteger(args.limit) ? Math.max(0, Math.min(args.limit, 200)) : 50;
      let candidateIds = null;

      if (Array.isArray(args.cardIds) && args.cardIds.length > 0) {
        candidateIds = args.cardIds;
      } else if (args.branchRootId) {
        if (!nodeMap.has(args.branchRootId)) {
          throw new CanvasToolError(`找不到分支起点：${args.branchRootId}`, 'node_not_found');
        }
        const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 10;
        const collected = [];
        const seen = new Set();
        function collect(id, depth) {
          if (seen.has(id) || depth > maxDepth) return;
          seen.add(id);
          collected.push(id);
          for (const cid of children.get(id) || []) collect(cid, depth + 1);
        }
        collect(args.branchRootId, 0);
        candidateIds = collected;
      } else {
        candidateIds = [...board.nodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((n) => n.id);
      }

      const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const matched = [];
      for (const id of candidateIds) {
        if (matched.length >= limit) break;
        const n = nodeMap.get(id);
        if (!n) continue;
        if (args.status && n.status !== args.status) continue;
        if (args.tone && n.tone !== args.tone) continue;
        if (q) {
          const sourceText = (n.sources || []).map((s) => `${s.label} ${s.url || ''}`).join(' ');
          const hay = `${n.id}\n${n.title}\n${n.body}\n${n.note || ''}\n${sourceText}\n${(n.tags || []).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        matched.push({
          id: n.id,
          title: n.title,
          body: n.body,
          tone: n.tone,
          parentId: parentOf.get(n.id) ?? null,
          childIds: children.get(n.id) || [],
          ...(n.note ? { note: n.note } : {}),
          ...(n.sources?.length ? { sources: n.sources } : {}),
          ...(n.status ? { status: n.status } : {}),
          ...(n.priority ? { priority: n.priority } : {}),
          ...(n.tags?.length ? { tags: n.tags } : {}),
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
          order: n.order ?? null,
        });
        if (matched.length >= limit) break;
      }
      return {
        mode: state.mode,
        boardId: board.id,
        boardName: board.name,
        count: matched.length,
        cards: matched,
      };
    }

    case 'canvas_upsert_cards': {
      if (!Array.isArray(args.cards) || args.cards.length === 0) {
        throw new CanvasToolError('cards 必须是非空数组。', 'invalid_args');
      }
      const outcome = await mutateWorkspace(cfg, (space) => {
        const board = resolveBoard(space, args);
        const nodeMap = new Map(board.nodes.map((n) => [n.id, n]));
        const created = [];
        const updated = [];

        function getChildrenIds(parentId) {
          return board.edges
            .filter((e) => e.kind === 'branch' && e.from === parentId)
            .map((e) => e.to)
            .sort((a, b) => (nodeMap.get(a)?.order ?? 0) - (nodeMap.get(b)?.order ?? 0));
        }

        function wouldCreateCycle(fromId, toId) {
          if (fromId === toId) return true;
          const stack = [toId];
          const seen = new Set();
          while (stack.length) {
            const cur = stack.pop();
            if (cur === fromId) return true;
            if (seen.has(cur)) continue;
            seen.add(cur);
            for (const e of board.edges) {
              if (e.kind === 'branch' && e.from === cur) stack.push(e.to);
            }
          }
          return false;
        }

        function ensureBranchEdge(parentId, childId) {
          if (!nodeMap.has(parentId)) {
            throw new CanvasToolError(`找不到父卡片 parentId：${parentId}`, 'node_not_found');
          }
          if (wouldCreateCycle(parentId, childId)) {
            throw new CanvasToolError(`连线 ${parentId} -> ${childId} 会形成环。`, 'cycle_detected');
          }
          // Remove existing incoming branch edge to childId if moving parent
          board.edges = board.edges.filter((e) => !(e.kind === 'branch' && e.to === childId && e.from !== parentId));
          const existsSame = board.edges.some((e) => e.kind === 'branch' && e.from === parentId && e.to === childId);
          if (!existsSame) {
            const existingPair = board.edges.find(
              (e) => (e.from === parentId && e.to === childId) || (e.from === childId && e.to === parentId),
            );
            if (existingPair) {
              existingPair.from = parentId;
              existingPair.to = childId;
              existingPair.kind = 'branch';
            } else {
              let eid = `edge-${childId}`;
              if (board.edges.some((e) => e.id === eid)) eid = `edge-${childId}-${randomUUID().slice(0, 8)}`;
              board.edges.push({ id: eid, from: parentId, to: childId, label: '', kind: 'branch' });
            }
          }
        }

        for (const spec of args.cards) {
          if (!spec || !isValidId(spec.id)) {
            throw new CanvasToolError(`无效卡片 ID：${spec?.id}`, 'invalid_id');
          }
          for (const numField of ['x', 'y', 'w', 'h']) {
            if (spec[numField] !== undefined && !Number.isFinite(spec[numField])) {
              throw new CanvasToolError(`卡片 ${numField} 坐标或尺寸数值无效：${spec.id}`, 'invalid_args');
            }
          }
          let node = nodeMap.get(spec.id);
          const isNew = !node;
          if (isNew) {
            const body = typeof spec.body === 'string' ? spec.body : '';
            const title = typeof spec.title === 'string' ? spec.title : spec.id;
            const tone = spec.tone ?? 'reference';
            if (!VALID_TONES.has(tone)) {
              throw new CanvasToolError(`无效卡片 tone：${tone}`, 'invalid_tone');
            }
            const lines = body ? body.split('\n').length : 1;
            let x = Number.isFinite(spec.x) ? spec.x : 0;
            let y = Number.isFinite(spec.y) ? spec.y : 0;
            if (spec.parentId && (!Number.isFinite(spec.x) || !Number.isFinite(spec.y))) {
              const parent = nodeMap.get(spec.parentId);
              if (!parent) throw new CanvasToolError(`找不到父卡片：${spec.parentId}`, 'node_not_found');
              const sibIds = getChildrenIds(spec.parentId);
              if (!Number.isFinite(spec.x)) x = parent.x + (parent.w || 305) + 108;
              if (!Number.isFinite(spec.y)) {
                if (spec.beforeSiblingId && nodeMap.has(spec.beforeSiblingId)) {
                  y = nodeMap.get(spec.beforeSiblingId).y - 200;
                } else if (spec.afterSiblingId && nodeMap.has(spec.afterSiblingId)) {
                  const ref = nodeMap.get(spec.afterSiblingId);
                  y = ref.y + (ref.h || 160) + 30;
                } else if (sibIds.length > 0) {
                  const last = nodeMap.get(sibIds[sibIds.length - 1]);
                  y = last.y + (last.h || 160) + 30;
                } else {
                  y = parent.y;
                }
              }
            }
            const hasMeta =
              Boolean(spec.status) ||
              Boolean(spec.priority) ||
              Boolean(spec.tags?.length) ||
              Boolean(spec.pinned) ||
              Boolean(spec.note && String(spec.note).trim()) ||
              Boolean(Array.isArray(spec.sources) && spec.sources.length);
            node = {
              id: spec.id,
              x,
              y,
              w: Number.isFinite(spec.w) ? spec.w : 310,
              h: Number.isFinite(spec.h) ? spec.h : estimateCardHeight(title, body, hasMeta),
              tone,
              title,
              body,
              order: board.nodes.length,
            };
            const rb = makeRichBody(body);
            if (rb !== undefined) node.richBody = rb;
            board.nodes.push(node);
            nodeMap.set(node.id, node);
            created.push(node.id);
          } else {
            if (spec.title !== undefined) node.title = String(spec.title);
            if (spec.body !== undefined) {
              const nextBody = String(spec.body);
              if (nextBody !== node.body) {
                node.body = nextBody;
                const imgs = (node.richBody || '').match(/<img\b[^>]*>/gi) || [];
                if (imgs.length) {
                  node.richBody = imgs.join('') + (nextBody ? bodyToRichHtml(nextBody) : '');
                } else {
                  const rb = makeRichBody(nextBody);
                  if (rb === undefined) delete node.richBody;
                  else node.richBody = rb;
                }
              }
            }
            if (spec.tone !== undefined) {
              if (!VALID_TONES.has(spec.tone)) throw new CanvasToolError(`无效卡片 tone：${spec.tone}`, 'invalid_tone');
              node.tone = spec.tone;
            }
            if (Number.isFinite(spec.x)) node.x = spec.x;
            if (Number.isFinite(spec.y)) node.y = spec.y;
            if (Number.isFinite(spec.w)) node.w = spec.w;
            if (Number.isFinite(spec.h)) node.h = spec.h;
            updated.push(node.id);
          }

          if (spec.note !== undefined) {
            if (spec.note === null || !String(spec.note).trim()) delete node.note;
            else node.note = String(spec.note).trim();
          }
          if (spec.sources !== undefined) {
            if (spec.sources === null) {
              delete node.sources;
            } else {
              if (!Array.isArray(spec.sources)) throw new CanvasToolError('sources 必须是数组。', 'invalid_args');
              const cleaned = spec.sources
                .filter((s) => s && typeof s.label === 'string' && s.label.trim())
                .map((s) => ({
                  label: s.label.trim(),
                  ...(typeof s.url === 'string' && s.url.trim() ? { url: s.url.trim() } : {}),
                }));
              if (cleaned.length === 0) delete node.sources;
              else node.sources = cleaned;
            }
          }

          if (spec.status !== undefined) {
            if (spec.status === null || spec.status === '') delete node.status;
            else node.status = String(spec.status);
          }
          if (spec.priority !== undefined) {
            if (spec.priority === null || spec.priority === '' || spec.priority === 'none') delete node.priority;
            else if (VALID_PRIORITIES.has(spec.priority)) node.priority = spec.priority;
            else throw new CanvasToolError(`无效 priority：${spec.priority}`, 'invalid_priority');
          }
          if (spec.tags !== undefined) {
            if (!Array.isArray(spec.tags)) throw new CanvasToolError('tags 必须是数组。', 'invalid_args');
            if (spec.tags.length === 0) delete node.tags;
            else node.tags = spec.tags.filter(isValidId);
          }
          if (spec.pinned !== undefined) {
            if (spec.pinned) node.pinned = true;
            else delete node.pinned;
          }
          if (spec.style !== undefined) {
            if (spec.style === null) delete node.style;
            else node.style = spec.style;
          }
          if (spec.branchStyle !== undefined) {
            if (spec.branchStyle === null) delete node.branchStyle;
            else node.branchStyle = spec.branchStyle;
          }
          if (spec.beforeSiblingId !== undefined && spec.beforeSiblingId !== null && !nodeMap.has(spec.beforeSiblingId)) {
            throw new CanvasToolError(`找不到参照同级卡片 beforeSiblingId：${spec.beforeSiblingId}`, 'node_not_found');
          }
          if (spec.afterSiblingId !== undefined && spec.afterSiblingId !== null && !nodeMap.has(spec.afterSiblingId)) {
            throw new CanvasToolError(`找不到参照同级卡片 afterSiblingId：${spec.afterSiblingId}`, 'node_not_found');
          }
          if (spec.parentId === null || spec.parentId === '') {
            board.edges = board.edges.filter((e) => !(e.kind === 'branch' && e.to === node.id));
          } else if (spec.parentId) {
            ensureBranchEdge(spec.parentId, node.id);
          }
          if (spec.beforeSiblingId) {
            node.order = (nodeMap.get(spec.beforeSiblingId).order ?? 0) - 0.5;
          } else if (spec.afterSiblingId) {
            node.order = (nodeMap.get(spec.afterSiblingId).order ?? 0) + 0.5;
          } else if (spec.parentId && isNew) {
            const sibOrders = getChildrenIds(spec.parentId)
              .filter((cid) => cid !== node.id)
              .map((cid) => nodeMap.get(cid)?.order ?? 0);
            node.order = sibOrders.length ? Math.max(...sibOrders) + 1 : 0;
          }
          recomputeBoardOrder(board);
        }
        return { boardId: board.id, boardName: board.name, created, updated, nodeCount: board.nodes.length, edgeCount: board.edges.length };
      });
      return { mode: outcome.mode, revision: outcome.revision, ...outcome.result };
    }

    case 'canvas_delete_cards': {
      if (!Array.isArray(args.cardIds) || args.cardIds.length === 0) {
        throw new CanvasToolError('cardIds 必须是非空数组。', 'invalid_args');
      }
      const deleteSubtree = args.deleteSubtree === true;
      const outcome = await mutateWorkspace(cfg, (space) => {
        const board = resolveBoard(space, args);
        const { nodeMap, children } = buildBranchChildrenMap(board);
        const toDelete = new Set();
        for (const id of args.cardIds) {
          if (!nodeMap.has(id)) throw new CanvasToolError(`找不到卡片：${id}`, 'node_not_found');
          if (!deleteSubtree) {
            const kids = (children.get(id) || []).filter((cid) => !args.cardIds.includes(cid));
            if (kids.length > 0) {
              throw new CanvasToolError(
                `卡片 ${id} 下仍有子卡片（${kids.join(', ')}）。请先处理子卡片，或显式传 deleteSubtree: true。`,
                'has_children',
              );
            }
            toDelete.add(id);
          } else {
            const stack = [id];
            while (stack.length) {
              const cur = stack.pop();
              if (toDelete.has(cur)) continue;
              toDelete.add(cur);
              for (const cid of children.get(cur) || []) stack.push(cid);
            }
          }
        }
        if (toDelete.size >= board.nodes.length) {
          throw new CanvasToolError('不能删除画布中的全部卡片。', 'cannot_empty_board');
        }
        board.nodes = board.nodes.filter((n) => !toDelete.has(n.id));
        board.edges = board.edges.filter((e) => !toDelete.has(e.from) && !toDelete.has(e.to));
        if (board.settings) {
          if (Array.isArray(board.settings.folded)) {
            board.settings.folded = board.settings.folded.filter((id) => !toDelete.has(id));
          }
          if (Array.isArray(board.settings.frames)) {
            for (const frame of board.settings.frames) {
              if (Array.isArray(frame.members)) {
                frame.members = frame.members.filter((id) => !toDelete.has(id));
              }
            }
            board.settings.frames = board.settings.frames.filter((frame) => frame.members?.length || frame.box);
          }
          if (board.settings.layout && toDelete.has(board.settings.layout.rootId)) {
            board.settings.layout.rootId = null;
          }
        }
        recomputeBoardOrder(board);
        return {
          boardId: board.id,
          boardName: board.name,
          deleted: [...toDelete],
          nodeCount: board.nodes.length,
          edgeCount: board.edges.length,
        };
      });
      return { mode: outcome.mode, revision: outcome.revision, ...outcome.result };
    }

    case 'canvas_create_board': {
      if (typeof args.name !== 'string' || !args.name.trim()) {
        throw new CanvasToolError('name 不能为空。', 'invalid_args');
      }
      const boardId = args.boardId ? String(args.boardId) : randomUUID();
      if (!isValidId(boardId)) throw new CanvasToolError(`无效 boardId：${boardId}`, 'invalid_id');
      const rootId = 'home';
      const rootTitle = args.rootTitle ? String(args.rootTitle) : args.name.trim();
      const rootBody = typeof args.rootBody === 'string' ? args.rootBody : '';
      const makeActive = args.makeActive !== false;

      const state = await loadWorkspace(cfg);
      const nextSpace = state.space
        ? structuredClone(state.space)
        : { version: 3, activeId: boardId, boards: [], themes: [] };
      if (nextSpace.boards.some((b) => b.id === boardId)) {
        throw new CanvasToolError(`画布 ID 已存在：${boardId}`, 'duplicate_board');
      }
      const rootNode = {
        id: rootId,
        x: 0,
        y: -70,
        w: 275,
        h: 160,
        tone: 'topic',
        title: rootTitle,
        body: rootBody,
        order: 0,
      };
      const rb = makeRichBody(rootBody);
      if (rb !== undefined) rootNode.richBody = rb;
      nextSpace.boards.push({
        id: boardId,
        name: args.name.trim(),
        nodes: [rootNode],
        edges: [],
        view: null,
        settings: defaultSettings(rootId),
      });
      if (makeActive) nextSpace.activeId = boardId;
      const saved = await saveWorkspace(cfg, state.revision, nextSpace, state);
      return {
        mode: saved.mode,
        revision: saved.revision,
        boardId,
        name: args.name.trim(),
        activeId: saved.space.activeId,
      };
    }

    case 'canvas_sync_mirror': {
      if (typeof args.mirrorPath !== 'string' || !args.mirrorPath.trim()) {
        throw new CanvasToolError('mirrorPath 不能为空。', 'invalid_args');
      }
      const direction = args.direction ?? 'check';
      if (!['check', 'pull', 'push'].includes(direction)) {
        throw new CanvasToolError('direction 必须是 check、pull 或 push。', 'invalid_args');
      }
      const mirrorAbs = path.resolve(args.mirrorPath);
      if (!fs.existsSync(mirrorAbs)) {
        throw new CanvasToolError(`找不到项目镜像文件：${mirrorAbs}`, 'mirror_not_found');
      }
      let mirrorJson;
      try {
        mirrorJson = JSON.parse(fs.readFileSync(mirrorAbs, 'utf8'));
      } catch {
        throw new CanvasToolError(`项目镜像 JSON 无法解析：${mirrorAbs}`, 'invalid_mirror');
      }
      const mirrorSpace = validateWorkspace(mirrorJson, '项目镜像');
      if (mirrorSpace.boards.length !== 1) {
        throw new CanvasToolError('项目镜像文件必须只包含 1 张画布。', 'invalid_mirror');
      }
      const mirrorBoard = mirrorSpace.boards[0];
      let baselinePath = null;
      try {
        const legacyPath = execFileSync(
          'git',
          ['rev-parse', '--path-format=absolute', '--git-path', `benebox-canvas-sync-${mirrorBoard.id}.sha256`],
          { cwd: path.dirname(mirrorAbs), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        baselinePath = fs.existsSync(legacyPath)
          ? legacyPath
          : execFileSync(
              'git',
              ['rev-parse', '--path-format=absolute', '--git-path', `idea-canvas-sync-${mirrorBoard.id}.sha256`],
              { cwd: path.dirname(mirrorAbs), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
            ).trim();
      } catch {
        const legacyLocal = `${mirrorAbs}.${mirrorBoard.id}.sha256`;
        baselinePath = fs.existsSync(legacyLocal) ? legacyLocal : `${mirrorAbs}.${mirrorBoard.id}.idea.sha256`;
      }

      const baseline = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, 'utf8').trim() : null;
      const projectDigest = boardDigest(mirrorBoard);
      const state = await loadWorkspace(cfg);
      const appBoard = state.space?.boards.find((b) => b.id === mirrorBoard.id);
      if (!appBoard) {
        throw new CanvasToolError(`想法画布中找不到 ID 为 ${mirrorBoard.id} 的画布。`, 'board_not_found');
      }
      const appDigest = boardDigest(appBoard);
      let alignment = 'conflict';
      if (projectDigest === appDigest) alignment = 'same';
      else if (!baseline) alignment = 'noBaseline';
      else if (baseline === projectDigest) alignment = 'pull';
      else if (baseline === appDigest) alignment = 'push';

      if (direction === 'check') {
        return {
          mode: state.mode,
          boardId: mirrorBoard.id,
          alignment,
          projectCounts: { nodes: mirrorBoard.nodes.length, edges: mirrorBoard.edges.length },
          appCounts: { nodes: appBoard.nodes.length, edges: appBoard.edges.length },
        };
      }
      if (alignment !== 'same' && alignment !== direction) {
        throw new CanvasToolError(`同步中止：当前状态为 ${alignment}，无法直接 ${direction}。`, 'sync_conflict');
      }
      if (alignment === 'same') {
        if (baseline !== projectDigest) fs.writeFileSync(baselinePath, `${projectDigest}\n`, { mode: 0o600 });
        return { mode: state.mode, boardId: mirrorBoard.id, alignment: 'same', synced: false };
      }
      if (direction === 'pull') {
        const portable = {
          version: state.space.version,
          activeId: appBoard.id,
          boards: [appBoard],
          themes: mirrorSpace.themes ?? [],
        };
        fs.writeFileSync(mirrorAbs, `${JSON.stringify(portable, null, 2)}\n`, 'utf8');
        fs.writeFileSync(baselinePath, `${appDigest}\n`, { mode: 0o600 });
        return {
          mode: state.mode,
          boardId: mirrorBoard.id,
          direction: 'pull',
          synced: true,
          counts: { nodes: appBoard.nodes.length, edges: appBoard.edges.length },
        };
      }
      // push
      const nextSpace = structuredClone(state.space);
      nextSpace.boards = nextSpace.boards.map((b) =>
        b.id === mirrorBoard.id ? { ...mirrorBoard, view: b.view } : b,
      );
      const saved = await saveWorkspace(cfg, state.revision, nextSpace, state);
      const updatedAppBoard = saved.space.boards.find((b) => b.id === mirrorBoard.id);
      const newDigest = boardDigest(updatedAppBoard);
      const portable = {
        version: saved.space.version,
        activeId: updatedAppBoard.id,
        boards: [updatedAppBoard],
        themes: mirrorSpace.themes ?? [],
      };
      fs.writeFileSync(mirrorAbs, `${JSON.stringify(portable, null, 2)}\n`, 'utf8');
      fs.writeFileSync(baselinePath, `${newDigest}\n`, { mode: 0o600 });
      return {
        mode: saved.mode,
        revision: saved.revision,
        boardId: mirrorBoard.id,
        direction: 'push',
        synced: true,
        counts: { nodes: updatedAppBoard.nodes.length, edges: updatedAppBoard.edges.length },
      };
    }

    default:
      throw new CanvasToolError(`未知工具：${name}`, 'unknown_tool');
  }
}

export const TOOLS = [
  {
    name: 'canvas_status',
    description: '检查「想法画布」本机 API 连接模式（live/offline/disabled）、当前版本修订号及所有画布概要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'canvas_list_boards',
    description: '列出「想法画布」中的所有画布（ID、名称、是否激活、卡片数与根卡片）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'canvas_get_outline',
    description: '按层级返回画布或指定分支的大纲树（仅含 ID、标题、类型、状态和首行摘要），避免一次读取整张大画布。',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: '画布 ID（省略则用当前激活画布）' },
        boardName: { type: 'string', description: '画布名称或关键词（可选）' },
        rootNodeId: { type: 'string', description: '从指定卡片 ID 向下展开大纲（可选）' },
        maxDepth: { type: 'integer', description: '最大展开层数，默认 3' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_get_cards',
    description: '按卡片 ID 列表、分支起点或关键词检索完整卡片内容（标题、正文、父子关系、状态、坐标）。',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        boardName: { type: 'string' },
        cardIds: { type: 'array', items: { type: 'string' }, description: '精确读取的卡片 ID 列表' },
        branchRootId: { type: 'string', description: '读取此分支下的子树卡片' },
        maxDepth: { type: 'integer', description: '配合 branchRootId 的最大深度，默认 10' },
        query: { type: 'string', description: '在 ID/标题/正文/标签中不区分大小写检索' },
        status: { type: 'string' },
        tone: { type: 'string', enum: ['topic', 'idea', 'question', 'action', 'reference'] },
        limit: { type: 'integer', description: '最多返回条数，默认 50，上限 200' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_upsert_cards',
    description: '在「想法画布」原位新增或更新卡片，自动维护分支连线、链接保真 richBody、坐标与 DFS order。',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        boardName: { type: 'string' },
        cards: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', description: '卡片唯一 ID（1-128 位字母数字_-）' },
              title: { type: 'string' },
              body: { type: 'string' },
              note: { type: ['string', 'null'], description: '默认隐藏的补充说明或边界备注（点卡片底部胶囊展开）' },
              sources: {
                type: ['array', 'null'],
                description: '默认隐藏的内容来源列表（点卡片底部胶囊展开）',
                items: {
                  type: 'object',
                  required: ['label'],
                  properties: { label: { type: 'string' }, url: { type: 'string' } },
                  additionalProperties: false,
                },
              },
              tone: { type: 'string', enum: ['topic', 'idea', 'question', 'action', 'reference'] },
              parentId: { type: ['string', 'null'], description: '挂载到此父卡片下；传 null 可解除父子连线升为顶层卡片' },
              afterSiblingId: { type: 'string', description: '排在同级某张卡片之后' },
              beforeSiblingId: { type: 'string', description: '排在同级某张卡片之前' },
              status: { type: ['string', 'null'] },
              priority: { type: ['string', 'null'], enum: ['none', 'high', 'medium', 'low', 'star', null] },
              tags: { type: 'array', items: { type: 'string' } },
              pinned: { type: 'boolean' },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
              style: { type: ['object', 'null'] },
              branchStyle: { type: ['object', 'null'] },
            },
          },
        },
      },
      required: ['cards'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_delete_cards',
    description: '删除指定卡片及其连线（默认拒绝删除仍有子卡片的节点，除非传 deleteSubtree: true）。离线写入自动生成删除前备份。',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        boardName: { type: 'string' },
        cardIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
        deleteSubtree: { type: 'boolean', description: '是否连同子孙卡片整棵删除，默认 false' },
      },
      required: ['cardIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_create_board',
    description: '在「想法画布」中创建一张带默认主题与根卡片的新画布。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        boardId: { type: 'string' },
        rootTitle: { type: 'string' },
        rootBody: { type: 'string' },
        makeActive: { type: 'boolean', description: '创建后是否切换为当前画布，默认 true' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_sync_mirror',
    description: '免复制配对链接，将项目内的单画布 JSON 镜像（如 docs/BeneBox.canvas.json）与「想法画布」进行 check / pull / push 双向同步。',
    inputSchema: {
      type: 'object',
      properties: {
        mirrorPath: { type: 'string', description: '项目内单画布 JSON 文件绝对路径' },
        direction: { type: 'string', enum: ['check', 'pull', 'push'], description: '默认 check' },
      },
      required: ['mirrorPath'],
      additionalProperties: false,
    },
  },
];

export async function handleRpcMessage(msg, cfgOverrides = {}) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;
  const hasId = id !== undefined && id !== null;

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null;
  }

  const reply = (result) => (hasId ? { jsonrpc: '2.0', id, result } : null);
  const replyErr = (code, message) => (hasId ? { jsonrpc: '2.0', id, error: { code, message } } : null);

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : '2025-03-26';
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'idea-canvas-mcp', version: '1.0.0' },
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        try {
          const result = await runTool(toolName, toolArgs, cfgOverrides);
          return reply({
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          });
        } catch (err) {
          return reply({
            isError: true,
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          });
        }
      }
      default:
        return replyErr(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return replyErr(-32603, err instanceof Error ? err.message : String(err));
  }
}

function startStdioServer() {
  let buffer = Buffer.alloc(0);
  let framing = null; // 'lsp' | 'line'

  function sendResponse(obj) {
    if (!obj) return;
    const json = JSON.stringify(obj);
    if (framing === 'lsp') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  }

  async function processMessage(rawText) {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const resp = await handleRpcMessage(parsed);
    sendResponse(resp);
  }

  let chain = Promise.resolve();
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      if (framing === null) {
        const probe = buffer.subarray(0, Math.min(buffer.length, 64)).toString('utf8');
        if (!probe.trim()) {
          if (!probe.includes('\n')) break;
          const nlIdx = buffer.indexOf('\n');
          buffer = buffer.subarray(nlIdx + 1);
          continue;
        }
        const trimmedStart = probe.trimStart();
        if (trimmedStart.startsWith('{')) {
          framing = 'line';
        } else if (/^Content-(?:Length|Type):/i.test(probe) || (buffer.includes('\r\n\r\n') && /Content-Length:/i.test(buffer.subarray(0, buffer.indexOf('\r\n\r\n')).toString('utf8')))) {
          framing = 'lsp';
        } else if (probe.includes('\n')) {
          framing = 'line';
        } else {
          break;
        }
      }
      if (framing === 'lsp') {
        const sepIdx = buffer.indexOf('\r\n\r\n');
        if (sepIdx === -1) break;
        const header = buffer.subarray(0, sepIdx).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) {
          buffer = buffer.subarray(sepIdx + 4);
          continue;
        }
        const len = Number(m[1]);
        const end = sepIdx + 4 + len;
        if (buffer.length < end) break;
        const body = buffer.subarray(sepIdx + 4, end).toString('utf8');
        buffer = buffer.subarray(end);
        chain = chain.then(() => processMessage(body)).catch(() => {});
      } else {
        const nlIdx = buffer.indexOf('\n');
        if (nlIdx === -1) break;
        const line = buffer.subarray(0, nlIdx).toString('utf8');
        buffer = buffer.subarray(nlIdx + 1);
        chain = chain.then(() => processMessage(line)).catch(() => {});
      }
    }
  });
}

const isMain =
  process.argv[1] &&
  pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;

if (isMain) {
  startStdioServer();
}
