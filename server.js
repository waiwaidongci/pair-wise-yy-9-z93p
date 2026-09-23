import http from "node:http";
import { defaultDbPath, loadDb, saveDb, queueView, batchHistoryView, ledgerView } from "./src/archive.js";
import {
  openBatch,
  registerOrder,
  recordSample,
  correctOrder,
  correctBatch
} from "./src/intake.js";
import { DomainError } from "./src/decision.js";
import { page } from "./src/ui.js";

const port = Number(process.env.PORT || 3040);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("BAD_JSON", "请求体不是合法 JSON", 400);
  }
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const now = new Date();

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page());
  }

  const dbPath = defaultDbPath();
  const db = await loadDb(dbPath);

  // 读路由
  if (req.method === "GET" && url.pathname === "/api/queue") {
    return send(res, 200, queueView(db, now));
  }
  if (req.method === "GET" && url.pathname === "/api/ledger") {
    return send(res, 200, ledgerView(db, now));
  }
  const historyMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/history$/);
  if (req.method === "GET" && historyMatch) {
    const view = batchHistoryView(db, decodeURIComponent(historyMatch[1]), now);
    if (!view) return send(res, 404, { error: "BATCH_NOT_FOUND", message: "药液批次不存在" });
    return send(res, 200, view);
  }

  // 写路由：入口层先完成校验与内存变更，全部成功后才统一原子落盘。
  // 任何 DomainError 都在 saveDb 之前抛出 → 冲突不落库、无半截记录。
  const mutate = async fn => {
    const result = fn();
    await saveDb(db, dbPath);
    return result;
  };

  try {
    if (req.method === "POST" && url.pathname === "/api/batches") {
      const input = await body(req);
      const batch = await mutate(() => openBatch(db, input, now));
      return send(res, 201, batch);
    }
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const input = await body(req);
      const order = await mutate(() => registerOrder(db, input, now));
      return send(res, 201, order);
    }
    const sampleMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/samples$/);
    if (req.method === "POST" && sampleMatch) {
      const input = await body(req);
      const out = await mutate(() => recordSample(db, decodeURIComponent(sampleMatch[1]), input, now));
      return send(res, 201, out);
    }
    const orderPatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (req.method === "PATCH" && orderPatch) {
      const input = await body(req);
      const order = await mutate(() => correctOrder(db, decodeURIComponent(orderPatch[1]), input, now));
      return send(res, 200, order);
    }
    const batchPatch = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
    if (req.method === "PATCH" && batchPatch) {
      const input = await body(req);
      const out = await mutate(() => correctBatch(db, decodeURIComponent(batchPatch[1]), input, now));
      return send(res, 200, out);
    }
    return send(res, 404, { error: "not_found", message: "未找到对应资源" });
  } catch (error) {
    if (error instanceof DomainError) {
      return send(res, error.status, { error: error.code, message: error.message, details: error.details });
    }
    return send(res, 500, { error: "internal", message: error.message });
  }
}

export function createServer() {
  return http.createServer((req, res) => {
    handler(req, res).catch(error => send(res, 500, { error: "internal", message: error.message }));
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  createServer().listen(port, () => console.log("母液开封与分装放行台 listening on http://localhost:" + port));
}
