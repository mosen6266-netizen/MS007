
const app = document.querySelector("#app");
const toastEl = document.querySelector("#toast");

const state = {
  user: null,
  sidebar: [],
  sidebarVersion: 0,
  fields: [],
  sales: [],
  sidebarTimer: null,
  pendingCustomerId: null,
};

const iconMap = {
  "layout-dashboard":"▦","users":"👥","user-cog":"⚙","list-plus":"☷","check-circle":"✓",
  "panel-left":"☰","database":"◫","user-plus":"＋","link":"↗","circle":"•"
};

function esc(v=""){
  return String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function toast(msg){
  toastEl.textContent=msg; toastEl.classList.add("show");
  clearTimeout(toastEl._t); toastEl._t=setTimeout(()=>toastEl.classList.remove("show"),2200);
}
async function api(path, options={}){
  const role=state.user?.role||sessionStorage.getItem("ms007Role")||"";
  const opts={credentials:"same-origin",...options};
  if(role)opts.headers={...(opts.headers||{}),"x-ms007-role":role};
  if(opts.body && typeof opts.body!=="string"){
    opts.headers={...(opts.headers||{}),"content-type":"application/json"};
    opts.body=JSON.stringify(opts.body);
  }
  const res=await fetch(path,opts);
  const data=await res.json().catch(()=>({message:"系统返回了无法识别的内容"}));
  if(!res.ok){
    const e=new Error(data.message||"操作失败"); e.status=res.status; e.code=data.code; throw e;
  }
  return data;
}
function pageHead(title, sub="", right=""){
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${sub?`<p>${esc(sub)}</p>`:""}</div><div>${right}</div></div>`;
}
function progressTone(p){
  if(p>=100)return "#dcfce7";
  if(p>=80)return "#ede9fe";
  if(p>=60)return "#dbeafe";
  if(p>=40)return "#fef3c7";
  if(p>=20)return "#ffedd5";
  return "#fee2e2";
}
function money(v){ return new Intl.NumberFormat("zh-CN").format(Number(v||0)); }

async function bootstrap(){
  const deep=location.hash.match(/^#\/customer\/([^/]+)$/);
  if(deep)state.pendingCustomerId=decodeURIComponent(deep[1]);
  try{
    const me=await api("/api/me");
    state.user=me.user;
    sessionStorage.setItem("ms007Role",me.user.role);
    await enterApp();
  }catch(e){
    renderHome();
  }
}
function renderHome(){
  stopSidebarSync();
  state.user=null;
  app.innerHTML=`
    <main class="home">
      <div class="home-box">
        <div class="brand">
          <h1>MS007 客户登记系统</h1>
          <p>请选择你的入口</p>
        </div>
        <div class="entry-grid">
          <section class="entry-card">
            <div class="entry-icon">👤</div>
            <h2>业务员入口</h2>
            <p>登记和管理自己的客户，查看客户进度并完成每个步骤。</p>
            <button class="btn full" data-login="sales">进入业务员系统</button>
          </section>
          <section class="entry-card">
            <div class="entry-icon">🛡️</div>
            <h2>管理员入口</h2>
            <p>查看全部客户、业务员、仪表盘和系统配置。</p>
            <button class="btn full" data-login="admin">进入管理员后台</button>
          </section>
        </div>
      </div>
    </main>`;
  app.querySelectorAll("[data-login]").forEach(b=>b.onclick=()=>renderLogin(b.dataset.login));
}
async function renderLogin(role){
  sessionStorage.setItem("ms007Role",role);
  let needsBootstrap=false;
  try{ needsBootstrap=(await api("/api/bootstrap-status")).needsBootstrap; }catch{}
  const roleName=role==="admin"?"管理员":"业务员";

  if(needsBootstrap && role==="admin"){
    app.innerHTML=`
      <main class="login-wrap">
        <section class="login-card">
          <button class="back" id="backHome">← 返回入口</button>
          <h2>首次创建管理员</h2>
          <div class="sub">这一步只在系统第一次上线时出现。以后不会再显示。</div>
          <div class="notice warning" style="margin-bottom:14px">请输入部署时设置的“一次性初始化授权码”。这个授权码不是你的登录密码。</div>
          <form id="setupForm">
            <div class="field"><label>一次性初始化授权码</label><input class="input" name="token" type="password" required></div>
            <div class="field"><label>管理员显示名称</label><input class="input" name="displayName" value="管理员" required></div>
            <div class="field"><label>管理员登录账号</label><input class="input" name="username" autocomplete="username" required></div>
            <div class="field"><label>管理员登录密码（至少8位）</label><input class="input" name="password" type="password" autocomplete="new-password" required></div>
            <button class="btn full" type="submit">创建管理员账号</button>
          </form>
        </section>
      </main>`;
    document.querySelector("#backHome").onclick=renderHome;
    document.querySelector("#setupForm").onsubmit=async e=>{
      e.preventDefault();const fd=new FormData(e.currentTarget);
      try{
        await api("/api/bootstrap",{method:"POST",headers:{"x-bootstrap-token":String(fd.get("token")||"")},body:{
          username:fd.get("username"),displayName:fd.get("displayName"),password:fd.get("password")
        }});
        toast("管理员创建成功，请登录");
        renderLogin("admin");
      }catch(err){toast(err.message)}
    };
    return;
  }

  app.innerHTML=`
    <main class="login-wrap">
      <section class="login-card">
        <button class="back" id="backHome">← 返回入口</button>
        <h2>${roleName}登录</h2>
        <div class="sub">使用你的 ${roleName} 账号进入系统</div>
        <form id="loginForm">
          <div class="field"><label>账号</label><input class="input" name="username" autocomplete="username" required></div>
          <div class="field"><label>密码</label><input class="input" type="password" name="password" autocomplete="current-password" required></div>
          <button class="btn full" type="submit">登录</button>
        </form>
      </section>
    </main>`;
  document.querySelector("#backHome").onclick=renderHome;
  document.querySelector("#loginForm").onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    try{
      const r=await api("/api/login",{method:"POST",body:{username:fd.get("username"),password:fd.get("password"),role}});
      state.user=r.user;
      sessionStorage.setItem("ms007Role",r.user.role);
      const pendingCustomerId=state.pendingCustomerId;
      state.pendingCustomerId=null;
      location.hash=pendingCustomerId?`#/${role}/customer/${encodeURIComponent(pendingCustomerId)}`:`#/${role}/dashboard`;
      await enterApp();
    }catch(err){toast(err.message);}
  };
}

