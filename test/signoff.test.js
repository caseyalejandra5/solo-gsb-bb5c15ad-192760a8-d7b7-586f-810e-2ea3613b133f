'use strict';

/* 交接双方签收引擎单元测试：node test/signoff.test.js */

const assert = require('assert');
const {
  recordFingerprint,
  recordSignoffStatus,
  buildVerifiedChain,
} = require('../src/signoff');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;

function rec(propId, minute, from, to, note = '') {
  seq += 1;
  return { id: `r${seq}`, propId, minute, from, to, note, createdAt: 1000 + seq };
}

function sign(record, side, overrides = {}) {
  seq += 1;
  return {
    id: `s${seq}`,
    recordId: record.id,
    side,
    name: side === 'from' ? record.from : record.to,
    fingerprint: recordFingerprint(record),
    signedAt: 5000 + seq,
    ...overrides,
  };
}

function signBoth(record) {
  return [sign(record, 'from'), sign(record, 'to')];
}

function mkData(props, records, signoffs = []) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: 100 + i })),
    records,
    signoffs,
  };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 内容指纹覆盖道具、分钟、双方姓名与备注：任一字段变化指纹即变
test('指纹：道具、分钟、双方姓名、备注任一变化即改变', () => {
  const r = rec('p0', 3, '张三', '李四', '侧台');
  const base = recordFingerprint(r);
  assert.strictEqual(recordFingerprint(r), base); // 同内容稳定
  assert.notStrictEqual(recordFingerprint({ ...r, propId: 'p9' }), base);
  assert.notStrictEqual(recordFingerprint({ ...r, minute: 4 }), base);
  assert.notStrictEqual(recordFingerprint({ ...r, from: '王五' }), base);
  assert.notStrictEqual(recordFingerprint({ ...r, to: '王五' }), base);
  assert.notStrictEqual(recordFingerprint({ ...r, note: '改备注' }), base);
  // 空备注与缺省备注视为一致
  const noNote = rec('p0', 3, '张三', '李四');
  delete noNote.note;
  assert.strictEqual(recordFingerprint(noNote), recordFingerprint({ ...noNote, note: '' }));
});

// 2. 单侧状态判定：未签 / 有效 / 失效，两侧独立
test('签收状态：未签 / 有效 / 失效，两侧独立判定', () => {
  const r = rec('p0', 3, '张三', '李四');
  let st = recordSignoffStatus(r, []);
  assert.strictEqual(st.from.status, 'UNSIGNED');
  assert.strictEqual(st.to.status, 'UNSIGNED');
  assert.strictEqual(st.complete, false);

  // 仅交出者签收：另一侧仍未签，complete 为 false
  st = recordSignoffStatus(r, [sign(r, 'from')]);
  assert.strictEqual(st.from.status, 'VALID');
  assert.strictEqual(st.to.status, 'UNSIGNED');
  assert.strictEqual(st.complete, false);

  // 双方签收：complete
  st = recordSignoffStatus(r, signBoth(r));
  assert.strictEqual(st.complete, true);

  // 记录被编辑（指纹不匹配）：旧签收失效
  const edited = { ...r, note: '改过的备注' };
  st = recordSignoffStatus(edited, signBoth(r));
  assert.strictEqual(st.from.status, 'STALE');
  assert.strictEqual(st.to.status, 'STALE');
  assert.strictEqual(st.complete, false);
});

// 3. 已核实链：双方签收的记录依次延伸，返回最后已核实持有人
test('已核实链：双方有效签收的记录依次延伸至归仓', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三');
  const r2 = rec('p0', 3, '张三', '李四');
  const r3 = rec('p0', 8, '李四', WAREHOUSE);
  const data = mkData(['剑'], [r1, r2, r3], [...signBoth(r1), ...signBoth(r2), ...signBoth(r3)]);
  const result = buildVerifiedChain(data, data.props[0], 8);
  assert.strictEqual(result.blocked, null);
  assert.strictEqual(result.verifiedCount, 3);
  assert.deepStrictEqual(result.chain.map((r) => r.id), [r1.id, r2.id, r3.id]);
  assert.strictEqual(result.holder, WAREHOUSE);
  assert.strictEqual(result.returned, true);
  assert.strictEqual(result.consideredCount, 3);
  assert.strictEqual(result.laterCount, 0);
});

