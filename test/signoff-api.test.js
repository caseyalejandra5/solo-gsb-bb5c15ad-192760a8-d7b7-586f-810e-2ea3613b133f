'use strict';

/* 交接双方签收 / 已核实交接链接口集成测试：node test/signoff-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-signoff-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 初始演示数据：青龙剑 p_sword 四条记录双方均已签收；
  // 御印 p_seal 第 1 条（r_se1）双方签收、第 2 条（r_se2）仅交出者签收
  const state0 = (await api('/api/state')).body;
  assert.ok(state0.recordSignoffs.r_sw1);
  assert.strictEqual(state0.recordSignoffs.r_sw1.complete, true);
  assert.strictEqual(state0.recordSignoffs.r_se1.complete, true);
  assert.strictEqual(state0.recordSignoffs.r_se2.from.status, 'VALID');
  assert.strictEqual(state0.recordSignoffs.r_se2.to.status, 'UNSIGNED');
  const rev0 = state0.rev;

  // 1. 已核实链：青龙剑双方签收齐全，截止第 12 分钟完整延伸至归仓
  await test('已核实链：双方签收齐全的道具完整延伸至归仓', async () => {
    const res = await api('/api/verified-chain?prop=p_sword&minute=12');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.blocked, null);
    assert.strictEqual(res.body.verifiedCount, 4);
    assert.strictEqual(res.body.holder, '仓库');
    assert.strictEqual(res.body.returned, true);
    assert.deepStrictEqual(
      res.body.chain.map((r) => r.id),
      ['r_sw1', 'r_sw2', 'r_sw3', 'r_sw4']
    );
  });

  // 2. 已核实链：御印第 6 分钟记录缺接收者签收 -> 阻断，返回阻断记录与此前持有人
  await test('已核实链：首条缺签即阻断，返回阻断记录与最后已核实持有人', async () => {
    const res = await api('/api/verified-chain?prop=p_seal&minute=6');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.verifiedCount, 1);
    assert.deepStrictEqual(res.body.chain.map((r) => r.id), ['r_se1']);
    assert.strictEqual(res.body.holder, '周八'); // 阻断前最后已核实持有人
    assert.strictEqual(res.body.blocked.type, 'MISSING_SIGNOFF');
    assert.strictEqual(res.body.blocked.minute, 6);
    assert.deepStrictEqual(res.body.blocked.records, ['r_se2']);
    assert.deepStrictEqual(res.body.blocked.missing, ['to']);
  });

  // 3. 道具参数支持名称；截止分钟过滤晚到的记录
  await test('已核实链：按名称查询，截止分钟后的记录不参与', async () => {
    const res = await api(`/api/verified-chain?prop=${encodeURIComponent('青龙剑')}&minute=3`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.verifiedCount, 2);
    assert.strictEqual(res.body.holder, '李四');
    assert.strictEqual(res.body.consideredCount, 2);
    assert.strictEqual(res.body.laterCount, 2);
  });

  // 4. 单侧签收成功：两侧状态独立并持久保存
  await test('签收：单侧确认成功，两侧状态独立持久保存', async () => {
    const fp = state0.recordSignoffs.r_se2.fingerprint;
    const res = await api('/api/records/r_se2/sign', {
      method: 'POST',
      body: JSON.stringify({ side: 'to', name: '孙七', fingerprint: fp }),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.side, 'to');
    assert.strictEqual(res.body.name, '孙七');
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.recordSignoffs.r_se2.complete, true); // 两侧均有效
    assert.strictEqual(after.recordSignoffs.r_se2.from.status, 'VALID'); // 原交出者签收不受影响
    assert.ok(after.signoffs.some((s) => s.recordId === 'r_se2' && s.side === 'to'));
    assert.ok(after.rev > rev0); // 签收写入会推进数据版本
    // 御印已核实链随之完整延伸
    const chain = await api('/api/verified-chain?prop=p_seal&minute=6');
    assert.strictEqual(chain.body.blocked, null);
    assert.strictEqual(chain.body.verifiedCount, 2);
    assert.strictEqual(chain.body.holder, '孙七');
  });

  // 5. 姓名须匹配对应角色：不匹配返回 400 且不写入
  await test('签收：姓名与记录角色不匹配 -> 400 且不写入', async () => {
    const before = (await api('/api/state')).body;
    const res = await api('/api/records/r_fa1/sign', {
      method: 'POST',
      body: JSON.stringify({ side: 'to', name: '李四', fingerprint: before.recordSignoffs.r_fa1.fingerprint }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/不符/.test(res.body.error));
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.recordSignoffs.r_fa1.to.status, 'UNSIGNED');
    assert.strictEqual(after.rev, before.rev);
  });

  // 6. 过期页面：指纹与当前记录不一致 -> 409 拒绝且不写入
  await test('签收：过期页面指纹不匹配 -> 409 拒绝且不写入', async () => {
    const before = (await api('/api/state')).body;
    const res = await api('/api/records/r_fa1/sign', {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '仓库', fingerprint: 'f'.repeat(64) }),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.stale, true);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.recordSignoffs.r_fa1.from.status, 'UNSIGNED');
    assert.strictEqual(after.rev, before.rev);
  });

  // 7. 记录被编辑后旧签收立即失效；过期确认请求被拒，重新签收后已核实链恢复
  await test('编辑记录：旧签收立即失效，旧指纹被拒，重新签收后链恢复', async () => {
    // 修改 r_se2 的备注 -> 两侧签收指纹均不再匹配
    const edit = await api('/api/records/r_se2', {
      method: 'PUT',
      body: JSON.stringify({ propId: 'p_seal', minute: 6, from: '周八', to: '孙七', note: '补登备注' }),
    });
    assert.strictEqual(edit.status, 200);
    let state = (await api('/api/state')).body;
    assert.strictEqual(state.recordSignoffs.r_se2.from.status, 'STALE');
    assert.strictEqual(state.recordSignoffs.r_se2.to.status, 'STALE');
    // 已核实链在 r_se2 处阻断（签收失效视同缺签）
    let chain = await api('/api/verified-chain?prop=p_seal&minute=6');
    assert.strictEqual(chain.body.blocked.type, 'MISSING_SIGNOFF');
    assert.strictEqual(chain.body.verifiedCount, 1);
    // 过期页面持旧指纹确认 -> 409
    const staleFp = state0.recordSignoffs.r_se2.fingerprint;
    const stale = await api('/api/records/r_se2/sign', {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '周八', fingerprint: staleFp }),
    });
    assert.strictEqual(stale.status, 409);
    // 页面刷新后携带新指纹，双方重新签收 -> 链恢复
    state = (await api('/api/state')).body;
    const fp = state.recordSignoffs.r_se2.fingerprint;
    for (const [side, name] of [['from', '周八'], ['to', '孙七']]) {
      const res = await api('/api/records/r_se2/sign', {
        method: 'POST',
        body: JSON.stringify({ side, name, fingerprint: fp }),
      });
      assert.strictEqual(res.status, 201);
    }
    chain = await api('/api/verified-chain?prop=p_seal&minute=6');
    assert.strictEqual(chain.body.blocked, null);
    assert.strictEqual(chain.body.verifiedCount, 2);
  });

  // 8. 记录被删除后签收记录级联清理，对其签收返回 404
  await test('删除记录：签收级联清理，对已删记录签收 -> 404', async () => {
    const before = (await api('/api/state')).body;
    assert.ok(before.signoffs.some((s) => s.recordId === 'r_se2'));
    const del = await api('/api/records/r_se2', { method: 'DELETE' });
    assert.strictEqual(del.status, 204);
    const after = (await api('/api/state')).body;
    assert.ok(!after.signoffs.some((s) => s.recordId === 'r_se2'));
    const res = await api('/api/records/r_se2/sign', {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '周八', fingerprint: 'f'.repeat(64) }),
    });
    assert.strictEqual(res.status, 404);
  });

  // 9. 参数校验：缺参 400、道具不存在 404、非法分钟 400
  await test('已核实链：参数校验与道具不存在', async () => {
    assert.strictEqual((await api('/api/verified-chain?minute=3')).status, 400);
    assert.strictEqual((await api('/api/verified-chain?prop=p_sword')).status, 400);
    assert.strictEqual((await api('/api/verified-chain?prop=p_sword&minute=-1')).status, 400);
    assert.strictEqual((await api('/api/verified-chain?prop=p_sword&minute=1.5')).status, 400);
    assert.strictEqual((await api('/api/verified-chain?prop=不存在的道具&minute=3')).status, 404);
  });

  // 10. 签收方与姓名字段校验
  await test('签收：签收方与姓名参数校验', async () => {
    const fp = (await api('/api/state')).body.recordSignoffs.r_fa1.fingerprint;
    const bad1 = await api('/api/records/r_fa1/sign', {
      method: 'POST',
      body: JSON.stringify({ side: 'middle', name: '仓库', fingerprint: fp }),
    });
    assert.strictEqual(bad1.status, 400);
    const bad2 = await api('/api/records/r_fa1/sign', {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '', fingerprint: fp }),
    });
    assert.strictEqual(bad2.status, 400);
    const bad3 = await api('/api/records/r_fa1/sign', {
      method: 'POST',
      body: JSON.stringify({ side: 'from', name: '仓库' }),
    });
    assert.strictEqual(bad3.status, 400);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个签收接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
