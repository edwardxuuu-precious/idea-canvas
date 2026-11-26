function freePosition(x, y, width, height) {
  const nodes = board().nodes;
  const rectangles = nodes.map(node => cardRect(node));
  const step = height + 34;
  const overlaps = candidate => rectangles.some(node =>
    x < node.x + node.w + 16 && x + width + 16 > node.x &&
    candidate < node.y + node.h + 16 && candidate + height + 16 > node.y
  );
  for (let index = 0; index <= nodes.length * 2 + 2; index++) {
    const offset = Math.ceil(index / 2) * (index % 2 ? 1 : -1);
    const candidate = y + offset * step;
    if (!overlaps(candidate)) return { x: coordinate(x), y: coordinate(candidate) };
  }
  return { x: coordinate(x), y: coordinate((boundsOf(nodes)?.bottom || 0) + 34) };
}

function blankCard(location = null, parent = null, sibling = null) {
  const w = 264;
  const h = 154;
  let position = location ? { x: location.x - w / 2, y: location.y - h / 2 } : { x: camera.x - w / 2, y: camera.y - h / 2 };
  if (!location && parent) {
    const rect = cardRect(parent);
    position = { x: rect.x + rect.w + 76, y: rect.y + (rect.h - h) / 2 };
  }
  if (!location && sibling) {
    const rect = cardRect(sibling);
    position = { x: rect.x, y: rect.y + rect.h + 24 };
  }
  return {
    id: CanvasData.uid(), ...freePosition(position.x, position.y, w, h), w, h,
    tone: sibling && sibling.tone !== 'topic' ? sibling.tone : 'idea', title: '', body: '',
  };
}

function addEdge(from, to, kind = 'link') {
  const id = CanvasData.uid();
  board().edges.push({ id, from, to, label: '', kind });
  return id;
}

function connect(from, to) {
  if (from === to) return;
  const existing = board().edges.find(edge =>
    (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from)
  );
  setMode('select');
  if (existing) {
    setSelected([], existing.id);
    toast('两张卡片已有连线');
    return;
  }
  checkpoint();
  const id = addEdge(from, to);
  selection = { kind: 'edge', id };
  render();
  save();
}

function paintToneChoices() {
  for (const element of $('#tone-options').children) element.setAttribute('aria-pressed', element.dataset.tone === modalNote.tone);
}

function editorSelection() {
  const selected = window.getSelection();
  if (!selected?.rangeCount) return null;
  const range = selected.getRangeAt(0);
  return noteBody.contains(range.startContainer) && noteBody.contains(range.endContainer) ? range : null;
}

function focusEditor() {
  noteBody.focus({ preventScroll: true });
  const selected = window.getSelection();
  let range = editorRange;
  if (!range || !noteBody.contains(range.startContainer) || !noteBody.contains(range.endContainer)) {
    range = document.createRange();
    range.selectNodeContents(noteBody);
    range.collapse(false);
  }
  selected.removeAllRanges();
  selected.addRange(range);
  return range;
}

function paintFormat() {
  const range = editorSelection();
  const inBody = !!range;
  const anchorEl = range ? (range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer) : null;
  for (const button of formatButtons) {
    const command = button.dataset.format;
    const active = inBody && (command === 'checklist'
      ? !!anchorEl?.closest?.('li[data-done]')
      : command === 'formatBlock'
        ? document.queryCommandValue(command).toLowerCase() === 'h3'
        : document.queryCommandState(command));
    button.setAttribute('aria-pressed', String(active));
  }
}

function selectImage(image) {
  pickedImage?.classList.remove('is-picked');
  pickedImage = image;
  pickedImage?.classList.add('is-picked');
  $('#note-image-remove').hidden = !image;
}

function imageMessage(text = '') {
  const status = $('#note-image-status');
  status.textContent = text;
  status.hidden = !text;
}

function updateNoteProvenanceSummary() {
  const count = noteSourcesRows.children.length;
  const hasExtra = !!noteExtra.value.trim();
  noteProvenanceSummary.textContent = count && hasExtra ? `（${count} 条 · 有备注）`
    : count ? `（${count} 条）`
    : hasExtra ? '（有备注）' : '';
}

function appendNoteSourceRow(label = '', url = '') {
  const row = document.createElement('div');
  row.className = 'note-source-row';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'field';
  labelInput.placeholder = '来源标题（如：家长原帖）';
  labelInput.value = label;
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'field';
  urlInput.placeholder = 'https://… 或文档路径';
  urlInput.value = url;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'icon-btn btn-danger';
  removeBtn.title = '移除此来源';
  removeBtn.setAttribute('aria-label', '移除此来源');
  removeBtn.innerHTML = icon('close');
  labelInput.addEventListener('input', () => { updateNoteProvenanceSummary(); syncNote(); });
  urlInput.addEventListener('input', () => { syncNote(); });
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateNoteProvenanceSummary();
    syncNote();
  });
  row.append(labelInput, urlInput, removeBtn);
  noteSourcesRows.append(row);
  updateNoteProvenanceSummary();
}

function readNoteSourcesFromForm() {
  const items = [];
  for (const row of noteSourcesRows.children) {
    const [labelInput, urlInput] = row.querySelectorAll('input');
    const label = utf8Slice([...labelInput.value.trim()].slice(0, 160).join(''), 600);
    if (!label) continue;
    const url = cleanSourceUrl(urlInput.value);
    items.push(url ? { label, url } : { label });
    if (items.length >= 64) break;
  }
  return items;
}

function openNote(node, isNew = false, parent = null) {
  if (inlineEdit) finishInline({ keepFocus: true });
  dismissIdleTip();
  closePopover();
  closeSelectionSubPopovers();
  closeSourcePopover();
  closeContextMenu();
  modalNote = { node, isNew, parent, tone: node.tone, checkpointed: false, bodyChanged: false, imageJob: null };
  $('#note-heading').textContent = isNew ? (parent ? '新建分支' : '新建卡片') : '编辑卡片';
  noteTitle.value = node.title;
  noteBody.replaceChildren(node.richBody ? richFragment(node.richBody) : plainFragment(node.body));
  noteBody.dataset.empty = String(!node.richBody && !node.body.trim());
  noteExtra.value = node.note || '';
  noteSourcesRows.replaceChildren();
  for (const src of node.sources || []) appendNoteSourceRow(src.label, src.url || '');
  updateNoteProvenanceSummary();
  noteProvenance.open = !!(node.note?.trim() || node.sources?.length);
  editorRange = null;
  selectImage(null);
  imageMessage();
  paintFormat();
  paintToneChoices();
  noteDialog.showModal();
  noteTitle.focus();
  if (!isNew) noteTitle.setSelectionRange(0, node.title.length);
}

