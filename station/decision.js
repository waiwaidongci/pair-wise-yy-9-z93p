// 判定层：母液开封与分装放行台的纯业务规则，不接触 HTTP 与文件。
// 所有冲突原因以错误码返回，由入口层翻译成状态码与提示。

export const CONCENTRATION_MIN = 18; // 显影浓度合格区间下限（%）
export const CONCENTRATION_MAX = 22; // 显影浓度合格区间上限（%）
export const TANK_COUNT = 8; // 显影槽总数

export const STATUS = Object.freeze({
  PENDING_RELEASE: "待放行", // 浓度合格，等待双人取样确认
  PENDING_REVIEW: "待复核", // 浓度越界，隔离不占显影槽
  RELEASED: "已放行" // 复核通过、分装结束
});

export const UNFINISHED_STATUSES = Object.freeze([
  STATUS.PENDING_RELEASE,
  STATUS.PENDING_REVIEW
]);

export function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function concentrationInRange(value) {
  return isNumber(value) && value >= CONCENTRATION_MIN && value <= CONCENTRATION_MAX;
}

export function batchExpired(batch, now = Date.now()) {
  return new Date(batch.expiresAt).getTime() < now;
}

// 分装登记前置判定：返回 null 表示通过，否则返回冲突错误码。
// 调用顺序保证：任何冲突都在写存档之前发生，不产生半截记录。
export function judgeRegistration({ batch, hasActiveOrder, amount, concentration }) {
  if (!batch) return "batch_not_found";
  if (!batch.handoverConfirmed) return "handover_not_confirmed";
  if (hasActiveOrder) return "active_order_exists";
  if (!isNumber(amount) || amount <= 0) return "amount_invalid";
  if (!isNumber(concentration)) return "concentration_invalid";
  if (!(batch.remaining >= amount)) return "insufficient_remaining";
  return null;
}

// 复核判定：必须由非登记操作者的另一人，连续两次取样均落合格区间，且原批次在效期。
export function judgeReview({ order, batch, reviewer, samples, now = Date.now() }) {
  if (!order) return { ok: false, reason: "order_not_found", appendable: false };
  if (order.status === STATUS.RELEASED) {
    return { ok: false, reason: "order_already_released", appendable: false };
  }
  if (!reviewer || reviewer === order.operator) {
    return { ok: false, reason: "reviewer_must_be_another_operator", appendable: true };
  }
  if (samples.length !== 2 || !samples.every(concentrationInRange)) {
    return { ok: false, reason: "sample_out_of_range", appendable: true };
  }
  if (batchExpired(batch, now)) {
    return { ok: false, reason: "batch_expired", appendable: true };
  }
  return { ok: true };
}

// 放行失效后的重算：浓度合格回待放行，越界回待复核（不占槽）。
export function recalcStatus(concentration) {
  return concentrationInRange(concentration)
    ? STATUS.PENDING_RELEASE
    : STATUS.PENDING_REVIEW;
}
