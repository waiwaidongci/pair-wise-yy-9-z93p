// 存档层：母液批次、分装单、事件履历的持久化与派生视图。
// 业务规则放在 decision.js；这里只负责加载/原子落盘、追加履历、计算一致的读视图。
// 入口层对内存对象完成校验与变更后，统一调用 saveDb 落盘，冲突时不写任何半截记录。

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONC_MIN,
  CONC_MAX,
  DEVELOP_TANKS,
  STATUS,
  TERMINAL,
  concentrationInRange,
  round1
} from "./decision.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function defaultDbPath() {
  const fromEnv = process.env.STATION_DB;
  if (fromEnv) return fromEnv;
  return join(__dirname, "..", "data", "stock-solution-station.json");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  for (const k of Object.keys(value)) deepFreeze(value[k]);
  return Object.freeze(value);
}

export function buildSeed(now = new Date()) {
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const seed = {
    meta: {
      concMin: CONC_MIN,
      concMax: CONC_MAX,
      developTanks: DEVELOP_TANKS
    },
    seq: 1,
    batches: [
      {
        batchNo: "B-0918",
        openedAt: "2026-09-18",
        expiresAt: "2026-10-18",
        initialMl: 1000,
        remainingMl: 700,
        handoverConfirmed: true,
        createdAt: at
      }
    ],
    orders: [],
    events: [
      {
        seq: 1,
        at,
        type: "BATCH_OPENED",
        batchNo: "B-0918",
        orderId: null,
        actor: "系统种子",
        detail: { initialMl: 1000, expiresAt: "2026-10-18" }
      }
    ]
  };
  deepFreeze(seed.events[0]);
  return seed;
}

