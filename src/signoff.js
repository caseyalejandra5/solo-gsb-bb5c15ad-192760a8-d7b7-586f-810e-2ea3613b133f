'use strict';

/**
 * 交接双方签收引擎。
 *
 * 每条交接记录可由「交出者」「接收者」分别输入自己的姓名签收确认：
 * - 姓名须匹配该条记录的对应角色（交出者 / 接收者），两侧状态独立、各自持久保存；
 * - 页面提交确认时携带当前记录内容指纹（道具、分钟、双方姓名、备注），
 *   服务端逐项核对一致后才写入；记录被编辑后指纹改变，旧签收立即失效（STALE），
 *   过期页面的确认请求被拒绝；记录被删除时其签收记录级联清理。
 *
 * 「已核实交接链」：按道具与截止分钟，沿现有同分钟唯一链规则重放，
 * 只有双方均有效签收的记录才可延伸已核实链；遇首条缺签或与原链冲突的记录即停止，
 * 返回阻断记录及此前最后已核实持有人，阻断之后的记录不计入已核实。
 */

const crypto = require('crypto');
const { WAREHOUSE, CONFLICT, sortRecords } = require('./verify');

/** 签收方 */
const SIDE = { FROM: 'from', TO: 'to' };

/** 单侧签收状态 */
const SIGN_STATUS = {
  UNSIGNED: 'UNSIGNED', // 未签收
  VALID: 'VALID',       // 已签收且指纹与当前记录一致（有效）
  STALE: 'STALE',       // 签收过，但记录已被编辑，指纹不匹配（已失效）
};

/** 已核实链阻断类型 */
const BLOCK = {
  MISSING_SIGNOFF: 'MISSING_SIGNOFF', // 首条可接续记录缺少双方有效签收
  CHAIN_CONFLICT: 'CHAIN_CONFLICT',   // 与原有交接链冲突（同分钟唯一链规则）
};

/**
 * 记录内容指纹：覆盖道具、分钟、双方姓名与备注。
 * 页面提交签收确认时携带该指纹，服务端核对一致才写入；
 * 记录被编辑后指纹改变，旧签收与过期页面的确认请求即失效。
 */
function recordFingerprint(record) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        propId: record.propId,
        minute: record.minute,
        from: record.from,
        to: record.to,
        note: record.note || '',
      })
    )
    .digest('hex');
}

/**
 * 单条记录的双方签收状态。
 * @returns {{from: {status: string, signoff: object|null},
 *            to: {status: string, signoff: object|null}, complete: boolean}}
 *          complete 为 true 表示两侧均为有效签收
 */
function recordSignoffStatus(record, signoffs) {
  const fingerprint = recordFingerprint(record);
  const sides = {};
  for (const side of [SIDE.FROM, SIDE.TO]) {
    const signoff =
      (signoffs || []).find((s) => s.recordId === record.id && s.side === side) || null;
    let status = SIGN_STATUS.UNSIGNED;
    if (signoff) {
      status = signoff.fingerprint === fingerprint ? SIGN_STATUS.VALID : SIGN_STATUS.STALE;
    }
    sides[side] = { status, signoff };
  }
  return {
    from: sides[SIDE.FROM],
    to: sides[SIDE.TO],
    complete:
      sides[SIDE.FROM].status === SIGN_STATUS.VALID &&
      sides[SIDE.TO].status === SIGN_STATUS.VALID,
  };
}

function describeRecord(r) {
  const note = r.note ? `（${r.note}）` : '';
  return `第${r.minute}分钟：${r.from} → ${r.to}${note}`;
}

/**
 * 已核实交接链：沿现有同分钟唯一链规则重放该道具 minute <= cutoffMinute 的记录，
 * 只有双方均有效签收的记录才可延伸已核实链；遇首条缺签或与原链冲突的记录即停止。
 *
 * @param {{props: Array, records: Array, signoffs: Array}} data 当前数据（只读）
 * @param {object} prop 目标道具
 * @param {number} cutoffMinute 截止分钟（含，该分钟全部交接先归约完毕）
 * @returns {{propId: string, propName: string, cutoffMinute: number, holder: string,
 *            returned: boolean, chain: Array, verifiedCount: number,
 *            consideredCount: number, laterCount: number, blocked: object|null}}
 *          holder 为最后已核实持有人；blocked 非空表示链被阻断
 *          （含阻断类型、分钟、阻断记录编号与原因），阻断之后的记录不计入已核实
 */
