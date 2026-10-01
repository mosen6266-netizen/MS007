const enc = new TextEncoder();

const now = () => new Date().toISOString();
const uid = (prefix = "") => prefix + crypto.randomUUID();

function responseJson(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function fail(message, status = 400, code = "BAD_REQUEST") {
  return responseJson({ ok: false, code, message }, status);
}

function parseCookies(request) {
  const raw = request.headers.get("cookie") || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(s) {
  const raw = atob(s);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

async function derivePassword(password, saltB64, iterations = 100000) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations, hash: "SHA-256" },
    key,
    256
  );
  return bytesToHex(bits);
}

function newSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToB64(b);
}

function newSessionToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function authUser(request, env) {
  const cookies=parseCookies(request);
  const requestedRole=normalizedRole(request.headers.get("x-ms007-role"));
  const candidates=[];

  if(requestedRole){
    if(cookies["sid_"+requestedRole]) candidates.push(cookies["sid_"+requestedRole]);
    // Backward compatibility with sessions created before role-separated cookies.
    if(cookies.sid) candidates.push(cookies.sid);
  }else{
    if(cookies.sid_admin) candidates.push(cookies.sid_admin);
    if(cookies.sid_sales) candidates.push(cookies.sid_sales);
    if(cookies.sid) candidates.push(cookies.sid);
  }

  for(const sid of [...new Set(candidates.filter(Boolean))]){
    const tokenHash=await sha256Hex(sid);
    const row=await env.DB.prepare(
      `SELECT u.id,u.username,u.display_name,u.role,u.active,s.expires_at
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=? AND s.expires_at > ? AND u.active=1`
    ).bind(tokenHash,now()).first();
    if(!row)continue;
    row.role=normalizedRole(row.role);
    if(requestedRole && row.role!==requestedRole)continue;
    return row;
  }
  return null;
}

function normalizedRole(value) {
  const role=String(value||"").trim().toLowerCase();
  return role==="admin"?"admin":role==="sales"?"sales":"";
}

function requireRole(user, role) {
  return !!user && normalizedRole(user.role)===normalizedRole(role);
}

async function audit(env, user, action, entityType, entityId = null, detail = {}) {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)"
    ).bind(uid("a_"), user?.id || null, action, entityType, entityId, JSON.stringify(detail), now()).run();
  } catch {
    // Audit logging must never block the user's main action.
  }
}

function safeInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function encodeCursor(row) {
  return btoa(unescape(encodeURIComponent(JSON.stringify([row.updated_at, row.id]))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const s = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = s + "=".repeat((4 - s.length % 4) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch {
    return null;
  }
}

async function getSystemSetting(env, key, fallback = null) {
  const row = await env.DB.prepare("SELECT value_json FROM system_settings WHERE setting_key=?").bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}


function telegramHtmlEscape(v="") {
  return String(v).replace(/[&<>]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[ch]));
}

async function telegramCryptoKey(env) {
  if(!env.BOOTSTRAP_TOKEN) throw new Error("系统缺少加密密钥");
  const raw=await crypto.subtle.digest("SHA-256",enc.encode("MS007:telegram:"+env.BOOTSTRAP_TOKEN));
  return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}

async function telegramEncryptSecret(env,value) {
  const iv=new Uint8Array(12);crypto.getRandomValues(iv);
  const key=await telegramCryptoKey(env);
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,enc.encode(String(value||"")));
  return "v1."+bytesToB64(iv)+"."+bytesToB64(new Uint8Array(encrypted));
}

async function telegramDecryptSecret(env,value) {
  if(!value)return "";
  const parts=String(value).split(".");
  if(parts.length!==3||parts[0]!=="v1") throw new Error("Telegram Token 数据格式无效");
  const key=await telegramCryptoKey(env);
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64ToBytes(parts[1])},key,b64ToBytes(parts[2]));
  return new TextDecoder().decode(plain);
}

function defaultTelegramFields(){
  return [
    {key:"sales_name",label:"业务员"},
    {key:"customer_name",label:"客户姓名"},
    {key:"completed_progress",label:"已完成进度"},
    {key:"next_progress",label:"下一步进度"},
    {key:"progress_percent",label:"当前完成度"}
  ];
}

function defaultTelegramTemplate(){
  return "✅ 客户进度已更新\n\n业务员：{{业务员}}\n\n客户姓名：{{客户姓名}}\n\n已完成进度：{{已完成进度}}\n\n下一步进度：{{下一步进度}}\n\n当前完成度：{{当前完成度}}\n\n{{查看客户详情}}";
}

function telegramBuiltInTemplateVariables(){
  return [
    {token:"{{业务员}}",key:"sales_name",label:"业务员"},
    {token:"{{客户姓名}}",key:"customer_name",label:"客户姓名"},
    {token:"{{客户所属业务员}}",key:"assigned_sales",label:"客户所属业务员"},
    {token:"{{已完成进度}}",key:"completed_progress",label:"已完成进度"},
    {token:"{{当前进度}}",key:"current_progress",label:"当前进度"},
    {token:"{{下一步进度}}",key:"next_progress",label:"下一步进度"},
    {token:"{{当前完成度}}",key:"progress_percent",label:"当前完成度"},
    {token:"{{已完成步骤}}",key:"progress_fraction",label:"已完成步骤"},
    {token:"{{查看客户详情}}",key:"detail_link",label:"查看客户详情链接"}
  ];
}

async function telegramTemplateVariables(env){
  const fields=await env.DB.prepare(
    "SELECT id,label FROM field_definitions WHERE enabled=1 ORDER BY sort_order,label"
  ).all();
  return [
    ...telegramBuiltInTemplateVariables(),
    ...(fields.results||[]).map(x=>({
      token:"{{"+String(x.label||"登记字段")+"}}",
      key:"field:"+x.id,
      fieldId:x.id,
      label:String(x.label||"登记字段")
    }))
  ];
}

function replaceAllLiteral(source,needle,replacement){
  return String(source).split(String(needle)).join(String(replacement));
}

function renderTelegramTemplate(template,variables,detailUrl,linkLabel){
  let out=telegramHtmlEscape(String(template||defaultTelegramTemplate()));
  for(const item of variables||[]){
    if(!item?.token||item.key==="detail_link")continue;
    out=replaceAllLiteral(out,item.token,telegramHtmlEscape(String(item.value??"")));
  }
  const link='<a href="'+telegramHtmlEscape(detailUrl)+'">'+telegramHtmlEscape(linkLabel||"查看客户详情")+"</a>";
  out=replaceAllLiteral(out,"{{查看客户详情}}",link);
  return out;
}

async function telegramSettingsRow(env){
  let row=await env.DB.prepare("SELECT * FROM telegram_settings WHERE id=1").first();
  if(!row){
    await env.DB.prepare(
      `INSERT INTO telegram_settings(id,enabled,chat_id,bot_token_enc,bot_token_hint,fields_json,notify_admin,link_label,updated_at)
       VALUES(1,0,'','','',?,0,'查看客户详情',?)`
    ).bind(JSON.stringify(defaultTelegramFields()),now()).run();
    row=await env.DB.prepare("SELECT * FROM telegram_settings WHERE id=1").first();
  }
  return row;
}

async function telegramAvailableFields(env){
  const r=await env.DB.prepare(
    "SELECT id,label,field_key FROM field_definitions WHERE enabled=1 ORDER BY sort_order,label"
  ).all();
  return [
    {key:"sales_name",label:"业务员"},
    {key:"customer_name",label:"客户姓名"},
    {key:"assigned_sales",label:"客户所属业务员"},
    {key:"completed_progress",label:"已完成进度"},
    {key:"current_progress",label:"当前进度"},
    {key:"next_progress",label:"下一步进度"},
    {key:"progress_percent",label:"当前完成度"},
    {key:"progress_fraction",label:"已完成步骤"},
    ...(r.results||[]).map(x=>({key:"field:"+x.id,label:x.label,fieldId:x.id}))
  ];
}