function syncNote() {
  if (!modalNote) return;
  const { node, isNew, parent, tone, bodyChanged } = modalNote;
  const title = noteTitle.value;
  const { text: body, html: richBody } = bodyChanged
    ? richContent(noteBody.innerHTML)
    : { text: node.body, html: node.richBody };
  const note = utf8Slice(noteExtra.value.trim(), 16_000);
  const sources = readNoteSourcesFromForm();
  modalNote.bodyChanged = false;
  noteBody.dataset.empty = String(!richBody && !body.trim());
  if (isNew && !title.trim() && !body.trim() && !richBody && !note && !sources.length) return;
  const sameNote = (node.note || '') === note;
  const sameSources = JSON.stringify(node.sources || []) === JSON.stringify(sources);
  if (node.title === title && node.body === body && node.richBody === richBody && node.tone === tone && sameNote && sameSources) return;
  if (!modalNote.checkpointed) {
    checkpoint();
    modalNote.checkpointed = true;
  }
  Object.assign(node, { title, body, tone });
  if (richBody) node.richBody = richBody;
  else delete node.richBody;
  if (note) node.note = note;
  else delete node.note;
  if (sources.length) node.sources = sources;
  else delete node.sources;
  if (isNew) {
    board().nodes.push(node);
    if (parent && nodeBy(parent.id)) {
      addEdge(parent.id, node.id, 'branch');
      board().settings.folded = board().settings.folded.filter(id => id !== parent.id);
    }
    modalNote.isNew = false;
    selection = { kind: 'cards', ids: new Set([node.id]) };
  }
  render();
  if (isNew) reveal(node);
  queueSave();
}

function editNoteBody() {
  if (!modalNote) return;
  modalNote.bodyChanged = true;
  if (pickedImage && !noteBody.contains(pickedImage)) selectImage(null);
  syncNote();
  paintFormat();
}

function insertBodyHtml(html) {
  if (!html) return;
  const range = focusEditor();
  if (!document.execCommand('insertHTML', false, html)) {
    const fragment = richFragment(html);
    const last = fragment.lastChild;
    if (!last) return;
    range.deleteContents();
    range.insertNode(fragment);
    range.setStartAfter(last);
    range.collapse(true);
  }
  editorRange = editorSelection()?.cloneRange() ?? null;
  editNoteBody();
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function pictureData(file) {
  if ((file.type && !imageType.test(file.type)) || file.size > 20_000_000) {
    throw new Error('请选择 20 MB 以内的 PNG、JPG、WebP 或 GIF 图片。');
  }
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    if (!longest) throw new Error('无法读取这张图片。');
    if (file.type && file.size < 590_000 && longest <= 2000) {
      const original = await readDataUrl(file);
      if (original.length <= imageDataLimit && imageData.test(original)) return original;
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    let scale = Math.min(1, 1920 / longest);
    for (let attempt = 0; attempt < 5; attempt++, scale *= .74) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', .88);
      if (data.length <= imageDataLimit && imageData.test(data)) return data;
    }
    throw new Error('这张图片过大。请裁切后再插入。');
  } finally {
    URL.revokeObjectURL(source);
  }
}

function canAddPictureBytes(length) {
  const budget = syncing ? 10_000_000 : 4_000_000;
  return new Blob([JSON.stringify(workspace)]).size + length < budget;
}

function transferNoteContent(transfer) {
  if (!transfer || !modalNote) return;
  const files = [...transfer.files];
  const html = transfer.getData('text/html');
  const text = transfer.getData('text/plain');
  const rich = richContent(html);
  if (files.length) {
    if (rich.text || (!html && text.trim() && !transfer.types.includes('text/uri-list'))) {
      const plain = document.createElement('div');
      plain.append(rich.text ? richFragment(rich.html) : plainFragment(text));
      for (const image of plain.querySelectorAll('img')) image.remove();
      insertBodyHtml(plain.innerHTML);
    }
    void addPictures(files);
    return;
  }
  if (rich.html && (!rich.html.includes('<img ') || canAddPictureBytes(rich.html.length))) {
    insertBodyHtml(rich.html);
    return;
  }
  const plain = document.createElement('div');
  plain.append(plainFragment(text));
  insertBodyHtml(plain.innerHTML);
  if (rich.html?.includes('<img ')) imageMessage('画布的图片存储空间已满。');
}

async function addPictures(files) {
  const editing = modalNote;
  if (!editing || editing.imageJob || !files.length) return;
  const insertion = editorRange?.cloneRange();
  insertion?.collapse(false);
  const addButton = $('#note-image-add');
  const finishButton = $('#note-form button[type="submit"]');
  addButton.disabled = true;
  finishButton.disabled = true;
  imageMessage('正在处理图片…');
  editing.imageJob = (async () => {
    const images = document.createElement('div');
    let message = '';
    let length = 0;
    for (const file of files) {
      try {
        const data = await pictureData(file);
        if (!canAddPictureBytes(length + data.length + 200)) {
          message = '画布的图片存储空间已满。可移除旧图片后再添加。';
          break;
        }
        const image = document.createElement('img');
        image.src = data;
        image.alt = (file.name || '卡片图片').slice(0, 140);
        images.append(image);
        length += data.length + 200;
      } catch (error) {
        message = error.message || '无法读取所选图片。';
      }
    }
    if (modalNote !== editing || !noteDialog.open) return;
    if (insertion) editorRange = insertion;
    insertBodyHtml(images.innerHTML);
    imageMessage(message);
  })();
  try {
    await editing.imageJob;
  } finally {
    editing.imageJob = null;
    addButton.disabled = false;
    finishButton.disabled = false;
  }
}