function buildVerifiedChain(data, prop, cutoffMinute) {
  const all = (data.records || []).filter((r) => r.propId === prop.id);
  const considered = sortRecords(all.filter((r) => Number(r.minute) <= cutoffMinute));
  const signoffs = data.signoffs || [];

  const chain = [];
  let holder = WAREHOUSE;
  let blocked = null;
  let i = 0;

  while (!blocked && i < considered.length) {
    const minute = considered[i].minute;

    // 本分钟全部记录，作为尚未使用的有向边集合（与核验引擎同一规则）
    let pool = [];
    while (i < considered.length && considered[i].minute === minute) {
      pool.push(considered[i]);
      i += 1;
    }

    // 同一分钟内从当前已核实持有人沿「唯一出边」反复归约，与录入顺序无关
    while (!blocked && pool.length > 0) {
      const continuable = pool.filter((r) => r.from === holder);

      if (continuable.length === 0) {
        blocked = {
          type: BLOCK.CHAIN_CONFLICT,
          conflictType: CONFLICT.BROKEN,
          minute,
          holder,
          records: pool.map((r) => r.id),
          reason:
            `第${minute}分钟最后已核实持有人为「${holder}」，但该分钟尚未执行的交接记录为` +
            `${pool.map(describeRecord).join('；')}——交出者均不是「${holder}」，` +
            `与原有交接链冲突（断链），已核实链在此阻断，本分钟剩余记录及之后的记录均不计入已核实。`,
        };
        break;
      }

      if (continuable.length > 1) {
        blocked = {
          type: BLOCK.CHAIN_CONFLICT,
          conflictType: CONFLICT.AMBIGUOUS,
          minute,
          holder,
          records: continuable.map((r) => r.id),
          reason:
            `第${minute}分钟最后已核实持有人为「${holder}」，同时存在 ${continuable.length} 条` +
            `交出者为「${holder}」的可接续记录（${continuable
              .map((r) => `${r.from} → ${r.to}`)
              .join('；')}），与原有交接链冲突（链不唯一），已核实链在此阻断，之后的记录均不计入已核实。`,
        };
        break;
      }

      const rec = continuable[0];
      const st = recordSignoffStatus(rec, signoffs);
      if (!st.complete) {
        const missing = [
          ...(st.from.status !== SIGN_STATUS.VALID ? [SIDE.FROM] : []),
          ...(st.to.status !== SIGN_STATUS.VALID ? [SIDE.TO] : []),
        ];
        const missingText = missing
          .map((s) => (s === SIDE.FROM ? '交出者' : '接收者'))
          .join('、');
        blocked = {
          type: BLOCK.MISSING_SIGNOFF,
          minute: rec.minute,
          holder,
          records: [rec.id],
          missing,
          reason:
            `第${rec.minute}分钟的交接记录（${rec.from} → ${rec.to}）缺少有效签收` +
            `（${missingText}未签收或签收已失效），已核实链在此阻断，` +
            `该记录及之后的记录均不计入已核实。`,
        };
        break;
      }

      chain.push(rec);
      holder = rec.to;
      pool = pool.filter((r) => r.id !== rec.id); // 该边已使用
    }
  }

  return {
    propId: prop.id,
    propName: prop.name,
    cutoffMinute,
    holder,
    returned: holder === WAREHOUSE,
    chain,
    verifiedCount: chain.length,
    consideredCount: considered.length,
    laterCount: all.length - considered.length,
    blocked,
  };
}

module.exports = {
  SIDE,
  SIGN_STATUS,
  BLOCK,
  recordFingerprint,
  recordSignoffStatus,
  buildVerifiedChain,
};
