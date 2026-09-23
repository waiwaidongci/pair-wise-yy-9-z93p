import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATION_DB ||= "";

import {
  CONC_MIN,
  CONC_MAX,
  STATUS,
  concentrationInRange,
  batchInDate,
  occupiedTanks,
  reviewVerdict,
  findOpenOrderForBatch,
  DomainError
} from "../src/decision.js";
import { loadDb, saveDb, queueView, batchHistoryView, ledgerView, buildSeed } from "../src/archive.js";
import { openBatch, registerOrder, recordSample, correctOrder, correctBatch } from "../src/intake.js";

const NOW = new Date("2026-09-23T08:00:00.000Z");

// 入口层是同步函数（落盘由外层负责），用 assert.throws；统一一个判定 code 的辅助。
async function expectError(fn, code) {
  try {
    await fn();
  } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return;
  }
  assert.fail(`期望抛出 ${code}，但未抛错`);
}

async function freshDb() {
  const dir = await mkdtemp(join(tmpdir(), "station-"));
  const dbPath = join(dir, "station.json");
  process.env.STATION_DB = dbPath;
  const db = buildSeed(NOW);
  await saveDb(db, dbPath);
  return { db, dbPath, dir };
}

function makeBatch(overrides = {}) {
  return {
    batchNo: "B-1",
    openedAt: "2026-09-20",
    expiresAt: "2026-10-20",
    initialMl: 500,
    remainingMl: 500,
    handoverConfirmed: true,
    ...overrides
  };
}

// ---------- 判定层纯函数 ----------

test("浓度合格区间 12.0–14.0，边界值合格", () => {
  assert.equal(concentrationInRange(12.0), true);
  assert.equal(concentrationInRange(14.0), true);
  assert.equal(concentrationInRange(11.9), false);
  assert.equal(concentrationInRange(14.1), false);
});

test("效期按日期判定，过期日当天有效，次日失效", () => {
  const b = makeBatch({ openedAt: "2026-09-01", expiresAt: "2026-09-23" });
  assert.equal(batchInDate(b, new Date("2026-09-23T12:00:00Z")), true);
  assert.equal(batchInDate(b, new Date("2026-09-24T00:00:00Z")), false);
  assert.equal(batchInDate(b, new Date("2026-08-31T00:00:00Z")), false);
});

test("同一批次仅一张未结束分装单", () => {
  const orders = [{ batchNo: "B-1", status: STATUS.REVIEW }];
  assert.ok(findOpenOrderForBatch(orders, "B-1"));
  assert.equal(findOpenOrderForBatch([{ batchNo: "B-1", status: STATUS.RELEASED }], "B-1"), null);
  assert.equal(findOpenOrderForBatch([{ batchNo: "B-1", status: STATUS.REJECTED }], "B-1"), null);
});

test("占槽只看未结束且浓度合格的单", () => {
  const orders = [
    { status: STATUS.REVIEW, concentration: 13 },
    { status: STATUS.REVIEW, concentration: 15 }, // 越界不占槽
    { status: STATUS.RELEASED, concentration: 13 }, // 已结束释放
    { status: STATUS.REJECTED, concentration: 12 } // 已驳回释放
  ];
  assert.equal(occupiedTanks(orders), 1);
});

test("双人双样复核：换人、连续、均合格、批次在效期才放行", () => {
  const b = makeBatch();
  const s1 = { sampler: "甲", concentration: 13 };
  const s2 = { sampler: "乙", concentration: 13.5 };
  assert.equal(reviewVerdict({}, b, s1, s2, NOW).release, true);
  assert.equal(reviewVerdict({}, b, s1, { sampler: "甲", concentration: 13 }, NOW).reason, "REVIEWER_SAME");
  assert.equal(reviewVerdict({}, b, s1, { sampler: "乙", concentration: 11 }, NOW).reason, "SECOND_SAMPLE_OUT_OF_RANGE");
  assert.equal(reviewVerdict({}, b, { sampler: "甲", concentration: 15 }, s2, NOW).reason, "FIRST_SAMPLE_OUT_OF_RANGE");
  const expired = makeBatch({ expiresAt: "2026-09-22" });
  assert.equal(reviewVerdict({}, expired, s1, s2, NOW).reason, "BATCH_EXPIRED");
  const noHandover = makeBatch({ handoverConfirmed: false });
  assert.equal(reviewVerdict({}, noHandover, s1, s2, NOW).reason, "HANDOVER_NOT_CONFIRMED");
});

