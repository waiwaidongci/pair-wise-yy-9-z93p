import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StationArchive } from "./station/archive.js";
import { stationIntake } from "./station/intake.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "cyanotype-negative-room.json");
const port = Number(process.env.PORT || 3040);
const seed = {
  "items": [
    {
      "code": "CN-001",
      "plateSize": "18x24cm",
      "chemicalBatch": "B-0620",
      "exposure": "8分钟",
      "waterSource": "井水过滤",
      "box": "蓝盒A-03",
      "status": "冲洗中",
      "defect": "边角显影不均",
      "logs": [
        {
          "at": "2026-06-20",
          "step": "曝光",
          "note": "阴天补时2分钟"
        }
      ]
    }
  ]
};
const fields = [["code","底片编号","text"],["plateSize","玻璃板尺寸","text"],["chemicalBatch","药液批次","text"],["exposure","曝光时间","text"],["waterSource","冲洗水源","text"],["box","存放盒位","text"]];
const stages = ["待曝光","冲洗中","待入盒","已交付"];
const statLabels = ["待曝光","冲洗中","待入盒","已交付"];
const extraFields = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "CN-" + Date.now(); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法蓝晒底片整理室 · 母液开封与分装放行台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --cyan:#2f5d6b; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } main { padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.cyan { background:var(--cyan); }
    .tabs { display:flex; gap:8px; margin-bottom:18px; } .tabs button { background:#e4e9e0; color:var(--ink); } .tabs button.active { background:var(--accent); color:#fff; }
    .layout { display:grid; grid-template-columns:380px 1fr; gap:22px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.review { color:var(--warn); border-color:var(--warn); } .pill.release { color:var(--cyan); border-color:var(--cyan); } .pill.ok { color:var(--accent); border-color:var(--accent); }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .tanks { display:grid; grid-template-columns:repeat(auto-fill,minmax(104px,1fr)); gap:8px; margin-bottom:14px; }
    .tank { border:1px solid var(--line); border-radius:6px; padding:8px; text-align:center; font-size:13px; background:#fff; }
    .tank.busy { border-color:var(--cyan); background:#eef4f6; } .tank b { display:block; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border-bottom:1px solid var(--line); padding:7px 8px; text-align:left; } th { color:var(--muted); font-weight:600; }
    .ledger { max-height:220px; overflow:auto; font-size:12px; } .ledger .e { border-left:3px solid var(--line); padding:4px 8px; margin:6px 0; }
    #toast { position:fixed; right:20px; bottom:20px; max-width:360px; display:none; background:#2a2e29; color:#fff; padding:12px 14px; border-radius:8px; font-size:13px; white-space:pre-wrap; z-index:9; }
    #toast.err { background:var(--warn); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{padding:16px;} .layout{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古法蓝晒底片整理室 · 母液开封与分装放行台</h1><div class="meta">底片工艺 / 母液开封、分装登记、双人取样复核与放行</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <div class="tabs">
      <button id="tabNegative" class="active">底片整理</button>
      <button id="tabStation">母液开封与分装放行台</button>
    </div>

    <section id="viewNegative" class="layout">
      <div>
        <form id="createForm"><h2>新增底片</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>' + s + '</option>').join('')}</select><button>保存底片</button></form>
        <form id="actionForm" style="margin-top:14px"><h2>记录工艺步骤</h2><label>选择底片</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      </div>
      <div>
        <div class="stats" id="stats"></div>
        <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>' + s + '</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
        <div class="panel"><h2>按涂布、晾干、曝光、冲洗、复晒、入盒记录每一步历史。</h2><div class="grid" id="cards"></div></div>
      </div>
    </section>

    <section id="viewStation" class="layout" style="display:none">
      <div>
        <form class="panel" id="openForm">
          <h2>母液开封</h2>
          <label>药液批次</label><input name="batchId" placeholder="如 B-0901" required>
          <label>开封母液总量（ml）</label><input name="initial" type="number" min="1" required>
          <label>开封日期</label><input name="openedAt" type="date">
          <label>有效期至</label><input name="expiresAt" type="date" required>
          <label>当班交接确认</label><select name="handoverConfirmed"><option value="true">已确认</option><option value="false">未确认</option></select>
          <button class="cyan">登记开封</button>
        </form>
        <form class="panel" id="registerForm" style="margin-top:14px">
          <h2>分装登记</h2>
          <label>药液批次</label><select name="batchId" id="regBatch" required></select>
          <label>分装量（ml，不得超过母液余量）</label><input name="amount" type="number" min="1" required>
          <label>显影浓度（%，合格区间 18–22）</label><input name="concentration" type="number" step="0.1" required>
          <label>操作者</label><input name="operator" required>
          <button class="cyan">登记分装单</button>
        </form>
      </div>
      <div>
        <div class="panel"><h2>显影槽占用</h2><div class="tanks" id="tanks"></div></div>
        <div class="panel" style="margin-top:14px"><h2>母液批次</h2><div class="grid" id="batchCards"></div></div>
        <div class="panel" style="margin-top:14px"><h2>分装队列（未结束分装单）</h2><div id="queueWrap"><table id="queueTable"></table></div></div>
        <div class="panel" style="margin-top:14px"><h2>全部分装单与批次履历（旧稿只读）</h2><div id="ordersWrap"></div><div id="ledgerWrap" class="ledger" style="margin-top:10px"></div></div>
      </div>
    </section>
  </main>
  <div id="toast"></div>

  <script>
    const fields = [["code","底片编号","text"],["plateSize","玻璃板尺寸","text"],["chemicalBatch","药液批次","text"],["exposure","曝光时间","text"],["waterSource","冲洗水源","text"],["box","存放盒位","text"]];
    const stages = ["待曝光","冲洗中","待入盒","已交付"];
    const extraFields = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];
    const ERRORS = {
      batch_not_found:"批次不存在", batch_already_open:"该批次已开封", handover_not_confirmed:"当班交接未确认，禁止分装",
      active_order_exists:"同一药液批次已有未结束分装单", amount_invalid:"分装量无效", concentration_invalid:"浓度无效",
      insufficient_remaining:"母液余量不足，冲突返回且未产生记录", initial_invalid:"母液总量无效", batch_id_required:"请填写批次号",
      expires_at_invalid:"效期无效", operator_required:"请填写操作者", reviewer_required:"请填写复核人",
      reviewer_must_be_another_operator:"复核必须由操作者之外的另一人完成", reviewer_must_be_continuous:"两次取样必须为同一复核人连续完成",
      order_not_found:"分装单不存在", order_already_released:"分装单已放行", no_free_tank:"没有空闲显影槽",
      remaining_invalid:"余量无效", sample_out_of_range:"取样浓度超出合格区间", batch_expired:"原批次已过效期",
      need_second_sample:"第一次取样已记录，请由同一复核人再次取样"
    };
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = []; let station = null;
    const toast = document.querySelector('#toast'); let toastTimer = null;
    function showToast(text, isErr) { toast.textContent = text; toast.className = isErr ? 'err' : ''; toast.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.style.display = 'none', 4200); }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const msg = ERRORS[data.error] || data.error || '请求失败'; const err = new Error(msg); err.code = data.error; throw err; }
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+esc(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await loadAll(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await loadAll(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key] ?? '')+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><span class="pill">'+esc(item.status)+'</span>'+main+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function esc(v){ const d=document.createElement('div'); d.textContent=v??''; return d.innerHTML; }

    // ---------- 放行台 ----------
    function pill(status) {
      const cls = status === '待复核' ? 'review' : status === '已放行' ? 'ok' : 'release';
      return '<span class="pill '+cls+'">'+status+'</span>';
    }
    function renderStation() {
      const s = station;
      document.querySelector('#regBatch').innerHTML = s.batches.map(b => '<option value="'+esc(b.batchId)+'">'+esc(b.batchId)+' · 余量 '+b.remaining+'ml · '+(b.handoverConfirmed?'交接已确认':'交接未确认')+(b.activeOrder?' · 单进行中':'')+'</option>').join('');
      document.querySelector('#tanks').innerHTML = s.tanks.map(t => '<div class="tank '+(t.occupied?'busy':'')+'"><b>'+t.no+'</b>'+(t.occupied ? esc(t.orderId)+'<br>'+esc(t.status) : '空闲')+'</div>').join('');
      document.querySelector('#batchCards').innerHTML = s.batches.map(b => '<div class="card"><h3>'+esc(b.batchId)+'</h3>'
        + '<div class="meta">开封 '+esc(b.openedAt)+' · 效期至 '+esc(b.expiresAt.slice(0,10))+'</div>'
        + '<div>余量 <b>'+b.remaining+'</b> / '+b.initial+' ml</div>'
        + '<div>'+(b.handoverConfirmed?'<span class="pill ok">交接已确认</span>':'<span class="pill review">交接未确认</span>')+'</div>'
        + '<div class="meta">分装单 '+b.orderCount+' 张'+(b.activeOrder?' · 进行中 '+esc(b.activeOrder.id):'')+'</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="secondary" onclick="correctBatch(\''+esc(b.batchId)+'\',\'remaining\')">更正余量</button><button class="secondary" onclick="correctBatch(\''+esc(b.batchId)+'\',\'handover\')">交接状态</button><button class="secondary" onclick="correctBatch(\''+esc(b.batchId)+'\',\'expires\')">更正效期</button></div>'
        + '</div>').join('');
      const qRows = s.queue.length ? s.queue.map(o => '<tr><td>'+esc(o.id)+'</td><td>'+esc(o.batchId)+'</td><td>'+o.amount+'ml</td><td>'+o.concentration+'%</td><td>'+esc(o.operator)+'</td><td>'+pill(o.status)+'</td><td>'+(o.tankNo?esc(o.tankNo):'—（不占槽）')+'</td><td>'+(o.samples.length)+'/2</td><td><button class="cyan" onclick="reviewOrder(\''+esc(o.id)+'\')">取样复核</button> <button class="secondary" onclick="correctOrder(\''+esc(o.id)+'\')">更正浓度</button></td></tr>').join('') : '<tr><td class="meta">当前没有未结束分装单</td></tr>';
      document.querySelector('#queueTable').innerHTML = '<tr><th>单号</th><th>批次</th><th>分装量</th><th>浓度</th><th>操作者</th><th>状态</th><th>显影槽</th><th>取样</th><th>操作</th></tr>' + qRows;
      document.querySelector('#ordersWrap').innerHTML = '<table><tr><th>单号</th><th>批次</th><th>量</th><th>浓度</th><th>操作者</th><th>复核人</th><th>状态</th><th>槽位</th><th>放行时间</th></tr>'
        + s.orders.map(o => '<tr><td>'+esc(o.id)+'</td><td>'+esc(o.batchId)+'</td><td>'+o.amount+'ml</td><td>'+o.concentration+'%</td><td>'+esc(o.operator)+'</td><td>'+esc(o.reviewer||'—')+'</td><td>'+pill(o.status)+'</td><td>'+(o.tankNo?esc(o.tankNo):'—')+'</td><td class="meta">'+(o.releasedAt?esc(o.releasedAt.replace('T',' ').slice(0,16)):'—')+'</td></tr>').join('') + '</table>';
      document.querySelector('#ledgerWrap').innerHTML = s.ledger.map(g => '<div><b>'+(g.batchId?esc(g.batchId):'未分组')+'</b>' + g.entries.map(e => '<div class="e"><span class="meta">#'+e.seq+' '+esc(e.at)+'</span> <b>'+esc(e.label)+'</b> <span class="meta">'+esc(JSON.stringify(e.payload))+'</span></div>').join('') + '</div>').join('');
    }
    async function reviewOrder(id) {
      const reviewer = prompt('复核取样人（须与操作者不同，且两次为同一人）'); if (reviewer === null) return;
      const concentration = Number(prompt('本次取样测得显影浓度（%，合格区间 18–22）'));
      if (!reviewer.trim() || Number.isNaN(concentration)) return showToast('输入无效', true);
      try {
        const r = await api('/api/station/orders/'+encodeURIComponent(id)+'/review', { method:'POST', body: JSON.stringify({ reviewer: reviewer.trim(), concentration }) });
        showToast(r.released ? ('已放行，占用 '+r.tankNo) : (ERRORS[r.reason] || r.reason));
      } catch (e) { showToast(e.message, true); }
      await loadAll();
    }
    async function correctOrder(id) {
      const concentration = Number(prompt('更正后的显影浓度（%）')); if (Number.isNaN(concentration)) return;
      try { const r = await api('/api/station/orders/'+encodeURIComponent(id)+'/correct', { method:'POST', body: JSON.stringify({ concentration }) }); showToast(r.note || '已更正，放行失效并重算'); }
      catch (e) { showToast(e.message, true); }
      await loadAll();
    }
    async function correctBatch(batchId, field) {
      const body = { batchId };
      if (field === 'remaining') { const v = Number(prompt('更正后的母液余量（ml）')); if (Number.isNaN(v) || v < 0) return; body.remaining = v; }
      if (field === 'handover') { body.handoverConfirmed = confirm('点击「确定」设为交接已确认；「取消」设为未确认'); }
      if (field === 'expires') { const v = prompt('更正后的效期（YYYY-MM-DD）'); if (!v) return; body.expiresAt = v; }
      try { const r = await api('/api/station/batches/correct', { method:'POST', body: JSON.stringify(body) }); showToast('已更正；失效重算放行单：'+(r.invalidated.length?r.invalidated.join(', '):'无')); }
      catch (e) { showToast(e.message, true); }
      await loadAll();
    }
    document.querySelector('#openForm').onsubmit = async e => { e.preventDefault(); const fd = new FormData(document.querySelector('#openForm')); const data = Object.fromEntries(fd.entries()); data.handoverConfirmed = data.handoverConfirmed === 'true';
      try { await api('/api/station/batches', { method:'POST', body: JSON.stringify(data) }); showToast('母液已开封'); document.querySelector('#openForm').reset(); } catch (err) { showToast(err.message, true); } await loadAll(); };
    document.querySelector('#registerForm').onsubmit = async e => { e.preventDefault(); const data = Object.fromEntries(new FormData(document.querySelector('#registerForm')).entries());
      try { const r = await api('/api/station/orders', { method:'POST', body: JSON.stringify(data) }); showToast(r.note); document.querySelector('#registerForm').reset(); } catch (err) { showToast(err.message, true); } await loadAll(); };
    document.querySelector('#tabNegative').onclick = () => { document.querySelector('#viewNegative').style.display='grid'; document.querySelector('#viewStation').style.display='none'; document.querySelector('#tabNegative').className='active'; document.querySelector('#tabStation').className=''; };
    document.querySelector('#tabStation').onclick = () => { document.querySelector('#viewNegative').style.display='none'; document.querySelector('#viewStation').style.display='grid'; document.querySelector('#tabStation').className='active'; document.querySelector('#tabNegative').className=''; loadAll(); };

    async function loadStation() { station = await api('/api/station/state'); renderStation(); }
    async function loadAll() { items = await api('/api/items'); render(); if (document.querySelector('#viewStation').style.display !== 'none') await loadStation(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await loadAll(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await loadAll(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = loadAll;
    renderForms(); loadAll();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    const archive = new StationArchive(db, saveDb);
    if (archive.seedIfEmpty()) await saveDb(db);
    const intake = stationIntake(archive);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    // ---------- 放行台 API ----------
    if (req.method === "GET" && url.pathname === "/api/station/state") {
      return send(res, 200, archive.snapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/station/batches") {
      const result = await intake.openBatch(await body(req));
      return send(res, result.status, result.body);
    }
    if (req.method === "POST" && url.pathname === "/api/station/batches/correct") {
      const result = await intake.correctBatch(await body(req));
      return send(res, result.status, result.body);
    }
    if (req.method === "POST" && url.pathname === "/api/station/orders") {
      const result = await intake.registerOrder(await body(req));
      return send(res, result.status, result.body);
    }
    const stationReview = url.pathname.match(/^\/api\/station\/orders\/([^/]+)\/review$/);
    if (stationReview && req.method === "POST") {
      const result = await intake.reviewSample({ orderId: decodeURIComponent(stationReview[1]), ...(await body(req)) });
      return send(res, result.status, result.body);
    }
    const stationCorrect = url.pathname.match(/^\/api\/station\/orders\/([^/]+)\/correct$/);
    if (stationCorrect && req.method === "POST") {
      const result = await intake.correctOrder({ orderId: decodeURIComponent(stationCorrect[1]), ...(await body(req)) });
      return send(res, result.status, result.body);
    }

    // ---------- 底片整理（既有功能） ----------
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建底片" }] };

      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.steps ||= [];
      item.steps.push({ at: new Date().toISOString(), ...input });
      if (input.defect) item.defect = input.defect;
      if (input.step === "冲洗") item.status = "冲洗中";
      else if (input.step === "入盒") item.status = "待入盒";
      else if (input.step === "交付") item.status = "已交付";
      else item.status = "待曝光";
      item.logs.push({ at: new Date().toISOString(), step: input.step || "工艺", note: input.note || input.developStatus || "步骤记录" });
      await saveDb(db);
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法蓝晒底片整理室 listening on http://localhost:" + port));
