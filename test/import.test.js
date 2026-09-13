/* freshkeeper/test/import.test.js —— 导入结构校验 / 加载防御迁移 */
const test = require('node:test');
const assert = require('node:assert');
const Storage = require('../js/storage');

function memBackend() {
  let s = {};
  return {
    getItem: k => (s[k] === undefined ? null : s[k]),
    setItem: (k, v) => { s[k] = String(v); },
    _raw: () => s['freshkeeper:v1']
  };
}

const VALID_ITEM = { name: '菠菜', purchaseDate: '2026-09-10', packageType: 'loose', location: 'fridge' };

test('合法 JSON 字符串/对象均可导入（合并）', () => {
  const b = memBackend();
  const st = Storage.createStore(b);
  st.addItem({ name: '原有', purchaseDate: '2026-09-11', packageType: 'sealed', location: 'fridge' });
  const r = st.importJSON(JSON.stringify({ items: [VALID_ITEM], audit: [] }), true);
  assert.equal(r.items, 1);
  assert.equal(st.listItems().length, 2);
});

test('缺少 items 结构：拒绝且不写入', () => {
  const st = Storage.createStore(memBackend());
  assert.throws(() => st.importJSON({ foo: 1 }, true), /items/);
  assert.throws(() => st.importJSON('[1,2,3]', true), /数据对象/);
  assert.throws(() => st.importJSON('not-json', true), /JSON|JSON/i);
  assert.equal(st.listItems().length, 0);
});

test('单条记录缺必要字段（名称/购买日期/位置/包装）整体拒绝', () => {
  const st = Storage.createStore(memBackend());
  const bad = [
    { purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' },          // 缺 name
    { name: '肉', packageType: 'sealed', location: 'fridge' },                            // 缺 purchaseDate
    { name: '肉', purchaseDate: '2026-13-40', packageType: 'sealed', location: 'fridge' }, // 非法日期
    { name: '肉', purchaseDate: '2026-09-10', packageType: 'sealed', location: '阳台' },   // 非法位置
    { name: '肉', purchaseDate: '2026-09-10', packageType: '真空', location: 'fridge' },   // 非法包装
    '一条字符串', null, 42
  ];
  bad.forEach(rec => {
    assert.throws(() => st.importJSON({ items: [rec] }, true), /结构|缺少|非法|对象/);
  });
  assert.equal(st.listItems().length, 0);
});

test('畸形事件/修订结构被拒绝（不静默吞掉）', () => {
  const st = Storage.createStore(memBackend());
  assert.throws(() => st.importJSON({ items: [Object.assign({}, VALID_ITEM, { events: '已开封' })] }, true), /events/);
  assert.throws(() => st.importJSON({ items: [Object.assign({}, VALID_ITEM, { events: [{ type: '未知', at: '2026-09-11' }] })] }, true), /事件类型/);
  assert.throws(() => st.importJSON({ items: [Object.assign({}, VALID_ITEM, { events: [{ type: 'open' }] })] }, true), /日期/);
  assert.throws(() => st.importJSON({ items: [Object.assign({}, VALID_ITEM, { revisions: {} })] }, true), /revisions/);
});

test('原子性：多条中只有一条非法时全部不写入，已有库存不变', () => {
  const b = memBackend();
  const st = Storage.createStore(b);
  st.addItem({ name: '原有牛奶', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' });
  const before = st.exportJSON();
  assert.throws(() => st.importJSON({ items: [
    { name: '好蛋', purchaseDate: '2026-09-01', packageType: 'sealed', location: 'fridge' },
    { name: '坏肉', purchaseDate: 'not-a-date', packageType: 'sealed', location: 'fridge' }
  ] }, true), /1 处/);
  assert.equal(st.listItems().length, 1);
  assert.equal(st.listItems()[0].name, '原有牛奶');
  assert.equal(st.exportJSON(), before, '拒绝后存储应完全不变');
});

test('覆盖模式遇到非法数据也不能清空现有库存', () => {
  const st = Storage.createStore(memBackend());
  st.addItem({ name: '不能被清掉', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' });
  assert.throws(() => st.importJSON({ items: [{ name: '坏' }] }, false));
  assert.equal(st.listItems().length, 1);
  assert.equal(st.listItems()[0].name, '不能被清掉');
});

test('同一文件内/与现有库存重复 ID 拒绝合并', () => {
  const st = Storage.createStore(memBackend());
  st.importJSON({ items: [{ id: 'X1', name: 'A', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' }] }, true);
  assert.throws(() => st.importJSON({ items: [{ id: 'X1', name: 'B', purchaseDate: '2026-09-11', packageType: 'sealed', location: 'fridge' }] }, true), /ID/);
  assert.throws(() => st.importJSON({ items: [
    { id: 'Y', name: 'A', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' },
    { id: 'Y', name: 'B', purchaseDate: '2026-09-11', packageType: 'sealed', location: 'fridge' }
  ] }, true), /重复/);
});

test('导入记录缺少 id/events/revisions 时自动补全为可用结构', () => {
  const clean = Storage.validatePayload({ items: [Object.assign({}, VALID_ITEM, {
    events: [{ type: 'open', at: '2026-09-11' }],
    revisions: undefined
  })] });
  const it = clean.items[0];
  assert.ok(it.id);
  assert.ok(Array.isArray(it.events) && it.events[0].id);
  assert.ok(Array.isArray(it.revisions));
  assert.equal(it.events[0].type, 'open');
});

test('加载旧版脏数据时宽松迁移：核心字段合法则保留并归一化，页面不崩', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({
    items: [
      { id: 'a', name: '好记录', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge', events: null, revisions: null },
      { id: 'b', name: '缺日期', location: 'fridge', packageType: 'sealed' },
      '字符串', null,
      { id: 'c', name: '位置错', purchaseDate: '2026-09-10', packageType: 'sealed', location: '阳台' },
      { id: 'd', name: '畸形事件', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge',
        events: [{ type: 'open', at: '2026-09-11' }, '坏事件', { type: 'bad', at: 'x' }] }
    ],
    audit: [{ action: 'item.create' }, null, 'junk']
  }));
  const st = Storage.createStore(b);
  const items = st.listItems(true);
  assert.equal(items.length, 3);                       // 缺日期/字符串/null 被跳过
  assert.deepEqual(items.map(i => i.id).sort(), ['a', 'c', 'd']);
  assert.ok(Array.isArray(st.getItem('a').events));    // null 归一化
  assert.equal(st.getItem('c').location, 'fridge');    // 非法位置兜底
  assert.equal(st.getItem('d').events.length, 1);      // 有效事件保留
  assert.equal(st.auditEntries().length, 1);

  // 引擎可正常评估迁移后的每条记录（复现渲染崩溃场景）
  const Engine = require('../js/engine');
  assert.doesNotThrow(() => items.forEach(i => Engine.assess(i)));

  // 已回写为干净结构
  const reparsed = JSON.parse(b._raw());
  assert.ok(reparsed.items.every(x => x && typeof x === 'object' && Array.isArray(x.events)));
});

test('本地 JSON 完全损坏时降级为空库存而非抛错', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', '{损坏的json');
  assert.doesNotThrow(() => Storage.createStore(b));
  assert.equal(Storage.createStore(b).listItems().length, 0);
});
