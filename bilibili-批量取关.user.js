// ==UserScript==
// @name         B站关注列表 - 批量取关
// @namespace    https://space.bilibili.com/
// @version      2.3.0
// @description  在 space.bilibili.com 关注列表页右上角添加「批量取关」「停止」「诊断」按钮和数量输入框：自动翻页（分页结构）+ 自动滚动加载（虚拟滚动）、随机延迟逐个取关、数量可自定，并校验取关是否真的生效——未生效会明确报错而不是假装成功。
// @author       you
// @match        https://space.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ======================== 配置 ======================== */
  const CONFIG = {
    DEFAULT_LIMIT: 50,          // 输入框的默认值 / 留空时的回退值
    HARD_LIMIT: 500,            // 输入框允许的最大值（防手滑填一个巨大的数）
    BASE_INTERVAL_MS: 3000,     // 两次取关之间的基准间隔
    JITTER_MS: 2000,            // 随机抖动，实际 3000~5000ms
    SCROLL_STEP_MS: 700,        // 每次滚动后的等待
    SCROLL_SETTLE_MS: 1000,     // 仍未出现卡片时的额外等待
    SCROLL_RATIO: 0.85,         // 每次滚动占视口高度的比例
    PRE_CLICK_SETTLE_MS: 400,  // 滚动到目标后、点击前的等待
    PAGE_TURN_WAIT_MS: 2500,    // 点「下一页」后等待新内容加载
    MAX_IDLE_SCROLLS: 8,        // 连续 N 次滚动都推不动 => 判定真到底了
    MENU_WAIT_MS: 700,          // 点触发器后，等下拉菜单出现
    VERIFY_WAIT_MS: 2500,       // 操作后等待校验（是否真的取关成功）
    MAX_CONSECUTIVE_ERRORS: 5,  // 连续失败这么多次自动停
    DEBUG: true                 // 输出更详细的日志
  };

  const LOG_PREFIX = '[批量取关]';
  let running = false;
  let stopped = false;
  let reachedLimit = false;
  let doneCount = 0;      // 确认成功的数量
  let failCount = 0;      // 失败数量
  let runLimit = 50;      // 本次运行的上限（由界面输入框决定，开跑瞬间锁定）
  let pagesTurned = 0;    // 本次运行已经翻了几页
  let statusEl = null;

  /* ======================== 工具 ======================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function randomDelay() {
    return CONFIG.BASE_INTERVAL_MS + Math.floor(Math.random() * CONFIG.JITTER_MS);
  }

  function now() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  const STYLES = {
    info: 'color:#00a1d6', ok: 'color:#2ecc71', warn: 'color:#f39c12',
    err: 'color:#e74c3c', dim: 'color:#888'
  };

  function log(msg, type = 'info') {
    console.log(`%c${LOG_PREFIX} ${now()} ${msg}`, STYLES[type] || STYLES.info);
  }

  function debug(msg) {
    if (CONFIG.DEBUG) console.log(`%c${LOG_PREFIX} ${now()} · ${msg}`, STYLES.dim);
  }

  function textOf(el) {
    return el ? (el.textContent || '').replace(/\s+/g, '') : '';
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  }

  /* ======================== 选择器 ========================
   * 依据真实页面结构（2026-09 实测）：
   *   <div class="relation-card-info-option">
   *     <div class="follow-btn">                     <- 外层容器，点了没用
   *       <div class="menu-popover">
   *         <div class="follow-btn-wrapper">
   *           <div class="follow-btn__trigger gray">  <- 真正可点的触发器
   *             <svg/> 已关注
   *     <div class="menu-popover">                    <- 下拉菜单挂在这里
   */
  const TRIGGER_SELECTORS = [
    '.follow-btn__trigger',
    '.follow-btn-wrapper',
    '.follow-btn',
    '.relation-card-info-option [class*="trigger"]'
  ];

  const CARD_SELECTORS = [
    '.relation-list-item',
    '.follow-item',
    '.user-card',
    '.bili-user-card',
    '.card-item',
    '.relation-card-info'
  ];

  /* 只排除【页面级】区域。
   * 注意：不要把 '.menu' / '.menu-item' / '.tab' 这类通用词放进来 ——
   * 取关按钮自己就包在 .menu-popover 里，这类通用词会把整批按钮误伤掉，
   * 造成"一个都识别不到"。
   */
  const EXCLUDE_REGION_SELECTORS = [
    '.nav', '.nav-bar', '.sidebar', '.side-bar', '.aside',
    '.header', '.footer', '.pagination', '.page-nav',
    '.breadcrumb', '.bili-header', '.mini-header', '.international-header'
  ];

  /** 下拉菜单里「取消关注」的候选项 */
  const MENU_ITEM_SELECTORS = [
    '.be-dropdown-item',
    '.be-dropdown-menu__item',
    '.menu-popover .menu-item',
    '.vui_menu_item',
    '[class*="dropdown"] [class*="item"]',
    '[class*="popover"] [class*="item"]',
    'li[role="menuitem"]',
    '[role="menuitem"]'
  ];

  const UNFOLLOW_WORDS = ['取消关注', '不再关注', '取消關注', '移除粉丝'];

  function inExcludedRegion(el, root) {
    let node = el;
    while (node && node !== root) {
      if (node.matches && EXCLUDE_REGION_SELECTORS.some((s) => node.matches(s))) return true;
      node = node.parentElement;
    }
    return false;
  }

  function findContainer() {
    const sels = ['.relation-list', '.follow-list', '.card-list', '.user-card-list', '.bili-user-card-list'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  /**
   * 向上找到该触发器所属的「用户卡片」。
   *
   * 注意两个踩过的坑：
   *  1) 不能限制上溯层数 —— 真实结构里触发器到卡片有 6~7 层
   *     （trigger → wrapper → menu-popover → follow-btn → option → card-info → list-item）。
   *  2) 用户名链接是触发器的【兄弟节点】（同在卡片容器内），不是后代，
   *     所以必须用 closest 向上匹配，而不是在触发器内部 querySelector。
   */
  function findCardAncestor(el) {
    // 优先：向上找明确的卡片容器
    for (const sel of CARD_SELECTORS) {
      const hit = el.closest && el.closest(sel);
      if (hit) return hit;
    }
    // 兜底：向上找到「包含用户空间链接」的那个容器（不限层数）
    let node = el;
    while (node && node !== document.body) {
      if (node.querySelector && node.querySelector('a[href*="space.bilibili.com/"]')) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 收集当前所有「已关注」触发器。
   * 返回 [{ trigger, card }]，每张卡片最多一个。
   */
  function findTriggers() {
    const out = [];
    const seen = new Set();      // 已收录的卡片，保证每卡片只处理一次
    const root = findContainer() || document.body;

    const consider = (el) => {
      if (!el || seen.has(el)) return;
      if (!isVisible(el)) return;
      if (inExcludedRegion(el, root)) return;

      // 【关键】触发器本身必须带「已关注」文字。
      // 否则 <svg class="vui_icon follow-btn__trigger-icon"> 这类子元素会被误收，
      // 点它等于什么都没点。
      const t = textOf(el);
      if (!t.includes('已关注') && !t.includes('取消关注')) return;

      const card = findCardAncestor(el);
      if (!card) return;                       // 必须在用户卡片里
      if (seen.has(card)) return;              // 每张卡片只保留第一个触发器
      // 已经被判定为"点了不生效"的卡片，本轮不再重试，否则会一直撞同一张卡、
      // 永远推进不到后面的用户。
      if (card.dataset && card.dataset.bfuFailed === '1') return;

      seen.add(card);
      out.push({ trigger: el, card });
    };

    // 主策略：真实类名
    for (const sel of TRIGGER_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        // 只取最内层：若它内部还有触发器结构，说明它只是外层容器
        if (el.querySelector('.follow-btn__trigger, .follow-btn-wrapper')) return;
        consider(el);
      });
      if (out.length > 0) break;               // 命中就不再往下试，避免重复
    }

    // 补充：纯文字匹配（覆盖改版导致类名变化的情况）
    if (out.length === 0) {
      document.querySelectorAll('div, span, button, a').forEach((el) => {
        if (el.children.length > 0) return;
        const t = textOf(el);
        if (t !== '已关注' && t !== '取消关注') return;
        // 优先用它的可点击祖先
        let p = el;
        for (let d = 0; d < 4 && p; d++) {
          if (/follow-btn__trigger|follow-btn-wrapper|follow-btn/.test(p.className || '')) {
            consider(p);
            return;
          }
          p = p.parentElement;
        }
        consider(el);
      });
    }

    return out;
  }

  /**
   * 点开下拉菜单后，找到「取消关注」菜单项。
   * 返回元素或 null。
   */
  function findMenuItem() {
    // 优先在可见的浮层里找
    const layers = document.querySelectorAll(
      '.menu-popover, .be-dropdown, .be-dropdown-menu, [class*="popover"], [class*="dropdown"], [class*="menu"]'
    );

    for (const layer of layers) {
      if (!isVisible(layer)) continue;
      for (const sel of MENU_ITEM_SELECTORS) {
        for (const item of layer.querySelectorAll(sel)) {
          if (!isVisible(item)) continue;
          const t = textOf(item);
          if (!UNFOLLOW_WORDS.some((w) => t.includes(w))) continue;
          return item;
        }
      }
    }

    // 退一步：全页找可见的「取消关注」文字项
    for (const el of document.querySelectorAll('div, span, li, button, a')) {
      if (el.children.length > 0) continue;
      const t = textOf(el);
      if (!UNFOLLOW_WORDS.includes(t)) continue;
      if (!isVisible(el)) continue;
      const clickable = el.closest('li, button, [class*="item"], [role="menuitem"]') || el;
      if (isVisible(clickable)) return clickable;
    }
    return null;
  }

  /** 处理可能出现的二次确认弹窗（只在确实是确认语境时点） */
  async function confirmDialogIfAny() {
    const sels = [
      '.bili-modal .bili-modal__button.primary',
      '.bili-dialog .bili-dialog__button.primary',
      '.bili-modal__button.primary',
      '.bl-button--primary',
      '.van-dialog__confirm'
    ];
    for (const sel of sels) {
      for (const btn of document.querySelectorAll(sel)) {
        if (!isVisible(btn)) continue;
        const t = textOf(btn);
        if (t && /取消|关闭/.test(t)) continue;
        if (t && !/确定|确认|好的|是/.test(t)) continue;
        btn.click();
        debug(`已点击确认弹窗（${sel}）`);
        return true;
      }
    }
    return false;
  }

  /* ======================== 分页 ========================
   * 关注列表是【分页】结构（每页 N 人，底部有页码条），
   * 不是无限滚动 —— 处理完当前页必须点「下一页」才会有新用户。
   * 这是"必须人工调页面"的真正原因。
   */

  /** 下一页按钮的候选选择器（B 站用 VUI 的 vui_pagenation 组件） */
  const NEXT_PAGE_SELECTORS = [
    '.vui_pagenation--btn-next',
    '.vui_pagenation .vui_pagenation--btn-next',
    '.vui_pagenation-btn-next',
    '.vui_pagenation .next',
    'button[class*="pagenation"][class*="next"]',
    '[class*="pagination"] [class*="next"]',
    '[class*="pagenation"] [class*="next"]'
  ];

  /** 找「下一页」按钮（类名优先，文字兜底；排除禁用状态） */
  function findNextPageButton() {
    for (const sel of NEXT_PAGE_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;
        if (el.disabled) continue;
        if (/disabled|forbid/i.test(el.className || '')) continue;
        return el;
      }
    }
    for (const el of document.querySelectorAll('button, a, li, div, span')) {
      const t = textOf(el);
      if (t !== '下一页' && t !== '下页') continue;
      if (!isVisible(el)) continue;
      const clickable = el.closest('button, a, li, [class*="btn"]') || el;
      if (clickable.disabled) continue;
      if (/disabled|forbid/i.test(clickable.className || '')) continue;
      return clickable;
    }
    return null;
  }

  /** 当前页的"指纹"：用页面上几个用户 uid 拼成，用于判断翻页是否真生效 */
  function pageSignature() {
    const uids = [];
    document.querySelectorAll('a[href*="space.bilibili.com/"]').forEach((a) => {
      const m = /space\.bilibili\.com\/(\d+)/.exec(a.getAttribute('href') || '');
      if (m && uids.length < 8 && !uids.includes(m[1])) uids.push(m[1]);
    });
    return uids.join(',');
  }

  /** 点「下一页」，返回是否点到了 */
  function clickNextPage() {
    const btn = findNextPageButton();
    if (!btn) return false;
    debug(`点击下一页：<${btn.tagName.toLowerCase()} class="${btn.className}">`);
    try {
      if (typeof btn.scrollIntoView === 'function') btn.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch (e) { /* ignore */ }
    btn.click();
    return true;
  }

  /**
   * 对单个卡片执行取关，并【校验是否真的生效】。
   * 成功判定（满足任一）：
   *   a) 该卡片从 DOM 中消失（B 站取关后会把卡片移除）
   *   b) 卡片内不再有「已关注」文字
   * @returns {{ok: boolean, reason: string}}
   */
  async function unfollowOne(target) {
    const { trigger, card } = target;

    // 环境防御：scrollIntoView 在部分环境（含测试用的 jsdom）不存在，
    // 不能让它把整个流程打断。
    try {
      if (typeof trigger.scrollIntoView === 'function') {
        // 必须用瞬时滚动：smooth 动画期间点击会点空
        trigger.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
    } catch (e) {
      debug(`scrollIntoView 失败（忽略）：${e.message}`);
    }
    await sleep(CONFIG.PRE_CLICK_SETTLE_MS);
    if (stopped) return { ok: false, reason: 'stopped' };

    // 虚拟滚动可能在滚动过程中把节点回收掉，点了也是白点
    if (!trigger.isConnected) return { ok: false, reason: 'stale', stale: true };

    // 第一步：点开触发器
    debug(`点击触发器：<${trigger.tagName.toLowerCase()} class="${trigger.className}">`);
    trigger.click();
    await sleep(CONFIG.MENU_WAIT_MS);

    // 第二步：若有下拉菜单，点其中的「取消关注」
    const item = findMenuItem();
    if (item) {
      debug(`发现菜单项「${textOf(item)}」，点击它`);
      item.click();
    } else {
      debug('未发现下拉菜单（可能是单击直接取关）');
    }

    // 第三步：处理二次确认
    const confirmed = await confirmDialogIfAny();
    if (confirmed) debug('已处理二次确认弹窗');

    await sleep(CONFIG.VERIFY_WAIT_MS);

    // 第四步：校验是否真的生效
    const cardGone = !card.isConnected;
    const stillFollowing = card.isConnected && /已关注/.test(textOf(card));

    if (cardGone) return { ok: true, reason: '卡片已从列表移除' };
    if (!stillFollowing) return { ok: true, reason: '按钮状态已变化' };

    // 没生效：给出可诊断的原因
    const why = item
      ? '点了菜单项但卡片仍在，可能被风控/接口失败'
      : '未找到「取消关注」菜单项，触发器点击可能未展开菜单';
    return { ok: false, reason: why };
  }

  /* ======================== 滚动（虚拟滚动适配）=======================
   * B 站关注列表只渲染【视口附近】的卡片，屏幕外的卡片根本不在 DOM 里。
   * 所以：
   *  - 滚动必须用 behavior:'auto'（瞬时）。smooth 有动画延迟，
   *    滚动还没结束就去点元素，会点空。
   *  - "没找到按钮" ≠ "列表到底了"，必须持续往下推并等新卡片渲染。
   *  - 【关键】不能只滚 window！B 站是 SPA，内容常常放在内部滚动容器里
   *    （.space-app / #app 等），此时窗口本身没有滚动条，滚 window 毫无效果，
   *    会被误判成"到底了"而停下 —— 这正是"必须手动滚一下才能继续"的根因。
   */

  /** 收集所有【真正可滚动】的候选容器（含 window/documentElement） */
  function scrollCandidates() {
    const list = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      list.push(el);
    };

    push(document.scrollingElement);
    push(document.documentElement);
    push(document.body);

    // 从卡片（或列表容器）向上找「内容高于可视高度」的祖先
    const anchor = findContainer() || document.querySelector('.follow-btn__trigger');
    let node = anchor;
    let hops = 0;
    while (node && hops < 12) {
      try {
        if (node.scrollHeight > node.clientHeight + 4 && node.clientHeight > 0) push(node);
      } catch (e) { /* 忽略跨域/无效节点 */ }
      node = node.parentElement;
      hops++;
    }

    // 全页兜底扫描（只在大致可滚动时收录，避免把一堆元素都塞进来）
    try {
      document.querySelectorAll('div, main, section').forEach((el) => {
        if (list.length > 12) return;
        if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200) push(el);
      });
    } catch (e) { /* ignore */ }

    return list;
  }

  function scrollTopOf(el) {
    if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
      return el.scrollTop || window.scrollY || 0;
    }
    return el.scrollTop || 0;
  }

  /** 所有候选容器的滚动位置之和（用作"是否移动"的判据） */
  function totalScrollTop() {
    let sum = 0;
    for (const el of scrollCandidates()) {
      try { sum += scrollTopOf(el); } catch (e) { /* ignore */ }
    }
    return sum;
  }

  /**
   * 向下滚一屏。把【整条祖先链 + window】都推一遍，
   * 这样不管真正的滚动容器是哪一个，都能生效。
   * @returns 是否至少有一个容器真的移动了
   */
  function scrollDown() {
    const step = Math.max(Math.floor(window.innerHeight * CONFIG.SCROLL_RATIO), 300);
    const before = totalScrollTop();

    const candidates = scrollCandidates();
    for (const el of candidates) {
      try {
        const cur = scrollTopOf(el);
        const next = cur + step;
        if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
          window.scrollTo({ top: next, behavior: 'auto' });
        } else {
          el.scrollTop = next;
          // 有些虚拟列表依赖 scroll 事件才会重新渲染；直接改 scrollTop 不一定触发
          el.dispatchEvent(new Event('scroll', { bubbles: false }));
        }
      } catch (e) { /* 某些容器可能只读，忽略 */ }
    }

    // 再兜一次 window（防止 window 才是真容器的情况被上面的异常跳过）
    try { window.scrollBy({ top: step, behavior: 'auto' }); } catch (e) { /* ignore */ }

    return totalScrollTop() !== before;
  }

  /**
   * 主动把页面往下推，直到出现可处理的卡片、或确认到底。
   * 这是"必须手动滚一下才能继续"的核心修复。
   * @returns {boolean} 是否找到了卡片
   */
  async function advanceUntilCards() {
    if (findTriggers().length > 0) return true;

    let idle = 0;
    while (!stopped && idle < CONFIG.MAX_IDLE_SCROLLS) {
      const moved = scrollDown();
      await sleep(CONFIG.SCROLL_STEP_MS);

      // 滚动后立刻检查；虚拟滚动会在这一瞬间渲染出新卡片
      if (findTriggers().length > 0) return true;

      if (!moved) {
        idle++;
        debug(`滚动未移动（${idle}/${CONFIG.MAX_IDLE_SCROLLS}）`);
      } else {
        idle = 0;   // 还在移动就说明没到底，重置计数
      }
      await sleep(CONFIG.SCROLL_SETTLE_MS);
    }
    return findTriggers().length > 0;
  }

  /* ======================== 主流程 ======================== */
  async function batchUnfollow() {
    if (running) {
      log('已有任务在运行中，忽略本次点击', 'warn');
      return;
    }
    running = true;
    stopped = false;
    reachedLimit = false;
    doneCount = 0;
    failCount = 0;
    pagesTurned = 0;
    // 开跑瞬间锁定上限，之后即使改输入框也不影响本次
    runLimit = readLimitFromUI();

    log('========== 开始批量取关（v2.2）==========');
    log(`本次计划取关 ${runLimit} 个 · 间隔 ${CONFIG.BASE_INTERVAL_MS}~${CONFIG.BASE_INTERVAL_MS + CONFIG.JITTER_MS}ms`);

    // 起始时若视口内没卡片，先主动往下推（虚拟滚动下很常见）
    if (findTriggers().length === 0) await advanceUntilCards();

    const firstBatch = findTriggers();
    log(`页面当前识别到 ${firstBatch.length} 个「已关注」按钮`, firstBatch.length ? 'ok' : 'err');
    if (firstBatch.length === 0) {
      log('一个都没识别到，脚本无法工作。请点「诊断」并把输出发给开发者。', 'err');
      running = false;
      updateStatus();
      return;
    }

    let consecutiveErrors = 0;

    while (!stopped && !reachedLimit) {
      if (doneCount >= runLimit) {
        reachedLimit = true;
        log(`已达到本次计划数量 ${runLimit} 个，自动停止。想继续请改数字后再点「批量取关」。`, 'ok');
        break;
      }

      let targets = findTriggers();

      // 当前页处理完了。分页结构的页面必须【点下一页】才会有新用户，
      // 光靠滚动是永远等不到的 —— 这是"必须人工调页面"的真正原因。
      if (targets.length === 0) {
        const found = await advanceUntilCards();
        targets = findTriggers();

        if (targets.length === 0) {
          if (found) continue;   // 滚动又加载出了卡片，继续

          // 滚动已到底仍然没卡片 => 尝试翻到下一页
          const beforeSig = pageSignature();
          const turned = clickNextPage();
          if (turned) {
            pagesTurned++;
            log(`本页已处理完，翻到第 ${pagesTurned + 1} 页…`, 'info');
            await sleep(CONFIG.PAGE_TURN_WAIT_MS);
            // 等新一页的卡片渲染出来
            await advanceUntilCards();
            const after = findTriggers();
            if (after.length > 0) {
              log(`第 ${pagesTurned + 1} 页已加载，识别到 ${after.length} 个「已关注」`, 'ok');
              consecutiveErrors = 0;
              continue;
            }
            if (pageSignature() === beforeSig) {
              log('点了「下一页」但页面内容没变化，停止（可能已是最后一页或按钮已禁用）。', 'warn');
              break;
            }
            continue;
          }

          log('页面已滚到底，且没有可用的「下一页」按钮，任务结束。', 'ok');
          break;
        }
        if (!found) {
          debug('滚动已到底，但页面上仍有可处理卡片，继续处理');
        }
      }

      const target = targets[0];

      try {
        const result = await unfollowOne(target);

        if (result.ok) {
          doneCount++;
          consecutiveErrors = 0;
          log(`第 ${doneCount} 个：✅ 已取关（${result.reason}）`, 'ok');
        } else if (result.reason === 'stopped') {
          break;
        } else if (result.stale) {
          // 节点被虚拟滚动回收了，不算失败，重新扫描即可
          debug('目标节点已被列表回收，重新扫描');
          continue;
        } else {
          failCount++;
          consecutiveErrors++;
          log(`第 ${doneCount + failCount} 个：❌ 未生效 —— ${result.reason}`, 'err');
          if (consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
            log(`连续 ${CONFIG.MAX_CONSECUTIVE_ERRORS} 次未生效，自动停止。多数情况是 B 站改了页面结构或触发了风控。`, 'err');
            break;
          }
          // 标记这张卡，避免下一轮又撞同一个
          target.card.dataset.bfuFailed = '1';
        }
      } catch (err) {
        failCount++;
        consecutiveErrors++;
        log(`第 ${doneCount + failCount} 个：❌ 异常 —— ${err.message}`, 'err');
        if (consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) break;
      }

      if (stopped) break;

      const delay = randomDelay();
      log(`  等待 ${(delay / 1000).toFixed(1)} 秒…`, 'dim');
      if (!(await waitInterruptible(delay))) break;
    }

    running = false;
    const tail = `成功 ${doneCount} 个，失败 ${failCount} 个`;
    if (reachedLimit) log(`========== 已达单次上限，自动停止（${tail}）==========`, 'ok');
    else if (stopped) log(`========== 已手动停止（${tail}）==========`, 'warn');
    else log(`========== 任务结束，已到列表末尾（${tail}）==========`, 'ok');

    if (doneCount === 0 && failCount > 0) {
      log('⚠️ 一个都没成功。这通常意味着页面结构又变了，请把上面的错误原因发给开发者。', 'err');
    }
    updateStatus();
  }

  async function waitInterruptible(ms) {
    const step = 100;
    let waited = 0;
    while (waited < ms) {
      if (stopped) return false;
      await sleep(Math.min(step, ms - waited));
      waited += step;
    }
    return !stopped;
  }

  /* ======================== 界面 ======================== */
  function updateStatus() {
    if (!statusEl) return;
    const pageInfo = pagesTurned > 0 ? ` · 已翻 ${pagesTurned} 页` : '';
    if (running) {
      statusEl.textContent = `运行中 · ${doneCount}/${runLimit} · 失败 ${failCount}${pageInfo}`;
      statusEl.style.color = '#2ecc71';
    } else if (reachedLimit) {
      statusEl.textContent = `已完成 ${doneCount}/${runLimit} · 失败 ${failCount}${pageInfo}`;
      statusEl.style.color = '#f39c12';
    } else if (doneCount || failCount) {
      statusEl.textContent = `已停止 · 成功 ${doneCount} / 失败 ${failCount}${pageInfo}`;
      statusEl.style.color = failCount && !doneCount ? '#e74c3c' : '#999';
    } else {
      statusEl.textContent = '就绪，填好数量后点「批量取关」';
      statusEl.style.color = '#999';
    }
  }

  /** 读取界面上的「本次取关数量」输入框，非法值回退到默认值 */
  function readLimitFromUI() {
    const input = document.getElementById('bfu-limit');
    if (!input) return CONFIG.DEFAULT_LIMIT;
    // 去掉首尾及中间的空格：从别处复制粘贴时经常带空格（如 " 30 "）
    const raw = String(input.value == null ? '' : input.value).replace(/\s+/g, '');
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return CONFIG.DEFAULT_LIMIT;
    return Math.min(n, CONFIG.HARD_LIMIT);
  }

  function buildUI() {
    if (document.getElementById('bfu-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'bfu-panel';
    panel.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'padding:12px', 'border-radius:10px',
      'background:rgba(33,33,33,.94)', 'box-shadow:0 4px 16px rgba(0,0,0,.35)',
      'font:13px/1.5 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif',
      'color:#eee', 'user-select:none'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '关注列表工具 v2.1';
    title.style.cssText = 'font-weight:600;font-size:13px;opacity:.9;';
    panel.appendChild(title);

    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;gap:8px;';

    const startBtn = document.createElement('button');
    startBtn.id = 'bfu-start';
    startBtn.textContent = '批量取关';
    startBtn.style.cssText = [
      'padding:8px 14px', 'border:0', 'border-radius:6px', 'cursor:pointer',
      'background:#00a1d6', 'color:#fff', 'font-size:13px', 'font-weight:600'
    ].join(';');

    const stopBtn = document.createElement('button');
    stopBtn.id = 'bfu-stop';
    stopBtn.textContent = '停止';
    stopBtn.style.cssText = [
      'padding:8px 14px', 'border:0', 'border-radius:6px', 'cursor:pointer',
      'background:#e74c3c', 'color:#fff', 'font-size:13px', 'font-weight:600'
    ].join(';');

    // 诊断按钮：一键检查当前页面能否被正确识别
    const diagBtn = document.createElement('button');
    diagBtn.id = 'bfu-diag';
    diagBtn.textContent = '诊断';
    // 做得足够大，避免点到边缘没反应
    diagBtn.style.cssText = [
      'flex:0 0 auto', 'min-width:64px', 'padding:8px 12px',
      'border:0', 'border-radius:6px', 'cursor:pointer',
      'background:#444', 'color:#eee', 'font-size:12px', 'font-weight:600'
    ].join(';');

    btnWrap.appendChild(startBtn);
    btnWrap.appendChild(stopBtn);
    btnWrap.appendChild(diagBtn);
    panel.appendChild(btnWrap);

    // ---- 数量输入行（放在面板下方）----
    const limitRow = document.createElement('div');
    limitRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;';

    const limitLabel = document.createElement('label');
    limitLabel.textContent = '本次取关数量：';
    limitLabel.setAttribute('for', 'bfu-limit');
    limitLabel.style.cssText = 'color:#ccc;';

    const limitInput = document.createElement('input');
    limitInput.id = 'bfu-limit';
    limitInput.type = 'number';
    limitInput.min = '1';
    limitInput.max = String(CONFIG.HARD_LIMIT);
    limitInput.step = '1';
    limitInput.value = String(CONFIG.DEFAULT_LIMIT);
    limitInput.style.cssText = [
      'width:70px', 'padding:4px 6px', 'border:1px solid #555', 'border-radius:4px',
      'background:#1c1c1c', 'color:#eee', 'font-size:12px', 'text-align:center'
    ].join(';');

    const limitUnit = document.createElement('span');
    limitUnit.textContent = '个';
    limitUnit.style.cssText = 'color:#888;';

    limitRow.appendChild(limitLabel);
    limitRow.appendChild(limitInput);
    limitRow.appendChild(limitUnit);
    panel.appendChild(limitRow);

    // Ctrl+Enter 也能直接开跑，省得去点按钮
    limitInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !running) {
        batchUnfollow();
        updateStatus();
      }
    });

    statusEl = document.createElement('div');
    statusEl.id = 'bfu-status';
    statusEl.style.cssText = 'font-size:12px;color:#999;';
    panel.appendChild(statusEl);

    const hint = document.createElement('div');
    hint.textContent = `默认 ${CONFIG.DEFAULT_LIMIT} 个，最大 ${CONFIG.HARD_LIMIT} · 日志见 F12`;
    hint.style.cssText = 'font-size:11px;color:#666;';
    panel.appendChild(hint);

    document.body.appendChild(panel);

    startBtn.addEventListener('click', () => {
      if (running) { log('任务已在运行中', 'warn'); return; }
      batchUnfollow();
      updateStatus();
      const timer = setInterval(() => {
        updateStatus();
        if (!running) clearInterval(timer);
      }, 500);
    });

    stopBtn.addEventListener('click', () => {
      if (!running) { log('当前没有正在运行的任务', 'warn'); return; }
      stopped = true;
      log('收到停止指令，正在收尾…', 'warn');
      updateStatus();
    });

    diagBtn.addEventListener('click', () => runDiagnostics());

    updateStatus();
    log('控制面板已加载（右上角）', 'ok');
  }

  /** 诊断：不点击任何东西，只报告识别结果；并把结果复制到剪贴板 */
  function runDiagnostics() {
    const lines = [];
    const add = (msg, type) => { lines.push(msg); log(msg, type || 'info'); };

    add('========== 诊断开始 ==========');
    add(`页面：${location.href}`);

    // ---- 1. 列表容器 ----
    const container = findContainer();
    add(`列表容器：${container ? container.className : '未识别到（退化为全页查找）'}`, container ? 'ok' : 'warn');

    // ---- 2. 分页情况（关键：判断是分页还是无限滚动）----
    const nextBtn = findNextPageButton();
    add(`分页：${nextBtn ? '识别到「下一页」按钮 → ' + nextBtn.tagName.toLowerCase() + '.' + nextBtn.className : '未识别到「下一页」按钮'}`, nextBtn ? 'ok' : 'warn');
    const pagerText = (() => {
      const p = document.querySelector('.vui_pagenation, [class*="pagenation"], [class*="pagination"]');
      return p ? textOf(p).slice(0, 60) : null;
    })();
    add(`页码条文字：${pagerText || '(未找到页码条)'}`, 'dim');

    // ---- 3. 滚动容器 ----
    const cands = scrollCandidates();
    add(`可滚动容器 ${cands.length} 个：`, 'dim');
    cands.slice(0, 6).forEach((el) => {
      const name = el === document.body ? 'body'
        : el === document.documentElement ? 'html'
        : (el.className ? el.tagName.toLowerCase() + '.' + String(el.className).split(/\s+/)[0] : el.tagName.toLowerCase());
      add(`   ${name}  scrollTop=${Math.round(scrollTopOf(el))}  内容高=${el.scrollHeight}  可视高=${el.clientHeight}`, 'dim');
    });
    const sc = document.scrollingElement || document.documentElement;
    const screens = sc.clientHeight ? (sc.scrollHeight / sc.clientHeight).toFixed(1) : '?';
    add(`整页高度约 ${screens} 屏 ${Number(screens) > 3 ? '（可能有虚拟滚动）' : '（内容不多，更可能是分页）'}`, 'dim');

    // ---- 4. 触发器 ----
    const targets = findTriggers();
    add(`识别到「已关注」触发器：${targets.length} 个`, targets.length ? 'ok' : 'err');
    targets.slice(0, 3).forEach((t, i) => {
      add(`   #${i + 1} <${t.trigger.tagName.toLowerCase()} class="${t.trigger.className}"> 文字="${textOf(t.trigger)}"`, 'dim');
    });
    if (targets.length === 0) {
      add('⚠️ 一个都没识别到，脚本无法工作。', 'err');
    }

    // ---- 5. 菜单项 ----
    const menu = findMenuItem();
    add(`当前可见「取消关注」菜单项：${menu ? '是 → ' + textOf(menu) : '否（正常，需先点开触发器）'}`, 'dim');

    add('========== 诊断结束 ==========');

    // 复制到剪贴板，方便直接反馈
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => {
          log('诊断结果已复制到剪贴板，可直接 Ctrl+V 粘贴', 'ok');
          if (statusEl) {
            statusEl.textContent = '诊断完成，结果已复制到剪贴板';
            statusEl.style.color = '#2ecc71';
          }
        })
        .catch(() => log('复制到剪贴板失败（可在 F12 控制台里手动复制）', 'warn'));
    } else {
      log('浏览器不支持自动复制，请在 F12 控制台里复制上面的输出', 'warn');
    }
  }

  /* ======================== 启动 ======================== */
  function boot() {
    buildUI();

    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        if (/relation\/follow/i.test(lastPath)) {
          log('检测到已进入关注列表页', 'ok');
          buildUI();
        }
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