async function enterApp(){
  await refreshSidebar(true);
  startSidebarSync();
  const direct=location.hash.match(/^#\/customer\/([^/]+)$/);
  if(direct){
    const pendingCustomerId=decodeURIComponent(direct[1]);
    state.pendingCustomerId=null;
    location.hash=`#/${state.user.role}/customer/${encodeURIComponent(pendingCustomerId)}`;
  }else if(!location.hash.startsWith("#/")){
    location.hash=`#/${state.user.role}/dashboard`;
  }
  await renderShell();
}
async function refreshSidebar(force=false){
  if(!state.user)return;
  try{
    const r=await api("/api/sidebar");
    if(force || Number(r.version)!==Number(state.sidebarVersion)){
      state.sidebar=r.items||[]; state.sidebarVersion=Number(r.version||0);
      if(!force && document.querySelector(".sidebar")) renderSidebarOnly();
    }
  }catch{}
}
function startSidebarSync(){
  stopSidebarSync();
  state.sidebarTimer=setInterval(()=>{ if(document.visibilityState==="visible")refreshSidebar(false); },60000);
  document.addEventListener("visibilitychange",onVisible);
}
function stopSidebarSync(){
  if(state.sidebarTimer)clearInterval(state.sidebarTimer);
  state.sidebarTimer=null; document.removeEventListener("visibilitychange",onVisible);
}
function onVisible(){ if(document.visibilityState==="visible")refreshSidebar(false); }

function sideHtml(){
  let currentGroup=null, html="";
  for(const item of state.sidebar){
    const g=item.group_label||"";
    if(g!==currentGroup){ currentGroup=g; if(g)html+=`<div class="side-group">${esc(g)}</div>`; }
    const icon=iconMap[item.icon]||"•";
    const active=item.url.startsWith("#/")&&location.hash===item.url?"active":"";
    const isNewCustomer=item.url==="#/sales/new"||item.url==="#/admin/new";
    html+=`<a class="side-link ${active}" href="${isNewCustomer?"#":esc(item.url)}" ${isNewCustomer?'data-action="new-customer"':""} ${!isNewCustomer&&item.target==="new"?'target="_blank" rel="noopener"':""}>
      <span class="side-icon">${esc(icon)}</span><span>${esc(item.label)}</span></a>`;
  }
  return html;
}
function renderSidebarOnly(){
  const box=document.querySelector("#sideNav"); if(box)box.innerHTML=sideHtml();
}
async function renderShell(){
  const roleLabel=state.user.role==="admin"?"管理员":"业务员";
  app.innerHTML=`
    <div class="shell">
      <aside class="sidebar">
        <div class="logo"><strong>MS007</strong><small>${roleLabel}系统</small></div>
        <nav id="sideNav">${sideHtml()}</nav>
        <div class="side-footer"><button class="btn ghost small full" id="logoutBtn">退出登录</button></div>
      </aside>
      <section class="main">
        <header class="topbar">
          <div id="systemMini"></div>
          <div class="user-chip"><div class="avatar">${esc((state.user.displayName||"U").slice(0,1))}</div><div><strong>${esc(state.user.displayName)}</strong><div class="muted" style="font-size:12px">${roleLabel}</div></div></div>
        </header>
        <div class="content" id="view"><div class="boot" style="height:50vh"><div class="spinner"></div></div></div>
      </section>
    </div>`;
  document.querySelector("#logoutBtn").onclick=logout;
  document.querySelector("#sideNav").onclick=e=>{
    const a=e.target.closest('[data-action="new-customer"]');
    if(a){e.preventDefault();openCustomerEditor();}
  };
  if(state.user.role==="admin") refreshMiniStatus();
  await renderRoute();
}
async function refreshMiniStatus(){
  try{
    const r=await api("/api/admin/capacity");
    const cls=r.level==="normal"?"":r.level==="warning"?"warn":"bad";
    document.querySelector("#systemMini").innerHTML=`<a href="#/admin/capacity" class="status-pill ${cls}" style="text-decoration:none">● 系统状态：${r.level==="normal"?"正常":"需要关注"}</a>`;
  }catch{}
}
async function logout(){
  try{await api("/api/logout",{method:"POST"});}catch{}
  sessionStorage.removeItem("ms007Role");
  state.user=null;
  location.hash="";
  renderHome();
}
window.addEventListener("hashchange",()=>{ if(state.user){renderSidebarOnly();renderRoute();} });

async function renderRoute(){
  const view=document.querySelector("#view"); if(!view)return;
  const parts=location.hash.replace(/^#\//,"").split("/");
  const role=parts[0], page=parts[1]||"dashboard", id=parts[2];
  if(role!==state.user.role){
    location.hash=`#/${state.user.role}/dashboard`; return;
  }
  view.innerHTML=`<div class="boot" style="height:50vh"><div class="spinner"></div></div>`;
  try{
    if(page==="dashboard")return renderDashboard(view);
    if(page==="customers")return renderCustomers(view);
    if(page==="new"){await renderCustomers(view);return openCustomerEditor();}
    if(page==="customer"&&id)return renderCustomerDetail(view,id);
    if(role==="admin"&&page==="sales")return renderSales(view);
    if(role==="admin"&&page==="fields")return renderFields(view);
    if(role==="admin"&&page==="progress")return renderProgressAdmin(view);
    if(role==="admin"&&page==="sidebar")return renderSidebarAdmin(view);
    if(role==="admin"&&page==="registration-layout")return renderRegistrationLayoutSettings(view);
    if(role==="admin"&&page==="list-settings")return renderListSettings(view);
    if(role==="admin"&&page==="dashboard-settings")return renderDashboardSettings(view);
    if(role==="admin"&&page==="capacity")return renderCapacity(view);
    if(role==="admin"&&page==="telegram")return renderTelegramSettings(view);
    if(role==="admin"&&page==="audit")return renderAudit(view);
    if(role==="admin"&&page==="recycle")return renderRecycle(view);
    if(role==="admin"&&page==="backup")return renderBackup(view);
    view.innerHTML=pageHead("页面不存在");
  }catch(err){
    if(err.status===401){renderHome();return;}
    view.innerHTML=`<div class="notice urgent">${esc(err.message)}</div>`;
  }
}

function dashboardPeriodStart(period){
  const d=new Date();
  if(period==="today"){
    d.setHours(0,0,0,0);
    return d.toISOString();
  }
  if(period==="week"){
    const day=d.getDay();
    const diff=(day+6)%7;
    d.setDate(d.getDate()-diff);
    d.setHours(0,0,0,0);
    return d.toISOString();
  }
  return "";
}

async function renderDashboard(view,period=null){
  const stored=sessionStorage.getItem("ms007DashboardPeriod");
  period=period||(["total","today","week"].includes(stored)?stored:"total");
  sessionStorage.setItem("ms007DashboardPeriod",period);

  const qs=new URLSearchParams({period});
  const from=dashboardPeriodStart(period);
  if(from)qs.set("from",from);

  const [r,wr]=await Promise.all([
    api("/api/stats?"+qs.toString()),
    api("/api/dashboard-widgets")
  ]);
  const s=r.summary, widgets=wr.items||[];
  let capacityHtml="";
  if(state.user.role==="admin"){
    const cap=await api("/api/admin/capacity");
    if(cap.level!=="normal"){
      capacityHtml=`<div class="notice ${cap.level==="warning"?"warning":"urgent"}" style="margin-bottom:16px"><strong>系统容量提醒：</strong> ${esc(cap.message)} <a href="#/admin/capacity">查看详情</a></div>`;
    }
  }

  const periodName={total:"总数据",today:"当日数据",week:"本周数据"}[period]||"总数据";
  const metricValue={
    metric_total:s.total,
    metric_today:s.today,
    metric_complete:s.completed,
    metric_archived:0
  };

  const metricWidgets=widgets.filter(x=>x.widget_type.startsWith("metric_"));
  const largeWidgets=widgets.filter(x=>!x.widget_type.startsWith("metric_"));

  let html=pageHead(
    "仪表盘",
    state.user.role==="admin"?"查看整个团队的客户情况":"查看你的客户情况",
    `<div class="dashboard-period-switch">
      <button class="btn ${period==="total"?"":"ghost"} small" data-dashboard-period="total">总数据</button>
      <button class="btn ${period==="today"?"":"ghost"} small" data-dashboard-period="today">当日数据</button>
      <button class="btn ${period==="week"?"":"ghost"} small" data-dashboard-period="week">本周数据</button>
    </div>`
  ) + capacityHtml;

  if(metricWidgets.length){
    html+=`<div class="grid metrics">${metricWidgets.map(w=>{
      let value=metricValue[w.widget_type]??0;
      let subtitle=periodName;
      if(w.widget_type==="metric_progress"){
        let cfg={};try{cfg=JSON.parse(w.config_json||"{}")}catch{}
        value=Number(r.progressCounts?.[cfg.progressId]||0);
      }else if(w.widget_type==="metric_today"){
        subtitle="今天新增（固定）";
      }else if(w.widget_type==="metric_archived"){
        subtitle="归档客户不计入统计";
      }
      return `<div class="card metric">
        <div class="label">${esc(w.title)}</div>
        <div class="value">${money(value)}</div>
        <div class="metric-period-label">${esc(subtitle)}</div>
      </div>`;
    }).join("")}</div>`;
  }

  for(const w of largeWidgets){
    if(w.widget_type==="sales_breakdown" && state.user.role==="admin"){
      html+=`<div class="card" style="margin-top:18px"><div class="dashboard-card-head"><h3>${esc(w.title)}</h3><span>${esc(periodName)}</span></div><div class="table-wrap"><table><thead><tr><th>业务员</th><th>客户数量</th><th>平均进度</th></tr></thead><tbody>${(r.sales||[]).map(x=>`<tr><td>${esc(x.display_name)}</td><td>${money(x.customer_count)}</td><td>${money(x.avg_progress)}%</td></tr>`).join("")||`<tr><td colspan="3" class="muted">当前时间范围内没有数据</td></tr>`}</tbody></table></div></div>`;
    }
  }

  if(!widgets.length)html+=`<div class="empty card">当前仪表盘没有启用任何组件。</div>`;
  view.innerHTML=html;

  view.querySelectorAll("[data-dashboard-period]").forEach(b=>b.onclick=()=>{
    renderDashboard(view,b.dataset.dashboardPeriod);
  });
}

async function getSales(){
  if(state.user.role!=="admin")return[];
  const r=await api("/api/admin/users");
  state.sales=(r.items||[]).filter(x=>x.role==="sales"&&x.active);
  return state.sales;
}
let currentListColumns=[];
let customerPageState={cursor:null,loading:false,items:[],viewArchived:false};

async function renderCustomers(view){
  const [sales,lc]=await Promise.all([
    state.user.role==="admin"?getSales():Promise.resolve([]),
    api("/api/list-columns")
  ]);
  currentListColumns=lc.items||[];
  customerPageState={cursor:null,loading:false,items:[],viewArchived:false};

  view.innerHTML=
    pageHead(state.user.role==="admin"?"全部客户":"我的客户","客户以整行方式显示，整行背景就是当前完成进度。",
      `<button class="btn" id="newCustomer">＋ 登记客户</button>`)+
    `<div class="toolbar">
      <input class="input" id="searchCustomer" placeholder="搜索姓名、案件编号或其他可搜索字段">
      ${state.user.role==="admin"?`<select class="input" id="ownerFilter"><option value="">全部业务员</option>${sales.map(x=>`<option value="${esc(x.id)}">${esc(x.display_name)}</option>`).join("")}</select>`:""}
      <button class="btn secondary" id="searchBtn">搜索</button>
      <span class="grow"></span>
      <button class="btn small" id="activeCustomersBtn">当前客户</button>
      <button class="btn ghost small" id="archivedCustomersBtn">已归档</button>
    </div>
    <div id="customerResults"></div>`;

  document.querySelector("#newCustomer").onclick=()=>openCustomerEditor();
  document.querySelector("#searchBtn").onclick=()=>loadCustomerPage(true);
  document.querySelector("#searchCustomer").onkeydown=e=>{if(e.key==="Enter")loadCustomerPage(true)};
  if(document.querySelector("#ownerFilter"))document.querySelector("#ownerFilter").onchange=()=>loadCustomerPage(true);

  document.querySelector("#activeCustomersBtn").onclick=()=>{
    customerPageState.viewArchived=false;
    document.querySelector("#activeCustomersBtn").className="btn small";
    document.querySelector("#archivedCustomersBtn").className="btn ghost small";
    loadCustomerPage(true);
  };
  document.querySelector("#archivedCustomersBtn").onclick=()=>{
    customerPageState.viewArchived=true;
    document.querySelector("#activeCustomersBtn").className="btn ghost small";
    document.querySelector("#archivedCustomersBtn").className="btn small";
    loadCustomerPage(true);
  };

  await loadCustomerPage(true);
}

async function loadCustomerPage(reset){
  if(customerPageState.loading)return;
  customerPageState.loading=true;
  const host=document.querySelector("#customerResults"); if(!host)return;
  if(reset){
    const archived=customerPageState.viewArchived;
    customerPageState={cursor:null,loading:true,items:[],viewArchived:archived};
    host.innerHTML=`<div class="boot" style="height:30vh"><div class="spinner"></div></div>`;
  }
  const q=document.querySelector("#searchCustomer")?.value||"";
  const owner=document.querySelector("#ownerFilter")?.value||"";
  try{
    const qs=new URLSearchParams({limit:"50",archived:customerPageState.viewArchived?"1":"0"});
    if(q)qs.set("q",q);
    if(owner)qs.set("owner",owner);
    if(customerPageState.cursor)qs.set("cursor",customerPageState.cursor);
    const r=await api("/api/customers?"+qs.toString());
    customerPageState.items.push(...r.items);
    customerPageState.cursor=r.nextCursor;
    renderCustomerRows(host,customerPageState.items,!!r.nextCursor);
  }catch(e){
    host.innerHTML=`<div class="notice urgent">${esc(e.message)}</div>`;
  }
  customerPageState.loading=false;
}

function renderCustomerRows(host,items,hasMore){
  if(!items.length){
    host.innerHTML=`<div class="empty card">${customerPageState.viewArchived?"还没有归档客户":"还没有客户资料"}</div>`;
    return;
  }

  host.innerHTML=`<div class="customer-list">${items.map(c=>{
    const details=[];
    for(const col of currentListColumns){
      if(col.column_key==="name"){
        details.push(`<div class="customer-cell"><span>${esc(col.label||"客户姓名")}</span><strong>${esc(c.name||"—")}</strong></div>`);
        continue;
      }
      if(col.column_key==="owner"){
        if(state.user.role==="admin")details.push(`<div class="customer-cell"><span>${esc(col.label||"业务员")}</span><strong>${esc(c.ownerName||"未分配")}</strong></div>`);
        continue;
      }
      if(col.column_key==="dynamic"&&col.field_id){
        const v=c.values?.[col.field_id]||"";
        details.push(`<div class="customer-cell"><span>${esc(col.label||"")}</span><strong>${esc(v||"—")}</strong></div>`);
      }
    }
    const archiveLabel=customerPageState.viewArchived?"取消归档":"归档";
    return `<article class="customer-row" style="--pct:${Number(c.progressPercent||0)}%;--progress-color:${progressTone(Number(c.progressPercent||0))}">
      <div class="customer-fields customer-fields-configurable">${details.join("")||'<div class="muted">未设置客户资料显示项</div>'}</div>
      <div class="customer-step-status">
        <div class="step-status current-step">
          <span>当前进度</span>
          <strong><i></i>${esc(c.currentProgress?.label||"未开始")}</strong>
        </div>
        <div class="step-status next-step">
          <span>下一步进度</span>
          <strong><i></i>${esc(c.nextProgress?.label||"暂无进度")}</strong>
        </div>
      </div>
      <div class="customer-row-progress">
        <strong>${c.progressPercent}%</strong>
        <span>${c.progressDone}/${c.progressTotal}</span>
      </div>
      <div class="customer-actions">
        <button class="icon-action" title="预览" data-preview="${esc(c.id)}">👁 <span>预览</span></button>
        <button class="icon-action" title="客户进度" data-progress-only="${esc(c.id)}">☑ <span>进度</span></button>
        <button class="icon-action" title="编辑" data-edit="${esc(c.id)}">✏ <span>编辑</span></button>
        <button class="icon-action" title="复制全部信息" data-copy="${esc(c.id)}">📋 <span>复制</span></button>
        <button class="icon-action" title="${archiveLabel}" data-archive="${esc(c.id)}">📦 <span>${archiveLabel}</span></button>
        <button class="icon-action danger-action" title="删除" data-delete="${esc(c.id)}">🗑 <span>删除</span></button>
      </div>
    </article>`;
  }).join("")}</div>
  ${hasMore?`<div style="text-align:center;margin:18px"><button class="btn secondary" id="loadMore">加载更多</button></div>`:""}`;

  host.querySelectorAll("[data-preview]").forEach(b=>b.onclick=()=>openCustomerPreview(b.dataset.preview));
  host.querySelectorAll("[data-progress-only]").forEach(b=>b.onclick=()=>openCustomerProgressPanel(b.dataset.progressOnly));
  host.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openCustomerEditor(b.dataset.edit));
  host.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>copyCustomerAll(b.dataset.copy));
  host.querySelectorAll("[data-archive]").forEach(b=>b.onclick=()=>setCustomerArchived(b.dataset.archive,!customerPageState.viewArchived));
  host.querySelectorAll("[data-delete]").forEach(b=>b.onclick=()=>deleteCustomerRow(b.dataset.delete));
  const more=document.querySelector("#loadMore"); if(more)more.onclick=()=>loadCustomerPage(false);
}

function inputForField(f,value=""){
  let options=[];try{options=JSON.parse(f.options_json||"[]")}catch{}
  if(f.field_type==="textarea")return `<textarea class="input dyn" data-field="${esc(f.id)}">${esc(value)}</textarea>`;
  if(["select","single"].includes(f.field_type))return `<select class="input dyn" data-field="${esc(f.id)}"><option value="">请选择</option>${options.map(o=>`<option ${String(o)===String(value)?"selected":""}>${esc(o)}</option>`).join("")}</select>`;
  const type=({email:"email",phone:"tel",number:"number",date:"date",time:"time",url:"url"}[f.field_type]||"text");
  return `<input class="input dyn" data-field="${esc(f.id)}" type="${type}" value="${esc(value)}" ${f.required?"required":""}>`;
}

function registrationSectionHtml(section,fieldMap,customer){
  const items=(section.items||[]).map(key=>{
    if(key==="name"){
      return `<div class="field"><label>客户姓名 *</label><input class="input" name="name" value="${esc(customer?.name||"")}" required></div>`;
    }
    const f=fieldMap.get(key);
    if(!f)return "";
    const wide=f.field_type==="textarea"?"span2":"";
    return `<div class="field ${wide}"><label>${esc(f.label)}${f.required?" *":""}</label>${inputForField(f,customer?.values?.[f.id]||"")}</div>`;
  }).join("");
  if(!items)return "";
  return `<section class="form-section">
    <div class="form-section-head">
      <h3>${esc(section.title||"信息")}</h3>
      ${section.description?`<p>${esc(section.description)}</p>`:""}
    </div>
    <div class="form-grid">${items}</div>
  </section>`;
}

