// 入口层：接收并校验入参，调用 decision.js 的判定，再把变更写入内存库对象。
// 本层不做文件落盘——由 HTTP 入口在返回前统一 saveDb；任何抛错都发生在落盘之前，
// 因此余量不足、交接未确认、已有未结束分装单等冲突不会产生半截记录。

import {
  STATUS,
  TERMINAL,
  DomainError,
  assertCanCreateOrder,
  batchInDate,
  concentrationInRange,
  findOpenOrderForBatch,
  occupiedTanks,
  reviewVerdict,
  round1
} from "./decision.js";
import {
  appendEvent,
  findBatch,
  findOrder,
  nextSeq,
  voidOrderRelease
} from "./archive.js";

function iso(now) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function num(v, field, { allowOutOfRange = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new DomainError("INVALID_NUMBER", `${field}必须是数字`, 400);
  return n;
}

function requireText(v, field) {
  if (typeof v !== "string" || !v.trim()) {
    throw new DomainError("FIELD_REQUIRED", `缺少必填项：${field}`, 400);
  }
  return v.trim();
}

// ---- 母液开封 ----

export function openBatch(db, input, now = new Date()) {
  const at = iso(now);
  const batchNo = requireText(input.batchNo, "药液批次号");
  const openedAt = requireText(input.openedAt, "开封日期");
  const expiresAt = requireText(input.expiresAt, "效期至");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(openedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) || expiresAt < openedAt) {
    throw new DomainError("INVALID_DATE_RANGE", "日期格式应为 YYYY-MM-DD，且效期不得早于开封日", 400);
  }
  const initialMl = num(input.initialMl, "初始母液量");
  if (initialMl <= 0) throw new DomainError("INVALID_VOLUME", "初始母液量必须为正数", 400);
  const remainingMl = input.remainingMl === undefined ? initialMl : num(input.remainingMl, "当前余量");
  if (remainingMl < 0 || remainingMl > initialMl) {
    throw new DomainError("INVALID_VOLUME", "余量必须在 0 与初始量之间", 400);
  }
  if (findBatch(db, batchNo)) throw new DomainError("BATCH_EXISTS", "该药液批次已开封登记", 409);
  const actor = requireText(input.operator, "开封操作者");

  const batch = {
    batchNo,
    openedAt,
    expiresAt,
    initialMl: round1(initialMl),
    remainingMl: round1(remainingMl),
    handoverConfirmed: Boolean(input.handoverConfirmed),
    createdAt: at
  };
  db.batches.unshift(batch);
  appendEvent(db, {
    at,
    type: "BATCH_OPENED",
    batchNo,
    actor,
    detail: { openedAt, expiresAt, initialMl: batch.initialMl, remainingMl: batch.remainingMl }
  });
  return batch;
}

// ---- 分装登记：单内登记分装量、显影浓度、操作者 ----

export function registerOrder(db, input, now = new Date()) {
  const at = iso(now);
  const batchNo = requireText(input.batchNo, "药液批次号");
  const batch = findBatch(db, batchNo);
  if (!batch) throw new DomainError("BATCH_NOT_FOUND", "药液批次不存在", 404);
  const volumeMl = num(input.volumeMl, "分装量");
  const concentration = num(input.concentration, "显影浓度");
  const operator = requireText(input.operator, "操作者");

  // 一次性完成全部前置判定，任何一项失败都在变更前抛错。
  assertCanCreateOrder(batch, db.orders, volumeMl, now);

  const inRange = concentrationInRange(concentration);
  // 合格单占显影槽（槽位在队列视图中按顺序派生）；登记前先确认有槽可用。
  if (inRange && occupiedTanks(db.orders) >= db.meta.developTanks) {
    throw new DomainError("NO_FREE_TANK", "显影槽已满，合格分装无法占槽", 409);
  }

  batch.remainingMl = round1(batch.remainingMl - volumeMl);
  const id = `FZ-${String(nextSeq(db)).padStart(4, "0")}`;
  const order = {
    id,
    revision: 1,
    batchNo,
    volumeMl: round1(volumeMl),
    concentration: round1(concentration),
    operator,
    createdAt: at,
    status: STATUS.REVIEW, // 无论浓度是否越界，一律先转待复核
    samples: [],
    archivedSamples: [],
    revisions: [],
    voidedReleases: [],
    release: null,
    rejectedReason: null,
    rejectedReasonText: null,
    batchRemainingMlAtCreate: batch.remainingMl
  };
  db.orders.unshift(order);
  appendEvent(db, {
    at,
    type: "ORDER_REGISTERED",
    batchNo,
    orderId: id,
    actor: operator,
    detail: {
      volumeMl: order.volumeMl,
      concentration: order.concentration,
      concentrationInRange: inRange,
      occupiesTank: inRange,
      batchRemainingMl: batch.remainingMl
    }
  });
  return order;
}

