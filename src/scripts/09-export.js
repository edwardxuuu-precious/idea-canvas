const exportMime = {
  html: 'text/html;charset=utf-8', json: 'application/json;charset=utf-8', md: 'text/markdown;charset=utf-8',
  svg: 'image/svg+xml;charset=utf-8', png: 'image/png',
};
const exportNames = { png: 'PNG 图片', svg: 'SVG 矢量图', md: 'Markdown' };

function dateStamp() {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('');
}

function fileSafe(name) {
  return name.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) || '想法画布';
}

async function saveFile(kind, filename, contents) {
  if (desktop) return !!await desktop.postMessage({ operation: 'export', kind, filename, contents });
  const blob = kind === 'png'
    ? new Blob([Uint8Array.from(atob(contents), char => char.charCodeAt(0))], { type: exportMime.png })
    : new Blob([contents], { type: exportMime[kind] });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  return true;
}

async function download(kind) {
  closePopover();
  const isHtml = kind === 'html';
  try {
    const contents = isHtml ? CanvasData.exportHtml(sourceHtml, workspace) : JSON.stringify(workspace, null, 2);
    if (!await saveFile(kind, '想法画布-' + dateStamp() + '.' + kind, contents)) return;
    if (desktop) toast(isHtml ? '已导出可编辑 HTML' : '已导出 JSON');
    else toast(isHtml ? '已导出包含所有画布的可编辑 HTML' : '已导出全部画布的 JSON');
  } catch {
    toast('导出失败，请重试。', 'error');
  }
}

function exportScopeIds() {
  const ids = noteIds();
  if (!ids.length) return null;
  if (ids.length === 1) return CanvasLayout.subtree(hierarchy, ids[0]).filter(id => !visibility.hidden.has(id));
  const visible = ids.filter(id => !visibility.hidden.has(id) && nodeBy(id));
  return visible.length ? visible : null;
}

function boardToMarkdown() {
  const current = board();
  return formatNodesAsMarkdown(new Map(current.nodes.map(node => [node.id, node])), hierarchy,
    current.settings.statuses, current.settings.tags);
}

async function exportBoard(kind) {
  closePopover();
  closeSelectionSubPopovers();
  const ids = exportScopeIds();
  const firstNode = ids?.map(nodeBy).find(Boolean);
  const scope = firstNode ? '-' + fileSafe(titleOf(firstNode)) : '';
  try {
    let contents = '';
    if (kind === 'md') {
      contents = ids ? selectionToMarkdown(noteIds()) : boardToMarkdown();
    } else {
      const scene = CanvasExport.scene(ids);
      if (scene) contents = kind === 'svg' ? CanvasExport.toSVG(scene) : await CanvasExport.toPNG(scene);
    }
    if (!contents) return toast('没有可导出的卡片');
    if (!await saveFile(kind, fileSafe(board().name) + scope + '-' + dateStamp() + '.' + kind, contents)) return;
    toast((ids ? '已导出所选分支的 ' : '已导出当前画布的 ') + exportNames[kind]);
  } catch (error) {
    toast('导出失败：' + (error.message || '请重试'), 'error');
  }
}

