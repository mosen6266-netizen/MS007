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
  const sid = parseCookies(request).sid;
  if (!sid) return null;
  const tokenHash = await sha256Hex(sid);
  const row = await env.DB.prepare(
    `SELECT u.id,u.username,u.display_name,u.role,u.active,s.expires_at
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at > ? AND u.active=1`
  ).bind(tokenHash, now()).first();
  return row || null;
}

function requireRole(user, role) {
  return user && user.role === role;
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
    "UPDATE customers SET progress_done=?,progress_total=?,progress_percent=?,updated_at=? WHERE id=?"
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
  const wantedRole = body.role === "admin" ? "admin" : body.role === "sales" ? "sales" : null;
  const u = await env.DB.prepare(
    "SELECT * FROM users WHERE username=? AND active=1"
  ).bind(username).first();
  if (!u) return fail("账号或密码不正确", 401, "LOGIN_FAILED");
  const hash = await derivePassword(password, u.password_salt, Number(u.password_iterations || 100000));
  if (hash !== u.password_hash) return fail("账号或密码不正确", 401, "LOGIN_FAILED");
  if (wantedRole && u.role !== wantedRole) return fail("该账号没有这个入口的权限", 403, "WRONG_ROLE");

  const rawToken = newSessionToken();
  const tokenHash = await sha256Hex(rawToken);
  const days = safeInt(env.SESSION_DAYS || "7", 7, 1, 30);
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)"
  ).bind(tokenHash, u.id, expires, now()).run();
  await audit(env, u, "login", "session", null, {});
  const cookie = `sid=${encodeURIComponent(rawToken)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${days * 86400}`;
  return responseJson({
    ok: true,
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role }
  }, 200, { "set-cookie": cookie });
}