function finishNote() {
  if (modalNote?.imageJob) return;
  syncNote();
  noteDialog.close();
}

function toggleChecklistCommand(container, editCallback) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  let block = sel.getRangeAt(0).startContainer;
  if (block.nodeType === Node.TEXT_NODE) block = block.parentElement;
  const existingLi = block?.closest?.('li');
  if (existingLi && container.contains(existingLi)) {
    if (existingLi.hasAttribute('data-done')) existingLi.removeAttribute('data-done');
    else existingLi.setAttribute('data-done', 'false');
    editCallback();
    return;
  }
  document.execCommand('insertUnorderedList', false, null);
  const current = window.getSelection()?.anchorNode;
  const li = (current?.nodeType === Node.TEXT_NODE ? current.parentElement : current)?.closest?.('li');
  if (li && container.contains(li)) li.setAttribute('data-done', 'false');
  editCallback();
}

function maybeConvertChecklistShortcut(container, editCallback) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !container.contains(node)) return;
  const before = node.textContent.slice(0, range.startOffset);
  const match = before.match(/^(?:[-*]\s*)?\[([ xX]?)\]\s$/);
  if (!match) return;
  const rest = node.textContent.slice(range.startOffset);
  const li = node.parentElement?.closest?.('li');
  if (li && container.contains(li)) {
    li.setAttribute('data-done', match[1] && match[1] !== ' ' ? 'true' : 'false');
    node.textContent = rest;
  } else {
    const block = node.parentElement && node.parentElement !== container ? node.parentElement : null;
    const ul = document.createElement('ul');
    const item = document.createElement('li');
    item.setAttribute('data-done', match[1] && match[1] !== ' ' ? 'true' : 'false');
    item.append(rest || document.createElement('br'));
    ul.append(item);
    if (block && block.parentElement === container) block.replaceWith(ul);
    else node.replaceWith(ul);
    const newRange = document.createRange();
    newRange.setStart(item, 0);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
  editCallback();
}

function resolveChecklistLi(container, sel) {
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const candidates = [range.startContainer, sel.anchorNode, sel.focusNode].filter(Boolean);
  for (const node of candidates) {
    const direct = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.('li[data-done]');
    if (direct && container.contains(direct)) return direct;
  }
  const anchor = range.startContainer;
  const offset = range.startOffset;
  if (anchor.nodeName === 'UL' && container.contains(anchor)) {
    const candidate = anchor.childNodes[Math.max(0, offset - 1)] || anchor.lastElementChild;
    if (candidate?.matches?.('li[data-done]')) return candidate;
  }
  if (anchor === container && offset > 0) {
    const prev = container.childNodes[offset - 1];
    if (prev?.nodeName === 'UL' && prev.lastElementChild?.matches?.('li[data-done]')) {
      return prev.lastElementChild;
    }
  }
  return null;
}

function repairSplitChecklist(container, inputEvent) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const anchor = sel.getRangeAt(0).startContainer;
  const anchorEl = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
  if (anchorEl?.hasAttribute?.('data-exit-check') && anchorEl.textContent.trim()) {
    anchorEl.removeAttribute('data-exit-check');
  }
  const block = anchorEl?.closest?.('div, p');
  if (!block || block.parentElement !== container || block.hasAttribute('data-exit-check')) return;
  const prev = block.previousElementSibling;
  if (prev?.nodeName !== 'UL' || !prev.lastElementChild?.matches?.('li[data-done]')) return;
  if (inputEvent?.inputType !== 'insertParagraph' && block.textContent.trim() !== '') return;
  const nextLi = document.createElement('li');
  nextLi.setAttribute('data-done', 'false');
  while (block.firstChild) nextLi.append(block.firstChild);
  if (!nextLi.firstChild) nextLi.append(document.createElement('br'));
  prev.append(nextLi);
  block.remove();
  const nextRange = document.createRange();
  nextRange.setStart(nextLi, 0);
  nextRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(nextRange);
}

function handleChecklistEnter(event, container, editCallback) {
  if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.isComposing || event.keyCode === 229) return false;
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const anchor = sel.getRangeAt(0).startContainer;
  let li = resolveChecklistLi(container, sel);
  if (!li && anchor.nodeType === Node.TEXT_NODE && container.contains(anchor)) {
    const lineMatch = anchor.textContent.match(checklistLineRe);
    if (lineMatch) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      const block = anchor.parentElement && anchor.parentElement !== container ? anchor.parentElement : null;
      const ul = document.createElement('ul');
      li = document.createElement('li');
      li.setAttribute('data-done', lineMatch[2] === ' ' ? 'false' : 'true');
      li.textContent = anchor.textContent.replace(/^\s*[-*]\s*\[[ xX✓]\]\s+/, '');
      const nextLi = document.createElement('li');
      nextLi.setAttribute('data-done', 'false');
      nextLi.append(document.createElement('br'));
      ul.append(li, nextLi);
      if (block && block.parentElement === container) block.replaceWith(ul);
      else anchor.replaceWith(ul);
      const nextRange = document.createRange();
      nextRange.setStart(nextLi, 0);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
      editCallback();
      return true;
    }
  }
  if (!li || !container.contains(li)) return false;
  event.preventDefault();
  event.stopImmediatePropagation?.();
  const text = li.textContent.trim();
  if (!text) {
    const ul = li.parentElement;
    const div = document.createElement('div');
    div.dataset.exitCheck = '1';
    div.append(document.createElement('br'));
    li.remove();
    if (!ul.children.length) ul.replaceWith(div);
    else ul.after(div);
    const nextRange = document.createRange();
    nextRange.setStart(div, 0);
    nextRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(nextRange);
    editCallback();
    return true;
  }
  const nextLi = document.createElement('li');
  nextLi.setAttribute('data-done', 'false');
  nextLi.append(document.createElement('br'));
  li.after(nextLi);
  const nextRange = document.createRange();
  nextRange.setStart(nextLi, 0);
  nextRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(nextRange);
  editCallback();
  return true;
}

