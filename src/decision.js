// 判定层：母液开封与分装放行的全部业务规则。
// 纯函数，不读写文件、不发起存储调用，便于单元测试。

export const CONC_MIN = 12.0; // 显影浓度合格区间（%）
export const CONC_MAX = 14.0;
export const DEVELOP_TANKS = 6; // 显影槽总数，落合格区间的分装单各占一槽

export const STATUS = {
  REVIEW: "待复核", // 分装登记后等待双人双样复核；浓度越界也转这里，但不占槽
  RELEASED: "已放行",
  REJECTED: "已驳回"
};
export const TERMINAL = [STATUS.RELEASED, STATUS.REJECTED];

export class DomainError extends Error {
  constructor(code, message, status = 409, details) {
    super(message);
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

export function todayOf(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
}

// 显影浓度是否落合格区间
export function concentrationInRange(conc) {
  const n = Number(conc);
  return Number.isFinite(n) && n >= CONC_MIN && n <= CONC_MAX;
}

// 批次是否仍在效期（按当天日期比较，过期日当天仍有效）
export function batchInDate(batch, now) {
  if (!batch) return false;
  const today = todayOf(now);
  return Boolean(batch.openedAt) && today >= batch.openedAt && today <= batch.expiresAt;
}

// 同一药液批次是否已有未结束分装单（已放行/已驳回之外都算未结束）
export function findOpenOrderForBatch(orders, batchNo) {
  return orders.find(o => o.batchNo === batchNo && !TERMINAL.includes(o.status)) || null;
}

// 当班交接是否已确认
export function handoverConfirmed(batch) {
  return Boolean(batch && batch.handoverConfirmed);
}

// 母液余量是否够本次分装
export function hasEnoughRemaining(batch, volumeMl) {
  return batch && Number(batch.remainingMl) - Number(volumeMl) >= -1e-9;
}

// 显影槽占用数：仅“未结束且浓度合格”的分装单占槽；放行/驳回后释放
export function occupiedTanks(orders) {
  return orders.reduce(
    (n, o) => n + (!TERMINAL.includes(o.status) && concentrationInRange(o.concentration) ? 1 : 0),
    0
  );
}

// 分装登记前置校验。全部通过才允许写库，杜绝半截记录。
export function assertCanCreateOrder(batch, orders, volumeMl, now) {
  if (!batchInDate(batch, now)) {
    throw new DomainError("BATCH_EXPIRED", "原批次已过效期或批次不存在，不能分装");
  }
  if (!handoverConfirmed(batch)) {
    throw new DomainError("HANDOVER_NOT_CONFIRMED", "当班交接尚未确认，暂缓分装");
  }
  const open = findOpenOrderForBatch(orders, batch.batchNo);
  if (open) {
    throw new DomainError("OPEN_ORDER_EXISTS", "同一药液批次已有未结束分装单", 409, { blockingOrderId: open.id });
  }
  if (!Number.isFinite(Number(volumeMl)) || Number(volumeMl) <= 0) {
    throw new DomainError("INVALID_VOLUME", "分装量必须为正数", 400);
  }
  if (!hasEnoughRemaining(batch, volumeMl)) {
    throw new DomainError("INSUFFICIENT_REMAINING", "母液余量不足，拒绝登记", 409, {
      remainingMl: batch.remainingMl
    });
  }
  return true;
}

// 第二次取样的复核结论：另一人、连续两次、均合格，且批次仍在效期、交接仍确认。
// 任何一项不满足都不放行（已驳回为终态）。
export function reviewVerdict(order, batch, firstSample, secondSample, now) {
  if (!firstSample || !secondSample) {
    return { release: false, reason: "SAMPLES_INCOMPLETE", reasonText: "需要连续两次取样" };
  }
  if (firstSample.sampler === secondSample.sampler) {
    return { release: false, reason: "REVIEWER_SAME", reasonText: "复核须由另一人完成" };
  }
  if (!concentrationInRange(firstSample.concentration)) {
    return { release: false, reason: "FIRST_SAMPLE_OUT_OF_RANGE", reasonText: "第一次取样浓度越界" };
  }
  if (!concentrationInRange(secondSample.concentration)) {
    return { release: false, reason: "SECOND_SAMPLE_OUT_OF_RANGE", reasonText: "第二次取样浓度越界" };
  }
  if (!batchInDate(batch, now)) {
    return { release: false, reason: "BATCH_EXPIRED", reasonText: "原批次已过效期" };
  }
  if (!handoverConfirmed(batch)) {
    return { release: false, reason: "HANDOVER_NOT_CONFIRMED", reasonText: "当班交接未确认" };
  }
  return { release: true, reason: "OK", reasonText: "双人双样合格，且批次在效期内" };
}

// 哪些字段更正后会导致放行失效重算
export const RELEASE_INVALIDATING_BATCH_FIELDS = ["remainingMl", "handoverConfirmed"];
export const RELEASE_INVALIDATING_ORDER_FIELDS = ["concentration", "volumeMl"];
