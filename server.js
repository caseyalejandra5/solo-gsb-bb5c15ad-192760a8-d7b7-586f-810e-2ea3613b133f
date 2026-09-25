'use strict';

const express = require('express');
const path = require('path');

const store = require('./src/store');
const { verifyAll } = require('./src/verify');
const { checkInventory } = require('./src/inventory');
const { previewBatch, hashRows } = require('./src/batch');
const { buildResponsibilitySheet } = require('./src/responsibility');
const { checkAppearances } = require('./src/appearance');
const { previewConflictFix } = require('./src/conflict-fix');
const {
  SIDE,
  recordFingerprint,
  recordSignoffStatus,
  buildVerifiedChain,
} = require('./src/signoff');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- 校验工具 ---------------- */

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function parseMinute(value, field) {
  if (value === undefined || value === null || value === '') throw new Error(`${field}不能为空`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${field}必须是不小于 0 的整数（分钟）`);
  return n;
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}不能为空`);
  return value.trim();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/* ---------------- 读取 / 核验 ---------------- */

app.get('/api/state', (req, res) => {
  // data 自带 rev（数据版本号）与 signoffs（签收记录），一并下发；
  // recordSignoffs 为每条记录的双方签收状态与当前内容指纹，供页面签收时携带核对
  const data = store.getData();
  const recordSignoffs = {};
  for (const r of data.records) {
    recordSignoffs[r.id] = { fingerprint: recordFingerprint(r), ...recordSignoffStatus(r, data.signoffs) };
  }
  res.json({ warehouse: store.WAREHOUSE, ...data, recordSignoffs, verification: verifyAll(data) });
});

app.get('/api/verify', (req, res) => {
  res.json(verifyAll(store.getData()));
});

/* ---------------- 现场盘点（只读，即时结果，不改写交接记录） ---------------- */

app.post('/api/inventory/check', asyncRoute((req, res) => {
  const body = req.body || {};

  let minute;
  try {
    minute = parseMinute(body.minute, '盘点时刻（分钟）');
  } catch (err) {
    return badRequest(res, err.message);
  }

  if (!Array.isArray(body.rows)) {
    return badRequest(res, '盘点行（rows）必须是数组');
  }
  if (body.rows.length === 0) {
    return badRequest(res, '请至少填写一行盘点记录');
  }
  if (body.rows.length > 500) {
    return badRequest(res, '单次盘点最多 500 行');
  }

  const rows = [];
  for (let i = 0; i < body.rows.length; i += 1) {
    const r = body.rows[i] || {};
    try {
      const name = nonEmpty(r.name, `第 ${i + 1} 行道具名称`);
      const holder = nonEmpty(r.holder, `第 ${i + 1} 行实物持有人`);
      if (name.length > 40) throw new Error(`第 ${i + 1} 行道具名称最长 40 个字符`);
      if (holder.length > 30) throw new Error(`第 ${i + 1} 行实物持有人最长 30 个字符`);
      rows.push({ name, holder });
    } catch (err) {
      return badRequest(res, err.message);
    }
  }

  // 纯读取 + 即时重放，不写入任何数据
  res.json(checkInventory(store.getData(), minute, rows));
}));

/* ---------------- 人员交接责任单（只读，即时结果，不改写交接记录） ---------------- */

app.get('/api/responsibility', (req, res) => {
  let person;
  let startMinute;
  let endMinute;
  try {
    person = nonEmpty(req.query.person, '人员姓名');
    if (person.length > 30) throw new Error('人员姓名最长 30 个字符');
    startMinute = parseMinute(req.query.start, '起始分钟');
    endMinute = parseMinute(req.query.end, '结束分钟');
    if (startMinute > endMinute) throw new Error('起始分钟不能大于结束分钟');
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 纯读取 + 即时重放，不写入任何数据
  res.json(buildResponsibilitySheet(store.getData(), person, startMinute, endMinute));
});

/* ---------------- 出场时段到位核对（只读，即时结果，不改写交接记录） ---------------- */

const MAX_APPEARANCE_ROWS = 500;

app.post('/api/appearance/check', asyncRoute((req, res) => {
  const body = req.body || {};

  if (!Array.isArray(body.rows)) {
    return badRequest(res, '核对行（rows）必须是数组');
  }
  if (body.rows.length === 0) {
    return badRequest(res, '请至少填写一行出场核对记录');
  }
  if (body.rows.length > MAX_APPEARANCE_ROWS) {
    return badRequest(res, `单次核对最多 ${MAX_APPEARANCE_ROWS} 行`);
  }

  const rows = [];
  for (let i = 0; i < body.rows.length; i += 1) {
    const r = body.rows[i] || {};
    try {
      const name = nonEmpty(r.name, `第 ${i + 1} 行道具名称`);
      const actor = nonEmpty(r.actor, `第 ${i + 1} 行出场演员`);
      const startMinute = parseMinute(r.startMinute, `第 ${i + 1} 行起始分钟`);
      const endMinute = parseMinute(r.endMinute, `第 ${i + 1} 行结束分钟`);
      if (name.length > 40) throw new Error(`第 ${i + 1} 行道具名称最长 40 个字符`);
      if (actor.length > 30) throw new Error(`第 ${i + 1} 行出场演员最长 30 个字符`);
      if (startMinute >= endMinute) {
        throw new Error(`第 ${i + 1} 行起始分钟必须小于结束分钟（区间左闭右开，至少覆盖 1 分钟）`);
      }
      rows.push({ name, actor, startMinute, endMinute });
    } catch (err) {
      return badRequest(res, err.message);
    }
  }

  // 纯读取 + 即时重放，不写入任何数据
  res.json(checkAppearances(store.getData(), rows));
}));

/* ---------------- 道具 CRUD ---------------- */

app.get('/api/props', (req, res) => {
  res.json(store.getData().props);
});

app.post('/api/props', asyncRoute((req, res) => {
  const body = req.body || {};
  let name;
  try {
    name = nonEmpty(body.name, '道具名称');
  } catch (err) {
    return badRequest(res, err.message);
  }
  const data = store.getData();
  if (data.props.some((p) => p.name === name)) {
    return badRequest(res, `已存在同名道具「${name}」`);
  }
  const prop = {
    id: store.newId('p'),
    name,
    note: typeof body.note === 'string' ? body.note.trim() : '',
    createdAt: Date.now(),
  };
  const props = [...data.props, prop];
  store.saveProps(props);
  res.status(201).json(prop);
}));

app.put('/api/props/:id', asyncRoute((req, res) => {
  const data = store.getData();
  const idx = data.props.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '道具不存在' });

  const body = req.body || {};
  let name;
  try {
    name = nonEmpty(body.name, '道具名称');
  } catch (err) {
    return badRequest(res, err.message);
  }
  if (data.props.some((p) => p.name === name && p.id !== req.params.id)) {
    return badRequest(res, `已存在同名道具「${name}」`);
  }
  const updated = {
    ...data.props[idx],
    name,
    note: typeof body.note === 'string' ? body.note.trim() : (data.props[idx].note || ''),
  };
  const props = data.props.map((p) => (p.id === updated.id ? updated : p));
  store.saveProps(props);
  res.json(updated);
}));

