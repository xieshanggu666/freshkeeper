/* freshkeeper/app.js —— 界面控制器（所有业务决策都调用 engine/planner，本文件只做渲染与交互） */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var store = FreshStorage.createStore();
  var state = {
    view: 'inventory',
    filter: 'all',
    editingId: null,
    formLocation: 'fridge',
    pickedIds: null,   // null=使用全部库存；数组=仅选中的食材
    lastPlans: []
  };

  // ---------- 小工具 ----------
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function todayISO() { return FreshEngine.isoDate(FreshEngine.todayAt()); }
  function fmtDate(s) {
    if (!s) return '—';
    return String(s).slice(0, 10);
  }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function locTag(loc) {
    var m = FreshRules.locations[loc] || { name: loc };
    return '<span class="loc-tag loc-' + loc + '">' + esc(m.name) + '</span>';
  }

  // ---------- 库存渲染 ----------
  function assessments() {
    // 包含软删除记录（仅在“已归档”中展示），其余过滤条件排除
    return FreshEngine.assessAll(store.listItems(true));
  }

  function filterRows(rows) {
    switch (state.filter) {
      case 'expired': return rows.filter(function (a) { return a.status === 'expired' && !a.item.removed; });
      case 'urgent': return rows.filter(function (a) { return (a.status === 'danger' || a.status === 'warn') && !a.item.removed; });
      case 'fresh': return rows.filter(function (a) { return (a.status === 'fresh' || a.status === 'quality') && !a.item.removed; });
      case 'frozen': return rows.filter(function (a) { return a.state.clockPaused && !a.item.removed; });
      case 'ended': return rows.filter(function (a) { return a.state.ended || a.item.removed; });
      default: return rows.filter(function (a) { return !a.state.ended && !a.item.removed; });
    }
  }

  function daysText(a) {
    if (a.state.ended) return esc(a.statusInfo.label);
    if (a.state.clockPaused) {
      var q = a.qualityDaysLeft;
      return q < 0 ? '冷冻品质期已过 ' + Math.abs(q) + ' 天' : '冷冻中 · 品质期剩 ' + q + ' 天';
    }
    if (a.safeDaysLeft < 0) return '已过期 ' + Math.abs(a.safeDaysLeft) + ' 天';
    if (a.safeDaysLeft === 0) return '今天到期';
    return '建议期限剩 ' + a.safeDaysLeft + ' 天';
  }

  function renderInventory() {
    var all = assessments();
    var rows = filterRows(all);
    var active = all.filter(function (a) { return !a.state.ended; });

    // 顶部汇总
    var nExp = active.filter(function (a) { return a.status === 'expired'; }).length;
    var nUrg = active.filter(function (a) { return a.status === 'danger' || a.status === 'warn'; }).length;
    $('#summaryLine').textContent =
      '在库 ' + active.length + ' 样 · ' +
      (nExp ? '过期 ' + nExp + ' · ' : '') +
      (nUrg ? '需尽快 ' + nUrg : (nExp ? '' : '暂无临期，状态良好'));

    var list = $('#inventoryList');
    list.innerHTML = rows.map(function (a) {
      var it = a.item;
      var cat = a.state.cat;
      var endedCls = a.state.ended ? 's-' + a.status : '';
      return '<div class="food-card s-' + a.status + ' ' + endedCls + '" data-id="' + esc(it.id) + '">' +
        '<div class="fc-main">' +
          '<div class="fc-title">' +
            '<span class="fc-name">' + esc(it.name) + '</span>' +
            (cat ? '<span class="fc-cat">' + esc(cat.name) + '</span>' : '<span class="fc-cat">未识别分类</span>') +
            (a.highRisk ? '<span class="fc-risk">高风险</span>' : '') +
            (it.events.some(function (e) { return !e.deleted && e.type === 'cook'; }) ? '<span class="fc-cat">已做熟</span>' : '') +
          '</div>' +
          '<div class="fc-meta">' +
            locTag(a.state.location) +
            '<span>' + esc(FreshRules.packages[a.state.packageType] || a.state.packageType) + '</span>' +
            '<span>购于 ' + fmtDate(it.purchaseDate) + '</span>' +
          '</div>' +
          '<div class="fc-advice">' + esc(a.advice.title) + '</div>' +
        '</div>' +
        '<div class="fc-side">' +
          '<span class="status-pill sp-' + a.status + '">' + esc(a.statusInfo.label) + '</span>' +
          '<span class="fc-days">' + esc(daysText(a)) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');

    $('#inventoryEmpty').hidden = rows.length > 0;
    $$('#inventoryList .food-card').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(el.getAttribute('data-id')); });
    });
  }

  // ---------- 录入/编辑表单 ----------
  function fillCategorySelect(selectId, selectedId) {
    var sel = $('#' + selectId);
    sel.innerHTML = '<option value="">（按名称自动识别）</option>' +
      FreshRules.categories.map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === selectedId ? ' selected' : '') + '>' +
          esc(c.name) + (c.highRisk ? ' ·高风险' : '') + '</option>';
      }).join('');
  }

  function rulePreview() {
    var name = $('#fName').value.trim();
    var catId = $('#fCategory').value;
    var loc = state.formLocation;
    var pkg = $('#fPackage').value;
    var m = FreshEngine.matchCategory(name);
    var cat = catId
      ? FreshRules.categories.filter(function (c) { return c.id === catId; })[0]
      : m.category;

    if (!name) { $('#rulePreview').innerHTML = '输入名称后显示该食材的建议期限。'; return; }
    if (!cat) {
      $('#catHint').textContent = m.matchedKeyword ? '' : '未识别该食材，可在上方手动选择分类';
      $('#rulePreview').innerHTML = '未匹配到规则，将按最保守 1 天估算；请手动选择分类以获得准确建议。';
      return;
    }
    $('#catHint').textContent = '识别为：' + cat.name + (cat.highRisk ? '（高风险食材，建议从严）' : '');
    var d = FreshEngine.safeDaysFor(cat, loc, pkg);
    var html;
    if (d === null) {
      html = '⚠️ <b>' + esc(cat.name) + '不建议' + FreshRules.locations[loc].name + '保存</b>，请更换位置，否则按 1 天估算。';
    } else if (loc === 'freezer') {
      html = '冷冻保存：安全时钟暂停，建议品质期约 <b>' + Math.round(cat.freezerQuality / 30) + ' 个月</b>；' +
        '解冻后冷藏请在 <b>' + cat.thawQuality + ' 天</b>内吃完。';
    } else {
      html = esc(cat.name) + ' · ' + FreshRules.locations[loc].name + ' · ' +
        esc(FreshRules.packages[pkg]) + ' 建议期限：<b>' + d + ' 天</b>' +
        '；做熟后冷藏 ' + cat.cookedSafe + ' 天内吃完。';
    }
    $('#rulePreview').innerHTML = html;
  }

  function openForm(item) {
    state.editingId = item ? item.id : null;
    $('#formTitle').textContent = item ? '编辑食材' : '录入食材';
    fillCategorySelect('fCategory', item ? item.categoryId : '');
    $('#fName').value = item ? item.name : '';
    $('#fPurchaseDate').value = item ? item.purchaseDate : todayISO();
    $('#fPackage').value = item ? item.packageType : 'sealed';
    state.formLocation = item ? item.location : 'fridge';
    $('#fNote').value = item ? (item.note || '') : '';
    $$('#fLocation button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-v') === state.formLocation);
    });
    $('#btnDeleteItem').hidden = !item;
    rulePreview();
    $('#sheetForm').hidden = false;
  }

  function closeSheet(sheet) { $('#' + sheet).hidden = true; }

  function saveForm(e) {
    e.preventDefault();
    var fields = {
      name: $('#fName').value.trim(),
      categoryId: $('#fCategory').value,
      purchaseDate: $('#fPurchaseDate').value,
      packageType: $('#fPackage').value,
      location: state.formLocation,
      note: $('#fNote').value.trim()
    };
    if (!fields.name || !fields.purchaseDate) { toast('请填写名称和购买日期'); return; }
    if (!fields.categoryId) {
      var m = FreshEngine.matchCategory(fields.name);
      if (!m.category) { toast('未识别食材分类，请手动选择'); return; }
    }

    if (state.editingId) {
      store.updateItem(state.editingId, fields, 'manual');
      toast('已保存修改，旧值已记入追溯');
    } else {
      store.addItem(fields, 'manual');
      toast('已录入：' + fields.name);
    }
    closeSheet('sheetForm');
    renderAll();
  }

  // ---------- OCR 拍照识别 ----------
  function setupOCR() {
    var fileInput = $('#fileInput');
    $('#btnCamera').addEventListener('click', function () {
      fileInput.removeAttribute('capture');
      fileInput.setAttribute('capture', 'environment');
      fileInput.click();
    });
    $('#btnPhoto').addEventListener('click', function () {
      fileInput.removeAttribute('capture');
      fileInput.click();
    });
    fileInput.addEventListener('change', function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      runOCR(fileInput.files[0]);
      fileInput.value = '';
    });
  }

  function runOCR(file) {
    var status = $('#ocrStatus');
    var btns = [$('#btnCamera'), $('#btnPhoto')];
    btns.forEach(function (b) { b.disabled = true; });
    status.innerHTML = '📸 正在识别标签文字（首次需下载识别组件，请稍候）…';

    var reader = new FileReader();
    reader.onload = function () {
      FreshOCR.recognizeImage(reader.result, function (stage, p) {
        var label = { 'loading tesseract core': '加载识别引擎', 'initializing tesseract': '初始化',
          'loading language traineddata': '下载中文语言包', 'initializing api': '准备中',
          'recognizing text': '识别文字中' }[stage] || stage;
        status.textContent = '📸 ' + label + (p ? ' ' + Math.round(p * 100) + '%' : '…');
      }).then(function (parsed) {
        fillFormFromOCR(parsed);
        status.innerHTML = '✅ 识别完成，<b>请逐项核对后再保存</b>（识别结果未入库）';
      }).catch(function (err) {
        status.innerHTML = '⚠️ ' + esc(err.message || '识别失败') + '，可直接手动填写。';
      }).then(function () {
        btns.forEach(function (b) { b.disabled = false; });
      });
    };
    reader.readAsDataURL(file);
  }

  function fillFormFromOCR(p) {
    if (p.name) $('#fName').value = p.name;
    var m = FreshEngine.matchCategory(p.name);
    if (m.category) $('#fCategory').value = m.category.id;
    if (p.locationHint) {
      state.formLocation = p.locationHint;
      $$('#fLocation button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-v') === state.formLocation);
      });
    }
    // 标签上的到期日：换算回“购买日期”不现实，改在备注中提示，由用户确认
    if (p.expireDate) {
      $('#fNote').value = '标签到期日 ' + p.expireDate + (p.daysShelf ? '（保质期约 ' + p.daysShelf + ' 天）' : '') +
        '，请确认购买日期';
    }
    rulePreview();
    toast('识别文字已填入，请核对');
  }

  // ---------- 详情 / 时间线 ----------
  var EVENT_LABELS = {
    open: '开封', move: '更换保存位置', freeze: '放入冷冻', thaw: '解冻移至冷藏',
    cook: '已做熟', reheat: '重新加热', consume: '吃完/用尽', discard: '丢弃'
  };

  function openDetail(id) {
    var item = store.getItem(id);
    if (!item) return;
    var a = FreshEngine.assess(item);
    var cat = a.state.cat;

    var events = (item.events || []).filter(function (e) { return !e.deleted; })
      .slice().sort(function (x, y) { return x.at < y.at ? 1 : x.at > y.at ? -1 : -1; });
    var undone = (item.events || []).filter(function (e) { return e.deleted; })
      .slice().sort(function (x, y) { return (x.deletedAt || '') < (y.deletedAt || '') ? 1 : -1; });

    var adviceCls = a.status === 'expired' || a.status === 'danger' ? 'bad'
      : a.status === 'fresh' ? 'good' : '';

    var html =
      '<div class="detail-head">' +
        '<div style="flex:1">' +
          '<div class="detail-name">' + esc(item.name) + '</div>' +
          '<div class="fc-meta">' +
            (cat ? '<span class="fc-cat">' + esc(cat.name) + '</span>' : '<span class="fc-cat">未识别分类</span>') +
            (a.highRisk ? '<span class="fc-risk">高风险</span>' : '') +
            '<span class="tl-date">录入于 ' + fmtDateTime(item.createdAt) + '</span>' +
          '</div>' +
        '</div>' +
        '<span class="status-pill sp-' + a.status + '">' + esc(a.statusInfo.label) + '</span>' +
      '</div>' +

      '<div class="detail-advice ' + adviceCls + '">' +
        '<h4>👉 ' + esc(a.advice.title) + '</h4>' +
        '<p>' + esc(daysText(a)) + (a.advice.detail ? '。' + esc(a.advice.detail) : '') + '</p>' +
        (a.advice.alternatives.length
          ? '<ul class="alt-list">' + a.advice.alternatives.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
          : '') +
      '</div>' +

      '<div class="detail-meta">' +
        '<div><span>购买日期</span>' + fmtDate(item.purchaseDate) + '</div>' +
        '<div><span>当前位置</span>' + (FreshRules.locations[a.state.location] || {}).name + '</div>' +
        '<div><span>包装状态</span>' + esc(FreshRules.packages[a.state.packageType] || a.state.packageType) + '</div>' +
        '<div><span>处理状态</span>' + (a.state.cooked ? '已做熟' : '生/原状') + (a.state.thawed ? ' ·已解冻' : '') + '</div>' +
        (item.note ? '<div style="grid-column:1/-1"><span>备注</span>' + esc(item.note) + '</div>' : '') +
      '</div>';

    if (!a.state.ended) {
      html += '<div class="act-grid">' +
        actBtn('ev-open', '📦', '已开封', false) +
        actBtn('ev-freeze', '❄️', '放入冷冻', false) +
        actBtn('ev-thaw', '💧', '已解冻', false) +
        actBtn('ev-cook', '🍳', '做熟了', false) +
        actBtn('ev-reheat', '♨️', '重新加热', false) +
        actBtn('ev-move-pantry', '🏠', '移常温', false) +
        actBtn('ev-consume', '✅', '吃完了', false) +
        actBtn('ev-discard', '🗑️', '丢弃', true) +
      '</div>';
    } else {
      html += '<div class="form-actions" style="margin:12px 0">' +
        '<button class="btn-ghost" id="btnRestoreItem">↩️ 撤销归档（恢复在库）</button>' +
      '</div>';
    }

    html += '<div class="timeline"><h4>变更时间线（可撤销）</h4>';
    html += '<div class="tl-item"><span class="tl-dot"></span><div class="tl-body tl-create">' +
      '<span class="tl-date">' + fmtDate(item.purchaseDate) + '</span> 购买并录入（' +
      esc(FreshRules.packages[item.packageType] || item.packageType) + ' · ' +
      (FreshRules.locations[item.location] || {}).name + '）</div></div>';

    events.forEach(function (ev) {
      var note = ev.type === 'reheat' ? a.reheatNote : null;
      html += '<div class="tl-item"><span class="tl-dot"></span>' +
        '<div class="tl-body"><span class="tl-date">' + fmtDate(ev.at) + '</span> ' +
        esc(EVENT_LABELS[ev.type] || ev.type) +
        (ev.reason ? '：' + esc(ev.reason) : '') +
        (ev.source && ev.source.indexOf('plan') === 0 ? ' <span class="fc-cat">来自方案</span>' : '') +
        (note ? '<br><span class="tl-date">' + esc(note) + '</span>' : '') +
        ' <button class="tl-undo" data-undo="' + ev.id + '">撤销</button></div></div>';
    });
    undone.forEach(function (ev) {
      html += '<div class="tl-item"><span class="tl-dot undone"></span>' +
        '<div class="tl-body undone"><span class="tl-date">' + fmtDate(ev.at) + '</span> ' +
        esc(EVENT_LABELS[ev.type] || ev.type) + '（已撤销）</div></div>';
    });
    html += '</div>';

    html += '<div class="form-actions" style="margin-top:14px">' +
      '<button class="btn-ghost" id="btnEditItem">✏️ 修改信息</button>' +
      '<button class="btn-primary" data-close>关闭</button>' +
    '</div>';

    $('#detailBody').innerHTML = html;
    $('#sheetDetail').hidden = false;

    // 事件按钮
    var evMap = {
      'ev-open': ['open', {}],
      'ev-freeze': ['freeze', {}],
      'ev-thaw': ['thaw', {}],
      'ev-cook': ['cook', {}],
      'ev-reheat': ['reheat', {}],
      'ev-move-pantry': ['move', { to: 'pantry' }],
      'ev-consume': ['consume', {}],
      'ev-discard': ['discard', { reason: '用户丢弃' }]
    };
    Object.keys(evMap).forEach(function (k) {
      var btn = document.getElementById(k);
      if (btn) btn.addEventListener('click', function () {
        var spec = evMap[k];
        if (spec[0] === 'discard' && !confirm('确认丢弃该食材？此操作会记入追溯（可在记录中恢复）。')) return;
        store.addEvent(id, spec[0], Object.assign({ at: todayISO() }, spec[1]), 'manual');
        toast('已记录：' + EVENT_LABELS[spec[0]]);
        closeSheet('sheetDetail');
        renderAll();
      });
    });
    $$('#detailBody [data-undo]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (store.undoEvent(b.getAttribute('data-undo'))) {
          toast('已撤销该操作，期限已重新计算');
          openDetail(id);
          renderAll();
        }
      });
    });
    var editBtn = $('#btnEditItem');
    if (editBtn) editBtn.addEventListener('click', function () {
      closeSheet('sheetDetail');
      openForm(item);
    });
    var restoreBtn = $('#btnRestoreItem');
    if (restoreBtn) restoreBtn.addEventListener('click', function () {
      // 归档恢复 = 撤销 consume/discard 事件
      var endEv = item.events.filter(function (e) { return !e.deleted && (e.type === 'consume' || e.type === 'discard'); }).pop();
      if (endEv) { store.undoEvent(endEv.id); toast('已恢复在库'); openDetail(id); renderAll(); }
    });
  }

  function actBtn(id, icon, label, danger) {
    return '<button class="act-btn' + (danger ? ' danger' : '') + '" id="' + id + '"><span>' + icon + '</span>' + esc(label) + '</button>';
  }

  // ---------- 方案视图 ----------
  function planScopeItems() {
    if (!state.pickedIds) return store.listItems();
    var ids = {};
    state.pickedIds.forEach(function (id) { ids[id] = true; });
    return store.listItems().filter(function (it) { return ids[it.id]; });
  }

  function renderPlan() {
    // 快速勾选区：优先展示临期/高风险食材
    var active = FreshEngine.activeAssessments(store.listItems());
    var pickRoot = $('#quickPick');
    var picked = state.pickedIds;
    pickRoot.innerHTML = active.map(function (a) {
      var on = !picked || picked.indexOf(a.item.id) >= 0;
      return '<button class="pick-chip ' + (on ? 'on' : '') + '" data-id="' + esc(a.item.id) + '">' +
        esc(a.item.name) +
        (a.status === 'expired' || a.status === 'danger' || a.status === 'warn'
          ? ' <span style="color:var(--danger)">●</span>' : '') +
      '</button>';
    }).join('') +
    '<button class="pick-chip" id="pickScope" style="border-style:dashed">' +
      (picked ? '已选 ' + picked.length + ' 样 · 点此用全部库存' : '当前：全部库存') +
    '</button>';

    $$('#quickPick .pick-chip[data-id]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        var cur = state.pickedIds || active.map(function (a) { return a.item.id; });
        var idx = cur.indexOf(id);
        if (idx >= 0) cur.splice(idx, 1); else cur.push(id);
        state.pickedIds = cur;
        renderPlan();
      });
    });
    $('#pickScope').addEventListener('click', function () {
      state.pickedIds = null;
      renderPlan();
    });

    var plans = FreshPlanner.buildPlans(planScopeItems());
    state.lastPlans = plans;

    var root = $('#planList');
    if (!plans.length) {
      root.innerHTML = '<p class="empty-hint">当前选中的食材暂时凑不出方案。<br>试试勾选更多食材，或先处理过期食材。</p>';
      return;
    }

    var ICONS = { cook: '🍳', discard: '🗑️', freeze: '❄️', reheat: '♨️' };
    var TAGS = { cook: ['pt-cook', '烹饪'], discard: ['pt-discard', '丢弃'], freeze: ['pt-freeze', '冷冻'], reheat: ['pt-reheat', '复热'] };

    root.innerHTML = plans.map(function (p, i) {
      return '<div class="plan-card" data-i="' + i + '">' +
        '<div class="plan-top">' +
          '<span class="plan-icon">' + (ICONS[p.type] || '🍽️') + '</span>' +
          '<div><div class="plan-title">' + esc(p.title) + '</div>' +
            (p.minutes ? '<div class="plan-min">约 ' + p.minutes + ' 分钟</div>' : '') +
          '</div>' +
          '<span class="plan-tag ' + TAGS[p.type][0] + '">' + TAGS[p.type][1] + '</span>' +
        '</div>' +
        '<div class="plan-section">' +
          '<h4>使用食材（' + p.used.length + '）</h4>' +
          '<div class="used-tags">' + p.used.map(function (u) {
            var dot = /今天到期|近 /.test(u.statusLabel || '') || u.frozen;
            return '<span class="used-tag' + (u.frozen ? ' frozen' : '') + '">' +
              (dot ? '<span class="urgent-dot">●</span>' : '') + esc(u.name) +
              (u.note ? ' <small>(' + esc(u.note) + ')</small>' : '') + '</span>';
          }).join('') + '</div>' +
          (p.stillUrgent.length
            ? '<h4 style="color:var(--danger)">做完后仍需尽快处理（' + p.stillUrgent.length + '）</h4>' +
              '<div class="used-tags">' + p.stillUrgent.map(function (u) {
                return '<span class="used-tag" style="background:var(--warn-soft);color:#a35e00">⚠️ ' + esc(u.name) +
                  ' <small>(' + esc(u.statusLabel) + ')</small></span>';
              }).join('') + '</div>'
            : '<h4 style="color:var(--green-dark)">✓ 应用后没有遗留的临期食材</h4>') +
        '</div>' +
        '<div class="plan-actions">' +
          (p.type === 'cook'
            ? '<button class="btn-primary" data-apply="' + i + '">按此方案处理并记录</button>'
            : '<button class="btn-primary ' + (p.type === 'discard' ? 'danger' : '') + '" data-apply="' + i + '">执行并记录</button>') +
          '<button class="btn-ghost" data-detail="' + i + '">查看步骤</button>' +
        '</div>' +
      '</div>';
    }).join('');

    $$('#planList [data-detail]').forEach(function (b) {
      b.addEventListener('click', function () { openPlanDetail(+b.getAttribute('data-detail')); });
    });
    $$('#planList [data-apply]').forEach(function (b) {
      b.addEventListener('click', function () { applyPlan(+b.getAttribute('data-apply')); });
    });
  }

  function openPlanDetail(i) {
    var p = state.lastPlans[i];
    if (!p) return;
    var html = '<div class="pd-title">' + esc(p.title) + '</div>' +
      (p.minutes ? '<div class="plan-min">约 ' + p.minutes + ' 分钟</div>' : '') +
      '<div class="pd-block"><h4>使用了哪些食材</h4><div class="used-tags">' +
        p.used.map(function (u) {
          return '<span class="used-tag' + (u.frozen ? ' frozen' : '') + '">' + esc(u.name) +
            (u.note ? ' <small>(' + esc(u.note) + ')</small>' : '') + '</span>';
        }).join('') + '</div></div>' +
      (p.steps && p.steps.length
        ? '<ol class="pd-steps">' + p.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>'
        : '') +
      (p.leftoverNote ? '<p class="hint">' + esc(p.leftoverNote) + '</p>' : '') +
      (p.tip ? '<div class="pd-tip">💡 ' + esc(p.tip) + '</div>' : '') +
      '<div class="pd-block"><h4>应用后仍需尽快处理</h4>' +
        (p.stillUrgent.length
          ? '<div class="still-list">' + p.stillUrgent.map(function (u) {
              return '<div class="row"><span>⚠️ ' + esc(u.name) + '</span><b>' + esc(u.statusLabel) + '</b></div>';
            }).join('') + '</div>'
          : '<div class="still-list" style="background:var(--green-soft);color:var(--green-dark)">✓ 没有遗留的临期食材</div>') +
      '</div>' +
      '<div class="form-actions"><button class="btn-ghost" data-close>关闭</button>' +
      '<button class="btn-primary ' + (p.type === 'discard' ? 'danger' : '') + '" id="pdApply">按此方案处理并记录</button></div>';

    $('#planDetailBody').innerHTML = html;
    $('#sheetPlan').hidden = false;
    $('#pdApply').addEventListener('click', function () {
      closeSheet('sheetPlan');
      applyPlan(i);
    });
  }

  function applyPlan(i) {
    var p = state.lastPlans[i];
    if (!p) return;
    var verb = { cook: '确认已做熟并记录？', discard: '确认丢弃以上食材？', freeze: '确认已分装放入冷冻？', reheat: '确认已彻底复热？' }[p.type] || '确认执行？';
    if (!confirm('「' + p.title + '」\n将为 ' + p.used.length + ' 样食材写入处理记录。\n' + verb)) return;
    store.applyPlan(p);
    toast('已记录方案处理结果');
    renderAll();
  }

  // ---------- 追溯视图 ----------
  var AUDIT_META = {
    'item.create': ['录入食材', 'a-update', '📥'],
    'item.update': ['修改信息', 'a-update', '✏️'],
    'item.remove': ['删除记录', 'a-remove', '🗑️'],
    'item.restore': ['恢复记录', 'a-update', '↩️'],
    'event.add': ['记录期限事件', 'a-event', '🧷'],
    'event.undo': ['撤销事件', 'a-event', '↩️'],
    'plan.apply': ['应用方案', 'a-plan', '🍳'],
    'data.import': ['导入数据', 'a-update', '⬆️']
  };
  function renderAudit() {
    var entries = store.auditEntries().slice(0, 100);
    var nameOf = {};
    store.listItems(true).forEach(function (it) { nameOf[it.id] = it.name; });

    $('#auditList').innerHTML = entries.length ? entries.map(function (e) {
      var meta = AUDIT_META[e.action] || [e.action, '', '•'];
      var d = e.detail || {};
      var lines = [];
      if (d.name) lines.push(esc(d.name));
      if (d.source) lines.push('来源：' + esc(d.source));
      if (d.eventType) lines.push(esc(EVENT_LABELS[d.eventType] || d.eventType) + (d.at ? ' @ ' + d.at : ''));
      if (d.planType || d.title) lines.push(esc(d.title || d.planType));
      if (d.changes) {
        var LABELS = { name: '名称', categoryId: '分类', purchaseDate: '购买日期', packageType: '包装', location: '位置', note: '备注' };
        Object.keys(d.changes).forEach(function (k) {
          var c = d.changes[k];
          lines.push((LABELS[k] || k) + '：' + esc(short(c.from)) + ' → ' + esc(short(c.to)));
        });
      }
      if (d.itemIds && d.itemIds.length) lines.push('涉及 ' + d.itemIds.length + ' 样食材');
      var restoreBtn = e.action === 'item.remove' && d.itemId && store.getItem(d.itemId) && store.getItem(d.itemId).removed
        ? ' <button class="tl-undo" data-restore="' + esc(d.itemId) + '">恢复该记录</button>' : '';
      return '<div class="audit-item ' + meta[1] + '">' +
        '<div class="audit-top"><span class="audit-action">' + meta[2] + ' ' + meta[0] + '</span>' +
        '<span class="audit-time">' + fmtDateTime(e.at) + '</span></div>' +
        (lines.length ? '<div class="audit-detail">' + lines.join('<br>') + restoreBtn + '</div>' : (restoreBtn ? restoreBtn : '')) +
      '</div>';
    }).join('') : '<p class="empty-hint">暂无操作记录。</p>';

    $$('#auditList [data-restore]').forEach(function (b) {
      b.addEventListener('click', function () {
        store.restoreItem(b.getAttribute('data-restore'));
        toast('已恢复该记录');
        renderAll();
      });
    });
  }
  function short(v) {
    v = String(v == null || v === '' ? '（空）' : v);
    return v.length > 18 ? v.slice(0, 18) + '…' : v;
  }

  // ---------- 设置：导入导出/演示/清空 ----------
  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function setupSettings() {
    $('#btnExport').addEventListener('click', function () { $('#sheetSettings').hidden = false; });
    $('#btnDemo').addEventListener('click', function () {
      if (store.listItems().length && !confirm('载入演示数据会追加到现有库存，继续？')) return;
      var n = store.seedDemo(null, FreshEngine);
      toast('已载入 ' + n + ' 样演示食材');
      closeSheet('sheetSettings');
      renderAll();
    });
    $('#btnExport2').addEventListener('click', function () {
      download('freshkeeper-' + todayISO() + '.json', store.exportJSON());
      toast('已导出数据文件');
    });
    $('#btnImport').addEventListener('click', function () { $('#importInput').click(); });
    $('#importInput').addEventListener('change', function (ev) {
      var f = ev.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          store.importJSON(r.result, true);
          toast('导入完成（已合并）');
          closeSheet('sheetSettings');
          renderAll();
        } catch (e) { toast('导入失败：文件格式不正确'); }
      };
      r.readAsText(f);
      ev.target.value = '';
    });
    $('#btnWipe').addEventListener('click', function () {
      if (!confirm('确定清空本机全部食材与追溯记录？此操作不可恢复。')) return;
      localStorage.removeItem(store._key());
      location.reload();
    });
  }

  // ---------- 全局渲染/导航 ----------
  function renderAll() {
    renderInventory();
    renderPlan();
    renderAudit();
  }

  function switchView(v) {
    state.view = v;
    $$('.tab[data-view]').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-view') === v); });
    ['inventory', 'plan', 'history'].forEach(function (k) {
      $('#view-' + k).hidden = (k !== v);
    });
    window.scrollTo(0, 0);
  }

  function init() {
    // 导航
    $$('.tab[data-view]').forEach(function (t) {
      t.addEventListener('click', function () { switchView(t.getAttribute('data-view')); });
    });
    $('#btnAdd').addEventListener('click', function () { openForm(null); });

    // 过滤
    $$('#statusFilter .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        state.filter = c.getAttribute('data-f');
        $$('#statusFilter .chip').forEach(function (x) { x.classList.toggle('active', x === c); });
        renderInventory();
      });
    });

    // 表单
    $('#itemForm').addEventListener('submit', saveForm);
    $('#fName').addEventListener('input', function () {
      var m = FreshEngine.matchCategory(this.value.trim());
      if (m.category && !$('#fCategory').value) $('#fCategory').value = m.category.id;
      rulePreview();
    });
    $('#fCategory').addEventListener('change', rulePreview);
    $('#fPackage').addEventListener('change', rulePreview);
    $$('#fLocation button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.formLocation = b.getAttribute('data-v');
        $$('#fLocation button').forEach(function (x) { x.classList.toggle('active', x === b); });
        rulePreview();
      });
    });
    $('#btnDeleteItem').addEventListener('click', function () {
      if (!state.editingId) return;
      if (!confirm('删除该食材记录？记录会软删除并保留在追溯中（可恢复）。')) return;
      store.removeItem(state.editingId);
      closeSheet('sheetForm');
      toast('已删除，可在追溯中恢复');
      renderAll();
    });

    // 弹层关闭
    document.addEventListener('click', function (e) {
      var closeBtn = e.target.closest('[data-close]');
      if (!closeBtn) return;
      var sheet = closeBtn.closest('.sheet');
      if (sheet) sheet.hidden = true;
    });

    setupOCR();
    setupSettings();
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
