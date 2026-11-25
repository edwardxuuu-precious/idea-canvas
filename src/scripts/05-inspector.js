const CanvasInspector = (() => {
  const color = /^#[0-9a-f]{6}$/i;
  const labels = ['board', 'card', 'branch', 'link', 'state'];
  const aliases = { node: 'card', relation: 'link', edge: 'link', status: 'state' };
  const colors = ['#387b69', '#486c9c', '#a0632b', '#78639b', '#a04f63', '#596a63'];
  const cardShape = [
    ['rounded', '圆角矩形'], ['pill', '胶囊'], ['square', '直角矩形'], ['plain', '无外框'],
  ];
  const lineShape = [['curve', '曲线'], ['straight', '直线'], ['elbow', '直角线']];
  const lineDash = [['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']];
  const lineArrows = [['end', '末端箭头'], ['start', '起点箭头'], ['both', '双向箭头'], ['none', '无箭头']];
  const priorities = [['none', '无优先级'], ['star', '星标'], ['low', '低'], ['medium', '中'], ['high', '高']];
  const builtInThemes = [
    {
      id: 'paper-green', name: '晨雾纸白',
      appearance: { background: '#f5f6f8', grid: 'dots', gridColor: '#94a3b8', gridSize: 24, accent: '#0f766e',
        card: {}, branch: {}, link: {} },
    },
    {
      id: 'linear-dark', name: '静谧夜色',
      appearance: { background: '#101216', grid: 'dots', gridColor: '#334155', gridSize: 24, accent: '#10b981',
        card: {}, branch: { color: '#475569' }, link: { color: '#64748b' } },
    },
    {
      id: 'cool-blue', name: '极简冷灰蓝',
      appearance: { background: '#f1f5f9', grid: 'lines', gridColor: '#94a3b8', gridSize: 26, accent: '#2563eb',
        card: { fill: '#ffffff', border: '#cbd5e1', text: '#0f172a' },
        branch: { color: '#64748b' }, link: { color: '#64748b', dash: 'dashed' } },
    },
    {
      id: 'sandstone', name: '暖调羊皮纸',
      appearance: { background: '#faf6f0', grid: 'dots', gridColor: '#b7a589', gridSize: 24, accent: '#b45309',
        card: { fill: '#fffcf7', border: '#e5d5bc', text: '#451a03' },
        branch: { color: '#a17b5c' }, link: { color: '#9b6864' } },
    },
  ];

  let panel;
  let body;
  let tab = 'board';
  let chosenTheme = '';
  let selection = '';
  let followSelection = true;
  let activePointer = null;
  let refreshPending = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, handler, options = {}) {
    const node = el('button', options.className || 'btn btn-outline', text);
    node.type = 'button';
    if (options.label) {
      node.setAttribute('aria-label', options.label);
      node.title = options.label;
    }
    if (options.disabled) node.disabled = true;
    node.addEventListener('click', handler);
    return node;
  }

  function section(title, folded = false) {
    const block = el(folded ? 'details' : 'section', 'inspector-section');
    if (folded) block.dataset.inspectorSection = title;
    block.append(el(folded ? 'summary' : 'h3', '', title));
    return block;
  }

  function field(title, input, value) {
    const component = el('div', 'inspector-field');
    const heading = el('span', 'inspector-field-title', title);
    if (value) heading.append(el('span', 'inspector-swatch-value', value));
    component.append(heading, input);
    return component;
  }

  function inputField(type, value, label, listener, bounds) {
    const control = el('input');
    control.type = type;
    control.value = value;
    control.setAttribute('aria-label', label);
    if (bounds) {
      control.min = bounds[0];
      control.max = bounds[1];
      control.step = bounds[2] || 1;
    }
    control.addEventListener('change', listener);
    return control;
  }

  function selectField(label, value, choices, listener) {
    const control = el('select');
    control.setAttribute('aria-label', label);
    for (const [key, name] of choices) {
      const option = el('option', '', name);
      option.value = key;
      control.append(option);
    }
    control.value = value;
    control.addEventListener('change', listener);
    return control;
  }

  function row(...nodes) {
    const block = el('div', 'inspector-row');
    block.append(...nodes);
    return block;
  }

  function noteSelection() {
    return noteIds().map(id => nodeBy(id)).filter(Boolean);
  }

  function branchSelection() {
    const cards = noteSelection();
    const edge = chosenEdge();
    return cards.length ? cards : edge?.kind === 'branch' ? [nodeBy(edge.to)].filter(Boolean) : [];
  }

  function contextTab() {
    const edge = chosenEdge();
    if (edge) return edge.kind === 'branch' ? 'branch' : 'link';
    return noteSelection().length ? 'card' : 'board';
  }

  function selectionKey() {
    return JSON.stringify([board().id, noteIds(), chosenEdge()?.id]);
  }

  function currentTheme() {
    return [...builtInThemes, ...workspace.themes].find(theme => theme.id === chosenTheme);
  }

  function changeProperty(item, key, value) {
    if (item[key] === value) return;
    applyChange(() => { item[key] = value; });
  }

  const quickSwatches = {
    background: ['#f5f6f8', '#f1f5f9', '#faf6f0', '#101216', '#161b22'],
    accent: ['#0f766e', '#2563eb', '#7c3aed', '#b45309', '#10b981'],
    gridColor: ['#94a3b8', '#b7a589', '#475569', '#334155'],
    cardFill: ['#ffffff', '#f8fafc', '#fffdf7', '#181c24'],
    cardBorder: ['#e2e8f0', '#cbd5e1', '#fde68a', '#2a303c'],
    cardText: ['#0f172a', '#334155', '#1e3a8a', '#f1f5f9'],
    lineColor: ['#64748b', '#94a3b8', '#0f766e', '#475569'],
  };
  const toneDots = {
    topic: '#1f4238', idea: '#0f766e', question: '#7c3aed', action: '#b45309', reference: '#2563eb',
  };

  function colorFieldControl(value, label, swatches, onChange) {
    const wrap = el('div', 'inspector-swatches');
    const current = (value || '').toLowerCase();
    for (const hex of swatches) {
      const btn = el('button', 'inspector-swatch-btn');
      btn.type = 'button';
      btn.style.background = hex;
      btn.title = hex.toUpperCase();
      btn.setAttribute('aria-label', label + ' ' + hex.toUpperCase());
      btn.setAttribute('aria-pressed', String(current === hex.toLowerCase()));
      btn.addEventListener('click', () => onChange(hex));
      wrap.append(btn);
    }
    const picker = inputField('color', value, label + '自定义', event => onChange(event.target.value));
    picker.className = 'inspector-swatch-custom';
    wrap.append(picker);
    return wrap;
  }

  function boardColor(appearance, key, label, fallback) {
    const value = color.test(appearance[key]) ? appearance[key] : fallback;
    const swatches = quickSwatches[key] || quickSwatches.accent;
    const comp = field(label, colorFieldControl(value, label, swatches, next => changeProperty(appearance, key, next)), value.toUpperCase());
    comp.classList.add('inspector-field-full');
    return comp;
  }

  function number(value, initial, bounds) {
    const parsed = Number(value);
    if (value === '' || !Number.isFinite(parsed)) return initial;
    return Math.max(bounds[0], Math.min(bounds[1], parsed));
  }

  function appearanceFields(appearance) {
    const grid = selectField('网格样式', appearance.grid, [['dots', '点阵'], ['lines', '方格'], ['none', '纯色']], event => {
      changeProperty(appearance, 'grid', event.target.value);
    });
    const size = inputField('number', appearance.gridSize, '网格间距', event => {
      const range = [10, 64];
      changeProperty(appearance, 'gridSize', number(event.target.value, appearance.gridSize, range));
    }, [10, 64]);
    const fields = el('div', 'inspector-fields');
    fields.append(boardColor(appearance, 'background', '画布背景', '#f5f6f8'),
      boardColor(appearance, 'accent', '强调色', '#0f766e'),
      boardColor(appearance, 'gridColor', '网格颜色', '#94a3b8'),
      field('网格样式', grid), field('网格间距', size));
    return fields;
  }

  function sameName(existing, name) {
    return existing.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  }

  function nameField(label, placeholder, length = 32) {
    const control = el('input');
    control.type = 'text';
    control.placeholder = placeholder;
    control.maxLength = length;
    control.setAttribute('aria-label', label);
    return control;
  }

  function commitOnEnter(input, handler) {
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      handler();
    });
  }

  function sameAppearance(a, b) {
    const normalize = app => JSON.stringify({
      background: (app?.background || '').toLowerCase(),
      grid: app?.grid || 'dots',
      gridColor: (app?.gridColor || '').toLowerCase(),
      gridSize: app?.gridSize || 24,
      accent: (app?.accent || '').toLowerCase(),
      card: app?.card || {},
      branch: app?.branch || {},
      link: app?.link || {},
    });
    return normalize(a) === normalize(b);
  }

  function themeCard(theme, isCustom, currentAppearance) {
    const wrap = el('div');
    wrap.style.position = 'relative';
    const cardBtn = el('button', 'inspector-theme-card');
    cardBtn.type = 'button';
    cardBtn.setAttribute('aria-pressed', String(sameAppearance(theme.appearance, currentAppearance)));
    cardBtn.addEventListener('click', () => {
      chosenTheme = theme.id;
      applyChange(() => { board().settings.appearance = structuredClone(theme.appearance); });
    });

    const app = theme.appearance;
    const dark = isDarkHex(app.background);
    const preview = el('div', 'inspector-theme-preview' + (app.grid === 'lines' ? ' is-lines' : app.grid === 'dots' ? ' is-dots' : ''));
    preview.style.backgroundColor = app.background;
    if (app.grid === 'dots') {
      preview.style.backgroundImage = `radial-gradient(circle at 1px 1px, ${app.gridColor}66 1px, transparent 1.1px)`;
    } else if (app.grid === 'lines') {
      preview.style.backgroundImage = `linear-gradient(to right, ${app.gridColor}44 1px, transparent 1px), linear-gradient(to bottom, ${app.gridColor}44 1px, transparent 1px)`;
    }
    const topicBox = el('span', 'inspector-theme-topic');
    topicBox.style.background = mixHex(app.accent || '#0f766e', '#081116', 0.6);
    const nodeFill = app.card?.fill || (dark ? '#181c24' : '#ffffff');
    const nodeBorder = app.card?.border || (dark ? '#2a303c' : '#e2e8f0');
    const nodeA = el('span', 'inspector-theme-node');
    nodeA.style.background = nodeFill;
    nodeA.style.borderColor = nodeBorder;
    const nodeB = el('span', 'inspector-theme-node is-second');
    nodeB.style.background = nodeFill;
    nodeB.style.borderColor = app.accent || nodeBorder;
    preview.append(topicBox, nodeA, nodeB);

    cardBtn.append(preview, el('span', 'inspector-theme-name', theme.name));
    wrap.append(cardBtn);
    if (isCustom) {
      const del = button('×', event => {
        event.stopPropagation();
        applyChange(() => {
          workspace.themes = workspace.themes.filter(item => item.id !== theme.id);
          if (chosenTheme === theme.id) chosenTheme = '';
        }, { themes: true });
      }, { className: 'inspector-theme-del', label: '删除主题「' + theme.name + '」' });
      wrap.append(del);
    }
    return wrap;
  }

  function showThemes(settings) {
    const block = section('主题');
    const grid = el('div', 'inspector-theme-grid');
    for (const theme of builtInThemes) grid.append(themeCard(theme, false, settings.appearance));
    for (const theme of workspace.themes) grid.append(themeCard(theme, true, settings.appearance));

    const input = nameField('新主题名称', '如「我的复盘主题」');
    const save = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      if (sameName(workspace.themes, name) || sameName(builtInThemes, name)) {
        toast('已有同名主题', 'error');
        return;
      }
      applyChange(() => {
        chosenTheme = CanvasData.uid();
        workspace.themes.push({ id: chosenTheme, name, appearance: structuredClone(board().settings.appearance) });
      }, { themes: true });
      toast('已保存主题「' + name + '」');
    };
    commitOnEnter(input, save);
    block.append(grid, row(input, button('保存当前主题', save)));
    return block;
  }

  function rainbowPalette(dark) {
    return dark
      ? ['#10b981', '#60a5fa', '#a78bfa', '#f59e0b', '#fb7185', '#22d3ee']
      : ['#0f766e', '#2563eb', '#7c3aed', '#d97706', '#e11d48', '#0891b2'];
  }

  function rainbowSection() {
    const levelOne = hierarchy.roots.flatMap(rootId => hierarchy.children.get(rootId) || []);
    const hasBranchColors = levelOne.some(id => nodeBy(id)?.branchStyle?.color);
    const block = section('分支色彩');
    const applyBtn = button('一键多彩分支', () => {
      if (!levelOne.length) return toast('当前画布还没有分支');
      const palette = rainbowPalette(isDarkHex(board().settings.appearance.background));
      applyChange(() => {
        levelOne.forEach((id, idx) => {
          const node = nodeBy(id);
          if (node) node.branchStyle = { ...node.branchStyle, color: palette[idx % palette.length] };
        });
      });
      toast('已为一级分支分配多色主题');
    }, { disabled: !levelOne.length });
    const clearBtn = button('还原默认色', () => {
      applyChange(() => {
        for (const id of levelOne) {
          const node = nodeBy(id);
          if (!node?.branchStyle) continue;
          delete node.branchStyle.color;
          if (!Object.keys(node.branchStyle).length) delete node.branchStyle;
        }
      });
      toast('已还原默认分支颜色');
    }, { disabled: !hasBranchColors });
    block.append(row(applyBtn, clearBtn));
    return block;
  }

  function styleTarget(owners, name, inherited, defaultValues) {
    function current(owner) {
      return name ? owner[name] || {} : owner;
    }

    function read(key) {
      const first = owners[0];
      const local = current(first)[key];
      const fallback = owner => (typeof inherited === 'function' ? inherited(owner) : inherited)[key] ?? defaultValues[key];
      const effective = local ?? fallback(first);
      const mixed = owners.some(owner => (current(owner)[key] ?? fallback(owner)) !== effective);
      return { effective, mixed, overridden: owners.some(owner => current(owner)[key] !== undefined) };
    }

    function write(key, value) {
      if (owners.every(owner => current(owner)[key] === value)) return;
      applyChange(() => {
        for (const owner of owners) {
          if (!name) {
            if (value === undefined) delete owner[key];
            else owner[key] = value;
          } else {
            const next = { ...current(owner) };
            if (value === undefined) delete next[key];
            else next[key] = value;
            if (Object.keys(next).length) owner[name] = next;
            else delete owner[name];
          }
        }
      });
    }

    function reset() {
      if (owners.every(owner => !Object.keys(current(owner)).length)) return;
      applyChange(() => {
        for (const owner of owners) {
          if (name) delete owner[name];
          else for (const key of Object.keys(owner)) delete owner[key];
        }
      });
    }

    return { read, write, reset };
  }

  function styleControl(target, key, label, kind, choices, swatchPool = null) {
    const state = target.read(key);
    let input;
    let isFull = false;
    if (kind === 'segmented') {
      isFull = true;
      input = el('div', 'inspector-segmented');
      input.setAttribute('role', 'group');
      input.setAttribute('aria-label', label);
      for (const [choiceKey, choiceName] of choices) {
        const btn = el('button', '', choiceName);
        btn.type = 'button';
        btn.setAttribute('aria-pressed', String(!state.mixed && state.effective === choiceKey));
        btn.addEventListener('click', () => target.write(key, choiceKey));
        input.append(btn);
      }
    } else if (kind === 'select') {
      input = selectField(label, state.mixed ? '' : state.effective, [
        ['', state.mixed ? '混合' : '继承'], ...choices,
      ], event => target.write(key, event.target.value || undefined));
    } else if (kind === 'color' && swatchPool) {
      isFull = true;
      input = colorFieldControl(state.effective, label, swatchPool, next => target.write(key, next));
    } else {
      input = inputField(kind, state.effective, label, event => {
        const value = kind === 'number' ? number(event.target.value, state.effective, choices) : event.target.value;
        target.write(key, value);
      }, choices);
    }
    const inline = el('div', 'inspector-inline');
    inline.append(input);
    if (state.overridden) inline.append(button('继承', () => target.write(key, undefined), {
      className: 'inspector-reset', label: label + '恢复继承',
    }));
    const swatch = kind === 'color' && state.effective ? state.effective.toUpperCase() : state.mixed ? '混合' : '';
    const comp = field(label, inline, state.mixed ? '混合' : swatch);
    if (isFull) comp.classList.add('inspector-field-full');
    return comp;
  }

  function cardStyleFields(target) {
    const fields = el('div', 'inspector-fields');
    fields.append(
      styleControl(target, 'fill', '填充色', 'color', null, quickSwatches.cardFill),
      styleControl(target, 'border', '边框色', 'color', null, quickSwatches.cardBorder),
      styleControl(target, 'text', '文字色', 'color', null, quickSwatches.cardText),
      styleControl(target, 'size', '文字字号', 'number', [10, 32]),
      styleControl(target, 'shape', '卡片形状', 'segmented', cardShape),
    );
    return fields;
  }

  function lineStyleFields(target) {
    const fields = el('div', 'inspector-fields');
    fields.append(
      styleControl(target, 'color', '线条颜色', 'color', null, quickSwatches.lineColor),
      styleControl(target, 'width', '线条宽度', 'number', [0.75, 8, 0.25]),
      styleControl(target, 'shape', '线条形状', 'segmented', lineShape),
      styleControl(target, 'dash', '线条样式', 'segmented', lineDash),
      styleControl(target, 'arrow', '箭头方向', 'select', lineArrows),
    );
    return fields;
  }

  function styleSection(title, target, controls, folded = false) {
    const block = section(title, folded);
    block.append(controls(target));
    const actions = el('div', 'inspector-feedback');
    actions.append(button('恢复继承样式', target.reset, { className: 'inspector-reset' }));
    block.append(actions);
    return block;
  }

  const cardDefaults = { fill: '#ffffff', border: '#e2e8f0', text: '#0f172a', size: 14, shape: 'rounded' };
  const branchDefaults = { color: '#64748b', width: 1.5, shape: 'curve', dash: 'solid', arrow: 'none' };
  const linkDefaults = { ...branchDefaults, color: '#94a3b8', arrow: 'end' };

  function cardDefaultValues(node) {
    if (!node) return cardDefaults;
    const element = document.querySelector('.card[data-card="' + CSS.escape(node.id) + '"]');
    if (!element) return cardDefaults;
    const css = getComputedStyle(element);
    const readColor = (name, fallback) => color.test(css.getPropertyValue(name).trim()) ? css.getPropertyValue(name).trim() : fallback;
    return {
      ...cardDefaults, fill: readColor('--card-bg', cardDefaults.fill),
      border: readColor('--card-line', cardDefaults.border), text: readColor('--card-ink', cardDefaults.text),
    };
  }

  function showBoard(settings) {
    const appearance = settings.appearance;
    const canvas = section('背景与网格');
    canvas.append(appearanceFields(appearance));
    const titles = styleSection('默认卡片样式', styleTarget([appearance.card], null, {}, cardDefaults), cardStyleFields, true);
    const branches = styleSection('默认分支样式', styleTarget([appearance.branch], null, {}, branchDefaults), lineStyleFields, true);
    const links = styleSection('默认关系线样式', styleTarget([appearance.link], null, {}, linkDefaults), lineStyleFields, true);
    body.append(showThemes(settings), canvas, rainbowSection(), titles, branches, links);
  }

  function showCard(settings) {
    const cards = noteSelection();
    if (!cards.length) {
      body.append(el('p', 'inspector-feedback inspector-empty', '选中一张或多张卡片后，可调整样式。'));
      return;
    }
    const type = commonValue(cards, card => card.tone, '');
    const tonePills = el('div', 'inspector-tone-pills');
    tonePills.setAttribute('role', 'group');
    tonePills.setAttribute('aria-label', '卡片类型');
    for (const [key, info] of Object.entries(CanvasData.tone)) {
      const btn = el('button', 'inspector-tone-pill');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(type === key));
      btn.addEventListener('click', () => {
        if (cards.some(card => card.tone !== key)) {
          applyChange(() => { for (const card of cards) card.tone = key; });
        }
      });
      const dot = el('i');
      dot.style.background = toneDots[key] || '#0f766e';
      btn.append(dot, el('span', '', info.label));
      tonePills.append(btn);
    }
    const typeField = field('卡片类型', tonePills);
    typeField.classList.add('inspector-field-full');
    const inherited = owner => cardDefaultsFor(owner.id, settings);
    const target = styleTarget(cards, 'style', inherited, cardDefaultValues(cards[0]));
    body.append(styleSection('卡片样式', target, owner => {
      const fields = cardStyleFields(owner);
      fields.prepend(typeField);
      return fields;
    }));
  }

  function showBranch(settings) {
    const cards = branchSelection();
    if (!cards.length) {
      body.append(el('p', 'inspector-feedback inspector-empty', '选中分支起点或一条分支线后，可设定该分支的样式。'), rainbowSection());
      return;
    }
    const inherited = owner => ({
      ...settings.appearance.branch,
      ...inheritedBranches.get(hierarchy.parent.get(owner.id)),
    });
    const target = styleTarget(cards, 'branchStyle', inherited, branchDefaults);
    const block = styleSection('分支线条样式', target, lineStyleFields);
    body.append(block, rainbowSection());
  }

  function showLink(settings) {
    const edge = chosenEdge();
    if (!edge || edge.kind !== 'link') {
      body.append(el('p', 'inspector-feedback inspector-empty', '选中一条普通关系线后，可调整这条线的样式。'));
      return;
    }
    const target = styleTarget([edge], 'style', settings.appearance.link, linkDefaults);
    body.append(styleSection('关系线样式', target, lineStyleFields));
  }

  function commonValue(cards, valueOf, mixed = '') {
    const value = valueOf(cards[0]);
    return cards.every(card => valueOf(card) === value) ? value : mixed;
  }

  function showAssigned(settings) {
    const cards = noteSelection();
    if (!cards.length) return null;
    const block = section('设置已选卡片');
    const choices = [['', '无状态'], ...settings.statuses.map(state => [state.id, [state.icon, state.name].filter(Boolean).join(' ')])];
    const statusId = commonValue(cards, card => card.status || '', '__mixed__');
    if (statusId === '__mixed__') choices.unshift(['__mixed__', '混合状态']);
    const state = selectField('卡片状态', statusId, choices, event => {
      const value = event.target.value;
      if (value === '__mixed__') return;
      if (cards.every(card => (card.status || '') === value)) return;
      applyChange(() => {
        for (const card of cards) {
          if (value) card.status = value;
          else delete card.status;
        }
      });
    });
    const priorityValue = commonValue(cards, card => card.priority || 'none', '__mixed__');
    const choicesPriority = priorityValue === '__mixed__' ? [['__mixed__', '混合优先级'], ...priorities] : priorities;
    const priority = selectField('卡片优先级', priorityValue, choicesPriority, event => {
      const value = event.target.value;
      if (value === '__mixed__') return;
      applyChange(() => {
        for (const card of cards) {
          if (value === 'none') delete card.priority;
          else card.priority = value;
        }
      });
    });
    const fields = el('div', 'inspector-fields');
    fields.append(field('状态', state), field('优先级', priority));
    block.append(fields);
    if (settings.tags.length) {
      const tags = el('div', 'inspector-tag-list');
      for (const tag of settings.tags) {
        const assigned = cards.filter(card => card.tags?.includes(tag.id)).length;
        const control = button('', () => {
          applyChange(() => {
            for (const card of cards) {
              const ids = new Set(card.tags || []);
              if (assigned === cards.length) ids.delete(tag.id);
              else ids.add(tag.id);
              if (ids.size) card.tags = [...ids];
              else delete card.tags;
            }
          });
        }, { className: 'inspector-tag', label: '标签 ' + tag.name });
        const icon = el('span', 'inspector-tag-marker', tag.icon || '●');
        icon.style.color = tag.color;
        icon.setAttribute('aria-hidden', 'true');
        control.append(icon, el('span', '', tag.name));
        control.setAttribute('aria-pressed', assigned ? assigned === cards.length ? 'true' : 'mixed' : 'false');
        tags.append(control);
      }
      const group = el('div', 'inspector-assigned');
      group.append(el('p', 'inspector-feedback', '标签'), tags);
      block.append(group);
    }
    return block;
  }

  function changeDefinition(items, item, kind, property, value, control) {
    if (property === 'name' && (!value || sameName(items.filter(other => other.id !== item.id), value))) {
      control.value = item.name;
      if (value) toast('已有同名' + kind, 'error');
      return;
    }
    changeProperty(item, property, value);
  }

  function definitionEditor(kind, settings, folded = false) {
    const status = kind === '状态';
    const items = status ? settings.statuses : settings.tags;
    const block = section('管理' + kind, folded);
    const table = el('div', 'inspector-table');
    for (const [index, item] of items.entries()) {
      const definition = el('div', 'inspector-definition');
      const description = kind + '「' + item.name + '」';
      const colorInput = inputField('color', item.color, description + '颜色', event => {
        changeDefinition(items, item, kind, 'color', event.target.value, event.target);
      });
      const mark = nameField(description + '图标', '●', 8);
      mark.className = 'inspector-marker-input';
      mark.value = item.icon || '';
      mark.addEventListener('change', () => changeDefinition(items, item, kind, 'icon', [...mark.value.trim()].slice(0, 4).join(''), mark));
      commitOnEnter(mark, () => mark.blur());
      const name = nameField(description + '名称', kind + '名称', 24);
      name.value = item.name;
      name.addEventListener('change', () => changeDefinition(items, item, kind, 'name', name.value.trim(), name));
      commitOnEnter(name, () => name.blur());
      const move = direction => applyChange(() => {
        items.splice(index + direction, 0, items.splice(index, 1)[0]);
      });
      const up = button('↑', () => move(-1), {
        className: 'inspector-icon', label: '上移' + description, disabled: index === 0,
      });
      const down = button('↓', () => move(1), {
        className: 'inspector-icon', label: '下移' + description, disabled: index === items.length - 1,
      });
      const remove = button('×', () => {
        applyChange(() => {
          items.splice(index, 1);
          for (const card of board().nodes) {
            if (status && card.status === item.id) delete card.status;
            if (!status && card.tags?.includes(item.id)) {
              card.tags = card.tags.filter(id => id !== item.id);
              if (!card.tags.length) delete card.tags;
            }
          }
        });
      }, { className: 'inspector-icon inspector-delete', label: '删除' + description });
      definition.append(colorInput, mark, name, up, down, remove);
      table.append(definition);
    }

    const input = nameField('新' + kind + '名称', status ? '如「待验证」' : '如「案例」', 24);
    const add = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      if (sameName(items, name)) {
        toast('已有同名' + kind, 'error');
        return;
      }
      applyChange(() => { items.push({ id: CanvasData.uid(), name, color: colors[items.length % colors.length], icon: '●' }); });
    };
    commitOnEnter(input, add);
    block.append(table, row(input, button('添加' + kind, add)));
    return block;
  }

  function showState(settings) {
    const assignment = showAssigned(settings);
    if (assignment) body.append(assignment);
    body.append(definitionEditor('状态', settings), definitionEditor('标签', settings, true));
  }

  function scopeLabel() {
    const edge = chosenEdge();
    const nodes = tab === 'branch' ? branchSelection() : noteSelection();
    if (tab === 'link' && edge) return edge.label || '已选连线';
    if (tab !== 'board' && nodes.length === 1) return nodes[0].title || '未命名卡片';
    if (tab !== 'board' && nodes.length > 1) return '已选 ' + nodes.length + ' 张卡片';
    return board().name;
  }

  const painters = { board: showBoard, card: showCard, branch: showBranch, link: showLink, state: showState };

  function refresh(force = false) {
    if (!panel || panel.hidden) return;
    if (!force && activePointer !== null) {
      refreshPending = true;
      return;
    }
    refreshPending = false;
    const nextSelection = selectionKey();
    if (!force && selection !== nextSelection && followSelection) tab = contextTab();
    selection = nextSelection;

    const openSections = new Set([...body.querySelectorAll('details[open]')].map(item => item.dataset.inspectorSection));
    const scroll = body.scrollTop;
    for (const control of panel.querySelectorAll('[data-inspector-tab]')) {
      const current = control.dataset.inspectorTab === tab;
      control.tabIndex = current ? 0 : -1;
      control.setAttribute('aria-selected', String(current));
    }
    $('#inspector-scope').textContent = scopeLabel();
    body.setAttribute('aria-labelledby', 'inspector-tab-' + tab);
    body.replaceChildren();
    painters[tab](board().settings);
    for (const block of body.querySelectorAll('details[data-inspector-section]')) {
      if (openSections.has(block.dataset.inspectorSection)) block.open = true;
    }
    body.scrollTop = force ? 0 : scroll;
  }

  function setExpanded(expanded) {
    for (const control of document.querySelectorAll('[aria-controls="inspector-panel"]')) {
      control.setAttribute('aria-expanded', String(expanded));
    }
  }

  function open(nextTab) {
    if (!panel) return;
    const resolved = aliases[nextTab] || nextTab;
    followSelection = !labels.includes(resolved);
    tab = followSelection ? contextTab() : resolved;
    panel.hidden = false;
    setExpanded(true);
    refresh(true);
  }

  function close() {
    if (!panel) return;
    panel.hidden = true;
    setExpanded(false);
  }

  function toggle() {
    if (!panel) return;
    if (panel.hidden) open();
    else close();
  }

  function finishPointer(event) {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    if (refreshPending) setTimeout(() => { if (refreshPending) refresh(); }, 0);
  }

  function mount() {
    panel = $('#inspector-panel');
    body = $('#inspector-body');
    if (!panel) return;
    // A field can save on blur while the pointer is still down on another control.
    panel.addEventListener('pointerdown', event => { activePointer = event.pointerId; }, true);
    window.addEventListener('pointerup', finishPointer, true);
    window.addEventListener('pointercancel', finishPointer, true);
    panel.addEventListener('click', event => {
      const control = event.target.closest('[data-inspector-tab]');
      if (control) open(control.dataset.inspectorTab);
      if (event.target.closest('[data-inspector-close]')) close();
    });
    panel.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        close();
        document.querySelector('[aria-controls="inspector-panel"]')?.focus();
        return;
      }
      if (!event.target.closest('[data-inspector-tab]')) return;
      const current = labels.indexOf(tab);
      const next = event.key === 'ArrowRight' ? (current + 1) % labels.length :
        event.key === 'ArrowLeft' ? (current + labels.length - 1) % labels.length :
        event.key === 'Home' ? 0 : event.key === 'End' ? labels.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      open(labels[next]);
      $('#inspector-tab-' + tab).focus();
    });
  }

  return { mount, refresh, open, close, toggle };
})();