function handleChecklistClickInEditor(event, container, editCallback) {
  const li = event.target.closest?.('li[data-done]');
  if (!li || !container.contains(li)) return;
  const rect = li.getBoundingClientRect();
  if (event.clientX - rect.left <= 22) {
    event.preventDefault();
    li.setAttribute('data-done', li.getAttribute('data-done') === 'true' ? 'false' : 'true');
    editCallback();
  }
}

function syncInline() {
  if (!inlineEdit) return;
  const { node, isNew, parent, titleInput, bodyEditor } = inlineEdit;
  const title = titleInput.value;
  const { text: body, html: richBody } = inlineEdit.bodyChanged
    ? richContent(bodyEditor.innerHTML)
    : { text: node.body, html: node.richBody };
  inlineEdit.bodyChanged = false;
  bodyEditor.dataset.empty = String(!richBody && !body.trim());
  if (isNew && !title.trim() && !body.trim() && !richBody) return;
  if (node.title === title && node.body === body && node.richBody === richBody && node.tone === inlineEdit.tone) return;
  if (!inlineEdit.checkpointed) {
    checkpoint();
    inlineEdit.checkpointed = true;
  }
  Object.assign(node, { title, body, tone: inlineEdit.tone });
  if (richBody) node.richBody = richBody;
  else delete node.richBody;
  if (isNew) {
    board().nodes.push(node);
    if (parent && nodeBy(parent.id)) {
      addEdge(parent.id, node.id, 'branch');
      board().settings.folded = board().settings.folded.filter(id => id !== parent.id);
    }
    inlineEdit.isNew = false;
    selection = { kind: 'cards', ids: new Set([node.id]) };
  }
  queueSave();
}

function finishInline(options = {}) {
  const active = inlineEdit;
  if (!active) return;
  syncInline();
  inlineEdit = null;
  active.element.classList.remove('is-editing');
  active.element.style.width = '';
  active.element.style.minWidth = '';
  active.element.style.maxWidth = '';
  active.toolbar.remove();
  active.titleInput.remove();
  active.bodyEditor.remove();
  active.hint.remove();
  const view = cardIndex.get(active.node.id);
  if (view) view.size = null;
  if (active.isNew) {
    cardSizes.unobserve(active.element);
    active.element.remove();
    cardIndex.delete(active.node.id);
    render();
    return;
  }
  if (!options.keepFocus) focusCanvas();
  render();
  save();
}

function cancelInline() {
  const active = inlineEdit;
  if (!active) return;
  if (active.isNew) {
    inlineEdit = null;
    cardSizes.unobserve(active.element);
    active.element.remove();
    cardIndex.delete(active.node.id);
    render();
    focusCanvas();
    return;
  }
  finishInline();
}

