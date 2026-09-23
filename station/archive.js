// 存档层：只追加的事件履历（旧稿只读），队列与批次履历均由事件折叠得到。
// 所有修改都经过 append(kind, payload)：先 append 后整体落盘，
// 判定在 append 之前完成，因此冲突时不会产生半截记录。

import { CONCENTRATION_MIN, CONCENTRATION_MAX, TANK_COUNT, STATUS, UNFINISHED_STATUSES, recalcStatus } from "./decision.js";

const EVENT_LABELS = {
  stock_opened: "母液开封",
  order_registered: "分装登记",
  sample_reviewed: "复核取样",
  order_released: "放行",
  review_failed: "复核未过",
  batch_corrected: "批次更正",
  order_corrected: "浓度更正",
  release_invalidated: "放行失效重算"
};

function tankNumber(index) {
  return "槽-" + String(index + 1).padStart(2, "0");
}

function freeTanks(occupied) {
  const free = [];
  for (let i = 0; i < TANK_COUNT; i++) {
    const no = tankNumber(i);
    if (!occupied.has(no)) free.push(no);
  }
  return free;
}

export class StationArchive {
  constructor(db, save, clock = () => new Date().toISOString()) {
    this.db = db;
    this.save = save;
    this.clock = clock;
    if (!Array.isArray(db.stationEvents)) db.stationEvents = [];
  }

  seedIfEmpty() {
    if (this.db.stationEvents.length > 0) return false;
    // 与既有底片 CN-001 的药液批次 B-0620 对齐
    this.db.stationEvents.push({
      id: "EV-seed",
      at: "2026-06-20T00:00:00.000Z",
      kind: "stock_opened",
      payload: {
        batchId: "B-0620",
        openedAt: "2026-06-20",
        initial: 5000,
        remaining: 5000,
        expiresAt: "2026-12-31",
        handoverConfirmed: true
      }
    });
    return true;
  }

  async append(kind, payload) {
    const event = {
      id: "EV-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      at: this.clock(),
      kind,
      payload
    };
    this.db.stationEvents.push(event);
    await this.save(this.db);
    return event;
  }

  now() { return this.clock(); }

  // 折叠：把不可变事件履历还原成批次、分装单队列与显影槽占用。
  fold() {
    const events = this.db.stationEvents;
    const batches = new Map(); // batchId -> batch 聚合
    const orders = new Map(); // orderId -> 分装单聚合
    const occupied = new Set(); // 当前占用中的显影槽号

    function placeOrder(order, no) {
      if (order.tankNo && order.tankNo !== no) occupied.delete(order.tankNo);
      if (no) {
        order.tankNo = no;
        occupied.add(no);
      } else {
        order.tankNo = null;
      }
    }

    function releaseTank(order) {
      if (order.tankNo) occupied.delete(order.tankNo);
      order.tankNo = null;
    }

    for (const event of events) {
      const p = event.payload;
      switch (event.kind) {
        case "stock_opened":
        case "batch_corrected": {
          const prev = batches.get(p.batchId) || {
            batchId: p.batchId,
            openedAt: p.openedAt,
            initial: p.initial,
            remaining: 0,
            expiresAt: p.expiresAt,
            handoverConfirmed: p.handoverConfirmed
          };
          if (event.kind === "stock_opened") {
            Object.assign(prev, {
              openedAt: p.openedAt,
              initial: p.initial,
              remaining: p.initial,
              expiresAt: p.expiresAt,
              handoverConfirmed: p.handoverConfirmed
            });
          } else {
            if (p.remaining !== undefined) prev.remaining = p.remaining;
            if (p.expiresAt !== undefined) prev.expiresAt = p.expiresAt;
            if (p.handoverConfirmed !== undefined) prev.handoverConfirmed = p.handoverConfirmed;
          }
          batches.set(p.batchId, prev);
          break;
        }
        case "order_registered": {
          const batch = batches.get(p.batchId);
          batch.remaining -= p.amount;
          const status = p.concentration >= CONCENTRATION_MIN && p.concentration <= CONCENTRATION_MAX
            ? STATUS.PENDING_RELEASE
            : STATUS.PENDING_REVIEW;
          const order = {
            id: p.orderId,
            batchId: p.batchId,
            amount: p.amount,
            concentration: p.concentration,
            operator: p.operator,
            status,
            tankNo: null,
            reviewer: null,
            samples: [],
            releasedAt: null
          };
          orders.set(p.orderId, order);
          if (status === STATUS.PENDING_RELEASE) placeOrder(order, freeTanks(occupied)[0] || null);
          break;
        }
        case "sample_reviewed": {
          const order = orders.get(p.orderId);
          order.samples.push({ seq: p.seq, concentration: p.concentration, at: p.at, reviewer: p.reviewer });
          break;
        }
        case "review_failed": {
          const order = orders.get(p.orderId);
          order.reviewer = p.reviewer;
          // 越界样本等失败尝试在履历中保留（sample_reviewed 旧稿只读），
          // 但待评的连续取样序列在读模型上重置，允许重新连续取样两次。
          order.samples = [];
          break;
        }
        case "order_released": {
          const order = orders.get(p.orderId);
          order.status = STATUS.RELEASED;
          order.reviewer = p.reviewer;
          order.releasedAt = p.at;
          // 待复核单放行前不占槽，放行时补占
          if (!order.tankNo) placeOrder(order, freeTanks(occupied)[0] || null);
          break;
        }
        case "release_invalidated": {
          const order = orders.get(p.orderId);
          order.status = recalcStatus(order.concentration);
          order.releasedAt = null;
          order.reviewer = null;
          order.samples = [];
          if (order.status === STATUS.PENDING_REVIEW) releaseTank(order);
          else if (!order.tankNo) placeOrder(order, freeTanks(occupied)[0] || null);
          break;
        }
        case "order_corrected": {
          const order = orders.get(p.orderId);
          order.concentration = p.concentration;
          if (order.status === STATUS.RELEASED) {
            // 已放行单更正浓度：放行失效，清空取样序列后重算
            order.releasedAt = null;
            order.reviewer = null;
            order.samples = [];
          }
          // 已放行与未结束单都按新浓度重算；待复核↔待放行之间同步让槽/补占
          const next = recalcStatus(p.concentration);
          if (order.status !== next || !order.releasedAt) {
            order.status = next;
            if (next === STATUS.PENDING_REVIEW) releaseTank(order);
            else if (!order.tankNo) placeOrder(order, freeTanks(occupied)[0] || null);
          }
          break;
        }
        default:
          break;
      }
    }

    return { batches, orders, occupied, events };
  }