async function telegramApiCall(token,method,payload){
  token=String(token||"").trim();
  if(!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Bot Token 格式不正确");
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),15000);
  try{
    const res=await fetch("https://api.telegram.org/bot"+token+"/"+method,{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify(payload||{}),
      signal:ctl.signal
    });
    const data=await res.json().catch(()=>({ok:false,description:"Telegram 返回了无法识别的内容"}));
    if(!res.ok||!data.ok){
      const err=new Error(data.description||("Telegram HTTP "+res.status));
      err.httpStatus=Number(res.status||0);
      err.telegramErrorCode=Number(data?.error_code||0);
      err.retryAfter=Math.max(0,Number(data?.parameters?.retry_after||0));
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function telegramValidateToken(token){
  const data=await telegramApiCall(token,"getMe",{});
  return data.result||{};
}

function telegramAfterSeconds(seconds){
  return new Date(Date.now()+Math.max(0,Number(seconds)||0)*1000).toISOString();
}

function telegramRetryableError(error){
  const status=Number(error?.httpStatus||0);
  return Number(error?.retryAfter||0)>0 ||
    status===429 ||
    status>=500 ||
    error?.name==="AbortError" ||
    status===0;
}

function telegramRetryDelaySeconds(error,attempts){
  const retryAfter=Math.max(0,Number(error?.retryAfter||0));
  if(retryAfter>0)return Math.max(5,retryAfter+1);
  const steps=[10,20,40,60,120,300,600,900];
  return steps[Math.min(Math.max(0,Number(attempts)||0),steps.length-1)];
}

async function enqueueTelegramMessage(env,{
  dedupeKey,customerId=null,actorUserId=null,progressId=null,chatId,messageText
}){
  const t=now();
  const id=uid("tgq_");
  const result=await env.DB.prepare(
    `INSERT OR IGNORE INTO telegram_send_queue(
      id,dedupe_key,customer_id,actor_user_id,progress_id,chat_id,message_text,
      status,attempts,next_attempt_at,locked_until,last_error,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,'pending',0,?,NULL,'',?,?)`
  ).bind(
    id,String(dedupeKey),customerId,actorUserId,progressId,String(chatId),String(messageText),
    t,t,t
  ).run();
  return {id,inserted:Number(result?.meta?.changes||0)>0};
}

async function acquireTelegramChatLease(env,chatId,seconds=4){
  const current=now();
  const nextAllowed=telegramAfterSeconds(seconds);
  const result=await env.DB.prepare(
    `INSERT INTO telegram_chat_rate(chat_id,next_allowed_at,updated_at)
     VALUES(?,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET
       next_allowed_at=excluded.next_allowed_at,
       updated_at=excluded.updated_at
     WHERE telegram_chat_rate.next_allowed_at<=?`
  ).bind(String(chatId),nextAllowed,current,current).run();
  return {acquired:Number(result?.meta?.changes||0)>0,nextAllowed};
}

async function extendTelegramChatLease(env,chatId,nextAllowedAt){
  const t=now();
  await env.DB.prepare(
    `INSERT INTO telegram_chat_rate(chat_id,next_allowed_at,updated_at)
     VALUES(?,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET
       next_allowed_at=CASE
         WHEN telegram_chat_rate.next_allowed_at<excluded.next_allowed_at THEN excluded.next_allowed_at
         ELSE telegram_chat_rate.next_allowed_at
       END,
       updated_at=excluded.updated_at`
  ).bind(String(chatId),String(nextAllowedAt),t).run();
}

async function telegramRecentActivity(env,limit=20){
  const r=await env.DB.prepare(
    `SELECT * FROM (
       SELECT
         l.id,l.status,l.error_text,l.created_at,
         NULL AS chat_id,NULL AS next_attempt_at,NULL AS attempts,
         c.name customer_name,u.display_name actor_name,p.label progress_name
       FROM telegram_delivery_logs l
       LEFT JOIN customers c ON c.id=l.customer_id
       LEFT JOIN users u ON u.id=l.actor_user_id
       LEFT JOIN progress_definitions p ON p.id=l.progress_id

       UNION ALL

       SELECT
         q.id,
         CASE WHEN q.status='retry' THEN 'retry' ELSE 'pending' END AS status,
         q.last_error AS error_text,
         q.created_at,
         q.chat_id,
         q.next_attempt_at,
         q.attempts,
         c.name customer_name,u.display_name actor_name,p.label progress_name
       FROM telegram_send_queue q
       LEFT JOIN customers c ON c.id=q.customer_id
       LEFT JOIN users u ON u.id=q.actor_user_id
       LEFT JOIN progress_definitions p ON p.id=q.progress_id
     ) activity
     ORDER BY activity.created_at DESC,activity.id DESC
     LIMIT ?`
  ).bind(Math.max(1,Math.min(100,Number(limit)||20))).all();
  return r.results||[];
}

async function processTelegramQueue(env,{maxItems=8,maxRunMs=12000,allowShortWait=false}={}){
  const started=Date.now();
  let processed=0;

  const settings=await telegramSettingsRow(env);
  if(!settings?.bot_token_enc)return {processed,reason:"token_missing"};
  const notificationsEnabled=!!settings?.enabled;

  let token="";
  try{
    token=await telegramDecryptSecret(env,settings.bot_token_enc);
  }catch(e){
    const retryAt=telegramAfterSeconds(300);
    await env.DB.prepare(
      `UPDATE telegram_send_queue
       SET status='retry',next_attempt_at=?,locked_until=NULL,last_error=?,updated_at=?
       WHERE status IN ('pending','retry','sending')`
    ).bind(retryAt,"Token 无法解密，等待管理员重新保存 Token",now()).run();
    return {processed,reason:"token"};
  }

  while(processed<maxItems && Date.now()-started<maxRunMs){
    const current=now();
    const task=await env.DB.prepare(
      `SELECT * FROM telegram_send_queue
       WHERE (
         (status IN ('pending','retry') AND next_attempt_at<=?)
         OR
         (status='sending' AND locked_until IS NOT NULL AND locked_until<=?)
       )
       ORDER BY next_attempt_at,created_at,id
       LIMIT 1`
    ).bind(current,current).first();

    if(!task){
      if(allowShortWait){
        const nextRow=await env.DB.prepare(
          `SELECT MIN(next_attempt_at) next_at
           FROM telegram_send_queue
           WHERE status IN ('pending','retry')`
        ).first();
        const nextMs=Date.parse(String(nextRow?.next_at||""));
        const waitMs=Number.isFinite(nextMs)?nextMs-Date.now():0;
        if(waitMs>0 && waitMs<=4500 && Date.now()-started+waitMs+250<maxRunMs){
          await new Promise(resolve=>setTimeout(resolve,waitMs+150));
          continue;
        }
      }
      break;
    }

    if(task.progress_id && !notificationsEnabled){
      await env.DB.prepare(
        `UPDATE telegram_send_queue
         SET status='retry',next_attempt_at=?,locked_until=NULL,last_error=?,updated_at=?
         WHERE id=?`
      ).bind(
        telegramAfterSeconds(300),
        "Telegram 自动通知当前已关闭，消息保留在队列中，重新启用后会继续发送",
        now(),
        task.id
      ).run();
      continue;
    }

    const lockUntil=telegramAfterSeconds(75);
    const claim=await env.DB.prepare(
      `UPDATE telegram_send_queue
       SET status='sending',locked_until=?,updated_at=?
       WHERE id=? AND (
         (status IN ('pending','retry') AND next_attempt_at<=?)
         OR
         (status='sending' AND locked_until IS NOT NULL AND locked_until<=?)
       )`
    ).bind(lockUntil,current,task.id,current,current).run();
    if(Number(claim?.meta?.changes||0)!==1)continue;

    const globalLease=await acquireTelegramChatLease(env,"__bot_global__",1);
    if(!globalLease.acquired){
      const rate=await env.DB.prepare(
        "SELECT next_allowed_at FROM telegram_chat_rate WHERE chat_id='__bot_global__'"
      ).first();
      const retryAt=String(rate?.next_allowed_at||telegramAfterSeconds(1));
      await env.DB.prepare(
        `UPDATE telegram_send_queue
         SET status='retry',next_attempt_at=?,locked_until=NULL,last_error=?,updated_at=?
         WHERE id=?`
      ).bind(retryAt,"Telegram 全局发送正在安全限速，系统会自动发送",now(),task.id).run();
      continue;
    }

    const lease=await acquireTelegramChatLease(env,task.chat_id,4);
    if(!lease.acquired){
      const rate=await env.DB.prepare(
        "SELECT next_allowed_at FROM telegram_chat_rate WHERE chat_id=?"
      ).bind(task.chat_id).first();
      const retryAt=String(rate?.next_allowed_at||telegramAfterSeconds(4));
      await env.DB.prepare(
        `UPDATE telegram_send_queue
         SET status='retry',next_attempt_at=?,locked_until=NULL,last_error=?,updated_at=?
         WHERE id=?`
      ).bind(retryAt,"同一群组正在安全限速排队，系统会自动发送",now(),task.id).run();
      continue;
    }

    try{
      await telegramApiCall(token,"sendMessage",{
        chat_id:task.chat_id,
        text:task.message_text,
        parse_mode:"HTML",
        disable_web_page_preview:true
      });
      await logTelegramDelivery(env,{
        customerId:task.customer_id,
        actorUserId:task.actor_user_id,
        progressId:task.progress_id,
        status:"success",
        error:"群 "+task.chat_id
      });
      await env.DB.prepare("DELETE FROM telegram_send_queue WHERE id=?").bind(task.id).run();
      processed++;
    }catch(e){
      const attempts=Number(task.attempts||0)+1;
      if(telegramRetryableError(e)){
        const delaySeconds=telegramRetryDelaySeconds(e,attempts-1);
        const retryAt=telegramAfterSeconds(delaySeconds);
        const reason=Number(e?.retryAfter||0)>0
          ?("Telegram 限流，已自动等待 "+delaySeconds+" 秒后重试")
          :("发送暂时失败，系统将在 "+delaySeconds+" 秒后自动重试："+String(e?.message||e));
        await extendTelegramChatLease(env,task.chat_id,retryAt);
        await env.DB.prepare(
          `UPDATE telegram_send_queue
           SET status='retry',attempts=?,next_attempt_at=?,locked_until=NULL,last_error=?,updated_at=?
           WHERE id=?`
        ).bind(attempts,retryAt,String(reason).slice(0,1000),now(),task.id).run();
      }else{
        await logTelegramDelivery(env,{
          customerId:task.customer_id,
          actorUserId:task.actor_user_id,
          progressId:task.progress_id,
          status:"failed",
          error:"群 "+task.chat_id+"："+String(e?.message||e)
        });
        await env.DB.prepare("DELETE FROM telegram_send_queue WHERE id=?").bind(task.id).run();
      }
      processed++;
    }
  }

  return {processed};
}

async function telegramAdminGet(env){
  const row=await telegramSettingsRow(env);
  let fields=defaultTelegramFields();
  try{
    const parsed=JSON.parse(row.fields_json||"[]");
    if(Array.isArray(parsed))fields=parsed;
  }catch{}
  const [availableFields,logs,progressDefs,routes,templateVariables]=await Promise.all([
    telegramAvailableFields(env),
    telegramRecentActivity(env,20).then(results=>({results})),
    env.DB.prepare(
      "SELECT id,label,sort_order FROM progress_definitions WHERE enabled=1 ORDER BY sort_order,label"
    ).all(),
    env.DB.prepare(
      "SELECT progress_id,route_mode,chat_id FROM telegram_progress_routes"
    ).all(),
    telegramTemplateVariables(env)
  ]);
  const messageTemplate=await getSystemSetting(env,"telegram_message_template",defaultTelegramTemplate());
  return responseJson({
    ok:true,
    settings:{
      enabled:!!row.enabled,
      chatId:row.chat_id||"",
      hasToken:!!row.bot_token_enc,
      tokenHint:row.bot_token_hint||"",
      fields,
      notifyAdmin:!!row.notify_admin,
      linkLabel:row.link_label||"查看客户详情",
      messageTemplate:String(messageTemplate||defaultTelegramTemplate())
    },
    availableFields,
    templateVariables,
    progressDefs:progressDefs.results||[],
    routes:routes.results||[],
    logs:logs.results||[]
  });
}

async function telegramLogs(request,env){
  const url=new URL(request.url);
  const page=safeInt(url.searchParams.get("page"),1,1,1000000);
  const limit=safeInt(url.searchParams.get("limit"),50,1,100);
  const status=String(url.searchParams.get("status")||"").trim();
  const allowedStatus=new Set(["pending","retry","success","failed","skipped"]);
  const statusFilter=allowedStatus.has(status)?status:"";

  const baseSql=`
    SELECT
      l.id,l.status,l.error_text,l.created_at,
      NULL AS chat_id,NULL AS next_attempt_at,NULL AS attempts,
      c.name customer_name,u.display_name actor_name,p.label progress_name
    FROM telegram_delivery_logs l
    LEFT JOIN customers c ON c.id=l.customer_id
    LEFT JOIN users u ON u.id=l.actor_user_id
    LEFT JOIN progress_definitions p ON p.id=l.progress_id

    UNION ALL

    SELECT
      q.id,
      CASE WHEN q.status='retry' THEN 'retry' ELSE 'pending' END AS status,
      q.last_error AS error_text,
      q.created_at,
      q.chat_id,
      q.next_attempt_at,
      q.attempts,
      c.name customer_name,u.display_name actor_name,p.label progress_name
    FROM telegram_send_queue q
    LEFT JOIN customers c ON c.id=q.customer_id
    LEFT JOIN users u ON u.id=q.actor_user_id
    LEFT JOIN progress_definitions p ON p.id=q.progress_id
  `;
  const whereSql=statusFilter?"WHERE activity.status=?":"";
  const binds=statusFilter?[statusFilter]:[];

  const totalRow=await env.DB.prepare(
    `SELECT COUNT(*) n FROM (${baseSql}) activity ${whereSql}`
  ).bind(...binds).first();
  const total=Number(totalRow?.n||0);
  const pages=Math.max(1,Math.ceil(total/limit));
  const offset=(page-1)*limit;

  const r=await env.DB.prepare(
    `SELECT * FROM (${baseSql}) activity
     ${whereSql}
     ORDER BY activity.created_at DESC,activity.id DESC
     LIMIT ? OFFSET ?`
  ).bind(...binds,limit,offset).all();

  return responseJson({ok:true,items:r.results||[],page,limit,total,pages,status:statusFilter});
}
async function telegramAdminSave(request,env,user){
  const b=await readBody(request);
  const old=await telegramSettingsRow(env);
  let encToken=old.bot_token_enc||"";
  let hint=old.bot_token_hint||"";
  const newToken=String(b.botToken||"").trim();

  if(newToken){
    const me=await telegramValidateToken(newToken);
    encToken=await telegramEncryptSecret(env,newToken);
    const username=String(me.username||"");
    hint=username?("@"+username):("…"+newToken.slice(-6));
  }

  const chatId=String(b.chatId!==undefined?b.chatId:old.chat_id||"").trim();
  const enabled=b.enabled!==undefined?!!b.enabled:!!old.enabled;
  const notifyAdmin=b.notifyAdmin!==undefined?!!b.notifyAdmin:!!old.notify_admin;
  const linkLabel=String(b.linkLabel||old.link_label||"查看客户详情").trim().slice(0,80)||"查看客户详情";
  let messageTemplate=b.messageTemplate!==undefined?String(b.messageTemplate):await getSystemSetting(env,"telegram_message_template",defaultTelegramTemplate());
  messageTemplate=messageTemplate.replace(/\r\n/g,"\n").slice(0,6000);
  if(!messageTemplate.trim())messageTemplate=defaultTelegramTemplate();

  const available=await telegramAvailableFields(env);
  const allowed=new Set(available.map(x=>x.key));
  const fieldLabel=new Map(available.map(x=>[x.key,x.label]));
  const input=Array.isArray(b.fields)?b.fields:[];
  const fields=[];
  const seen=new Set();
  for(const item of input.slice(0,40)){
    const key=String(item?.key||"");
    if(!allowed.has(key)||seen.has(key))continue;
    seen.add(key);
    fields.push({key,label:String(item?.label||fieldLabel.get(key)||key).trim().slice(0,80)});
  }
  if(enabled && !encToken)return fail("请先填写 Telegram Bot Token");
  if(enabled && !chatId)return fail("请先填写默认 Telegram 群 ID");

  const progressResult=await env.DB.prepare(
    "SELECT id FROM progress_definitions WHERE enabled=1"
  ).all();
  const validProgressIds=new Set((progressResult.results||[]).map(x=>x.id));
  const routeInput=Array.isArray(b.routes)?b.routes:[];
  const routes=[];
  const seenRouteProgress=new Set();
  for(const item of routeInput.slice(0,200)){
    const progressId=String(item?.progressId||"").trim();
    const mode=["replace","additional"].includes(item?.mode)?item.mode:"";
    const routeChatId=String(item?.chatId||"").trim();
    if(!progressId||!validProgressIds.has(progressId)||!mode||!routeChatId||seenRouteProgress.has(progressId))continue;
    seenRouteProgress.add(progressId);
    routes.push({progressId,mode,chatId:routeChatId});
  }

  const t=now();
  const stmts=[
    env.DB.prepare(
      `UPDATE telegram_settings
       SET enabled=?,chat_id=?,bot_token_enc=?,bot_token_hint=?,fields_json=?,notify_admin=?,link_label=?,updated_at=?
       WHERE id=1`
    ).bind(enabled?1:0,chatId,encToken,hint,JSON.stringify(fields),notifyAdmin?1:0,linkLabel,t),
    env.DB.prepare("DELETE FROM telegram_progress_routes"),
    env.DB.prepare(
      `INSERT INTO system_settings(setting_key,value_json,updated_at) VALUES('telegram_message_template',?,?)
       ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`
    ).bind(JSON.stringify(messageTemplate),t)
  ];
  for(const route of routes){
    stmts.push(
      env.DB.prepare(
        "INSERT INTO telegram_progress_routes(progress_id,route_mode,chat_id,updated_at) VALUES(?,?,?,?)"
      ).bind(route.progressId,route.mode,route.chatId,t)
    );
  }
  await env.DB.batch(stmts);

  await audit(env,user,"update","telegram_settings","1",{
    enabled,chatId,hasToken:!!encToken,fieldCount:fields.length,notifyAdmin,routeCount:routes.length,templateLength:messageTemplate.length
  });
  return responseJson({ok:true,tokenHint:hint,hasToken:!!encToken,routeCount:routes.length});
}

async function telegramAdminTest(request,env,user){
  const row=await telegramSettingsRow(env);
  if(!row.bot_token_enc)return fail("请先保存 Telegram Bot Token");
  if(!row.chat_id)return fail("请先填写 Telegram 群 ID");

  const origin=new URL(request.url).origin;
  const template=await getSystemSetting(env,"telegram_message_template",defaultTelegramTemplate());
  const templateVariables=await telegramTemplateVariables(env);
  const sampleValues={
    sales_name:"测试业务员",
    customer_name:"测试客户",
    assigned_sales:"测试业务员",
    completed_progress:"客户建档",
    current_progress:"客户建档",
    next_progress:"已联系",
    progress_percent:"20%",
    progress_fraction:"1/5"
  };
  const renderedVariables=templateVariables.map(v=>({
    ...v,
    value:v.key.startsWith("field:")?"示例内容":sampleValues[v.key]||""
  }));
  const text=renderTelegramTemplate(
    template,
    renderedVariables,
    origin+"/#/customer/test",
    row.link_label||"查看客户详情"
  );

  await enqueueTelegramMessage(env,{
    dedupeKey:"test:"+uid("evt_"),
    actorUserId:user.id,
    chatId:row.chat_id,
    messageText:text
  });
  await audit(env,user,"test","telegram_settings","1",{chatId:row.chat_id,template:true,queued:true});
  await processTelegramQueue(env,{maxItems:2,maxRunMs:2500,allowShortWait:false}).catch(()=>{});
  return responseJson({ok:true,message:"模板测试消息已加入可靠发送队列"});
}
async function telegramProgressStatus(env,customerId){
  const defsResult=await env.DB.prepare(
    "SELECT id,label,color,sort_order FROM progress_definitions WHERE enabled=1 ORDER BY sort_order,label"
  ).all();
  const doneResult=await env.DB.prepare(
    "SELECT progress_id FROM customer_progress WHERE customer_id=? AND completed=1"
  ).bind(customerId).all();
  const done=new Set((doneResult.results||[]).map(x=>x.progress_id));
  let current=null,next=null;
  for(const p of defsResult.results||[]){
    if(done.has(p.id))current=p;
    else if(!next)next=p;
  }
  return {current,next,total:(defsResult.results||[]).length,done:done.size};
}

async function logTelegramDelivery(env,{customerId,actorUserId,progressId,status,error=""}){
  try{
    await env.DB.prepare(
      "INSERT INTO telegram_delivery_logs(id,customer_id,actor_user_id,progress_id,status,error_text,created_at) VALUES(?,?,?,?,?,?,?)"
    ).bind(uid("tg_"),customerId||null,actorUserId||null,progressId||null,status,String(error||"").slice(0,1000),now()).run();
  }catch{}
}

async function sendTelegramProgressNotification(request,env,user,customerId,progressDef,summary,eventId=""){
  const row=await telegramSettingsRow(env);
  if(!row.enabled)return;
  if(normalizedRole(user.role)==="admin"&&!row.notify_admin)return;
  if(!row.bot_token_enc){
    await logTelegramDelivery(env,{customerId,actorUserId:user.id,progressId:progressDef.id,status:"skipped",error:"Telegram Bot Token 未设置"});
    return;
  }

  const route=await env.DB.prepare(
    "SELECT route_mode,chat_id FROM telegram_progress_routes WHERE progress_id=?"
  ).bind(progressDef.id).first();

  let targetChatIds=[];
  if(route?.route_mode==="replace"){
    if(route.chat_id)targetChatIds=[String(route.chat_id)];
  }else if(route?.route_mode==="additional"){
    if(row.chat_id)targetChatIds.push(String(row.chat_id));
    if(route.chat_id)targetChatIds.push(String(route.chat_id));
  }else if(row.chat_id){
    targetChatIds=[String(row.chat_id)];
  }
  targetChatIds=[...new Set(targetChatIds.filter(Boolean))];

  if(!targetChatIds.length){
    await logTelegramDelivery(env,{customerId,actorUserId:user.id,progressId:progressDef.id,status:"skipped",error:"这个进度没有可用的通知群"});
    return;
  }

  const customer=await env.DB.prepare(
    `SELECT c.id,c.name,c.assigned_user_id,u.display_name owner_name
     FROM customers c LEFT JOIN users u ON u.id=c.assigned_user_id
     WHERE c.id=?`
  ).bind(customerId).first();
  if(!customer)return;

  const status=await telegramProgressStatus(env,customerId);
  const template=await getSystemSetting(env,"telegram_message_template",defaultTelegramTemplate());
  const templateVariables=await telegramTemplateVariables(env);

  const customIds=[...new Set(templateVariables.filter(x=>String(x.key||"").startsWith("field:")).map(x=>String(x.key).slice(6)).filter(Boolean))];
  const customValues={};
  if(customIds.length){
    const marks=customIds.map(()=>"?").join(",");
    const vals=await env.DB.prepare(
      `SELECT field_id,value FROM customer_values WHERE customer_id=? AND field_id IN (${marks})`
    ).bind(customerId,...customIds).all();
    for(const v of vals.results||[])customValues[v.field_id]=v.value||"";
  }

  const values={
    sales_name:user.display_name||user.username||"",
    customer_name:customer.name||"",
    assigned_sales:customer.owner_name||"未分配",
    completed_progress:progressDef.label||"",
    current_progress:status.current?.label||"未开始",
    next_progress:status.next?.label||"已全部完成",
    progress_percent:String(summary.percent||0)+"%",
    progress_fraction:String(summary.done||0)+"/"+String(summary.total||0)
  };

  const renderedVariables=templateVariables.map(v=>({
    ...v,
    value:String(v.key||"").startsWith("field:")
      ?(customValues[String(v.key).slice(6)]||"")
      :(values[v.key]??"")
  }));

  const origin=new URL(request.url).origin;
  const detailUrl=origin+"/#/customer/"+encodeURIComponent(customerId);
  const messageText=renderTelegramTemplate(
    template,
    renderedVariables,
    detailUrl,
    row.link_label||"查看客户详情"
  );

  const eventKey=String(eventId||now());
  for(const targetChatId of targetChatIds){
    await enqueueTelegramMessage(env,{
      dedupeKey:[customerId,progressDef.id,eventKey,targetChatId].join(":"),
      customerId,
      actorUserId:user.id,
      progressId:progressDef.id,
      chatId:targetChatId,
      messageText
    });
  }

  // Try to deliver immediately. Per-chat leases prevent concurrent Worker
  // requests from exceeding the safe pace; cron continues anything left queued.
  await processTelegramQueue(env,{maxItems:4,maxRunMs:2500,allowShortWait:false});
}
async function bumpVersion(env, key) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO system_settings(setting_key,value_json,updated_at) VALUES(?,?,?)
     ON CONFLICT(setting_key) DO UPDATE SET value_json=CAST(CAST(value_json AS INTEGER)+1 AS TEXT), updated_at=excluded.updated_at`
  ).bind(key, "1", t).run();
}

async function recalcProgress(env, customerId) {
  const totals = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM progress_definitions WHERE enabled=1) AS total,
      (SELECT COUNT(*) FROM customer_progress cp
       JOIN progress_definitions pd ON pd.id=cp.progress_id
       WHERE cp.customer_id=? AND cp.completed=1 AND pd.enabled=1) AS done`
  ).bind(customerId).first();
  const total = Number(totals?.total || 0);
  const done = Number(totals?.done || 0);
  const percent = total > 0 ? Math.round(done * 100 / total) : 0;
  await env.DB.prepare(
    "UPDATE customers SET progress_done=?,progress_total=?,progress_percent=?,updated_at=?,edit_version=edit_version+1 WHERE id=?"
  ).bind(done, total, percent, now(), customerId).run();
  return { done, total, percent };
}

async function recalcAllProgress(env) {
  const totalRow = await env.DB.prepare("SELECT COUNT(*) n FROM progress_definitions WHERE enabled=1").first();
  const total = Number(totalRow?.n || 0);
  await env.DB.prepare(
    `UPDATE customers
     SET progress_total=?,
         progress_done=(SELECT COUNT(*) FROM customer_progress cp JOIN progress_definitions pd ON pd.id=cp.progress_id WHERE cp.customer_id=customers.id AND cp.completed=1 AND pd.enabled=1),
         progress_percent=CASE WHEN ?=0 THEN 0 ELSE ROUND(
           (SELECT COUNT(*) FROM customer_progress cp JOIN progress_definitions pd ON pd.id=cp.progress_id WHERE cp.customer_id=customers.id AND cp.completed=1 AND pd.enabled=1) * 100.0 / ?
         ) END,
         updated_at=updated_at
     WHERE deleted_at IS NULL`
  ).bind(total,total,total).run();
}