// ---------- 入口层：冲突不产生半截记录 ----------

test("余量不足：拒绝登记，余量与订单数不变，无事件新增", async () => {
  const { db } = await freshDb();
  const before = { remaining: db.batches[0].remainingMl, orders: db.orders.length, events: db.events.length };
  await expectError(
    () => registerOrder(db, { batchNo: "B-0918", volumeMl: 701, concentration: 13, operator: "甲" }, NOW),
    "INSUFFICIENT_REMAINING"
  );
  assert.equal(db.batches[0].remainingMl, before.remaining);
  assert.equal(db.orders.length, before.orders);
  assert.equal(db.events.length, before.events);
});

test("交接未确认：冲突返回，且无任何记录", async () => {
  const { db } = await freshDb();
  db.batches[0].handoverConfirmed = false;
  await expectError(
    () => registerOrder(db, { batchNo: "B-0918", volumeMl: 10, concentration: 13, operator: "甲" }, NOW),
    "HANDOVER_NOT_CONFIRMED"
  );
  assert.equal(db.orders.length, 0);
});

test("批次已过效期：拒绝分装", async () => {
  const { db } = await freshDb();
  db.batches[0].expiresAt = "2026-09-22";
  await expectError(
    () => registerOrder(db, { batchNo: "B-0918", volumeMl: 10, concentration: 13, operator: "甲" }, NOW),
    "BATCH_EXPIRED"
  );
});

test("同一批次未结束单存在：第二张冲突，且不扣余量", async () => {
  const { db } = await freshDb();
  registerOrder(db, { batchNo: "B-0918", volumeMl: 100, concentration: 13, operator: "甲" }, NOW);
  const remaining = db.batches[0].remainingMl;
  await expectError(
    () => registerOrder(db, { batchNo: "B-0918", volumeMl: 50, concentration: 13, operator: "乙" }, NOW),
    "OPEN_ORDER_EXISTS"
  );
  assert.equal(db.batches[0].remainingMl, remaining);
  assert.equal(db.orders.length, 1);
});

test("该单结束后同批次可再开新单，余量扣减正确", async () => {
  const { db } = await freshDb();
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 100, concentration: 13, operator: "甲" }, NOW);
  recordSample(db, o.id, { sampler: "复核员A", concentration: 13 }, NOW);
  recordSample(db, o.id, { sampler: "复核员B", concentration: 13.2 }, NOW);
  assert.equal(o.status, STATUS.RELEASED);
  const o2 = registerOrder(db, { batchNo: "B-0918", volumeMl: 50, concentration: 12.5, operator: "乙" }, NOW);
  assert.ok(o2.id);
  assert.equal(db.batches[0].remainingMl, 550); // 700 - 100 - 50
});

test("浓度越界：单转待复核且不占显影槽", async () => {
  const { db } = await freshDb();
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 30, concentration: 15, operator: "甲" }, NOW);
  assert.equal(o.status, STATUS.REVIEW);
  const q = queueView(db, NOW);
  assert.equal(q.tanks.occupied, 0);
  const view = q.queue.find(x => x.id === o.id);
  assert.equal(view.concentrationInRange, false);
  assert.equal(view.tankHeld, false);
  assert.equal(view.tankNo, null);
});

test("合格单占槽；放行后释放槽位", async () => {
  const { db } = await freshDb();
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 30, concentration: 13, operator: "甲" }, NOW);
  assert.equal(queueView(db, NOW).tanks.occupied, 1);
  recordSample(db, o.id, { sampler: "A", concentration: 13 }, NOW);
  recordSample(db, o.id, { sampler: "B", concentration: 13.4 }, NOW);
  assert.equal(o.status, STATUS.RELEASED);
  assert.equal(queueView(db, NOW).tanks.occupied, 0);
});