const CanvasExport = (() => {
  const measure = document.createElement('canvas').getContext('2d');
  const padding = 48;
  const cjk = '\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F';
  const tokenPattern = new RegExp(`[${cjk}]|[^\\s${cjk}]+\\s*|\\s+`, 'g');

  function color(value, fallback = 'rgba(0, 0, 0, 0)') {
    const text = (value || '').trim();
    if (!text) return fallback;
    if (/^(#|rgb)/i.test(text)) return text;
    measure.fillStyle = '#010203';
    measure.fillStyle = text;
    return measure.fillStyle === '#010203' ? fallback : measure.fillStyle;
  }

  const isTransparent = value => !value || value === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(value);

  function hexAlpha(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    return `rgba(${value >> 16 & 255}, ${value >> 8 & 255}, ${value & 255}, ${alpha})`;
  }

  function fontOf(element) {
    const style = getComputedStyle(element);
    const size = parseFloat(style.fontSize) || 14;
    return {
      css: `${style.fontStyle === 'italic' ? 'italic ' : ''}${style.fontWeight} ${size}px ${style.fontFamily}`,
      size, weight: style.fontWeight, family: style.fontFamily,
      lineHeight: parseFloat(style.lineHeight) || size * 1.4, color: color(style.color, '#0f172a'),
    };
  }

  function wrap(text, font, width, maxLines = Infinity) {
    measure.font = font.css;
    const fits = line => measure.measureText(line).width <= width;
    const lines = [];
    for (const paragraph of text.split(/\r?\n/)) {
      let line = '';
      for (const token of paragraph.match(tokenPattern) || []) {
        if (line && !fits((line + token).trimEnd())) {
          lines.push(line.trimEnd());
          line = token.trimStart();
        } else {
          line += token;
        }
        while (line.length > 1 && !fits(line)) {
          let cut = line.length - 1;
          while (cut > 1 && !fits(line.slice(0, cut))) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      lines.push(line.trimEnd());
    }
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    let last = kept.at(-1);
    while (last && !fits(last + '…')) last = last.slice(0, -1);
    kept[kept.length - 1] = last + '…';
    return kept;
  }

  function boxIn(element, card) {
    let x = 0;
    let y = 0;
    let current = element;
    while (current && current !== card) {
      x += current.offsetLeft;
      y += current.offsetTop;
      current = current.offsetParent;
    }
    return current === card ? { x, y, w: element.offsetWidth, h: element.offsetHeight } : null;
  }

  function textShape(x, y, box, element, text, maxLines, font = fontOf(element)) {
    const lines = wrap(text, font, box.w + 2, maxLines);
    return { type: 'text', x: x + box.x, y: y + box.y, lines, font, lineHeight: font.lineHeight };
  }

  function exportBodyText(root) {
    const blocks = new Set(['DIV', 'P', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE']);
    let out = '';
    function walk(el) {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.textContent;
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.tagName === 'BR') {
          out += '\n';
          continue;
        }
        if (blocks.has(child.tagName) && out && !out.endsWith('\n')) out += '\n';
        if (child.classList?.contains('checklist-item')) {
          out += child.dataset.done === 'true' ? '☑ ' : '☐ ';
        }
        walk(child);
        if (blocks.has(child.tagName) && out && !out.endsWith('\n')) out += '\n';
      }
    }
    walk(root);
    return out.replace(/\n{3,}/g, '\n\n').trim();
  }

  function cardShapes(node, view, shapes) {
    const card = view.element;
    if (card.hidden || !card.offsetWidth) return;
    const style = getComputedStyle(card);
    const { w, h } = cardRect(node);
    const { x, y } = node;
    let fill = color(style.backgroundColor);
    let fill2 = null;
    const gradient = style.backgroundImage.match(/rgba?\([^)]*\)/g);
    if (isTransparent(fill) && card.dataset.tone === 'topic' && gradient?.length >= 2) {
      fill = color(gradient[0]);
      fill2 = color(gradient.at(-1));
    }
    shapes.push({
      type: 'rect', x, y, w, h, r: Math.min(parseFloat(style.borderTopLeftRadius) || 0, w / 2, h / 2),
      fill, fill2, stroke: color(style.borderTopColor), strokeWidth: parseFloat(style.borderTopWidth) || 0,
      shadow: !isTransparent(fill),
    });
    const typeBox = !view.type.hidden && boxIn(view.type, card);
    if (typeBox) {
      const typeStyle = getComputedStyle(view.type);
      const pill = color(typeStyle.backgroundColor);
      if (!isTransparent(pill)) shapes.push({ type: 'rect', x: x + typeBox.x, y: y + typeBox.y, w: typeBox.w, h: typeBox.h, r: typeBox.h / 2, fill: pill });
      const label = view.type.querySelector('span');
      const labelBox = label && boxIn(label, card);
      if (labelBox) {
        const dotX = x + typeBox.x + Math.max(4, (labelBox.x - typeBox.x - 5.5) / 2);
        shapes.push({ type: 'rect', x: dotX, y: y + typeBox.y + typeBox.h / 2 - 2.75, w: 5.5, h: 5.5, r: 2.75, fill: color(typeStyle.color, '#0f766e') });
        shapes.push({ ...textShape(x, y, labelBox, label, label.textContent, 1), lineHeight: labelBox.h });
      }
    }
    const titleBox = !view.title.hidden && boxIn(view.title, card);
    if (titleBox) {
      const font = fontOf(view.title);
      shapes.push(textShape(x, y, titleBox, view.title, view.title.textContent, Math.max(1, Math.round(titleBox.h / font.lineHeight)), font));
    }
    const image = !view.cover.hidden && view.cover.querySelector('img');
    const imageBox = image && boxIn(image, card);
    if (imageBox?.w && imageBox.h) shapes.push({ type: 'image', x: x + imageBox.x, y: y + imageBox.y, w: imageBox.w, h: imageBox.h, r: 8, src: image.src });
    const bodyBox = !view.body.hidden && boxIn(view.body, card);
    if (bodyBox) {
      const hasBodyImages = view.body.querySelectorAll('img').length > 0;
      if (!hasBodyImages) {
        const bodyText = exportBodyText(view.body);
        if (bodyText) {
          const font = fontOf(view.body);
          const bottomPad = parseFloat(getComputedStyle(card.querySelector('.card-copy')).paddingBottom) || 12;
          const room = Math.min(bodyBox.h, h - bodyBox.y - bottomPad);
          const maxLines = bodyBox.h > 0 ? Math.max(1, Math.floor(room / font.lineHeight + 0.25)) : 0;
          if (maxLines > 0) shapes.push(textShape(x, y, bodyBox, view.body, bodyText, maxLines, font));
        }
      } else {
        const bottomPad = parseFloat(getComputedStyle(card.querySelector('.card-copy')).paddingBottom) || 12;
        const maxBottom = h - bottomPad;
        const cardRectBox = card.getBoundingClientRect();
        const domScale = cardRectBox.width && card.offsetWidth ? cardRectBox.width / card.offsetWidth : 1;
        const emitBodyNode = item => {
          if (item.nodeType === Node.TEXT_NODE) {
            const text = item.textContent.trim();
            if (!text) return;
            const range = document.createRange();
            range.selectNodeContents(item);
            const r = range.getBoundingClientRect();
            const relBox = {
              x: (r.left - cardRectBox.left) / domScale,
              y: (r.top - cardRectBox.top) / domScale,
              w: Math.max(20, r.width / domScale),
              h: Math.max(14, r.height / domScale),
            };
            const font = fontOf(item.parentElement || view.body);
            const maxLines = Math.max(1, Math.floor(Math.min(relBox.h, maxBottom - relBox.y) / font.lineHeight + 0.25));
            if (relBox.y < maxBottom) shapes.push(textShape(x, y, relBox, view.body, text, maxLines, font));
            return;
          }
          if (item.nodeType !== Node.ELEMENT_NODE) return;
          if (item.tagName === 'IMG') {
            const bImgBox = boxIn(item, card);
            if (bImgBox?.w && bImgBox.h) shapes.push({ type: 'image', x: x + bImgBox.x, y: y + bImgBox.y, w: bImgBox.w, h: bImgBox.h, r: 7, src: item.src });
            return;
          }
          if (item.querySelector('img')) {
            for (const sub of item.childNodes) emitBodyNode(sub);
            return;
          }
          const subBox = boxIn(item, card);
          const subText = exportBodyText(item);
          if (subBox && subText && subBox.y < maxBottom) {
            const font = fontOf(item);
            const maxLines = Math.max(1, Math.floor(Math.min(subBox.h, maxBottom - subBox.y) / font.lineHeight + 0.25));
            shapes.push(textShape(x, y, subBox, item, subText, maxLines, font));
          }
        };
        for (const child of view.body.childNodes) emitBodyNode(child);
      }
    }
    if (view.meta.hidden) return;
    for (const chip of view.meta.children) {
      const box = boxIn(chip, card);
      if (!box) continue;
      const chipStyle = getComputedStyle(chip);
      shapes.push({
        type: 'rect', x: x + box.x, y: y + box.y, w: box.w, h: box.h, r: box.h / 2,
        fill: color(chipStyle.backgroundColor), stroke: color(chipStyle.borderTopColor), strokeWidth: 1,
      });
      const inset = parseFloat(chipStyle.paddingLeft) || 7;
      shapes.push({ ...textShape(x, y, { ...box, x: box.x + inset, w: box.w - inset * 2 }, chip, chip.textContent.trim(), 1), lineHeight: box.h });
    }
  }

  function scene(ids = null) {
    const current = board();
    const wanted = ids && new Set(ids);
    const nodes = current.nodes.filter(node => !visibility.hidden.has(node.id) && (!wanted || wanted.has(node.id)));
    if (!nodes.length) return null;
    const rects = new Map(nodes.map(node => [node.id, cardRect(node)]));
    const rootStyle = getComputedStyle(document.documentElement);
    const ink = color(rootStyle.getPropertyValue('--ink'), '#0f172a');
    const inkSoft = color(rootStyle.getPropertyValue('--ink-soft'), '#475569');
    const paper = color(rootStyle.getPropertyValue('--paper'), '#ffffff');
    const line = color(rootStyle.getPropertyValue('--line'), '#e2e8f0');
    const family = rootStyle.fontFamily;
    const shapes = [];
    const boxes = [...rects.values()].map(({ x, y, w, h }) => ({ x, y, w, h }));

    for (const frame of current.settings.frames) {
      const members = frame.members.filter(id => rects.has(id));
      if (wanted && !members.length) continue;
      const memberBox = wanted && boundsOf(members.map(id => rects.get(id)));
      const box = memberBox
        ? { x: memberBox.left - 18, y: memberBox.top - 45, w: memberBox.w + 36, h: memberBox.h + 64 }
        : CanvasViews.frameRect(frame, null, visibility.hidden);
      if (!box) continue;
      const font = { css: `620 12.5px ${family}`, size: 12.5, weight: '620', family, lineHeight: 26, color: ink };
      measure.font = font.css;
      const labelWidth = Math.min(box.w - 20, measure.measureText(frame.name).width + 22);
      shapes.push({ type: 'rect', ...box, r: 18, fill: frame.color, fillOpacity: .09, stroke: frame.color, strokeWidth: 1.5 });
      shapes.push({ type: 'rect', x: box.x + 10, y: box.y + 8, w: labelWidth, h: 26, r: 8, fill: paper, stroke: frame.color, strokeWidth: 1 });
      shapes.push({ type: 'text', x: box.x + 21, y: box.y + 8, lines: wrap(frame.name, font, labelWidth - 22, 1), font, lineHeight: 26 });
      boxes.push(box);
    }

    const layout = displayedLayout();
    const layoutGuides = layout.guides || [];
    const includeGuides = layoutGuides.length > 0 && (!wanted || current.nodes.every(node => visibility.hidden.has(node.id) || wanted.has(node.id)));
    const matrix = includeGuides && layout.options.mode === 'matrix';
    const canvasBg = color(current.settings.appearance.background, '#f5f6f8');
    if (includeGuides) {
      const guideColor = color(rootStyle.getPropertyValue('--board-accent'), current.settings.appearance.accent || '#0f766e');
      const guideInk = color(rootStyle.getPropertyValue('--guide-ink'), guideColor);
      const tracks = matrix ? CanvasLayout.matrixTracks(layout.options, layoutGuides, current.settings.statuses) : null;
      const columns = matrix ? layoutGuides.filter(guide => guide.kind === 'line' && guide.x === guide.x2) : [];
      const matrixLeft = columns.length ? Math.min(...columns.map(guide => guide.x)) : 0;
      if (columns.length >= 2) {
        const rowLines = layoutGuides.filter(guide => guide.kind === 'line' && guide.y === guide.y2).sort((a, b) => a.y - b.y);
        const right = Math.max(...columns.map(guide => guide.x));
        for (let index = 0; index < rowLines.length - 1; index += 2) {
          const y = rowLines[index].y;
          const h = rowLines[index + 1].y - y;
          shapes.push({ type: 'rect', x: matrixLeft, y, w: right - matrixLeft, h, r: 0, fill: guideColor, fillOpacity: 0.045 });
          boxes.push({ x: matrixLeft, y, w: right - matrixLeft, h });
        }
      }
      const fontSize = matrix ? 16 : 14;
      const lineHeight = Math.round(fontSize * 1.25);
      const guideFont = { css: `650 ${fontSize}px ${family}`, size: fontSize, weight: '650', family, lineHeight, color: guideInk };
      const guideLabels = [];
      for (const guide of layoutGuides) {
        if (guide.kind === 'line') {
          shapes.push({
            type: 'path', d: `M ${guide.x} ${guide.y} L ${guide.x2} ${guide.y2}`,
            color: guideColor, width: 1.4, opacity: 0.42,
          });
          boxes.push({
            x: Math.min(guide.x, guide.x2), y: Math.min(guide.y, guide.y2),
            w: Math.max(1, Math.abs(guide.x2 - guide.x)), h: Math.max(1, Math.abs(guide.y2 - guide.y)),
          });
          continue;
        }
        const rowLabel = matrix && columns.length && guide.x < matrixLeft;
        const track = tracks && (rowLabel ? matrixTrackAt(tracks.rows, guide.y) : matrixTrackAt(tracks.columns, guide.x));
        const text = track?.name ?? guide.text ?? '';
        if (!text) continue;
        measure.font = guideFont.css;
        const textWidth = Math.ceil(measure.measureText(text).width);
        const textX = rowLabel ? matrixLeft - 12 - textWidth : guide.x;
        const textY = rowLabel ? guide.y - lineHeight / 2 : guide.y - fontSize * 0.35 - lineHeight / 2;
        guideLabels.push({
          type: 'text', x: textX, y: textY, lines: [text], font: guideFont, lineHeight,
          halo: matrix ? canvasBg : null,
        });
        boxes.push({ x: textX, y: textY, w: Math.max(1, textWidth), h: lineHeight });
      }
      shapes.push(...guideLabels);
    }

    const downward = layout.options.mode === 'down';
    const labels = [];
    for (const edge of current.edges) {
      const from = rects.get(edge.from);
      const to = rects.get(edge.to);
      if (!from || !to) continue;
      const style = edgeStyle(edge);
      const side = downward && hierarchy.parent.get(edge.to) === edge.from && to.y >= from.y + from.h ? 'down' : undefined;
      const curve = linkCurve(from, to, false, style.shape, side);
      shapes.push({
        type: 'path', d: curve.path, color: color(style.color, '#64748b'), width: style.width,
        dash: lineDashes[style.dash] || null, round: style.dash === 'dotted',
        opacity: matrix ? 0.28 : undefined,
        start: style.arrow === 'start' || style.arrow === 'both' ? curve.start : null,
        end: style.arrow === 'end' || style.arrow === 'both' ? curve.end : null,
      });
      if (!edge.label) continue;
      const text = [...edge.label].length > 20 ? [...edge.label].slice(0, 20).join('') + '…' : edge.label;
      const width = [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 12 : 7), 16);
      const font = { css: `550 11.5px ${family}`, size: 11.5, weight: '550', family, lineHeight: 20, color: inkSoft };
      const box = { x: curve.label.x - width / 2, y: curve.label.y - 10, w: width, h: 20 };
      const edgeOpacity = matrix ? 0.28 : undefined;
      labels.push({ type: 'rect', ...box, r: 10, fill: paper, stroke: line, strokeWidth: 1, opacity: edgeOpacity });
      measure.font = font.css;
      const textWidth = measure.measureText(text).width;
      labels.push({ type: 'text', x: curve.label.x - textWidth / 2, y: box.y, lines: [text], font, lineHeight: 20, opacity: edgeOpacity });
      boxes.push(box);
    }
    shapes.push(...labels);
    const hadOverview = viewport.classList.contains('is-overview');
    const hadZoomedOut = viewport.classList.contains('is-zoomed-out');
    viewport.classList.remove('is-overview', 'is-zoomed-out');
    try {
      for (const node of nodes) cardShapes(node, cardIndex.get(node.id), shapes);
    } finally {
      viewport.classList.toggle('is-overview', hadOverview);
      viewport.classList.toggle('is-zoomed-out', hadZoomedOut);
    }

    const left = Math.min(...boxes.map(box => box.x)) - padding;
    const top = Math.min(...boxes.map(box => box.y)) - padding;
    const right = Math.max(...boxes.map(box => box.x + box.w)) + padding;
    const bottom = Math.max(...boxes.map(box => box.y + box.h)) + padding;
    return {
      x: left, y: top, width: Math.ceil(right - left), height: Math.ceil(bottom - top),
      background: color(current.settings.appearance.background, '#f5f6f8'), shapes,
    };
  }

  const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const round = value => Math.round(value * 10) / 10;

  function toSVG(view) {
    const defs = ['<filter id="card-shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#0f172a" flood-opacity="0.08"/></filter>'];
    const markers = new Map();
    const body = [];
    let serial = 0;
    const marker = stroke => {
      if (!markers.has(stroke)) {
        const id = 'arrow-' + markers.size;
        markers.set(stroke, id);
        defs.push(`<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M2 1.8L8.2 5L2 8.2" fill="none" stroke="${escapeXml(stroke)}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></marker>`);
      }
      return markers.get(stroke);
    };
    for (const shape of view.shapes) {
      if (shape.type === 'rect') {
        let fill = isTransparent(shape.fill) ? 'none' : escapeXml(shape.fill);
        if (shape.fill2) {
          const id = 'fill-' + serial++;
          defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${escapeXml(shape.fill)}"/><stop offset="1" stop-color="${escapeXml(shape.fill2)}"/></linearGradient>`);
          fill = `url(#${id})`;
        }
        const stroke = shape.strokeWidth && !isTransparent(shape.stroke) ? ` stroke="${escapeXml(shape.stroke)}" stroke-width="${shape.strokeWidth}"` : '';
        if (fill === 'none' && !stroke) continue;
        const fillOpacity = shape.fillOpacity != null ? ` fill-opacity="${shape.fillOpacity}"` : '';
        const opacity = shape.opacity != null ? ` opacity="${shape.opacity}"` : '';
        const shadow = shape.shadow ? ' filter="url(#card-shadow)"' : '';
        body.push(`<rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.w)}" height="${round(shape.h)}" rx="${round(shape.r || 0)}" fill="${fill}"${fillOpacity}${opacity}${stroke}${shadow}/>`);
      } else if (shape.type === 'text') {
        const spans = shape.lines.map((text, index) =>
          `<tspan x="${round(shape.x)}" y="${round(shape.y + shape.lineHeight * (index + .5))}">${escapeXml(text)}</tspan>`).join('');
        const halo = shape.halo ? ` stroke="${escapeXml(shape.halo)}" stroke-width="3" stroke-linejoin="round" paint-order="stroke"` : '';
        const opacity = shape.opacity != null ? ` opacity="${shape.opacity}"` : '';
        body.push(`<text font-family="${escapeXml(shape.font.family)}" font-size="${shape.font.size}" font-weight="${shape.font.weight}" fill="${escapeXml(shape.font.color)}"${halo}${opacity} dominant-baseline="central">${spans}</text>`);
      } else if (shape.type === 'image') {
        const id = 'clip-' + serial++;
        defs.push(`<clipPath id="${id}"><rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.w)}" height="${round(shape.h)}" rx="${shape.r}"/></clipPath>`);
        body.push(`<image href="${escapeXml(shape.src)}" x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.w)}" height="${round(shape.h)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`);
      } else if (shape.type === 'path') {
        const dash = shape.dash ? ` stroke-dasharray="${shape.dash}"` : '';
        const cap = shape.round ? ' stroke-linecap="round"' : '';
        const opacity = shape.opacity != null ? ` opacity="${shape.opacity}"` : '';
        const start = shape.start ? ` marker-start="url(#${marker(shape.color)})"` : '';
        const end = shape.end ? ` marker-end="url(#${marker(shape.color)})"` : '';
        body.push(`<path d="${shape.d}" fill="none" stroke="${escapeXml(shape.color)}" stroke-width="${shape.width}"${opacity}${dash}${cap}${start}${end}/>`);
      }
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="${round(view.x)} ${round(view.y)} ${view.width} ${view.height}">` +
      `<defs>${defs.join('')}</defs><rect x="${round(view.x)}" y="${round(view.y)}" width="${view.width}" height="${view.height}" fill="${escapeXml(view.background)}"/>${body.join('')}</svg>\n`;
  }

  function roundedPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function arrowHead(ctx, tip, width) {
    const length = 4.3 * width + 1.5;
    const half = 2.2 * width + 1;
    const backX = tip.x - tip.dx * length;
    const backY = tip.y - tip.dy * length;
    ctx.beginPath();
    ctx.moveTo(backX - tip.dy * half, backY + tip.dx * half);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(backX + tip.dy * half, backY - tip.dx * half);
    ctx.stroke();
  }

  async function toPNG(view) {
    const scale = Math.min(2, Math.sqrt(16e6 / (view.width * view.height)), 16384 / view.width, 16384 / view.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(view.width * scale));
    canvas.height = Math.max(1, Math.round(view.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.translate(-view.x, -view.y);
    ctx.fillStyle = view.background;
    ctx.fillRect(view.x, view.y, view.width, view.height);
    const images = new Map();
    await Promise.all(view.shapes.filter(shape => shape.type === 'image').map(async shape => {
      const image = new Image();
      image.src = shape.src;
      try {
        await image.decode();
        images.set(shape, image);
      } catch {
        // A broken image leaves its card readable without the picture.
      }
    }));
    for (const shape of view.shapes) {
      ctx.save();
      if (shape.type === 'rect') {
        const baseAlpha = shape.opacity != null ? shape.opacity : 1;
        roundedPath(ctx, shape.x, shape.y, shape.w, shape.h, shape.r || 0);
        if (!isTransparent(shape.fill)) {
          if (shape.fill2) {
            const gradient = ctx.createLinearGradient(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h);
            gradient.addColorStop(0, shape.fill);
            gradient.addColorStop(1, shape.fill2);
            ctx.fillStyle = gradient;
          } else {
            ctx.fillStyle = shape.fill;
          }
          if (shape.shadow) {
            ctx.shadowColor = 'rgba(15, 23, 42, 0.08)';
            ctx.shadowBlur = 12;
            ctx.shadowOffsetY = 4;
          }
          ctx.globalAlpha = baseAlpha * (shape.fillOpacity != null ? shape.fillOpacity : 1);
          ctx.fill();
          ctx.shadowColor = 'transparent';
        }
        if (shape.strokeWidth && !isTransparent(shape.stroke)) {
          ctx.globalAlpha = baseAlpha;
          ctx.lineWidth = shape.strokeWidth;
          ctx.strokeStyle = shape.stroke;
          ctx.stroke();
        }
      } else if (shape.type === 'text') {
        if (shape.opacity != null) ctx.globalAlpha = shape.opacity;
        ctx.font = shape.font.css;
        ctx.fillStyle = shape.font.color;
        ctx.textBaseline = 'middle';
        if (shape.halo) {
          ctx.strokeStyle = shape.halo;
          ctx.lineWidth = 3;
          ctx.lineJoin = 'round';
        }
        shape.lines.forEach((text, index) => {
          const ty = shape.y + shape.lineHeight * (index + .5);
          if (shape.halo) ctx.strokeText(text, shape.x, ty);
          ctx.fillText(text, shape.x, ty);
        });
      } else if (shape.type === 'image' && images.has(shape)) {
        roundedPath(ctx, shape.x, shape.y, shape.w, shape.h, shape.r);
        ctx.clip();
        ctx.drawImage(images.get(shape), shape.x, shape.y, shape.w, shape.h);
      } else if (shape.type === 'path') {
        if (shape.opacity != null) ctx.globalAlpha = shape.opacity;
        ctx.strokeStyle = shape.color;
        ctx.lineWidth = shape.width;
        ctx.lineJoin = 'round';
        ctx.lineCap = shape.round ? 'round' : 'butt';
        if (shape.dash) ctx.setLineDash(shape.dash.split(' ').map(Number));
        ctx.stroke(new Path2D(shape.d));
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
        for (const tip of [shape.start, shape.end]) if (tip) arrowHead(ctx, tip, shape.width);
      }
      ctx.restore();
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }

  return { scene, toSVG, toPNG };
})();

