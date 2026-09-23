import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dbDir = await mkdtemp(join(tmpdir(), "station-http-"));
process.env.STATION_DB = join(dbDir, "station.json");
process.env.PORT = "0";

const { createServer } = await import("../server.js");

function start() {
  return new Promise(resolve => {
    const srv = createServer().listen(0, () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function req(base, path, options) {
  const res = await fetch(base + path, options);
  const data = await res.json();
  return { status: res.status, data };
}
const post = (base, path, body) => req(base, path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});
const patch = (base, path, body) => req(base, path, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});
const batchBody = {
  batchNo: "B-HTTP1", openedAt: "2026-09-20", expiresAt: "2026-10-20",
  initialMl: 100, handoverConfirmed: true, operator: "甲"
};

test.beforeEach(async () => {
  // 每个用例独立数据文件：server 的 defaultDbPath 在每次请求时动态读取 STATION_DB。
  dbDir = await mkdtemp(join(tmpdir(), "station-http-case-"));
  process.env.STATION_DB = join(dbDir, "station.json");
});

test.afterEach(async () => {
  await rm(dbDir, { recursive: true, force: true });
});

test("HTTP 全流程：登记→双样→放行→更正失效→再复核", async () => {
  const { srv, base } = await start();
  try {
    assert.equal((await post(base, "/api/batches", batchBody)).status, 201);

    const r1 = await post(base, "/api/orders", { batchNo: "B-HTTP1", volumeMl: 40, concentration: 13, operator: "甲" });
    assert.equal(r1.status, 201);
    const id = r1.data.id;

    // 第二张未结束单 → 409，且队列仍只有一张
    const conflict = await post(base, "/api/orders", { batchNo: "B-HTTP1", volumeMl: 5, concentration: 13, operator: "乙" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error, "OPEN_ORDER_EXISTS");
    let q = (await req(base, "/api/queue")).data;
    assert.equal(q.queue.length, 1);
    assert.equal(q.tanks.occupied, 1);

    // 第二次取样同一人 → 409
    const same = await post(base, `/api/orders/${id}/samples`, { sampler: "A", concentration: 13 });
    assert.equal(same.status, 201, "第一次取样成功");
    const same2 = await post(base, `/api/orders/${id}/samples`, { sampler: "A", concentration: 13.2 });
    assert.equal(same2.status, 409);
    assert.equal(same2.data.error, "REVIEWER_SAME");

    // 换人合格 → 放行
    const rel = await post(base, `/api/orders/${id}/samples`, { sampler: "B", concentration: 13.2 });
    assert.equal(rel.status, 201);
    assert.equal(rel.data.stage, "RELEASED");
    q = (await req(base, "/api/queue")).data;
    assert.equal(q.queue.length, 0);
    assert.equal(q.terminal[0].status, "已放行");

    // 更正浓度 → 放行失效，回队列待复核
    const fix = await patch(base, `/api/orders/${id}`, { concentration: 12.8, reason: "读数笔误", actor: "班长" });
    assert.equal(fix.status, 200);
    assert.equal(fix.data.status, "待复核");
    q = (await req(base, "/api/queue")).data;
    assert.equal(q.queue.length, 1);
    const view = q.queue[0];
    assert.equal(view.voidedReleases.length, 1, "旧放行稿封存");
    assert.equal(view.samplesGiven, 0, "须重新双样");

    // 批次履历与队列一致
    const h = (await req(base, "/api/batches/B-HTTP1/history")).data;
    assert.equal(h.dispensedMl, 40);
    assert.equal(h.orders.length, 1);
    assert.deepEqual(h.orders.map(o => o.status), ["待复核"]);
    const eventTypes = h.events.map(e => e.type);
    assert.deepEqual(eventTypes, ["BATCH_OPENED", "ORDER_REGISTERED", "SAMPLE_TAKEN", "SAMPLE_TAKEN", "REVIEW_RELEASED", "RELEASE_VOIDED", "ORDER_CORRECTED"]);
  } finally {
    srv.close();
  }
});

test("HTTP：越界浓度不占槽，且双样越界判驳回", async () => {
  const { srv, base } = await start();
  try {
    await post(base, "/api/batches", batchBody);
    const r = await post(base, "/api/orders", { batchNo: "B-HTTP1", volumeMl: 10, concentration: 20, operator: "甲" });
    assert.equal(r.status, 201);
    const id = r.data.id;
    let q = (await req(base, "/api/queue")).data;
    assert.equal(q.tanks.occupied, 0);
    assert.equal(q.queue[0].tankHeld, false);

    await post(base, `/api/orders/${id}/samples`, { sampler: "A", concentration: 20 });
    const out = await post(base, `/api/orders/${id}/samples`, { sampler: "B", concentration: 13 });
    assert.equal(out.data.stage, "REJECTED");
    q = (await req(base, "/api/queue")).data;
    assert.equal(q.queue.length, 0);
    assert.equal(q.terminal[0].rejectedReason, "FIRST_SAMPLE_OUT_OF_RANGE");
  } finally {
    srv.close();
  }
});

test("HTTP：交接未确认时登记返回 409 且磁盘无新记录", async () => {
  const { srv, base } = await start();
  try {
    await post(base, "/api/batches", { ...batchBody, handoverConfirmed: false });
    const before = await readFile(process.env.STATION_DB, "utf8");
    const r = await post(base, "/api/orders", { batchNo: "B-HTTP1", volumeMl: 10, concentration: 13, operator: "甲" });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "HANDOVER_NOT_CONFIRMED");
    const after = await readFile(process.env.STATION_DB, "utf8");
    assert.equal(after, before, "冲突后文件内容不变（无半截记录）");
  } finally {
    srv.close();
  }
});

test("HTTP：批次更正交接状态后已放行单失效，履历与队列刷新一致", async () => {
  const { srv, base } = await start();
  try {
    await post(base, "/api/batches", batchBody);
    const r = await post(base, "/api/orders", { batchNo: "B-HTTP1", volumeMl: 10, concentration: 13, operator: "甲" });
    const id = r.data.id;
    await post(base, `/api/orders/${id}/samples`, { sampler: "A", concentration: 13 });
    await post(base, `/api/orders/${id}/samples`, { sampler: "B", concentration: 13 });
    const fixed = await patch(base, "/api/batches/B-HTTP1", { handoverConfirmed: false, reason: "交接补查", actor: "值班长" });
    assert.deepEqual(fixed.data.invalidatedOrders, [id]);
    const q = (await req(base, "/api/queue")).data;
    const h = (await req(base, "/api/batches/B-HTTP1/history")).data;
    assert.equal(q.queue[0].status, "待复核");
    assert.equal(h.orders[0].status, "待复核");
    assert.equal(h.orders[0].voidedReleases.length, 1);
  } finally {
    srv.close();
  }
});