test("第二次取样仍是同一人：拒绝且不产生判定记录", async () => {
  const { db } = await freshDb();
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 30, concentration: 13, operator: "甲" }, NOW);
  recordSample(db, o.id, { sampler: "A", concentration: 13 }, NOW);
  const eventsBefore = db.events.length;
  await expectError(() => recordSample(db, o.id, { sampler: "A", concentration: 13 }, NOW), "REVIEWER_SAME");
  assert.equal(o.samples.length, 1);
  assert.equal(o.status, STATUS.REVIEW);
  assert.equal(db.events.length, eventsBefore);
});

test("双样中任一越界：驳回终态、释放槽位、归档可查", async () => {
  const { db } = await freshDb();
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 30, concentration: 13, operator: "甲" }, NOW);
  recordSample(db, o.id, { sampler: "A", concentration: 13 }, NOW);
  const out = recordSample(db, o.id, { sampler: "B", concentration: 14.5 }, NOW);
  assert.equal(out.stage, "REJECTED");
  assert.equal(o.status, STATUS.REJECTED);
  assert.equal(o.rejectedReason, "SECOND_SAMPLE_OUT_OF_RANGE");
  assert.equal(queueView(db, NOW).tanks.occupied, 0);
  // 已驳回归档只读，不能再取样
  await expectError(() => recordSample(db, o.id, { sampler: "C", concentration: 13 }, NOW), "ORDER_CLOSED");
});

// ---------- 更正：放行失效重算，旧稿只读 ----------

test("更正已放行单的浓度：放行失效、回待复核、旧稿封存只读，须重新双样", async () => {
  const { db } = await freshDb();
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 100, concentration: 13, operator: "甲" }, NOW);
  recordSample(db, o.id, { sampler: "A", concentration: 13 }, NOW);
  recordSample(db, o.id, { sampler: "B", concentration: 13.1 }, NOW);
  assert.equal(o.status, STATUS.RELEASED);
  const oldReleaseAt = o.release.at;

  correctOrder(db, o.id, { concentration: 13.6, reason: "复测读数修正", actor: "班长丙" }, NOW);
  assert.equal(o.status, STATUS.REVIEW);
  assert.equal(o.release, null);
  assert.equal(o.samples.length, 0, "新一轮取样必须重新进行");
  assert.equal(o.revision, 2);
  assert.equal(o.voidedReleases.length, 1);
  assert.equal(o.voidedReleases[0].at, oldReleaseAt);
  assert.equal(o.revisions.length, 1);
  assert.equal(o.revisions[0].data.concentration, 13); // 旧稿保存更正前的值

  // 旧稿是冻结对象
  const frozen = o.revisions[0];
  assert.ok(Object.isFrozen(frozen));
  assert.throws(() => { frozen.actor = "x"; }, TypeError);

  // 重新双样（另一人）后方可再放行
  recordSample(db, o.id, { sampler: "复核员C", concentration: 13.4 }, NOW);
  recordSample(db, o.id, { sampler: "复核员D", concentration: 13.5 }, NOW);
  assert.equal(o.status, STATUS.RELEASED);
});

test("越界单更正为合格：重新占槽；合格改越界：释放槽位", async () => {
  const { db } = await freshDb();
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 30, concentration: 15, operator: "甲" }, NOW);
  assert.equal(queueView(db, NOW).tanks.occupied, 0);
  correctOrder(db, o.id, { concentration: 13, reason: "登记笔误", actor: "丙" }, NOW);
  assert.equal(queueView(db, NOW).tanks.occupied, 1);
  correctOrder(db, o.id, { concentration: 11, reason: "再次核对", actor: "丙" }, NOW);
  assert.equal(queueView(db, NOW).tanks.occupied, 0);
});

test("更正分装量：余量联动重算，导致负余量则拒绝且无任何变更", async () => {
  const { db } = await freshDb();
  // 余量 700，开一张 650 的单 → 余 50
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 650, concentration: 13, operator: "甲" }, NOW);
  assert.equal(db.batches[0].remainingMl, 50);
  const revBefore = o.revision;
  await expectError(
    () => correctOrder(db, o.id, { volumeMl: 760, reason: "量错了", actor: "丙" }, NOW),
    "INSUFFICIENT_REMAINING"
  );
  assert.equal(o.volumeMl, 650);
  assert.equal(db.batches[0].remainingMl, 50);
  assert.equal(o.revision, revBefore);
  assert.equal(o.revisions.length, 0);

  // 合法调小 → 余量回升
  correctOrder(db, o.id, { volumeMl: 600, reason: "实取修正", actor: "丙" }, NOW);
  assert.equal(o.volumeMl, 600);
  assert.equal(db.batches[0].remainingMl, 100);
});