async function bootstrapStatus(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  return Number(row?.n || 0) === 0;
}

async function bootstrapDiagnostic(request, env) {
  const token = request.headers.get("x-bootstrap-token") || "";
  if (!env.BOOTSTRAP_TOKEN || token !== env.BOOTSTRAP_TOKEN) {
    return fail("初始化授权无效", 403, "BOOTSTRAP_FORBIDDEN");
  }

  let step = "start";
  let testUserId = null;
  let testUsername = null;
  try {
    step = "bootstrap_status";
    const empty = await bootstrapStatus(env);
    if (!empty) return responseJson({ ok:true, skipped:true, reason:"already_initialized" });

    step = "password_hash";
    const salt = newSalt();
    const iterations = 100000;
    const hash = await derivePassword("MS007-diagnostic-password", salt, iterations);

    step = "insert_test_user";
    testUserId = uid("diag_");
    testUsername = "diag_" + crypto.randomUUID().replace(/-/g,"").slice(0,16);
    const t = now();
    await env.DB.prepare(
      `INSERT INTO users(id,username,display_name,password_hash,password_salt,password_iterations,role,active,created_at,updated_at)
       VALUES(?,?,?,?,?,?,'admin',0,?,?)`
    ).bind(testUserId, testUsername, "Diagnostic", hash, salt, iterations, t, t).run();

    step = "insert_audit";
    const auditId = uid("diag_a_");
    await env.DB.prepare(
      "INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)"
    ).bind(auditId, testUserId, "diagnostic", "user", testUserId, "{}", now()).run();

    step = "cleanup_audit";
    await env.DB.prepare("DELETE FROM audit_logs WHERE id=?").bind(auditId).run();

    step = "cleanup_user";
    await env.DB.prepare("DELETE FROM users WHERE id=?").bind(testUserId).run();

    return responseJson({ ok:true, diagnostic:true });
  } catch (e) {
    try {
      if (testUserId) {
        await env.DB.prepare("DELETE FROM audit_logs WHERE actor_user_id=? OR entity_id=?").bind(testUserId,testUserId).run();
        await env.DB.prepare("DELETE FROM users WHERE id=?").bind(testUserId).run();
      }
    } catch {}
    return responseJson({
      ok:false,
      diagnostic:true,
      step,
      errorName:String(e?.name||"Error"),
      errorMessage:String(e?.message||e)
    },500);
  }
}

async function handleBootstrap(request, env) {
  const empty = await bootstrapStatus(env);
  if (!empty) return fail("系统已经初始化", 409, "ALREADY_INITIALIZED");
  const token = request.headers.get("x-bootstrap-token") || "";
  if (!env.BOOTSTRAP_TOKEN || token !== env.BOOTSTRAP_TOKEN) {
    return fail("初始化授权无效", 403, "BOOTSTRAP_FORBIDDEN");
  }
  const body = await readBody(request);
  const username = String(body.username || "").trim();
  const displayName = String(body.displayName || "管理员").trim();
  const password = String(body.password || "");
  if (username.length < 3 || password.length < 8) {
    return fail("管理员账号至少3位，密码至少8位");
  }
  const salt = newSalt();
  const iterations = 100000;
  const hash = await derivePassword(password, salt, iterations);
  const id = uid("u_");
  const t = now();
  await env.DB.prepare(
    `INSERT INTO users(id,username,display_name,password_hash,password_salt,password_iterations,role,active,created_at,updated_at)
     VALUES(?,?,?,?,?,?,'admin',1,?,?)`
  ).bind(id, username, displayName, hash, salt, iterations, t, t).run();
  await audit(env, { id }, "bootstrap_admin", "user", id, { username });
  return responseJson({ ok: true });
}

async function handleLogin(request, env) {
  const body = await readBody(request);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const wantedRole = normalizedRole(body.role) || null;
  const u = await env.DB.prepare(
    "SELECT * FROM users WHERE username=? AND active=1"
  ).bind(username).first();
  if (!u) return fail("账号或密码不正确", 401, "LOGIN_FAILED");
  const hash = await derivePassword(password, u.password_salt, Number(u.password_iterations || 100000));
  if (hash !== u.password_hash) return fail("账号或密码不正确", 401, "LOGIN_FAILED");
  const actualRole=normalizedRole(u.role);
  if (wantedRole && actualRole !== wantedRole) return fail("该账号没有这个入口的权限", 403, "WRONG_ROLE");

  const rawToken = newSessionToken();
  const tokenHash = await sha256Hex(rawToken);
  const days = safeInt(env.SESSION_DAYS || "7", 7, 1, 30);
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)"
  ).bind(tokenHash, u.id, expires, now()).run();
  await audit(env, u, "login", "session", null, {});
  const cookieName=actualRole==="admin"?"sid_admin":"sid_sales";
  const cookie = `${cookieName}=${encodeURIComponent(rawToken)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${days * 86400}`;
  return responseJson({
    ok: true,
    user: { id: u.id, username: u.username, displayName: u.display_name, role: actualRole }
  }, 200, { "set-cookie": cookie });
}

async function handleLogout(request, env, user) {
  const cookies=parseCookies(request);
  const role=normalizedRole(user?.role);
  const cookieName=role==="admin"?"sid_admin":"sid_sales";
  const sid=cookies[cookieName]||cookies.sid;
  if(sid){
    const hash=await sha256Hex(sid);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(hash).run();
  }
  await audit(env,user,"logout","session",null,{});
  return responseJson({ok:true},200,{
    "set-cookie":cookieName+"=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
  });
}

async function listCustomers(request, env, user) {
  const url = new URL(request.url);
  const limit = safeInt(url.searchParams.get("limit"), 50, 1, 100);
  const q = String(url.searchParams.get("q") || "").trim();
  const archived = url.searchParams.get("archived") === "1" ? 1 : 0;
  const owner = String(url.searchParams.get("owner") || "").trim();
  const cursor = decodeCursor(url.searchParams.get("cursor"));

  const where = ["c.deleted_at IS NULL", "c.archived=?"];
  const binds = [archived];

  if (normalizedRole(user.role) === "sales") {
    where.push("c.assigned_user_id=?");
    binds.push(user.id);
  } else if (owner) {
    where.push("c.assigned_user_id=?");
    binds.push(owner);
  }

  if (q) {
    where.push(`(c.name LIKE ? OR EXISTS(
      SELECT 1 FROM customer_values cv
      JOIN field_definitions fd ON fd.id=cv.field_id
      WHERE cv.customer_id=c.id AND fd.searchable=1 AND cv.value LIKE ?
    ))`);
    binds.push("%" + q + "%", "%" + q + "%");
  }

  if (cursor && Array.isArray(cursor) && cursor.length === 2) {
    where.push("(c.updated_at < ? OR (c.updated_at=? AND c.id < ?))");
    binds.push(cursor[0], cursor[0], cursor[1]);
  }

  const sql = `SELECT c.id,c.name,c.assigned_user_id,c.progress_done,c.progress_total,c.progress_percent,
    c.archived,c.created_at,c.updated_at,u.display_name AS owner_name
    FROM customers c
    LEFT JOIN users u ON u.id=c.assigned_user_id
    WHERE ${where.join(" AND ")}
    ORDER BY c.updated_at DESC,c.id DESC LIMIT ?`;
  binds.push(limit + 1);
  const result = await env.DB.prepare(sql).bind(...binds).all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const visible = await env.DB.prepare(
    `SELECT fd.id,fd.field_key,lc.label
     FROM list_columns lc
     JOIN field_definitions fd ON fd.id=lc.field_id
     WHERE lc.audience=? AND lc.enabled=1 AND lc.column_key='dynamic' AND fd.enabled=1
     ORDER BY lc.sort_order,fd.sort_order`
  ).bind(user.role).all();
  const visibleFields = visible.results || [];
  const ids = page.map(x => x.id);
  const valuesByCustomer = {};
  if (ids.length && visibleFields.length) {
    const idMarks = ids.map(() => "?").join(",");
    const fieldIds = visibleFields.map(f => f.id);
    const fieldMarks = fieldIds.map(() => "?").join(",");
    const vals = await env.DB.prepare(
      `SELECT customer_id,field_id,value FROM customer_values
       WHERE customer_id IN (${idMarks}) AND field_id IN (${fieldMarks})`
    ).bind(...ids, ...fieldIds).all();
    for (const v of vals.results || []) {
      (valuesByCustomer[v.customer_id] ||= {})[v.field_id] = v.value;
    }
  }

  // Resolve current + next progress for the whole page in two compact queries.
  // This avoids one database request per customer when the list grows large.
  const progressDefsResult = await env.DB.prepare(
    "SELECT id,label,sort_order,color FROM progress_definitions WHERE enabled=1 ORDER BY sort_order,label"
  ).all();
  const progressDefs = progressDefsResult.results || [];
  const completedByCustomer = {};
  if (ids.length && progressDefs.length) {
    const idMarks = ids.map(() => "?").join(",");
    const done = await env.DB.prepare(
      `SELECT customer_id,progress_id FROM customer_progress
       WHERE completed=1 AND customer_id IN (${idMarks})`
    ).bind(...ids).all();
    for (const x of done.results || []) {
      (completedByCustomer[x.customer_id] ||= new Set()).add(x.progress_id);
    }
  }

  const items = page.map(r => {
    const completed = completedByCustomer[r.id] || new Set();
    let currentProgress = null;
    let nextProgress = null;
    for (const p of progressDefs) {
      if (completed.has(p.id)) currentProgress = {id:p.id,label:p.label,color:p.color};
      else if (!nextProgress) nextProgress = {id:p.id,label:p.label,color:p.color};
    }
    return {
      id: r.id,
      name: r.name,
      ownerId: r.assigned_user_id,
      ownerName: r.owner_name || "",
      progressDone: Number(r.progress_done || 0),
      progressTotal: Number(r.progress_total || 0),
      progressPercent: Number(r.progress_percent || 0),
      currentProgress: currentProgress || {id:null,label:"未开始",color:"#94a3b8"},
      nextProgress: nextProgress || {id:null,label:progressDefs.length?"已全部完成":"暂无进度",color:"#22c55e"},
      archived: !!r.archived,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      values: valuesByCustomer[r.id] || {}
    };
  });

  return responseJson({
    ok: true,
    items,
    visibleFields,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null
  });
}

function validateCustomerName(value){
  const name=String(value??"").trim();
  if(!name)return {ok:false,message:"请输入客户姓名"};
  if(name.length>300)return {ok:false,message:"客户姓名不能超过 300 个字符"};
  return {ok:true,value:name};
}

function validateFieldValue(field,raw){
  const value=String(raw??"");
  const trimmed=value.trim();
  const type=String(field.field_type||"text");

  if(field.required && !trimmed)return {ok:false,message:"「"+field.label+"」为必填项"};

  const max=type==="textarea"?50000:10000;
  if(value.length>max)return {ok:false,message:"「"+field.label+"」内容过长"};

  if(trimmed){
    if(type==="email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)){
      return {ok:false,message:"「"+field.label+"」邮箱格式不正确"};
    }
    if(type==="number" && !Number.isFinite(Number(trimmed))){
      return {ok:false,message:"「"+field.label+"」必须填写有效数字"};
    }
    if(type==="date" && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)){
      return {ok:false,message:"「"+field.label+"」日期格式不正确"};
    }
    if(type==="time" && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(trimmed)){
      return {ok:false,message:"「"+field.label+"」时间格式不正确"};
    }
    if(type==="url"){
      try{
        const u=new URL(trimmed);
        if(!["http:","https:"].includes(u.protocol))throw new Error("protocol");
      }catch{
        return {ok:false,message:"「"+field.label+"」网址格式不正确"};
      }
    }
    if(type==="select"||type==="single"){
      let options=[];
      try{
        const parsed=JSON.parse(field.options_json||"[]");
        if(Array.isArray(parsed))options=parsed.map(x=>String(x));
      }catch{}
      if(!options.includes(value)){
        return {ok:false,message:"「"+field.label+"」的选择值已经不在当前选项中，请重新选择"};
      }
    }
  }

  return {ok:true,value};
}

async function validateCustomerValues(env,values,{requireRequired=true}={}){
  const input=values && typeof values==="object" && !Array.isArray(values)?values:{};
  const defsResult=await env.DB.prepare(
    "SELECT id,label,field_type,required,options_json FROM field_definitions WHERE enabled=1 ORDER BY sort_order,label"
  ).all();
  const defs=defsResult.results||[];
  const byId=new Map(defs.map(x=>[x.id,x]));

  for(const key of Object.keys(input)){
    if(!byId.has(key))return {ok:false,message:"客户资料中包含已经停用或不存在的登记条目，请刷新页面后重试"};
  }

  const normalized={};
  for(const field of defs){
    const has=Object.prototype.hasOwnProperty.call(input,field.id);
    if(!has){
      if(requireRequired && field.required)return {ok:false,message:"「"+field.label+"」为必填项"};
      continue;
    }
    const checked=validateFieldValue(field,input[field.id]);
    if(!checked.ok)return checked;
    normalized[field.id]=checked.value;
  }
  return {ok:true,values:normalized,fields:defs};
}

async function resolveCustomerOwner(env,user,current,requestedProvided,requestedValue){
  if(normalizedRole(user.role)==="sales")return {ok:true,ownerId:user.id};

  if(!requestedProvided)return {ok:true,ownerId:current?.assigned_user_id||null};
  const ownerId=String(requestedValue||"").trim()||null;
  if(!ownerId)return {ok:true,ownerId:null};

  const owner=await env.DB.prepare(
    "SELECT id,display_name,active FROM users WHERE id=? AND role='sales'"
  ).bind(ownerId).first();
  if(!owner)return {ok:false,message:"指定的业务员不存在"};

  if(!owner.active && ownerId!==current?.assigned_user_id){
    return {ok:false,message:"该业务员已经停用，不能再把新客户或其他客户分配给他"};
  }
  return {ok:true,ownerId,owner};
}

async function getCustomer(env, user, id) {
  const row = await env.DB.prepare(
    `SELECT c.*,u.display_name owner_name,u.active owner_active FROM customers c
     LEFT JOIN users u ON u.id=c.assigned_user_id
     WHERE c.id=? AND c.deleted_at IS NULL`
  ).bind(id).first();
  if (!row) return fail("客户不存在", 404, "NOT_FOUND");
  if (normalizedRole(user.role) === "sales" && row.assigned_user_id !== user.id) return fail("无权查看该客户", 403, "FORBIDDEN");

  const fields = await env.DB.prepare(
    "SELECT * FROM field_definitions WHERE enabled=1 ORDER BY sort_order,label"
  ).all();
  const vals = await env.DB.prepare(
    "SELECT field_id,value FROM customer_values WHERE customer_id=?"
  ).bind(id).all();
  const valueMap = Object.fromEntries((vals.results || []).map(v => [v.field_id, v.value]));

  const prog = await env.DB.prepare(
    `SELECT pd.id,pd.label,pd.description,pd.color,pd.sort_order,
      COALESCE(cp.completed,0) completed,cp.completed_at
      FROM progress_definitions pd
      LEFT JOIN customer_progress cp ON cp.progress_id=pd.id AND cp.customer_id=?
      WHERE pd.enabled=1 ORDER BY pd.sort_order,pd.label`
  ).bind(id).all();

  return responseJson({
    ok: true,
    customer: {
      id: row.id,
      name: row.name,
      ownerId: row.assigned_user_id,
      ownerName: row.owner_name || "",
      ownerActive: row.assigned_user_id ? !!row.owner_active : null,
      editVersion: Number(row.edit_version || 1),
      progressDone: Number(row.progress_done || 0),
      progressTotal: Number(row.progress_total || 0),
      progressPercent: Number(row.progress_percent || 0),
      archived: !!row.archived,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      values: valueMap,
      progress: (prog.results || []).map(p => ({ ...p, completed: !!p.completed }))
    },
    fields: fields.results || []
  });
}

async function createCustomer(request, env, user) {
  const body = await readBody(request);
  const nameCheck=validateCustomerName(body.name);
  if(!nameCheck.ok)return fail(nameCheck.message);

  const ownerCheck=await resolveCustomerOwner(
    env,user,null,
    normalizedRole(user.role)==="admin",
    body.assignedUserId
  );
  if(!ownerCheck.ok)return fail(ownerCheck.message);

  const valuesCheck=await validateCustomerValues(env,body.values||{},{requireRequired:true});
  if(!valuesCheck.ok)return fail(valuesCheck.message);

  const totalRow = await env.DB.prepare("SELECT COUNT(*) n FROM progress_definitions WHERE enabled=1").first();
  const total = Number(totalRow?.n || 0);
  const id = uid("c_");
  const t = now();

  const statements=[
    env.DB.prepare(
      `INSERT INTO customers(
        id,assigned_user_id,name,progress_done,progress_total,progress_percent,archived,
        created_by_id,created_at,updated_at,edit_version
       ) VALUES(?,?,?,0,?,0,0,?,?,?,1)`
    ).bind(id,ownerCheck.ownerId,nameCheck.value,total,user.id,t,t)
  ];

  for(const [fieldId,value] of Object.entries(valuesCheck.values)){
    statements.push(env.DB.prepare(
      `INSERT INTO customer_values(customer_id,field_id,value,updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(customer_id,field_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`
    ).bind(id,fieldId,value,t));
  }

  await env.DB.batch(statements);
  await audit(env,user,"create","customer",id,{name:nameCheck.value,assignedUserId:ownerCheck.ownerId});
  return responseJson({ok:true,id,editVersion:1},201);
}