async function openCustomerEditor(id=null){
  try{
    const [layout,sales,detail]=await Promise.all([
      api("/api/registration-layout"),
      state.user.role==="admin"?getSales():Promise.resolve([]),
      id?api("/api/customers/"+encodeURIComponent(id)):Promise.resolve(null)
    ]);
    const customer=detail?.customer||null;
    const fields=layout.fields||[];
    const fieldMap=new Map(fields.map(x=>[x.id,x]));
    const sections=(layout.sections||[]).map(s=>registrationSectionHtml(s,fieldMap,customer)).join("");
    const progressSection=id&&customer?`
      <section class="form-section customer-progress-editor">
        <div class="form-section-head progress-editor-head">
          <div>
            <h3>客户进度</h3>
            <p>勾选表示已完成；取消勾选表示改回未完成。只有点击“保存修改”后才会真正生效。</p>
          </div>
          <div class="progress-editor-summary">
            <strong id="editProgressPercent">${Number(customer.progressPercent||0)}%</strong>
            <span id="editProgressFraction">${Number(customer.progressDone||0)}/${Number(customer.progressTotal||0)}</span>
          </div>
        </div>
        <div class="progress-check-grid">
          ${(customer.progress||[]).map(p=>`
            <label class="progress-check-item">
              <input type="checkbox"
                class="customer-progress-check"
                data-progress-id="${esc(p.id)}"
                data-original="${p.completed?"1":"0"}"
                ${p.completed?"checked":""}>
              <span class="progress-check-mark"></span>
              <span class="progress-check-content">
                <strong><i class="progress-status-dot"></i>${esc(p.label)}</strong>
                ${p.description?`<small>${esc(p.description)}</small>`:""}
              </span>
            </label>`).join("")||'<div class="muted">管理员还没有设置客户进度。</div>'}
        </div>
      </section>`:"";

    openDrawer(id?"编辑客户":"登记客户",`
      <form id="customerDrawerForm">
        ${state.user.role==="admin"?`<section class="form-section"><div class="form-section-head"><h3>负责人</h3></div><div class="form-grid"><div class="field"><label>业务员</label><select class="input" name="owner"><option value="">暂不分配</option>${sales.map(x=>`<option value="${esc(x.id)}" ${customer?.ownerId===x.id?"selected":""}>${esc(x.display_name)}</option>`).join("")}</select></div></div></section>`:""}
        ${sections}
        ${progressSection}
        <div class="drawer-actions">
          <button class="btn" type="submit">${id?"保存修改":"保存客户"}</button>
          <button class="btn ghost" type="button" id="drawerCancel">取消</button>
        </div>
      </form>`,()=>{
        document.querySelector("#drawerCancel").onclick=requestCloseDrawer;

        const progressChecks=[...document.querySelectorAll(".customer-progress-check")];
        const updateProgressSummary=()=>{
          if(!progressChecks.length)return;
          const done=progressChecks.filter(x=>x.checked).length;
          const total=progressChecks.length;
          const percent=total?Math.round(done*100/total):0;
          const pct=document.querySelector("#editProgressPercent");
          const fraction=document.querySelector("#editProgressFraction");
          if(pct)pct.textContent=percent+"%";
          if(fraction)fraction.textContent=done+"/"+total;
        };
        progressChecks.forEach(x=>x.addEventListener("change",updateProgressSummary));
        updateProgressSummary();

        document.querySelector("#customerDrawerForm").onsubmit=async e=>{
          e.preventDefault();
          const form=e.currentTarget;
          const values={};
          form.querySelectorAll(".dyn").forEach(x=>values[x.dataset.field]=x.value);
          const name=form.querySelector('[name="name"]')?.value?.trim()||"";
          if(!name){toast("请输入客户姓名");return}
          const body={name,values};
          if(state.user.role==="admin") body.assignedUserId=form.querySelector('[name="owner"]')?.value||null;

          const changedProgress=progressChecks
            .filter(x=>(x.dataset.original==="1")!==x.checked)
            .map(x=>({id:x.dataset.progressId,completed:x.checked}));

          const saveBtn=form.querySelector('button[type="submit"]');
          if(saveBtn){saveBtn.disabled=true;saveBtn.textContent=id?"正在保存...":"正在登记..."}

          try{
            if(id){
              await api("/api/customers/"+encodeURIComponent(id),{method:"PATCH",body});
              for(const p of changedProgress){
                await api("/api/customers/"+encodeURIComponent(id)+"/progress/"+encodeURIComponent(p.id),{
                  method:"PUT",
                  body:{completed:p.completed}
                });
              }
            }else{
              await api("/api/customers",{method:"POST",body});
            }
            closeDrawer();
            toast(id?(changedProgress.length?"客户资料和进度已保存":"客户资料已保存"):"客户已登记");
            if(document.querySelector("#customerResults")) await loadCustomerPage(true);
          }catch(err){
            toast(err.message);
            if(saveBtn){saveBtn.disabled=false;saveBtn.textContent=id?"保存修改":"保存客户"}
          }
        };
      },{draftKey:`customer:${id||"new"}:${state.user.id}`});
  }catch(err){toast(err.message)}
}

async function openCustomerProgressPanel(id){
  try{
    const r=await api("/api/customers/"+encodeURIComponent(id));
    const customer=r.customer;

    openDrawer("客户进度 · "+customer.name,`
      <section class="form-section customer-progress-editor progress-only-panel">
        <div class="form-section-head progress-editor-head">
          <div>
            <h3>客户进度</h3>
            <p>这里只修改客户进度，不显示或修改其他客户资料。只有点击“保存进度”后才会真正生效。</p>
          </div>
          <div class="progress-editor-summary">
            <strong id="quickProgressPercent">${Number(customer.progressPercent||0)}%</strong>
            <span id="quickProgressFraction">${Number(customer.progressDone||0)}/${Number(customer.progressTotal||0)}</span>
          </div>
        </div>
        <div class="progress-check-grid">
          ${(customer.progress||[]).map(p=>`
            <label class="progress-check-item">
              <input type="checkbox"
                class="quick-progress-check"
                data-progress-id="${esc(p.id)}"
                data-original="${p.completed?"1":"0"}"
                ${p.completed?"checked":""}>
              <span class="progress-check-mark"></span>
              <span class="progress-check-content">
                <strong><i class="progress-status-dot"></i>${esc(p.label)}</strong>
                ${p.description?`<small>${esc(p.description)}</small>`:""}
              </span>
            </label>`).join("")||'<div class="muted">管理员还没有设置客户进度。</div>'}
        </div>
      </section>
      <div class="drawer-actions">
        <button class="btn" id="quickProgressSave">保存进度</button>
        <button class="btn ghost" id="quickProgressCancel">取消</button>
      </div>
    `,()=>{
      const checks=[...document.querySelectorAll(".quick-progress-check")];
      const updateSummary=()=>{
        const done=checks.filter(x=>x.checked).length;
        const total=checks.length;
        const percent=total?Math.round(done*100/total):0;
        const pct=document.querySelector("#quickProgressPercent");
        const fraction=document.querySelector("#quickProgressFraction");
        if(pct)pct.textContent=percent+"%";
        if(fraction)fraction.textContent=done+"/"+total;
      };
      checks.forEach(x=>x.addEventListener("change",updateSummary));
      updateSummary();

      document.querySelector("#quickProgressCancel").onclick=requestCloseDrawer;
      document.querySelector("#quickProgressSave").onclick=async()=>{
        const changed=checks
          .filter(x=>(x.dataset.original==="1")!==x.checked)
          .map(x=>({id:x.dataset.progressId,completed:x.checked}));

        const btn=document.querySelector("#quickProgressSave");
        btn.disabled=true;btn.textContent="正在保存...";
        try{
          for(const p of changed){
            await api("/api/customers/"+encodeURIComponent(id)+"/progress/"+encodeURIComponent(p.id),{
              method:"PUT",
              body:{completed:p.completed}
            });
          }
          closeDrawer();
          toast(changed.length?"客户进度已保存":"客户进度没有变化");
          if(document.querySelector("#customerResults"))await loadCustomerPage(true);
        }catch(err){
          toast(err.message);
          btn.disabled=false;btn.textContent="保存进度";
        }
      };
    },{draftKey:`customer-progress:${id}:${state.user.id}`});
  }catch(err){toast(err.message)}
}

async function openCustomerPreview(id){
  try{
    const [r,layout]=await Promise.all([
      api("/api/customers/"+encodeURIComponent(id)),
      api("/api/registration-layout")
    ]);
    const c=r.customer;
    const fieldMap=new Map((r.fields||[]).map(x=>[x.id,x]));
    const sections=(layout.sections||[]).map(section=>{
      const rows=(section.items||[]).map(key=>{
        if(key==="name") return `<div class="preview-item"><span>客户姓名</span><strong>${esc(c.name)}</strong></div>`;
        const f=fieldMap.get(key); if(!f)return "";
        return `<div class="preview-item"><span>${esc(f.label)}</span><strong>${esc(c.values?.[f.id]||"—")}</strong></div>`;
      }).join("");
      return rows?`<section class="preview-section"><h3>${esc(section.title||"信息")}</h3><div class="preview-grid">${rows}</div></section>`:"";
    }).join("");

    openDrawer("客户预览",`
      <div class="preview-summary">
        <div><span>业务员</span><strong>${esc(c.ownerName||"未分配")}</strong></div>
        <div><span>当前进度</span><strong>${c.progressPercent}%</strong></div>
        <div><span>创建时间</span><strong>${esc((c.createdAt||"").replace("T"," ").slice(0,19))}</strong></div>
        <div><span>状态</span><strong>${c.archived?"已归档":"正常"}</strong></div>
      </div>
      ${sections}
      <section class="preview-section">
        <h3>客户进度</h3>
        <div class="progress-list">
          ${c.progress.map(p=>`<div class="progress-item"><span style="font-size:18px">${p.completed?"☑":"☐"}</span><span><strong>${esc(p.label)}</strong>${p.description?`<div class="muted" style="font-size:12px">${esc(p.description)}</div>`:""}</span></div>`).join("")}
        </div>
      </section>
      <div class="drawer-actions">
        <button class="btn" id="previewEdit">编辑客户</button>
        <button class="btn secondary" id="previewCopy">复制全部信息</button>
        <button class="btn ghost" id="previewClose">关闭</button>
      </div>`,()=>{
        document.querySelector("#previewEdit").onclick=()=>{closeDrawer();openCustomerEditor(id)};
        document.querySelector("#previewCopy").onclick=()=>copyCustomerAll(id);
        document.querySelector("#previewClose").onclick=requestCloseDrawer;
      },{draft:false});
  }catch(err){toast(err.message)}
}

async function copyCustomerAll(id){
  try{
    const r=await api("/api/customers/"+encodeURIComponent(id));
    const c=r.customer;
    const fields=r.fields||[];
    const lines=[
      `客户姓名：${c.name}`,
      `业务员：${c.ownerName||"未分配"}`,
      ...fields.map(f=>`${f.label}：${c.values?.[f.id]||""}`),
      `客户进度：${c.progressPercent}%（${c.progressDone}/${c.progressTotal}）`,
      ...c.progress.map(p=>`${p.completed?"✓":"□"} ${p.label}`),
      `状态：${c.archived?"已归档":"正常"}`,
      `创建时间：${(c.createdAt||"").replace("T"," ").slice(0,19)}`,
      `更新时间：${(c.updatedAt||"").replace("T"," ").slice(0,19)}`
    ];
    const copyText=lines.join("\n");
    try{
      await navigator.clipboard.writeText(copyText);
    }catch{
      const ta=document.createElement("textarea");ta.value=copyText;ta.style.position="fixed";ta.style.opacity="0";
      document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();
    }
    toast("已复制此客户全部信息");
  }catch(err){toast(err.message)}
}

async function setCustomerArchived(id,archived){
  try{
    await api("/api/customers/"+encodeURIComponent(id),{method:"PATCH",body:{archived}});
    toast(archived?"客户已归档":"客户已取消归档");
    await loadCustomerPage(true);
  }catch(err){toast(err.message)}
}

async function deleteCustomerRow(id){
  if(!await uiConfirm("确认删除这个客户？\n\n删除后会进入管理员回收站，不会立即永久消失。",{title:"删除客户",confirmText:"移入回收站",danger:true}))return;
  try{
    await api("/api/customers/"+encodeURIComponent(id),{method:"DELETE"});
    toast("客户已移入回收站");
    await loadCustomerPage(true);
  }catch(err){toast(err.message)}
}

async function renderCustomerDetail(view,id){
  await renderCustomers(view);
  await openCustomerPreview(id);
}

async function renderSales(view){
  const r=await api("/api/admin/users");const items=r.items||[];
  view.innerHTML=pageHead("业务员管理","业务员只能看到分配给自己的客户",`<button class="btn" id="addSales">＋ 添加业务员</button>`)+
    `<div class="table-wrap"><table><thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
    ${items.map(x=>`<tr><td>${esc(x.display_name)}</td><td>${esc(x.username)}</td><td>${x.role==="admin"?"管理员":"业务员"}</td><td><span class="tag">${x.active?"启用":"停用"}</span></td><td>${esc((x.created_at||"").slice(0,10))}</td><td>${x.role==="sales"?`<button class="btn ghost small" data-edit-user="${esc(x.id)}">设置</button>`:""}</td></tr>`).join("")}</tbody></table></div>`;
  document.querySelector("#addSales").onclick=()=>openModal("添加业务员",`
    <div class="field"><label>业务员姓名</label><input class="input" id="mName"></div>
    <div class="field"><label>登录账号</label><input class="input" id="mUser"></div>
    <div class="field"><label>初始密码（至少8位）</label><input class="input" type="password" id="mPass"></div>
    <button class="btn full" id="mSave">创建业务员</button>`,()=>{
      document.querySelector("#mSave").onclick=async()=>{try{await api("/api/admin/users",{method:"POST",body:{displayName:val("mName"),username:val("mUser"),password:val("mPass")}});closeModal();toast("业务员已创建");renderSales(view);}catch(e){toast(e.message)}};
    },{draftKey:"sales-user:new"});
  document.querySelectorAll("[data-edit-user]").forEach(b=>b.onclick=()=>{
    const u=items.find(x=>x.id===b.dataset.editUser); if(!u)return;
    openModal("业务员账号设置",`
      <div class="field"><label>业务员姓名</label><input class="input" id="euName" value="${esc(u.display_name)}"></div>
      <div class="field"><label>登录账号</label><input class="input" value="${esc(u.username)}" disabled></div>
      <div class="field"><label>重新设置密码</label><input class="input" type="password" id="euPass" placeholder="不修改密码请留空"></div>
      <label><input type="checkbox" id="euActive" ${u.active?"checked":""}> 启用这个业务员账号</label>
      <div class="notice warning" style="margin:14px 0">修改密码后，这个业务员当前已经登录的会话会被退出，需要使用新密码重新登录。</div>
      <button class="btn full" id="euSave">保存设置</button>`,()=>{
        document.querySelector("#euSave").onclick=async()=>{try{
          const body={displayName:val("euName"),active:checked("euActive")};if(val("euPass"))body.password=val("euPass");
          await api("/api/admin/users/"+u.id,{method:"PATCH",body});closeModal();toast("业务员账号设置已保存");renderSales(view);
        }catch(e){toast(e.message)}};
      },{draftKey:`sales-user:${u.id}`});
  });
}