function openInline(node, { isNew = false, parent = null, focusBody = false, triggerKey = null } = {}) {
  if (inlineEdit?.node.id === node.id) {
    (focusBody ? inlineEdit.bodyEditor : inlineEdit.titleInput).focus({ preventScroll: true });
    return;
  }
  if (inlineEdit) finishInline({ keepFocus: true });
  dismissIdleTip();
  closePopover();
  closeSelectionSubPopovers();
  closeSourcePopover();
  closeContextMenu();
  if (isNew) {
    if (!board().nodes.includes(node) && !cardIndex.has(node.id)) {
      const createdView = createCardView(node.id);
      createdView.element.dataset.tone = node.tone;
      createdView.element.dataset.profile = 'note';
      createdView.type.innerHTML = icon(node.tone) + '<span>' + CanvasData.tone[node.tone].label + '</span>';
      createdView.type.hidden = node.tone === 'idea';
      placeCard(createdView.element, node);
    }
  } else {
    selection = { kind: 'cards', ids: new Set([node.id]) };
    renderSelection();
  }
  const view = cardIndex.get(node.id);
  if (!view) return openNote(node, isNew, parent);
  if (camera.scale < 0.68) animateCamera({ x: node.x + node.w / 2, y: node.y + node.h / 2, scale: 0.85 }, { duration: 240 });
  else reveal(node);

  if (isNew) {
    view.element.style.width = node.w + 'px';
    view.element.style.maxWidth = 'none';
  } else {
    const rect = cardRect(node);
    const prof = view.element.dataset.profile;
    if (prof === 'title' || prof === 'empty') {
      view.element.style.width = '';
      view.element.style.minWidth = Math.max(rect.w, 220) + 'px';
    } else {
      view.element.style.width = rect.w + 'px';
      view.element.style.maxWidth = 'none';
    }
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'inline-toolbar';
  const toneDots = Object.entries(CanvasData.tone).map(([key, info]) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'inline-tone-dot';
    dot.title = '类型：' + info.label;
    dot.setAttribute('aria-label', info.label);
    dot.setAttribute('aria-pressed', String(key === node.tone));
    dot.style.background = colors[key];
    dot.addEventListener('mousedown', e => e.preventDefault());
    dot.addEventListener('click', () => {
      if (!inlineEdit) return;
      inlineEdit.tone = key;
      view.element.dataset.tone = key;
      view.type.innerHTML = icon(key) + '<span>' + CanvasData.tone[key].label + '</span>';
      view.type.hidden = key === 'idea';
      for (const btn of toneDots) btn.setAttribute('aria-pressed', String(btn === dot));
      syncInline();
    });
    return dot;
  });
  const mkFmtBtn = (label, title, onClick, inner) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = inner || label;
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  };
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'inline-title';
  titleInput.placeholder = parent ? '子分支标题（Tab 继续建子卡，Enter 确认）' : '输入标题…';
  titleInput.value = node.title;
  const bodyEditor = document.createElement('div');
  bodyEditor.className = 'inline-body flow-text';
  bodyEditor.contentEditable = 'true';
  bodyEditor.setAttribute('role', 'textbox');
  bodyEditor.setAttribute('aria-multiline', 'true');
  bodyEditor.dataset.placeholder = '补充细节，输入 - [ ] 自动变待办…';
  bodyEditor.replaceChildren(node.richBody ? richFragment(node.richBody) : plainFragment(node.body));
  bodyEditor.dataset.empty = String(!node.richBody && !node.body.trim());
  const hint = document.createElement('div');
  hint.className = 'inline-hint';
  hint.innerHTML = '<span><kbd>Tab</kbd> 下一级 · <kbd>⇧Enter</kbd> 正文</span><span><kbd>Esc</kbd> 完成</span>';

  const editInlineBody = () => {
    if (!inlineEdit) return;
    inlineEdit.bodyChanged = true;
    syncInline();
  };

  toolbar.append(
    ...toneDots,
    Object.assign(document.createElement('span'), { className: 'separator' }),
    mkFmtBtn('B', '加粗', () => { bodyEditor.focus(); document.execCommand('bold'); editInlineBody(); }, '<strong>B</strong>'),
    mkFmtBtn('列表', '项目符号', () => { bodyEditor.focus(); document.execCommand('insertUnorderedList'); editInlineBody(); }, icon('bullets')),
    mkFmtBtn('待办', '待办清单 (- [ ])', () => { bodyEditor.focus(); toggleChecklistCommand(bodyEditor, editInlineBody); }, icon('checklist')),
    Object.assign(document.createElement('span'), { className: 'separator' }),
    mkFmtBtn('大窗', '打开大窗富文本 / 插图编辑', () => {
      syncInline();
      const targetNode = inlineEdit.node;
      const wasNew = inlineEdit.isNew;
      const targetParent = inlineEdit.parent;
      finishInline({ keepFocus: true });
      openNote(targetNode, wasNew, targetParent);
    }, icon('expand'))
  );

  view.element.classList.add('is-editing');
  view.title.after(titleInput);
  view.body.after(bodyEditor);
  view.element.append(toolbar, hint);

  inlineEdit = {
    node, isNew, parent, tone: node.tone, element: view.element,
    toolbar, titleInput, bodyEditor, hint, checkpointed: false, bodyChanged: false,
  };
  renderSelection();

  let suppressKey = triggerKey ? triggerKey.toLowerCase() : null;
  const initialTitleValue = node.title;
  let clearSuppress = () => { suppressKey = null; };
  if (suppressKey) {
    let timer = 0;
    clearSuppress = () => {
      suppressKey = null;
      clearTimeout(timer);
      window.removeEventListener('keyup', clearSuppress, true);
    };
    window.addEventListener('keyup', clearSuppress, true);
    timer = setTimeout(clearSuppress, 300);
    titleInput.addEventListener('beforeinput', e => {
      if (suppressKey && e.inputType === 'insertText' && e.data?.toLowerCase() === suppressKey) {
        clearSuppress();
        e.preventDefault();
      }
    });
  }

  titleInput.addEventListener('input', e => {
    if (suppressKey && (titleInput.value.toLowerCase() === suppressKey ||
        titleInput.value.toLowerCase() === (initialTitleValue + suppressKey).toLowerCase())) {
      clearSuppress();
      titleInput.value = initialTitleValue;
      if (!isNew) titleInput.select();
      return;
    }
    if (!e.isComposing) syncInline();
  });
  titleInput.addEventListener('compositionend', syncInline);
  titleInput.addEventListener('keydown', e => {
    if (suppressKey && !e.repeat) clearSuppress();
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return;
    e.stopPropagation();
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      if (inlineEdit?.isNew && !titleInput.value.trim() && !bodyEditor.textContent.trim() && !bodyEditor.querySelector('img')) return;
      const currentNode = node;
      finishInline({ keepFocus: true });
      if (!nodeBy(currentNode.id)) return;
      openInline(blankCard(null, currentNode), { isNew: true, parent: currentNode });
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      bodyEditor.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      bodyEditor.focus();
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      finishInline();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelInline();
    }
  });

  bodyEditor.addEventListener('input', e => {
    if (e.isComposing) return;
    repairSplitChecklist(bodyEditor, e);
    maybeConvertChecklistShortcut(bodyEditor, editInlineBody);
    editInlineBody();
  });
  bodyEditor.addEventListener('compositionend', editInlineBody);
  bodyEditor.addEventListener('click', e => handleChecklistClickInEditor(e, bodyEditor, editInlineBody));
  bodyEditor.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return;
    e.stopPropagation();
    if (handleChecklistEnter(e, bodyEditor, editInlineBody)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      finishInline();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishInline();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      if (inlineEdit?.isNew && !titleInput.value.trim() && !bodyEditor.textContent.trim() && !bodyEditor.querySelector('img')) return;
      const currentNode = node;
      finishInline({ keepFocus: true });
      if (!nodeBy(currentNode.id)) return;
      openInline(blankCard(null, currentNode), { isNew: true, parent: currentNode });
    }
  });
  bodyEditor.addEventListener('paste', e => {
    const transfer = e.clipboardData;
    if (!transfer) return;
    const files = [...transfer.files];
    if (files.length) {
      e.preventDefault();
      const targetNode = node;
      const wasNew = inlineEdit.isNew;
      const targetParent = inlineEdit.parent;
      finishInline({ keepFocus: true });
      openNote(targetNode, wasNew, targetParent);
      void addPictures(files);
      return;
    }
    e.preventDefault();
    const text = transfer.getData('text/plain');
    if (text) {
      const fragment = plainFragment(text);
      const temp = document.createElement('div');
      temp.append(fragment);
      document.execCommand('insertHTML', false, temp.innerHTML);
      editInlineBody();
    }
  });

  if (focusBody) bodyEditor.focus({ preventScroll: true });
  else {
    titleInput.focus({ preventScroll: true });
    if (!isNew) titleInput.select();
  }
}

function addBranch(sibling = false) {
  const node = chosenCard();
  if (!node) return;
  const parentId = sibling ? hierarchy?.parent.get(node.id) : node.id;
  const parent = parentId ? nodeBy(parentId) : null;
  openInline(blankCard(null, parent, sibling ? node : null), { isNew: true, parent });
}

function editSelection({ triggerKey = null } = {}) {
  const note = chosenCard();
  const edge = chosenEdge();
  if (note) openInline(note, { triggerKey });
  if (edge) openText('edge', edge.label, edge.id, triggerKey);
}