async function updateCustomer(request, env, user, id) {
  const current = await env.DB.prepare("SELECT * FROM customers WHERE id=? AND deleted_at IS NULL").bind(id).first();
  if (!current) return fail("客户不存在", 404);
  if (normalizedRole(user.role) === "sales" && current.assigned_user_id !== user.id) return fail("无权修改该客户", 403);

  const body = await readBody(request);
  const nameCheck=validateCustomerName(body.name!==undefined?body.name:current.name);
  if(!nameCheck.ok)return fail(nameCheck.message);

  const ownerCheck=await resolveCustomerOwner(
    env,user,current,
    normalizedRole(user.role)==="admin" && body.assignedUserId!==undefined,
    body.assignedUserId
  );
  if(!ownerCheck.ok)return fail(ownerCheck.message);

  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : null;
  let valuesCheck={ok:true,values:{}};
  if(values){
    valuesCheck=await validateCustomerValues(env,values,{requireRequired:true});
    if(!valuesCheck.ok)return fail(valuesCheck.message);
  }

  const archived = body.archived !== undefined ? (body.archived ? 1 : 0) : current.archived;
  const t = now();
  const statements=[];

  for(const [fieldId,value] of Object.entries(valuesCheck.values||{})){
    statements.push(env.DB.prepare(
      `INSERT INTO customer_values(customer_id,field_id,value,updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(customer_id,field_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`
    ).bind(id,fieldId,value,t));
  }

  statements.push(env.DB.prepare(
    `UPDATE customers
     SET name=?,assigned_user_id=?,archived=?,updated_at=?,edit_version=edit_version+1
     WHERE id=?`
  ).bind(nameCheck.value,ownerCheck.ownerId,archived,t,id));

  await env.DB.batch(statements);
  await audit(env,user,"update","customer",id,{
    name:nameCheck.value,assignedUserId:ownerCheck.ownerId,archived:!!archived
  });
  return responseJson({ok:true,editVersion:Number(current.edit_version||1)+1,updatedAt:t});
}

async function saveCustomerAtomic(request,env,user,id,ctx){
  const current=await env.DB.prepare(
    "SELECT * FROM customers WHERE id=? AND deleted_at IS NULL"
  ).bind(id).first();
  if(!current)return fail("客户不存在",404,"NOT_FOUND");
  if(normalizedRole(user.role)==="sales"&&current.assigned_user_id!==user.id){
    return fail("无权修改该客户",403,"FORBIDDEN");
  }

  const body=await readBody(request);
  const expectedVersion=safeInt(body.expectedVersion,0,0,2147483647);
  const currentVersion=Number(current.edit_version||1);
  if(!expectedVersion || expectedVersion!==currentVersion){
    return fail(
      "这名客户已经被其他人修改。为了避免覆盖别人的最新内容，本次保存已被阻止，请重新载入客户资料后确认。",
      409,
      "EDIT_CONFLICT"
    );
  }

  const hasProfile=body.name!==undefined || body.values!==undefined || body.assignedUserId!==undefined || body.archived!==undefined;
  const nameCheck=validateCustomerName(body.name!==undefined?body.name:current.name);
  if(!nameCheck.ok)return fail(nameCheck.message);

  const ownerCheck=await resolveCustomerOwner(
    env,user,current,
    normalizedRole(user.role)==="admin"&&body.assignedUserId!==undefined,
    body.assignedUserId
  );
  if(!ownerCheck.ok)return fail(ownerCheck.message);

  let valuesCheck={ok:true,values:{}};
  if(body.values!==undefined){
    valuesCheck=await validateCustomerValues(env,body.values,{requireRequired:true});
    if(!valuesCheck.ok)return fail(valuesCheck.message);
  }

  const progressInput=Array.isArray(body.progressChanges)?body.progressChanges:[];
  const uniqueProgress=new Map();
  for(const p of progressInput){
    const pid=String(p?.id||"").trim();
    if(pid)uniqueProgress.set(pid,!!p.completed);
  }

  const [defsResult,progressResult]=await Promise.all([
    env.DB.prepare(
      "SELECT id,label,description,color,sort_order FROM progress_definitions WHERE enabled=1 ORDER BY sort_order,label"
    ).all(),
    env.DB.prepare(
      "SELECT progress_id,completed FROM customer_progress WHERE customer_id=?"
    ).bind(id).all()
  ]);
  const defs=defsResult.results||[];
  const defsById=new Map(defs.map(x=>[x.id,x]));
  for(const pid of uniqueProgress.keys()){
    if(!defsById.has(pid))return fail("客户进度已经发生变化，请刷新页面后重试",409,"PROGRESS_CHANGED");
  }

  const completedMap=new Map((progressResult.results||[]).map(x=>[x.progress_id,Number(x.completed||0)===1]));
  const transitioned=[];
  for(const [pid,completed] of uniqueProgress.entries()){
    const before=completedMap.get(pid)===true;
    if(completed&&!before)transitioned.push(defsById.get(pid));
    completedMap.set(pid,completed);
  }

  const total=defs.length;
  const done=defs.reduce((n,p)=>n+(completedMap.get(p.id)?1:0),0);
  const percent=total?Math.round(done*100/total):0;
  const archived=body.archived!==undefined?(body.archived?1:0):current.archived;
  const t=now();
  const statements=[];

  for(const [fieldId,value] of Object.entries(valuesCheck.values||{})){
    statements.push(env.DB.prepare(
      `INSERT INTO customer_values(customer_id,field_id,value,updated_at)
       SELECT ?,?,?,?
       WHERE EXISTS(SELECT 1 FROM customers WHERE id=? AND edit_version=?)
       ON CONFLICT(customer_id,field_id) DO UPDATE SET
         value=excluded.value,updated_at=excluded.updated_at`
    ).bind(id,fieldId,value,t,id,currentVersion));
  }

  for(const [pid,completed] of uniqueProgress.entries()){
    statements.push(env.DB.prepare(
      `INSERT INTO customer_progress(customer_id,progress_id,completed,completed_by,completed_at)
       SELECT ?,?,?,?,?,?
       WHERE EXISTS(SELECT 1 FROM customers WHERE id=? AND edit_version=?)
       ON CONFLICT(customer_id,progress_id) DO UPDATE SET
         completed=excluded.completed,
         completed_by=excluded.completed_by,
         completed_at=excluded.completed_at`
    ).bind(id,pid,completed?1:0,user.id,completed?t:null,id,currentVersion));
  }

  statements.push(env.DB.prepare(
    `UPDATE customers SET
       name=?,assigned_user_id=?,archived=?,
       progress_done=?,progress_total=?,progress_percent=?,
       updated_at=?,edit_version=edit_version+1
     WHERE id=? AND edit_version=?`
  ).bind(
    nameCheck.value,ownerCheck.ownerId,archived,
    done,total,percent,t,id,currentVersion
  ));

  const results=await env.DB.batch(statements);
  const finalResult=results[results.length-1];
  if(Number(finalResult?.meta?.changes||0)!==1){
    return fail(
      "这名客户刚刚被其他人修改。为了避免覆盖，本次保存没有生效，请重新载入后确认。",
      409,
      "EDIT_CONFLICT"
    );
  }

  await audit(env,user,"update","customer",id,{
    atomic:true,
    profileChanged:!!hasProfile,
    progressChanges:[...uniqueProgress.entries()].map(([progressId,completed])=>({progressId,completed})),
    editVersionBefore:currentVersion,
    editVersionAfter:currentVersion+1
  });

  if(transitioned.length){
    const summary={done,total,percent};
    const jobs=transitioned.map(pd=>
      sendTelegramProgressNotification(request,env,user,id,pd,summary,t+":"+pd.id).catch(()=>{})
    );
    const job=Promise.all(jobs);
    if(ctx?.waitUntil)ctx.waitUntil(job);
    else await job;
  }

  return responseJson({
    ok:true,
    done,total,percent,
    editVersion:currentVersion+1,
    updatedAt:t
  });
}

async function toggleProgress(request, env, user, customerId, progressId, ctx) {
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id=? AND deleted_at IS NULL").bind(customerId).first();
  if (!customer) return fail("客户不存在", 404);
  if (normalizedRole(user.role) === "sales" && customer.assigned_user_id !== user.id) return fail("无权修改该客户", 403);

  const pd = await env.DB.prepare("SELECT id,label,description,color,sort_order FROM progress_definitions WHERE id=? AND enabled=1").bind(progressId).first();
  if (!pd) return fail("进度项目不存在", 404);
  const previous=await env.DB.prepare(
    "SELECT completed FROM customer_progress WHERE customer_id=? AND progress_id=?"
  ).bind(customerId,progressId).first();

  const body = await readBody(request);
  const completed = body.completed ? 1 : 0;
  const t = now();
  await env.DB.prepare(
    `INSERT INTO customer_progress(customer_id,progress_id,completed,completed_by,completed_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(customer_id,progress_id) DO UPDATE SET
     completed=excluded.completed,completed_by=excluded.completed_by,completed_at=excluded.completed_at`
  ).bind(customerId, progressId, completed, user.id, completed ? t : null).run();
  const summary = await recalcProgress(env, customerId);
  await audit(env, user, completed ? "progress_complete" : "progress_uncomplete", "customer", customerId, { progressId });

  const transitionedToComplete=completed===1 && Number(previous?.completed||0)!==1;
  if(transitionedToComplete){
    const job=sendTelegramProgressNotification(request,env,user,customerId,pd,summary,t).catch(()=>{});
    if(ctx?.waitUntil)ctx.waitUntil(job);
    else await job;
  }

  return responseJson({ ok: true, ...summary });
}

async function listFields(env, user) {
  const sql = normalizedRole(user.role) === "admin"
    ? "SELECT * FROM field_definitions ORDER BY sort_order,label"
    : "SELECT * FROM field_definitions WHERE enabled=1 ORDER BY sort_order,label";
  const r = await env.DB.prepare(sql).all();
  return responseJson({ ok: true, items: r.results || [] });
}

async function createField(request, env, user) {
  const b = await readBody(request);
  const label = String(b.label || "").trim();
  if (!label) return fail("请输入字段名称");
  const key = String(b.fieldKey || ("field_" + Date.now())).trim().replace(/[^a-zA-Z0-9_]/g, "_");
  const id = uid("f_");
  const t = now();

  let sortOrder;
  const insertAnchorId=String(b.insertAnchorId||"").trim();
  const insertPosition=b.insertPosition==="before"?"before":b.insertPosition==="after"?"after":"";

  if(insertAnchorId && insertPosition){
    const anchor=await env.DB.prepare("SELECT id,sort_order FROM field_definitions WHERE id=?").bind(insertAnchorId).first();
    if(!anchor)return fail("插入位置已经不存在，请刷新后重试",409,"INSERT_ANCHOR_MISSING");
    const anchorSort=Number(anchor.sort_order||0);
    sortOrder=Math.max(0,anchorSort+(insertPosition==="after"?1:0));

    const listSortOrder=sortOrder;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE field_definitions SET sort_order=sort_order+1,updated_at=? WHERE sort_order>=?"
      ).bind(t,sortOrder),
      env.DB.prepare(
        `INSERT INTO field_definitions(id,field_key,label,field_type,required,enabled,list_visible,list_sort_order,sort_order,options_json,searchable,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id,key,label,String(b.fieldType||"text"),b.required?1:0,b.enabled===false?0:1,b.listVisible?1:0,
        listSortOrder,sortOrder,JSON.stringify(b.options||[]),b.searchable===false?0:1,t,t)
    ]);
  }else{
    const maxRow = await env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) AS max_sort FROM field_definitions").first();
    const nextSort = Number(maxRow?.max_sort || 0) + 1;
    sortOrder = b.sortOrder!==undefined ? safeInt(b.sortOrder,nextSort,0,100000) : nextSort;
    const listSortOrder = b.listSortOrder!==undefined ? safeInt(b.listSortOrder,sortOrder,0,100000) : sortOrder;

    await env.DB.prepare(
      `INSERT INTO field_definitions(id,field_key,label,field_type,required,enabled,list_visible,list_sort_order,sort_order,options_json,searchable,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id,key,label,String(b.fieldType||"text"),b.required?1:0,b.enabled===false?0:1,b.listVisible?1:0,
      listSortOrder,sortOrder,JSON.stringify(b.options||[]),
      b.searchable===false?0:1,t,t).run();
  }

  await audit(env,user,"create","field",id,{label,sortOrder,insertAnchorId:insertAnchorId||null,insertPosition:insertPosition||null});
  return responseJson({ok:true,id,sortOrder},201);
}

async function updateField(request, env, user, id) {
  const old = await env.DB.prepare("SELECT * FROM field_definitions WHERE id=?").bind(id).first();
  if (!old) return fail("字段不存在",404);
  const b=await readBody(request), t=now();
  await env.DB.prepare(
    `UPDATE field_definitions SET label=?,field_type=?,required=?,enabled=?,list_visible=?,list_sort_order=?,sort_order=?,options_json=?,searchable=?,updated_at=? WHERE id=?`
  ).bind(
    b.label!==undefined?String(b.label):old.label,
    b.fieldType!==undefined?String(b.fieldType):old.field_type,
    b.required!==undefined?(b.required?1:0):old.required,
    b.enabled!==undefined?(b.enabled?1:0):old.enabled,
    b.listVisible!==undefined?(b.listVisible?1:0):old.list_visible,
    b.listSortOrder!==undefined?safeInt(b.listSortOrder,old.list_sort_order,0,100000):old.list_sort_order,
    b.sortOrder!==undefined?safeInt(b.sortOrder,old.sort_order,0,100000):old.sort_order,
    b.options!==undefined?JSON.stringify(b.options):old.options_json,
    b.searchable!==undefined?(b.searchable?1:0):old.searchable,t,id
  ).run();
  await audit(env,user,"update","field",id,b);
  return responseJson({ok:true});
}


async function hardDeleteField(env,user,id){
  const field=await env.DB.prepare("SELECT * FROM field_definitions WHERE id=?").bind(id).first();
  if(!field)return fail("登记条目不存在",404);

  const valueCountRow=await env.DB.prepare("SELECT COUNT(*) n FROM customer_values WHERE field_id=?").bind(id).first();
  const valueCount=Number(valueCountRow?.n||0);
  const t=now();

  // Remove references first because these tables intentionally do not use ON DELETE CASCADE.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM customer_values WHERE field_id=?").bind(id),
    env.DB.prepare("DELETE FROM list_columns WHERE field_id=?").bind(id)
  ]);

  // Remove the field from the registration panel layout.
  const layoutRow=await env.DB.prepare("SELECT value_json FROM system_settings WHERE setting_key='sales_registration_layout'").first();
  if(layoutRow?.value_json){
    try{
      const layout=JSON.parse(layoutRow.value_json);
      if(Array.isArray(layout?.sections)){
        for(const section of layout.sections){
          if(Array.isArray(section.items))section.items=section.items.filter(x=>String(x)!==id);
        }
        await env.DB.prepare(
          "UPDATE system_settings SET value_json=?,updated_at=? WHERE setting_key='sales_registration_layout'"
        ).bind(JSON.stringify(layout),t).run();
      }
    }catch{}
  }

  // Remove the field from Telegram notification templates.
  const tg=await env.DB.prepare("SELECT fields_json FROM telegram_settings WHERE id=1").first();
  if(tg?.fields_json){
    try{
      const items=JSON.parse(tg.fields_json);
      if(Array.isArray(items)){
        const filtered=items.filter(x=>String(x?.key||"")!=="field:"+id);
        await env.DB.prepare("UPDATE telegram_settings SET fields_json=?,updated_at=? WHERE id=1")
          .bind(JSON.stringify(filtered),t).run();
      }
    }catch{}
  }

  await env.DB.prepare("DELETE FROM field_definitions WHERE id=?").bind(id).run();
  await audit(env,user,"delete_permanent","field",id,{label:field.label,deletedCustomerValues:valueCount});
  return responseJson({ok:true,deletedCustomerValues:valueCount,label:field.label});
}

async function hardDeleteProgressDef(env,user,id){
  const progress=await env.DB.prepare("SELECT * FROM progress_definitions WHERE id=?").bind(id).first();
  if(!progress)return fail("客户进度不存在",404);

  const valueCountRow=await env.DB.prepare("SELECT COUNT(*) n FROM customer_progress WHERE progress_id=?").bind(id).first();
  const valueCount=Number(valueCountRow?.n||0);

  await env.DB.prepare("DELETE FROM customer_progress WHERE progress_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM telegram_progress_routes WHERE progress_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM telegram_send_queue WHERE progress_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM progress_definitions WHERE id=?").bind(id).run();
  await recalcAllProgress(env);
  await audit(env,user,"delete_permanent","progress_definition",id,{label:progress.label,deletedCustomerProgress:valueCount});
  return responseJson({ok:true,deletedCustomerProgress:valueCount,label:progress.label});
}

