// 工作台页面：入口（开封/分装登记）、判定（队列与双人双样复核）、存档（批次履历与流水）。
// 页面只做展示与调用 API，所有判定均在后端 src/decision.js 完成。

export function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>母液开封与分装放行台</title>
  <style>
    :root { --bg:#eef1ec; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#2f5d8a; --warn:#9b4937; --ok:#3f7a4b; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:23px; } h2 { margin:0 0 10px; font-size:16px; } h3 { margin:0; font-size:15px; }
    main { display:grid; grid-template-columns:360px 1fr 1fr; gap:16px; padding:18px 24px; align-items:start; }
    .col { display:grid; gap:14px; }
    form,.panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    label { display:block; margin:8px 0 4px; color:var(--muted); font-size:12px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; margin-top:10px; }
    button.secondary { background:#69736a; } button.small { padding:5px 9px; font-size:12px; margin-top:6px; }
    .meta { color:var(--muted); font-size:12px; } .warn { color:var(--warn); font-weight:700; } .ok { color:var(--ok); font-weight:700; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
    .pill.review { background:#fdf6e3; border-color:#d8c27a; } .pill.released { background:#e8f3ea; border-color:#9cc2a6; color:var(--ok); }
    .pill.rejected { background:#f7e8e4; border-color:#d2a093; color:var(--warn); }
    .tanks { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
    .slot { width:30px; height:22px; border:1px solid var(--line); border-radius:5px; display:grid; place-items:center; font-size:11px; background:#fff; }
    .slot.on { background:var(--accent); color:#fff; border-color:var(--accent); }
    .card { display:grid; gap:6px; margin-bottom:10px; } .card .row { display:flex; justify-content:space-between; gap:8px; align-items:center; flex-wrap:wrap; }
    .scroll { max-height:340px; overflow:auto; } .event { border-left:3px solid var(--line); padding:4px 8px; margin:6px 0; font-size:12px; }
    .event b { font-size:12px; } .readonly { background:#f4f5f2; border:1px dashed var(--line); border-radius:6px; padding:8px; font-size:12px; }
    #alert { position:fixed; top:12px; right:12px; max-width:380px; z-index:10; }
    #alert .msg { background:#f7e8e4; border:1px solid #d2a093; color:var(--warn); padding:10px 14px; border-radius:8px; font-weight:700; margin-bottom:8px; cursor:pointer; }
    details summary { cursor:pointer; color:var(--muted); font-size:12px; margin-top:4px; }
    @media (max-width:1100px){ main{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <div id="alert"></div>
  <header>
    <div><h1>母液开封与分装放行台</h1>
      <div class="meta">古法蓝晒 · 入口登记 / 判定放行 / 存档履历 三岗分置 · 合格区间 <span id="range"></span></div>
    </div>
    <button id="reload" class="secondary">刷新队列与履历</button>
  </header>
  <main>
    <section class="col">
      <form id="batchForm">
        <h2>① 母液开封登记（入口）</h2>
        <label>药液批次号</label><input name="batchNo" required placeholder="B-0923">
        <label>开封日期 / 效期至</label>
        <div style="display:flex;gap:8px"><input name="openedAt" type="date" required><input name="expiresAt" type="date" required></div>
        <label>初始母液量（ml）</label><input name="initialMl" type="number" step="0.1" min="0.1" required>
        <label>当班交接已确认</label><select name="handoverConfirmed"><option value="true">已确认</option><option value="false">未确认</option></select>
        <label>开封操作者</label><input name="operator" required placeholder="姓名">
        <button>开封存档</button>
      </form>
      <form id="orderForm">
        <h2>分装登记（入口）</h2>
        <label>药液批次</label><select name="batchNo" id="orderBatch" required></select>
        <label>分装量（ml）</label><input name="volumeMl" type="number" step="0.1" min="0.1" required>
        <label>显影浓度（%，越界只转待复核、不占显影槽）</label><input name="concentration" type="number" step="0.1" required>
        <label>操作者</label><input name="operator" required placeholder="登记人姓名">
        <button>提交分装单</button>
      </form>
    </section>

    <section class="col">
      <div class="panel">
        <h2>② 判定：分装队列与显影槽</h2>
        <div id="tanks"></div>
        <div id="queue"></div>
      </div>
      <div class="panel">
        <h2>双人双样复核取样</h2>
        <form id="sampleForm">
          <label>分装单</label><select name="orderId" id="sampleOrder" required></select>
          <label>取样人（第二次须为另一人）</label><input name="sampler" required>
          <label>本次取样浓度（%）</label><input name="concentration" type="number" step="0.1" required>
          <button>提交第 <span id="sampleRound">1</span> 次取样</button>
        </form>
      </div>
      <div class="panel">
        <h2>更正（放行失效重算，旧稿只读）</h2>
        <form id="orderFixForm">
          <label>分装单</label><select name="orderId" id="fixOrder"></select>
          <div style="display:flex;gap:8px"><div style="flex:1"><label>新分装量</label><input name="volumeMl" type="number" step="0.1" placeholder="不改留空"></div>
          <div style="flex:1"><label>新浓度</label><input name="concentration" type="number" step="0.1" placeholder="不改留空"></div></div>
          <label>更正操作者</label><input name="actor" required>
          <label>更正原因</label><input name="reason" required>
          <button class="secondary">更正分装单</button>
        </form>
        <form id="batchFixForm" style="margin-top:10px">
          <label>批次</label><select name="batchNo" id="fixBatch"></select>
          <div style="display:flex;gap:8px"><div style="flex:1"><label>新余量（ml）</label><input name="remainingMl" type="number" step="0.1" placeholder="不改留空"></div>
          <div style="flex:1"><label>当班交接</label><select name="handoverConfirmed"><option value="">不改</option><option value="true">已确认</option><option value="false">未确认</option></select></div></div>
          <label>更正操作者</label><input name="actor" required>
          <label>更正原因</label><input name="reason" required>
          <button class="secondary">更正批次现场</button>
        </form>
      </div>
    </section>

    <section class="col">
      <div class="panel">
        <h2>③ 存档：批次履历</h2>
        <label>选择批次</label><select id="historyBatch"></select>
        <div id="history"></div>
      </div>
      <div class="panel">
        <h2>批次当前现场</h2>
        <div id="batches" class="scroll"></div>
      </div>
      <div class="panel">
        <h2>全部事件流水（只追加）</h2>
        <div id="events" class="scroll"></div>
      </div>
    </section>
  </main>
  <script>
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function api(path, options) {
    const res = await fetch(path, options ? { ...options, headers:{ 'Content-Type':'application/json' } } : {});
    const data = await res.json();
    if (!res.ok) {
      const e = new Error(data.message || '请求失败'); e.payload = data; throw e;
    }
    return data;
  }
  function flash(msg) {
    const box = document.querySelector('#alert');
    const el = document.createElement('div'); el.className = 'msg'; el.textContent = '✕ ' + msg;
    el.onclick = () => el.remove(); box.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
  function pill(status) {
    const cls = status === '已放行' ? 'released' : status === '已驳回' ? 'rejected' : 'review';
    return '<span class="pill '+cls+'">'+esc(status)+'</span>';
  }
  let queue, ledger;
  async function load() {
    [queue, ledger] = await Promise.all([api('/api/queue'), api('/api/ledger')]);
    document.querySelector('#range').textContent = queue.limits.concMin + '–' + queue.limits.concMax + '%';
    renderSelects(); renderTanks(); renderQueue(); renderBatches(); renderEvents(); renderHistoryIfPicked();
  }
  function renderSelects() {
    const batches = ledger.batches.map(b => esc(b.batchNo));
    document.querySelector('#orderBatch').innerHTML = batches.map(b => '<option>'+b+'</option>').join('');
    document.querySelector('#fixBatch').innerHTML = batches.map(b => '<option>'+b+'</option>').join('');
    document.querySelector('#historyBatch').innerHTML = batches.map(b => '<option>'+b+'</option>').join('');
    const live = queue.queue;
    document.querySelector('#sampleOrder').innerHTML = live.map(o => '<option value="'+o.id+'">'+o.id+' · '+esc(o.batchNo)+' · 已取样'+o.samplesGiven+'次</option>').join('') || '<option value="">（无待复核单）</option>';
    const fixable = [...queue.queue, ...queue.terminal.filter(o => o.status === '已放行')];
    document.querySelector('#fixOrder').innerHTML = fixable.map(o => '<option value="'+o.id+'">'+o.id+' · '+esc(o.status)+'</option>').join('') || '<option value="">（无可更正单）</option>';
    const so = document.querySelector('#sampleOrder');
    const picked = live.find(o => o.id === so.value) || live[0];
    document.querySelector('#sampleRound').textContent = picked ? picked.samplesGiven + 1 : 1;
  }
  function renderTanks() {
    const t = queue.tanks;
    let html = '<div class="meta">显影槽占用 '+t.occupied+'/'+t.total+'，空槽 '+t.free+(t.overCapacity?' <span class="warn">超容！</span>':'')+'</div><div class="tanks">';
    for (let i = 1; i <= t.total; i++) html += '<div class="slot '+(i <= t.occupied ? 'on' : '')+'">'+i+'</div>';
    document.querySelector('#tanks').innerHTML = html + '</div>';
  }
  function samplesHtml(o) {
    const s = (o.samples || []).map((x, i) => '第'+(i+1)+'次 '+esc(x.sampler)+' 测 '+x.concentration+'%'+
      (x.concentration>=queue.limits.concMin && x.concentration<=queue.limits.concMax ? ' <span class="ok">合格</span>' : ' <span class="warn">越界</span>')).join('；');
    return s ? '<div class="meta">'+s+'</div>' : '';
  }
  function readonlyHtml(o) {
    let html = '';
    if (o.release) html += '<div class="readonly">放行稿 v'+o.rev+'：'+esc(o.release.by)+' 双样 '
      +o.release.first.concentration+'% / '+o.release.second.concentration+'% @ '+esc(o.release.at)+'</div>';
    const voided = (o.voidedReleases||[]);
    if (voided.length) html += voided.map(v => '<div class="readonly">旧放行稿（已失效，只读）：'+esc(v.by)+' '
      +v.first.concentration+'% / '+v.second.concentration+'% @ '+esc(v.at)+'</div>').join('');
    const revs = (o.revisions||[]);
    if (revs.length) html += '<details><summary>旧稿与更正痕迹（'+revs.length+' 份，只读）</summary>'
      + revs.map(r => '<div class="readonly">v'+esc(r.data.status)+' · '+esc(r.reason)+' · '+esc(r.actor)+' @ '+esc(r.at)
        +'<br>分装量 '+r.data.volumeMl+'ml，浓度 '+r.data.concentration+'%</div>').join('') + '</details>';
    return html;
  }
  function cardHtml(o) {
    const badge = o.concentrationInRange ? '<span class="ok">浓度合格·占槽'+(o.tankHeld ? ' #'+o.tankNo : '（已释放）')+'</span>'
      : '<span class="warn">浓度越界·不占槽</span>';
    let tail = '';
    if (o.status === '待复核') tail = '<div class="meta">等待另一人连续两次取样均落入 '+queue.limits.concMin+'–'+queue.limits.concMax+'%，且批次仍在效期。</div>';
    if (o.status === '已驳回') tail = '<div class="warn">已驳回：'+esc(o.rejectedReasonText || o.rejectedReason)+'</div>';
    if (o.status === '已放行') tail = '<div class="ok">已放行：'+esc(o.release.verdictText)+'</div>';
    return '<article class="card"><div class="row"><h3>'+o.id+' <span class="meta">rev '+o.rev+'</span></h3>'+pill(o.status)+'</div>'
      + '<div class="meta">批次 '+esc(o.batchNo)+' · 分装 '+o.volumeMl+'ml · 登记浓度 '+o.concentration+'% · 操作者 '+esc(o.operator)+'</div>'
      + '<div class="row">'+badge+'</div>' + samplesHtml(o) + tail + readonlyHtml(o) + '</article>';
  }
  function renderQueue() {
    const html = queue.queue.map(cardHtml).join('') || '<div class="meta">队列为空</div>';
    const closed = queue.terminal.map(cardHtml).join('');
    document.querySelector('#queue').innerHTML = '<div class="scroll">'+html+'</div>'
      + (closed ? '<h3 style="margin-top:10px">已结束（归档）</h3><div class="scroll" style="max-height:200px">'+closed+'</div>' : '');
  }
  function renderBatches() {
    document.querySelector('#batches').innerHTML = ledger.batches.map(b =>
      '<div class="card"><div class="row"><h3>'+esc(b.batchNo)+'</h3>'
      + '<span class="pill '+(b.handoverConfirmed ? 'released' : 'rejected')+'">'+(b.handoverConfirmed ? '交接已确认' : '交接未确认')+'</span></div>'
      + '<div class="meta">开封 '+b.openedAt+' · 效期至 '+b.expiresAt+' · 初始 '+b.initialMl+'ml · 余量 <b>'+b.remainingMl+'ml</b></div></div>').join('');
  }
  function renderEvents() {
    const labels = { BATCH_OPENED:'开封', ORDER_REGISTERED:'分装登记', SAMPLE_TAKEN:'取样', REVIEW_RELEASED:'放行', REVIEW_REJECTED:'驳回', ORDER_CORRECTED:'单更正', BATCH_CORRECTED:'批次更正', RELEASE_VOIDED:'放行失效' };
    document.querySelector('#events').innerHTML = ledger.events.slice().reverse().map(e =>
      '<div class="event"><b>['+labels[e.type] || e.type+']</b> '+esc(e.batchNo)+(e.orderId ? ' / '+e.orderId : '')
      +' <span class="meta">'+esc(e.at)+' · '+esc(e.actor)+'</span><div class="meta">'+esc(JSON.stringify(e.detail))+'</div></div>').join('');
  }
  async function renderHistoryIfPicked() {
    const sel = document.querySelector('#historyBatch');
    if (!sel.value || !ledger.batches.length) { document.querySelector('#history').innerHTML = ''; return; }
    const h = await api('/api/batches/'+encodeURIComponent(sel.value)+'/history');
    const open = h.orders.filter(o => o.status === '待复核').length;
    document.querySelector('#history').innerHTML =
      '<div class="meta">在效期：'+(h.inDate ? '<span class="ok">是</span>' : '<span class="warn">否</span>')
      +' · 累计分装登记 '+h.dispensedMl+'ml · 未结束单 '+open+' 张</div>'
      + '<div class="scroll" style="max-height:260px;margin-top:6px">'
      + h.events.map(e => '<div class="event"><b>'+esc(e.type)+'</b> <span class="meta">'+esc(e.at)+' · '+esc(e.actor)+'</span>'
        +(e.orderId ? '<div class="meta">'+esc(e.orderId)+'</div>' : '')+'</div>').join('') + '</div>';
  }
  function formJson(form) {
    const obj = Object.fromEntries(new FormData(form).entries());
    for (const [k, v] of Object.entries(obj)) if (v === '' || v === null) delete obj[k];
    return obj;
  }
  async function submit(path, form, patchBody) {
    try {
      const body = patchBody || formJson(form);
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      if (form) form.reset();
      await load();
    } catch (e) { flash(e.message + (e.payload && e.payload.details ? '（'+JSON.stringify(e.payload.details)+'）' : '')); }
  }
  document.querySelector('#batchForm').onsubmit = e => { e.preventDefault();
    const b = formJson(e.target); b.handoverConfirmed = b.handoverConfirmed === 'true';
    submit('/api/batches', e.target, b); };
  document.querySelector('#orderForm').onsubmit = e => { e.preventDefault(); submit('/api/orders', e.target); };
  document.querySelector('#sampleForm').onsubmit = e => { e.preventDefault();
    const id = document.querySelector('#sampleOrder').value;
    if (!id) return flash('没有待复核分装单');
    submit('/api/orders/'+encodeURIComponent(id)+'/samples', e.target); };
  document.querySelector('#sampleOrder').onchange = () => {
    const o = queue.queue.find(x => x.id === document.querySelector('#sampleOrder').value);
    document.querySelector('#sampleRound').textContent = o ? o.samplesGiven + 1 : 1;
  };
  document.querySelector('#orderFixForm').onsubmit = e => { e.preventDefault();
    const id = document.querySelector('#fixOrder').value; if (!id) return flash('选择要更正的分装单');
    api('/api/orders/'+encodeURIComponent(id), { method:'PATCH', body: JSON.stringify(formJson(e.target)) })
      .then(() => { e.target.reset(); load(); }).catch(err => flash(err.message)); };
  document.querySelector('#batchFixForm').onsubmit = e => { e.preventDefault();
    const no = document.querySelector('#fixBatch').value;
    const body = formJson(e.target);
    if ('handoverConfirmed' in body) body.handoverConfirmed = body.handoverConfirmed === 'true';
    api('/api/batches/'+encodeURIComponent(no), { method:'PATCH', body: JSON.stringify(body) })
      .then(() => { e.target.reset(); load(); }).catch(err => flash(err.message)); };
  document.querySelector('#historyBatch').onchange = renderHistoryIfPicked;
  document.querySelector('#reload').onclick = load;
  load();
  </script>
</body>
</html>`;
}
