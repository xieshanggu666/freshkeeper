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

    function load() {
      try {
        var raw = backend.getItem(STORE_KEY);
        if (!raw) return { items: [], audit: [] };
        var data = JSON.parse(raw);
        return { items: data.items || [], audit: data.audit || [] };
      } catch (e) {
        return { items: [], audit: [] };
      }
    }

    var db = load();
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
      var incoming = typeof text === 'string' ? JSON.parse(text) : text;
      if (!merge) {
        db = { items: incoming.items || [], audit: incoming.audit || [] };
      } else {
        db.items = db.items.concat(incoming.items || []);
        db.audit = db.audit.concat(incoming.audit || []);
      }
      log('data.import', { merge: !!merge, items: (incoming.items || []).length });
      persist();
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

  var Storage = { createStore: createStore, uid: uid };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Storage;
  } else {
    global.FreshStorage = Storage;
  }
})(typeof window !== 'undefined' ? window : this);