async function listProgressDefs(env, user) {
  const sql = normalizedRole(user.role)==="admin"
    ? "SELECT * FROM progress_definitions ORDER BY sort_order,label"
    : "SELECT * FROM progress_definitions WHERE enabled=1 ORDER BY sort_order,label";
  const r=await env.DB.prepare(sql).all();
  return responseJson({ok:true,items:r.results||[]});
}

async function createProgressDef(request, env, user) {
  const b=await readBody(request), label=String(b.label||"").trim();
  if(!label) return fail("请输入进度名称");
  const id=uid("p_"),t=now();

  let sortOrder;
  const insertAnchorId=String(b.insertAnchorId||"").trim();
  const insertPosition=b.insertPosition==="before"?"before":b.insertPosition==="after"?"after":"";

  if(insertAnchorId && insertPosition){
    const anchor=await env.DB.prepare("SELECT id,sort_order FROM progress_definitions WHERE id=?").bind(insertAnchorId).first();
    if(!anchor)return fail("插入位置已经不存在，请刷新后重试",409,"INSERT_ANCHOR_MISSING");
    const anchorSort=Number(anchor.sort_order||0);
    sortOrder=Math.max(0,anchorSort+(insertPosition==="after"?1:0));

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE progress_definitions SET sort_order=sort_order+1,updated_at=? WHERE sort_order>=?"
      ).bind(t,sortOrder),
      env.DB.prepare(
        "INSERT INTO progress_definitions(id,label,description,enabled,sort_order,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
      ).bind(id,label,String(b.description||""),b.enabled===false?0:1,sortOrder,String(b.color||"#2563eb"),t,t)
    ]);
  }else{
    const maxRow=await env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) AS max_sort FROM progress_definitions").first();
    const nextSort=Number(maxRow?.max_sort||0)+1;
    sortOrder=b.sortOrder!==undefined?safeInt(b.sortOrder,nextSort,0,100000):nextSort;
    await env.DB.prepare(
      "INSERT INTO progress_definitions(id,label,description,enabled,sort_order,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
    ).bind(id,label,String(b.description||""),b.enabled===false?0:1,sortOrder,String(b.color||"#2563eb"),t,t).run();
  }

  await recalcAllProgress(env);
  await audit(env,user,"create","progress_definition",id,{label,sortOrder,insertAnchorId:insertAnchorId||null,insertPosition:insertPosition||null});
  return responseJson({ok:true,id,sortOrder},201);
}

async function updateProgressDef(request, env, user, id) {
  const old=await env.DB.prepare("SELECT * FROM progress_definitions WHERE id=?").bind(id).first();
  if(!old) return fail("进度不存在",404);
  const b=await readBody(request),t=now();
  await env.DB.prepare(
    "UPDATE progress_definitions SET label=?,description=?,enabled=?,sort_order=?,color=?,updated_at=? WHERE id=?"
  ).bind(
    b.label!==undefined?String(b.label):old.label,
    b.description!==undefined?String(b.description):old.description,
    b.enabled!==undefined?(b.enabled?1:0):old.enabled,
    b.sortOrder!==undefined?safeInt(b.sortOrder,old.sort_order,0,100000):old.sort_order,
    b.color!==undefined?String(b.color):old.color,t,id
  ).run();
  await recalcAllProgress(env);
  await audit(env,user,"update","progress_definition",id,b);
  return responseJson({ok:true});
}

async function listColumns(env, user) {
  const r = await env.DB.prepare(
    "SELECT id,audience,column_key,field_id,label,enabled,sort_order FROM list_columns WHERE audience=? AND enabled=1 ORDER BY sort_order,label,id"
  ).bind(normalizedRole(user.role)).all();
  const seen=new Set(),items=[];
  for(const item of r.results||[]){
    const key=String(item.column_key||"")+":"+String(item.field_id||"");
    if(seen.has(key))continue;
    seen.add(key);items.push(item);
  }
  return responseJson({ok:true,items});
}

async function adminListColumns(request, env) {
  const url=new URL(request.url);
  const audience=url.searchParams.get("audience")==="sales"?"sales":"admin";
  const r=await env.DB.prepare(
    "SELECT id,audience,column_key,field_id,label,enabled,sort_order FROM list_columns WHERE audience=? ORDER BY sort_order,label,id"
  ).bind(audience).all();

  const seen=new Set();
  const duplicates=[];
  const items=[];
  for(const item of r.results||[]){
    const key=String(item.column_key||"")+":"+String(item.field_id||"");
    if(seen.has(key)){duplicates.push(item.id);continue}
    seen.add(key);items.push(item);
  }
  if(duplicates.length){
    const marks=duplicates.map(()=>"?").join(",");
    await env.DB.prepare(`DELETE FROM list_columns WHERE id IN (${marks})`).bind(...duplicates).run();
  }

  const fields=await env.DB.prepare("SELECT id,label,field_key FROM field_definitions WHERE enabled=1 ORDER BY sort_order,label").all();
  return responseJson({ok:true,audience,items,fields:fields.results||[]});
}

async function saveListColumns(request, env, user) {
  const b=await readBody(request);
  const audience=b.audience==="sales"?"sales":"admin";
  const input=Array.isArray(b.items)?b.items:[];
  const statements=[env.DB.prepare("DELETE FROM list_columns WHERE audience=?").bind(audience)];
  const seen=new Set();
  let sort=10;
  let count=0;

  for(const item of input){
    const columnKey=String(item.columnKey||"dynamic");
    const fieldId=item.fieldId||null;
    if(columnKey==="dynamic"&&!fieldId)continue;
    if(!["name","owner","dynamic"].includes(columnKey))continue;
    if(audience==="sales"&&columnKey==="owner")continue;

    const uniqueKey=columnKey+":"+String(fieldId||"");
    if(seen.has(uniqueKey))continue;
    seen.add(uniqueKey);

    statements.push(env.DB.prepare(
      "INSERT INTO list_columns(id,audience,column_key,field_id,label,enabled,sort_order) VALUES(?,?,?,?,?,?,?)"
    ).bind(uid("lc_"),audience,columnKey,fieldId,String(item.label||""),item.enabled===false?0:1,sort));
    sort+=10;count++;
  }
  await env.DB.batch(statements);
  await audit(env,user,"replace","list_columns",audience,{count});
  return responseJson({ok:true,count});
}

async function dashboardWidgets(env,user){
  const r=await env.DB.prepare(
    "SELECT id,audience,widget_type,title,enabled,sort_order,config_json FROM dashboard_widgets WHERE audience=? AND enabled=1 ORDER BY sort_order,title"
  ).bind(user.role).all();
  return responseJson({ok:true,items:r.results||[]});
}

async function adminDashboardWidgets(request,env){
  const url=new URL(request.url);
  const audience=url.searchParams.get("audience")==="sales"?"sales":"admin";
  const [r,p]=await Promise.all([
    env.DB.prepare(
      "SELECT id,audience,widget_type,title,enabled,sort_order,config_json FROM dashboard_widgets WHERE audience=? ORDER BY sort_order,title"
    ).bind(audience).all(),
    env.DB.prepare(
      "SELECT id,label,sort_order FROM progress_definitions WHERE enabled=1 ORDER BY sort_order,label"
    ).all()
  ]);
  return responseJson({ok:true,audience,items:r.results||[],progressDefs:p.results||[]});
}

async function createDashboardWidget(request,env,user){
  const b=await readBody(request);
  const allowed=["metric_total","metric_today","metric_complete","metric_archived","metric_progress","sales_breakdown"];
  const type=allowed.includes(b.widgetType)?b.widgetType:"metric_total";
  const audience=b.audience==="sales"?"sales":"admin";
  const id=uid("dw_"),t=now();

  let config=b.config&&typeof b.config==="object"?b.config:{};
  if(type==="metric_progress"){
    const progressId=String(config.progressId||"");
    const exists=await env.DB.prepare("SELECT id FROM progress_definitions WHERE id=? AND enabled=1").bind(progressId).first();
    if(!exists)return fail("请选择有效的客户进度");
    config={progressId};
  }

  let sortOrder;
  const insertAnchorId=String(b.insertAnchorId||"").trim();
  const insertPosition=b.insertPosition==="before"?"before":b.insertPosition==="after"?"after":"";

  if(insertAnchorId&&insertPosition){
    const anchor=await env.DB.prepare(
      "SELECT id,audience,sort_order FROM dashboard_widgets WHERE id=?"
    ).bind(insertAnchorId).first();
    if(!anchor)return fail("插入位置已经不存在，请刷新后重试",409,"INSERT_ANCHOR_MISSING");
    if(anchor.audience!==audience)return fail("插入位置与当前仪表盘不一致，请刷新后重试",409,"INSERT_AUDIENCE_MISMATCH");

    const anchorSort=Number(anchor.sort_order||0);
    sortOrder=Math.max(0,anchorSort+(insertPosition==="after"?1:0));

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE dashboard_widgets SET sort_order=sort_order+1 WHERE audience=? AND sort_order>=?"
      ).bind(audience,sortOrder),
      env.DB.prepare(
        "INSERT INTO dashboard_widgets(id,audience,widget_type,title,enabled,sort_order,config_json) VALUES(?,?,?,?,?,?,?)"
      ).bind(id,audience,type,String(b.title||"统计组件"),b.enabled===false?0:1,sortOrder,JSON.stringify(config))
    ]);
  }else{
    const maxRow=await env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order),0) AS max_sort FROM dashboard_widgets WHERE audience=?"
    ).bind(audience).first();
    const nextSort=Number(maxRow?.max_sort||0)+1;
    sortOrder=b.sortOrder!==undefined?safeInt(b.sortOrder,nextSort,0,100000):nextSort;

    await env.DB.prepare(
      "INSERT INTO dashboard_widgets(id,audience,widget_type,title,enabled,sort_order,config_json) VALUES(?,?,?,?,?,?,?)"
    ).bind(id,audience,type,String(b.title||"统计组件"),b.enabled===false?0:1,sortOrder,JSON.stringify(config)).run();
  }

  await audit(env,user,"create","dashboard_widget",id,{
    audience,type,title:String(b.title||"统计组件"),sortOrder,
    insertAnchorId:insertAnchorId||null,insertPosition:insertPosition||null
  });
  return responseJson({ok:true,id,sortOrder},201);
}

async function updateDashboardWidget(request,env,user,id){
  const old=await env.DB.prepare("SELECT * FROM dashboard_widgets WHERE id=?").bind(id).first();
  if(!old)return fail("仪表盘组件不存在",404);
  const b=await readBody(request);
  const allowed=["metric_total","metric_today","metric_complete","metric_archived","metric_progress","sales_breakdown"];
  const type=b.widgetType!==undefined&&allowed.includes(b.widgetType)?b.widgetType:old.widget_type;
  const audience=b.audience!==undefined?(b.audience==="sales"?"sales":"admin"):old.audience;
  let configJson=b.config!==undefined?JSON.stringify(b.config):old.config_json;
  if(type==="metric_progress"){
    let cfg={};try{cfg=b.config!==undefined?b.config:JSON.parse(old.config_json||"{}")}catch{}
    const progressId=String(cfg?.progressId||"");
    const exists=await env.DB.prepare("SELECT id FROM progress_definitions WHERE id=? AND enabled=1").bind(progressId).first();
    if(!exists)return fail("请选择有效的客户进度");
    configJson=JSON.stringify({progressId});
  }
  await env.DB.prepare(
    "UPDATE dashboard_widgets SET audience=?,widget_type=?,title=?,enabled=?,sort_order=?,config_json=? WHERE id=?"
  ).bind(audience,type,b.title!==undefined?String(b.title):old.title,b.enabled!==undefined?(b.enabled?1:0):old.enabled,
    b.sortOrder!==undefined?safeInt(b.sortOrder,old.sort_order,0,100000):old.sort_order,
    configJson,id).run();
  await audit(env,user,"update","dashboard_widget",id,b);
  return responseJson({ok:true});
}


function defaultRegistrationLayout() {
  return {
    sections: [
      { id:"basic", title:"基本信息", description:"", items:["name","f_phone","f_email"] },
      { id:"details", title:"其他信息", description:"", items:["f_case_no","f_country","f_city","f_notes"] }
    ]
  };
}

async function resolvedRegistrationLayout(env) {
  const raw = await getSystemSetting(env,"sales_registration_layout",defaultRegistrationLayout());
  const fieldsResult = await env.DB.prepare(
    "SELECT * FROM field_definitions WHERE enabled=1 ORDER BY sort_order,label"
  ).all();
  const fields = fieldsResult.results || [];
  const fieldMap = new Map(fields.map(x=>[x.id,x]));
  const seen = new Set();
  const sections = [];

  for (const source of Array.isArray(raw?.sections) ? raw.sections.slice(0,30) : []) {
    const items = [];
    for (const key of Array.isArray(source.items) ? source.items : []) {
      const k = String(key||"");
      if (!k || seen.has(k)) continue;
      if (k === "name" || fieldMap.has(k)) {
        seen.add(k);
        items.push(k);
      }
    }
    if (items.length || String(source.title||"").trim()) {
      sections.push({
        id:String(source.id||uid("sec_")),
        title:String(source.title||"信息分组").slice(0,80),
        description:String(source.description||"").slice(0,240),
        items
      });
    }
  }

  if (!seen.has("name")) {
    if (!sections.length) sections.push({id:"basic",title:"基本信息",description:"",items:[]});
    sections[0].items.unshift("name");
    seen.add("name");
  }

  const unassigned = fields.filter(x=>!seen.has(x.id)).map(x=>x.id);
  if (unassigned.length) {
    sections.push({
      id:"__unassigned",
      title:"其他信息",
      description:"尚未在管理员中分组的登记条目会自动显示在这里，避免遗漏。",
      items:unassigned,
      system:true
    });
  }

  return { sections, fields };
}

async function getRegistrationLayout(env) {
  const r = await resolvedRegistrationLayout(env);
  return responseJson({ok:true,...r});
}

async function adminRegistrationLayout(env) {
  const raw = await getSystemSetting(env,"sales_registration_layout",defaultRegistrationLayout());
  const fieldsResult = await env.DB.prepare(
    "SELECT id,field_key,label,field_type,required,sort_order FROM field_definitions WHERE enabled=1 ORDER BY sort_order,label"
  ).all();
  return responseJson({ok:true,layout:raw,fields:fieldsResult.results||[]});
}

async function saveRegistrationLayout(request,env,user) {
  const b=await readBody(request);
  const input=Array.isArray(b?.sections)?b.sections:[];
  const active=await env.DB.prepare("SELECT id FROM field_definitions WHERE enabled=1").all();
  const allowed=new Set((active.results||[]).map(x=>x.id));
  allowed.add("name");
  const seen=new Set();
  const sections=[];

  for(const source of input.slice(0,30)){
    const title=String(source?.title||"").trim().slice(0,80);
    if(!title) continue;
    const items=[];
    for(const rawKey of Array.isArray(source?.items)?source.items:[]){
      const key=String(rawKey||"");
      if(!allowed.has(key)||seen.has(key)) continue;
      seen.add(key);items.push(key);
    }
    sections.push({
      id:String(source?.id||uid("sec_")).slice(0,120),
      title,
      description:String(source?.description||"").slice(0,240),
      items
    });
  }

  if(!seen.has("name")){
    if(!sections.length) sections.push({id:"basic",title:"基本信息",description:"",items:[]});
    sections[0].items.unshift("name");
  }

  const value={sections};
  await env.DB.prepare(
    `INSERT INTO system_settings(setting_key,value_json,updated_at) VALUES('sales_registration_layout',?,?)
     ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`
  ).bind(JSON.stringify(value),now()).run();
  await audit(env,user,"update","registration_layout","sales",{sections:sections.length});
  return responseJson({ok:true,layout:value});
}

async function listSidebar(env, user) {
  const audience=normalizedRole(user.role);
  const r=await env.DB.prepare(
    `SELECT si.id,si.audience,si.label,si.icon,si.url,si.target,si.enabled,si.sort_order,
       COALESCE(sc.label,si.group_label,'') AS group_label
     FROM sidebar_items si
     LEFT JOIN sidebar_item_categories sic
       ON sic.item_id=si.id AND sic.audience=?
     LEFT JOIN sidebar_categories sc
       ON sc.id=sic.category_id AND sc.audience=?
     WHERE si.enabled=1 AND (si.audience=? OR si.audience='all')
     ORDER BY
       CASE WHEN COALESCE(sc.label,si.group_label,'')='' THEN 0 ELSE 1 END,
       COALESCE(sc.sort_order,si.sort_order),
       si.sort_order,
       si.label`
  ).bind(audience,audience,audience).all();
  const version = await getSystemSetting(env,"sidebar_version",0);
  return responseJson({ok:true,version:Number(version||0),items:r.results||[]});
}

async function adminSidebar(env) {
  const [items,categories,mappings]=await Promise.all([
    env.DB.prepare("SELECT * FROM sidebar_items ORDER BY audience,sort_order,label").all(),
    env.DB.prepare("SELECT * FROM sidebar_categories ORDER BY audience,sort_order,label").all(),
    env.DB.prepare("SELECT item_id,audience,category_id FROM sidebar_item_categories").all()
  ]);
  const version=await getSystemSetting(env,"sidebar_version",0);
  return responseJson({
    ok:true,
    version:Number(version||0),
    items:items.results||[],
    categories:categories.results||[],
    mappings:mappings.results||[]
  });
}