// 4. 首条记录即缺签：链在起点阻断，最后已核实持有人为仓库
test('已核实链：首条缺签即阻断，持有人仍为仓库', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三');
  const r2 = rec('p0', 3, '张三', WAREHOUSE);
  const data = mkData(['剑'], [r1, r2], signBoth(r2)); // r1 未签，r2 已签也不计入
  const result = buildVerifiedChain(data, data.props[0], 3);
  assert.strictEqual(result.verifiedCount, 0);
  assert.strictEqual(result.holder, WAREHOUSE);
  assert.strictEqual(result.blocked.type, 'MISSING_SIGNOFF');
  assert.strictEqual(result.blocked.minute, 0);
  assert.deepStrictEqual(result.blocked.records, [r1.id]);
  assert.deepStrictEqual(result.blocked.missing, ['from', 'to']);
});

// 5. 中间记录单侧缺签：链在此前阻断，阻断后记录不计入
test('已核实链：中间记录仅单侧签收即阻断，后续不计入', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三');
  const r2 = rec('p0', 3, '张三', '李四');
  const r3 = rec('p0', 8, '李四', WAREHOUSE);
  const data = mkData(
    ['剑'],
    [r1, r2, r3],
    [...signBoth(r1), sign(r2, 'from'), ...signBoth(r3)] // r2 缺接收者签收
  );
  const result = buildVerifiedChain(data, data.props[0], 8);
  assert.strictEqual(result.verifiedCount, 1);
  assert.deepStrictEqual(result.chain.map((r) => r.id), [r1.id]);
  assert.strictEqual(result.holder, '张三'); // 阻断前最后已核实持有人
  assert.strictEqual(result.blocked.type, 'MISSING_SIGNOFF');
  assert.deepStrictEqual(result.blocked.records, [r2.id]);
  assert.deepStrictEqual(result.blocked.missing, ['to']);
});

// 6. 记录被编辑后旧签收失效：视同缺签阻断
test('已核实链：记录被编辑后旧签收失效，视同缺签阻断', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三');
  const r2 = rec('p0', 3, '张三', WAREHOUSE);
  const signoffs = [...signBoth(r1), ...signBoth(r2)];
  // r2 的分钟被修改：其签收指纹不再匹配
  const r2Edited = { ...r2, minute: 4 };
  const data = mkData(['剑'], [r1, r2Edited], signoffs);
  const result = buildVerifiedChain(data, data.props[0], 8);
  assert.strictEqual(result.verifiedCount, 1);
  assert.strictEqual(result.holder, '张三');
  assert.strictEqual(result.blocked.type, 'MISSING_SIGNOFF');
  assert.deepStrictEqual(result.blocked.records, [r2.id]);
});

// 7. 与原链冲突（断链）：即使记录双方已签，也无法接续，阻断并返回阻断记录
test('已核实链：断链冲突即阻断，后续已签记录不计入', () => {
  const r1 = rec('p0', 2, WAREHOUSE, '王五');
  const r2 = rec('p0', 4, '李四', '钱七'); // 当前持有人是王五，交出者对不上
  const r3 = rec('p0', 9, '钱七', WAREHOUSE);
  const data = mkData(
    ['灯'],
    [r1, r2, r3],
    [...signBoth(r1), ...signBoth(r2), ...signBoth(r3)]
  );
  const result = buildVerifiedChain(data, data.props[0], 9);
  assert.strictEqual(result.verifiedCount, 1);
  assert.strictEqual(result.holder, '王五');
  assert.strictEqual(result.blocked.type, 'CHAIN_CONFLICT');
  assert.strictEqual(result.blocked.conflictType, 'BROKEN');
  assert.strictEqual(result.blocked.minute, 4);
  assert.deepStrictEqual(result.blocked.records, [r2.id]); // 第 4 分钟池内仅 r2
});