// 读取（不存在则用种子初始化文件）。事件、旧稿（revisions/archivedSamples/voidedReleases）
// 一经写入即冻结，任何后续请求拿到的都是只读快照。
export async function loadDb(dbPath = defaultDbPath()) {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(buildSeed(), null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.batches ||= [];
  db.orders ||= [];
  db.events ||= [];
  db.seq ||= 1;
  db.meta ||= { concMin: CONC_MIN, concMax: CONC_MAX, developTanks: DEVELOP_TANKS };
  for (const e of db.events) deepFreeze(e);
  for (const o of db.orders) {
    (o.revisions || []).forEach(deepFreeze);
    (o.archivedSamples || []).forEach(deepFreeze);
    (o.voidedReleases || []).forEach(deepFreeze);
  }
  return db;
}

// 原子落盘：先写临时文件再 rename，避免半截记录留在正式数据文件里。
export async function saveDb(db, dbPath = defaultDbPath()) {
  const tmp = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

export function nextSeq(db) {
  db.seq = (db.seq || 0) + 1;
  return db.seq;
}

export function appendEvent(db, { at, type, batchNo, orderId = null, actor, detail = {} }) {
  const seq = nextSeq(db);
  const event = { seq, at, type, batchNo, orderId, actor: actor || "未署名", detail };
  deepFreeze(event);
  db.events.push(event);
  return event;
}

export function findBatch(db, batchNo) {
  return db.batches.find(b => b.batchNo === batchNo) || null;
}

export function findOrder(db, id) {
  return db.orders.find(o => o.id === id) || null;
}

// 旧稿快照：更正前把当时的关键字段、放行结论原样封存，之后只读。
export function snapshotRevision(order, reason, actor, at) {
  return {
    at,
    reason,
    actor: actor || "未署名",
    data: {
      volumeMl: order.volumeMl,
      concentration: order.concentration,
      operator: order.operator,
      status: order.status,
      batchRemainingMl: order.batchRemainingMlAtCreate ?? null,
      release: order.release ? cloneRelease(order.release) : null,
      samples: (order.samples || []).map(s => ({ ...s }))
    }
  };
}

function cloneRelease(release) {
  return {
    at: release.at,
    by: release.by,
    first: { ...release.first },
    second: { ...release.second },
    verdictText: release.verdictText
  };
}

// 放行失效重算：封存旧稿，清空当前取样轮，回到待复核。
export function voidOrderRelease(order, reason, db, at, actor, detail = {}) {
  order.revisions ||= [];
  order.voidedReleases ||= [];
  if (order.release) {
    order.voidedReleases.push(cloneRelease(order.release));
    order.release = null;
  }
  if (order.samples && order.samples.length) {
    order.archivedSamples ||= [];
    order.archivedSamples.push({ at, reason, samples: order.samples.map(s => ({ ...s })) });
    order.samples = [];
  }
  order.status = STATUS.REVIEW;
  order.revision = (order.revision || 1) + 1;
  const rev = snapshotRevision(order, reason, actor, at);
  // 快照存的是“更正前”状态，因此在改字段前调用；这里冻结封存。
  order.revisions.push(rev);
  deepFreeze(rev);
  appendEvent(db, {
    at,
    type: "RELEASE_VOIDED",
    batchNo: order.batchNo,
    orderId: order.id,
    actor,
    detail: { reason, ...detail }
  });
}

// ---- 派生视图：队列、槽位、批次履历全部由同一份存储现场计算，刷新后必然一致 ----

function orderView(o, tankAssign, concMin, concMax) {
  const inRange = concentrationInRange(o.concentration);
  return {
    id: o.id,
    rev: o.revision || 1,
    batchNo: o.batchNo,
    volumeMl: round1(o.volumeMl),
    concentration: Number(o.concentration),
    concentrationInRange: inRange,
    operator: o.operator,
    createdAt: o.createdAt,
    status: o.status,
    occupiesTank: inRange, // 占槽资格只看浓度；是否实际占用再看是否已结束
    tankHeld: !TERMINAL.includes(o.status) && inRange,
    tankNo: tankAssign.get(o.id) ?? null,
    samplesGiven: (o.samples || []).length,
    samples: o.samples || [],
    release: o.release || null,
    rejectedReason: o.rejectedReason || null,
    rejectedReasonText: o.rejectedReasonText || null,
    revisions: o.revisions || [],
    archivedSamples: o.archivedSamples || [],
    voidedReleases: o.voidedReleases || []
  };
}

// 分装队列：未结束在前，越界单标记不占槽
export function queueView(db, now) {
  const tanks = db.meta.developTanks;
  const orders = [...db.orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const live = orders.filter(o => !TERMINAL.includes(o.status));
  const tankAssign = new Map();
  let cursor = 1;
  for (const o of live) {
    if (concentrationInRange(o.concentration)) {
      tankAssign.set(o.id, cursor);
      cursor += 1;
    }
  }
  const occupied = tankAssign.size;
  return {
    now: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    limits: { concMin: db.meta.concMin, concMax: db.meta.concMax },
    tanks: { total: tanks, occupied, free: tanks - occupied, overCapacity: occupied > tanks },
    queue: live.map(o => orderView(o, tankAssign)),
    terminal: orders.filter(o => TERMINAL.includes(o.status)).map(o => orderView(o, tankAssign))
  };
}

// 批次履历：批次当前现场 + 相关事件流水 + 相关分装单（含只读旧稿）
export function batchHistoryView(db, batchNo, now) {
  const batch = findBatch(db, batchNo);
  if (!batch) return null;
  const events = db.events
    .filter(e => e.batchNo === batchNo)
    .sort((a, b) => a.seq - b.seq);
  const orders = db.orders
    .filter(o => o.batchNo === batchNo)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(o => orderView(o, new Map()));
  const dispensed = db.orders
    .filter(o => o.batchNo === batchNo)
    .reduce((sum, o) => sum + Number(o.volumeMl || 0), 0);
  const today = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  return {
    batch: { ...batch },
    inDate: today >= batch.openedAt && today <= batch.expiresAt,
    dispensedMl: round1(dispensed),
    events,
    orders
  };
}

// 存档总览：全部批次与全部事件（只读流水）
export function ledgerView(db, now) {
  return {
    now: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    limits: { concMin: db.meta.concMin, concMax: db.meta.concMax, tanks: db.meta.developTanks },
    batches: db.batches.map(b => ({ ...b })),
    events: [...db.events].sort((a, b) => a.seq - b.seq)
  };
}