app.delete('/api/props/:id', (req, res) => {
  const data = store.getData();
  if (!data.props.some((p) => p.id === req.params.id)) {
    return res.status(404).json({ error: '道具不存在' });
  }
  // 删除道具时级联删除其全部交接记录与对应签收记录
  const removedRecordIds = new Set(
    data.records.filter((r) => r.propId === req.params.id).map((r) => r.id)
  );
  const props = data.props.filter((p) => p.id !== req.params.id);
  const records = data.records.filter((r) => r.propId !== req.params.id);
  const signoffs = (data.signoffs || []).filter((s) => !removedRecordIds.has(s.recordId));
  store.saveProps(props);
  store.saveRecords(records);
  if (signoffs.length !== (data.signoffs || []).length) store.saveSignoffs(signoffs);
  res.status(204).end();
});

/* ---------------- 交接记录 CRUD ---------------- */

function validateRecord(body, data) {
  const minute = parseMinute(body.minute, '分钟');
  const from = nonEmpty(body.from, '交出者');
  const to = nonEmpty(body.to, '接收者');
  if (from === to) throw new Error('交出者与接收者不能相同');
  const propId = nonEmpty(body.propId, '道具');
  if (!data.props.some((p) => p.id === propId)) throw new Error('请选择已登记的道具');
  return {
    propId,
    minute,
    from,
    to,
    note: typeof body.note === 'string' ? body.note.trim() : '',
  };
}