async function getSidebarCategory(env,id,audience){
  const categoryId=String(id||"").trim();
  if(!categoryId)return null;
  return env.DB.prepare(
    "SELECT id,audience,label,sort_order FROM sidebar_categories WHERE id=? AND audience=?"
  ).bind(categoryId,audience).first();
}

async function createSidebarCategory(request,env,user){
  const b=await readBody(request);
  const audience=b.audience==="admin"?"admin":b.audience==="sales"?"sales":"";
  const label=String(b.label||"").trim().slice(0,80);
  if(!audience)return fail("请选择管理员或业务员区域");
  if(!label)return fail("请输入分类名称");

  const exists=await env.DB.prepare(
    "SELECT id FROM sidebar_categories WHERE audience=? AND label=?"
  ).bind(audience,label).first();
  if(exists)return fail("这个区域已经存在同名分类",409);

  let sortOrder;
  if(b.sortOrder!==undefined && b.sortOrder!==null && String(b.sortOrder)!==""){
    sortOrder=safeInt(b.sortOrder,1,0,100000);
  }else{
    const maxRow=await env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order),0) AS max_sort FROM sidebar_categories WHERE audience=?"
    ).bind(audience).first();
    sortOrder=Number(maxRow?.max_sort||0)+1;
  }

  const id=uid("sc_"),t=now();
  await env.DB.prepare(
    "INSERT INTO sidebar_categories(id,audience,label,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)"
  ).bind(id,audience,label,sortOrder,t,t).run();
  await bumpVersion(env,"sidebar_version");
  await audit(env,user,"create","sidebar_category",id,{audience,label,sortOrder});
  return responseJson({ok:true,id,sortOrder},201);
}

async function updateSidebarCategory(request,env,user,id){
  const old=await env.DB.prepare("SELECT * FROM sidebar_categories WHERE id=?").bind(id).first();
  if(!old)return fail("分类不存在",404);
  const b=await readBody(request);
  const label=b.label!==undefined?String(b.label).trim().slice(0,80):old.label;
  if(!label)return fail("分类名称不能为空");

  const dup=await env.DB.prepare(
    "SELECT id FROM sidebar_categories WHERE audience=? AND label=? AND id<>?"
  ).bind(old.audience,label,id).first();
  if(dup)return fail("这个区域已经存在同名分类",409);

  const sortOrder=b.sortOrder!==undefined?safeInt(b.sortOrder,old.sort_order,0,100000):old.sort_order;
  await env.DB.prepare(
    "UPDATE sidebar_categories SET label=?,sort_order=?,updated_at=? WHERE id=?"
  ).bind(label,sortOrder,now(),id).run();
  await bumpVersion(env,"sidebar_version");
  await audit(env,user,"update","sidebar_category",id,{label,sortOrder});
  return responseJson({ok:true});
}

async function deleteSidebarCategory(env,user,id){
  const old=await env.DB.prepare("SELECT * FROM sidebar_categories WHERE id=?").bind(id).first();
  if(!old)return fail("分类不存在",404);
  const used=await env.DB.prepare(
    "SELECT COUNT(*) n FROM sidebar_item_categories WHERE category_id=?"
  ).bind(id).first();
  if(Number(used?.n||0)>0)return fail("这个分类里面还有按钮，请先把按钮移动到其他分类或未分类后再删除",409,"CATEGORY_NOT_EMPTY");

  await env.DB.prepare("DELETE FROM sidebar_categories WHERE id=?").bind(id).run();
  await bumpVersion(env,"sidebar_version");
  await audit(env,user,"delete","sidebar_category",id,{audience:old.audience,label:old.label});
  return responseJson({ok:true});
}

async function createSidebarItem(request, env, user) {
  const b=await readBody(request);
  if(!String(b.label||"").trim()||!String(b.url||"").trim()) return fail("按钮名称和跳转链接不能为空");
  const audience=["admin","sales","all"].includes(b.audience)?b.audience:"sales";
  const id=uid("sb_"),t=now();

  let sortOrder;
  if(b.sortOrder!==undefined && b.sortOrder!==null && String(b.sortOrder)!==""){
    sortOrder=safeInt(b.sortOrder,1,0,100000);
  }else{
    const maxRow=audience==="all"
      ? await env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) AS max_sort FROM sidebar_items").first()
      : await env.DB.prepare(
          "SELECT COALESCE(MAX(sort_order),0) AS max_sort FROM sidebar_items WHERE audience=? OR audience='all'"
        ).bind(audience).first();
    sortOrder=Number(maxRow?.max_sort||0)+1;
  }

  const adminCategory=(audience==="admin"||audience==="all")
    ? await getSidebarCategory(env,b.adminCategoryId||b.categoryId,"admin")
    : null;
  const salesCategory=(audience==="sales"||audience==="all")
    ? await getSidebarCategory(env,b.salesCategoryId||b.categoryId,"sales")
    : null;

  if((b.adminCategoryId||((audience==="admin")&&b.categoryId))&&!adminCategory)return fail("选择的管理员分类不存在，请刷新后重试");
  if((b.salesCategoryId||((audience==="sales")&&b.categoryId))&&!salesCategory)return fail("选择的业务员分类不存在，请刷新后重试");

  const legacyGroup=String(
    b.groupLabel!==undefined?b.groupLabel:(adminCategory?.label||salesCategory?.label||"")
  ).trim();

  await env.DB.prepare(
    `INSERT INTO sidebar_items(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id,audience,String(b.label).trim(),String(b.icon||"link"),String(b.url).trim(),
    b.target==="new"?"new":"same",b.enabled===false?0:1,sortOrder,legacyGroup,t,t).run();

  const mappings=[];
  if(adminCategory)mappings.push(env.DB.prepare(
    "INSERT OR REPLACE INTO sidebar_item_categories(item_id,audience,category_id) VALUES(?,?,?)"
  ).bind(id,"admin",adminCategory.id));
  if(salesCategory)mappings.push(env.DB.prepare(
    "INSERT OR REPLACE INTO sidebar_item_categories(item_id,audience,category_id) VALUES(?,?,?)"
  ).bind(id,"sales",salesCategory.id));
  if(mappings.length)await env.DB.batch(mappings);

  await bumpVersion(env,"sidebar_version");
  await audit(env,user,"create","sidebar_item",id,{...b,sortOrder});
  return responseJson({ok:true,id,sortOrder},201);
}

async function updateSidebarItem(request, env, user, id) {
  const old=await env.DB.prepare("SELECT * FROM sidebar_items WHERE id=?").bind(id).first();
  if(!old) return fail("按钮不存在",404);
  const b=await readBody(request),t=now();
  const audience=b.audience!==undefined&&["admin","sales","all"].includes(b.audience)?b.audience:old.audience;

  const oldMappingsResult=await env.DB.prepare(
    "SELECT audience,category_id FROM sidebar_item_categories WHERE item_id=?"
  ).bind(id).all();
  const oldMappings=Object.fromEntries((oldMappingsResult.results||[]).map(x=>[x.audience,x.category_id]));

  const adminCategoryId=b.adminCategoryId!==undefined
    ? String(b.adminCategoryId||"")
    : (audience===old.audience?String(oldMappings.admin||""):"");
  const salesCategoryId=b.salesCategoryId!==undefined
    ? String(b.salesCategoryId||"")
    : (audience===old.audience?String(oldMappings.sales||""):"");

  const adminCategory=(audience==="admin"||audience==="all")
    ? await getSidebarCategory(env,adminCategoryId,"admin")
    : null;
  const salesCategory=(audience==="sales"||audience==="all")
    ? await getSidebarCategory(env,salesCategoryId,"sales")
    : null;

  if(adminCategoryId&&!adminCategory)return fail("选择的管理员分类不存在，请刷新后重试");
  if(salesCategoryId&&!salesCategory)return fail("选择的业务员分类不存在，请刷新后重试");

  let groupLabel=b.groupLabel!==undefined?String(b.groupLabel):old.group_label;
  if(adminCategory||salesCategory)groupLabel=adminCategory?.label||salesCategory?.label||groupLabel;

  const statements=[
    env.DB.prepare(
      `UPDATE sidebar_items SET audience=?,label=?,icon=?,url=?,target=?,enabled=?,sort_order=?,group_label=?,updated_at=? WHERE id=?`
    ).bind(audience,b.label!==undefined?String(b.label):old.label,b.icon!==undefined?String(b.icon):old.icon,
      b.url!==undefined?String(b.url):old.url,b.target!==undefined?(b.target==="new"?"new":"same"):old.target,
      b.enabled!==undefined?(b.enabled?1:0):old.enabled,
      b.sortOrder!==undefined?safeInt(b.sortOrder,old.sort_order,0,100000):old.sort_order,
      groupLabel,t,id),
    env.DB.prepare("DELETE FROM sidebar_item_categories WHERE item_id=?").bind(id)
  ];
  if(adminCategory)statements.push(env.DB.prepare(
    "INSERT INTO sidebar_item_categories(item_id,audience,category_id) VALUES(?,?,?)"
  ).bind(id,"admin",adminCategory.id));
  if(salesCategory)statements.push(env.DB.prepare(
    "INSERT INTO sidebar_item_categories(item_id,audience,category_id) VALUES(?,?,?)"
  ).bind(id,"sales",salesCategory.id));

  await env.DB.batch(statements);
  await bumpVersion(env,"sidebar_version");
  await audit(env,user,"update","sidebar_item",id,b);
  return responseJson({ok:true});
}

async function stats(request, env, user) {
  const url=new URL(request.url);
  const period=["total","today","week"].includes(url.searchParams.get("period"))?url.searchParams.get("period"):"total";
  const fromRaw=String(url.searchParams.get("from")||"").trim();
  const from=(period!=="total" && /^\d{4}-\d{2}-\d{2}T/.test(fromRaw))?fromRaw:null;

  const salesOnly=normalizedRole(user.role)==="sales";
  const ownerSql=salesOnly?" AND c.assigned_user_id=?":"";
  const ownerBind=salesOnly?[user.id]:[];
  const createdPeriodSql=from?" AND c.created_at>=?":"";
  const createdBind=from?[from]:[];

  const base=await env.DB.prepare(
    `SELECT COUNT(*) total
     FROM customers c
     WHERE c.deleted_at IS NULL AND c.archived=0${ownerSql}${createdPeriodSql}`
  ).bind(...ownerBind,...createdBind).first();

  let completed;
  if(from){
    completed=await env.DB.prepare(
      `SELECT COUNT(*) n
       FROM customers c
       WHERE c.deleted_at IS NULL
         AND c.archived=0
         AND c.progress_percent=100
         ${salesOnly?"AND c.assigned_user_id=?":""}
         AND (SELECT MAX(cp.completed_at) FROM customer_progress cp
              WHERE cp.customer_id=c.id AND cp.completed=1) >= ?`
    ).bind(...ownerBind,from).first();
  }else{
    completed=await env.DB.prepare(
      `SELECT COUNT(*) n
       FROM customers c
       WHERE c.deleted_at IS NULL
         AND c.archived=0
         AND c.progress_percent=100
         ${salesOnly?"AND c.assigned_user_id=?":""}`
    ).bind(...ownerBind).first();
  }

  const todayFromRaw=String(url.searchParams.get("todayFrom")||"").trim();
  const todayFrom=/^\d{4}-\d{2}-\d{2}T/.test(todayFromRaw)?todayFromRaw:new Date(new Date().setUTCHours(0,0,0,0)).toISOString();
  const today=await env.DB.prepare(
    `SELECT COUNT(*) n FROM customers c
      WHERE c.deleted_at IS NULL AND c.archived=0${ownerSql} AND c.created_at>=?`
  ).bind(...ownerBind,todayFrom).first();

  const progressRows=await env.DB.prepare(
    `SELECT cp.progress_id, COUNT(DISTINCT cp.customer_id) n
     FROM customer_progress cp
     JOIN customers c ON c.id=cp.customer_id
     WHERE cp.completed=1
       AND c.deleted_at IS NULL
       AND c.archived=0
       ${salesOnly?"AND c.assigned_user_id=?":""}
       ${from?"AND cp.completed_at>=?":""}
     GROUP BY cp.progress_id`
  ).bind(...ownerBind,...createdBind).all();

  const progressCounts={};
  for(const row of progressRows.results||[])progressCounts[row.progress_id]=Number(row.n||0);

  let sales=[];
  if(normalizedRole(user.role)==="admin"){
    const r=await env.DB.prepare(
      `SELECT u.id,u.display_name,COUNT(c.id) customer_count,
       COALESCE(ROUND(AVG(c.progress_percent)),0) avg_progress
       FROM users u
       LEFT JOIN customers c ON c.assigned_user_id=u.id
         AND c.deleted_at IS NULL
         AND c.archived=0
         ${from?"AND c.created_at>=?":""}
       WHERE u.role='sales' AND u.active=1
       GROUP BY u.id,u.display_name
       ORDER BY customer_count DESC,u.display_name`
    ).bind(...createdBind).all();
    sales=r.results||[];
  }

  return responseJson({ok:true,period,from:from||null,summary:{
    total:Number(base?.total||0),
    today:Number(today?.n||0),
    completed:Number(completed?.n||0),
    archived:0
  },progressCounts,sales});
}


async function statsBundle(request,env,user){
  const url=new URL(request.url);
  const validIso=v=>/^\d{4}-\d{2}-\d{2}T/.test(String(v||""));
  const todayFrom=validIso(url.searchParams.get("todayFrom"))?String(url.searchParams.get("todayFrom")):new Date(new Date().setUTCHours(0,0,0,0)).toISOString();
  const weekFrom=validIso(url.searchParams.get("weekFrom"))?String(url.searchParams.get("weekFrom")):todayFrom;
  const monthFrom=validIso(url.searchParams.get("monthFrom"))?String(url.searchParams.get("monthFrom")):todayFrom;

  const salesOnly=normalizedRole(user.role)==="sales";
  const ownerClause=salesOnly?" AND c.assigned_user_id=?":"";
  const ownerBind=salesOnly?[user.id]:[];

  const [customers,completed,progressRows]=await Promise.all([
    env.DB.prepare(
      `SELECT
        COUNT(*) total,
        SUM(CASE WHEN c.created_at>=? THEN 1 ELSE 0 END) today,
        SUM(CASE WHEN c.created_at>=? THEN 1 ELSE 0 END) week,
        SUM(CASE WHEN c.created_at>=? THEN 1 ELSE 0 END) month
       FROM customers c
       WHERE c.deleted_at IS NULL AND c.archived=0${ownerClause}`
    ).bind(todayFrom,weekFrom,monthFrom,...ownerBind).first(),

    env.DB.prepare(
      `WITH completed_dates AS (
        SELECT c.id,MAX(cp.completed_at) completed_at
        FROM customers c
        JOIN customer_progress cp ON cp.customer_id=c.id AND cp.completed=1
        WHERE c.deleted_at IS NULL
          AND c.archived=0
          AND c.progress_percent=100
          ${salesOnly?"AND c.assigned_user_id=?":""}
        GROUP BY c.id
      )
      SELECT
        COUNT(*) total,
        SUM(CASE WHEN completed_at>=? THEN 1 ELSE 0 END) today,
        SUM(CASE WHEN completed_at>=? THEN 1 ELSE 0 END) week,
        SUM(CASE WHEN completed_at>=? THEN 1 ELSE 0 END) month
      FROM completed_dates`
    ).bind(...ownerBind,todayFrom,weekFrom,monthFrom).first(),

    env.DB.prepare(
      `SELECT cp.progress_id,
        COUNT(DISTINCT cp.customer_id) total,
        COUNT(DISTINCT CASE WHEN cp.completed_at>=? THEN cp.customer_id END) today,
        COUNT(DISTINCT CASE WHEN cp.completed_at>=? THEN cp.customer_id END) week,
        COUNT(DISTINCT CASE WHEN cp.completed_at>=? THEN cp.customer_id END) month
       FROM customer_progress cp
       JOIN customers c ON c.id=cp.customer_id
       WHERE cp.completed=1
         AND c.deleted_at IS NULL
         AND c.archived=0
         ${salesOnly?"AND c.assigned_user_id=?":""}
       GROUP BY cp.progress_id`
    ).bind(todayFrom,weekFrom,monthFrom,...ownerBind).all()
  ]);

  let salesRows=[];
  if(normalizedRole(user.role)==="admin"){
    const salesResult=await env.DB.prepare(
      `SELECT u.id,u.display_name,
        COUNT(c.id) total_count,
        SUM(CASE WHEN c.created_at>=? THEN 1 ELSE 0 END) today_count,
        SUM(CASE WHEN c.created_at>=? THEN 1 ELSE 0 END) week_count,
        SUM(CASE WHEN c.created_at>=? THEN 1 ELSE 0 END) month_count,
        COALESCE(ROUND(AVG(c.progress_percent)),0) avg_total,
        COALESCE(ROUND(AVG(CASE WHEN c.created_at>=? THEN c.progress_percent END)),0) avg_today,
        COALESCE(ROUND(AVG(CASE WHEN c.created_at>=? THEN c.progress_percent END)),0) avg_week,
        COALESCE(ROUND(AVG(CASE WHEN c.created_at>=? THEN c.progress_percent END)),0) avg_month
       FROM users u
       LEFT JOIN customers c ON c.assigned_user_id=u.id
         AND c.deleted_at IS NULL
         AND c.archived=0
       WHERE u.role='sales' AND u.active=1
       GROUP BY u.id,u.display_name
       ORDER BY total_count DESC,u.display_name`
    ).bind(todayFrom,weekFrom,monthFrom,todayFrom,weekFrom,monthFrom).all();
    salesRows=salesResult.results||[];
  }

  const progressByPeriod={total:{},today:{},week:{},month:{}};
  for(const row of progressRows.results||[]){
    progressByPeriod.total[row.progress_id]=Number(row.total||0);
    progressByPeriod.today[row.progress_id]=Number(row.today||0);
    progressByPeriod.week[row.progress_id]=Number(row.week||0);
    progressByPeriod.month[row.progress_id]=Number(row.month||0);
  }

  const salesByPeriod={total:[],today:[],week:[],month:[]};
  for(const row of salesRows){
    salesByPeriod.total.push({id:row.id,display_name:row.display_name,customer_count:Number(row.total_count||0),avg_progress:Number(row.avg_total||0)});
    salesByPeriod.today.push({id:row.id,display_name:row.display_name,customer_count:Number(row.today_count||0),avg_progress:Number(row.avg_today||0)});
    salesByPeriod.week.push({id:row.id,display_name:row.display_name,customer_count:Number(row.week_count||0),avg_progress:Number(row.avg_week||0)});
    salesByPeriod.month.push({id:row.id,display_name:row.display_name,customer_count:Number(row.month_count||0),avg_progress:Number(row.avg_month||0)});
  }

  const makePeriod=(key)=>({
    summary:{
      total:Number(customers?.[key]||0),
      today:Number(customers?.today||0),
      completed:Number(completed?.[key]||0),
      archived:0
    },
    progressCounts:progressByPeriod[key],
    sales:salesByPeriod[key]
  });

  return responseJson({
    ok:true,
    boundaries:{todayFrom,weekFrom,monthFrom},
    periods:{
      total:makePeriod("total"),
      today:makePeriod("today"),
      week:makePeriod("week"),
      month:makePeriod("month")
    }
  });
}

async function capacity(env) {
  const config=await getSystemSetting(env,"capacity_config",{
    provider:"Cloudflare",database:"D1",free_single_db_mb:500,free_account_gb:5,
    free_rows_read_day:5000000,free_rows_write_day:100000,free_worker_requests_day:100000,
    paid_base_usd_month:5,warning_percent:70,upgrade_percent:85,urgent_percent:95,
    upgrade_url:"https://dash.cloudflare.com/",pricing_checked:"2026-10-01"
  });
  const c=await env.DB.prepare("SELECT COUNT(*) n FROM customers WHERE deleted_at IS NULL").first();
  const core=await env.DB.prepare(
    `SELECT COALESCE(SUM(LENGTH(id)+LENGTH(name)+COALESCE(LENGTH(assigned_user_id),0)+LENGTH(created_at)+LENGTH(updated_at)+96),0) bytes
     FROM customers`
  ).first();
  const vals=await env.DB.prepare(
    "SELECT COALESCE(SUM(LENGTH(customer_id)+LENGTH(field_id)+LENGTH(value)+48),0) bytes FROM customer_values"
  ).first();
  const logs=await env.DB.prepare(
    "SELECT COALESCE(SUM(LENGTH(id)+LENGTH(action)+LENGTH(entity_type)+COALESCE(LENGTH(detail_json),0)+72),0) bytes FROM audit_logs"
  ).first();
  const estimatedBytes=Math.round((Number(core?.bytes||0)+Number(vals?.bytes||0)+Number(logs?.bytes||0))*1.8);
  const usedMb=estimatedBytes/1024/1024;
  const maxMb=Number(config.free_single_db_mb||500);
  const percent=maxMb>0?Math.min(100,usedMb/maxMb*100):0;
  let level="normal",message="当前容量正常，暂时不需要付费。";
  if(percent>=Number(config.urgent_percent||95)){level="urgent";message="数据库容量非常接近当前免费上限，建议尽快升级。";}
  else if(percent>=Number(config.upgrade_percent||85)){level="upgrade";message="数据库容量已经较高，建议准备升级套餐。";}
  else if(percent>=Number(config.warning_percent||70)){level="warning";message="数据库容量开始增加，目前仍可正常使用。";}
  return responseJson({ok:true,
    customerCount:Number(c?.n||0),
    estimatedMb:Number(usedMb.toFixed(2)),
    freeSingleDatabaseMb:maxMb,
    percent:Number(percent.toFixed(2)),
    level,message,config
  });
}

async function salesOptions(env){
  const r=await env.DB.prepare(
    `SELECT id,username,display_name,active,created_at,updated_at
     FROM users
     WHERE role='sales'
     ORDER BY active DESC,display_name,id`
  ).all();
  return responseJson({ok:true,items:r.results||[]});
}

async function usersList(request,env) {
  const url=new URL(request.url);
  const page=safeInt(url.searchParams.get("page"),1,1,1000000);
  const limit=safeInt(url.searchParams.get("limit"),50,1,100);
  const offset=(page-1)*limit;
  const totalRow=await env.DB.prepare("SELECT COUNT(*) n FROM users").first();
  const total=Number(totalRow?.n||0);
  const pages=Math.max(1,Math.ceil(total/limit));
  const r=await env.DB.prepare(
    "SELECT id,username,display_name,role,active,created_at,updated_at FROM users ORDER BY role,display_name,id LIMIT ? OFFSET ?"
  ).bind(limit,offset).all();
  return responseJson({ok:true,items:r.results||[],page,limit,total,pages});
}

async function createUser(request, env, admin) {
  const b=await readBody(request);
  const username=String(b.username||"").trim();
  const displayName=String(b.displayName||"").trim();
  const password=String(b.password||"");
  const role=normalizedRole(b.role)||"sales";

  if(!["admin","sales"].includes(role)) return fail("账号角色无效");
  if(username.length<3||!displayName||password.length<8) return fail("账号至少3位、姓名不能为空、密码至少8位");

  const exists=await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first();
  if(exists) return fail("这个账号已经存在",409);

  const salt=newSalt();
  const iterations=100000;
  const hash=await derivePassword(password,salt,iterations);
  const id=uid("u_"),t=now();

  await env.DB.prepare(
    `INSERT INTO users(id,username,display_name,password_hash,password_salt,password_iterations,role,active,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).bind(id,username,displayName,hash,salt,iterations,role,1,t,t).run();

  await audit(env,admin,"create","user",id,{username,displayName,role});
  return responseJson({ok:true,id,role},201);
}


