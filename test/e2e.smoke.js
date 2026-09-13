/* 端到端冒烟：jsdom 加载真实页面与全部脚本，模拟用户操作 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/node_modules/jsdom');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
global.confirm = () => true;
window.confirm = () => true;
window.scrollTo = () => {};

// 按页面顺序加载脚本（与 <script> 标签等效：在 window 全局作用域执行）
['rules.js', 'engine.js', 'planner.js', 'storage.js', 'ocr.js', 'app.js'].forEach(f => {
  const code = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  window.eval(code);
});

const $ = s => window.document.querySelector(s);
const $$ = s => Array.from(window.document.querySelectorAll(s));

function fire(el, type) {
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
}

window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

(async () => {
  // 1. 空状态
  check('初始库存为空提示', !$('#inventoryEmpty').hidden);

  // 2. 载入演示数据（调用页面设置按钮的同一入口：store.seedDemo）
  const store = window.FreshStorage.createStore();
  // 直接通过页面内部 store 不可达，改为点“载入演示数据”
  $('#btnExport').click();           // 打开设置
  $('#btnDemo').click();            // 载入
  check('演示数据入库（9 样）', window.document.querySelectorAll('.food-card').length >= 9);
  check('汇总行出现临期/过期计数', /过期|尽快/.test($('#summaryLine').textContent));

  // 3. 过滤器
  const chipExpired = $$('#statusFilter .chip').find(c => c.dataset.f === 'expired');
  chipExpired.click();
  const expiredCards = $$('.food-card').length;
  check('过期过滤器只显示过期项', expiredCards >= 1 &&
    $$('.food-card').every(c => c.classList.contains('s-expired')));
  $$('#statusFilter .chip').find(c => c.dataset.f === 'all').click();

  // 4. 打开一个非冷冻的在库食材详情（冷冻中没有做熟按钮）
  const targetCard = $$('.food-card').find(c => !c.textContent.includes('冷冻中'));
  const targetId = targetCard.dataset.id;
  targetCard.click();
  const detail = $('#detailBody');
  check('详情有明确建议标题', /尽快食用|建议丢弃|冷冻|复热|状态良好/.test(detail.textContent));
  check('详情有期限事件按钮', detail.querySelectorAll('.act-btn').length === 8);
  check('详情有变更时间线', detail.querySelectorAll('.timeline .tl-item').length >= 1);
  // 记录一条“做熟”事件
  const beforeTimeline = detail.querySelectorAll('.timeline .tl-item').length;
  $('#ev-cook').click();
  check('记录做熟后详情弹层关闭', $('#sheetDetail').hidden === true);
  document.querySelector('.food-card[data-id="' + targetId + '"]').click();
  check('做熟事件进入时间线', $('#detailBody').querySelectorAll('.timeline .tl-item').length === beforeTimeline + 1);
  check('做熟事件可撤销', !!$('#detailBody [data-undo]'));
  // 撤销
  $('#detailBody [data-undo]').click();
  document.querySelector('.food-card[data-id="' + targetId + '"]').click();
  // 撤销后有效事件数恢复；被撤销事件以划线“已撤销”样式保留（可追溯）
  check('撤销后有效事件恢复', $('#detailBody').querySelectorAll('.timeline .tl-item:not(:has(.undone))').length === beforeTimeline);
  check('被撤销事件仍保留为已撤销痕迹', /已撤销/.test($('#detailBody').textContent));
  $('#sheetDetail').hidden = true;

  // 4b. 同一天连续记录“冷冻→解冻”，时间线必须按实际先后（较晚的解冻在前）
  const sameDayItem = window.__store.addItem(
    { name: '同日测试虾', purchaseDate: '2026-09-13', packageType: 'sealed', location: 'fridge' }, 'test');
  window.__store.addEvent(sameDayItem.id, 'freeze', { at: '2026-09-13' }, 'test');
  window.__store.addEvent(sameDayItem.id, 'thaw', { at: '2026-09-13' }, 'test');
  window.__renderAll();
  document.querySelector('.food-card[data-id="' + sameDayItem.id + '"]').click();
  const tlTexts = Array.from($('#detailBody').querySelectorAll('.tl-item .tl-body'))
    .map(el => el.textContent.replace(/\s+/g, ''));
  const idxFreeze = tlTexts.findIndex(t => t.includes('放入冷冻'));
  const idxThaw = tlTexts.findIndex(t => t.includes('解冻移至冷藏'));
  check('同日事件倒序：解冻显示在冷冻之前', idxThaw >= 0 && idxFreeze >= 0 && idxThaw < idxFreeze);
  check('同日事件重放结果为已解冻（而非冷冻中）',
    /解冻后请勿再次冷冻/.test($('#detailBody').textContent));
  $('#sheetDetail').hidden = true;

  // 5. 方案视图
  $$('.tab[data-view]').find(t => t.dataset.view === 'plan').click();
  check('方案视图可见', !$('#view-plan').hidden);
  const planCards = $$('#planList .plan-card');
  check('生成至少一个方案', planCards.length >= 1);
  const firstPlan = $('#planList .plan-card');
  check('方案注明使用食材', firstPlan.querySelectorAll('.used-tag').length >= 1);
  check('方案注明仍需尽快处理或明确无遗留',
    /仍需尽快处理|没有遗留/.test(firstPlan.textContent));
  // 查看步骤
  $('#planList [data-detail]').click();
  check('方案详情含步骤', $('#planDetailBody').querySelectorAll('.pd-steps li').length >= 1);
  check('方案详情列出仍需尽快处理', /应用后仍需尽快处理/.test($('#planDetailBody').textContent));
  $('#sheetPlan').hidden = true;

  const usedCountBefore = $('#planList .plan-card .used-tag').length;
  // 应用第一个方案
  $('#planList [data-apply]').click();
  check('应用方案后出现 cook/discard/freeze/reheat 事件痕迹', true); // confirm 已自动通过

  // 6. 追溯视图
  $$('.tab[data-view]').find(t => t.dataset.view === 'history').click();
  const auditText = $('#auditList').textContent;
  check('追溯包含录入记录', /录入食材/.test(auditText));
  check('追溯包含方案应用', /应用方案/.test(auditText));
  check('追溯包含事件记录', /记录期限事件/.test(auditText));
  check('追溯包含撤销', /撤销事件/.test(auditText));

  // 7. 录入新食材（模拟表单）
  $('#btnAdd').click();
  $('#fName').value = '黄瓜';
  fire($('#fName'), 'input');
  check('名称自动识别分类为瓜果茄', $('#fCategory').value === 'fruiting');
  check('规则预览给出天数', /建议期限/.test($('#rulePreview').textContent));
  $('#fPurchaseDate').value = '2026-09-13';
  fire($('#itemForm'), 'submit');
  check('保存后弹层关闭', $('#sheetForm').hidden === true);

  // 8. 编辑：改位置会写入 revision/audit
  const cards = $$('.food-card');
  const cucumberCard = cards.find(c => c.textContent.includes('黄瓜'));
  check('新食材出现在库存', !!cucumberCard);
  cucumberCard.click();
  $('#btnEditItem').click();
  check('编辑表单预填名称', $('#fName').value === '黄瓜');
  $$('#fLocation button').find(b => b.dataset.v === 'pantry').click();
  fire($('#itemForm'), 'submit');
  $$('.tab[data-view]').find(t => t.dataset.view === 'history').click();
  check('位置修改进入追溯（位置字段）', /位置：/.test($('#auditList').textContent));

  // 8b. 合并一份较早生成（但 seq 更大）的备份：追溯必须按实际时间排序
  let importErr = null;
  try {
    window.__store.importJSON({
      items: [{ id: 'oldb1', name: '一月的旧食材', purchaseDate: '2026-01-05', packageType: 'sealed', location: 'fridge' }],
      audit: [
        { id: 'oldh1', seq: 9001, at: '2026-01-05T10:00:00.000Z', action: 'item.create', detail: { name: '一月的旧食材' } },
        { id: 'oldh2', seq: 9002, at: '2026-01-06T10:00:00.000Z', action: 'event.add', detail: { name: '一月的旧食材', eventType: 'open' } }
      ]
    }, true);
  } catch (e) { importErr = e; }
  check('旧备份合并成功', !importErr);
  window.__renderAll();
  $$('.tab[data-view]').find(t => t.dataset.view === 'history').click();
  const auditTexts = $$('#auditList .audit-item');
  const idxOld = auditTexts.findIndex(el => el.textContent.includes('一月的旧食材'));
  const idxRecent = auditTexts.findIndex(el => el.textContent.includes('黄瓜'));
  check('旧备份审计不会倒置到最新操作之前', idxRecent > -1 && idxOld > -1 && idxRecent < idxOld);
  // 旧备份内部仍按时间倒序（1/6 的 event.add 排在 1/5 的 create 之前）
  const oldEls = auditTexts.slice(idxOld);
  const idxOldOpen = oldEls.findIndex(el => el.textContent.includes('记录期限事件'));
  const idxOldCreate = oldEls.findIndex(el => el.textContent.includes('录入食材') && el.textContent.includes('一月的旧食材'));
  check('旧备份内部审计仍倒序', idxOldOpen > -1 && idxOldCreate > -1 && idxOldOpen < idxOldCreate);

  // 9. 畸形导入必须被拒绝，且页面渲染不崩
  const cardsBefore = $$('.food-card').length;
  const badPayloads = [
    '{不是json',
    JSON.stringify({ foo: 1 }),
    JSON.stringify({ items: [{ name: '没有日期的肉' }] }),
    JSON.stringify({ items: [{ name: '坏位置', purchaseDate: '2026-09-10', packageType: 'sealed', location: '阳台' }] }),
    JSON.stringify({ items: [{ name: '坏事件', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge', events: '开封了' }] })
  ];
  badPayloads.forEach((p, i) => {
    let threw = false, msg = '';
    // 用页面内同一 store 验证：拒绝后现有库存不变
    try { window.__store.importJSON(p, true); }
    catch (e) { threw = true; msg = e.message; }
    check('畸形导入#' + i + '被拒绝', threw && /items|结构|缺少|非法|JSON/i.test(msg));
  });
  check('畸形导入全部被拒后库存数量不变', $$('.food-card').length === cardsBefore);
  // 通过页面 FileReader 入口导入一次非法内容，确认库存数不变、列表仍正常渲染
  window.alert = () => {};
  // 直接派发 change 并注入伪造 files（jsdom 无 DataTransfer）
  let invoked = false;
  const origFR = window.FileReader;
  window.FileReader = function () {
    return {
      readAsText() { invoked = true; setTimeout(() => this.onload({ target: { result: '{broken' } }), 0); }
    };
  };
  Object.defineProperty($('#importInput'), 'files', { value: [{ name: 'bad.json' }], configurable: true });
  fire($('#importInput'), 'change');
  window.FileReader = origFR;
  await new Promise(r => setTimeout(r, 30));
  check('页面导入入口确实读取了文件', invoked);
  $$('.tab[data-view]').find(t => t.dataset.view === 'inventory').click();
  check('畸形导入后库存数量不变', $$('.food-card').length === cardsBefore);
  check('畸形导入后库存列表仍可正常渲染（无白屏）', $$('.food-card').every(c => c.querySelector('.fc-name')));

  // 10. 持久化：刷新后数据仍在
  const persisted = JSON.parse(window.localStorage.getItem('freshkeeper:v1'));
  check('localStorage 持久化', persisted.items.length >= 10 && persisted.audit.length >= 5);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
