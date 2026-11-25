const richTags = new Map(Object.entries({
  DIV: 'div', P: 'p', BR: 'br', B: 'strong', STRONG: 'strong', I: 'em', EM: 'em',
  U: 'u', STRIKE: 's', S: 's', H1: 'h3', H2: 'h3', H3: 'h3', H4: 'h3',
  UL: 'ul', OL: 'ol', LI: 'li', BLOCKQUOTE: 'blockquote', CODE: 'code', PRE: 'pre',
}));
const blockTags = new Set(['DIV', 'P', 'H3', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE']);
const ignoredTags = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'SVG', 'MATH']);
const imageDataLimit = 800_000;
const imageType = /^image\/(png|jpeg|webp|gif)$/i;
const imageData = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i;

function safeExternalUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function richFragment(html) {
  const source = document.createElement('template');
  source.innerHTML = html;
  const result = document.createDocumentFragment();
  function copy(input, output, depth) {
    for (const node of input.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        output.append(node.textContent);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
          ignoredTags.has(node.tagName) || depth === 48) continue;
      if (node.tagName === 'IMG') {
        const src = node.getAttribute('src');
        if (src && src.length <= imageDataLimit && imageData.test(src)) {
          const image = document.createElement('img');
          image.alt = (node.getAttribute('alt') || '卡片图片').slice(0, 140);
          image.src = src;
          output.append(image);
        }
        continue;
      }
      if (node.tagName === 'A') {
        const href = safeExternalUrl(node.getAttribute('href'));
        if (href) {
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          output.append(anchor);
          copy(node, anchor, depth + 1);
          continue;
        }
      }
      const tag = richTags.get(node.tagName);
      let destination = output;
      if (tag) {
        destination = document.createElement(tag);
        if (tag === 'li' && node.hasAttribute('data-done')) {
          destination.setAttribute('data-done', node.getAttribute('data-done') === 'true' ? 'true' : 'false');
        }
        output.append(destination);
      } else if (node.tagName === 'SPAN') {
        if (/^(bold|[6-9]00)$/i.test(node.style.fontWeight)) {
          const strong = document.createElement('strong');
          destination.append(strong);
          destination = strong;
        }
        if (node.style.fontStyle === 'italic') {
          const emphasis = document.createElement('em');
          destination.append(emphasis);
          destination = emphasis;
        }
      }
      copy(node, destination, depth + 1);
    }
  }
  copy(source.content, result, 0);
  return result;
}

function normalizeChecklistBlocks(root) {
  let activeList = null;
  for (const child of [...root.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      const lines = child.textContent.split(/\r?\n/);
      if (lines.some(line => checklistLineRe.test(line))) {
        const frag = document.createDocumentFragment();
        let list = null;
        for (const line of lines) {
          const m = line.match(checklistLineRe);
          if (m) {
            if (!list) { list = document.createElement('ul'); frag.append(list); }
            const li = document.createElement('li');
            li.setAttribute('data-done', m[2] === ' ' ? 'false' : 'true');
            li.textContent = line.replace(/^\s*[-*]\s*\[[ xX✓]\]\s+/, '');
            list.append(li);
          } else if (line.trim()) {
            list = null;
            const div = document.createElement('div');
            div.textContent = line;
            frag.append(div);
          }
        }
        child.replaceWith(frag);
        activeList = null;
        continue;
      }
    }
    if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'DIV' || child.tagName === 'P') && !child.querySelector('img,ul,ol,h3,blockquote,pre')) {
      const raw = child.textContent;
      const m = raw.match(checklistLineRe);
      if (m) {
        if (!activeList) {
          activeList = document.createElement('ul');
          child.before(activeList);
        }
        const li = document.createElement('li');
        li.setAttribute('data-done', m[2] === ' ' ? 'false' : 'true');
        li.innerHTML = child.innerHTML.replace(/^\s*(?:[-*]\s*)?\[[ xX✓]\]\s+/, '');
        activeList.append(li);
        child.remove();
        continue;
      }
    }
    activeList = null;
  }
}

function richContent(html) {
  const view = document.createElement('div');
  view.append(richFragment(html));
  normalizeChecklistBlocks(view);
  const parts = [];
  function separate() {
    if (parts.length && !parts.at(-1).endsWith('\n')) parts.push('\n');
  }
  function collect(element) {
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent);
      } else if (node.tagName === 'BR') {
        parts.push('\n');
      } else {
        const block = blockTags.has(node.tagName);
        if (block) separate();
        if (node.tagName === 'LI' && node.hasAttribute('data-done')) {
          parts.push(node.getAttribute('data-done') === 'true' ? '- [x] ' : '- [ ] ');
        }
        collect(node);
        if (block) separate();
      }
    }
  }
  collect(view);
  const text = parts.join('').trim();
  return { text, html: text || view.querySelector('img') ? view.innerHTML : undefined };
}

const checklistLineRe = /^(\s*[-*]\s*\[)([ xX✓])(\]\s+.*)$/;

function checklistStats(node) {
  if (node.richBody) {
    const view = document.createElement('div');
    view.append(richFragment(node.richBody));
    const items = [...view.querySelectorAll('li[data-done]')];
    if (items.length) {
      const done = items.filter(item => item.getAttribute('data-done') === 'true').length;
      return { total: items.length, done };
    }
  }
  const lines = (node.body || '').split(/\r?\n/);
  let total = 0;
  let done = 0;
  for (const line of lines) {
    const match = line.match(checklistLineRe);
    if (!match) continue;
    total++;
    if (match[2] !== ' ') done++;
  }
  return total ? { total, done } : null;
}

function toggleChecklistItem(node, ref) {
  const [kind, rawIndex] = String(ref).split(':');
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) return false;
  if (kind === 'rich' && node.richBody) {
    const view = document.createElement('div');
    view.append(richFragment(node.richBody));
    const item = view.querySelectorAll('li[data-done]')[index];
    if (!item) return false;
    const next = item.getAttribute('data-done') === 'true' ? 'false' : 'true';
    item.setAttribute('data-done', next);
    const clean = richContent(view.innerHTML);
    node.body = clean.text;
    if (clean.html) node.richBody = clean.html;
    return true;
  }
  if (kind === 'line') {
    const lines = (node.body || '').split(/\r?\n/);
    const match = lines[index]?.match(checklistLineRe);
    if (!match) return false;
    lines[index] = match[1] + (match[2] === ' ' ? 'x' : ' ') + match[3];
    node.body = lines.join('\n');
    if (node.richBody) {
      const view = document.createElement('div');
      view.append(richFragment(node.richBody));
      if (!view.querySelector('img') && !view.querySelector('strong,em,u,s,h3,ul,ol,blockquote,a,code,pre')) {
        delete node.richBody;
      }
    }
    return true;
  }
  return false;
}

function plainFragment(text) {
  const fragment = document.createDocumentFragment();
  if (text) {
    let list = null;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(checklistLineRe);
      if (match) {
        if (!list) {
          list = document.createElement('ul');
          fragment.append(list);
        }
        const item = document.createElement('li');
        item.setAttribute('data-done', match[2] === ' ' ? 'false' : 'true');
        item.textContent = line.replace(/^\s*[-*]\s*\[[ xX✓]\]\s+/, '');
        list.append(item);
        continue;
      }
      list = null;
      const paragraph = document.createElement('div');
      paragraph.append(line || document.createElement('br'));
      fragment.append(paragraph);
    }
  }
  return fragment;
}