test("批次更正交接状态：该批次所有已放行单失效重算；待复核单不受回滚影响", async () => {
  const { db } = await freshDb();
  const o1 = registerOrder(db, { batchNo: "B-0918", volumeMl: 50, concentration: 13, operator: "甲" }, NOW);
  recordSample(db, o1.id, { sampler: "A", concentration: 13 }, NOW);
  recordSample(db, o1.id, { sampler: "B", concentration: 13.1 }, NOW);
  assert.equal(o1.status, STATUS.RELEASED);

  const out = correctBatch(db, "B-0918", { handoverConfirmed: false, reason: "交接记录补登", actor: "值班长" }, NOW);
  assert.deepEqual(out.invalidatedOrders, [o1.id]);
  assert.equal(o1.status, STATUS.REVIEW);
  assert.equal(o1.release, null);
  assert.equal(o1.voidedReleases.length, 1);
  assert.equal(db.batches[0].handoverConfirmed, false);
  // 交接未确认时不能再放行（双样判定失败）
  recordSample(db, o1.id, { sampler: "C", concentration: 13 }, NOW);
  const v = recordSample(db, o1.id, { sampler: "D", concentration: 13 }, NOW);
  assert.equal(v.stage, "REJECTED");
  assert.equal(v.verdict.reason, "HANDOVER_NOT_CONFIRMED");
});

test("批次更正余量为负被拒绝；不可更正字段被拒", async () => {
  const { db } = await freshDb();
  await expectError(() => correctBatch(db, "B-0918", { remainingMl: -1, reason: "x", actor: "y" }, NOW), "INVALID_VOLUME");
  await expectError(() => correctBatch(db, "B-0918", { expiresAt: "2027-01-01", reason: "x", actor: "y" }, NOW), "FIELD_NOT_CORRECTABLE");
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 30, concentration: 13, operator: "甲" }, NOW);
  await expectError(() => correctOrder(db, o.id, { operator: "丁", reason: "换人", actor: "丙" }, NOW), "FIELD_NOT_CORRECTABLE");
});

test("已驳回单不可更正，旧稿只读", async () => {
  const { db } = await freshDb();
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 30, concentration: 13, operator: "甲" }, NOW);
  recordSample(db, o.id, { sampler: "A", concentration: 11 }, NOW);
  recordSample(db, o.id, { sampler: "B", concentration: 13 }, NOW);
  assert.equal(o.status, STATUS.REJECTED);
  await expectError(() => correctOrder(db, o.id, { concentration: 13, reason: "x", actor: "y" }, NOW), "ORDER_CLOSED");
});

// ---------- 存档层：队列与批次履历刷新后一致 ----------

test("队列槽位、批次履历、总账三种视图对同一份存储一致", async () => {
  const { db } = await freshDb();
  const o1 = registerOrder(db, { batchNo: "B-0918", volumeMl: 100, concentration: 13, operator: "甲" }, NOW);
  // 直接开第二张同批次单会冲突，改用另一批次验证多批次履历
  openBatch(db, { batchNo: "B-0919", openedAt: "2026-09-20", expiresAt: "2026-10-20", initialMl: 200, handoverConfirmed: true, operator: "乙" }, NOW);
  const o3 = registerOrder(db, { batchNo: "B-0919", volumeMl: 40, concentration: 15, operator: "乙" }, NOW);
  recordSample(db, o1.id, { sampler: "A", concentration: 13 }, NOW);
  recordSample(db, o1.id, { sampler: "B", concentration: 13.1 }, NOW); // o1 放行
  assert.equal(o1.status, STATUS.RELEASED);

  const q = queueView(db, NOW);
  const h1 = batchHistoryView(db, "B-0918", NOW);
  const h2 = batchHistoryView(db, "B-0919", NOW);
  const ledger = ledgerView(db, NOW);

  // 队列里只剩 o3（越界，不占槽），o1 在终态区
  assert.deepEqual(q.queue.map(x => x.id), [o3.id]);
  assert.equal(q.tanks.occupied, 0);
  assert.deepEqual(q.terminal.map(x => x.id), [o1.id]);
  // 履历各自独立
  assert.deepEqual(h1.orders.map(x => x.id), [o1.id]);
  assert.deepEqual(h2.orders.map(x => x.id), [o3.id]);
  assert.equal(h1.dispensedMl, 100);
  assert.equal(h2.dispensedMl, 40);
  // 事件流水含全部事件且按序
  const types = ledger.events.map(e => e.type);
  assert.ok(types.includes("REVIEW_RELEASED"));
  assert.ok(types.includes("ORDER_REGISTERED"));
  assert.deepEqual(ledger.events.map(e => e.seq), [...ledger.events.map(e => e.seq)].sort((a, b) => a - b));
  // 冻结事件不可改
  assert.ok(Object.isFrozen(ledger.events[0]));
});