function duplicateSelected() {
  const selected = new Set(noteIds());
  const originals = board().nodes.filter(node => selected.has(node.id));
  if (!originals.length) return;
  const box = boundsOf(originals);
  const place = freePosition(box.right + 44, box.top, box.w, box.h);
  const ids = new Map(originals.map(node => [node.id, CanvasData.uid()]));
  const copied = originals.map(node => {
    const clone = structuredClone(node);
    delete clone.subBoardId;
    return {
      ...clone, id: ids.get(node.id), x: coordinate(node.x + place.x - box.left), y: coordinate(node.y + place.y - box.top),
    };
  });
  const links = board().edges
    .filter(edge => ids.has(edge.from) && ids.has(edge.to))
    .map(edge => ({ ...structuredClone(edge), id: CanvasData.uid(), from: ids.get(edge.from), to: ids.get(edge.to) }));
  checkpoint();
  board().nodes.push(...copied);
  board().edges.push(...links);
  selection = { kind: 'cards', ids: new Set(ids.values()) };
  reveal(copied[0]);
  render();
  save();
  focusCanvas();
}

function removeSelected() {
  const ids = new Set(noteIds());
  const edge = chosenEdge();
  if (!ids.size && !edge) return;
  checkpoint();
  board().nodes = board().nodes.filter(node => !ids.has(node.id));
  board().edges = board().edges.filter(link => link.id !== edge?.id && !ids.has(link.from) && !ids.has(link.to));
  const settings = board().settings;
  settings.folded = settings.folded.filter(id => !ids.has(id));
  for (const frame of settings.frames) frame.members = frame.members.filter(id => !ids.has(id));
  settings.frames = settings.frames.filter(frame => frame.members.length || frame.box);
  if (ids.has(settings.layout.rootId)) settings.layout.rootId = null;
  setSelected([]);
  if (!board().nodes.length) fitView();
  render();
  save();
  focusCanvas();
}

function openText(kind, initial = '', id = null, triggerKey = null) {
  closePopover();
  modalText = { kind, id };
  const wording = {
    'board-new': ['新建空白画布', '画布名称', '给这张画布起个名字'],
    'board-rename': ['重命名画布', '画布名称', '给这张画布起个名字'],
    edge: ['编辑连线', '连线说明', '如「支持」「下一步」「待验证」'],
  };
  const [heading, label, placeholder] = wording[kind];
  $('#text-heading').textContent = heading;
  $('#text-label').textContent = label;
  textField.placeholder = placeholder;
  textField.required = kind !== 'edge';
  textField.value = initial;
  textDialog.showModal();
  textField.select();
  if (triggerKey) {
    const target = triggerKey.toLowerCase();
    let timer = 0;
    const onBeforeInput = e => {
      if (e.inputType === 'insertText' && e.data?.toLowerCase() === target) {
        cleanup();
        e.preventDefault();
      }
    };
    const onKeyDown = e => { if (!e.repeat) cleanup(); };
    const cleanup = () => {
      clearTimeout(timer);
      textField.removeEventListener('beforeinput', onBeforeInput);
      textField.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', cleanup, true);
      textDialog.removeEventListener('close', cleanup);
    };
    textField.addEventListener('beforeinput', onBeforeInput);
    textField.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', cleanup, true);
    textDialog.addEventListener('close', cleanup);
    timer = setTimeout(cleanup, 300);
  }
}

function switchBoard(id) {
  if (inlineEdit) finishInline({ keepFocus: true });
  cancelCameraAnimation();
  cancelPositionAnimation();
  closeContextMenu();
  closeSelectionSubPopovers();
  if (gesture) cancelGesture();
  if (layoutDraft) cancelLayout();
  CanvasViews.reset();
  CanvasViews.close();
  CanvasInspector.close();
  closePopover();
  closeSourcePopover();
  workspace.activeId = id;
  selection = noSelection();
  render();
  setMode('select');
  showBoardView();
  save();
  focusCanvas();
}

function commitText() {
  const { kind, id } = modalText;
  const text = textField.value.trim();
  if (kind !== 'edge' && !text) {
    textField.setCustomValidity('请输入画布名称');
    textField.reportValidity();
    return;
  }
  textDialog.close();
  if (kind === 'board-new') {
    const next = CanvasData.makeBoard(text);
    workspace.boards.push(next);
    switchBoard(next.id);
    return;
  }
  if (kind === 'board-rename' && board().name !== text) {
    checkpoint();
    board().name = text;
  }
  if (kind === 'edge' && edgeBy(id)?.label !== text) {
    checkpoint();
    edgeBy(id).label = text;
  }
  render();
  save();
  focusCanvas();
}

function deleteBoard() {
  if (workspace.boards.length <= 1) return;
  const current = board();
  closePopover();
  if (!confirm('删除「' + current.name + '」及其中的卡片和连线？')) return;
  const deletedId = current.id;
  const fallbackParent = current.settings.parentId || null;
  const index = workspace.boards.indexOf(current);
  workspace.boards.splice(index, 1);
  for (const item of workspace.boards) {
    if (item.settings.parentId === deletedId) item.settings.parentId = fallbackParent === item.id ? null : fallbackParent;
    for (const node of item.nodes) {
      if (node.subBoardId === deletedId) delete node.subBoardId;
    }
  }
  history.delete(deletedId);
  for (const stack of history.values()) {
    stack.past = stack.past.filter(entry => !entry.workspaceBoards);
    stack.future = stack.future.filter(entry => !entry.workspaceBoards);
  }
  switchBoard(workspace.boards[Math.min(index, workspace.boards.length - 1)].id);
  toast('已删除画布');
}

const popovers = {
  boards: { panel: $('#board-menu'), toggle: $('#board-toggle') },
  files: { panel: $('#file-menu'), toggle: $('#file-toggle') },
  search: { panel: $('#search-panel'), toggle: $('#search-toggle') },
};

function closePopover() {
  closeSourcePopover();
  $('#palette-backdrop').hidden = true;
  if (!openPopover) return;
  const { panel, toggle } = popovers[openPopover];
  panel.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  openPopover = null;
}