const fieldTypeName={
  text:"单行文本",
  textarea:"多行文本",
  phone:"手机号",
  email:"邮箱",
  number:"数字",
  date:"日期",
  time:"时间",
  url:"网址",
  select:"下拉选择",
  single:"单选"
};

async function renderFields(view){
  const r=await api("/api/fields");const items=r.items||[];
  view.innerHTML=pageHead("登记字段管理","添加、编辑、排序并决定哪些字段显示在客户列表",`<button class="btn" id="addField">＋ 添加字段</button>`)+
    `<div class="table-wrap"><table><thead><tr><th>顺序</th><th>名称</th><th>类型</th><th>必填</th><th>列表显示</th><th>可搜索</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${items.map(f=>`<tr data-field-row="${esc(f.id)}"><td>${f.sort_order}</td><td><strong>${esc(f.label)}</strong></td><td>${esc(fieldTypeName[f.field_type]||f.field_type)}</td><td>${f.required?"是":"否"}</td><td>${f.list_visible?"显示":"不显示"}</td><td>${f.searchable?"是":"否"}</td><td>${f.enabled?"启用":"停用"}</td><td>
      <button class="btn ghost small" data-edit-field="${esc(f.id)}">编辑</button>
      <button class="btn ghost small" data-toggle-field="${esc(f.id)}" data-enable-field="${f.enabled?"0":"1"}">${f.enabled?"停用":"启用"}</button>
      <button class="btn danger small" data-hard-del-field="${esc(f.id)}">删除</button>
    </td></tr>`).join("")}</tbody></table></div>`;
  const nextFieldSort=(items.reduce((m,x)=>Math.max(m,Number(x.sort_order)||0),0))+1;
  document.querySelector("#addField").onclick=()=>fieldModal(view,null,nextFieldSort);
  document.querySelectorAll("[data-edit-field]").forEach(b=>b.onclick=()=>fieldModal(view,items.find(x=>x.id===b.dataset.editField)));
  document.querySelectorAll("[data-toggle-field]").forEach(b=>b.onclick=async()=>{
    const enabled=b.dataset.enableField==="1";
    try{
      await api("/api/admin/fields/"+b.dataset.toggleField,{method:"PATCH",body:{enabled}});
      toast(enabled?"字段已启用":"字段已停用");
      renderFields(view);
    }catch(e){toast(e.message)}
  });
  document.querySelectorAll("[data-hard-del-field]").forEach(b=>b.onclick=async()=>{
    const item=items.find(x=>x.id===b.dataset.hardDelField);if(!item)return;
    if(!await uiConfirm("永久删除登记条目「"+item.label+"」？\n\n这会同时删除所有客户在这个条目下已经填写的数据，并且无法恢复。",{title:"永久删除登记条目",confirmText:"继续删除",danger:true}))return;
    if(!await uiConfirm("请再次确认：真的要永久删除「"+item.label+"」吗？\n\n此操作无法撤销。",{title:"最后确认",confirmText:"永久删除",danger:true}))return;
    try{
      const r=await api("/api/admin/fields/"+encodeURIComponent(item.id)+"/hard-delete",{method:"DELETE"});
      toast("登记条目已永久删除"+(r.deletedCustomerValues?("，同时删除 "+r.deletedCustomerValues+" 条客户字段数据"):""));
      renderFields(view);
    }catch(e){toast(e.message)}
  });
  document.querySelectorAll("[data-field-row]").forEach(row=>row.addEventListener("contextmenu",e=>{
    e.preventDefault();
    const anchor=items.find(x=>x.id===row.dataset.fieldRow);if(!anchor)return;
    showInsertContextMenu(e,{
      label:anchor.label,
      before:()=>fieldModal(view,null,Number(anchor.sort_order)||1,{anchorId:anchor.id,position:"before",anchorLabel:anchor.label}),
      after:()=>fieldModal(view,null,(Number(anchor.sort_order)||0)+1,{anchorId:anchor.id,position:"after",anchorLabel:anchor.label})
    });
  }));
}
function fieldModal(view,f,nextSort=1,insert=null){
  let fieldOptions=[];
  try{
    const parsed=JSON.parse(f?.options_json||"[]");
    if(Array.isArray(parsed)) fieldOptions=parsed.map(x=>String(x)).filter(Boolean);
  }catch{}

  const modalTitle=f?"编辑字段":insert?(insert.position==="before"?`在「${insert.anchorLabel}」上方插入字段`:`在「${insert.anchorLabel}」下方插入字段`):"添加字段";
  openModal(modalTitle,`
    <div class="field"><label>字段名称</label><input class="input" id="fLabel" value="${esc(f?.label||"")}"></div>
    <div class="field"><label>字段类型</label><select class="input" id="fType">
      ${["text","textarea","phone","email","number","date","time","url","select"].map(x=>`<option ${x===f?.field_type?"selected":""} value="${x}">${esc(fieldTypeName[x]||x)}</option>`).join("")}
    </select></div>

    <div id="fOptionsBox" class="field-options-box hidden">
      <div class="field-options-head">
        <div>
          <strong>下拉选择项</strong>
          <div class="muted" style="font-size:12px;margin-top:3px">业务员登记客户时，会从这里设置的选项中选择。</div>
        </div>
        <button class="btn secondary small" type="button" id="addFieldOption">＋ 添加选项</button>
      </div>
      <div id="fieldOptionsList" class="field-options-list"></div>
    </div>

    <div class="row wrap">
      <label><input type="checkbox" id="fRequired" ${f?.required?"checked":""}> 必填</label>
      <label><input type="checkbox" id="fList" ${f?.list_visible?"checked":""}> 客户列表显示</label>
      <label><input type="checkbox" id="fSearch" ${f?.searchable!==0?"checked":""}> 可搜索</label>
      <label><input type="checkbox" id="fEnabled" ${f?.enabled!==0?"checked":""}> 启用</label>
    </div>
    <div class="field"><label>排序数字（越小越靠前）</label><input class="input" id="fSort" type="number" value="${f?.sort_order??nextSort}" ${insert?"readonly":""}>${insert?'<div class="muted" style="font-size:12px;margin-top:5px">插入保存时会自动调整后续所有排序数字。</div>':""}</div>
    <button class="btn full" id="fSave">保存</button>`,()=>{
      const typeEl=document.querySelector("#fType");
      const box=document.querySelector("#fOptionsBox");
      const list=document.querySelector("#fieldOptionsList");

      function syncOptionsFromInputs(){
        fieldOptions=[...list.querySelectorAll(".field-option-input")]
          .map(x=>x.value.trim())
          .filter(Boolean);
      }

      function renderOptions(){
        list.innerHTML=fieldOptions.length
          ? fieldOptions.map((option,i)=>`
              <div class="field-option-row" data-option-index="${i}">
                <span class="drag">⋮⋮</span>
                <input class="input field-option-input" value="${esc(option)}" placeholder="例如：是">
                <button class="btn ghost small" type="button" data-option-up="${i}" ${i===0?"disabled":""}>↑</button>
                <button class="btn ghost small" type="button" data-option-down="${i}" ${i===fieldOptions.length-1?"disabled":""}>↓</button>
                <button class="btn danger small" type="button" data-option-delete="${i}">删除</button>
              </div>`).join("")
          : '<div class="empty-options">还没有选项，点击右上角“＋ 添加选项”。</div>';

        list.querySelectorAll(".field-option-input").forEach(input=>{
          input.oninput=()=>{
            const row=input.closest("[data-option-index]");
            if(row) fieldOptions[Number(row.dataset.optionIndex)]=input.value;
          };
        });
        list.querySelectorAll("[data-option-up]").forEach(btn=>btn.onclick=()=>{
          syncOptionsFromInputs();
          const i=Number(btn.dataset.optionUp);
          if(i>0)[fieldOptions[i-1],fieldOptions[i]]=[fieldOptions[i],fieldOptions[i-1]];
          renderOptions();
        });
        list.querySelectorAll("[data-option-down]").forEach(btn=>btn.onclick=()=>{
          syncOptionsFromInputs();
          const i=Number(btn.dataset.optionDown);
          if(i<fieldOptions.length-1)[fieldOptions[i+1],fieldOptions[i]]=[fieldOptions[i],fieldOptions[i+1]];
          renderOptions();
        });
        list.querySelectorAll("[data-option-delete]").forEach(btn=>btn.onclick=()=>{
          syncOptionsFromInputs();
          fieldOptions.splice(Number(btn.dataset.optionDelete),1);
          renderOptions();
        });
      }

      function updateOptionVisibility(){
        const isSelect=typeEl.value==="select";
        box.classList.toggle("hidden",!isSelect);
        if(isSelect&&fieldOptions.length===0){
          fieldOptions=["是","否"];
          renderOptions();
        }
      }

      document.querySelector("#addFieldOption").onclick=()=>{
        syncOptionsFromInputs();
        fieldOptions.push("");
        renderOptions();
        const inputs=list.querySelectorAll(".field-option-input");
        inputs[inputs.length-1]?.focus();
      };

      typeEl.onchange=updateOptionVisibility;
      renderOptions();
      updateOptionVisibility();

      document.querySelector("#fSave").onclick=async()=>{
        syncOptionsFromInputs();
        const type=val("fType");
        const label=val("fLabel").trim();
        if(!label){toast("请输入字段名称");return}
        if(type==="select"){
          const normalized=[];
          const seen=new Set();
          for(const option of fieldOptions.map(x=>String(x).trim()).filter(Boolean)){
            if(!seen.has(option)){seen.add(option);normalized.push(option)}
          }
          fieldOptions=normalized;
          if(fieldOptions.length===0){toast("下拉选择至少需要一个选项");return}
        }
        const body={
          label,
          fieldType:type,
          required:checked("fRequired"),
          listVisible:checked("fList"),
          searchable:checked("fSearch"),
          enabled:checked("fEnabled"),
          sortOrder:Number(val("fSort")||100),
          listSortOrder:Number(val("fSort")||100),
          options:type==="select"?fieldOptions:[]
        };
        if(insert){
          body.insertAnchorId=insert.anchorId;
          body.insertPosition=insert.position;
        }
        try{
          if(f)await api("/api/admin/fields/"+f.id,{method:"PATCH",body});
          else await api("/api/admin/fields",{method:"POST",body});
          closeModal();
          toast(insert?"字段已插入并自动调整排序":"字段设置已保存");
          renderFields(view);
        }catch(e){toast(e.message)}
      };
    },{draftKey:f?`field:${f.id}`:insert?`field:insert:${insert.anchorId}:${insert.position}`:"field:new"});
}