test("落盘重载后视图不变（刷新一致）", async () => {
  const { db, dbPath, dir } = await freshDb();
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 80, concentration: 15, operator: "甲" }, NOW);
  correctOrder(db, o.id, { concentration: 13.2, reason: "笔误", actor: "丙" }, NOW);
  await saveDb(db, dbPath);

  const reloaded = await loadDb(dbPath);
  const q1 = JSON.stringify(queueView(db, NOW));
  const q2 = JSON.stringify(queueView(reloaded, NOW));
  assert.equal(q1, q2);
  // 旧稿重载后依然只读
  const view = queueView(reloaded, NOW).queue[0];
  assert.ok(Object.isFrozen(view.revisions[0]));
  await rm(dir, { recursive: true, force: true });
});

test("冲突请求后磁盘文件仍是冲突前内容（无半截记录）", async () => {
  const { db, dbPath, dir } = await freshDb();
  await saveDb(db, dbPath);
  const before = await readFile(dbPath, "utf8");
  const o = registerOrder(db, { batchNo: "B-0918", volumeMl: 100, concentration: 13, operator: "甲" }, NOW);
  // 模拟 HTTP 层行为：抛错时不调用 saveDb
  await assert.rejects(async () => {
    registerOrder(db, { batchNo: "B-0918", volumeMl: 10, concentration: 13, operator: "乙" }, NOW);
    throw new Error("不应到这里");
  }, DomainError);
  const after = await readFile(dbPath, "utf8");
  assert.equal(after, before);
  await rm(dir, { recursive: true, force: true });
});

test("开封：重复批次号冲突", async () => {
  const { db } = await freshDb();
  await expectError(
    () => openBatch(db, { batchNo: "B-0918", openedAt: "2026-09-20", expiresAt: "2026-10-20", initialMl: 10, operator: "x" }, NOW),
    "BATCH_EXISTS"
  );
});

test("槽位满：合格单登记冲突，越界单仍可登记（不占槽）", async () => {
  const { db } = await freshDb();
  // 种子批次余量 700，槽 6；开 6 张合格单需要 6 个不同批次（同批次只能一张未结束单）
  for (let i = 1; i <= 6; i++) {
    const no = `B-T${i}`;
    openBatch(db, { batchNo: no, openedAt: "2026-09-20", expiresAt: "2026-10-20", initialMl: 500, handoverConfirmed: true, operator: "甲" }, NOW);
    registerOrder(db, { batchNo: no, volumeMl: 10, concentration: 13, operator: "甲" }, NOW);
  }
  assert.equal(queueView(db, NOW).tanks.occupied, 6);
  const no = "B-T7";
  openBatch(db, { batchNo: no, openedAt: "2026-09-20", expiresAt: "2026-10-20", initialMl: 500, handoverConfirmed: true, operator: "甲" }, NOW);
  await expectError(
    () => registerOrder(db, { batchNo: no, volumeMl: 10, concentration: 12.5, operator: "甲" }, NOW),
    "NO_FREE_TANK"
  );
  // 越界单不占槽，允许登记
  const o = registerOrder(db, { batchNo: no, volumeMl: 10, concentration: 20, operator: "甲" }, NOW);
  assert.equal(o.status, STATUS.REVIEW);
  assert.equal(queueView(db, NOW).tanks.occupied, 6);
});