function togglePopover(key, forceOpen = false) {
  const previous = openPopover;
  closePopover();
  if (previous === key && !forceOpen) return;
  const { panel, toggle } = popovers[key];
  openPopover = key;
  $('#palette-backdrop').hidden = key !== 'search';
  panel.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  if (key === 'boards') renderBoardMenu();
  if (key === 'search') {
    activeMatch = 0;
    renderResults();
    searchInput.focus();
    searchInput.select();
  }
}

function renderBoardMenu() {
  const byId = new Map(workspace.boards.map(item => [item.id, item]));
  const childrenOf = new Map();
  const roots = [];
  for (const item of workspace.boards) {
    const parentId = item.settings?.parentId;
    if (parentId && parentId !== item.id && byId.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(item);
    } else {
      roots.push(item);
    }
  }
  const ordered = [];
  const seen = new Set();
  const walk = (item, depth) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    ordered.push({ item, depth });
    for (const child of childrenOf.get(item.id) || []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  for (const item of workspace.boards) walk(item, 0);

  const options = ordered.map(({ item: current, depth }) => {
    const button = document.createElement('button');
    button.className = 'menu-item' + (depth ? ' is-child' : '');
    button.type = 'button';
    button.dataset.board = current.id;
    button.setAttribute('aria-current', current.id === workspace.activeId);
    if (depth) button.style.setProperty('--board-depth', Math.min(depth, 4));
    if (depth) {
      const glyph = document.createElement('span');
      glyph.className = 'menu-branch-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = '↳';
      button.append(glyph);
    }
    const boardIcon = document.createElement('span');
    boardIcon.innerHTML = icon('board');
    button.append(boardIcon.firstElementChild);
    const title = document.createElement('span');
    title.textContent = current.name;
    const count = document.createElement('span');
    count.className = 'menu-count';
    count.textContent = String(current.nodes.length);
    button.append(title, count);
    if (current.id === workspace.activeId) {
      const checkWrap = document.createElement('span');
      checkWrap.innerHTML = '<svg class="icon end-icon" aria-hidden="true"><use href="#i-check"/></svg>';
      button.append(checkWrap.firstElementChild);
    }
    return button;
  });
  $('#board-list').replaceChildren(...options);
  controls['board-delete'].disabled = workspace.boards.length <= 1;
}

function selectMatch(index, scroll = false) {
  activeMatch = index;
  [...searchResults.querySelectorAll('[role="option"]')].forEach((option, row) =>
    option.setAttribute('aria-selected', row === index)
  );
  if (index >= 0 && matches[index]) {
    const option = document.getElementById('match-' + index);
    searchInput.setAttribute('aria-activedescendant', option.id);
    if (scroll) option.scrollIntoView({ block: 'nearest' });
  } else {
    searchInput.removeAttribute('aria-activedescendant');
  }
}

function paletteCommands() {
  const current = board();
  const hasCards = noteIds().length > 0;
  const nonEmpty = current.nodes.length > 0;
  const dark = isDarkHex(current.settings.appearance.background);
  return [
    { id: 'new-card', label: '新建卡片', icon: 'plus', keys: 'N', words: 'add create card' },
    { id: 'board-new', label: '新建空白画布', icon: 'board', words: 'board canvas new' },
    { id: 'auto-arrange', label: '自动整理画布', icon: 'arrange', when: nonEmpty, words: 'auto layout arrange tidy' },
    { id: 'arrange', label: '打开布局面板', icon: 'arrange', when: nonEmpty, words: 'layout' },
    { id: 'fit', label: '查看全图', icon: 'fit', keys: 'F', words: 'fit zoom overview' },
    { id: 'toggle-dark', label: dark ? '切换为浅色外观' : '切换为深色外观', icon: 'theme', words: 'dark light theme 主题 深色 浅色' },
    { id: 'expand-all', label: '展开全部分支', icon: 'expand', when: current.settings.folded.length > 0, words: 'expand unfold', run: () => CanvasViews.expandAll() },
    { id: 'focus-branch', label: '聚焦选中分支', icon: 'target', when: !!chosenCard(), words: 'focus' },
    { id: 'outline', label: '打开大纲', icon: 'outline', words: 'outline tree' },
    { id: 'view-options', label: '打开视图与筛选', icon: 'view', words: 'filter view 筛选' },
    { id: 'inspector', label: '打开样式面板', icon: 'style', words: 'style color 颜色' },
    { id: 'toggle-map', label: '显示或隐藏小地图', icon: 'map', keys: 'M', words: 'minimap' },
    { id: 'copy-markdown', label: '复制所选为 Markdown', icon: 'markdown', when: hasCards, words: 'copy markdown ai' },
    { id: 'export-png', label: hasCards ? '导出所选分支为 PNG 图片' : '导出 PNG 图片', icon: 'image', when: nonEmpty, words: 'export png image 图片' },
    { id: 'export-svg', label: hasCards ? '导出所选分支为 SVG 矢量图' : '导出 SVG 矢量图', icon: 'image', when: nonEmpty, words: 'export svg vector 矢量' },
    { id: 'export-markdown', label: hasCards ? '导出所选分支为 Markdown' : '导出 Markdown', icon: 'markdown', when: nonEmpty, words: 'export markdown md' },
    { id: 'export-html', label: '导出可编辑 HTML', icon: 'download', keys: modKey + 'S', words: 'export html save' },
    { id: 'export-json', label: '导出 JSON', icon: 'download', words: 'export json' },
    { id: 'help', label: '打开操作指南', icon: 'help', words: 'help shortcut 快捷键' },
  ].filter(command => command.when !== false);
}

function appendHighlighted(container, text, query) {
  if (!query) {
    container.textContent = text;
    return;
  }
  const lower = text.toLocaleLowerCase();
  let pos = 0;
  let idx = lower.indexOf(query, pos);
  if (idx < 0) {
    container.textContent = text;
    return;
  }
  while (idx >= 0) {
    if (idx > pos) container.append(text.slice(pos, idx));
    const mark = document.createElement('mark');
    mark.className = 'search-mark';
    mark.textContent = text.slice(idx, idx + query.length);
    container.append(mark);
    pos = idx + query.length;
    idx = lower.indexOf(query, pos);
  }
  if (pos < text.length) container.append(text.slice(pos));
}

function commandRow(command, index, query = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.id = 'match-' + index;
  element.className = 'search-result is-command';
  element.dataset.match = index;
  element.setAttribute('role', 'option');
  element.innerHTML = icon(command.icon);
  const label = document.createElement('strong');
  appendHighlighted(label, command.label, query);
  element.append(label);
  if (command.keys) {
    const keys = document.createElement('kbd');
    keys.textContent = command.keys;
    element.append(keys);
  }
  return element;
}

function searchSection(text) {
  const heading = document.createElement('div');
  heading.className = 'search-section';
  heading.textContent = text;
  return heading;
}

function renderResults() {
  const raw = searchInput.value.trim();
  const commandOnly = raw.startsWith('>');
  const query = (commandOnly ? raw.slice(1).trim() : raw).toLocaleLowerCase();
  const activeBoard = board();
  const hasQuery = !!query;
  const entries = [];
  const commands = commandOnly || hasQuery ? paletteCommands().filter(command =>
    !query || (command.label + ' ' + (command.words || '')).toLocaleLowerCase().includes(query)) : [];
  if (hasQuery && !commandOnly) {
    for (const item of workspace.boards) {
      if (item.name.toLocaleLowerCase().includes(query)) {
        entries.push({ kind: 'board', board: item, score: item.id === activeBoard.id ? 4 : 3 });
      }
    }
  }
  const sourceBoards = commandOnly ? [] : hasQuery ? workspace.boards : [activeBoard];
  for (const item of sourceBoards) {
    const statusMap = new Map(item.settings.statuses.map(s => [s.id, s.name]));
    const tagMap = new Map(item.settings.tags.map(t => [t.id, t.name]));
    for (const node of item.nodes) {
      const statusText = statusMap.get(node.status) || '';
      const tagText = (node.tags || []).map(id => tagMap.get(id) || '').join(' ');
      const sourceText = (node.sources || []).map(s => s.label + ' ' + (s.url || '')).join(' ');
      const haystack = (node.title + '\n' + node.body + '\n' + (node.note || '') + '\n' + sourceText + '\n' + statusText + '\n' + tagText).toLocaleLowerCase();
      if (query && !haystack.includes(query)) continue;
      const inTitle = query && node.title.toLocaleLowerCase().includes(query) ? 2 : 0;
      const inActive = item.id === activeBoard.id ? 1 : 0;
      entries.push({ kind: 'node', board: item, node, score: inTitle + inActive });
    }
  }
  if (query) entries.sort((a, b) => b.score - a.score);
  const commandEntries = commands.slice(0, commandOnly ? 40 : 4).map(command => ({ kind: 'command', command }));
  const contentEntries = entries.slice(0, 60);
  matches = [...commandEntries, ...contentEntries];
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'search-empty';
    empty.textContent = commandOnly ? '没有匹配的命令' : hasQuery ? '没有找到匹配的画布、卡片或命令' : '当前画布还没有卡片';
    searchResults.replaceChildren(empty);
    selectMatch(-1);
    return;
  }
  const rows = matches.map((entry, index) => {
    if (entry.kind === 'command') return commandRow(entry.command, index, query);
    const element = document.createElement('button');
    element.type = 'button';
    element.id = 'match-' + index;
    element.className = 'search-result';
    element.dataset.match = index;
    element.setAttribute('role', 'option');
    const head = document.createElement('div');
    head.className = 'search-result-head';
    const title = document.createElement('strong');
    const excerpt = document.createElement('small');
    if (entry.kind === 'board') {
      appendHighlighted(title, entry.board.name, query);
      const badge = document.createElement('span');
      badge.className = 'search-badge is-board';
      badge.textContent = '画布';
      head.append(title, badge);
      excerpt.textContent = `${entry.board.nodes.length} 张卡片 · 切换到此画布`;
    } else {
      const { node, board: ownerBoard } = entry;
      const main = document.createElement('div');
      main.className = 'search-result-main';
      const dot = document.createElement('span');
      dot.className = 'search-tone-dot';
      dot.style.background = node.tone === 'topic' ? (ownerBoard.settings.appearance.accent || colors.topic) : (colors[node.tone] || colors.idea);
      appendHighlighted(title, titleOf(node), query);
      main.append(dot, title);
      head.append(main);
      if (ownerBoard.id !== activeBoard.id) {
        const badge = document.createElement('span');
        badge.className = 'search-badge';
        badge.textContent = ownerBoard.name;
        head.append(badge);
      }
      const flat = (node.body || node.note || (node.sources || []).map(s => s.label).join(' · ')).replace(/\s+/g, ' ');
      const start = hasQuery ? flat.toLocaleLowerCase().indexOf(query) : -1;
      const trim = Math.max(0, start - 18);
      if (flat) appendHighlighted(excerpt, (trim ? '…' : '') + flat.slice(trim, trim + 130), query);
      else excerpt.textContent = CanvasData.tone[node.tone].label;
    }
    element.append(head, excerpt);
    return element;
  });
  const grouped = commandEntries.length && contentEntries.length;
  const children = [];
  rows.forEach((row, index) => {
    if (grouped && index === 0) children.push(searchSection('命令'));
    if (grouped && index === commandEntries.length) children.push(searchSection('画布与卡片'));
    children.push(row);
  });
  searchResults.replaceChildren(...children);
  selectMatch(0);
}

function goToMatch(index) {
  const entry = matches[index];
  if (!entry) return;
  closePopover();
  if (entry.kind === 'command') {
    runAction(entry.command.id, entry.command.run);
    return;
  }
  setMode('select');
  if (entry.kind === 'board') {
    if (entry.board.id !== workspace.activeId) switchBoard(entry.board.id);
    focusCanvas();
    return;
  }
  if (entry.board.id !== workspace.activeId) switchBoard(entry.board.id);
  CanvasViews.revealFromOutline(entry.node.id);
  focusCanvas();
}

