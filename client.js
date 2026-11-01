/**
 * dsh-quote-annotate —— 划选悬浮批注（Web 客户端插件）
 *
 * 交互（对齐 Codex / GitHub PR review 的手感）：
 *   1. 在对话里划选一段文字 → 悬浮工具条「批注」「引用」
 *   2. 点「批注」→ 在选区旁弹出悬浮批注框（Cancel / Save）
 *   3. 保存后：原文出现浅色高亮 + 右侧编号角标（①②③），
 *      输入框上方出现一个「N 条批注」胶囊，点开可审阅 / 编辑 / 删除 / 跳回原文
 *   4. 发送时（Enter 或发送按钮）自动把批注折叠成一段结构化文字，附在消息正文后面
 *      —— 输入框里始终只放你自己写的字，很干净
 *
 * 依赖的官方 seam：
 *   - shell.overlay（悬浮层：工具条 / 批注框 / 角标）
 *   - conversation.input.dock（输入框上方胶囊）
 *   - 标准 props：useInput / inputActions（captureInsertion / insertText / setDraft）
 *   - CSS Custom Highlight API 做原文高亮（不改别人的 DOM）
 */
window.__ModuleLoader__.load({
  id: 'dsh-quote-annotate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ================================================================== *
     * 常量
     * ================================================================== */
    const TRANSCRIPT_SELECTOR = '[data-slot="conversation.session"]';
    const ROW_SELECTOR = '[data-chat-flow-key]';
    const COMPOSER_SELECTOR = '[data-lexical-editor="true"], [data-composer-card]';
    const EDITOR_SELECTOR = '[data-lexical-editor="true"]';
    const OWN_SELECTOR = '[data-dqa]';
    const HIGHLIGHT_NAME = 'dqa-annotation';
    /** 便于在界面上确认当前加载的是哪一版（HMR / 桌面端缓存排查用） */
    const VERSION = '1.1.1';
    const MAX_QUOTE_CHARS = 4000;
    const MAX_SENT_QUOTE_CHARS = 1200;
    const ZWSP = '\u200b';
    const MARKER_RE = /^> 【引用 (\d+)｜([^】]*)】\s*$/;

    const DICT = {
      zh: {
        annotate: '批注',
        quote: '引用',
        toolbarTitle: '对选中的原文加批注，AI 会看到原文 + 你的批注',
        quoteTitle: '把选中的原文引用到输入框',
        placeholder: '写你的批注，比如：这里说的参数应该是 0.7',
        save: '保存',
        cancel: '取消',
        remove: '删除',
        edit: '编辑',
        jump: '定位原文',
        clear: '清空',
        pillOne: '条批注',
        pillHint: '发送时会自动附在消息里',
        trayMissing: '批注已记录，但输入框未连接：请刷新页面（Ctrl+R）',
        insert: '插入正文',
        insertHint: '发送时没自动带上批注？点这里把批注写进输入框',
        trayTitle: '批注 {n} 条',
        trayHint: '发送时自动折叠进消息正文',
        emptyComment: '（未填写批注）',
        roleUser: '我的消息',
        roleAssistant: 'AI 回复',
        roleTool: '工具调用',
        roleSteering: '追加消息',
        roleCommand: '命令',
        roleContext: '对话上下文',
        turnLabel: '第 {n} 轮',
        truncated: '……（引用过长，已截断）',
        sentMark: '✎',
        sentQuoteOpen: '「',
        sentQuoteClose: '」',
        sentArrow: '→ ',
        shortUser: '我',
        shortAssistant: 'AI',
        shortTool: '工具',
        shortSteering: '补充',
        shortCommand: '命令',
        shortContext: '上文',
      },
      en: {
        annotate: 'Annotate',
        quote: 'Quote',
        toolbarTitle: 'Annotate the selection — the model sees the quote + your comment',
        quoteTitle: 'Quote the selection into the composer',
        placeholder: 'Your annotation, e.g. the parameter here should be 0.7',
        save: 'Save',
        cancel: 'Cancel',
        remove: 'Delete',
        edit: 'Edit',
        jump: 'Jump to source',
        clear: 'Clear',
        pillOne: 'annotations',
        pillHint: 'attached to your next message',
        trayMissing: 'Annotations recorded, but the composer is not connected — reload the page (Ctrl+R)',
        insert: 'Insert',
        insertHint: 'If sending did not carry the annotations, write them into the composer here',
        trayTitle: '{n} annotations',
        trayHint: 'Folded into the message body when you send',
        emptyComment: '(no annotation)',
        roleUser: 'My message',
        roleAssistant: 'Assistant',
        roleTool: 'Tool call',
        roleSteering: 'Follow-up',
        roleCommand: 'Command',
        roleContext: 'Conversation',
        turnLabel: 'turn {n}',
        truncated: '…(quote truncated)',
        sentMark: '✎',
        sentQuoteOpen: '"',
        sentQuoteClose: '"',
        sentArrow: '→ ',
        shortUser: 'me',
        shortAssistant: 'AI',
        shortTool: 'tool',
        shortSteering: 'note',
        shortCommand: 'cmd',
        shortContext: 'ctx',
      },
    };

    /* ================================================================== *
     * 全局状态（同一模块实例里的两个 slot 组件共享）
     * ================================================================== */
    let locale = null;
    let activeLocale = 'zh';
    let applied = false;
    let themeService = null;
    let clientCtx = null;
    /** 'light' | 'dark'：跟随宿主主题，组件据此切两套调色板 */
    let scheme = 'light';

    /** 从宿主 body 上解析 --dsw-alias-bg-base 的亮度（服务拿不到时兜底） */
    function detectSchemeFromDom() {
      try {
        const body = document.body;
        if (!body) return null;
        const style = window.getComputedStyle(body);
        const raw = (style.getPropertyValue('--dsw-alias-bg-base') || style.backgroundColor || '').trim();
        let r = 0;
        let g = 0;
        let b = 0;
        if (raw.charAt(0) === '#') {
          const hex =
            raw.length === 4
              ? '#' + raw.charAt(1) + raw.charAt(1) + raw.charAt(2) + raw.charAt(2) + raw.charAt(3) + raw.charAt(3)
              : raw;
          r = parseInt(hex.slice(1, 3), 16);
          g = parseInt(hex.slice(3, 5), 16);
          b = parseInt(hex.slice(5, 7), 16);
        } else {
          const match = raw.match(/rgba?\(([^)]+)\)/);
          if (!match) return null;
          const parts = match[1].split(',').map((value) => parseFloat(value));
          r = parts[0] || 0;
          g = parts[1] || 0;
          b = parts[2] || 0;
        }
        if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return null;
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        return luminance > 0.55 ? 'light' : 'dark';
      } catch (error) {
        return null;
      }
    }

    function refreshScheme() {
      let next = '';
      try {
        const service =
          themeService || (clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('theme') : null);
        if (service && typeof service.getTheme === 'function') {
          const snapshot = service.getTheme();
          const colorScheme = snapshot && snapshot.active && snapshot.active.colorScheme;
          if (colorScheme === 'dark' || colorScheme === 'light') next = colorScheme;
        }
      } catch (error) {
        next = '';
      }
      if (!next) next = detectSchemeFromDom() || '';
      if (!next) {
        try {
          next =
            typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light';
        } catch (error) {
          next = 'light';
        }
      }
      scheme = next;
    }

    /**
     * 共享状态放在 window 上，而不是模块作用域：
     * HMR 换包时悬浮层和输入框 dock 两半可能来自不同的模块实例，
     * 各自持有一份模块级 store 就会「一边有批注、一边空」。
     */
    const SHARED_KEY = '__DSH_QUOTE_ANNOTATE_SHARED__';
    function sharedState() {
      if (!window[SHARED_KEY]) {
        window[SHARED_KEY] = {
          /** 批注列表：{ id, n, quote, comment, rowKey, turn, kind, start, end, label } */
          store: { items: [] },
          subscribers: new Set(),
          bridge: { sessionId: null, actions: null, getDraft: () => '' },
          folding: { current: false },
        };
      }
      return window[SHARED_KEY];
    }

    const shared = sharedState();
    const store = shared.store;
    const subscribers = shared.subscribers;

    function notify() {
      subscribers.forEach((fn) => {
        try {
          fn();
        } catch (error) {
          /* 单个订阅者异常不影响其他 */
        }
      });
    }

    function useStoreVersion() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const fn = () => force((value) => value + 1);
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      }, []);
    }

    /** 输入框 dock 注册的桥；悬浮层通过它拿到当前会话与草稿动作 */
    const bridge = shared.bridge;

    /** 防止「折叠 → 发送」这一瞬间被重复折叠 */
    const foldingRef = shared.folding;

    /* ================================================================== *
     * 文案
     * ================================================================== */
    function refreshLocale() {
      let id = '';
      try {
        if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
          id = String(document.documentElement.lang);
        }
      } catch (error) {
        id = '';
      }
      if (!id) {
        try {
          const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null;
          if (snapshot && typeof snapshot.active === 'string') id = snapshot.active;
        } catch (error) {
          id = '';
        }
      }
      if (!id) {
        try {
          id = (typeof navigator !== 'undefined' && navigator.language) || '';
        } catch (error) {
          id = '';
        }
      }
      activeLocale = String(id).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    }

    function tr(key, params) {
      const dict = DICT[activeLocale] || DICT.zh;
      let text = dict[key] !== undefined ? dict[key] : DICT.zh[key] !== undefined ? DICT.zh[key] : key;
      if (params) {
        for (const name in params) text = text.split('{' + name + '}').join(String(params[name]));
      }
      return text;
    }

    function useLocaleTick() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => {
          refreshLocale();
          force((value) => value + 1);
        });
      }, []);
    }

    /* ================================================================== *
     * 文本映射：把 Range 映射成「行内文本偏移」，以便 React 重渲染后还能找回来
     * ================================================================== */
    function textMapOf(root) {
      const nodes = [];
      let position = 0;
      if (!root) return { nodes, text: '' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let node = walker.nextNode();
      while (node) {
        const el = node.parentElement;
        const value = node.nodeValue || '';
        if (el && value.length > 0 && !el.closest(OWN_SELECTOR)) {
          nodes.push({ node, start: position, end: position + value.length });
          position += value.length;
        }
        node = walker.nextNode();
      }
      return { nodes, text: nodes.map((item) => item.node.nodeValue).join('') };
    }

    function pointToOffset(map, node, offset) {
      if (!node) return -1;
      if (node.nodeType === 3) {
        for (let i = 0; i < map.nodes.length; i++) {
          const item = map.nodes[i];
          if (item.node === node) return item.start + Math.min(offset, item.node.nodeValue.length);
        }
        return -1;
      }
      // 元素节点：取它内部第一个文本节点
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
      const first = walker.nextNode();
      if (!first) return -1;
      for (let i = 0; i < map.nodes.length; i++) {
        if (map.nodes[i].node === first) return map.nodes[i].start;
      }
      return -1;
    }

    function offsetToPoint(map, offset) {
      for (let i = 0; i < map.nodes.length; i++) {
        const item = map.nodes[i];
        if (offset <= item.end) return { node: item.node, offset: Math.max(0, offset - item.start) };
      }
      const last = map.nodes[map.nodes.length - 1];
      return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
    }

    function rangeFromOffsets(map, start, end) {
      const from = offsetToPoint(map, start);
      const to = offsetToPoint(map, end);
      if (!from || !to) return null;
      try {
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        return range;
      } catch (error) {
        return null;
      }
    }

    function looseEqual(a, b) {
      const strip = (value) => String(value || '').replace(/\s+/g, '');
      return strip(a) === strip(b);
    }

    /** 在当前页面里找回一条批注对应的 Range（找不到返回 null） */
    function locateAnnotation(annotation) {
      const scope = document.querySelector(TRANSCRIPT_SELECTOR);
      if (!scope) return null;

      let root = null;
      if (annotation.rowKey) {
        try {
          root = scope.querySelector('[data-chat-flow-key="' + String(annotation.rowKey).replace(/["\\]/g, '\\$&') + '"]');
        } catch (error) {
          root = null;
        }
      }
      if (!root) root = scope;

      const map = textMapOf(root);
      if (map.nodes.length === 0) return null;

      if (annotation.start >= 0 && annotation.end > annotation.start && annotation.end <= map.text.length) {
        if (looseEqual(map.text.slice(annotation.start, annotation.end), annotation.quote)) {
          const range = rangeFromOffsets(map, annotation.start, annotation.end);
          if (range) return range;
        }
      }

      const needle = String(annotation.quote || '').split('\n')[0].trim();
      if (needle) {
        const at = map.text.indexOf(needle);
        if (at >= 0) return rangeFromOffsets(map, at, Math.min(map.text.length, at + needle.length));
      }
      return null;
    }

    function applyHighlights(ranges) {
      if (typeof CSS === 'undefined' || !CSS.highlights) return;
      try {
        if (!ranges.length) {
          CSS.highlights.delete(HIGHLIGHT_NAME);
          return;
        }
        const highlight = new Highlight(...ranges);
        CSS.highlights.set(HIGHLIGHT_NAME, highlight);
      } catch (error) {
        /* 老浏览器没有 Highlight 构造器时静默降级 */
      }
    }

    /* ================================================================== *
     * 选区
     * ================================================================== */
    function elementOf(node) {
      if (!node) return null;
      if (node.nodeType === 1) return node;
      return node.parentElement || null;
    }

    function readSelection() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

      const anchorEl = elementOf(selection.anchorNode);
      const focusEl = elementOf(selection.focusNode);
      if (!anchorEl || !focusEl) return null;
      if (anchorEl.closest(OWN_SELECTOR) || focusEl.closest(OWN_SELECTOR)) return null;
      if (anchorEl.closest(COMPOSER_SELECTOR) || focusEl.closest(COMPOSER_SELECTOR)) return null;
      if (!anchorEl.closest(TRANSCRIPT_SELECTOR) || !focusEl.closest(TRANSCRIPT_SELECTOR)) return null;

      const text = selection.toString().replace(/\r\n?/g, '\n').trim();
      if (!text) return null;

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return null;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return null;

      const rowEl = anchorEl.closest(ROW_SELECTOR);
      return {
        text,
        kind: rowEl ? rowEl.getAttribute('data-chat-flow-kind') || '' : '',
        turn: rowEl ? rowEl.getAttribute('data-chat-turn') || '' : '',
        rowKey: rowEl ? rowEl.getAttribute('data-chat-flow-key') || '' : '',
        rowEl,
        range: range.cloneRange(),
        rect: { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right, width: rect.width },
      };
    }

    function selectionOffsets(payload) {
      const row = payload.rowEl;
      if (!row) return { start: -1, end: -1 };
      try {
        const map = textMapOf(row);
        const start = pointToOffset(map, payload.range.startContainer, payload.range.startOffset);
        const end = pointToOffset(map, payload.range.endContainer, payload.range.endOffset);
        if (start >= 0 && end > start) return { start, end };
      } catch (error) {
        /* 落到文本搜索兜底 */
      }
      return { start: -1, end: -1 };
    }

    function roleLabel(kind, turn) {
      let base;
      if (kind === 'user') base = tr('roleUser');
      else if (kind === 'assistant-step') base = tr('roleAssistant');
      else if (kind === 'tool-call') base = tr('roleTool');
      else if (kind === 'steering') base = tr('roleSteering');
      else if (kind === 'command' || kind === 'command-input') base = tr('roleCommand');
      else base = tr('roleContext');
      return turn ? base + ' · ' + tr('turnLabel', { n: turn }) : base;
    }

    /* ================================================================== *
     * 批注数据操作
     * ================================================================== */
    let annotationSeq = 0;

    function nextNumber() {
      let max = 0;
      for (let i = 0; i < store.items.length; i++) if (store.items[i].n > max) max = store.items[i].n;
      return max + 1;
    }

    function addAnnotation(payload) {
      const offsets = selectionOffsets(payload);
      const annotation = {
        id: 'a' + ++annotationSeq,
        n: nextNumber(),
        quote: String(payload.text || '').slice(0, MAX_QUOTE_CHARS),
        comment: '',
        rowKey: payload.rowKey || '',
        rowRight: payload.rowEl ? Math.round(payload.rowEl.getBoundingClientRect().right) : 0,
        turn: payload.turn || '',
        kind: payload.kind || '',
        label: roleLabel(payload.kind, payload.turn),
        start: offsets.start,
        end: offsets.end,
        rect: payload.rect,
      };
      store.items = store.items.concat([annotation]);
      notify();
      return annotation;
    }

    function updateAnnotation(id, patch) {
      store.items = store.items.map((item) => (item.id === id ? Object.assign({}, item, patch) : item));
      notify();
    }

    function removeAnnotation(id) {
      store.items = store.items.filter((item) => item.id !== id);
      notify();
    }

    function clearAnnotations() {
      if (store.items.length === 0) return;
      store.items = [];
      notify();
    }

    function findAnnotation(id) {
      for (let i = 0; i < store.items.length; i++) if (store.items[i].id === id) return store.items[i];
      return null;
    }

    /* ================================================================== *
     * 发送时折叠成正文
     * ================================================================== */
    const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

    /** 极简出处：我 / AI / 工具 / 补充 / 命令 / 上文，外加 · 轮次 */
    function shortSource(item) {
      let base;
      if (item.kind === 'user') base = tr('shortUser');
      else if (item.kind === 'assistant-step') base = tr('shortAssistant');
      else if (item.kind === 'tool-call') base = tr('shortTool');
      else if (item.kind === 'steering') base = tr('shortSteering');
      else if (item.kind === 'command' || item.kind === 'command-input') base = tr('shortCommand');
      else base = tr('shortContext');
      return item.turn ? base + '·' + item.turn : base;
    }

    /**
     * 一行一条，尽量短：
     *   ✎①AI·25「原文摘要」→ 我的批注
     * 空批注只保留 ✎①AI·25「原文摘要」。
     */
    function buildAnnotationBlock(items) {
      const lines = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const mark = item.n <= CIRCLED.length ? CIRCLED[item.n - 1] : '(' + item.n + ')';
        let quote = String(item.quote || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (quote.length > 90) quote = quote.slice(0, 90) + '…';
        const comment = item.comment && item.comment.trim() ? item.comment.trim() : '';
        lines.push(
          tr('sentMark') +
            mark +
            shortSource(item) +
            tr('sentQuoteOpen') +
            quote +
            tr('sentQuoteClose') +
            (comment ? tr('sentArrow') + comment : '')
        );
      }
      return lines.join('\n');
    }

    function composeSentText(draft, items) {
      const body = String(draft || '').split(ZWSP).join('').replace(/\s+$/, '');
      const block = buildAnnotationBlock(items);
      return body ? body + '\n\n' + block : block;
    }

    /* ================================================================== *
     * 「引用」：旧行为，直接把引用块插进输入框
     * ================================================================== */
    function normalizeQuoteText(raw) {
      let text = String(raw || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+$/gm, '')
        .trim();
      if (text.length > MAX_QUOTE_CHARS) text = text.slice(0, MAX_QUOTE_CHARS) + '\n' + tr('truncated');
      return text;
    }

    function buildQuoteBlock(n, label, text) {
      const body = normalizeQuoteText(text)
        .split('\n')
        .map((line) => (line.trim() === '' ? '>' : '> ' + line))
        .join('\n');
      return '> 【引用 ' + n + '｜' + label + '】\n' + body + '\n\n【批注 ' + n + '】';
    }

    function maxMarkerNumber(draft) {
      let max = 0;
      const lines = String(draft || '').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = MARKER_RE.exec(lines[i]);
        if (match) {
          const value = Number(match[1]);
          if (value > max) max = value;
        }
      }
      return max;
    }

    function parseQuoteItems(draft) {
      const items = [];
      const lines = String(draft || '').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = MARKER_RE.exec(lines[i]);
        if (!match) continue;
        const body = [];
        let j = i + 1;
        while (j < lines.length && lines[j].charAt(0) === '>') {
          body.push(lines[j].replace(/^>\s?/, ''));
          j++;
        }
        items.push({ n: Number(match[1]), label: match[2], text: body.join('\n') });
        i = j - 1;
      }
      return items;
    }

    function insertQuote(payload) {
      const actions = bridge.actions;
      if (!actions) return false;
      const draft = String(bridge.getDraft() || '');
      const n = Math.max(maxMarkerNumber(draft), 0) + 1;
      const block = buildQuoteBlock(n, roleLabel(payload.kind, payload.turn), payload.text);
      let prefix = '';
      if (draft.trim() !== '') prefix = /\n\n$/.test(draft) ? '' : /\n$/.test(draft) ? '\n' : '\n\n';
      const payloadText = prefix + block;

      let ok = false;
      try {
        const span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : null;
        if (span && typeof actions.insertText === 'function') ok = actions.insertText(payloadText, span) === true;
      } catch (error) {
        ok = false;
      }
      if (!ok && typeof actions.setDraft === 'function') {
        try {
          actions.setDraft(draft + payloadText);
          ok = true;
        } catch (error) {
          ok = false;
        }
      }
      return ok;
    }

    /* ================================================================== *
     * 悬浮层：工具条 / 批注框 / 编号角标
     * ================================================================== */
    const OVERLAY_CSS = [
      '@keyframes dqa-in{from{opacity:0;transform:translateY(2px) scale(.98)}to{opacity:1;transform:none}}',
      '@keyframes dqa-fade{from{opacity:0}to{opacity:1}}',
      '::highlight(dqa-annotation){background-color:rgba(65,118,230,.24);color:inherit}',
      '.dqa-layer{position:fixed;z-index:2147483000;pointer-events:none;user-select:none;-webkit-user-select:none;',
      '--dqa-surface:#fff;--dqa-surface-2:#f3f5f9;--dqa-surface-3:#e8ebf1;--dqa-input:#fff;',
      '--dqa-text:#15181e;--dqa-text-2:#5b6472;--dqa-border:rgba(15,17,21,.16);',
      '--dqa-accent:#2f6bff;--dqa-accent-fill:#4176e6;--dqa-on-accent:#fff;--dqa-danger:#d93a3a;',
      '--dqa-shadow:0 10px 28px rgba(15,17,21,.18)}',
      '.dqa-layer[data-dqa-scheme="dark"]{--dqa-surface:#24272e;--dqa-surface-2:#2f333c;--dqa-surface-3:#3a3f4a;',
      '--dqa-input:#1b1e24;--dqa-text:#eef1f6;--dqa-text-2:#a9b1bf;--dqa-border:rgba(255,255,255,.14);',
      '--dqa-accent:#6f9bff;--dqa-accent-fill:#4176e6;--dqa-on-accent:#fff;--dqa-danger:#ff7373;',
      '--dqa-shadow:0 12px 34px rgba(0,0,0,.55)}',
      '.dqa-bar{pointer-events:auto;user-select:none;-webkit-user-select:none;display:inline-flex;align-items:center;gap:2px;padding:3px;',
      'border:1px solid var(--dqa-border);border-radius:10px;background:var(--dqa-surface);',
      'box-shadow:var(--dqa-shadow);animation:dqa-fade .1s ease;}',
      '.dqa-bar-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:none;',
      'border-radius:7px;background:transparent;color:var(--dqa-text);cursor:pointer;',
      'font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
      '.dqa-bar-btn:hover{background:var(--dqa-surface-2)}',
      '.dqa-bar-btn .dqa-ico{display:inline-flex;color:var(--dqa-accent)}',
      '.dqa-pop{pointer-events:auto;position:fixed;width:340px;max-width:calc(100vw - 24px);box-sizing:border-box;',
      'padding:10px;border:1px solid var(--dqa-border);border-radius:12px;background:var(--dqa-surface);',
      'box-shadow:var(--dqa-shadow);color:var(--dqa-text);animation:dqa-in .12s ease;',
      'font:400 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
      '.dqa-pop textarea{display:block;width:100%;box-sizing:border-box;min-height:64px;max-height:180px;resize:vertical;',
      'padding:7px 9px;border-radius:8px;border:1px solid var(--dqa-border);background:var(--dqa-input);',
      'color:var(--dqa-text);font:inherit;outline:none}',
      '.dqa-pop textarea::placeholder{color:var(--dqa-text-2)}',
      '.dqa-pop textarea:focus{border-color:var(--dqa-accent)}',
      '.dqa-pop-actions{display:flex;align-items:center;gap:8px;margin-top:8px}',
      '.dqa-pop-trash{margin-right:auto;border:none;background:transparent;cursor:pointer;padding:4px;border-radius:6px;',
      'color:var(--dqa-text-2);display:inline-flex}',
      '.dqa-pop-trash:hover{color:var(--dqa-danger);background:var(--dqa-surface-2)}',
      '.dqa-btn{height:28px;padding:0 12px;border-radius:7px;border:1px solid var(--dqa-border);background:transparent;',
      'color:var(--dqa-text);cursor:pointer;font:500 12px/1 inherit}',
      '.dqa-btn:hover{background:var(--dqa-surface-2)}',
      '.dqa-btn.primary{border-color:transparent;background:var(--dqa-accent-fill);color:var(--dqa-on-accent)}',
      '.dqa-btn.primary:hover{filter:brightness(1.08)}',
      '.dqa-warn{pointer-events:auto;position:fixed;left:50%;bottom:96px;transform:translateX(-50%);',
      'padding:6px 12px;border-radius:8px;background:var(--dqa-danger);color:#fff;font:500 12px/1.2 inherit;',
      'box-shadow:var(--dqa-shadow)}',
      '.dqa-badge{pointer-events:auto;position:fixed;display:inline-flex;align-items:center;justify-content:center;',
      'min-width:18px;height:18px;padding:0 5px;border-radius:9px;border:none;cursor:pointer;',
      'background:var(--dqa-accent-fill);color:var(--dqa-on-accent);font:600 11px/1 inherit;',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)}',
      '.dqa-badge:hover{filter:brightness(1.08)}',
    ].join('');

    function QuoteIcon() {
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M7 7c-2 1.2-3.2 3.1-3.2 5.3V17h5.4v-4.6H6.4c0-1.5.7-2.7 2.1-3.4L7 7Zm9.4 0c-2 1.2-3.2 3.1-3.2 5.3V17h5.4v-4.6h-2.8c0-1.5.7-2.7 2.1-3.4L16.4 7Z',
          fill: 'currentColor',
        })
      );
    }

    function AnnotateIcon() {
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H12l-4.2 3.4c-.6.5-1.3 0-1.3-.7V16H5.5A1.5 1.5 0 0 1 4 14.5v-9Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        })
      );
    }

    function TrashIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M5 7h14M10 7V5h4v2m-6 0 .6 12h6.8L16 7',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      );
    }

    function QuoteOverlay() {
      useLocaleTick();
      useStoreVersion();

      const [selection, setSelection] = React.useState(null);
      const [editor, setEditor] = React.useState(null);
      const [badges, setBadges] = React.useState([]);
      const selectionRef = React.useRef(null);
      const editorRef = React.useRef(null);
      editorRef.current = editor;

      /* ---- 选区跟踪 ----
       * 拖选（按下未抬起）期间完全不显示按钮、也不重算：浮层元素在指针底下反复
       * 出现/消失会被浏览器当成可选内容边界，表现就是选区闪一下、甚至整段全选。
       * 抬起后再统一读一次选区。
       */
      React.useEffect(() => {
        let frame = 0;
        let dragging = false;
        const sameAnchor = (a, b) =>
          a === b || (a && b && a.x === b.x && a.y === b.y && a.above === b.above);

        const applySelection = (next) => {
          setSelection((previous) => (sameAnchor(previous, next) ? previous : next));
        };

        const read = () => {
          frame = 0;
          if (dragging || editorRef.current) {
            selectionRef.current = null;
            applySelection(null);
            return;
          }
          const payload = readSelection();
          selectionRef.current = payload;
          if (!payload) {
            applySelection(null);
            return;
          }
          const half = 120;
          const minX = 12 + half;
          const maxX = Math.max(minX, window.innerWidth - 12 - half);
          const x = Math.min(Math.max(payload.rect.left + payload.rect.width / 2, minX), maxX);
          const above = payload.rect.top > 60;
          applySelection({ x, y: above ? payload.rect.top - 10 : payload.rect.bottom + 10, above });
        };
        const schedule = () => {
          if (!frame) frame = window.requestAnimationFrame(read);
        };

        const onPointerDown = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest(OWN_SELECTOR)) return;
          if (event.button !== undefined && event.button !== 0) return;
          dragging = true;
          selectionRef.current = null;
          applySelection(null);
        };
        const onPointerUp = () => {
          if (!dragging) return;
          dragging = false;
          schedule();
        };

        document.addEventListener('selectionchange', schedule);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('scroll', schedule, true);
        window.addEventListener('resize', schedule);
        return () => {
          if (frame) window.cancelAnimationFrame(frame);
          document.removeEventListener('selectionchange', schedule);
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('pointerup', onPointerUp, true);
          window.removeEventListener('scroll', schedule, true);
          window.removeEventListener('resize', schedule);
        };
      }, []);

      /* ---- 高亮 + 角标定位 ---- */
      React.useEffect(() => {
        let frame = 0;
        let timer = 0;

        const recompute = () => {
          frame = 0;
          const ranges = [];
          const next = [];
          for (let i = 0; i < store.items.length; i++) {
            const annotation = store.items[i];
            const range = locateAnnotation(annotation);
            if (!range) continue;
            ranges.push(range);
            const rects = range.getClientRects();
            const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
            if (!rect || rect.width === 0) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
            const right = Math.min(window.innerWidth - 26, Math.max(6, rect.right + 6));
            const top = Math.min(window.innerHeight - 24, Math.max(4, rect.top - 2));
            next.push({ id: annotation.id, n: annotation.n, left: right, top });
          }
          applyHighlights(ranges);
          setBadges(next);
        };

        const schedule = () => {
          if (!frame) frame = window.requestAnimationFrame(recompute);
        };

        recompute();
        window.addEventListener('scroll', schedule, true);
        window.addEventListener('resize', schedule);
        timer = window.setInterval(schedule, 700);
        return () => {
          if (frame) window.cancelAnimationFrame(frame);
          if (timer) window.clearInterval(timer);
          window.removeEventListener('scroll', schedule, true);
          window.removeEventListener('resize', schedule);
          applyHighlights([]);
        };
      }, [store.items.length]);

      /* ---- 打开新批注 ---- */
      const startAnnotate = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const payload = selectionRef.current;
        if (!payload) return;
        const annotation = addAnnotation(payload);
        setSelection(null);
        setEditor({ mode: 'new', id: annotation.id, rect: payload.rect, comment: '' });
        const selection = window.getSelection();
        if (selection) selection.removeAllRanges();
      };

      /* ---- 旧「引用」---- */
      const doQuote = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const payload = selectionRef.current;
        if (!payload) return;
        insertQuote(payload);
        setSelection(null);
        const selection = window.getSelection();
        if (selection) selection.removeAllRanges();
      };

      /* ---- 编辑已有批注 ---- */
      const openEditor = (annotation, rect) => {
        setEditor({
          mode: 'edit',
          id: annotation.id,
          rect: rect || annotation.rect || { left: window.innerWidth / 2, top: window.innerHeight / 2, bottom: window.innerHeight / 2, right: window.innerWidth / 2, width: 0 },
          comment: annotation.comment || '',
        });
      };

      const commit = () => {
        const current = editorRef.current;
        if (!current) return;
        if (current.mode === 'new') {
          updateAnnotation(current.id, { comment: current.comment || '' });
        } else {
          updateAnnotation(current.id, { comment: current.comment || '' });
        }
        setEditor(null);
      };

      const cancel = () => {
        const current = editorRef.current;
        if (current && current.mode === 'new') removeAnnotation(current.id);
        setEditor(null);
      };

      const discard = () => {
        const current = editorRef.current;
        if (!current) return;
        removeAnnotation(current.id);
        setEditor(null);
      };

      /* 输入框上方的「编辑」请求（跨 slot 通信，避免把两半绑死） */
      React.useEffect(() => {
        const handler = (event) => {
          const detail = (event && event.detail) || {};
          const annotation = findAnnotation(detail.id);
          if (annotation) openEditor(annotation, detail.rect);
        };
        const onSession = () => {
          setEditor(null);
          setSelection(null);
        };
        window.addEventListener('dqa:edit', handler);
        window.addEventListener('dqa:session', onSession);
        return () => {
          window.removeEventListener('dqa:edit', handler);
          window.removeEventListener('dqa:session', onSession);
        };
      }, []);

      /* ---- 渲染 ---- */
      const children = [];
      children.push(h('style', { key: 'css' }, OVERLAY_CSS));

      if (store.items.length > 0 && !bridge.actions) {
        children.push(
          h(
            'div',
            { key: 'warn', className: 'dqa-warn', 'data-dqa': 'warn' },
            tr('trayMissing')
          )
        );
      }

      if (selection && !editor) {
        children.push(
          h(
            'div',
            {
              key: 'bar',
              className: 'dqa-bar',
              'data-dqa': 'toolbar',
              style: {
                position: 'fixed',
                left: selection.x + 'px',
                top: selection.y + 'px',
                transform: selection.above ? 'translate(-50%,-100%)' : 'translate(-50%,0)',
              },
              onMouseDown: (event) => event.preventDefault(),
            },
            h(
              'button',
              { type: 'button', className: 'dqa-bar-btn primary', title: tr('toolbarTitle') + ' · v' + VERSION, onClick: startAnnotate },
              h('span', { className: 'dqa-ico' }, AnnotateIcon()),
              h('span', null, tr('annotate'))
            ),
          )
        );
      }

      if (editor) {
        const rect = editor.rect || {};
        const width = 340;
        const annotation = findAnnotation(editor.id);

        /* 永远贴着「选区 / 角标」放，不按整行的右边缘定位（整行很宽，会把框甩到很远）：
         * 1) 选区右侧放得下 → 放右侧（选区在行尾时正好落进正文右侧留白）
         * 2) 左侧放得下 → 放左侧
         * 3) 都不行 → 选区下方，再不行就上方 */
        const anchorLeft = rect.left || 0;
        const anchorRight = rect.right || anchorLeft + (rect.width || 0);
        const anchorTop = rect.top || 0;
        const anchorBottom = rect.bottom || 0;
        const gap = 12;
        const POP_H = 240;

        /* 别压到输入框：以输入框卡片顶边为下界，空间不够就翻到选区上方 */
        let limitBottom = window.innerHeight - 12;
        try {
          const card = document.querySelector('[data-composer-card]');
          if (card) {
            const cardTop = card.getBoundingClientRect().top;
            if (cardTop > 80) limitBottom = Math.min(limitBottom, cardTop - 12);
          }
        } catch (error) {
          /* 忽略 */
        }
        const maxTop = Math.max(12, limitBottom - POP_H);
        const maxLeft = Math.max(12, window.innerWidth - width - 12);
        const clampTop = (value) => Math.min(Math.max(12, value), maxTop);

        let left;
        let top;
        if (anchorRight + gap + width <= window.innerWidth - 12) {
          left = anchorRight + gap;
          top = clampTop(anchorTop);
        } else if (anchorLeft - gap - width >= 12) {
          left = anchorLeft - gap - width;
          top = clampTop(anchorTop);
        } else {
          left = Math.min(Math.max(12, anchorLeft), maxLeft);
          const spaceBelow = limitBottom - anchorBottom;
          top = spaceBelow > POP_H + gap ? anchorBottom + gap : Math.max(12, anchorTop - POP_H - gap);
          top = clampTop(top);
        }

        children.push(
          h(
            'div',
            { key: 'pop', className: 'dqa-pop', 'data-dqa': 'popover', style: { left: left + 'px', top: top + 'px' } },
            h('textarea', {
              autoFocus: true,
              placeholder: tr('placeholder'),
              value: editor.comment,
              onChange: (event) => setEditor(Object.assign({}, editor, { comment: event.target.value })),
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancel();
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  commit();
                }
              },
            }),
            h(
              'div',
              { className: 'dqa-pop-actions' },
              editor.mode === 'edit'
                ? h('button', { type: 'button', className: 'dqa-pop-trash', title: tr('remove'), onClick: discard }, TrashIcon())
                : null,
              h('button', { type: 'button', className: 'dqa-btn', onClick: cancel }, tr('cancel')),
              h('button', { type: 'button', className: 'dqa-btn primary', onClick: commit }, tr('save'))
            )
          )
        );
      }

      for (let i = 0; i < badges.length; i++) {
        const badge = badges[i];
        children.push(
          h(
            'button',
            {
              key: 'b' + badge.id,
              type: 'button',
              className: 'dqa-badge',
              'data-dqa': 'badge',
              title: tr('edit'),
              style: { left: badge.left + 'px', top: badge.top + 'px' },
              onClick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                const annotation = findAnnotation(badge.id);
                if (annotation) {
                  openEditor(annotation, {
                    left: badge.left - 22,
                    right: badge.left,
                    top: badge.top,
                    bottom: badge.top + 20,
                    width: 22,
                  });
                }
              },
            },
            String(badge.n)
          )
        );
      }

      children.push(h(QuoteStrip, { key: 'strip' }));

      return h('div', { className: 'dqa-layer', 'data-dqa': 'layer', 'data-dqa-scheme': scheme }, children);
    }

    /* ================================================================== *
     * 输入框上方：批注胶囊 + 面板 + 发送时折叠
     * ================================================================== */
    const TRAY_CSS = [
      '@keyframes dqa-in2{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
      '.dqa-stripwrap{position:fixed;z-index:2147483001;pointer-events:auto;user-select:none;display:flex;flex-direction:column;',
      'gap:6px;box-sizing:border-box}',
      '.dqa-strip{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;height:30px;',
      'padding:0 8px 0 10px;border:1px solid var(--dqa-border);border-radius:10px;background:var(--dqa-surface-2)}',
      '.dqa-strip-main{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:100%;border:none;',
      'background:transparent;color:var(--dqa-text);cursor:pointer;font:400 12px/1 -apple-system,',
      'BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;text-align:left;padding:0}',
      '.dqa-strip-main:hover .dqa-strip-title{opacity:.85}',
      '.dqa-strip-insert{flex:none;width:22px;height:20px;padding:0;border-radius:6px;border:none;',
      'background:transparent;color:var(--dqa-text-2);cursor:pointer;font:500 12px/1 inherit}',
      '.dqa-strip-insert:hover{color:var(--dqa-text);background:var(--dqa-surface-3)}',
      '.dqa-strip-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;',
      'padding:0 5px;border-radius:9px;background:var(--dqa-accent-fill);color:var(--dqa-on-accent);',
      'font-size:11px;font-weight:600;flex:none}',
      '.dqa-strip-title{flex:none;font-weight:500}',
      '.dqa-strip-hint{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dqa-text-2);font-size:11px}',
      '.dqa-strip-chevron{flex:none;color:var(--dqa-text-2);font-size:10px}',
      '.dqa-panel{border:1px solid var(--dqa-border);border-radius:12px;background:var(--dqa-surface);',
      'padding:8px;display:flex;flex-direction:column;gap:6px;max-height:230px;overflow:auto;animation:dqa-in2 .12s ease}',
      '.dqa-row{display:flex;align-items:flex-start;gap:8px;padding:5px 4px;border-bottom:1px solid var(--dqa-border)}',
      '.dqa-row:last-of-type{border-bottom:none}',
      '.dqa-row-src{flex:none;color:var(--dqa-text-2);font-size:11px;opacity:.85}',
      '.dqa-row-n{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;',
      'margin-top:1px;padding:0 5px;border-radius:9px;background:var(--dqa-accent-fill);color:var(--dqa-on-accent);',
      'font-size:11px;font-weight:600}',
      '.dqa-row-main{flex:1;min-width:0}',
      '.dqa-row-head{display:flex;align-items:center;gap:6px;color:var(--dqa-text-2);font-size:11px;',
      'margin-bottom:2px;min-width:0}',
      '.dqa-row-quote{color:var(--dqa-text-2);opacity:.9;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;min-width:0}',
      '.dqa-row-comment{color:var(--dqa-text);white-space:pre-wrap;word-break:break-word}',
      '.dqa-row-acts{flex:none;display:flex;gap:2px;align-items:center}',
      '.dqa-icon-btn{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:none;',
      'border-radius:6px;background:transparent;color:var(--dqa-text-2);cursor:pointer;font:inherit;padding:0}',
      '.dqa-icon-btn:hover{background:var(--dqa-surface-3);color:var(--dqa-text)}',
      '.dqa-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}',
      '.dqa-link{border:none;background:transparent;color:var(--dqa-text-2);cursor:pointer;font:inherit;',
      'padding:2px 4px;border-radius:4px}',
      '.dqa-link:hover{color:var(--dqa-text);background:var(--dqa-surface-3)}',
    ].join('');

    function annotationSessionItems(sessionId) {
      // 批注按「当前可见会话」组织：会话切换时由 QuoteTray 清空，
      // 因此这里直接返回全局列表即可（避免把两半组件耦合到 session 身份上）。
      void sessionId;
      return store.items;
    }

    /* ================================================================== *
     * 输入框桥（conversation.input.overlay 里渲染 null）
     * 只做两件事：把 inputActions / 草稿暴露给共享 bridge；维护空草稿占位符。
     * ================================================================== */
    function InputBridge(props) {
      useStoreVersion();

      const propsRef = React.useRef(props);
      propsRef.current = props;

      const selectDraft = (state) => (state && state.draft) || '';
      const useInputProp = props.useInput;
      const draft = typeof useInputProp === 'function' ? useInputProp(selectDraft) : selectDraft(props.input);
      const draftRef = React.useRef(draft);
      draftRef.current = draft;

      const actions = props.inputActions;
      React.useEffect(() => {
        bridge.sessionId = props.sessionId || null;
        bridge.actions = actions || null;
        bridge.getDraft = () => draftRef.current || '';
        return () => {
          if (bridge.actions === actions) bridge.actions = null;
        };
      }, [actions, props.sessionId]);

      /* 切换会话：上一会话的批注不能带到这一会话（更不能跨会话发出去） */
      const sessionRef = React.useRef(props.sessionId);
      React.useEffect(() => {
        if (sessionRef.current === props.sessionId) return;
        sessionRef.current = props.sessionId;
        if (store.items.length > 0) {
          store.items = [];
          notify();
        }
        try {
          window.dispatchEvent(new CustomEvent('dqa:session'));
        } catch (error) {
          /* 忽略 */
        }
      }, [props.sessionId]);

      /* 空草稿 + 有批注：写一个零宽占位，让原生发送按钮可用（发送时剔除） */
      React.useEffect(() => {
        if (!actions || typeof actions.setDraft !== 'function') return;
        const current = draftRef.current || '';
        if (store.items.length > 0) {
          if (current.trim() !== '') return;
          if (current.indexOf(ZWSP) >= 0) return;
          actions.setDraft(ZWSP);
        } else if (current === ZWSP) {
          actions.setDraft('');
        }
      }, [store.items.length, actions]);

      return null;
    }

    /* ================================================================== *
     * 发送拦截（模块级安装，不依赖任何组件是否挂载）
     * ================================================================== */
    function isSendButton(button) {
      let root = document.querySelector('[data-composer-card]');
      if (!root) {
        const editor = document.querySelector(EDITOR_SELECTOR);
        if (!editor) return false;
        root = editor;
        for (let depth = 0; depth < 8 && root.parentElement; depth++) {
          root = root.parentElement;
          if (root.querySelectorAll('button').length >= 2) break;
        }
      }
      if (!root.contains(button)) return false;
      const all = root.querySelectorAll('button');
      let rightmost = null;
      let rightmostEdge = -Infinity;
      for (let i = 0; i < all.length; i++) {
        const candidate = all[i];
        if (candidate.disabled || candidate.closest(OWN_SELECTOR)) continue;
        const edge = candidate.getBoundingClientRect().right;
        if (edge > rightmostEdge) {
          rightmost = candidate;
          rightmostEdge = edge;
        }
      }
      return rightmost === button;
    }

    function submitWhenReady(actions, composed) {
      let tries = 0;
      const header = tr('sentHeader');
      const attempt = () => {
        tries += 1;
        const published = (bridge.getDraft && bridge.getDraft()) || '';
        const ready = header !== '' && published.indexOf(header) !== -1;
        if (ready || tries > 16) {
          try {
            if (typeof actions.submit === 'function') actions.submit();
          } catch (error) {
            if (window.console) window.console.error('[quote-annotate] submit failed', error);
          }
          window.setTimeout(() => {
            foldingRef.current = false;
          }, 150);
          if (window.console) {
            window.console.log('[quote-annotate] submit sent, draftPublished =', ready, ', chars =', (composed || '').length);
          }
          return;
        }
        window.setTimeout(attempt, 16);
      };
      window.setTimeout(attempt, 16);
    }

    function foldAndSubmit() {
      const folded = store.items.slice();
      if (folded.length === 0) return false;
      const actions = bridge.actions;
      if (!actions || typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') return false;
      if (foldingRef.current) return false;
      foldingRef.current = true;
      let composed = '';
      try {
        composed = composeSentText(bridge.getDraft ? bridge.getDraft() : '', folded);
        actions.setDraft(composed);
        store.items = [];
        notify();
      } catch (error) {
        foldingRef.current = false;
        if (window.console) window.console.error('[quote-annotate] fold failed', error);
        return false;
      }
      if (window.console) {
        window.console.log('[quote-annotate] folded', folded.length, 'annotation(s),', composed.length, 'chars');
      }
      submitWhenReady(actions, composed);
      return true;
    }

    function onSendKeyDown(event) {
      if (event.key !== 'Enter') return;
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest(EDITOR_SELECTOR)) return;
      if (foldAndSubmit()) {
        event.preventDefault();
        event.stopPropagation();
        if (window.console) window.console.log('[quote-annotate] send by Enter (intercepted)');
      }
    }

    function onSendClick(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('button');
      if (!button || button.disabled || button.closest(OWN_SELECTOR)) return;
      if (!isSendButton(button)) return;
      if (foldAndSubmit()) {
        event.preventDefault();
        event.stopPropagation();
        if (window.console) window.console.log('[quote-annotate] send by button (intercepted)');
      }
    }

    let sendListenerInstalled = false;
    function installSendInterception() {
      if (sendListenerInstalled) return;
      sendListenerInstalled = true;
      document.addEventListener('keydown', onSendKeyDown, true);
      document.addEventListener('click', onSendClick, true);
    }

    /* ================================================================== *
     * 批注条（根级悬浮层里渲染，贴在输入框正上方）
     * ================================================================== */
    const STRIP_GAP = 6;

    function QuoteStrip() {
      useLocaleTick();
      useStoreVersion();

      const [expanded, setExpanded] = React.useState(false);
      /** 输入框卡片位置（fixed 坐标）：{ left, width, top } */
      const [anchor, setAnchor] = React.useState(null);

      React.useEffect(() => {
        let frame = 0;
        const measure = () => {
          frame = 0;
          const card =
            document.querySelector('[data-composer-card]') || document.querySelector(EDITOR_SELECTOR);
          if (!card) {
            setAnchor(null);
            return;
          }
          const rect = card.getBoundingClientRect();
          if (!rect.width) return;
          setAnchor({
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            top: Math.round(rect.top),
          });
        };
        const schedule = () => {
          if (!frame) frame = window.requestAnimationFrame(measure);
        };
        measure();
        const timer = window.setInterval(schedule, 500);
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);
        return () => {
          if (frame) window.cancelAnimationFrame(frame);
          window.clearInterval(timer);
          window.removeEventListener('resize', schedule);
          window.removeEventListener('scroll', schedule, true);
        };
      }, [expanded]);

      const items = store.items;
      if (items.length === 0 || !anchor) return null;

      const clearAll = () => {
        store.items = [];
        notify();
        const actions = bridge.actions;
        const draft = bridge.getDraft ? bridge.getDraft() : '';
        if (actions && typeof actions.setDraft === 'function' && draft === ZWSP) actions.setDraft('');
      };

      const insertIntoDraft = () => {
        const actions = bridge.actions;
        const folded = store.items.slice();
        if (!actions || typeof actions.setDraft !== 'function' || folded.length === 0) return;
        actions.setDraft(composeSentText(bridge.getDraft ? bridge.getDraft() : '', folded));
        store.items = [];
        notify();
      };

      const rows = expanded
        ? items.map((item) =>
            h(
              'div',
              { className: 'dqa-row', key: item.id },
              h('span', { className: 'dqa-row-n' }, String(item.n)),
              h(
                'div',
                { className: 'dqa-row-main' },
                h(
                  'div',
                  { className: 'dqa-row-head' },
                  h('span', { className: 'dqa-row-src' }, shortSource(item)),
                  h('span', { className: 'dqa-row-quote' }, '「' + String(item.quote || '').split('\n')[0] + '」')
                ),
                item.comment && item.comment.trim()
                  ? h('div', { className: 'dqa-row-comment' }, item.comment)
                  : null
              ),
              h(
                'div',
                { className: 'dqa-row-acts' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dqa-icon-btn',
                    title: tr('edit'),
                    onClick: () => {
                      const range = locateAnnotation(item);
                      const rect = range ? range.getBoundingClientRect() : item.rect;
                      try {
                        window.dispatchEvent(new CustomEvent('dqa:edit', { detail: { id: item.id, rect: toPlainRect(rect) } }));
                      } catch (error) {
                        /* 忽略 */
                      }
                    },
                  },
                  '✎'
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dqa-icon-btn',
                    title: tr('jump'),
                    onClick: () => {
                      const range = locateAnnotation(item);
                      const el = range ? elementOf(range.startContainer) : null;
                      const row = el ? el.closest(ROW_SELECTOR) : null;
                      const target = row || el;
                      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    },
                  },
                  '↗'
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dqa-icon-btn',
                    title: tr('remove'),
                    onClick: () => {
                      removeAnnotation(item.id);
                    },
                  },
                  '×'
                )
              )
            )
          )
        : null;

      const panel = expanded
        ? h(
            'div',
            { className: 'dqa-panel', 'data-dqa': 'panel' },
            h(
              'div',
              { className: 'dqa-row-head', style: { padding: '0 4px' } },
              h('span', null, tr('trayTitle', { n: items.length })),
              h('span', { className: 'dqa-row-quote' })
            ),
            rows,
            h(
              'div',
              { className: 'dqa-foot' },
              h('button', { type: 'button', className: 'dqa-link', onClick: clearAll }, tr('clear'))
            )
          )
        : null;

      const strip = h(
        'div',
        { className: 'dqa-strip', 'data-dqa': 'strip', title: 'v' + VERSION + ' · ' + tr('pillHint') },
        h(
          'button',
          { type: 'button', className: 'dqa-strip-main', onClick: () => setExpanded((value) => !value) },
          h('span', { className: 'dqa-strip-count' }, String(items.length)),
          h('span', { className: 'dqa-strip-title' }, tr('pillOne')),
          h('span', { className: 'dqa-strip-chevron' }, expanded ? '▾' : '▸')
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dqa-strip-insert',
            title: tr('insertHint'),
            onClick: (event) => {
              event.stopPropagation();
              insertIntoDraft();
            },
          },
          '⇩'
        )
      );

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, TRAY_CSS),
        h(
          'div',
          {
            className: 'dqa-stripwrap',
            'data-dqa': 'stripwrap',
            style: {
              left: anchor.left + 'px',
              width: anchor.width + 'px',
              bottom: Math.max(8, window.innerHeight - anchor.top + STRIP_GAP) + 'px',
            },
          },
          panel,
          strip
        )
      );
    }

    /** Range/DOMRect -> 可序列化的普通对象（跨组件传参用） */
    function toPlainRect(rect) {
      if (!rect) return null;
      return {
        left: rect.left || 0,
        top: rect.top || 0,
        bottom: rect.bottom || 0,
        right: rect.right || 0,
        width: rect.width || 0,
      };
    }

    /* ================================================================== *
     * 插件入口
     * ================================================================== */
    function apply(ctx) {
      if (applied) return;
      applied = true;
      if (window.console) window.console.log('[quote-annotate] client loaded v' + VERSION);

      locale = typeof ctx.get === 'function' ? ctx.get('locale') : null;
      refreshLocale();

      if (locale && typeof locale.subscribe === 'function') {
        ctx.effect(() => {
          const dispose = locale.subscribe(() => refreshLocale());
          return () => dispose();
        });
      }

      clientCtx = ctx;
      themeService = typeof ctx.get === 'function' ? ctx.get('theme') : null;
      refreshScheme();
      if (typeof ctx.on === 'function') {
        ctx.effect(() =>
          ctx.on('theme/change', () => {
            refreshScheme();
            notify();
          })
        );
      }

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'quote-annotate-overlay', order: 40 }, QuoteOverlay)
      );

      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register({ name: 'conversation.input.overlay', id: 'quote-annotate-bridge', order: 90 }, InputBridge)
      );

      installSendInterception();
    }

    /* 测试钩子（仅显式打开时暴露，方便无浏览器环境回归） */
    if (typeof window !== 'undefined' && window.__DQA_TEST_HOOK__) {
      window.__dqaTest = {
        store,
        bridge,
        buildAnnotationBlock,
        composeSentText,
        buildQuoteBlock,
        parseQuoteItems,
        maxMarkerNumber,
        insertQuote,
        addAnnotation,
        updateAnnotation,
        removeAnnotation,
        clearAnnotations,
        locateAnnotation,
        textMapOf,
      };
    }

    return { inject: ['slots'], apply };
  },
});