async function renderProgressAdmin(view){
  const r=await api("/api/progress-defs");const items=r.items||[];
  view.innerHTML=pageHead("客户进度管理","业务员勾选完成后，客户卡片百分比立即更新",`<button class="btn" id="addProgress">＋ 添加进度</button>`)+
    `<div class="table-wrap"><table><thead><tr><th>顺序</th><th>进度名称</th><th>说明</th><th>颜色</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${items.map(p=>`<tr data-progress-row="${esc(p.id)}"><td>${p.sort_order}</td><td><strong>${esc(p.label)}</strong></td><td>${esc(p.description||"")}</td><td><span class="tag" style="border-left:5px solid ${esc(p.color)}">${esc(p.color)}</span></td><td>${p.enabled?"启用":"停用"}</td><td>
      <button class="btn ghost small" data-edit-prog="${esc(p.id)}">编辑</button>
      <button class="btn ghost small" data-toggle-prog="${esc(p.id)}" data-enable-prog="${p.enabled?"0":"1"}">${p.enabled?"停用":"启用"}</button>
      <button class="btn danger small" data-hard-del-prog="${esc(p.id)}">删除</button>
    </td></tr>`).join("")}</tbody></table></div>`;
  const nextProgressSort=(items.reduce((m,x)=>Math.max(m,Number(x.sort_order)||0),0))+1;
  document.querySelector("#addProgress").onclick=()=>progressModal(view,null,nextProgressSort);
  document.querySelectorAll("[data-edit-prog]").forEach(b=>b.onclick=()=>progressModal(view,items.find(x=>x.id===b.dataset.editProg)));
  document.querySelectorAll("[data-toggle-prog]").forEach(b=>b.onclick=async()=>{
    const enabled=b.dataset.enableProg==="1";
    try{
      await api("/api/admin/progress/"+b.dataset.toggleProg,{method:"PATCH",body:{enabled}});
      toast(enabled?"客户进度已启用":"客户进度已停用");
      renderProgressAdmin(view);
    }catch(e){toast(e.message)}
  });
  document.querySelectorAll("[data-hard-del-prog]").forEach(b=>b.onclick=async()=>{
    const item=items.find(x=>x.id===b.dataset.hardDelProg);if(!item)return;
    if(!await uiConfirm("永久删除客户进度「"+item.label+"」？\n\n这会同时删除所有客户在这个进度上的完成记录，并重新计算所有客户的完成百分比。",{title:"永久删除客户进度",confirmText:"继续删除",danger:true}))return;
    if(!await uiConfirm("请再次确认：真的要永久删除「"+item.label+"」吗？\n\n此操作无法撤销。",{title:"最后确认",confirmText:"永久删除",danger:true}))return;
    try{
      const r=await api("/api/admin/progress/"+encodeURIComponent(item.id)+"/hard-delete",{method:"DELETE"});
      toast("客户进度已永久删除"+(r.deletedCustomerProgress?("，同时删除 "+r.deletedCustomerProgress+" 条完成记录"):""));
      renderProgressAdmin(view);
    }catch(e){toast(e.message)}
  });
  document.querySelectorAll("[data-progress-row]").forEach(row=>row.addEventListener("contextmenu",e=>{
    e.preventDefault();
    const anchor=items.find(x=>x.id===row.dataset.progressRow);if(!anchor)return;
    showInsertContextMenu(e,{
      label:anchor.label,
      before:()=>progressModal(view,null,Number(anchor.sort_order)||1,{anchorId:anchor.id,position:"before",anchorLabel:anchor.label}),
      after:()=>progressModal(view,null,(Number(anchor.sort_order)||0)+1,{anchorId:anchor.id,position:"after",anchorLabel:anchor.label})
    });
  }));
}
function progressModal(view,p,nextSort=1,insert=null){
  const modalTitle=p?"编辑进度":insert?(insert.position==="before"?`在「${insert.anchorLabel}」上方插入进度`:`在「${insert.anchorLabel}」下方插入进度`):"添加进度";
  openModal(modalTitle,`
    <div class="field"><label>进度名称</label><input class="input" id="pLabel" value="${esc(p?.label||"")}"></div>
    <div class="field"><label>说明</label><input class="input" id="pDesc" value="${esc(p?.description||"")}"></div>
    <div class="field"><label>颜色</label><input class="input" type="color" id="pColor" value="${esc(p?.color||"#2563eb")}"></div>
    <div class="field"><label>排序数字</label><input class="input" type="number" id="pSort" value="${p?.sort_order??nextSort}" ${insert?"readonly":""}>${insert?'<div class="muted" style="font-size:12px;margin-top:5px">插入保存时会自动调整后续所有排序数字。</div>':""}</div>
    <label><input type="checkbox" id="pEnabled" ${p?.enabled!==0?"checked":""}> 启用</label>
    <button class="btn full" id="pSave" style="margin-top:16px">保存</button>`,()=>{
      document.querySelector("#pSave").onclick=async()=>{
        const body={label:val("pLabel"),description:val("pDesc"),color:val("pColor"),sortOrder:Number(val("pSort")||100),enabled:checked("pEnabled")};
        if(insert){body.insertAnchorId=insert.anchorId;body.insertPosition=insert.position}
        try{
          if(p)await api("/api/admin/progress/"+p.id,{method:"PATCH",body});
          else await api("/api/admin/progress",{method:"POST",body});
          closeModal();toast(insert?"进度已插入并自动调整排序":"进度设置已保存");renderProgressAdmin(view)
        }catch(e){toast(e.message)}
      };
    },{draftKey:p?`progress:${p.id}`:insert?`progress:insert:${insert.anchorId}:${insert.position}`:"progress:new"});
}

async function renderSidebarAdmin(view){
  const r=await api("/api/admin/sidebar");const items=r.items||[];
  view.innerHTML=pageHead("左侧栏管理","只有管理员可以设置；保存后管理员端和业务员端会自动同步",`<button class="btn" id="addSide">＋ 添加按钮</button>`)+
    `<div class="notice" style="margin-bottom:14px">当前侧栏配置版本：<strong>${r.version}</strong>。在线用户会自动检测新版本并刷新左侧栏，不需要退出登录。</div>
    <div class="settings-list" id="sideRows">
      ${items.map(x=>`<div class="setting-row" draggable="true" data-side-id="${esc(x.id)}" data-audience="${esc(x.audience)}">
        <div class="drag">⋮⋮</div><div><strong>${esc(x.label)}</strong><div class="muted" style="font-size:12px">${esc(x.url)}</div></div>
        <div><span class="tag">${x.audience==="admin"?"管理员":x.audience==="sales"?"业务员":"两边"}</span></div>
        <div>${x.enabled?"启用":"停用"}</div>
        <div><button class="btn ghost small" data-side-edit="${esc(x.id)}">编辑</button> <button class="btn danger small" data-side-del="${esc(x.id)}">删除</button></div>
      </div>`).join("")}
    </div>`;
  document.querySelector("#addSide").onclick=()=>sidebarModal(view,null);
  document.querySelectorAll("[data-side-edit]").forEach(b=>b.onclick=()=>sidebarModal(view,items.find(x=>x.id===b.dataset.sideEdit)));
  document.querySelectorAll("[data-side-del]").forEach(b=>b.onclick=async()=>{if(!await uiConfirm("确认删除这个侧栏按钮？",{title:"删除侧栏按钮",confirmText:"删除",danger:true}))return;try{await api("/api/admin/sidebar/"+b.dataset.sideDel,{method:"DELETE"});toast("侧栏按钮已删除并同步");await refreshSidebar(true);renderSidebarAdmin(view)}catch(e){toast(e.message)}});
  enableSidebarDrag(view,items);
}
function sidebarModal(view,x){
  openModal(x?"编辑左侧栏按钮":"添加左侧栏按钮",`
    <div class="field"><label>按钮名称</label><input class="input" id="sLabel" value="${esc(x?.label||"")}"></div>
    <div class="field"><label>显示对象</label><select class="input" id="sAudience"><option value="admin" ${x?.audience==="admin"?"selected":""}>管理员</option><option value="sales" ${x?.audience==="sales"?"selected":""}>业务员</option><option value="all" ${x?.audience==="all"?"selected":""}>管理员和业务员</option></select></div>
    <div class="field"><label>跳转链接</label><input class="input" id="sUrl" value="${esc(x?.url||"https://")}"></div>
    <div class="field"><label>图标文字/图标代号</label><input class="input" id="sIcon" value="${esc(x?.icon||"link")}"></div>
    <div class="field"><label>分组标题</label><input class="input" id="sGroup" value="${esc(x?.group_label||"")}"></div>
    <div class="field"><label>打开方式</label><select class="input" id="sTarget"><option value="same" ${x?.target!=="new"?"selected":""}>当前页面</option><option value="new" ${x?.target==="new"?"selected":""}>新窗口</option></select></div>
    <div class="field"><label>排序数字</label><input class="input" type="number" id="sSort" value="${x?.sort_order??100}"></div>
    <label><input type="checkbox" id="sEnabled" ${x?.enabled!==0?"checked":""}> 启用</label>
    <button class="btn full" id="sSave" style="margin-top:16px">保存并同步</button>`,()=>{
      document.querySelector("#sSave").onclick=async()=>{const body={label:val("sLabel"),audience:val("sAudience"),url:val("sUrl"),icon:val("sIcon"),groupLabel:val("sGroup"),target:val("sTarget"),sortOrder:Number(val("sSort")||100),enabled:checked("sEnabled")};try{if(x)await api("/api/admin/sidebar/"+x.id,{method:"PATCH",body});else await api("/api/admin/sidebar",{method:"POST",body});closeModal();toast("左侧栏已保存并同步");await refreshSidebar(true);renderSidebarAdmin(view)}catch(e){toast(e.message)}};
    },{draftKey:`sidebar:${x?.id||"new"}`});
}
function enableSidebarDrag(view,items){
  let dragId=null;
  document.querySelectorAll("[data-side-id]").forEach(row=>{
    row.addEventListener("dragstart",()=>dragId=row.dataset.sideId);
    row.addEventListener("dragover",e=>e.preventDefault());
    row.addEventListener("drop",async e=>{
      e.preventDefault();const targetId=row.dataset.sideId;if(!dragId||dragId===targetId)return;
      const a=items.find(x=>x.id===dragId),b=items.find(x=>x.id===targetId);
      if(!a||!b||a.audience!==b.audience){toast("请在同一显示对象内排序");return;}
      const subset=items.filter(x=>x.audience===a.audience).sort((x,y)=>x.sort_order-y.sort_order);
      const from=subset.findIndex(x=>x.id===dragId),to=subset.findIndex(x=>x.id===targetId);
      const [moved]=subset.splice(from,1);subset.splice(to,0,moved);
      try{
        for(let i=0;i<subset.length;i++)await api("/api/admin/sidebar/"+subset[i].id,{method:"PATCH",body:{sortOrder:(i+1)*10}});
        toast("排序已同步");await refreshSidebar(true);renderSidebarAdmin(view);
      }catch(err){toast(err.message)}
    });
  });
}


async function renderRegistrationLayoutSettings(view){
  const r=await api("/api/admin/registration-layout");
  const fields=r.fields||[];
  let sections=(r.layout?.sections||[]).map(s=>({
    id:String(s.id||("sec_"+Date.now()+Math.random())),
    title:String(s.title||"信息分组"),
    description:String(s.description||""),
    items:[...(Array.isArray(s.items)?s.items:[])]
  }));
  const allItems=[
    {id:"name",label:"客户姓名",field_type:"text",fixed:true},
    ...fields.map(f=>({id:f.id,label:f.label,field_type:f.field_type,fixed:false}))
  ];
  if(!sections.length)sections=[{id:"basic",title:"基本信息",description:"",items:["name"]}];

  function usedSet(){return new Set(sections.flatMap(s=>s.items||[]))}
  function syncInputs(){
    document.querySelectorAll("[data-layout-section]").forEach(el=>{
      const s=sections.find(x=>x.id===el.dataset.layoutSection);if(!s)return;
      s.title=el.querySelector(".layout-title")?.value||s.title;
      s.description=el.querySelector(".layout-desc")?.value||"";
    });
  }
  function labelOf(id){return allItems.find(x=>x.id===id)?.label||id}
  function renderEditor(){
    view.innerHTML=pageHead("业务员登记面板设置","把登记条目分成不同区域。业务员打开“登记客户”时会按这里的分组和顺序显示。",
      `<button class="btn" id="saveRegLayout">保存并同步</button>`)+
      `<div class="notice" style="margin-bottom:16px">例如可以把“客户姓名、手机号、邮箱”放进“基本信息”区域，把其他登记内容放进其他区域。没有分组的字段不会消失，会自动放到“其他信息”。</div>
      <div id="layoutSections" class="layout-section-list"></div>
      <div class="row wrap" style="margin-top:16px">
        <button class="btn secondary" id="addLayoutSection">＋ 添加区域栏</button>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="margin-top:0">未分组条目</h3>
        <div id="unassignedFields" class="unassigned-fields"></div>
      </div>`;

    const host=document.querySelector("#layoutSections");
    host.innerHTML=sections.map((s,si)=>{
      const used=usedSet();
      const available=allItems.filter(x=>!used.has(x.id));
      return `<section class="layout-section-card" data-layout-section="${esc(s.id)}">
        <div class="layout-section-toolbar">
          <div class="layout-section-fields">
            <input class="input layout-title" value="${esc(s.title)}" placeholder="区域名称">
            <input class="input layout-desc" value="${esc(s.description)}" placeholder="区域说明（可留空）">
          </div>
          <div class="row">
            <button class="btn ghost small" data-sec-up="${esc(s.id)}" ${si===0?"disabled":""}>↑</button>
            <button class="btn ghost small" data-sec-down="${esc(s.id)}" ${si===sections.length-1?"disabled":""}>↓</button>
            <button class="btn danger small" data-sec-delete="${esc(s.id)}">删除区域</button>
          </div>
        </div>
        <div class="layout-items">
          ${(s.items||[]).map((key,ii)=>`<div class="layout-item">
            <span class="drag">⋮⋮</span>
            <strong>${esc(labelOf(key))}</strong>
            <span class="tag">${key==="name"?"固定字段":"登记字段"}</span>
            <span class="grow"></span>
            <button class="btn ghost small" data-item-up="${esc(s.id)}:${ii}" ${ii===0?"disabled":""}>↑</button>
            <button class="btn ghost small" data-item-down="${esc(s.id)}:${ii}" ${ii===s.items.length-1?"disabled":""}>↓</button>
            <select class="input move-target" data-move-select="${esc(s.id)}:${ii}" style="width:auto;min-width:130px">
              <option value="">移动到...</option>
              ${sections.filter(x=>x.id!==s.id).map(x=>`<option value="${esc(x.id)}">${esc(x.title)}</option>`).join("")}
            </select>
            <button class="btn ghost small" data-move-item="${esc(s.id)}:${ii}">移动</button>
            <button class="btn danger small" data-remove-item="${esc(s.id)}:${ii}">移出</button>
          </div>`).join("")||'<div class="muted">这个区域还没有登记条目</div>'}
        </div>
        <div class="row wrap" style="margin-top:12px">
          <select class="input grow" data-add-select="${esc(s.id)}">
            <option value="">选择要加入这个区域的登记条目</option>
            ${available.map(x=>`<option value="${esc(x.id)}">${esc(x.label)}</option>`).join("")}
          </select>
          <button class="btn secondary small" data-add-item="${esc(s.id)}">加入区域</button>
        </div>
      </section>`;
    }).join("");

    const unused=allItems.filter(x=>!usedSet().has(x.id));
    document.querySelector("#unassignedFields").innerHTML=unused.length
      ? unused.map(x=>`<span class="tag">${esc(x.label)}</span>`).join(" ")
      : '<span class="muted">所有登记条目都已经分组</span>';

    document.querySelector("#addLayoutSection").onclick=()=>{
      syncInputs();
      sections.push({id:"sec_"+Date.now()+"_"+Math.random().toString(16).slice(2),title:"新区域",description:"",items:[]});
      renderEditor();
    };
    document.querySelectorAll("[data-sec-up]").forEach(b=>b.onclick=()=>{
      syncInputs();const i=sections.findIndex(x=>x.id===b.dataset.secUp);if(i>0)[sections[i-1],sections[i]]=[sections[i],sections[i-1]];renderEditor();
    });
    document.querySelectorAll("[data-sec-down]").forEach(b=>b.onclick=()=>{
      syncInputs();const i=sections.findIndex(x=>x.id===b.dataset.secDown);if(i>=0&&i<sections.length-1)[sections[i+1],sections[i]]=[sections[i],sections[i+1]];renderEditor();
    });
    document.querySelectorAll("[data-sec-delete]").forEach(b=>b.onclick=()=>{
      syncInputs();if(sections.length===1){toast("至少保留一个区域");return}
      sections=sections.filter(x=>x.id!==b.dataset.secDelete);renderEditor();
    });
    document.querySelectorAll("[data-add-item]").forEach(b=>b.onclick=()=>{
      syncInputs();const s=sections.find(x=>x.id===b.dataset.addItem);const sel=document.querySelector('[data-add-select="'+b.dataset.addItem+'"]');
      if(s&&sel?.value){s.items.push(sel.value);renderEditor()}
    });
    document.querySelectorAll("[data-remove-item]").forEach(b=>b.onclick=()=>{
      syncInputs();const [sid,idxRaw]=b.dataset.removeItem.split(":");const s=sections.find(x=>x.id===sid);if(s){s.items.splice(Number(idxRaw),1);renderEditor()}
    });
    document.querySelectorAll("[data-item-up]").forEach(b=>b.onclick=()=>{
      syncInputs();const [sid,idxRaw]=b.dataset.itemUp.split(":");const s=sections.find(x=>x.id===sid),i=Number(idxRaw);if(s&&i>0)[s.items[i-1],s.items[i]]=[s.items[i],s.items[i-1]];renderEditor();
    });
    document.querySelectorAll("[data-item-down]").forEach(b=>b.onclick=()=>{
      syncInputs();const [sid,idxRaw]=b.dataset.itemDown.split(":");const s=sections.find(x=>x.id===sid),i=Number(idxRaw);if(s&&i<s.items.length-1)[s.items[i+1],s.items[i]]=[s.items[i],s.items[i+1]];renderEditor();
    });
    document.querySelectorAll("[data-move-item]").forEach(b=>b.onclick=()=>{
      syncInputs();const [sid,idxRaw]=b.dataset.moveItem.split(":");const s=sections.find(x=>x.id===sid),i=Number(idxRaw);
      const targetId=document.querySelector('[data-move-select="'+b.dataset.moveItem+'"]')?.value;
      const target=sections.find(x=>x.id===targetId);if(s&&target&&s.items[i]){const [item]=s.items.splice(i,1);target.items.push(item);renderEditor()}
    });
    document.querySelector("#saveRegLayout").onclick=async()=>{
      syncInputs();
      try{
        await api("/api/admin/registration-layout",{method:"PUT",body:{sections}});
        toast("业务员登记面板已保存并同步");
        renderRegistrationLayoutSettings(view);
      }catch(e){toast(e.message)}
    };
  }
  renderEditor();
}

