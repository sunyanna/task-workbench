/* =========================================================
   日程工作台 · Personal Task Workbench
   纯前端 / 数据存本地 / 支持 PWA 离线
   ========================================================= */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  const STORE_KEY = 'ptw.state.v1';
  const CATS = {
    work:   { name: '工作', color: '#3b82f6' },
    health: { name: '健康', color: '#10b981' },
    life:   { name: '生活', color: '#f59e0b' },
    study:  { name: '学习', color: '#8b5cf6' }
  };
  const CAT_KEYS = ['work', 'health', 'life', 'study'];
  const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /* ---------- 日期工具 ---------- */
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12, 0, 0); };
  const todayStr = () => ymd(new Date());
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
  function mondayOf(s) { const d = parseYmd(s); const off = (d.getDay() + 6) % 7; return addDays(s, -off); }
  function rangeDays(a, b) { const out = []; let c = a; let guard = 0; while (c <= b && guard++ < 400) { out.push(c); c = addDays(c, 1); } return out; }
  function diffDays(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000); }

  /* ---------- 状态 ---------- */
  const DEFAULT_ROUTINES = [
    { title: '晨间 15 分钟规划当日重点', cat: 'work',   type: 'daily' },
    { title: '下班前复盘 + 明日待办',    cat: 'work',   type: 'daily' },
    { title: '喝水 1500ml',              cat: 'health', type: 'daily' },
    { title: '运动 30 分钟',             cat: 'health', type: 'weekly', days: [1, 3, 5] },
    { title: '23:30 前睡觉',             cat: 'health', type: 'daily' },
    { title: '整理桌面 / 房间 10 分钟',  cat: 'life',   type: 'daily' },
    { title: '给家人发条消息',           cat: 'life',   type: 'weekly', days: [0, 6] },
    { title: '阅读 30 分钟',             cat: 'study',  type: 'daily' },
    { title: '本周学习复盘',             cat: 'study',  type: 'weekly', days: [0] }
  ];

  function seedState() {
    const t = todayStr();
    return {
      version: 1,
      routines: DEFAULT_ROUTINES.map((r, i) => ({
        id: 'r' + (Date.now() + i),
        title: r.title,
        cat: r.cat,
        repeat: { type: r.type, days: r.days || [], dates: r.dates || [], every: r.every || 2, startDate: t },
        createdDate: t,
        archived: false
      })),
      tasks: {},
      checks: {},
      dueTimes: {},
      notes: {},
      settings: { endpoint: '', key: '', model: 'gpt-4o-mini' }
    };
  }

  let state;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    state = raw ? JSON.parse(raw) : seedState();
  } catch (e) { state = seedState(); }
  if (!state.routines) state = seedState();
  state.tasks = state.tasks || {};
  state.checks = state.checks || {};
  state.dueTimes = state.dueTimes || {};
  state.notes = state.notes || {};
  // 旧版笔记是 date->string（整体记录），统一为 date->{板块: 文本}
  Object.keys(state.notes).forEach(ds => {
    if (typeof state.notes[ds] === 'string') {
      const v = state.notes[ds].trim();
      state.notes[ds] = v ? { work: v } : {};
    }
  });
  state.settings = state.settings || { endpoint: '', key: '', model: 'gpt-4o-mini' };

  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { toast('存储失败，可能是空间已满'); } };
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  /* ---------- 视图状态 ---------- */
  let selDate = todayStr();
  let calCursor = { y: new Date().getFullYear(), m: new Date().getMonth() };
  let catFilter = 'all';
  let reportType = 'day';
  let reportCats = CAT_KEYS.slice();
  let lastReportMd = '';

  /* ---------- DOM ---------- */
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  /* =========================================================
     常规规则判断
     ========================================================= */
  function routineActiveOn(r, dateStr) {
    if (r.archived) return false;
    if (r.createdDate && dateStr < r.createdDate) return false;
    const d = parseYmd(dateStr);
    const rp = r.repeat || {};
    switch (rp.type) {
      case 'daily': return true;
      case 'weekly': return (rp.days || []).includes(d.getDay());
      case 'monthly': {
        const list = rp.dates || [];
        if (list.includes(d.getDate())) return true;
        // 例如「每月 31 号」，遇到小月就落在当月最后一天
        const last = daysInMonth(d.getFullYear(), d.getMonth());
        return d.getDate() === last && list.some(n => n > last);
      }
      case 'interval': {
        const base = rp.startDate || r.createdDate;
        const n = Math.max(2, Number(rp.every) || 2);
        const diff = diffDays(base, dateStr);
        return diff >= 0 && diff % n === 0;
      }
      default: return false;
    }
  }

  function repeatText(r) {
    const rp = r.repeat || {};
    if (rp.type === 'daily') return '每天';
    if (rp.type === 'weekly') {
      const ds = (rp.days || []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      return ds.length ? '每' + ds.map(d => WEEK_CN[d].replace('周', '周')).join('、') : '每周（未选日）';
    }
    if (rp.type === 'monthly') return '每月 ' + (rp.dates || []).join('、') + ' 号';
    if (rp.type === 'interval') return `每隔 ${rp.every} 天`;
    return '';
  }

  /* 某天的全部条目（常规 + 临时任务） */
  function itemsOf(dateStr) {
    const checks = state.checks[dateStr] || {};
    const rs = state.routines
      .filter(r => routineActiveOn(r, dateStr))
      .map(r => ({ id: r.id, title: r.title, cat: r.cat, kind: 'routine', done: !!checks[r.id] }));
    const ts = (state.tasks[dateStr] || [])
      .map(t => ({ id: t.id, title: t.title, cat: t.cat, kind: 'task', done: !!t.done, from: t.from, series: t.series, end: t.end }));
    return rs.concat(ts);
  }

  function statsOf(dateStr, cats) {
    const keys = cats && cats.length ? cats : CAT_KEYS;
    const items = itemsOf(dateStr).filter(i => keys.includes(i.cat));
    const by = {};
    CAT_KEYS.forEach(c => (by[c] = { total: 0, done: 0 }));
    items.forEach(i => { by[i.cat].total++; if (i.done) by[i.cat].done++; });
    const total = items.length;
    const done = items.filter(i => i.done).length;
    return { total, done, rate: total ? done / total : 0, by, items };
  }

  /* 任务的目标完成时间（仅当日视图使用） */
  function dueOf(item) {
    if (item.kind === 'task') {
      const t = (state.tasks[selDate] || []).find(x => x.id === item.id);
      return t ? t.due : undefined;
    }
    const m = state.dueTimes ? state.dueTimes[selDate] : undefined;
    return m ? m[item.id] : undefined;
  }
  function setDue(item, time) {
    if (item.kind === 'task') {
      const t = (state.tasks[selDate] || []).find(x => x.id === item.id);
      if (t) { if (time) t.due = time; else delete t.due; }
    } else {
      state.dueTimes = state.dueTimes || {};
      state.dueTimes[selDate] = state.dueTimes[selDate] || {};
      if (time) state.dueTimes[selDate][item.id] = time;
      else delete state.dueTimes[selDate][item.id];
    }
  }
  /* 某天某板块的记录文本 */
  function noteOf(dateStr, cat) {
    const m = state.notes ? state.notes[dateStr] : undefined;
    return m && m[cat] ? m[cat] : '';
  }
  /* 取消某系列任务从指定日期起的所有重复（保留之前的） */
  function truncateSeries(seriesId, fromDate) {
    if (!seriesId) return;
    let cnt = 0;
    Object.keys(state.tasks).forEach(ds => {
      if (ds < fromDate) return;
      let changed = false;
      state.tasks[ds] = (state.tasks[ds] || []).filter(t => {
        if (t.series === seriesId) { cnt++; changed = true; return false; }
        return true;
      });
      if (changed && !state.tasks[ds].length) delete state.tasks[ds];
    });
    save(); renderDay(); renderCalendar();
    toast(`已取消后续 ${cnt} 条重复`);
  }

  /* 行内编辑任务文案 */
  function startEdit(item, titleEl) {
    if (!titleEl || !titleEl.parentNode) return;
    const cur = item.title;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'item-edit-input';
    input.value = cur;
    input.maxLength = 120;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const commit = (doSave) => {
      if (finished) return;
      finished = true;
      if (doSave) {
        const v = input.value.trim();
        if (v && v !== cur) {
          if (item.kind === 'task') {
            const t = (state.tasks[selDate] || []).find(x => x.id === item.id);
            if (t) t.title = v;
          } else {
            const r = state.routines.find(x => x.id === item.id);
            if (r) r.title = v;
          }
          save(); renderDay(); renderCalendar();
          return;
        }
      }
      renderDay();   // 还原（未改或按 Esc）
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
  }
  /* 把一条当日任务顺延到目标日期（从今天移除，加到目标日，保留板块/时间/顺延来源） */
  function snoozeTo(item, targetDate) {
    if (targetDate === selDate) { toast('已经在这一天了'); return; }
    const list = state.tasks[selDate] || [];
    const t = list.find(x => x.id === item.id);
    if (!t) return;
    const moved = { id: uid(), title: t.title, cat: t.cat, done: false };
    if (t.due) moved.due = t.due;
    moved.from = selDate;
    state.tasks[targetDate] = state.tasks[targetDate] || [];
    state.tasks[targetDate].push(moved);
    state.tasks[selDate] = list.filter(x => x.id !== item.id);
    save();
    renderDay(); renderCalendar();
    toast(`已顺延到 ${targetDate.slice(5).replace('-', '/')}`);
  }

  /* 常规连续天数 */
  function streakOf(routineId, endDate) {
    const r = state.routines.find(x => x.id === routineId);
    if (!r) return 0;
    let n = 0, cur = endDate, guard = 0;
    while (guard++ < 400) {
      if (cur < (r.createdDate || '0000-00-00')) break;
      if (routineActiveOn(r, cur)) {
        const ck = state.checks[cur] || {};
        if (ck[routineId]) n++; else break;
      }
      cur = addDays(cur, -1);
    }
    return n;
  }

  /* =========================================================
     渲染：日历
     ========================================================= */
  function renderCalendar() {
    const { y, m } = calCursor;
    $('#calTitle').textContent = `${y} 年 ${m + 1} 月`;

    const first = new Date(y, m, 1);
    const startOff = (first.getDay() + 6) % 7;      // 周一开头
    const start = addDays(ymd(first), -startOff);
    const total = 42;
    const today = todayStr();

    const frag = document.createDocumentFragment();
    for (let i = 0; i < total; i++) {
      const ds = addDays(start, i);
      const d = parseYmd(ds);
      const out = d.getMonth() !== m;
      const st = statsOf(ds);

      const cell = document.createElement('button');
      cell.className = 'cell' + (out ? ' out' : '') + (ds === today ? ' today' : '') + (ds === selDate ? ' sel' : '');
      cell.dataset.date = ds;

      const top = document.createElement('div');
      top.className = 'cell-top';
      const num = document.createElement('span');
      num.className = 'dnum';
      num.textContent = d.getDate();
      top.appendChild(num);
      if (st.total) {
        const rate = document.createElement('span');
        rate.className = 'rate' + (st.done === st.total ? ' full' : '');
        rate.textContent = st.done === st.total ? '✓' : `${st.done}/${st.total}`;
        top.appendChild(rate);
      }
      cell.appendChild(top);

      const nd = state.notes[ds];
      const hasNote = nd && (typeof nd === 'string' ? nd.trim() : Object.values(nd).some(Boolean));
      if (hasNote) {
        const dot = document.createElement('i');
        dot.className = 'dot-note';
        cell.appendChild(dot);
      }

      const bars = document.createElement('div');
      bars.className = 'bars';
      CAT_KEYS.forEach(c => {
        if (!st.by[c].total) return;
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.dataset.c = c;
        const fill = document.createElement('i');
        fill.style.width = (st.by[c].done / st.by[c].total * 100) + '%';
        bar.appendChild(fill);
        bars.appendChild(bar);
      });
      cell.appendChild(bars);
      frag.appendChild(cell);
    }
    const grid = $('#calGrid');
    grid.innerHTML = '';
    grid.appendChild(frag);

    renderMonthStats();
  }

  function renderMonthStats() {
    const { y, m } = calCursor;
    const last = daysInMonth(y, m);
    const today = todayStr();
    let total = 0, done = 0, perfect = 0, activeDays = 0;
    const catAgg = {}; CAT_KEYS.forEach(c => (catAgg[c] = { t: 0, d: 0 }));

    for (let i = 1; i <= last; i++) {
      const ds = `${y}-${pad(m + 1)}-${pad(i)}`;
      if (ds > today) continue;                       // 未来不计入
      const st = statsOf(ds);
      if (!st.total) continue;
      activeDays++;
      total += st.total; done += st.done;
      if (st.done === st.total) perfect++;
      CAT_KEYS.forEach(c => { catAgg[c].t += st.by[c].total; catAgg[c].d += st.by[c].done; });
    }
    const rate = total ? Math.round(done / total * 100) : 0;
    let best = '—', bestRate = -1;
    CAT_KEYS.forEach(c => {
      if (!catAgg[c].t) return;
      const r = catAgg[c].d / catAgg[c].t;
      if (r > bestRate) { bestRate = r; best = CATS[c].name; }
    });

    $('#monthStats').innerHTML = [
      { b: rate + '%', s: '本月完成率' },
      { b: done, s: '已完成条目' },
      { b: perfect + ' 天', s: '全清天数' },
      { b: best, s: '最稳板块' }
    ].map(x => `<div class="ms-card"><b>${x.b}</b><span>${x.s}</span></div>`).join('');
  }

  /* =========================================================
     渲染：当日清单
     ========================================================= */
  function renderDay() {
    const d = parseYmd(selDate);
    const today = todayStr();
    let rel = '';
    if (selDate === today) rel = '今天';
    else if (selDate === addDays(today, -1)) rel = '昨天';
    else if (selDate === addDays(today, 1)) rel = '明天';

    $('#dayTitle').textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEK_CN[d.getDay()]}`;
    const st = statsOf(selDate);
    $('#daySub').textContent = (rel ? rel + ' · ' : '') + (st.total ? `完成 ${st.done} / ${st.total}` : '今天还没有任何安排');

    // 进度环
    const C = 2 * Math.PI * 18;
    const pct = st.rate;
    const fg = $('#ringFg');
    fg.style.strokeDasharray = C;
    fg.style.strokeDashoffset = C * (1 - pct);
    fg.style.stroke = pct >= 1 ? CATS.health.color : 'var(--brand)';
    $('#ringNum').textContent = Math.round(pct * 100) + '%';

    // 列表
    const wrap = $('#dayList');
    wrap.innerHTML = '';
    const shown = CAT_KEYS.filter(c => catFilter === 'all' || catFilter === c);
    let any = false;

    shown.forEach(c => {
      const list = st.items.filter(i => i.cat === c);
      if (!list.length) return;
      any = true;
      const block = document.createElement('div');
      block.className = 'cat-block';
      block.dataset.c = c;
      const doneN = list.filter(i => i.done).length;
      block.innerHTML = `<div class="cat-head"><span class="tag"></span>${CATS[c].name}<span class="cnt">${doneN}/${list.length}</span></div>`;

      // 按添加/定义顺序渲染，完成后位置不变（不再把已勾选项沉到末尾）
      list.forEach(item => {
        const row = document.createElement('div');
        row.className = 'item' + (item.done ? ' done' : '');
        row.dataset.c = c;

        const cb = document.createElement('button');
        cb.className = 'cb' + (item.done ? ' on' : '');
        cb.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-10"/></svg>';
        cb.addEventListener('click', () => toggleItem(item));
        row.appendChild(cb);

        const main = document.createElement('div');
        main.className = 'item-main';
        const t = document.createElement('div');
        t.className = 'item-title';
        t.textContent = item.title;
        t.title = '双击修改文案';
        t.addEventListener('dblclick', () => startEdit(item, t));
        main.appendChild(t);

        const meta = document.createElement('div');
        meta.className = 'item-meta';
        if (item.kind === 'routine') {
          const r = state.routines.find(x => x.id === item.id);
          const b = document.createElement('span');
          b.className = 'badge';
          b.textContent = r ? repeatText(r) : '常规';
          meta.appendChild(b);
          const sk = streakOf(item.id, item.done ? selDate : addDays(selDate, -1));
          if (sk >= 2) {
            const s2 = document.createElement('span');
            s2.className = 'badge streak';
            s2.textContent = `连续 ${sk} 次`;
            meta.appendChild(s2);
          }
        } else {
          const b = document.createElement('span');
          b.className = 'badge';
          b.textContent = '当日任务';
          meta.appendChild(b);
          if (item.from) {
            const f = document.createElement('span');
            f.className = 'badge from';
            f.textContent = `顺延自 ${item.from.slice(5).replace('-', '/')}`;
            meta.appendChild(f);
          }
          if (item.series) {
            const sb = document.createElement('span');
            sb.className = 'badge series';
            sb.textContent = '🔁 多日·至 ' + item.end.slice(5).replace('-', '/');
            meta.appendChild(sb);
          }
        }
        const due = dueOf(item);
        if (due) {
          const dt = document.createElement('span');
          dt.className = 'badge due';
          dt.textContent = '⏰ ' + due;
          meta.appendChild(dt);
        }
        main.appendChild(meta);
        row.appendChild(main);

        // 行内编辑文案
        const ed = document.createElement('button');
        ed.className = 'item-edit';
        ed.title = '修改文案';
        ed.textContent = '✎';
        ed.addEventListener('click', e => { e.stopPropagation(); startEdit(item, t); });
        row.appendChild(ed);

        if (!item.done) {
          const sz = document.createElement('button');
          sz.className = 'item-snooze';
          sz.title = '顺延 / 指定完成时间';
          sz.textContent = '🕘';
          sz.addEventListener('click', e => { e.stopPropagation(); openSnooze(item, sz); });
          row.appendChild(sz);
        }
        if (item.series && !item.done) {
          const tr = document.createElement('button');
          tr.className = 'item-trunc';
          tr.title = '取消该任务后续所有日期';
          tr.textContent = '✂';
          tr.addEventListener('click', e => {
            e.stopPropagation();
            if (confirm(`取消「${item.title}」从 ${selDate.slice(5).replace('-', '/')} 起之后的所有重复？已勾选的日期不受影响。`)) {
              truncateSeries(item.series, selDate);
            }
          });
          row.appendChild(tr);
        }
        if (item.kind === 'task') {
          const del = document.createElement('button');
          del.className = 'item-del';
          del.textContent = '✕';
          del.title = '删除这条';
          del.addEventListener('click', () => {
            state.tasks[selDate] = (state.tasks[selDate] || []).filter(x => x.id !== item.id);
            save(); renderDay(); renderCalendar();
          });
          row.appendChild(del);
        }
        block.appendChild(row);
      });

      // 板块记录：每个板块下一条输入框，写进对应板块的报告
      const note = document.createElement('textarea');
      note.className = 'cat-note';
      note.rows = 3;
      note.placeholder = `${CATS[c].name}记录（会写进报告）`;
      note.value = noteOf(selDate, c);
      note.dataset.cat = c;
      note.addEventListener('input', () => {
        state.notes[selDate] = state.notes[selDate] || {};
        const v = note.value.trim();
        if (v) state.notes[selDate][c] = v; else delete state.notes[selDate][c];
        if (!Object.keys(state.notes[selDate]).length) delete state.notes[selDate];
        save();
      });
      block.appendChild(note);

      wrap.appendChild(block);
    });

    if (!any) {
      wrap.innerHTML = `<div class="empty-day"><b>这一天还是空的</b>去「常规清单」加几条每天要做的事，或在上面直接添加当天任务。</div>`;
    }
  }

  function toggleItem(item) {
    if (item.kind === 'routine') {
      state.checks[selDate] = state.checks[selDate] || {};
      if (state.checks[selDate][item.id]) delete state.checks[selDate][item.id];
      else state.checks[selDate][item.id] = true;
    } else {
      const list = state.tasks[selDate] || [];
      const t = list.find(x => x.id === item.id);
      if (t) t.done = !t.done;
    }
    save();
    renderDay();
    renderCalendar();
  }

  /* 顺延 / 指定时间 弹层 */
  let snoozeItem = null;
  function openSnooze(item, btn) {
    snoozeItem = item;
    const pop = $('#snoozePop');
    const isTask = item.kind === 'task';
    $('#spQuick').hidden = !isTask;          // 常规会每天自动出现，无需顺延日期
    $('#spPick').hidden = true;
    $('#spDate').value = addDays(selDate, 1);
    $('#spTimeInput').value = dueOf(item) || '';
    // 定位到按钮附近
    const r = btn.getBoundingClientRect();
    pop.hidden = false;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.left + window.scrollX;
    let top = r.bottom + window.scrollY + 6;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight + window.scrollY - 8) top = r.top + window.scrollY - ph - 6;
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
  }
  function closeSnooze() { $('#snoozePop').hidden = true; snoozeItem = null; }
  $('#snoozePop').addEventListener('click', e => {
    const act = e.target.dataset.act;
    if (!act || !snoozeItem) return;
    e.stopPropagation();
    if (act === 'tomorrow') { snoozeTo(snoozeItem, addDays(selDate, 1)); closeSnooze(); }
    else if (act === 'dayafter') { snoozeTo(snoozeItem, addDays(selDate, 2)); closeSnooze(); }
    else if (act === 'pick') { $('#spPick').hidden = false; $('#spDate').focus(); }
    else if (act === 'confirmPick') {
      const v = $('#spDate').value;
      if (!v) { toast('请选择日期'); return; }
      snoozeTo(snoozeItem, v); closeSnooze();
    }
    else if (act === 'setTime') {
      const v = $('#spTimeInput').value;
      if (!v) { toast('请选择时间'); return; }
      setDue(snoozeItem, v); save(); renderDay(); closeSnooze();
      toast('已设定完成时间 ' + v);
    }
    else if (act === 'clearTime') { setDue(snoozeItem, ''); save(); renderDay(); closeSnooze(); }
  });
  $('#spCancel').addEventListener('click', closeSnooze);
  document.addEventListener('click', e => {
    if ($('#snoozePop').hidden) return;
    if (!e.target.closest('#snoozePop') && !e.target.closest('.item-snooze')) closeSnooze();
  });
  window.addEventListener('scroll', () => { if (!$('#snoozePop').hidden) closeSnooze(); }, true);

  /* =========================================================
     渲染：常规清单管理
     ========================================================= */
  function renderRoutineList() {
    const wrap = $('#routineList');
    wrap.innerHTML = '';
    if (!state.routines.length) {
      wrap.innerHTML = '<div class="empty-day">还没有常规，先在上面加一条吧。</div>';
      return;
    }
    const order = { work: 0, health: 1, life: 2, study: 3 };
    state.routines.slice().sort((a, b) => (order[a.cat] - order[b.cat]) || a.title.localeCompare(b.title, 'zh')).forEach(r => {
      const el = document.createElement('div');
      el.className = 'r-item' + (r.archived ? ' off' : '');
      el.dataset.c = r.cat;
      const sk = streakOf(r.id, todayStr());
      el.innerHTML = `
        <span class="rtag"></span>
        <div class="r-main">
          <b>${escapeHtml(r.title)}</b>
          <small>${CATS[r.cat].name} · ${repeatText(r)}${sk >= 2 ? ' · 连续 ' + sk + ' 次' : ''}${r.archived ? ' · 已停用' : ''}</small>
        </div>
        <div class="r-acts">
          <button data-act="edit">编辑</button>
          <button data-act="toggle">${r.archived ? '启用' : '停用'}</button>
          <button data-act="del" class="del">删除</button>
        </div>`;
      el.querySelector('[data-act="edit"]').addEventListener('click', () => fillRoutineForm(r));
      el.querySelector('[data-act="toggle"]').addEventListener('click', () => {
        r.archived = !r.archived; save(); renderRoutineList(); renderDay(); renderCalendar();
      });
      el.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm(`删除常规「${r.title}」？历史勾选记录会一并失效。`)) return;
        state.routines = state.routines.filter(x => x.id !== r.id);
        save(); renderRoutineList(); renderDay(); renderCalendar();
      });
      wrap.appendChild(el);
    });
  }

  function fillRoutineForm(r) {
    $('#rId').value = r.id;
    $('#rTitle').value = r.title;
    $('#rCat').value = r.cat;
    $('#rType').value = r.repeat.type;
    $$('#rWeekly input').forEach(cb => { cb.checked = (r.repeat.days || []).includes(Number(cb.value)); });
    $('#rDates').value = (r.repeat.dates || []).join(',');
    $('#rEvery').value = r.repeat.every || 2;
    $('#rStart').value = r.repeat.startDate || todayStr();
    $('#rSubmit').textContent = '保存修改';
    $('#rCancel').hidden = false;
    syncRepeatFields();
    $('#rTitle').focus();
  }

  function resetRoutineForm() {
    $('#rId').value = '';
    $('#rTitle').value = '';
    $('#rCat').value = 'work';
    $('#rType').value = 'daily';
    $$('#rWeekly input').forEach(cb => (cb.checked = false));
    $('#rDates').value = '';
    $('#rEvery').value = 2;
    $('#rStart').value = todayStr();
    $('#rSubmit').textContent = '添加常规';
    $('#rCancel').hidden = true;
    syncRepeatFields();
  }

  function syncRepeatFields() {
    const t = $('#rType').value;
    $('#rWeekly').hidden = t !== 'weekly';
    $('#rMonthly').hidden = t !== 'monthly';
    $('#rInterval').hidden = t !== 'interval';
  }

  /* =========================================================
     报告
     ========================================================= */
  function reportRange(type) {
    if (type === 'day') {
      const ds = $('#repDay').value || selDate;
      return { start: ds, end: ds, label: ds.replace(/-/g, '/') + ' ' + WEEK_CN[parseYmd(ds).getDay()] };
    }
    if (type === 'week') {
      const ds = $('#repWeekDay').value || selDate;
      const s = mondayOf(ds), e = addDays(s, 6);
      return { start: s, end: e, label: `${s.slice(5).replace('-', '/')} ~ ${e.slice(5).replace('-', '/')}` };
    }
    if (type === 'month') {
      const m = $('#repMonth').value || selDate.slice(0, 7);
      const d = parseYmd(m + '-01');
      const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
      const e = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(daysInMonth(d.getFullYear(), d.getMonth()))}`;
      return { start: s, end: e, label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月` };
    }
    // custom
    let s = $('#repStart').value, e = $('#repEnd').value;
    if (!s || !e) return { start: selDate, end: selDate, label: '请选择起止日期' };
    if (s > e) [s, e] = [e, s];                 // 允许倒着选
    const days = Math.round((parseYmd(e) - parseYmd(s)) / 86400000) + 1;
    const L = `${s.slice(5).replace('-', '/')} ~ ${e.slice(5).replace('-', '/')}`;
    return { start: s, end: e, label: days === 1 ? `${L} ${WEEK_CN[parseYmd(s).getDay()]}` : `${L}（${days} 天）` };
  }

  function collect(type) {
    const { start, end, label } = reportRange(type);
    const today = todayStr();
    const AC = reportCats.length ? reportCats : CAT_KEYS;   // 选中的板块
    const days = rangeDays(start, end)
      .filter(ds => ds <= today)
      .map(ds => {
        const dayNotes = {};
        AC.forEach(c => { const t = noteOf(ds, c); if (t) dayNotes[c] = t; });
        return { ds, st: statsOf(ds, AC), dayNotes };
      })
      .filter(x => x.st.total || Object.keys(x.dayNotes).length);

    const by = {}; CAT_KEYS.forEach(c => (by[c] = { total: 0, done: 0, doneList: [], missList: {} }));
    let total = 0, done = 0, perfect = 0;
    days.forEach(({ ds, st }) => {
      total += st.total; done += st.done;
      if (st.total && st.done === st.total) perfect++;
      st.items.forEach(i => {
        by[i.cat].total++;
        if (i.done) { by[i.cat].done++; by[i.cat].doneList.push({ title: i.title, ds }); }
        else { by[i.cat].missList[i.title] = (by[i.cat].missList[i.title] || 0) + 1; }
      });
    });

    // 常规坚持度
    const rstat = state.routines.filter(r => !r.archived && AC.includes(r.cat)).map(r => {
      let ap = 0, ok = 0;
      rangeDays(start, end).forEach(ds => {
        if (ds > today) return;
        if (!routineActiveOn(r, ds)) return;
        ap++;
        if ((state.checks[ds] || {})[r.id]) ok++;
      });
      return { title: r.title, cat: r.cat, applicable: ap, done: ok, rate: ap ? ok / ap : 0, streak: streakOf(r.id, today) };
    }).filter(x => x.applicable > 0);

    return { type, label, start, end, days, by, total, done, perfect, rate: total ? done / total : 0, rstat, cats: AC };
  }

  function bar10(rate) {
    const n = Math.round(rate * 10);
    return '█'.repeat(n) + '░'.repeat(10 - n);
  }

  function buildMarkdown(type) {
    const d = collect(type);
    const AC = d.cats;
    const partial = AC.length < CAT_KEYS.length;
    const title = type === 'day' ? '日报' : type === 'week' ? '周报' : type === 'month' ? '月报' : '区间报告';
    const L = [];
    L.push(`# ${title} · ${d.label}`);
    if (partial) {
      L.push('');
      L.push(`> 本报告仅统计：${AC.map(c => CATS[c].name).join(' / ')}`);
    }

    if (!d.total) {
      L.push('');
      L.push(partial
        ? `所选板块（${AC.map(c => CATS[c].name).join('、')}）在这段时间还没有记录。换个板块或时间范围试试。`
        : '这段时间还没有任何记录。先去日历里勾几条，再回来生成报告。');
      return L.join('\n');
    }

    L.push('');
    L.push(`**总体完成 ${d.done}/${d.total} · 完成率 ${Math.round(d.rate * 100)}%**${type !== 'day' ? ` · 全清 ${d.perfect} 天 / 有记录 ${d.days.length} 天` : ''}`);
    L.push('');
    L.push('---');

    /* 板块概览 */
    L.push('');
    L.push(AC.length === 1 ? '## 概览' : '## 板块概览');
    AC.forEach(c => {
      const b = d.by[c];
      if (!b.total) return;
      L.push(`- **${CATS[c].name}** \`${bar10(b.done / b.total)}\` ${b.done}/${b.total} · ${Math.round(b.done / b.total * 100)}%`);
    });

    /* 明细 */
    if (type === 'day') {
      const day = d.days[0];
      AC.forEach(c => {
        const list = day ? day.st.items.filter(i => i.cat === c) : [];
        const nt = day && day.dayNotes[c];
        if (!list.length && !nt) return;
        L.push('');
        L.push(AC.length > 1 ? `### ${CATS[c].name}` : '### 清单明细');
        list.forEach(i => L.push(`- ${i.done ? '✅' : '⬜'} ${i.title}`));
        if (nt) L.push(`- 📝 ${nt.replace(/\n+/g, ' / ')}`);
      });
    } else {
      L.push('');
      L.push('## 每日节奏');
      d.days.filter(x => x.st.total).forEach(({ ds, st }) => {
        const dd = parseYmd(ds);
        L.push(`- ${ds.slice(5)} ${WEEK_CN[dd.getDay()]} \`${bar10(st.rate)}\` ${st.done}/${st.total}${st.done === st.total ? ' 🎯' : ''}`);
      });

      if (d.rstat.length) {
        L.push('');
        L.push('## 常规坚持度');
        d.rstat.slice().sort((a, b) => b.rate - a.rate).forEach(r => {
          L.push(`- ${AC.length > 1 ? `[${CATS[r.cat].name}] ` : ''}**${r.title}** ${r.done}/${r.applicable} 次 · ${Math.round(r.rate * 100)}%${r.streak >= 3 ? ` · 当前连续 ${r.streak} 次` : ''}`);
        });
      }

      /* 完成的重点任务（临时任务更能体现产出） */
      const tasks = [];
      d.days.forEach(({ ds }) => (state.tasks[ds] || []).forEach(t => {
        if (t.done && AC.includes(t.cat)) tasks.push({ ...t, ds });
      }));
      if (tasks.length) {
        L.push('');
        L.push('## 本期完成的具体事项');
        AC.forEach(c => {
          const list = tasks.filter(t => t.cat === c);
          if (!list.length) return;
          if (AC.length > 1) L.push(`### ${CATS[c].name}`);
          list.forEach(t => L.push(`- ${t.title} \`${t.ds.slice(5)}\``));
        });
      }
    }

    /* 板块记录（逐板块；日报已在各板块明细里呈现，这里只在周/月汇总） */
    if (type !== 'day') {
      const allNotes = [];
      d.days.forEach(({ ds, dayNotes }) => AC.forEach(c => { if (dayNotes[c]) allNotes.push({ c, ds, text: dayNotes[c] }); }));
      if (allNotes.length) {
        L.push('');
        L.push('## 板块记录');
        AC.forEach(c => {
          const list = allNotes.filter(n => n.c === c);
          if (!list.length) return;
          if (AC.length > 1) L.push(`### ${CATS[c].name}`);
          list.forEach(n => L.push(`- **${n.ds.slice(5)}**：${n.text.replace(/\n+/g, ' / ')}`));
        });
      }
    }

    /* 洞察 */
    L.push('');
    L.push('## 小结与建议');
    L.push(...insights(d, type));

    L.push('');
    L.push('---');
    L.push(`*由日程工作台于 ${new Date().toLocaleString('zh-CN', { hour12: false })} 生成*`);
    return L.join('\n');
  }

  function insights(d, type) {
    const out = [];
    const cats = (d.cats || CAT_KEYS).filter(c => d.by[c].total).map(c => ({ c, r: d.by[c].done / d.by[c].total, ...d.by[c] }));
    if (!cats.length) return ['- 暂无足够数据。'];
    cats.sort((a, b) => b.r - a.r);
    const top = cats[0], bottom = cats[cats.length - 1];

    if (d.rate >= 0.9) out.push(`- 整体完成率 ${Math.round(d.rate * 100)}%，执行力非常稳；可以考虑给清单加一点难度或新目标。`);
    else if (d.rate >= 0.7) out.push(`- 整体完成率 ${Math.round(d.rate * 100)}%，属于健康区间，主要问题是尾部漏项而不是节奏。`);
    else if (d.rate >= 0.4) out.push(`- 整体完成率 ${Math.round(d.rate * 100)}%，清单可能定得偏多，建议砍掉 2~3 条非核心常规。`);
    else out.push(`- 整体完成率 ${Math.round(d.rate * 100)}%，先别加任务了，把清单缩到每天 3 件必做，重新建立节奏。`);

    if (cats.length > 1 && top.r - bottom.r > 0.2) {
      out.push(`- **${CATS[top.c].name}** 完成得最好（${Math.round(top.r * 100)}%），**${CATS[bottom.c].name}** 最弱（${Math.round(bottom.r * 100)}%），下一阶段重点补 ${CATS[bottom.c].name}。`);
    }

    // 最常漏掉的条目
    const miss = [];
    (d.cats || CAT_KEYS).forEach(c => Object.entries(d.by[c].missList || {}).forEach(([t, n]) => miss.push({ t, n, c })));
    miss.sort((a, b) => b.n - a.n);
    if (miss.length && miss[0].n >= (type === 'day' ? 1 : 2)) {
      const m = miss.slice(0, 3).map(x => `「${x.t}」${x.n > 1 ? '×' + x.n : ''}`).join('、');
      out.push(`- 最常漏掉的是 ${m}，要么换个时间点绑定，要么直接降低标准。`);
    }

    if (type !== 'day') {
      if (d.perfect >= 3) out.push(`- 本期有 ${d.perfect} 天全部完成，说明「全清」是做得到的，可以把它当成节奏基准。`);
      const best = d.days.slice().sort((a, b) => b.st.rate - a.st.rate)[0];
      const worst = d.days.slice().filter(x => x.st.total).sort((a, b) => a.st.rate - b.st.rate)[0];
      if (best && worst && best.ds !== worst.ds) {
        out.push(`- 状态最好的一天是 ${best.ds.slice(5)}（${Math.round(best.st.rate * 100)}%），最差是 ${worst.ds.slice(5)}（${Math.round(worst.st.rate * 100)}%）。`);
      }
      const strong = d.rstat.filter(r => r.streak >= 5).slice(0, 3);
      if (strong.length) out.push(`- 已经形成习惯的是：${strong.map(r => `${r.title}（连续 ${r.streak} 次）`).join('、')}。`);
    }
    return out;
  }

  /* AI 润色 */
  async function aiPolish(md, type) {
    const s = state.settings;
    if (!s.endpoint || !s.key) throw new Error('还没配置接口地址和 API Key，先去右上角设置里填一下。');
    const name = type === 'day' ? '日报' : type === 'week' ? '周报' : type === 'month' ? '月报' : '区间报告';
    const scope = reportCats.length && reportCats.length < CAT_KEYS.length
      ? `本次只汇报「${reportCats.map(c => CATS[c].name).join('、')}」板块，绝对不要提及其他板块的内容。`
      : '';
    const body = {
      model: s.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: '你是一位善于写工作总结的资深助理。基于用户提供的结构化打卡数据，写一份真实、克制、有洞察的中文' + name + '。要求：使用 Markdown；保留数据事实不要编造；语气自然像本人写的，不要空话套话；结尾给出 2~3 条具体可执行的改进建议。' + scope },
        { role: 'user', content: '以下是我这段时间的任务打卡原始汇总，请据此写成' + name + '：\n\n' + md }
      ],
      temperature: 0.6
    };
    const res = await fetch(s.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.key },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('接口返回 ' + res.status + '：' + (await res.text()).slice(0, 160));
    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content;
    if (!txt) throw new Error('接口没有返回内容');
    return txt;
  }

  /* =========================================================
     极简 Markdown 渲染
     ========================================================= */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function inlineMd(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }
  function mdToHtml(md) {
    const lines = md.split('\n');
    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    lines.forEach(raw => {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { closeList(); return; }
      if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr/>'); return; }
      let m;
      if ((m = line.match(/^###\s+(.*)$/))) { closeList(); out.push('<h3>' + inlineMd(m[1]) + '</h3>'); return; }
      if ((m = line.match(/^##\s+(.*)$/)))  { closeList(); out.push('<h2>' + inlineMd(m[1]) + '</h2>'); return; }
      if ((m = line.match(/^#\s+(.*)$/)))   { closeList(); out.push('<h1>' + inlineMd(m[1]) + '</h1>'); return; }
      if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inlineMd(m[1]) + '</li>');
        return;
      }
      closeList();
      out.push('<p>' + inlineMd(line) + '</p>');
    });
    closeList();
    return out.join('');
  }

  /* =========================================================
     交互绑定
     ========================================================= */
  function openModal(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal(el) { el.hidden = true; document.body.style.overflow = ''; }
  $$('.modal').forEach(mo => {
    mo.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(mo)));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $$('.modal').forEach(m => { if (!m.hidden) closeModal(m); });
  });

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2200);
  }

  /* 日历导航 */
  $('#prevMonth').addEventListener('click', () => {
    calCursor.m--; if (calCursor.m < 0) { calCursor.m = 11; calCursor.y--; } renderCalendar();
  });
  $('#nextMonth').addEventListener('click', () => {
    calCursor.m++; if (calCursor.m > 11) { calCursor.m = 0; calCursor.y++; } renderCalendar();
  });
  $('#btnToday').addEventListener('click', () => {
    selDate = todayStr();
    const d = new Date(); calCursor = { y: d.getFullYear(), m: d.getMonth() };
    renderCalendar(); renderDay();
  });
  $('#calGrid').addEventListener('click', e => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    selDate = cell.dataset.date;
    const d = parseYmd(selDate);
    if (d.getMonth() !== calCursor.m || d.getFullYear() !== calCursor.y) {
      calCursor = { y: d.getFullYear(), m: d.getMonth() };
    }
    renderCalendar(); renderDay();
    if (window.matchMedia('(max-width:768px)').matches) setView('day');
  });

  /* 分类筛选 */
  $('#catChips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    catFilter = chip.dataset.cat;
    $$('#catChips .chip').forEach(c => c.classList.toggle('active', c === chip));
    renderDay();
  });

  /* 切换时间范围时切换第二行：自定义显示起止日期 */
  $('#addRange').addEventListener('change', () => {
    const custom = $('#addRange').value === 'custom';
    $('#addRow2').hidden = !custom;
    if (custom) {
      if (!$('#addRangeStart').value) $('#addRangeStart').value = selDate;
      if (!$('#addRangeEnd').value) $('#addRangeEnd').value = addDays(selDate, 1);
    }
  });

  /* 添加任务（支持长期需求：发布到一段时间内的每一天） */
  $('#addForm').addEventListener('submit', e => {
    e.preventDefault();
    const title = $('#addTitle').value.trim();
    if (!title) return;
    const cat = $('#addCat').value;
    let end = selDate;
    const rangeSel = $('#addRange').value;
    if (rangeSel === 'custom') {
      const s = $('#addRangeStart').value;
      const v = $('#addRangeEnd').value;
      if (!s || !v) { toast('请选择起止日期'); return; }
      end = v < s ? s : v;       // 不允许早于起始日
    } else {
      const n = Number(rangeSel) || 1;
      if (n > 1) end = addDays(selDate, n - 1);
    }
    const days = rangeDays(selDate, end);
    const series = days.length > 1 ? uid() : null;
    days.forEach(ds => {
      state.tasks[ds] = state.tasks[ds] || [];
      const task = { id: uid(), title, cat, done: false };
      if (series) { task.series = series; task.end = end; }
      state.tasks[ds].push(task);
    });
    $('#addTitle').value = '';
    save(); renderDay(); renderCalendar();
    if (series) toast(`已发布「${title}」到 ${days.length} 天（至 ${end.slice(5).replace('-', '/')}）`);
  });

  /* 常规清单 */
  $('#btnRoutines').addEventListener('click', () => { resetRoutineForm(); renderRoutineList(); openModal('#modalRoutines'); });
  $('#rType').addEventListener('change', syncRepeatFields);
  $('#rCancel').addEventListener('click', resetRoutineForm);
  $('#routineForm').addEventListener('submit', e => {
    e.preventDefault();
    const title = $('#rTitle').value.trim();
    if (!title) return;
    const type = $('#rType').value;
    const repeat = { type, days: [], dates: [], every: 2, startDate: todayStr() };
    if (type === 'weekly') {
      repeat.days = $$('#rWeekly input:checked').map(c => Number(c.value));
      if (!repeat.days.length) { toast('至少选一天'); return; }
    }
    if (type === 'monthly') {
      repeat.dates = $('#rDates').value.split(/[,，\s]+/).map(Number).filter(n => n >= 1 && n <= 31);
      if (!repeat.dates.length) { toast('请填写每月的日期，如 1,15'); return; }
    }
    if (type === 'interval') {
      repeat.every = Math.max(2, Number($('#rEvery').value) || 2);
      repeat.startDate = $('#rStart').value || todayStr();
    }
    const id = $('#rId').value;
    if (id) {
      const r = state.routines.find(x => x.id === id);
      if (r) { r.title = title; r.cat = $('#rCat').value; r.repeat = repeat; }
      toast('已保存');
    } else {
      state.routines.push({ id: uid(), title, cat: $('#rCat').value, repeat, createdDate: todayStr(), archived: false });
      toast('已添加常规');
    }
    save(); resetRoutineForm(); renderRoutineList(); renderDay(); renderCalendar();
  });

  /* 报告 */
  $('#btnReport').addEventListener('click', () => { initRepDates(); syncCatPicker(); updateRangeLabel(); openModal('#modalReport'); });
  $('#repSeg').addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    reportType = b.dataset.r;
    $$('#repSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    switchRepDate();
    updateRangeLabel();
  });
  function switchRepDate() {
    $$('#repDate .rd-row').forEach(r => r.classList.toggle('show', r.dataset.mode === reportType));
  }
  function initRepDates() {
    $('#repDay').value = selDate;
    $('#repWeekDay').value = selDate;
    $('#repMonth').value = selDate.slice(0, 7);
    if (!($('#repStart').value && $('#repEnd').value)) {   // 自定义默认取上周，避免初始为空
      $('#repStart').value = addDays(mondayOf(selDate), -7);
      $('#repEnd').value = addDays(mondayOf(selDate), -1);
    }
    switchRepDate();
  }
  ['repDay', 'repWeekDay', 'repMonth', 'repStart', 'repEnd'].forEach(id =>
    $('#' + id).addEventListener('change', updateRangeLabel));
  function updateRangeLabel() {
    const r = reportRange(reportType);
    const partial = reportCats.length && reportCats.length < CAT_KEYS.length;
    $('#repRange').textContent = r.label + (partial ? ` · 仅 ${reportCats.map(c => CATS[c].name).join('/')}` : '');
  }

  /* 板块多选 */
  function syncCatPicker() {
    $$('#catPicker input').forEach(cb => (cb.checked = reportCats.includes(cb.value)));
    $('#cpAll').textContent = reportCats.length === CAT_KEYS.length ? '全不选' : '全选';
  }
  $('#catPicker').addEventListener('change', e => {
    if (e.target.tagName !== 'INPUT') return;
    const picked = $$('#catPicker input:checked').map(c => c.value);
    if (!picked.length) {                       // 不允许一个都不选
      e.target.checked = true;
      toast('至少保留一个板块');
      return;
    }
    reportCats = CAT_KEYS.filter(c => picked.includes(c));   // 保持固定顺序
    syncCatPicker();
    updateRangeLabel();
  });
  $('#cpAll').addEventListener('click', () => {
    reportCats = reportCats.length === CAT_KEYS.length ? ['work'] : CAT_KEYS.slice();
    syncCatPicker();
    updateRangeLabel();
  });
  $('#btnGenerate').addEventListener('click', async () => {
    const btn = $('#btnGenerate');
    const out = $('#reportOut');
    const md = buildMarkdown(reportType);
    if ($('#repAI').checked) {
      btn.disabled = true; btn.textContent = '生成中…';
      out.innerHTML = '<div class="empty">AI 正在撰写，请稍候…</div>';
      try {
        const txt = await aiPolish(md, reportType);
        lastReportMd = txt;
        out.innerHTML = mdToHtml(txt);
      } catch (err) {
        lastReportMd = md;
        out.innerHTML = mdToHtml(md);
        toast('AI 失败，已用本地汇总：' + err.message);
      } finally { btn.disabled = false; btn.textContent = '生成'; }
    } else {
      lastReportMd = md;
      out.innerHTML = mdToHtml(md);
    }
  });
  $('#btnCopy').addEventListener('click', async () => {
    if (!lastReportMd) return toast('先生成报告');
    try { await navigator.clipboard.writeText(lastReportMd); toast('已复制 Markdown'); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = lastReportMd; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); toast('已复制 Markdown');
    }
  });
  $('#btnDownload').addEventListener('click', () => {
    if (!lastReportMd) return toast('先生成报告');
    const r = reportRange(reportType);
    const tag = reportCats.length < CAT_KEYS.length ? '_' + reportCats.map(c => CATS[c].name).join('') : '';
    const name = `${reportType === 'day' ? '日报' : reportType === 'week' ? '周报' : reportType === 'month' ? '月报' : '区间报告'}${tag}_${r.start}.md`;
    download(name, lastReportMd, 'text/markdown');
  });

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  /* 设置 */
  $('#btnSettings').addEventListener('click', () => {
    $('#setEndpoint').value = state.settings.endpoint || '';
    $('#setKey').value = state.settings.key || '';
    $('#setModel').value = state.settings.model || '';
    openModal('#modalSettings');
  });
  ['setEndpoint', 'setKey', 'setModel'].forEach(id => {
    $('#' + id).addEventListener('change', () => {
      state.settings.endpoint = $('#setEndpoint').value.trim();
      state.settings.key = $('#setKey').value.trim();
      state.settings.model = $('#setModel').value.trim();
      save(); toast('已保存设置');
    });
  });
  $('#btnExport').addEventListener('click', () => {
    download(`工作台数据_${todayStr()}.json`, JSON.stringify(state, null, 2), 'application/json');
  });
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        if (!data.routines) throw new Error('格式不对');
        state = Object.assign(seedState(), data);
        save(); renderAll(); toast('导入成功');
        closeModal($('#modalSettings'));
      } catch (err) { toast('导入失败：' + err.message); }
    };
    fr.readAsText(f);
    e.target.value = '';
  });
  $('#btnClear').addEventListener('click', () => {
    if (!confirm('确定清空全部数据？此操作不可撤销，建议先导出备份。')) return;
    if (!confirm('再确认一次：所有常规、任务、勾选记录都会消失。')) return;
    localStorage.removeItem(STORE_KEY);
    state = seedState(); save(); renderAll();
    closeModal($('#modalSettings'));
    toast('已重置');
  });

  /* 手机底部标签 */
  function setView(v) {
    document.body.dataset.view = v;
    $$('.mobile-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  }
  $$('.mobile-tabs .tab').forEach(t => {
    t.addEventListener('click', () => {
      const v = t.dataset.view;
      if (v === 'routines') { resetRoutineForm(); renderRoutineList(); openModal('#modalRoutines'); return; }
      if (v === 'report') { initRepDates(); syncCatPicker(); updateRangeLabel(); openModal('#modalReport'); return; }
      setView(v);
    });
  });

  /* 左右滑动切月（手机） */
  let tx = 0, ty = 0;
  $('#calGrid').addEventListener('touchstart', e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  $('#calGrid').addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      (dx < 0 ? $('#nextMonth') : $('#prevMonth')).click();
    }
  }, { passive: true });

  /* ---------- 启动 ---------- */
  function renderAll() { renderCalendar(); renderDay(); }
  setView('calendar');
  resetRoutineForm();
  renderAll();

  // 跨天自动刷新
  setInterval(() => {
    const t = todayStr();
    if (t !== renderAll._last) { renderAll._last = t; renderCalendar(); }
  }, 60000);
  renderAll._last = todayStr();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