async function updateUser(request,env,admin,id){
  const old=await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
  if(!old)return fail("账号不存在",404);
  const b=await readBody(request),t=now();
  let displayName=b.displayName!==undefined?String(b.displayName).trim():old.display_name;
  let active=b.active!==undefined?(b.active?1:0):old.active;
  if(id===admin.id && !active) return fail("不能停用当前登录的管理员账号");
  if(b.password!==undefined && String(b.password).length>0){
    const password=String(b.password);
    if(password.length<8)return fail("新密码至少8位");
    const salt=newSalt(),iterations=100000,hash=await derivePassword(password,salt,iterations);
    await env.DB.prepare(
      "UPDATE users SET display_name=?,active=?,password_hash=?,password_salt=?,password_iterations=?,updated_at=? WHERE id=?"
    ).bind(displayName,active,hash,salt,iterations,t,id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
  }else{
    await env.DB.prepare("UPDATE users SET display_name=?,active=?,updated_at=? WHERE id=?").bind(displayName,active,t,id).run();
  }
  await audit(env,admin,"update","user",id,{displayName,active:!!active,passwordReset:!!b.password});
  return responseJson({ok:true});
}

async function importChunk(request,env,user){
  const body=await readBody(request);
  if(body?.format!=="MS007-BUSINESS-BACKUP" || !body?.section || !Array.isArray(body.rows)) return fail("导入分片格式不正确");
  const rows=body.rows.slice(0,100);
  const section=String(body.section);
  const t=now();
  const stmts=[];

  if(section==="users"){
    for(const u of rows){
      if(u.role!=="sales") continue;
      const exists=await env.DB.prepare("SELECT id FROM users WHERE id=? OR username=?").bind(u.id,u.username).first();
      if(!exists){
        const salt=newSalt(),hash=await derivePassword(uid("disabled_"),salt,100000);
        stmts.push(env.DB.prepare(
          `INSERT INTO users(id,username,display_name,password_hash,password_salt,password_iterations,role,active,created_at,updated_at)
           VALUES(?,?,?,?,?,100000,'sales',0,?,?)`
        ).bind(u.id,u.username,u.display_name,hash,salt,u.created_at||t,t));
      }
    }
  } else if(section==="fieldDefinitions"){
    for(const x of rows) stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO field_definitions(id,field_key,label,field_type,required,enabled,list_visible,list_sort_order,sort_order,options_json,searchable,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(x.id,x.field_key,x.label,x.field_type,x.required,x.enabled,x.list_visible,x.list_sort_order,x.sort_order,x.options_json,x.searchable,x.created_at||t,x.updated_at||t));
  } else if(section==="progressDefinitions"){
    for(const x of rows) stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO progress_definitions(id,label,description,enabled,sort_order,color,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).bind(x.id,x.label,x.description,x.enabled,x.sort_order,x.color,x.created_at||t,x.updated_at||t));
  } else if(section==="customers"){
    for(const x of rows) stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO customers(
        id,assigned_user_id,name,progress_done,progress_total,progress_percent,archived,deleted_at,created_by_id,created_at,updated_at
       ) VALUES(
        ?,
        CASE WHEN ? IS NOT NULL AND EXISTS(SELECT 1 FROM users WHERE id=?) THEN ? ELSE NULL END,
        ?,?,?,?,?,?,
        CASE WHEN ? IS NOT NULL AND EXISTS(SELECT 1 FROM users WHERE id=?) THEN ? ELSE ? END,
        ?,?
       )`
    ).bind(
      x.id,
      x.assigned_user_id,x.assigned_user_id,x.assigned_user_id,
      x.name,x.progress_done||0,x.progress_total||0,x.progress_percent||0,x.archived||0,x.deleted_at||null,
      x.created_by_id,x.created_by_id,x.created_by_id,user.id,
      x.created_at||t,x.updated_at||t
    ));
  } else if(section==="customerValues"){
    for(const x of rows) stmts.push(env.DB.prepare(
      "INSERT OR REPLACE INTO customer_values(customer_id,field_id,value,updated_at) VALUES(?,?,?,?)"
    ).bind(x.customer_id,x.field_id,x.value,x.updated_at||t));
  } else if(section==="customerProgress"){
    for(const x of rows) stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO customer_progress(customer_id,progress_id,completed,completed_by,completed_at)
       VALUES(?,?,?,CASE WHEN ? IS NOT NULL AND EXISTS(SELECT 1 FROM users WHERE id=?) THEN ? ELSE NULL END,?)`
    ).bind(x.customer_id,x.progress_id,x.completed,x.completed_by,x.completed_by,x.completed_by,x.completed_at));
  } else if(section==="sidebarCategories"){
    for(const x of rows) stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO sidebar_categories(id,audience,label,sort_order,created_at,updated_at)
       VALUES(?,?,?,?,?,?)`
    ).bind(x.id,x.audience,x.label,x.sort_order,x.created_at||t,x.updated_at||t));
  } else if(section==="sidebarItems"){
    for(const x of rows) stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO sidebar_items(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(x.id,x.audience,x.label,x.icon,x.url,x.target,x.enabled,x.sort_order,x.group_label,x.created_at||t,x.updated_at||t));
  } else if(section==="sidebarItemCategories"){
    for(const x of rows) stmts.push(env.DB.prepare(
      "INSERT OR REPLACE INTO sidebar_item_categories(item_id,audience,category_id) VALUES(?,?,?)"
    ).bind(x.item_id,x.audience,x.category_id));
  } else if(section==="listColumns"){
    for(const x of rows) stmts.push(env.DB.prepare(
      "INSERT OR REPLACE INTO list_columns(id,audience,column_key,field_id,label,enabled,sort_order) VALUES(?,?,?,?,?,?,?)"
    ).bind(x.id,x.audience,x.column_key,x.field_id,x.label,x.enabled,x.sort_order));
  } else if(section==="dashboardWidgets"){
    for(const x of rows) stmts.push(env.DB.prepare(
      "INSERT OR REPLACE INTO dashboard_widgets(id,audience,widget_type,title,enabled,sort_order,config_json) VALUES(?,?,?,?,?,?,?)"
    ).bind(x.id,x.audience,x.widget_type,x.title,x.enabled,x.sort_order,x.config_json||"{}"));
  } else if(section==="systemSettings"){
    for(const x of rows) stmts.push(env.DB.prepare(
      `INSERT INTO system_settings(setting_key,value_json,updated_at) VALUES(?,?,?)
       ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`
    ).bind(x.setting_key,x.value_json,x.updated_at||t));
  } else {
    return fail("未知的备份数据部分");
  }

  if(stmts.length) await env.DB.batch(stmts);
  return responseJson({ok:true,section,processed:rows.length});
}

async function finishImport(env,user){
  await recalcAllProgress(env);
  await bumpVersion(env,"sidebar_version");
  await audit(env,user,"import","business_data",null,{mode:"chunked"});
  return responseJson({ok:true,message:"数据恢复完成"});
}

async function softDeleteCustomer(env,user,id){
  const row=await env.DB.prepare("SELECT id,assigned_user_id FROM customers WHERE id=? AND deleted_at IS NULL").bind(id).first();
  if(!row)return fail("客户不存在",404);
  if(normalizedRole(user.role)==="sales" && row.assigned_user_id!==user.id) return fail("无权删除该客户",403);
  await env.DB.prepare("UPDATE customers SET deleted_at=?,updated_at=? WHERE id=?").bind(now(),now(),id).run();
  await audit(env,user,"delete","customer",id,{soft:true});
  return responseJson({ok:true});
}


async function recycleList(request,env) {
  const url=new URL(request.url);
  const page=safeInt(url.searchParams.get("page"),1,1,1000000);
  const limit=safeInt(url.searchParams.get("limit"),50,1,100);
  const q=String(url.searchParams.get("q")||"").trim();
  const owner=String(url.searchParams.get("owner")||"").trim();
  const where=["c.deleted_at IS NOT NULL"];
  const binds=[];

  if(q){
    where.push("c.name LIKE ?");
    binds.push("%"+q+"%");
  }
  if(owner==="__none__"){
    where.push("c.assigned_user_id IS NULL");
  }else if(owner){
    where.push("c.assigned_user_id=?");
    binds.push(owner);
  }

  const whereSql=where.join(" AND ");
  const totalRow=await env.DB.prepare(
    `SELECT COUNT(*) n FROM customers c WHERE ${whereSql}`
  ).bind(...binds).first();
  const total=Number(totalRow?.n||0);
  const pages=Math.max(1,Math.ceil(total/limit));
  const offset=(page-1)*limit;

  const [r,owners]=await Promise.all([
    env.DB.prepare(
      `SELECT c.id,c.name,c.deleted_at,c.updated_at,c.assigned_user_id,u.display_name owner_name
       FROM customers c
       LEFT JOIN users u ON u.id=c.assigned_user_id
       WHERE ${whereSql}
       ORDER BY c.deleted_at DESC,c.id DESC
       LIMIT ? OFFSET ?`
    ).bind(...binds,limit,offset).all(),
    env.DB.prepare(
      "SELECT id,display_name,active FROM users WHERE role='sales' ORDER BY display_name,id"
    ).all()
  ]);

  return responseJson({
    ok:true,
    items:r.results||[],
    owners:owners.results||[],
    page,limit,total,pages
  });
}

async function restoreCustomer(env,user,id){
  const row=await env.DB.prepare("SELECT id FROM customers WHERE id=? AND deleted_at IS NOT NULL").bind(id).first();
  if(!row)return fail("回收站中找不到这个客户",404);
  await env.DB.prepare("UPDATE customers SET deleted_at=NULL,updated_at=? WHERE id=?").bind(now(),id).run();
  await audit(env,user,"restore","customer",id,{});
  return responseJson({ok:true});
}

async function auditList(request,env){
  const url=new URL(request.url);
  const page=safeInt(url.searchParams.get("page"),1,1,1000000);
  const limit=safeInt(url.searchParams.get("limit"),50,1,100);
  const actor=String(url.searchParams.get("actor")||"").trim();
  const action=String(url.searchParams.get("action")||"").trim();
  const from=String(url.searchParams.get("from")||"").trim();
  const to=String(url.searchParams.get("to")||"").trim();

  const where=["1=1"];
  const binds=[];
  if(actor==="__system__")where.push("a.actor_user_id IS NULL");
  else if(actor){where.push("a.actor_user_id=?");binds.push(actor);}
  if(action){where.push("a.action=?");binds.push(action);}
  if(from){where.push("a.created_at>=?");binds.push(from);}
  if(to){where.push("a.created_at<?");binds.push(to);}

  const whereSql=where.join(" AND ");
  const totalRow=await env.DB.prepare(
    `SELECT COUNT(*) n FROM audit_logs a WHERE ${whereSql}`
  ).bind(...binds).first();
  const total=Number(totalRow?.n||0);
  const pages=Math.max(1,Math.ceil(total/limit));
  const offset=(page-1)*limit;

  const [r,actors,actions]=await Promise.all([
    env.DB.prepare(
      `SELECT a.id,a.action,a.entity_type,a.entity_id,a.detail_json,a.created_at,u.display_name actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id=a.actor_user_id
       WHERE ${whereSql}
       ORDER BY a.created_at DESC,a.id DESC
       LIMIT ? OFFSET ?`
    ).bind(...binds,limit,offset).all(),
    env.DB.prepare(
      "SELECT id,display_name,role FROM users ORDER BY role,display_name,id"
    ).all(),
    env.DB.prepare(
      "SELECT DISTINCT action FROM audit_logs ORDER BY action"
    ).all()
  ]);

  return responseJson({
    ok:true,
    items:(r.results||[]).map(x=>({
      ...x,
      detail:(()=>{try{return JSON.parse(x.detail_json||"{}")}catch{return{}}})()
    })),
    actors:actors.results||[],
    actions:(actions.results||[]).map(x=>x.action),
    page,limit,total,pages
  });
}

async function exportBusinessData(env,user){
  const [users,customers,fields,values,progressDefs,customerProgress,sidebars,sidebarCategories,sidebarItemCategories,listCols,dash,settings] = await Promise.all([
    env.DB.prepare("SELECT id,username,display_name,role,active,created_at,updated_at FROM users ORDER BY created_at").all(),
    env.DB.prepare("SELECT * FROM customers ORDER BY created_at").all(),
    env.DB.prepare("SELECT * FROM field_definitions ORDER BY sort_order").all(),
    env.DB.prepare("SELECT * FROM customer_values").all(),
    env.DB.prepare("SELECT * FROM progress_definitions ORDER BY sort_order").all(),
    env.DB.prepare("SELECT * FROM customer_progress").all(),
    env.DB.prepare("SELECT * FROM sidebar_items ORDER BY audience,sort_order").all(),
    env.DB.prepare("SELECT * FROM sidebar_categories ORDER BY audience,sort_order,label").all(),
    env.DB.prepare("SELECT * FROM sidebar_item_categories ORDER BY audience,category_id,item_id").all(),
    env.DB.prepare("SELECT * FROM list_columns ORDER BY audience,sort_order").all(),
    env.DB.prepare("SELECT * FROM dashboard_widgets ORDER BY audience,sort_order").all(),
    env.DB.prepare("SELECT setting_key,value_json,updated_at FROM system_settings ORDER BY setting_key").all()
  ]);
  await audit(env,user,"export","business_data",null,{});
  return responseJson({
    ok:true,
    format:"MS007-BUSINESS-BACKUP",
    version:2,
    exportedAt:now(),
    data:{
      users:users.results||[],
      customers:customers.results||[],
      fieldDefinitions:fields.results||[],
      customerValues:values.results||[],
      progressDefinitions:progressDefs.results||[],
      customerProgress:customerProgress.results||[],
      sidebarItems:sidebars.results||[],
      sidebarCategories:sidebarCategories.results||[],
      sidebarItemCategories:sidebarItemCategories.results||[],
      listColumns:listCols.results||[],
      dashboardWidgets:dash.results||[],
      systemSettings:settings.results||[]
    }
  });
}

async function importBusinessData(request,env,user){
  const body=await readBody(request);
  if(body?.format!=="MS007-BUSINESS-BACKUP" || !body?.data) return fail("备份文件格式不正确");
  const d=body.data;
  const tx=[];
  const t=now();
  // Do not import admin passwords/sessions. Existing users remain; sales users are upserted with disabled login until password reset.
  for(const u of d.users||[]){
    if(u.role!=="sales") continue;
    const exists=await env.DB.prepare("SELECT id FROM users WHERE id=? OR username=?").bind(u.id,u.username).first();
    if(!exists){
      const salt=newSalt(), hash=await derivePassword(uid("disabled_"),salt,100000);
      tx.push(env.DB.prepare(
        `INSERT INTO users(id,username,display_name,password_hash,password_salt,password_iterations,role,active,created_at,updated_at)
         VALUES(?,?,?,?,?,100000,'sales',0,?,?)`
      ).bind(u.id,u.username,u.display_name,hash,salt,u.created_at||t,t));
    }
  }
  for(const f of d.fieldDefinitions||[]) tx.push(env.DB.prepare(
    `INSERT OR REPLACE INTO field_definitions(id,field_key,label,field_type,required,enabled,list_visible,list_sort_order,sort_order,options_json,searchable,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(f.id,f.field_key,f.label,f.field_type,f.required,f.enabled,f.list_visible,f.list_sort_order,f.sort_order,f.options_json,f.searchable,f.created_at||t,f.updated_at||t));
  for(const p of d.progressDefinitions||[]) tx.push(env.DB.prepare(
    `INSERT OR REPLACE INTO progress_definitions(id,label,description,enabled,sort_order,color,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?)`
  ).bind(p.id,p.label,p.description,p.enabled,p.sort_order,p.color,p.created_at||t,p.updated_at||t));
  for(const x of d.customers||[]) tx.push(env.DB.prepare(
    `INSERT OR REPLACE INTO customers(id,assigned_user_id,name,progress_done,progress_total,progress_percent,archived,deleted_at,created_by_id,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(x.id,x.assigned_user_id,x.name,x.progress_done,x.progress_total,x.progress_percent,x.archived,x.deleted_at,x.created_by_id,x.created_at,x.updated_at));
  if(tx.length) await env.DB.batch(tx);

  const batch2=[];
  for(const x of d.customerValues||[]) batch2.push(env.DB.prepare(
    "INSERT OR REPLACE INTO customer_values(customer_id,field_id,value,updated_at) VALUES(?,?,?,?)"
  ).bind(x.customer_id,x.field_id,x.value,x.updated_at||t));
  for(const x of d.customerProgress||[]) batch2.push(env.DB.prepare(
    "INSERT OR REPLACE INTO customer_progress(customer_id,progress_id,completed,completed_by,completed_at) VALUES(?,?,?,?,?)"
  ).bind(x.customer_id,x.progress_id,x.completed,x.completed_by,x.completed_at));
  if(batch2.length) await env.DB.batch(batch2);

  const batch3=[];
  for(const x of d.sidebarCategories||[]) batch3.push(env.DB.prepare(
    `INSERT OR REPLACE INTO sidebar_categories(id,audience,label,sort_order,created_at,updated_at)
     VALUES(?,?,?,?,?,?)`
  ).bind(x.id,x.audience,x.label,x.sort_order,x.created_at||t,x.updated_at||t));
  for(const x of d.sidebarItems||[]) batch3.push(env.DB.prepare(
    `INSERT OR REPLACE INTO sidebar_items(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(x.id,x.audience,x.label,x.icon,x.url,x.target,x.enabled,x.sort_order,x.group_label,x.created_at||t,x.updated_at||t));
  for(const x of d.sidebarItemCategories||[]) batch3.push(env.DB.prepare(
    "INSERT OR REPLACE INTO sidebar_item_categories(item_id,audience,category_id) VALUES(?,?,?)"
  ).bind(x.item_id,x.audience,x.category_id));
  for(const x of d.listColumns||[]) batch3.push(env.DB.prepare(
    "INSERT OR REPLACE INTO list_columns(id,audience,column_key,field_id,label,enabled,sort_order) VALUES(?,?,?,?,?,?,?)"
  ).bind(x.id,x.audience,x.column_key,x.field_id,x.label,x.enabled,x.sort_order));
  for(const x of d.dashboardWidgets||[]) batch3.push(env.DB.prepare(
    "INSERT OR REPLACE INTO dashboard_widgets(id,audience,widget_type,title,enabled,sort_order,config_json) VALUES(?,?,?,?,?,?,?)"
  ).bind(x.id,x.audience,x.widget_type,x.title,x.enabled,x.sort_order,x.config_json||"{}"));
  for(const x of d.systemSettings||[]) batch3.push(env.DB.prepare(
    `INSERT INTO system_settings(setting_key,value_json,updated_at) VALUES(?,?,?)
     ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`
  ).bind(x.setting_key,x.value_json,x.updated_at||t));
  if(batch3.length) await env.DB.batch(batch3);
  await recalcAllProgress(env);
  await bumpVersion(env,"sidebar_version");
  await audit(env,user,"import","business_data",null,{sourceExportedAt:body.exportedAt||null});
  return responseJson({ok:true,message:"业务数据已导入。备份中的业务员账号为安全起见会保持停用，需要管理员重新设置密码并启用。"});
}

async function api(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/health") return responseJson({
    ok:true,
    app:env.APP_NAME||"MS007",
    version:env.APP_VERSION||"dev",
    channel:env.DEPLOY_CHANNEL||"development"
  });
  if (path === "/api/bootstrap-status" && method === "GET") return responseJson({ ok:true, needsBootstrap: await bootstrapStatus(env) });
  if (path === "/api/bootstrap-token-check" && method === "GET") {
    const token = request.headers.get("x-bootstrap-token") || "";
    const configured = !!env.BOOTSTRAP_TOKEN;
    const valid = configured && token === env.BOOTSTRAP_TOKEN;
    return responseJson({ ok:true, configured, valid });
  }
  if (path === "/api/bootstrap-diagnostic" && method === "POST") return bootstrapDiagnostic(request, env);
  if (path === "/api/bootstrap" && method === "POST") return handleBootstrap(request, env);
  if (path === "/api/login" && method === "POST") return handleLogin(request, env);

  const user = await authUser(request, env);
  if (!user) return fail("请先登录", 401, "UNAUTHENTICATED");

  if (path === "/api/me" && method === "GET") return responseJson({ok:true,user:{
    id:user.id,username:user.username,displayName:user.display_name,role:normalizedRole(user.role)
  }});
  if (path === "/api/logout" && method === "POST") return handleLogout(request, env, user);
  if (path === "/api/sidebar" && method === "GET") return listSidebar(env,user);
  if (path === "/api/registration-layout" && method === "GET") return getRegistrationLayout(env);
  if (path === "/api/list-columns" && method === "GET") return listColumns(env,user);
  if (path === "/api/dashboard-widgets" && method === "GET") return dashboardWidgets(env,user);
  if (path === "/api/fields" && method === "GET") return listFields(env,user);
  if (path === "/api/progress-defs" && method === "GET") return listProgressDefs(env,user);
  if (path === "/api/customers" && method === "GET") return listCustomers(request,env,user);
  if (path === "/api/customers" && method === "POST") return createCustomer(request,env,user);
  if (path === "/api/stats-bundle" && method === "GET") return statsBundle(request,env,user);
  if (path === "/api/stats" && method === "GET") return stats(request,env,user);

  let m=path.match(/^\/api\/customers\/([^/]+)$/);
  if(m && method==="GET") return getCustomer(env,user,m[1]);
  if(m && method==="PATCH") return updateCustomer(request,env,user,m[1]);
  if(m && method==="PUT") return saveCustomerAtomic(request,env,user,m[1],ctx);
  if(m && method==="DELETE") return softDeleteCustomer(env,user,m[1]);
  m=path.match(/^\/api\/customers\/([^/]+)\/progress\/([^/]+)$/);
  if(m && method==="PUT") return toggleProgress(request,env,user,m[1],m[2],ctx);

  if (!requireRole(user,"admin")) return fail("需要管理员权限",403,"ADMIN_REQUIRED");

  if (path === "/api/admin/users" && method === "GET") return usersList(request,env);
  if (path === "/api/admin/sales-options" && method === "GET") return salesOptions(env);
  if (path === "/api/admin/users" && method === "POST") return createUser(request,env,user);
  m=path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if(m && method==="PATCH") return updateUser(request,env,user,m[1]);
  if (path === "/api/admin/fields" && method === "POST") return createField(request,env,user);
  m=path.match(/^\/api\/admin\/fields\/([^/]+)$/);
  if(m && method==="PATCH") return updateField(request,env,user,m[1]);
  if(m && method==="DELETE"){
    await env.DB.prepare("UPDATE field_definitions SET enabled=0,updated_at=? WHERE id=?").bind(now(),m[1]).run();
    await audit(env,user,"disable","field",m[1],{});
    return responseJson({ok:true});
  }
  m=path.match(/^\/api\/admin\/fields\/([^/]+)\/hard-delete$/);
  if(m && method==="DELETE") return hardDeleteField(env,user,m[1]);

  if (path === "/api/admin/progress" && method === "POST") return createProgressDef(request,env,user);
  m=path.match(/^\/api\/admin\/progress\/([^/]+)$/);
  if(m && method==="PATCH") return updateProgressDef(request,env,user,m[1]);
  if(m && method==="DELETE"){
    await env.DB.prepare("UPDATE progress_definitions SET enabled=0,updated_at=? WHERE id=?").bind(now(),m[1]).run();
    await audit(env,user,"disable","progress_definition",m[1],{});
    return responseJson({ok:true});
  }
  m=path.match(/^\/api\/admin\/progress\/([^/]+)\/hard-delete$/);
  if(m && method==="DELETE") return hardDeleteProgressDef(env,user,m[1]);

  if (path === "/api/admin/sidebar" && method === "GET") return adminSidebar(env);
  if (path === "/api/admin/sidebar" && method === "POST") return createSidebarItem(request,env,user);
  if (path === "/api/admin/sidebar-categories" && method === "POST") return createSidebarCategory(request,env,user);
  m=path.match(/^\/api\/admin\/sidebar-categories\/([^/]+)$/);
  if(m && method==="PATCH") return updateSidebarCategory(request,env,user,m[1]);
  if(m && method==="DELETE") return deleteSidebarCategory(env,user,m[1]);
  m=path.match(/^\/api\/admin\/sidebar\/([^/]+)$/);
  if(m && method==="PATCH") return updateSidebarItem(request,env,user,m[1]);
  if(m && method==="DELETE"){
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sidebar_item_categories WHERE item_id=?").bind(m[1]),
      env.DB.prepare("DELETE FROM sidebar_items WHERE id=?").bind(m[1])
    ]);
    await bumpVersion(env,"sidebar_version");
    await audit(env,user,"delete","sidebar_item",m[1],{});
    return responseJson({ok:true});
  }

  if (path === "/api/admin/capacity" && method === "GET") return capacity(env);
  if (path === "/api/admin/telegram" && method === "GET") return telegramAdminGet(env);
  if (path === "/api/admin/telegram/logs" && method === "GET") return telegramLogs(request,env);
  if (path === "/api/admin/telegram" && method === "PUT") return telegramAdminSave(request,env,user);
  if (path === "/api/admin/telegram/test" && method === "POST") return telegramAdminTest(request,env,user);
  if (path === "/api/admin/registration-layout" && method === "GET") return adminRegistrationLayout(env);
  if (path === "/api/admin/registration-layout" && method === "PUT") return saveRegistrationLayout(request,env,user);
  if (path === "/api/admin/recycle" && method === "GET") return recycleList(request,env);
  m=path.match(/^\/api\/admin\/recycle\/([^/]+)\/restore$/);
  if(m && method==="POST") return restoreCustomer(env,user,m[1]);
  if (path === "/api/admin/audit" && method === "GET") return auditList(request,env);
  if (path === "/api/admin/export" && method === "GET") return exportBusinessData(env,user);
  if (path === "/api/admin/import" && method === "POST") return importBusinessData(request,env,user);
  if (path === "/api/admin/import-chunk" && method === "POST") return importChunk(request,env,user);
  if (path === "/api/admin/import-finish" && method === "POST") return finishImport(env,user);
  if (path === "/api/admin/list-columns" && method === "GET") return adminListColumns(request,env);
  if (path === "/api/admin/list-columns" && method === "PUT") return saveListColumns(request,env,user);
  if (path === "/api/admin/dashboard-widgets" && method === "GET") return adminDashboardWidgets(request,env);
  if (path === "/api/admin/dashboard-widgets" && method === "POST") return createDashboardWidget(request,env,user);
  m=path.match(/^\/api\/admin\/dashboard-widgets\/([^/]+)$/);
  if(m && method==="PATCH") return updateDashboardWidget(request,env,user,m[1]);
  if(m && method==="DELETE"){
    await env.DB.prepare("DELETE FROM dashboard_widgets WHERE id=?").bind(m[1]).run();
    await audit(env,user,"delete","dashboard_widget",m[1],{});
    return responseJson({ok:true});
  }

  return fail("接口不存在",404,"NOT_FOUND");
}

function withSecurityHeaders(response) {
  const h = new Headers(response.headers);
  h.set("x-content-type-options","nosniff");
  h.set("referrer-policy","same-origin");
  h.set("x-frame-options","DENY");
  h.set("permissions-policy","camera=(), microphone=(), geolocation=()");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url=new URL(request.url);
      if(url.pathname.startsWith("/api/")) return withSecurityHeaders(await api(request,env,ctx));
      const asset=await env.ASSETS.fetch(request);
      return withSecurityHeaders(asset);
    } catch (e) {
      return withSecurityHeaders(responseJson({ok:false,code:"SERVER_ERROR",message:"系统暂时无法处理请求",detail:String(e?.message||e)},500));
    }
  },

  async scheduled(controller,env,ctx){
    const job=processTelegramQueue(env,{
      maxItems:12,
      maxRunMs:48000,
      allowShortWait:true
    }).catch(()=>{});
    if(ctx?.waitUntil)ctx.waitUntil(job);
    else await job;
  }
};