app.get('/api/records', (req, res) => {
  res.json(store.getData().records);
});

app.post('/api/records', asyncRoute((req, res) => {
  const data = store.getData();
  let fields;
  try {
    fields = validateRecord(req.body || {}, data);
  } catch (err) {
    return badRequest(res, err.message);
  }
  const record = { id: store.newId('r'), ...fields, createdAt: Date.now() };
  store.saveRecords([...data.records, record]);
  res.status(201).json(record);
}));

app.put('/api/records/:id', asyncRoute((req, res) => {
  const data = store.getData();
  const idx = data.records.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '记录不存在' });

  let fields;
  try {
    fields = validateRecord(req.body || {}, data);
  } catch (err) {
    return badRequest(res, err.message);
  }
  // 修改保留原始录入顺序（createdAt），使同一分钟仍按最初录入先后重放
  const updated = { ...data.records[idx], ...fields };
  store.saveRecords(data.records.map((r) => (r.id === updated.id ? updated : r)));
  res.json(updated);
}));

app.delete('/api/records/:id', (req, res) => {
  const data = store.getData();
  if (!data.records.some((r) => r.id === req.params.id)) {
    return res.status(404).json({ error: '记录不存在' });
  }
  store.saveRecords(data.records.filter((r) => r.id !== req.params.id));
  // 删除记录时级联清理其签收记录
  const signoffs = (data.signoffs || []).filter((s) => s.recordId !== req.params.id);
  if (signoffs.length !== (data.signoffs || []).length) store.saveSignoffs(signoffs);
  res.status(204).end();
});

/* ---------------- 交接双方签收（写入，逐侧独立持久保存） ---------------- */

// 签收确认：页面携带当前记录内容指纹，服务端核对道具、分钟、双方姓名与备注后才写入；
// 记录被编辑后指纹改变，旧签收立即失效，过期页面的确认请求返回 409 拒绝。
app.post('/api/records/:id/sign', asyncRoute((req, res) => {
  const data = store.getData();
  const record = data.records.find((r) => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: '记录不存在或已被删除，请刷新后重试' });

  const body = req.body || {};
  let side;
  let name;
  let fingerprint;
  try {
    side = nonEmpty(body.side, '签收方');
    if (![SIDE.FROM, SIDE.TO].includes(side)) {
      throw new Error('签收方必须是 from（交出者）或 to（接收者）');
    }
    name = nonEmpty(body.name, '签收姓名');
    if (name.length > 30) throw new Error('签收姓名最长 30 个字符');
    fingerprint = nonEmpty(body.fingerprint, '记录内容指纹');
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 姓名须匹配该条记录的对应角色
  const expected = side === SIDE.FROM ? record.from : record.to;
  if (name !== expected) {
    return badRequest(
      res,
      `签收姓名与记录不符：该记录的${side === SIDE.FROM ? '交出者' : '接收者'}为「${expected}」`
    );
  }

  // 内容指纹核对：过期页面（记录已被编辑）的确认请求拒绝
  const current = recordFingerprint(record);
  if (fingerprint !== current) {
    return res
      .status(409)
      .json({ error: '记录内容已变化（页面数据过期），请刷新后重新核对再签收', stale: true });
  }

  // 逐侧独立写入：同一侧重复签收时覆盖旧签收（以最新一次为准）
  const signoff = {
    id: store.newId('s'),
    recordId: record.id,
    side,
    name,
    fingerprint: current,
    signedAt: Date.now(),
  };
  const signoffs = [
    ...(data.signoffs || []).filter((s) => !(s.recordId === record.id && s.side === side)),
    signoff,
  ];
  store.saveSignoffs(signoffs);
  res.status(201).json(signoff);
}));

/* ---------------- 已核实交接链（只读，即时重放，不改写任何数据） ---------------- */

