/*
 * freshkeeper/storage.js —— 本地持久化 + 全量审计追溯
 *
 * 数据（单个 localStorage 键）：
 *   items: 食材记录（fields 为当前字段，revisions 保存每次修改的字段快照）
 *   audit: 操作流水（创建/修改/事件/撤销/方案应用），永不物理删除
 *
 * 追溯模型：
 *   - 食材字段修改：旧字段整体进 revisions，audit 记录变更字段
 *   - 改变期限的操作（开封/移位/冷冻/解冻/做熟/复热/吃完/丢弃）一律写成
 *     “事件”，事件可以撤销（deleted 标记），引擎重放时会跳过——历史仍在
 *   - audit 支持按时间倒序浏览，任何记录都可追溯到来源（手动录入/拍照确认/方案应用）
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'freshkeeper:v1';

  function nowISO() { return new Date().toISOString(); }
  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---------- 结构校验与规范化 ----------
  // 导入时采用严格模式：任一食材记录缺必要结构即整体拒绝（抛错，不写入任何数据）。
  // 可选的畸形字段（events/revisions 不是数组等）不做静默吞除，统一归一化，保证渲染不崩。
  var LOCATIONS = ['fridge', 'freezer', 'pantry'];
  var PACKAGES = ['sealed', 'opened', 'loose'];
  var EVENT_TYPES = ['open', 'move', 'freeze', 'thaw', 'cook', 'reheat', 'consume', 'discard'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isDateStr(v) {
    return typeof v === 'string' && DATE_RE.test(v) && !isNaN(new Date(v + 'T12:00:00').getTime());
  }
  function isPlainObject(v) {
    return Object.prototype.toString.call(v) === '[object Object]';
  }

  // 校验并返回归一化后的食材。
  // opts.lenient（加载历史数据）：核心字段合法即保留，畸形数组/事件尽量修复，不轻易丢弃；
  // 严格模式（导入）：任何畸形结构都收集错误，由调用方整体拒绝。
  function normalizeItem(raw, index, errors, opts) {
    opts = opts || {};
    var lenient = !!opts.lenient;
    var where = '第 ' + (index + 1) + ' 条食材';
    if (!isPlainObject(raw)) {
      if (!lenient) errors.push(where + '不是对象');
      return null;
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      if (!lenient) errors.push(where + '缺少名称（name）');
      return null;
    }
    if (!isDateStr(raw.purchaseDate)) {
      if (!lenient) errors.push(where + '「' + raw.name + '」缺少合法购买日期（YYYY-MM-DD）');
      return null;
    }
    // 加载旧数据时对非法位置/包装做兜底；导入时严格拒绝
    var loc = LOCATIONS.indexOf(raw.location) >= 0 ? raw.location : (lenient ? 'fridge' : null);
    var pkg = PACKAGES.indexOf(raw.packageType) >= 0 ? raw.packageType : (lenient ? 'sealed' : null);
    if (!loc) { errors.push(where + '「' + raw.name + '」保存位置非法：' + raw.location); return null; }
    if (!pkg) { errors.push(where + '「' + raw.name + '」包装状态非法：' + raw.packageType); return null; }

    var item = {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid('it'),
      name: raw.name.trim().slice(0, 30),
      categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : '',
      purchaseDate: raw.purchaseDate,
      packageType: pkg,
      location: loc,
      note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
      events: [],
      revisions: [],
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : nowISO()
    };

    var rawEvents = Array.isArray(raw.events) ? raw.events
      : (raw.events == null ? [] : (lenient ? [] : null));
    if (rawEvents === null) { errors.push(where + '「' + item.name + '」的 events 必须是数组'); return null; }
    rawEvents.forEach(function (ev, j) {
      if (!isPlainObject(ev)) {
        if (!lenient) errors.push(where + '「' + item.name + '」第 ' + (j + 1) + ' 条事件不是对象');
        return;
      }
      if (EVENT_TYPES.indexOf(ev.type) < 0) {
        if (!lenient) errors.push(where + '「' + item.name + '」存在不支持的事件类型：' + ev.type);
        return;
      }
      if (!isDateStr(ev.at)) {
        if (!lenient) errors.push(where + '「' + item.name + '」的「' + ev.type + '」事件缺少合法日期');
        return;
      }
      var clean = {
        id: (typeof ev.id === 'string' && ev.id) ? ev.id : uid('ev'),
        type: ev.type, at: ev.at,
        deleted: !!ev.deleted
      };
      if (clean.deleted) clean.deletedAt = ev.deletedAt || nowISO();
      if (typeof ev.source === 'string') clean.source = ev.source;
      if (typeof ev.createdAt === 'string') clean.createdAt = ev.createdAt;
      ['to', 'from', 'reason', 'note'].forEach(function (k) {
        if (ev[k] !== undefined) clean[k] = String(ev[k]).slice(0, 200);
      });
      item.events.push(clean);
    });

    if (raw.revisions !== undefined && raw.revisions !== null && !Array.isArray(raw.revisions)) {
      if (!lenient) { errors.push(where + '「' + item.name + '」的 revisions 必须是数组'); return null; }
    } else if (Array.isArray(raw.revisions)) {
      raw.revisions.forEach(function (rev) {
        if (isPlainObject(rev) && isPlainObject(rev.fields)) item.revisions.push({ at: rev.at || nowISO(), fields: rev.fields });
      });
    }

    if (raw.removed === true) item.removed = true, item.removedAt = raw.removedAt || nowISO();
    return item;
  }

  function normalizeAuditEntry(raw) {
    if (!isPlainObject(raw)) return null;
    if (typeof raw.action !== 'string' || !raw.action) return null;
    return {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid('aud'),
      seq: Number.isFinite(raw.seq) ? raw.seq : 0,
      at: typeof raw.at === 'string' ? raw.at : nowISO(),
      action: raw.action,
      detail: isPlainObject(raw.detail) ? raw.detail : {},
      snapshot: raw.snapshot === undefined ? null : raw.snapshot
    };
  }

  // 严格校验整份导入数据，返回 { items, audit }；非法即抛错（原子拒绝）
  function validatePayload(input) {
    var data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!isPlainObject(data)) throw new Error('文件内容不是有效的数据对象');
    if (!Array.isArray(data.items)) throw new Error('缺少 items 食材列表');
    var errors = [];
    var seen = {};
    var items = data.items.map(function (raw, i) {
      var item = normalizeItem(raw, i, errors);
      if (item) {
        if (seen[item.id]) errors.push('食材 ID 重复：' + item.id + '（同一文件内出现多次）');
        seen[item.id] = true;
      }
      return item;
    });
    if (data.audit !== undefined && data.audit !== null && !Array.isArray(data.audit)) {
      errors.push('audit 必须是数组');
    }
    if (errors.length) {
      var e = new Error('导入文件有 ' + errors.length + ' 处结构问题，已取消导入（未改动现有库存）：\n' +
        errors.slice(0, 5).map(function (x) { return '· ' + x; }).join('\n') +
        (errors.length > 5 ? '\n……等共 ' + errors.length + ' 处' : ''));
      e.errors = errors;
      throw e;
    }
    var audit = Array.isArray(data.audit)
      ? data.audit.map(normalizeAuditEntry).filter(Boolean)
      : [];
    return { items: items, audit: audit };
  }

  function createStore(backend) {
    backend = backend || (function () {
      if (typeof localStorage === 'undefined') {
        var mem = {};
        return {
          getItem: function (k) { return mem[k] === undefined ? null : mem[k]; },
          setItem: function (k, v) { mem[k] = String(v); }
        };
      }
      return localStorage;
    })();

    // 加载历史数据采用“宽松迁移”：尽力归一化，无法修复的记录丢弃并告警，避免页面白屏
    function load() {
      var raw = backend.getItem(STORE_KEY);
      if (!raw) return { items: [], audit: [] };
      try {
        var parsed = JSON.parse(raw);
        if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) return { items: [], audit: [] };
        var total = Array.isArray(parsed.items) ? parsed.items.length : 0;
        var errors = [];
        var items = parsed.items.map(function (raw, i) {
          return normalizeItem(raw, i, errors, { lenient: true });
        }).filter(Boolean);
        var skipped = total - items.length;
        var audit = Array.isArray(parsed.audit)
          ? parsed.audit.map(normalizeAuditEntry).filter(Boolean) : [];
        if (skipped > 0 && typeof console !== 'undefined') {
          console.warn('FreshKeeper：本地数据跳过 ' + skipped + ' 条无法修复的异常记录');
        }
        return { items: items, audit: audit };
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('FreshKeeper：本地数据解析失败，使用空库存', e);
        return { items: [], audit: [] };
      }
    }

    var db = load();
    // 历史脏数据经宽松迁移后回写，保证后续读取的都是规范结构
    try { backend.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) {}
    var auditSeq = db.audit.reduce(function (m, e) { return Math.max(m, e.seq || 0); }, 0);

    function persist() {
      backend.setItem(STORE_KEY, JSON.stringify(db));
    }

    function log(action, detail, snapshot) {
      var entry = { id: uid('aud'), seq: ++auditSeq, at: nowISO(), action: action, detail: detail || {}, snapshot: snapshot || null };
      db.audit.push(entry);
      persist();
      return entry;
    }

    // ---- 食材 CRUD ----
    function addItem(fields, source) {
      var item = {
        id: uid('it'),
        name: fields.name || '',
        categoryId: fields.categoryId || '',
        purchaseDate: fields.purchaseDate,
        packageType: fields.packageType || 'sealed',
        location: fields.location || 'fridge',
        note: fields.note || '',
        events: [],
        revisions: [{ at: nowISO(), fields: {
          name: fields.name || '', categoryId: fields.categoryId || '',
          purchaseDate: fields.purchaseDate, packageType: fields.packageType || 'sealed',
          location: fields.location || 'fridge', note: fields.note || ''
        } }],
        createdAt: nowISO()
      };
      db.items.push(item);
      log('item.create', { itemId: item.id, name: item.name, source: source || 'manual' });
      persist();
      return item;
    }

    function getItem(id) {
      return db.items.filter(function (i) { return i.id === id; })[0] || null;
    }

    var TRACKED_FIELDS = ['name', 'categoryId', 'purchaseDate', 'packageType', 'location', 'note'];

    function updateItem(id, patch, source) {
      var item = getItem(id);
      if (!item) throw new Error('食材不存在: ' + id);
      var changes = {};
      TRACKED_FIELDS.forEach(function (f) {
        if (Object.prototype.hasOwnProperty.call(patch, f) && patch[f] !== item[f]) {
          changes[f] = { from: item[f], to: patch[f] };
        }
      });
      if (!Object.keys(changes).length) return item;
      item.revisions.push({ at: nowISO(), fields: TRACKED_FIELDS.reduce(function (acc, f) {
        acc[f] = item[f]; return acc;
      }, {}) });
      TRACKED_FIELDS.forEach(function (f) {
        if (Object.prototype.hasOwnProperty.call(patch, f)) item[f] = patch[f];
      });
      log('item.update', { itemId: id, name: item.name, changes: changes, source: source || 'manual' });
      persist();
      return item;
    }

    // ---- 期限事件 ----
    function addEvent(itemId, type, payload, source) {
      var item = getItem(itemId);
      if (!item) throw new Error('食材不存在: ' + itemId);
      var ev = {
        id: uid('ev'), type: type,
        at: (payload && payload.at) || new Date().toISOString().slice(0, 10),
        source: source || 'manual',
        createdAt: nowISO(),
        deleted: false
      };
      if (payload) {
        ['to', 'from', 'reason', 'note'].forEach(function (k) {
          if (payload[k] !== undefined) ev[k] = payload[k];
        });
      }
      item.events.push(ev);
      log('event.add', { itemId: itemId, name: item.name, eventType: type, eventId: ev.id, at: ev.at, payload: payload || {} });
      persist();
      return ev;
    }

    function undoEvent(eventId) {
      var found = null;
      db.items.forEach(function (item) {
        item.events.forEach(function (ev) {
          if (ev.id === eventId && !ev.deleted) found = { item: item, ev: ev };
        });
      });
      if (!found) return false;
      found.ev.deleted = true;
      found.ev.deletedAt = nowISO();
      log('event.undo', { itemId: found.item.id, name: found.item.name, eventId: eventId, eventType: found.ev.type });
      persist();
      return true;
    }

    // ---- 方案应用（一次写入多个事件）----
    function applyPlan(plan, source) {
      var applied = [];
      (plan.eventsOnApply || []).forEach(function (e) {
        applied.push(addEvent(e.itemId, e.type, { at: e.at, reason: e.reason }, source || ('plan:' + plan.type)));
      });
      log('plan.apply', {
        planType: plan.type, title: plan.title,
        itemIds: (plan.used || []).map(function (u) { return u.id; })
      });
      persist();
      return applied;
    }

    // ---- 删除食材（软删除：保留全部历史；audit 可恢复）----
    function removeItem(id) {
      var item = getItem(id);
      if (!item) return false;
      item.removed = true;
      item.removedAt = nowISO();
      log('item.remove', { itemId: id, name: item.name, snapshot: JSON.parse(JSON.stringify(item)) });
      persist();
      return true;
    }

    function restoreItem(id) {
      var item = getItem(id);
      if (!item || !item.removed) return false;
      delete item.removed;
      delete item.removedAt;
      log('item.restore', { itemId: id, name: item.name });
      persist();
      return true;
    }

    function listItems(includeRemoved) {
      return db.items.filter(function (i) { return includeRemoved || !i.removed; });
    }

    function auditEntries() {
      return db.audit.slice().sort(function (a, b) {
        return (b.seq || 0) - (a.seq || 0);
      });
    }

    function exportJSON() {
      return JSON.stringify(db, null, 2);
    }

    function importJSON(text, merge) {
      // 先校验、后写入：任何结构问题都整体拒绝，现有库存不被改动
      var clean = validatePayload(text);
      if (merge) {
        var dup = clean.items.filter(function (it) { return getItem(it.id); }).map(function (it) { return it.id; });
        if (dup.length) {
          var e = new Error('导入文件中有 ' + dup.length + ' 条记录与现有库存 ID 相同（可能是同一数据重复导入），已取消合并。');
          e.errors = dup;
          throw e;
        }
        db.items = db.items.concat(clean.items);
        // 合并进来的审计序号要平移到当前序号之后，避免 seq 倒退导致追溯排序错乱
        var shift = auditSeq;
        clean.audit.forEach(function (a) { a.seq = (a.seq || 0) + shift; });
        db.audit = db.audit.concat(clean.audit);
      } else {
        db = { items: clean.items, audit: clean.audit };
        auditSeq = db.audit.reduce(function (m, e) { return Math.max(m, e.seq || 0); }, 0);
      }
      log('data.import', { merge: !!merge, items: clean.items.length, audit: clean.audit.length });
      persist();
      return { items: clean.items.length, audit: clean.audit.length };
    }

    function seedDemo(demoItems, Engine) {
      // 演示数据：购买日期相对今天，便于直接看到各种分档
      Engine = Engine || (typeof global.FreshEngine !== 'undefined' ? global.FreshEngine : null);
      var today = Engine.isoDate(Engine.todayAt());
      var d = function (offset) { return Engine.isoDate(Engine.addDays(today, offset)); };
      var specs = [
        { name: '猪里脊', purchaseDate: d(-2), packageType: 'sealed', location: 'fridge' },
        { name: '菠菜', purchaseDate: d(-4), packageType: 'loose', location: 'fridge' },
        { name: '番茄', purchaseDate: d(-6), packageType: 'loose', location: 'fridge' },
        { name: '鸡蛋', purchaseDate: d(-10), packageType: 'sealed', location: 'fridge' },
        { name: '酸奶', purchaseDate: d(-18), packageType: 'sealed', location: 'fridge' },
        { name: '三文鱼', purchaseDate: d(-2), packageType: 'sealed', location: 'freezer' },
        { name: '白米饭(剩)', purchaseDate: d(-1), packageType: 'opened', location: 'fridge' },
        { name: '豆腐', purchaseDate: d(-2), packageType: 'opened', location: 'fridge' },
        { name: '牛奶', purchaseDate: d(-6), packageType: 'opened', location: 'fridge' }
      ];
      specs.forEach(function (s) { addItem(s, 'demo'); });
      var rice = db.items.filter(function (i) { return i.name === '白米饭(剩)'; })[0];
      if (rice) addEvent(rice.id, 'cook', { at: d(-1) }, 'demo');
      return specs.length;
    }

    return {
      addItem: addItem, getItem: getItem, updateItem: updateItem, removeItem: removeItem,
      restoreItem: restoreItem, listItems: listItems,
      addEvent: addEvent, undoEvent: undoEvent, applyPlan: applyPlan,
      auditEntries: auditEntries, exportJSON: exportJSON, importJSON: importJSON,
      seedDemo: seedDemo, _key: function () { return STORE_KEY; }
    };
  }

  var Storage = { createStore: createStore, uid: uid, validatePayload: validatePayload };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Storage;
  } else {
    global.FreshStorage = Storage;
  }
})(typeof window !== 'undefined' ? window : this);