// 8. 与原链冲突（同分钟多条可接续）：歧义阻断
test('已核实链：同分钟多条可接续（歧义）即阻断', () => {
  const r1 = rec('p0', 1, WAREHOUSE, '张三');
  const r2 = rec('p0', 5, '张三', '王五');
  const r3 = rec('p0', 5, '张三', '赵六');
  const data = mkData(
    ['扇'],
    [r1, r2, r3],
    [...signBoth(r1), ...signBoth(r2), ...signBoth(r3)]
  );
  const result = buildVerifiedChain(data, data.props[0], 5);
  assert.strictEqual(result.verifiedCount, 1);
  assert.strictEqual(result.holder, '张三');
  assert.strictEqual(result.blocked.type, 'CHAIN_CONFLICT');
  assert.strictEqual(result.blocked.conflictType, 'AMBIGUOUS');
  assert.deepStrictEqual(result.blocked.records.sort(), [r2.id, r3.id].sort());
});

// 9. 同分钟链式交接（A→B、B→C 同分钟，倒序录入）均签收可依次延伸
test('已核实链：同分钟链式交接倒序录入仍可依次延伸', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三');
  const r2 = rec('p0', 5, '李四', '王五'); // 先录入的 B→C
  const r3 = rec('p0', 5, '张三', '李四'); // 后录入的 A→B
  const data = mkData(
    ['剑'],
    [r1, r2, r3],
    [...signBoth(r1), ...signBoth(r2), ...signBoth(r3)]
  );
  const result = buildVerifiedChain(data, data.props[0], 5);
  assert.strictEqual(result.blocked, null);
  assert.strictEqual(result.verifiedCount, 3);
  assert.deepStrictEqual(result.chain.map((r) => r.id), [r1.id, r3.id, r2.id]);
  assert.strictEqual(result.holder, '王五');
});

// 10. 截止分钟过滤：晚于截止的记录不参与，不计入 considered
test('已核实链：截止分钟后的记录不参与重放', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三');
  const r2 = rec('p0', 3, '张三', '李四');
  const r3 = rec('p0', 8, '李四', WAREHOUSE);
  const data = mkData(['剑'], [r1, r2, r3], [...signBoth(r1), ...signBoth(r2), ...signBoth(r3)]);
  const result = buildVerifiedChain(data, data.props[0], 3);
  assert.strictEqual(result.blocked, null);
  assert.strictEqual(result.verifiedCount, 2);
  assert.strictEqual(result.holder, '李四');
  assert.strictEqual(result.returned, false);
  assert.strictEqual(result.consideredCount, 2);
  assert.strictEqual(result.laterCount, 1);
});

// 11. 阻断分钟之后的记录一律不计入（即使双方已签且能接续）
test('已核实链：阻断之后的记录不计入已核实', () => {
  const r1 = rec('p0', 0, WAREHOUSE, '张三');
  const r2 = rec('p0', 3, '张三', '李四'); // 未签收 -> 阻断点
  const r3 = rec('p0', 8, '李四', WAREHOUSE); // 双方已签，但在阻断之后
  const data = mkData(['剑'], [r1, r2, r3], [...signBoth(r1), ...signBoth(r3)]);
  const result = buildVerifiedChain(data, data.props[0], 8);
  assert.strictEqual(result.verifiedCount, 1);
  assert.strictEqual(result.holder, '张三');
  assert.strictEqual(result.blocked.type, 'MISSING_SIGNOFF');
  assert.deepStrictEqual(result.blocked.records, [r2.id]);
});

// 12. 无记录道具：链为空、持有人为仓库、无阻断
test('已核实链：无交接记录的道具全程在仓库', () => {
  const data = mkData(['印'], [], []);
  const result = buildVerifiedChain(data, data.props[0], 10);
  assert.strictEqual(result.blocked, null);
  assert.strictEqual(result.verifiedCount, 0);
  assert.strictEqual(result.holder, WAREHOUSE);
  assert.strictEqual(result.returned, true);
  assert.strictEqual(result.consideredCount, 0);
});

console.log(`\n全部 ${passed} 个签收引擎测试通过 ✔`);