app.get('/api/verified-chain', (req, res) => {
  const data = store.getData();
  let propKey;
  let minute;
  try {
    propKey = nonEmpty(req.query.prop, '道具');
    minute = parseMinute(req.query.minute, '截止分钟');
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 道具参数支持 id 或名称（名称精确匹配）
  const prop = data.props.find((p) => p.id === propKey) || data.props.find((p) => p.name === propKey);
  if (!prop) return res.status(404).json({ error: `道具「${propKey}」不存在` });

  // 纯读取 + 即时重放，不写入任何数据
  res.json(buildVerifiedChain(data, prop, minute));
});

/* ---------------- 批量交接预演（预演不落盘，提交一次写入） ---------------- */

// 预演票据只保存在内存中（不落盘）：记录预演时的数据版本与整批内容指纹，
// 提交时逐项核对，版本过期或内容改变都要求重新预演。
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_BATCH_ROWS = 200;
const previews = new Map(); // previewId -> { baseRev, rowsHash, canCommit, createdAt }

function sweepPreviews() {
  const now = Date.now();
  for (const [id, p] of previews) {
    if (now - p.createdAt > PREVIEW_TTL_MS) previews.delete(id);
  }
}

function conflict409(res, message) {
  return res.status(409).json({ error: message, needPreview: true });
}

/** 整批校验：逐行沿用单条记录校验，错误信息冠以批次行号 */
function validateBatchRows(body, data) {
  if (!Array.isArray(body.rows)) throw new Error('批次行（rows）必须是数组');
  if (body.rows.length === 0) throw new Error('请至少填写一行交接记录');
  if (body.rows.length > MAX_BATCH_ROWS) throw new Error(`单批次最多 ${MAX_BATCH_ROWS} 行`);
  return body.rows.map((row, i) => {
    try {
      return validateRecord(row || {}, data);
    } catch (err) {
      throw new Error(`第 ${i + 1} 行：${err.message}`);
    }
  });
}

app.post('/api/records/batch/preview', asyncRoute((req, res) => {
  const data = store.getData();
  let rows;
  try {
    rows = validateBatchRows(req.body || {}, data);
  } catch (err) {
    return badRequest(res, err.message);
  }

  // 纯读取 + 即时重放，不写入任何数据
  const result = previewBatch(data, rows);

  sweepPreviews();
  const previewId = store.newId('pv');
  previews.set(previewId, {
    baseRev: data.rev,
    rowsHash: hashRows(rows),
    canCommit: result.canCommit,
    createdAt: Date.now(),
  });

  res.json({ previewId, baseRev: data.rev, rows, ...result });
}));

app.post('/api/records/batch/commit', asyncRoute((req, res) => {
  const body = req.body || {};
  const data = store.getData();

  const ticket = body.previewId ? previews.get(String(body.previewId)) : null;
  if (!ticket || Date.now() - ticket.createdAt > PREVIEW_TTL_MS) {
    return conflict409(res, '预演不存在或已过期，请重新预演');
  }
  if (ticket.baseRev !== data.rev) {
    return conflict409(res, '预演后数据已被修改（数据版本过期），请重新预演');
  }

  let rows;
  try {
    rows = validateBatchRows(body, data);
  } catch (err) {
    return badRequest(res, err.message);
  }
  if (ticket.rowsHash !== hashRows(rows)) {
    return conflict409(res, '批次内容在预演后已改变，请重新预演');
  }
  if (!ticket.canCommit) {
    return conflict409(res, '预演结果存在冲突，禁止提交；请调整批次后重新预演');
  }

  // 一次写入全部记录：单次 saveRecords（临时文件 + 原子重命名），不留部分记录
  const now = Date.now();
  const newRecords = rows.map((f, i) => ({ id: store.newId('r'), ...f, createdAt: now + i }));
  store.saveRecords([...data.records, ...newRecords]);
  previews.delete(String(body.previewId));

  res.status(201).json({ inserted: newRecords.length, records: newRecords, rev: store.getData().rev });
}));

/* ---------------- 交接冲突修复预演（只读，枚举单条记录改动，不改写交接记录） ---------------- */

app.post('/api/conflict-fix/preview', asyncRoute((req, res) => {
  const body = req.body || {};

  let propId;
  try {
    propId = nonEmpty(body.propId, '道具');
  } catch (err) {
    return badRequest(res, err.message);
  }

  try {
    // 纯读取 + 即时重放，不写入任何数据
    return res.json(previewConflictFix(store.getData(), propId));
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'NO_CONFLICT') return badRequest(res, err.message);
    throw err;
  }
}));

/* ---------------- 错误兜底 ---------------- */

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    // 启动时确保数据文件存在（首次启动写入初始数据）
    store.getData();
    console.log(`演出道具交接核验应用已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