// ---- 双人双样复核：另一人连续两次取样，均合格且批次仍在效期、交接已确认才放行 ----

export function recordSample(db, orderId, input, now = new Date()) {
  const at = iso(now);
  const order = findOrder(db, orderId);
  if (!order) throw new DomainError("ORDER_NOT_FOUND", "分装单不存在", 404);
  if (TERMINAL.includes(order.status)) {
    throw new DomainError("ORDER_CLOSED", "分装单已结束，取样口只读", 409);
  }
  const sampler = requireText(input.sampler, "取样人");
  const concentration = num(input.concentration, "取样浓度");
  const batch = findBatch(db, order.batchNo);

  order.samples ||= [];
  if (order.samples.length >= 2) {
    throw new DomainError("REVIEW_ROUND_FULL", "本轮两次取样已齐，请先完成判定", 409);
  }
  if (order.samples.length === 1 && order.samples[0].sampler === sampler) {
    throw new DomainError("REVIEWER_SAME", "第二次取样须由另一人完成", 409, {
      firstSampler: order.samples[0].sampler
    });
  }

  const sample = { at, sampler, concentration: round1(concentration), round: order.samples.length + 1 };
  order.samples.push(sample);
  appendEvent(db, {
    at,
    type: "SAMPLE_TAKEN",
    batchNo: order.batchNo,
    orderId: order.id,
    actor: sampler,
    detail: { round: sample.round, concentration: sample.concentration }
  });
  if (sample.round === 1) return { stage: "FIRST_TAKEN", order };

  const verdict = reviewVerdict(order, batch, order.samples[0], order.samples[1], now);
  if (!verdict.release) {
    order.status = STATUS.REJECTED; // 终态：释放显影槽
    order.rejectedReason = verdict.reason;
    order.rejectedReasonText = verdict.reasonText;
    appendEvent(db, {
      at,
      type: "REVIEW_REJECTED",
      batchNo: order.batchNo,
      orderId: order.id,
      actor: sampler,
      detail: { reason: verdict.reason, reasonText: verdict.reasonText, samples: order.samples }
    });
    return { stage: "REJECTED", verdict, order };
  }

  order.status = STATUS.RELEASED; // 终态：释放显影槽，分装放行
  order.release = {
    at,
    by: sampler,
    first: { ...order.samples[0] },
    second: { ...order.samples[1] },
    verdictText: verdict.reasonText
  };
  appendEvent(db, {
    at,
    type: "REVIEW_RELEASED",
    batchNo: order.batchNo,
    orderId: order.id,
    actor: sampler,
    detail: {
      first: order.samples[0],
      second: order.samples[1],
      verdictText: verdict.reasonText
    }
  });
  return { stage: "RELEASED", verdict, order };
}

// ---- 分装单更正：分装量 / 显影浓度；放行因此失效重算，旧稿封存只读 ----