  snapshot() {
    const { batches, orders, occupied, events } = this.fold();

    const allOrders = [...orders.values()].sort((a, b) => b.id.localeCompare(a.id));
    const queue = allOrders.filter(o => UNFINISHED_STATUSES.includes(o.status));

    const batchViews = [...batches.values()].map(b => {
      const batchOrders = allOrders.filter(o => o.batchId === b.batchId);
      return {
        ...b,
        activeOrder: batchOrders.find(o => UNFINISHED_STATUSES.includes(o.status)) || null,
        orderCount: batchOrders.length
      };
    });

    const tanks = [];
    for (let i = 0; i < TANK_COUNT; i++) {
      const no = tankNumber(i);
      const order = allOrders.find(o => o.tankNo === no) || null;
      tanks.push({ no, occupied: occupied.has(no), orderId: order ? order.id : null, status: order ? order.status : null });
    }

    // 批次履历：按批次分组的只读旧稿
    const ledgerByBatch = new Map();
    events.forEach((event, index) => {
      const batchId = event.payload.batchId || null;
      if (!ledgerByBatch.has(batchId)) ledgerByBatch.set(batchId, []);
      ledgerByBatch.get(batchId).push({
        seq: index + 1,
        id: event.id,
        at: event.at,
        kind: event.kind,
        label: EVENT_LABELS[event.kind] || event.kind,
        payload: event.payload
      });
    });

    return {
      limits: {
        concentrationMin: CONCENTRATION_MIN,
        concentrationMax: CONCENTRATION_MAX,
        tankCount: TANK_COUNT
      },
      batches: batchViews,
      queue,
      orders: allOrders,
      tanks,
      ledger: [...ledgerByBatch.entries()].map(([batchId, entries]) => ({ batchId, entries }))
    };
  }

  getBatch(batchId) {
    return this.fold().batches.get(batchId);
  }

  getOrder(orderId) {
    return this.fold().orders.get(orderId);
  }

  hasActiveOrder(batchId) {
    const { orders } = this.fold();
    for (const order of orders.values()) {
      if (order.batchId === batchId && UNFINISHED_STATUSES.includes(order.status)) return true;
    }
    return false;
  }
}