async function renderListSettings(view,audience="admin"){
  const r=await api("/api/admin/list-columns?audience="+audience);
  const fields=r.fields||[];

  const seen=new Set();
  let items=[];
  for(const x of r.items||[]){
    const key=String(x.column_key||"")+":"+String(x.field_id||"");
    if(seen.has(key))continue;
    seen.add(key);
    items.push({...x});
  }

  const titleAudience=audience==="admin"?"管理员":"业务员";
  view.innerHTML=pageHead("客户列表显示设置","管理员统一决定客户列表每一行显示哪些资料以及显示顺序")+
    `<div class="row" style="margin-bottom:14px">
      <button class="btn ${audience==="admin"?"":"ghost"} small" id="listAdmin">管理员列表</button>
      <button class="btn ${audience==="sales"?"":"ghost"} small" id="listSales">业务员列表</button>
    </div>
    <div class="card">
      <h3 style="margin-top:0">${titleAudience}客户列表内容</h3>
      <p class="muted">没有任何固定字段。客户姓名、业务员和所有登记字段都可以自由添加、移除、改显示名称和拖动排序。</p>
      <div class="settings-list" id="listColumnRows"></div>
      <div class="row wrap" style="margin-top:14px">
        <select class="input grow" id="addColumnSelect"></select>
        <button class="btn secondary" id="addColumnBtn">＋ 添加显示内容</button>
        <button class="btn" id="saveColumns">保存并同步</button>
      </div>
    </div>`;

  document.querySelector("#listAdmin").onclick=()=>renderListSettings(view,"admin");
  document.querySelector("#listSales").onclick=()=>renderListSettings(view,"sales");

  const rows=document.querySelector("#listColumnRows");

  function redraw(){
    rows.innerHTML=items.length?items.map((x,i)=>`<div class="setting-row" draggable="true" data-ci="${i}">
      <div class="drag">⋮⋮</div>
      <div>
        <input class="input list-label" value="${esc(x.label||"")}">
        <div class="muted" style="font-size:12px">${x.column_key==="dynamic"?"登记字段":x.column_key==="owner"?"业务员":"客户姓名"}</div>
      </div>
      <div><span class="tag">${x.column_key==="dynamic"?"字段":x.column_key==="owner"?"业务员":"姓名"}</span></div>
      <div>${i+1}</div>
      <div><button class="btn danger small remove-col">移除</button></div>
    </div>`).join(""):'<div class="empty-options">当前列表没有设置任何客户资料显示项。</div>';

    rows.querySelectorAll(".remove-col").forEach(btn=>btn.onclick=()=>{
      const idx=Number(btn.closest("[data-ci]").dataset.ci);
      items.splice(idx,1);
      redraw();
      fillAdd();
    });
    enableListDrag();
  }

  function fillAdd(){
    const selectedKeys=new Set(items.map(x=>String(x.column_key||"")+":"+String(x.field_id||"")));
    const opts=[];

    if(!selectedKeys.has("name:"))opts.push('<option value="name:">客户姓名</option>');
    if(audience==="admin"&&!selectedKeys.has("owner:"))opts.push('<option value="owner:">业务员</option>');

    for(const f of fields){
      const k="dynamic:"+f.id;
      if(!selectedKeys.has(k))opts.push(`<option value="dynamic:${esc(f.id)}">${esc(f.label)}</option>`);
    }

    document.querySelector("#addColumnSelect").innerHTML=opts.join("")||'<option value="">没有可添加的内容</option>';
  }

  function enableListDrag(){
    let from=null;
    rows.querySelectorAll("[data-ci][draggable='true']").forEach(row=>{
      row.ondragstart=()=>from=Number(row.dataset.ci);
      row.ondragover=e=>e.preventDefault();
      row.ondrop=e=>{
        e.preventDefault();
        const to=Number(row.dataset.ci);
        if(from===null||from===to)return;
        const [m]=items.splice(from,1);
        items.splice(to,0,m);
        redraw();
      };
    });
  }

  redraw();
  fillAdd();

  document.querySelector("#addColumnBtn").onclick=()=>{
    const v=val("addColumnSelect");if(!v)return;
    const [key,fid]=v.split(":");
    if(key==="name")items.push({column_key:"name",field_id:null,label:"客户姓名",enabled:1});
    else if(key==="owner")items.push({column_key:"owner",field_id:null,label:"业务员",enabled:1});
    else{
      const f=fields.find(x=>x.id===fid);
      if(f)items.push({column_key:"dynamic",field_id:f.id,label:f.label,enabled:1});
    }
    redraw();
    fillAdd();
  };

  document.querySelector("#saveColumns").onclick=async()=>{
    const rowEls=[...rows.querySelectorAll("[data-ci]")];
    const payload=rowEls.map((el,i)=>{
      const item=items[Number(el.dataset.ci)];
      return {
        columnKey:item.column_key,
        fieldId:item.field_id||null,
        label:el.querySelector(".list-label")?.value||item.label||"",
        enabled:true,
        sortOrder:(i+1)*10
      };
    });
    try{
      await api("/api/admin/list-columns",{method:"PUT",body:{audience,items:payload}});
      toast("客户列表显示设置已同步");
      renderListSettings(view,audience);
    }catch(e){toast(e.message)}
  };
}

const widgetTypeName={
  metric_total:"客户数量",
  metric_today:"今日新增",
  metric_complete:"已完成客户",
  metric_archived:"已归档（不计入常规统计）",
  metric_progress:"客户进度统计",
  sales_breakdown:"业务员客户分布"
};

async function renderDashboardSettings(view,audience="admin"){
  const r=await api("/api/admin/dashboard-widgets?audience="+audience);
  const items=r.items||[];
  const progressDefs=r.progressDefs||[];
  const progressName=new Map(progressDefs.map(x=>[x.id,x.label]));

  view.innerHTML=pageHead("仪表盘设置","管理员可以添加、减少、编辑和排序仪表盘内容",`<button class="btn" id="addWidget">＋ 添加组件</button>`)+
    `<div class="row" style="margin-bottom:14px">
      <button class="btn ${audience==="admin"?"":"ghost"} small" id="dashAdmin">管理员仪表盘</button>
      <button class="btn ${audience==="sales"?"":"ghost"} small" id="dashSales">业务员仪表盘</button>
    </div>
    <div class="notice" style="margin-bottom:14px">仪表盘支持“总数据 / 当日数据 / 本周数据”切换。所有常规统计和客户进度统计都会自动排除已归档客户。</div>
    <div class="table-wrap"><table><thead><tr><th>顺序</th><th>标题</th><th>内容</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${items.map(x=>{
      let content=widgetTypeName[x.widget_type]||x.widget_type;
      if(x.widget_type==="metric_progress"){
        let cfg={};try{cfg=JSON.parse(x.config_json||"{}")}catch{}
        content+=" · "+(progressName.get(cfg.progressId)||"未选择进度");
      }
      return `<tr><td>${x.sort_order}</td><td><strong>${esc(x.title)}</strong></td><td>${esc(content)}</td><td>${x.enabled?"显示":"隐藏"}</td><td><button class="btn ghost small" data-widget-edit="${esc(x.id)}">编辑</button> <button class="btn danger small" data-widget-del="${esc(x.id)}">删除</button></td></tr>`;
    }).join("")||`<tr><td colspan="5" class="muted">当前没有组件</td></tr>`}</tbody></table></div>`;

  document.querySelector("#dashAdmin").onclick=()=>renderDashboardSettings(view,"admin");
  document.querySelector("#dashSales").onclick=()=>renderDashboardSettings(view,"sales");
  document.querySelector("#addWidget").onclick=()=>dashboardWidgetModal(view,audience,null,progressDefs);
  document.querySelectorAll("[data-widget-edit]").forEach(b=>b.onclick=()=>dashboardWidgetModal(view,audience,items.find(x=>x.id===b.dataset.widgetEdit),progressDefs));
  document.querySelectorAll("[data-widget-del]").forEach(b=>b.onclick=async()=>{
    if(!await uiConfirm("确认删除这个仪表盘组件？",{title:"删除仪表盘组件",confirmText:"删除",danger:true}))return;
    try{
      await api("/api/admin/dashboard-widgets/"+b.dataset.widgetDel,{method:"DELETE"});
      toast("组件已删除");
      renderDashboardSettings(view,audience);
    }catch(e){toast(e.message)}
  });
}

function dashboardWidgetModal(view,audience,w,progressDefs=[]){
  const baseAllowed=audience==="admin"
    ?["metric_total","metric_complete","metric_progress","sales_breakdown"]
    :["metric_total","metric_complete","metric_progress"];
  const allowed=w?.widget_type&&!baseAllowed.includes(w.widget_type)?[...baseAllowed,w.widget_type]:baseAllowed;

  let config={};try{config=JSON.parse(w?.config_json||"{}")}catch{}

  openModal(w?"编辑仪表盘组件":"添加仪表盘组件",`
    <div class="field"><label>组件内容</label><select class="input" id="wType">${allowed.map(x=>`<option value="${x}" ${w?.widget_type===x?"selected":""}>${esc(widgetTypeName[x]||x)}</option>`).join("")}</select></div>

    <div class="field hidden" id="wProgressBox">
      <label>选择客户进度</label>
      <select class="input" id="wProgressId">
        <option value="">请选择进度</option>
        ${progressDefs.map(p=>`<option value="${esc(p.id)}" ${config.progressId===p.id?"selected":""}>${esc(p.label)}</option>`).join("")}
      </select>
      <div class="muted" style="font-size:12px">例如选择“客户建档”，仪表盘就会显示该进度在当前时间范围内完成的客户数量。</div>
    </div>

    <div class="field"><label>显示标题</label><input class="input" id="wTitle" value="${esc(w?.title||"")}"></div>
    <div class="field"><label>排序数字（越小越靠前）</label><input class="input" id="wSort" type="number" value="${w?.sort_order??100}"></div>
    <label><input type="checkbox" id="wEnabled" ${w?.enabled!==0?"checked":""}> 显示</label>
    <button class="btn full" id="wSave" style="margin-top:16px">保存</button>
  `,()=>{
    const type=document.querySelector("#wType");
    const progressBox=document.querySelector("#wProgressBox");
    const progressSelect=document.querySelector("#wProgressId");
    const title=document.querySelector("#wTitle");

    const updateTypeUi=()=>{
      const isProgress=type.value==="metric_progress";
      progressBox.classList.toggle("hidden",!isProgress);
      if(!w||!title.value){
        if(isProgress){
          const selected=progressDefs.find(x=>x.id===progressSelect.value);
          title.value=selected?selected.label:"客户进度统计";
        }else{
          title.value=widgetTypeName[type.value]||"统计组件";
        }
      }
    };

    if(!w)title.value=widgetTypeName[type.value]||"统计组件";
    type.onchange=updateTypeUi;
    progressSelect.onchange=()=>{
      if(type.value==="metric_progress"){
        const selected=progressDefs.find(x=>x.id===progressSelect.value);
        if(selected)title.value=selected.label;
      }
    };
    updateTypeUi();

    document.querySelector("#wSave").onclick=async()=>{
      const widgetType=val("wType");
      const body={
        audience,
        widgetType,
        title:val("wTitle")||widgetTypeName[widgetType]||"统计组件",
        sortOrder:Number(val("wSort")||100),
        enabled:checked("wEnabled"),
        config:{}
      };
      if(widgetType==="metric_progress"){
        const progressId=val("wProgressId");
        if(!progressId){toast("请选择一个客户进度");return}
        body.config={progressId};
      }
      try{
        if(w)await api("/api/admin/dashboard-widgets/"+w.id,{method:"PATCH",body});
        else await api("/api/admin/dashboard-widgets",{method:"POST",body});
        closeModal();
        toast("仪表盘设置已保存");
        renderDashboardSettings(view,audience);
      }catch(e){toast(e.message)}
    };
  },{draftKey:`dashboard-widget:${audience}:${w?.id||"new"}`});
}