export function correctOrder(db, orderId, input, now = new Date()) {
  const at = iso(now);
  const order = findOrder(db, orderId);
  if (!order) throw new DomainError("ORDER_NOT_FOUND", "分装单不存在", 404);
  if (order.status === STATUS.REJECTED) {
    throw new DomainError("ORDER_CLOSED", "已驳回归档，旧稿只读", 409);
  }
  const reason = requireText(input.reason, "更正原因");
  const actor = requireText(input.actor, "更正操作者");
  const changes = {};
  if (input.volumeMl !== undefined) changes.volumeMl = round1(num(input.volumeMl, "分装量"));
  if (input.concentration !== undefined) changes.concentration = round1(num(input.concentration, "显影浓度"));
  const unknown = Object.keys(input).filter(k => !["volumeMl", "concentration", "reason", "actor"].includes(k));
  if (unknown.length) throw new DomainError("FIELD_NOT_CORRECTABLE", `不可更正字段：${unknown.join("、")}`, 400);
  if (!Object.keys(changes).length) {
    throw new DomainError("NO_CHANGE", "未提供任何可更正字段", 400);
  }
  if ("volumeMl" in changes && changes.volumeMl <= 0) {
    throw new DomainError("INVALID_VOLUME", "分装量必须为正数", 400);
  }

  const batch = findBatch(db, order.batchNo);
  const oldVolume = order.volumeMl;
  if ("volumeMl" in changes) {
    const projected = round1(batch.remainingMl + oldVolume - changes.volumeMl);
    if (projected < -1e-9) {
      throw new DomainError("INSUFFICIENT_REMAINING", "更正后母液余量为负，拒绝更正", 409, {
        projectedRemainingMl: projected
      });
    }
  }
  if ("concentration" in changes) {
    const newInRange = concentrationInRange(changes.concentration);
    if (newInRange) {
      const otherLive = db.orders.filter(
        o => o.id !== order.id && !TERMINAL.includes(o.status) && concentrationInRange(o.concentration)
      ).length;
      if (otherLive + 1 > db.meta.developTanks) {
        throw new DomainError("NO_FREE_TANK", "更正后该单需占显影槽，但槽位不足", 409);
      }
    }
  }

  const wasReleased = order.status === STATUS.RELEASED;
  // 先封存旧稿（含原放行结论、原取样），放行失效、回到待复核，再应用新值。
  voidOrderRelease(order, wasReleased ? "更正后放行失效，重算" : "登记字段更正，重算复核", db, at, actor, {
    changedFields: Object.keys(changes)
  });

  if ("volumeMl" in changes) {
    batch.remainingMl = round1(batch.remainingMl + oldVolume - changes.volumeMl);
    order.volumeMl = changes.volumeMl;
  }
  if ("concentration" in changes) order.concentration = changes.concentration;

  appendEvent(db, {
    at,
    type: "ORDER_CORRECTED",
    batchNo: order.batchNo,
    orderId: order.id,
    actor,
    detail: { reason, changes, batchRemainingMl: batch.remainingMl, newRevision: order.revision }
  });
  return order;
}

// ---- 批次更正：余量 / 当班交接状态；已放行单全部失效重算，旧稿只读 ----

export function correctBatch(db, batchNo, input, now = new Date()) {
  const at = iso(now);
  const batch = findBatch(db, batchNo);
  if (!batch) throw new DomainError("BATCH_NOT_FOUND", "药液批次不存在", 404);
  const reason = requireText(input.reason, "更正原因");
  const actor = requireText(input.actor, "更正操作者");
  const changes = {};
  if (input.remainingMl !== undefined) changes.remainingMl = round1(num(input.remainingMl, "当前余量"));
  if (input.handoverConfirmed !== undefined) changes.handoverConfirmed = Boolean(input.handoverConfirmed);
  const unknown = Object.keys(input).filter(
    k => !["remainingMl", "handoverConfirmed", "reason", "actor"].includes(k)
  );
  if (unknown.length) throw new DomainError("FIELD_NOT_CORRECTABLE", `不可更正字段：${unknown.join("、")}`, 400);
  if (!Object.keys(changes).length) throw new DomainError("NO_CHANGE", "未提供任何可更正字段", 400);
  if ("remainingMl" in changes && changes.remainingMl < 0) {
    throw new DomainError("INVALID_VOLUME", "余量不能为负", 400);
  }

  Object.assign(batch, changes);
  const invalidated = [];
  for (const o of db.orders.filter(o => o.batchNo === batchNo && o.status === STATUS.RELEASED)) {
    voidOrderRelease(o, "批次余量/交接状态更正，放行失效重算", db, at, actor, {
      batchChanges: Object.keys(changes)
    });
    invalidated.push(o.id);
  }
  // 待复核单无需回滚（判定时本来就读取批次最新现场）；但交接状态变化必须留痕，
  // 且待复核单若已有取样，交接触发的现场变化会在第二次取样判定时生效。
  appendEvent(db, {
    at,
    type: "BATCH_CORRECTED",
    batchNo,
    actor,
    detail: { reason, changes, invalidatedOrders: invalidated }
  });
  return { batch, invalidatedOrders: invalidated };
}
