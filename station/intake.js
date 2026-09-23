// 入口层：分装放行台的用例编排。只负责入参校验、调用判定、追加事件，
// 不含 HTTP 细节（由 server.js 绑定路由）。判定不通过时绝不 append。

import {
  STATUS,
  isNumber,
  judgeRegistration,
  judgeReview
} from "./decision.js";

const conflict = (reason) => ({ status: 409, body: { error: reason } });
const badRequest = (reason) => ({ status: 400, body: { error: reason } });
const ok = (status, body) => ({ status, body });

let orderSeq = 1;
function newOrderId(existing) {
  const d = new Date();
  const stamp = d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  const prefix = "FZ-" + stamp + "-";
  let max = orderSeq - 1;
  for (const id of existing) {
    if (id.startsWith(prefix)) max = Math.max(max, Number(id.slice(prefix.length)) || 0);
  }
  orderSeq = max + 1;
  return prefix + String(orderSeq++).padStart(3, "0");
}

export function stationIntake(archive) {
  async function openBatch(input) {
    const batchId = String(input.batchId || "").trim();
    if (!batchId) return badRequest("batch_id_required");
    if (archive.getBatch(batchId)) return conflict("batch_already_open");

    const initial = Number(input.initial);
    if (!isNumber(initial) || initial <= 0) return badRequest("initial_invalid");
    const expiresAt = String(input.expiresAt || "").trim();
    if (!expiresAt || Number.isNaN(new Date(expiresAt).getTime())) {
      return badRequest("expires_at_invalid");
    }
    const openedAt = String(input.openedAt || "").trim() || archive.now().slice(0, 10);
    const handoverConfirmed = input.handoverConfirmed !== false;

    const event = await archive.append("stock_opened", {
      batchId,
      openedAt,
      initial,
      expiresAt: new Date(expiresAt).toISOString(),
      handoverConfirmed
    });
    return ok(201, { event: event.id, batchId });
  }

  async function registerOrder(input) {
    const batchId = String(input.batchId || "").trim();
    const amount = Number(input.amount);
    const concentration = Number(input.concentration);
    const operator = String(input.operator || "").trim();

    if (!operator) return badRequest("operator_required");
    const batch = archive.getBatch(batchId);
    const code = judgeRegistration({
      batch,
      hasActiveOrder: batch ? archive.hasActiveOrder(batchId) : false,
      amount,
      concentration
    });
    if (code) {
      // 登记类前置冲突：余量不足 / 交接未确认 / 已有未结束单——直接返回，不产生任何记录
      if (code === "concentration_invalid") return badRequest(code);
      return conflict(code);
    }

    const orderId = newOrderId(archive.snapshot().orders.map(o => o.id));
    const event = await archive.append("order_registered", {
      orderId,
      batchId,
      amount,
      concentration,
      operator
    });

    const order = archive.getOrder(orderId);
    return ok(201, {
      event: event.id,
      order: {
        id: order.id,
        batchId: order.batchId,
        amount: order.amount,
        concentration: order.concentration,
        operator: order.operator,
        status: order.status,
        tankNo: order.tankNo
      },
      note: order.status === STATUS.PENDING_REVIEW ? "浓度越界，转待复核，不占显影槽" : "登记完成，等待双人取样放行"
    });
  }

  async function reviewSample(input) {
    const orderId = String(input.orderId || "").trim();
    const reviewer = String(input.reviewer || "").trim();
    const concentration = Number(input.concentration);
    if (!reviewer) return badRequest("reviewer_required");
    if (!isNumber(concentration)) return badRequest("concentration_invalid");

    const order = archive.getOrder(orderId);
    if (!order) return conflict("order_not_found");
    const batch = archive.getBatch(order.batchId);

    // 身份冲突先判定：必须由登记操作者之外的另一人，取样记录不产生
    if (reviewer === order.operator) {
      return conflict("reviewer_must_be_another_operator");
    }
    // 第二次取样必须与第一次为同一人（连续两次取样）
    if (order.samples.length === 1 && order.samples[0].reviewer !== reviewer) {
      return conflict("reviewer_must_be_continuous");
    }

    // 真实测量（即使越界）入只读履历
    const seq = order.samples.length + 1;
    await archive.append("sample_reviewed", {
      orderId,
      batchId: order.batchId,
      seq,
      reviewer,
      concentration,
      at: archive.now()
    });

    const fresh = archive.getOrder(orderId);
    if (seq < 2) {
      return ok(200, { orderId, released: false, reason: "need_second_sample", seq });
    }

    const verdict = judgeReview({
      order: fresh,
      batch,
      reviewer,
      samples: fresh.samples.map(s => s.concentration),
      now: new Date(archive.now()).getTime()
    });
    if (!verdict.ok) {
      await archive.append("review_failed", { orderId, batchId: fresh.batchId, reviewer, reason: verdict.reason });
      return ok(200, { orderId, released: false, reason: verdict.reason });
    }

    // 占槽在放瞬间完成；无空槽则不放行（登记阶段待复核单本不占槽）
    const snap = archive.snapshot();
    if (!fresh.tankNo && snap.tanks.every(t => t.occupied)) {
      return conflict("no_free_tank");
    }

    const event = await archive.append("order_released", {
      orderId,
      batchId: fresh.batchId,
      reviewer,
      at: archive.now()
    });
    const released = archive.getOrder(orderId);
    return ok(201, {
      event: event.id,
      orderId,
      released: true,
      tankNo: released.tankNo,
      note: "连续两次取样合格且批次在效期，已放行"
    });
  }

  // 更正批次余量 / 效期 / 交接状态：旧稿只读，仅追加更正事件；该批次所有已放行单失效重算。
  async function correctBatch(input) {
    const batchId = String(input.batchId || "").trim();
    const batch = archive.getBatch(batchId);
    if (!batch) return conflict("batch_not_found");

    const next = { batchId };
    if (input.remaining !== undefined) {
      const remaining = Number(input.remaining);
      if (!isNumber(remaining) || remaining < 0) return badRequest("remaining_invalid");
      next.remaining = remaining;
    }
    if (input.expiresAt !== undefined && String(input.expiresAt).trim() !== "") {
      const expiresAt = String(input.expiresAt).trim();
      if (Number.isNaN(new Date(expiresAt).getTime())) return badRequest("expires_at_invalid");
      next.expiresAt = new Date(expiresAt).toISOString();
    }
    if (input.handoverConfirmed !== undefined) {
      next.handoverConfirmed = Boolean(input.handoverConfirmed);
    }

    await archive.append("batch_corrected", next);

    // 放行失效重算（以事件方式存档，旧稿保留）
    const snap = archive.snapshot();
    const affected = snap.orders.filter(o => o.batchId === batchId && o.status === STATUS.RELEASED);
    for (const order of affected) {
      await archive.append("release_invalidated", {
        orderId: order.id,
        batchId,
        cause: "batch_corrected"
      });
    }
    return ok(200, { batchId, invalidated: affected.map(o => o.id) });
  }

  // 更正单内浓度：已放行单失效重算，越界则转待复核并让出显影槽。
  async function correctOrder(input) {
    const orderId = String(input.orderId || "").trim();
    const order = archive.getOrder(orderId);
    if (!order) return conflict("order_not_found");
    const concentration = Number(input.concentration);
    if (!isNumber(concentration)) return badRequest("concentration_invalid");

    const beforeStatus = order.status;
    // order_corrected 在折叠时即对已放行单执行失效重算（浓度越界转待复核并让槽），
    // 旧稿保留原登记与放行事件，无需再追加重复的失效事件。
    const event = await archive.append("order_corrected", {
      orderId,
      batchId: order.batchId,
      concentration
    });
    const fresh = archive.getOrder(orderId);
    return ok(200, {
      event: event.id,
      orderId,
      wasReleased: beforeStatus === STATUS.RELEASED,
      status: fresh.status,
      tankNo: fresh.tankNo,
      note: beforeStatus === STATUS.RELEASED
        ? (fresh.status === STATUS.PENDING_REVIEW ? "浓度更正后放行失效，转待复核，已让出显影槽" : "浓度更正后放行失效，重算为待放行")
        : (fresh.status === STATUS.PENDING_REVIEW ? "浓度越界，转待复核" : "浓度更正完成")
    });
  }

  return { openBatch, registerOrder, reviewSample, correctBatch, correctOrder };
}