async function handleLogout(request, env, user) {
  const sid = parseCookies(request).sid;
  if (sid) {
    const hash = await sha256Hex(sid);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(hash).run();
  }
  await audit(env, user, "logout", "session", null, {});
  return responseJson({ ok: true }, 200, {
    "set-cookie": "sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
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

  if (user.role === "sales") {
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

  const items = page.map(r => ({
    id: r.id,
    name: r.name,
    ownerId: r.assigned_user_id,
    ownerName: r.owner_name || "",
    progressDone: Number(r.progress_done || 0),
    progressTotal: Number(r.progress_total || 0),
    progressPercent: Number(r.progress_percent || 0),
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    values: valuesByCustomer[r.id] || {}
  }));

  return responseJson({
    ok: true,
    items,
    visibleFields,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null
  });
}

async function getCustomer(env, user, id) {
  const row = await env.DB.prepare(
    `SELECT c.*,u.display_name owner_name FROM customers c
     LEFT JOIN users u ON u.id=c.assigned_user_id
     WHERE c.id=? AND c.deleted_at IS NULL`
  ).bind(id).first();
  if (!row) return fail("客户不存在", 404, "NOT_FOUND");
  if (user.role === "sales" && row.assigned_user_id !== user.id) return fail("无权查看该客户", 403, "FORBIDDEN");

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
  const name = String(body.name || "").trim();
  if (!name) return fail("请输入客户姓名");
  let assigned = user.role === "sales" ? user.id : String(body.assignedUserId || "").trim() || null;
  if (assigned) {
    const owner = await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='sales' AND active=1").bind(assigned).first();
    if (!owner) return fail("指定的业务员不存在");
  }
  const totalRow = await env.DB.prepare("SELECT COUNT(*) n FROM progress_definitions WHERE enabled=1").first();
  const total = Number(totalRow?.n || 0);
  const id = uid("c_");
  const t = now();
  await env.DB.prepare(
    `INSERT INTO customers(id,assigned_user_id,name,progress_done,progress_total,progress_percent,archived,created_by_id,created_at,updated_at)
     VALUES(?,?,?,0,?,0,0,?,?,?)`
  ).bind(id, assigned, name, total, user.id, t, t).run();

  const values = body.values && typeof body.values === "object" ? body.values : {};
  const stmts = [];
  for (const [fieldId, value] of Object.entries(values)) {
    stmts.push(env.DB.prepare(
      "INSERT OR REPLACE INTO customer_values(customer_id,field_id,value,updated_at) VALUES(?,?,?,?)"
    ).bind(id, fieldId, String(value ?? ""), t));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await audit(env, user, "create", "customer", id, { name, assignedUserId: assigned });
  return responseJson({ ok: true, id }, 201);
}

async function updateCustomer(request, env, user, id) {
  const current = await env.DB.prepare("SELECT * FROM customers WHERE id=? AND deleted_at IS NULL").bind(id).first();
  if (!current) return fail("客户不存在", 404);
  if (user.role === "sales" && current.assigned_user_id !== user.id) return fail("无权修改该客户", 403);

  const body = await readBody(request);
  const name = body.name !== undefined ? String(body.name).trim() : current.name;
  let assigned = current.assigned_user_id;
  if (user.role === "admin" && body.assignedUserId !== undefined) assigned = body.assignedUserId || null;
  const archived = body.archived !== undefined ? (body.archived ? 1 : 0) : current.archived;
  const t = now();
  await env.DB.prepare(
    "UPDATE customers SET name=?,assigned_user_id=?,archived=?,updated_at=? WHERE id=?"
  ).bind(name, assigned, archived, t, id).run();

  const values = body.values && typeof body.values === "object" ? body.values : null;
  if (values) {
    const stmts = Object.entries(values).map(([fieldId, value]) =>
      env.DB.prepare(
        `INSERT INTO customer_values(customer_id,field_id,value,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(customer_id,field_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`
      ).bind(id, fieldId, String(value ?? ""), t)
    );
    if (stmts.length) await env.DB.batch(stmts);
  }
  await audit(env, user, "update", "customer", id, { name, assignedUserId: assigned, archived: !!archived });
  return responseJson({ ok: true });
}

async function toggleProgress(request, env, user, customerId, progressId) {
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id=? AND deleted_at IS NULL").bind(customerId).first();
  if (!customer) return fail("客户不存在", 404);
  if (user.role === "sales" && customer.assigned_user_id !== user.id) return fail("无权修改该客户", 403);

  const pd = await env.DB.prepare("SELECT id FROM progress_definitions WHERE id=? AND enabled=1").bind(progressId).first();
  if (!pd) return fail("进度项目不存在", 404);
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
  return responseJson({ ok: true, ...summary });
}

async function listFields(env, user) {
  const sql = user.role === "admin"
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

  const maxRow = await env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) AS max_sort FROM field_definitions WHERE enabled=1").first();
  const nextSort = Number(maxRow?.max_sort || 0) + 1;
  const sortOrder = b.sortOrder!==undefined ? safeInt(b.sortOrder,nextSort,0,100000) : nextSort;
  const listSortOrder = b.listSortOrder!==undefined ? safeInt(b.listSortOrder,sortOrder,0,100000) : sortOrder;

  await env.DB.prepare(
    `INSERT INTO field_definitions(id,field_key,label,field_type,required,enabled,list_visible,list_sort_order,sort_order,options_json,searchable,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id,key,label,String(b.fieldType||"text"),b.required?1:0,b.enabled===false?0:1,b.listVisible?1:0,
    listSortOrder,sortOrder,JSON.stringify(b.options||[]),
    b.searchable===false?0:1,t,t).run();
  await audit(env,user,"create","field",id,{label,sortOrder});
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

async function listProgressDefs(env, user) {
  const sql = user.role==="admin"
    ? "SELECT * FROM progress_definitions ORDER BY sort_order,label"
    : "SELECT * FROM progress_definitions WHERE enabled=1 ORDER BY sort_order,label";
  const r=await env.DB.prepare(sql).all();
  return responseJson({ok:true,items:r.results||[]});
}

async function createProgressDef(request, env, user) {
  const b=await readBody(request), label=String(b.label||"").trim();
  if(!label) return fail("请输入进度名称");
  const id=uid("p_"),t=now();
  const maxRow=await env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) AS max_sort FROM progress_definitions WHERE enabled=1").first();
  const nextSort=Number(maxRow?.max_sort||0)+1;
  const sortOrder=b.sortOrder!==undefined?safeInt(b.sortOrder,nextSort,0,100000):nextSort;
  await env.DB.prepare(
    "INSERT INTO progress_definitions(id,label,description,enabled,sort_order,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
  ).bind(id,label,String(b.description||""),b.enabled===false?0:1,sortOrder,String(b.color||"#2563eb"),t,t).run();
  await recalcAllProgress(env);
  await audit(env,user,"create","progress_definition",id,{label,sortOrder});
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
    "SELECT id,audience,column_key,field_id,label,enabled,sort_order FROM list_columns WHERE audience=? AND enabled=1 ORDER BY sort_order,label"
  ).bind(user.role).all();
  return responseJson({ok:true,items:r.results||[]});
}

async function adminListColumns(request, env) {
  const url=new URL(request.url);
  const audience=url.searchParams.get("audience")==="sales"?"sales":"admin";
  const r=await env.DB.prepare(
    "SELECT id,audience,column_key,field_id,label,enabled,sort_order FROM list_columns WHERE audience=? ORDER BY sort_order,label"
  ).bind(audience).all();
  const fields=await env.DB.prepare("SELECT id,label,field_key FROM field_definitions WHERE enabled=1 ORDER BY sort_order,label").all();
  return responseJson({ok:true,audience,items:r.results||[],fields:fields.results||[]});
}

async function saveListColumns(request, env, user) {
  const b=await readBody(request);
  const audience=b.audience==="sales"?"sales":"admin";
  const items=Array.isArray(b.items)?b.items:[];
  const statements=[env.DB.prepare("DELETE FROM list_columns WHERE audience=?").bind(audience)];
  let sort=10;
  for(const item of items){
    if(item.columnKey==="dynamic" && !item.fieldId) continue;
    statements.push(env.DB.prepare(
      "INSERT INTO list_columns(id,audience,column_key,field_id,label,enabled,sort_order) VALUES(?,?,?,?,?,?,?)"
    ).bind(uid("lc_"),audience,String(item.columnKey||"dynamic"),item.fieldId||null,String(item.label||""),item.enabled===false?0:1,sort));
    sort+=10;
  }
  await env.DB.batch(statements);
  await audit(env,user,"replace","list_columns",audience,{count:items.length});
  return responseJson({ok:true});
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
  const r=await env.DB.prepare(
    "SELECT id,audience,widget_type,title,enabled,sort_order,config_json FROM dashboard_widgets WHERE audience=? ORDER BY sort_order,title"
  ).bind(audience).all();
  return responseJson({ok:true,audience,items:r.results||[]});
}

async function createDashboardWidget(request,env,user){
  const b=await readBody(request);
  const allowed=["metric_total","metric_today","metric_complete","metric_archived","sales_breakdown"];
  const type=allowed.includes(b.widgetType)?b.widgetType:"metric_total";
  const audience=b.audience==="sales"?"sales":"admin";
  const id=uid("dw_"),t=now();
  await env.DB.prepare(
    "INSERT INTO dashboard_widgets(id,audience,widget_type,title,enabled,sort_order,config_json) VALUES(?,?,?,?,?,?,?)"
  ).bind(id,audience,type,String(b.title||"统计组件"),b.enabled===false?0:1,safeInt(b.sortOrder,100,0,100000),JSON.stringify(b.config||{})).run();
  await audit(env,user,"create","dashboard_widget",id,b);
  return responseJson({ok:true,id},201);
}

async function updateDashboardWidget(request,env,user,id){
  const old=await env.DB.prepare("SELECT * FROM dashboard_widgets WHERE id=?").bind(id).first();
  if(!old)return fail("仪表盘组件不存在",404);
  const b=await readBody(request);
  const allowed=["metric_total","metric_today","metric_complete","metric_archived","sales_breakdown"];
  const type=b.widgetType!==undefined&&allowed.includes(b.widgetType)?b.widgetType:old.widget_type;
  const audience=b.audience!==undefined?(b.audience==="sales"?"sales":"admin"):old.audience;
  await env.DB.prepare(
    "UPDATE dashboard_widgets SET audience=?,widget_type=?,title=?,enabled=?,sort_order=?,config_json=? WHERE id=?"
  ).bind(audience,type,b.title!==undefined?String(b.title):old.title,b.enabled!==undefined?(b.enabled?1:0):old.enabled,
    b.sortOrder!==undefined?safeInt(b.sortOrder,old.sort_order,0,100000):old.sort_order,
    b.config!==undefined?JSON.stringify(b.config):old.config_json,id).run();
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
  const r=await env.DB.prepare(
    "SELECT id,audience,label,icon,url,target,enabled,sort_order,group_label FROM sidebar_items WHERE enabled=1 AND (audience=? OR audience='all') ORDER BY sort_order,label"
  ).bind(user.role).all();
  const version = await getSystemSetting(env,"sidebar_version",0);
  return responseJson({ok:true,version:Number(version||0),items:r.results||[]});
}

async function adminSidebar(env) {
  const r=await env.DB.prepare("SELECT * FROM sidebar_items ORDER BY audience,sort_order,label").all();
  const version=await getSystemSetting(env,"sidebar_version",0);
  return responseJson({ok:true,version:Number(version||0),items:r.results||[]});
}

async function createSidebarItem(request, env, user) {
  const b=await readBody(request);
  if(!String(b.label||"").trim()||!String(b.url||"").trim()) return fail("按钮名称和跳转链接不能为空");
  const audience=["admin","sales","all"].includes(b.audience)?b.audience:"sales";
  const id=uid("sb_"),t=now();
  await env.DB.prepare(
    `INSERT INTO sidebar_items(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id,audience,String(b.label).trim(),String(b.icon||"link"),String(b.url).trim(),
    b.target==="new"?"new":"same",b.enabled===false?0:1,safeInt(b.sortOrder,100,0,100000),String(b.groupLabel||""),t,t).run();
  await bumpVersion(env,"sidebar_version");
  await audit(env,user,"create","sidebar_item",id,b);
  return responseJson({ok:true,id},201);
}

async function updateSidebarItem(request, env, user, id) {
  const old=await env.DB.prepare("SELECT * FROM sidebar_items WHERE id=?").bind(id).first();
  if(!old) return fail("按钮不存在",404);
  const b=await readBody(request),t=now();
  const audience=b.audience!==undefined&&["admin","sales","all"].includes(b.audience)?b.audience:old.audience;
  await env.DB.prepare(
    `UPDATE sidebar_items SET audience=?,label=?,icon=?,url=?,target=?,enabled=?,sort_order=?,group_label=?,updated_at=? WHERE id=?`
  ).bind(audience,b.label!==undefined?String(b.label):old.label,b.icon!==undefined?String(b.icon):old.icon,
    b.url!==undefined?String(b.url):old.url,b.target!==undefined?(b.target==="new"?"new":"same"):old.target,
    b.enabled!==undefined?(b.enabled?1:0):old.enabled,
    b.sortOrder!==undefined?safeInt(b.sortOrder,old.sort_order,0,100000):old.sort_order,
    b.groupLabel!==undefined?String(b.groupLabel):old.group_label,t,id).run();
  await bumpVersion(env,"sidebar_version");
  await audit(env,user,"update","sidebar_item",id,b);
  return responseJson({ok:true});
}

async function stats(env, user) {
  const where=user.role==="sales"?"deleted_at IS NULL AND assigned_user_id=?":"deleted_at IS NULL";
  const bind=user.role==="sales"?[user.id]:[];
  const base=await env.DB.prepare(
    `SELECT COUNT(*) total,
      SUM(CASE WHEN date(created_at)=date('now') THEN 1 ELSE 0 END) today,
      SUM(CASE WHEN progress_percent=100 THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) archived
     FROM customers WHERE ${where}`
  ).bind(...bind).first();
  let sales=[];
  if(user.role==="admin"){
    const r=await env.DB.prepare(
      `SELECT u.id,u.display_name,COUNT(c.id) customer_count,
       COALESCE(ROUND(AVG(c.progress_percent)),0) avg_progress
       FROM users u LEFT JOIN customers c ON c.assigned_user_id=u.id AND c.deleted_at IS NULL
       WHERE u.role='sales' AND u.active=1 GROUP BY u.id,u.display_name ORDER BY customer_count DESC,u.display_name`
    ).all();
    sales=r.results||[];
  }
  return responseJson({ok:true,summary:{
    total:Number(base?.total||0),today:Number(base?.today||0),completed:Number(base?.completed||0),archived:Number(base?.archived||0)
  },sales});
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

async function usersList(env) {
  const r=await env.DB.prepare(
    "SELECT id,username,display_name,role,active,created_at,updated_at FROM users ORDER BY role,display_name"
  ).all();
  return responseJson({ok:true,items:r.results||[]});
}

async function createUser(request, env, admin) {
  const b=await readBody(request);
  const username=String(b.username||"").trim(),displayName=String(b.displayName||"").trim(),password=String(b.password||"");
  if(username.length<3||!displayName||password.length<8) return fail("账号至少3位、姓名不能为空、密码至少8位");
  const exists=await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first();
  if(exists) return fail("这个账号已经存在",409);
  const salt=newSalt(),iterations=100000,hash=await derivePassword(password,salt,iterations),id=uid("u_"),t=now();
  await env.DB.prepare(
    `INSERT INTO users(id,username,display_name,password_hash,password_salt,password_iterations,role,active,created_at,updated_at)
     VALUES(?,?,?,?,?,?,'sales',1,?,?)`
  ).bind(id,username,displayName,hash,salt,iterations,t,t).run();
  await audit(env,admin,"create","user",id,{username,displayName,role:"sales"});
  return responseJson({ok:true,id},201);
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
  } else if(section==="sidebarItems"){
    for(const x of rows) stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO sidebar_items(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(x.id,x.audience,x.label,x.icon,x.url,x.target,x.enabled,x.sort_order,x.group_label,x.created_at||t,x.updated_at||t));
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
  if(user.role==="sales" && row.assigned_user_id!==user.id) return fail("无权删除该客户",403);
  await env.DB.prepare("UPDATE customers SET deleted_at=?,updated_at=? WHERE id=?").bind(now(),now(),id).run();
  await audit(env,user,"delete","customer",id,{soft:true});
  return responseJson({ok:true});
}


async function recycleList(env) {
  const r=await env.DB.prepare(
    `SELECT c.id,c.name,c.deleted_at,c.updated_at,u.display_name owner_name
     FROM customers c LEFT JOIN users u ON u.id=c.assigned_user_id
     WHERE c.deleted_at IS NOT NULL
     ORDER BY c.deleted_at DESC LIMIT 200`
  ).all();
  return responseJson({ok:true,items:r.results||[]});
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
  const limit=safeInt(url.searchParams.get("limit"),100,1,200);
  const r=await env.DB.prepare(
    `SELECT a.id,a.action,a.entity_type,a.entity_id,a.detail_json,a.created_at,u.display_name actor_name
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
     ORDER BY a.created_at DESC LIMIT ?`
  ).bind(limit).all();
  return responseJson({ok:true,items:(r.results||[]).map(x=>({
    ...x,
    detail:(()=>{try{return JSON.parse(x.detail_json||"{}")}catch{return{}}})()
  }))});
}

async function exportBusinessData(env,user){
  const [users,customers,fields,values,progressDefs,customerProgress,sidebars,listCols,dash,settings] = await Promise.all([
    env.DB.prepare("SELECT id,username,display_name,role,active,created_at,updated_at FROM users ORDER BY created_at").all(),
    env.DB.prepare("SELECT * FROM customers ORDER BY created_at").all(),
    env.DB.prepare("SELECT * FROM field_definitions ORDER BY sort_order").all(),
    env.DB.prepare("SELECT * FROM customer_values").all(),
    env.DB.prepare("SELECT * FROM progress_definitions ORDER BY sort_order").all(),
    env.DB.prepare("SELECT * FROM customer_progress").all(),
    env.DB.prepare("SELECT * FROM sidebar_items ORDER BY audience,sort_order").all(),
    env.DB.prepare("SELECT * FROM list_columns ORDER BY audience,sort_order").all(),
    env.DB.prepare("SELECT * FROM dashboard_widgets ORDER BY audience,sort_order").all(),
    env.DB.prepare("SELECT setting_key,value_json,updated_at FROM system_settings ORDER BY setting_key").all()
  ]);
  await audit(env,user,"export","business_data",null,{});
  return responseJson({
    ok:true,
    format:"MS007-BUSINESS-BACKUP",
    version:1,
    exportedAt:now(),
    data:{
      users:users.results||[],
      customers:customers.results||[],
      fieldDefinitions:fields.results||[],
      customerValues:values.results||[],
      progressDefinitions:progressDefs.results||[],
      customerProgress:customerProgress.results||[],
      sidebarItems:sidebars.results||[],
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
  for(const x of d.sidebarItems||[]) batch3.push(env.DB.prepare(
    `INSERT OR REPLACE INTO sidebar_items(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(x.id,x.audience,x.label,x.icon,x.url,x.target,x.enabled,x.sort_order,x.group_label,x.created_at||t,x.updated_at||t));
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

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/health") return responseJson({ ok: true, app: env.APP_NAME || "MS007" });
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
    id:user.id,username:user.username,displayName:user.display_name,role:user.role
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
  if (path === "/api/stats" && method === "GET") return stats(env,user);

  let m=path.match(/^\/api\/customers\/([^/]+)$/);
  if(m && method==="GET") return getCustomer(env,user,m[1]);
  if(m && method==="PATCH") return updateCustomer(request,env,user,m[1]);
  if(m && method==="DELETE") return softDeleteCustomer(env,user,m[1]);
  m=path.match(/^\/api\/customers\/([^/]+)\/progress\/([^/]+)$/);
  if(m && method==="PUT") return toggleProgress(request,env,user,m[1],m[2]);

  if (!requireRole(user,"admin")) return fail("需要管理员权限",403,"ADMIN_REQUIRED");

  if (path === "/api/admin/users" && method === "GET") return usersList(env);
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

  if (path === "/api/admin/progress" && method === "POST") return createProgressDef(request,env,user);
  m=path.match(/^\/api\/admin\/progress\/([^/]+)$/);
  if(m && method==="PATCH") return updateProgressDef(request,env,user,m[1]);
  if(m && method==="DELETE"){
    await env.DB.prepare("UPDATE progress_definitions SET enabled=0,updated_at=? WHERE id=?").bind(now(),m[1]).run();
    await audit(env,user,"disable","progress_definition",m[1],{});
    return responseJson({ok:true});
  }

  if (path === "/api/admin/sidebar" && method === "GET") return adminSidebar(env);
  if (path === "/api/admin/sidebar" && method === "POST") return createSidebarItem(request,env,user);
  m=path.match(/^\/api\/admin\/sidebar\/([^/]+)$/);
  if(m && method==="PATCH") return updateSidebarItem(request,env,user,m[1]);
  if(m && method==="DELETE"){
    await env.DB.prepare("DELETE FROM sidebar_items WHERE id=?").bind(m[1]).run();
    await bumpVersion(env,"sidebar_version");
    await audit(env,user,"delete","sidebar_item",m[1],{});
    return responseJson({ok:true});
  }

  if (path === "/api/admin/capacity" && method === "GET") return capacity(env);
  if (path === "/api/admin/registration-layout" && method === "GET") return adminRegistrationLayout(env);
  if (path === "/api/admin/registration-layout" && method === "PUT") return saveRegistrationLayout(request,env,user);
  if (path === "/api/admin/recycle" && method === "GET") return recycleList(env);
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
  async fetch(request, env) {
    try {
      const url=new URL(request.url);
      if(url.pathname.startsWith("/api/")) return withSecurityHeaders(await api(request,env));
      const asset=await env.ASSETS.fetch(request);
      return withSecurityHeaders(asset);
    } catch (e) {
      return withSecurityHeaders(responseJson({ok:false,code:"SERVER_ERROR",message:"系统暂时无法处理请求",detail:String(e?.message||e)},500));
    }
  }
};