async function renderTelegramSettings(view){
  const r=await api("/api/admin/telegram");
  const s=r.settings||{};
  const available=r.availableFields||[];
  let fields=(s.fields||[]).map(x=>({...x}));

  view.innerHTML=pageHead("Telegram 通知","业务员完成客户进度后，机器人自动在指定 Telegram 群播报。")+
    `<div class="grid telegram-settings-grid">
      <section class="card">
        <h3 style="margin-top:0">机器人连接</h3>
        <div class="field">
          <label>Telegram Bot Token</label>
          <input class="input" id="tgBotToken" type="password" autocomplete="new-password"
            placeholder="${s.hasToken?"已保存 "+esc(s.tokenHint||"")+"，不修改请留空":"粘贴 BotFather 给你的机器人 Token"}">
          <div class="muted" style="font-size:12px;margin-top:5px">Token 保存后不会在页面回显明文，也不会进入普通业务数据备份。</div>
        </div>
        <div class="field">
          <label>Telegram 群 ID</label>
          <input class="input" id="tgChatId" value="${esc(s.chatId||"")}" placeholder="例如：-1001234567890">
        </div>
        <div class="field">
          <label>详情链接文字</label>
          <input class="input" id="tgLinkLabel" value="${esc(s.linkLabel||"查看客户详情")}">
        </div>
        <div class="row wrap" style="margin:10px 0 16px">
          <label><input type="checkbox" id="tgEnabled" ${s.enabled?"checked":""}> 启用 Telegram 自动播报</label>
          <label><input type="checkbox" id="tgNotifyAdmin" ${s.notifyAdmin?"checked":""}> 管理员勾选进度时也播报</label>
        </div>
        <div class="row wrap">
          <button class="btn" id="tgSave">保存设置</button>
          <button class="btn secondary" id="tgTest">保存并发送测试消息</button>
        </div>
      </section>

      <section class="card">
        <h3 style="margin-top:0">播报内容</h3>
        <p class="muted">这里决定 Telegram 群里每条通知显示哪些客户资料。可以添加、删除、改标题和调整顺序。</p>
        <div id="tgFieldRows" class="telegram-field-list"></div>
        <div class="row wrap" style="margin-top:12px">
          <select class="input grow" id="tgAddField"></select>
          <button class="btn secondary" id="tgAddFieldBtn">＋ 添加显示内容</button>
        </div>
      </section>
    </div>

    <section class="card" style="margin-top:16px">
      <h3 style="margin-top:0">最近发送记录</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>时间</th><th>业务员</th><th>客户</th><th>状态</th><th>说明</th></tr></thead>
          <tbody>
            ${(r.logs||[]).map(x=>`<tr>
              <td>${esc((x.created_at||"").replace("T"," ").slice(0,19))}</td>
              <td>${esc(x.actor_name||"")}</td>
              <td>${esc(x.customer_name||"")}</td>
              <td><span class="tag">${x.status==="success"?"发送成功":x.status==="failed"?"发送失败":"已跳过"}</span></td>
              <td>${esc(x.error_text||"")}</td>
            </tr>`).join("")||'<tr><td colspan="5" class="muted">还没有发送记录</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>`;

  const rows=document.querySelector("#tgFieldRows");
  const add=document.querySelector("#tgAddField");

  function syncLabels(){
    rows.querySelectorAll("[data-tg-field-row]").forEach(el=>{
      const i=Number(el.dataset.tgFieldRow);
      if(fields[i])fields[i].label=el.querySelector(".tg-field-label")?.value||fields[i].label;
    });
  }

  function refillAdd(){
    const used=new Set(fields.map(x=>x.key));
    add.innerHTML=available.filter(x=>!used.has(x.key)).map(x=>
      `<option value="${esc(x.key)}">${esc(x.label)}</option>`
    ).join("")||'<option value="">没有其他可添加内容</option>';
  }

  function redraw(){
    rows.innerHTML=fields.map((x,i)=>`<div class="telegram-field-row" data-tg-field-row="${i}">
      <span class="drag">⋮⋮</span>
      <div class="grow">
        <input class="input tg-field-label" value="${esc(x.label||"")}" placeholder="Telegram 中显示的标题">
        <div class="muted" style="font-size:11px;margin-top:3px">${esc(available.find(a=>a.key===x.key)?.label||x.key)}</div>
      </div>
      <button class="btn ghost small" data-tg-up="${i}" ${i===0?"disabled":""}>↑</button>
      <button class="btn ghost small" data-tg-down="${i}" ${i===fields.length-1?"disabled":""}>↓</button>
      <button class="btn danger small" data-tg-del="${i}">删除</button>
    </div>`).join("")||'<div class="empty-options">当前没有播报内容。</div>';

    rows.querySelectorAll("[data-tg-up]").forEach(b=>b.onclick=()=>{
      syncLabels();const i=Number(b.dataset.tgUp);if(i>0)[fields[i-1],fields[i]]=[fields[i],fields[i-1]];redraw();
    });
    rows.querySelectorAll("[data-tg-down]").forEach(b=>b.onclick=()=>{
      syncLabels();const i=Number(b.dataset.tgDown);if(i<fields.length-1)[fields[i+1],fields[i]]=[fields[i],fields[i+1]];redraw();
    });
    rows.querySelectorAll("[data-tg-del]").forEach(b=>b.onclick=()=>{
      syncLabels();fields.splice(Number(b.dataset.tgDel),1);redraw();
    });
    refillAdd();
  }

  document.querySelector("#tgAddFieldBtn").onclick=()=>{
    syncLabels();
    const key=add.value;if(!key)return;
    const x=available.find(a=>a.key===key);if(!x)return;
    fields.push({key:x.key,label:x.label});
    redraw();
  };

  async function saveSettings(showToast=true){
    syncLabels();
    const body={
      botToken:val("tgBotToken"),
      chatId:val("tgChatId"),
      linkLabel:val("tgLinkLabel"),
      enabled:checked("tgEnabled"),
      notifyAdmin:checked("tgNotifyAdmin"),
      fields
    };
    const out=await api("/api/admin/telegram",{method:"PUT",body});
    document.querySelector("#tgBotToken").value="";
    document.querySelector("#tgBotToken").placeholder="已保存 "+(out.tokenHint||"")+"，不修改请留空";
    if(showToast)toast("Telegram 设置已保存");
  }

  document.querySelector("#tgSave").onclick=async()=>{
    try{await saveSettings(true)}catch(e){toast(e.message)}
  };
  document.querySelector("#tgTest").onclick=async()=>{
    const btn=document.querySelector("#tgTest");
    btn.disabled=true;btn.textContent="正在测试...";
    try{
      await saveSettings(false);
      await api("/api/admin/telegram/test",{method:"POST"});
      toast("测试消息已发送到 Telegram 群");
      setTimeout(()=>renderTelegramSettings(view),500);
    }catch(e){toast(e.message)}
    btn.disabled=false;btn.textContent="保存并发送测试消息";
  };

  redraw();
}

async function renderCapacity(view){
  const r=await api("/api/admin/capacity"), c=r.config;
  const noticeClass=r.level==="normal"?"":r.level==="warning"?"warning":"urgent";
  const levelText={normal:"正常",warning:"注意",upgrade:"建议升级",urgent:"尽快升级"}[r.level]||r.level;
  view.innerHTML=pageHead("系统容量与费用","你不需要记平台名称；需要付费时这里会明确告诉你")+
    `<div class="notice ${noticeClass}" style="margin-bottom:16px"><strong>当前状态：${levelText}</strong><div style="margin-top:6px">${esc(r.message)}</div></div>
    <div class="grid metrics">
      <div class="card metric"><div class="label">客户数量</div><div class="value">${money(r.customerCount)}</div></div>
      <div class="card metric"><div class="label">估算数据库使用</div><div class="value">${r.estimatedMb} MB</div></div>
      <div class="card metric"><div class="label">当前免费单库参考上限</div><div class="value">${r.freeSingleDatabaseMb} MB</div></div>
      <div class="card metric"><div class="label">容量使用率</div><div class="value">${r.percent}%</div></div>
    </div>
    <div class="card" style="margin-top:18px">
      <h3 style="margin-top:0">客户资料容量</h3>
      <div class="capacity-bar"><div class="capacity-fill" style="width:${Math.min(100,r.percent)}%"></div></div>
      <div class="muted" style="margin-top:8px">系统会在约 ${c.warning_percent}% 开始提醒，${c.upgrade_percent}% 建议升级，${c.urgent_percent}% 提醒尽快处理。</div>
    </div>
    <div class="card" style="margin-top:18px">
      <h3 style="margin-top:0">如果以后需要付费，你应该付什么</h3>
      <div class="table-wrap"><table>
        <tbody>
          <tr><th>服务商</th><td>${esc(c.provider)}</td></tr>
          <tr><th>数据库</th><td>${esc(c.database)}</td></tr>
          <tr><th>当前参考套餐</th><td>Workers Free / D1 Free</td></tr>
          <tr><th>需要升级时</th><td>升级 Cloudflare Workers Paid</td></tr>
          <tr><th>最低费用参考</th><td>约 ${c.paid_base_usd_month} USD / 月</td></tr>
          <tr><th>价格检查日期</th><td>${esc(c.pricing_checked)}</td></tr>
        </tbody>
      </table></div>
      <p class="muted">真正需要升级时，系统会在管理员首页和这里同时提醒。平台价格可能变化，因此会显示最近核对日期。</p>
      <a class="btn" href="${esc(c.upgrade_url)}" target="_blank" rel="noopener">打开升级/付款平台</a>
    </div>
    <div class="card" style="margin-top:18px">
      <h3 style="margin-top:0">当前免费额度参考</h3>
      <div class="table-wrap"><table><thead><tr><th>项目</th><th>参考免费额度</th></tr></thead><tbody>
        <tr><td>D1 数据读取</td><td>${money(c.free_rows_read_day)} 行 / 天</td></tr>
        <tr><td>D1 数据写入</td><td>${money(c.free_rows_write_day)} 行 / 天</td></tr>
        <tr><td>Workers 请求</td><td>${money(c.free_worker_requests_day)} 次 / 天</td></tr>
        <tr><td>D1 账户总存储</td><td>${c.free_account_gb} GB</td></tr>
      </tbody></table></div>
    </div>`;
}


const actionName={
  login:"登录",logout:"退出登录",create:"新增",update:"修改",delete:"删除",
  restore:"恢复",disable:"停用",replace:"替换配置",progress_complete:"完成进度",
  progress_uncomplete:"取消进度",export:"导出备份",import:"导入备份",bootstrap_admin:"创建首个管理员"
};
const entityName={
  customer:"客户",user:"账号",field:"登记字段",progress_definition:"客户进度",
  sidebar_item:"左侧栏按钮",dashboard_widget:"仪表盘组件",list_columns:"客户列表设置",
  business_data:"业务数据",session:"登录会话"
};

async function renderAudit(view){
  const r=await api("/api/admin/audit?limit=200");
  const items=r.items||[];
  view.innerHTML=pageHead("操作记录","查看谁在什么时候对系统做了什么操作")+
    `<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>对象ID</th></tr></thead><tbody>
    ${items.map(x=>`<tr><td>${esc((x.created_at||"").replace("T"," ").slice(0,19))}</td><td>${esc(x.actor_name||"系统")}</td><td>${esc(actionName[x.action]||x.action)}</td><td>${esc(entityName[x.entity_type]||x.entity_type)}</td><td><span class="muted">${esc(x.entity_id||"")}</span></td></tr>`).join("")||`<tr><td colspan="5" class="muted">还没有操作记录</td></tr>`}</tbody></table></div>`;
}

async function renderRecycle(view){
  const r=await api("/api/admin/recycle");
  const items=r.items||[];
  view.innerHTML=pageHead("回收站","删除客户不会立即永久消失，可以在这里恢复")+
    `<div class="table-wrap"><table><thead><tr><th>客户姓名</th><th>业务员</th><th>删除时间</th><th>操作</th></tr></thead><tbody>
    ${items.map(x=>`<tr><td><strong>${esc(x.name)}</strong></td><td>${esc(x.owner_name||"未分配")}</td><td>${esc((x.deleted_at||"").replace("T"," ").slice(0,19))}</td><td><button class="btn secondary small" data-restore="${esc(x.id)}">恢复客户</button></td></tr>`).join("")||`<tr><td colspan="4" class="muted">回收站为空</td></tr>`}</tbody></table></div>`;
  document.querySelectorAll("[data-restore]").forEach(b=>b.onclick=async()=>{
    try{await api("/api/admin/recycle/"+b.dataset.restore+"/restore",{method:"POST"});toast("客户已恢复");renderRecycle(view)}catch(e){toast(e.message)}
  });
}

async function renderBackup(view){
  view.innerHTML=pageHead("数据备份与恢复","备份只包含业务数据和配置，不包含管理员密码、业务员密码或登录会话")+
    `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="card">
        <h3 style="margin-top:0">导出完整业务备份</h3>
        <p class="muted">导出客户资料、业务员基础资料、客户进度、登记字段、左侧栏、列表设置和仪表盘配置。</p>
        <button class="btn" id="exportBackup">导出备份文件</button>
      </div>
      <div class="card">
        <h3 style="margin-top:0">从备份恢复</h3>
        <p class="muted">支持大数据量分批恢复。恢复过程不会把密码从备份带回系统，业务员会为了安全保持停用，管理员重新设置密码后再启用。</p>
        <input class="input" type="file" id="backupFile" accept="application/json,.json">
        <button class="btn secondary" id="importBackup" style="margin-top:10px">开始恢复</button>
        <div id="restoreProgress" class="muted" style="margin-top:10px"></div>
      </div>
    </div>
    <div class="notice warning" style="margin-top:16px">建议你每隔一段时间手动导出一份备份保存到自己的电脑。以后还会继续增加自动备份机制。</div>`;

  document.querySelector("#exportBackup").onclick=async()=>{
    const btn=document.querySelector("#exportBackup");btn.disabled=true;btn.textContent="正在生成...";
    try{
      const data=await api("/api/admin/export");
      const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
      const a=document.createElement("a");a.href=URL.createObjectURL(blob);
      const d=new Date().toISOString().replace(/[:.]/g,"-");
      a.download=`MS007-业务数据备份-${d}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
      toast("备份文件已生成");
    }catch(e){toast(e.message)}
    btn.disabled=false;btn.textContent="导出备份文件";
  };

  document.querySelector("#importBackup").onclick=async()=>{
    const file=document.querySelector("#backupFile").files?.[0];
    if(!file){toast("请先选择备份文件");return}
    let backup;
    try{backup=JSON.parse(await file.text())}catch{toast("这个文件不是有效的 JSON 备份");return}
    if(backup?.format!=="MS007-BUSINESS-BACKUP"||!backup?.data){toast("这不是 MS007 业务备份文件");return}
    if(!await uiConfirm("确认开始恢复这份备份？\n\n同 ID 数据会按备份内容覆盖。",{title:"恢复业务数据",confirmText:"开始恢复",danger:true}))return;

    const order=["users","fieldDefinitions","progressDefinitions","customers","customerValues","customerProgress","sidebarItems","listColumns","dashboardWidgets","systemSettings"];
    const total=order.reduce((n,k)=>n+(Array.isArray(backup.data[k])?backup.data[k].length:0),0);
    let done=0;const progress=document.querySelector("#restoreProgress");
    try{
      for(const section of order){
        const rows=Array.isArray(backup.data[section])?backup.data[section]:[];
        for(let i=0;i<rows.length;i+=100){
          const chunk=rows.slice(i,i+100);
          await api("/api/admin/import-chunk",{method:"POST",body:{format:"MS007-BUSINESS-BACKUP",section,rows:chunk}});
          done+=chunk.length;progress.textContent=`正在恢复：${done} / ${total} 条`;
        }
      }
      await api("/api/admin/import-finish",{method:"POST"});
      progress.textContent=`恢复完成：${done} 条数据`;toast("业务数据恢复完成");
      await refreshSidebar(true);
    }catch(e){progress.textContent=`恢复中断：${e.message}`;toast(e.message)}
  };
}

const DRAFT_PREFIX="ms007:draft:v1:";

function draftStorageKey(key){
  return DRAFT_PREFIX+(state.user?.id||"anonymous")+":"+key;
}

function draftControlKey(el,index){
  if(el.id)return "id:"+el.id;
  if(el.dataset?.field)return "field:"+el.dataset.field;
  if(el.name)return "name:"+el.name;
  return "index:"+index;
}

function draftEligible(el){
  const type=String(el.type||"").toLowerCase();
  if(["password","file","submit","button","reset"].includes(type))return false;
  if(el.disabled)return false;
  const marker=((el.id||"")+" "+(el.name||"")).toLowerCase();
  if(/password|passwd|secret|token|authorization|authcode/.test(marker))return false;
  return ["INPUT","SELECT","TEXTAREA"].includes(el.tagName);
}

function serializeOverlayDraft(root){
  const controls=[...root.querySelectorAll("input,select,textarea")].filter(draftEligible);
  return controls.map((el,index)=>({
    key:draftControlKey(el,index),
    tag:el.tagName,
    type:String(el.type||""),
    value:(el.type==="checkbox"||el.type==="radio")?undefined:el.value,
    checked:(el.type==="checkbox"||el.type==="radio")?!!el.checked:undefined
  }));
}

function findDraftControl(root,item,index){
  const controls=[...root.querySelectorAll("input,select,textarea")].filter(draftEligible);
  if(item.key?.startsWith("id:")){
    const id=item.key.slice(3);
    return controls.find(x=>x.id===id)||null;
  }
  if(item.key?.startsWith("field:")){
    const key=item.key.slice(6);
    return controls.find(x=>x.dataset?.field===key)||null;
  }
  if(item.key?.startsWith("name:")){
    const name=item.key.slice(5);
    return controls.find(x=>x.name===name)||null;
  }
  return controls[index]||null;
}

function restoreOverlayDraft(root,payload){
  const items=Array.isArray(payload?.controls)?payload.controls:[];
  items.forEach((item,index)=>{
    const el=findDraftControl(root,item,index);
    if(!el)return;
    if(el.type==="checkbox"||el.type==="radio")el.checked=!!item.checked;
    else if(item.value!==undefined)el.value=String(item.value);
    try{el.dispatchEvent(new Event("change",{bubbles:true}))}catch{}
  });
}

function saveOverlayDraft(root){
  const key=root.dataset.draftStorageKey;
  if(!key)return;
  try{
    localStorage.setItem(key,JSON.stringify({
      version:1,
      savedAt:new Date().toISOString(),
      controls:serializeOverlayDraft(root)
    }));
  }catch{}
}

function clearOverlayDraft(root){
  const key=root?.dataset?.draftStorageKey;
  if(!key)return;
  try{localStorage.removeItem(key)}catch{}
}

function setupOverlayDraft(root,title,opts={}){
  if(opts.draft===false)return;
  const logicalKey=opts.draftKey||((root.id==="drawer"?"drawer:":"modal:")+location.hash+":"+title);
  const storageKey=draftStorageKey(logicalKey);
  root.dataset.draftStorageKey=storageKey;
  root.dataset.dirty="0";

  let payload=null;
  try{
    const raw=localStorage.getItem(storageKey);
    if(raw)payload=JSON.parse(raw);
  }catch{}

  if(payload?.controls?.length){
    restoreOverlayDraft(root,payload);
    root.dataset.dirty="1";
    setTimeout(()=>toast("已恢复上次未保存的草稿"),80);
  }

  const onChange=e=>{
    if(!draftEligible(e.target))return;
    root.dataset.dirty="1";
    saveOverlayDraft(root);
  };
  root.addEventListener("input",onChange);
  root.addEventListener("change",onChange);
}

function hasUnsavedOverlay(root){
  return !!root && root.dataset.dirty==="1";
}

async function confirmCloseUnsaved(root){
  if(!hasUnsavedOverlay(root))return true;
  return uiConfirm(
    "当前内容还没有保存。\n\n关闭后不会丢失，系统已经自动保存为草稿，下次打开这个编辑面板会自动恢复。\n\n确定关闭吗？",
    {title:"未保存的内容",confirmText:"关闭并保留草稿",cancelText:"继续编辑"}
  );
}

let activeUiDialogResolve=null;

function closeUiDialog(result=false){
  document.querySelector("#uiDialog")?.remove();
  const resolve=activeUiDialogResolve;
  activeUiDialogResolve=null;
  if(resolve)resolve(!!result);
}

function uiConfirm(message,{title="确认操作",confirmText="确认",cancelText="取消",danger=false}={}){
  if(activeUiDialogResolve)closeUiDialog(false);
  return new Promise(resolve=>{
    activeUiDialogResolve=resolve;
    const el=document.createElement("div");
    el.id="uiDialog";
    el.className="ui-dialog-back";
    el.innerHTML=`
      <div class="ui-dialog-card" role="dialog" aria-modal="true" aria-labelledby="uiDialogTitle">
        <div class="ui-dialog-icon ${danger?"danger":""}">${danger?"!":"?"}</div>
        <div class="ui-dialog-content">
          <h3 id="uiDialogTitle">${esc(title)}</h3>
          <div class="ui-dialog-message">${esc(message)}</div>
          <div class="ui-dialog-actions">
            <button class="btn ghost" type="button" id="uiDialogCancel">${esc(cancelText)}</button>
            <button class="btn ${danger?"danger":""}" type="button" id="uiDialogConfirm">${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector("#uiDialogCancel").onclick=()=>closeUiDialog(false);
    el.querySelector("#uiDialogConfirm").onclick=()=>closeUiDialog(true);
    el.querySelector("#uiDialogCancel").focus();
  });
}

function removeDrawer({clearDraft=false}={}){
  const el=document.querySelector("#drawer");
  if(!el)return;
  if(clearDraft)clearOverlayDraft(el);
  el.remove();
}

function removeModal({clearDraft=false}={}){
  const el=document.querySelector("#modal");
  if(!el)return;
  if(clearDraft)clearOverlayDraft(el);
  el.remove();
}

function closeRowContextMenu(){
  document.querySelector("#rowContextMenu")?.remove();
}

function showInsertContextMenu(event,{label,before,after}){
  closeRowContextMenu();
  const menu=document.createElement("div");
  menu.id="rowContextMenu";
  menu.className="row-context-menu";
  menu.innerHTML=`
    <div class="row-context-title">${esc(label||"当前项目")}</div>
    <button type="button" data-insert-before>↑ 在上方插入一条</button>
    <button type="button" data-insert-after>↓ 在下方插入一条</button>`;
  document.body.appendChild(menu);

  const pad=8;
  const rect=menu.getBoundingClientRect();
  menu.style.left=Math.max(pad,Math.min(event.clientX,window.innerWidth-rect.width-pad))+"px";
  menu.style.top=Math.max(pad,Math.min(event.clientY,window.innerHeight-rect.height-pad))+"px";

  const cleanup=()=>closeRowContextMenu();
  menu.querySelector("[data-insert-before]").onclick=()=>{cleanup();before?.()};
  menu.querySelector("[data-insert-after]").onclick=()=>{cleanup();after?.()};

  setTimeout(()=>{
    document.addEventListener("click",cleanup,{once:true});
    window.addEventListener("scroll",cleanup,{once:true,capture:true});
  },0);
}

function openDrawer(title,body,onReady,opts={}){
  removeDrawer();
  const el=document.createElement("div");
  el.className="drawer-back";
  el.id="drawer";
  el.innerHTML=`<aside class="drawer-panel"><div class="drawer-head"><div><h2>${esc(title)}</h2></div><button class="btn ghost small" id="drawerClose">关闭</button></div><div class="drawer-body">${body}</div></aside>`;
  document.body.appendChild(el);
  document.querySelector("#drawerClose").onclick=requestCloseDrawer;
  onReady?.();
  setupOverlayDraft(el,title,opts);
}

async function requestCloseDrawer(){
  const el=document.querySelector("#drawer");
  if(!el)return;
  if(!await confirmCloseUnsaved(el))return;
  removeDrawer({clearDraft:false});
}

function closeDrawer(){
  removeDrawer({clearDraft:true});
}

function openModal(title,body,onReady,opts={}){
  removeModal();
  const el=document.createElement("div");
  el.className="modal-back";
  el.id="modal";
  el.innerHTML=`<div class="modal"><div class="page-head"><div><h1 style="font-size:20px">${esc(title)}</h1></div><button class="btn ghost small" id="mClose">关闭</button></div>${body}</div>`;
  document.body.appendChild(el);
  document.querySelector("#mClose").onclick=requestCloseModal;
  onReady?.();
  setupOverlayDraft(el,title,opts);
}

async function requestCloseModal(){
  const el=document.querySelector("#modal");
  if(!el)return;
  if(!await confirmCloseUnsaved(el))return;
  removeModal({clearDraft:false});
}

function closeModal(){
  removeModal({clearDraft:true});
}

function val(id){return document.querySelector("#"+id)?.value||""}
function checked(id){return !!document.querySelector("#"+id)?.checked}

document.addEventListener("keydown",async e=>{
  if(e.key!=="Escape")return;
  e.preventDefault();
  if(document.querySelector("#uiDialog")){
    closeUiDialog(false);
    return;
  }
  if(document.querySelector("#rowContextMenu")){
    closeRowContextMenu();
    return;
  }
  if(document.querySelector("#modal")){
    await requestCloseModal();
    return;
  }
  if(document.querySelector("#drawer")){
    await requestCloseDrawer();
  }
});

bootstrap();
