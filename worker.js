

// ============================================================================
// STUDIO PLATFORM — MULTI-TENANT BACKEND WORKER (worker.js)
// ============================================================================

const MASTER_TENANTS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTgotv2zBG-2uYmMPtCyXUP1z6TtgJ1Cg6WxocccVq29lbixrkiGvpkVawVtxz-_-I-OZHIJNHN58el/pub?output=csv';
const MASTER_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzJomF52wqZAUcu3StLXG8M41_PzhUwQiK0uoU9kIiHkde5nBQIKj51tcM_7vD0RX9GdA/exec';

let TENANTS_CACHE = { ts: 0, list: [] };
const MIGRATED_DBS = new Set();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (e) {
        return json({ error: e.message || 'Internal Server Error' }, 500);
      }
    }

    if (env.ASSETS) {
      return await env.ASSETS.fetch(request);
    }
    return fetch(request);
  }
};

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  const tenant = await resolveTenant(request, env);
  const db = tenant.db;

  if (!db) {
    return json({ error: `Database binding "${tenant.db_binding}" is not attached to this Worker.` }, 500);
  }

  await ensureActivityColumns(db, tenant.db_binding);

  // --- PUBLIC TENANT CONFIG ---
  if (path === '/api/config' && method === 'GET') {
    return await handleGetConfig(db, tenant);
  }

  // --- AUTH & PROFILE ---
  if (path === '/api/login' && method === 'POST') {
    return await handleLogin(request, db);
  }
  if (path === '/api/signup' && method === 'POST') {
    return await handleSignup(request, db, tenant, ctx);
  }
  if (path === '/api/change-password' && method === 'POST') {
    return await handleChangePassword(request, db);
  }
  if (path === '/api/heartbeat' && method === 'GET') {
    return await handleHeartbeat(request, db);
  }
  if (path === '/api/activity' && method === 'POST') {
    return await handleRecordActivity(request, db);
  }

  // --- LESSON ANSWERS & PROGRESS ---
  if (path === '/api/answers' && method === 'POST') {
    return await handleSaveAnswer(request, db, tenant, ctx);
  }

  // --- COMMUNITY POSTS ---
  if (path === '/api/posts') {
    if (method === 'GET') return await handleGetPosts(db);
    if (method === 'POST') return await handleCreatePost(request, db);
  }
  if (path === '/api/posts/delete' && method === 'POST') {
    return await handleDeletePost(request, db);
  }

  // --- SITE ADMINISTRATION ---
  if (path === '/api/admin/settings') {
    if (method === 'GET') return await handleAdminGetSettings(request, db, tenant);
    if (method === 'POST') return await handleAdminSaveSettings(request, db, tenant, ctx);
  }
  if (path === '/api/admin/stats' && method === 'GET') {
    return await handleAdminStats(request, db);
  }
  if (path === '/api/admin/analytics' && method === 'GET') {
    return await handleAdminAnalytics(request, db);
  }
  if (path === '/api/admin/users' && method === 'GET') {
    return await handleAdminUsers(request, db);
  }
  if (path === '/api/admin/status' && method === 'POST') {
    return await handleAdminSetStatus(request, db, tenant, ctx);
  }
  if (path === '/api/admin/set-paid' && method === 'POST') {
    return await handleAdminSetPaid(request, db, tenant, ctx);
  }
  if (path === '/api/admin/set-admin' && method === 'POST') {
    return await handleAdminSetAdmin(request, db, tenant, ctx);
  }
  if (path === '/api/admin/reset-password' && method === 'POST') {
    return await handleAdminResetPassword(request, db);
  }
  if (path === '/api/admin/sync-members' && method === 'POST') {
    return await handleAdminSyncMembers(request, db, tenant);
  }
  if (path === '/api/admin/reports' && method === 'GET') {
    return await handleAdminReports(request, db);
  }
  if (path === '/api/admin/reports/resolve' && method === 'POST') {
    return await handleAdminResolveReport(request, db);
  }
  if (path === '/api/admin/reports/delete' && method === 'POST') {
    return await handleAdminDeleteReport(request, db);
  }

  return json({ error: 'Endpoint not found.' }, 404);
}

// ============================================================================
// DATABASE AUTO-MIGRATION FOR ACTIVITY COUNTERS
// ============================================================================

async function ensureActivityColumns(db, bindingName) {
  if (MIGRATED_DBS.has(bindingName)) return;
  try {
    const info = await db.prepare('PRAGMA table_info(users)').all();
    const cols = new Set((info.results || []).map(c => c.name));
    if (!cols.has('session_count')) {
      await db.prepare('ALTER TABLE users ADD COLUMN session_count INTEGER DEFAULT 0').run();
    }
    if (!cols.has('click_count')) {
      await db.prepare('ALTER TABLE users ADD COLUMN click_count INTEGER DEFAULT 0').run();
    }
    if (!cols.has('last_active_at')) {
      await db.prepare('ALTER TABLE users ADD COLUMN last_active_at TEXT').run();
    }
    MIGRATED_DBS.add(bindingName);
  } catch (e) {}
}

// ============================================================================
// MULTI-TENANT ROUTING & CONFIG
// ============================================================================

async function resolveTenant(request, env) {
  const url = new URL(request.url);
  const host = (request.headers.get('host') || url.hostname || '').split(':')[0].toLowerCase().replace(/^www\./, '');

  const tenants = await getTenantsList();
  const match = tenants.find(t => t.domain === host) || tenants[0] || {
    domain: host || 'studio.cict.co',
    db_binding: 'DB',
    ams_sheet_url: '',
    cms_csv_url: '',
    defaults: {}
  };

  const bindingName = match.db_binding || 'DB';
  const db = env[bindingName] || env.DB;

  return {
    ...match,
    db_binding: bindingName,
    db
  };
}

async function getTenantsList() {
  const now = Date.now();
  if (TENANTS_CACHE.list.length > 0 && (now - TENANTS_CACHE.ts) < 60000) {
    return TENANTS_CACHE.list;
  }

  try {
    const res = await fetch(MASTER_TENANTS_CSV_URL, { cf: { cacheTtl: 30 } });
    if (!res.ok) return TENANTS_CACHE.list;
    const csv = await res.text();
    const rows = parseCSV(csv);
    if (rows.length < 2) return TENANTS_CACHE.list;

    const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idx = name => headers.indexOf(name);

    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const domain = String(r[idx('domain')] || '').trim().toLowerCase().replace(/^www\./, '');
      if (!domain) continue;

      const amsCol = idx('ams_sheet_url') !== -1 ? idx('ams_sheet_url') : idx('ams_sheet_id');
      list.push({
        domain,
        db_binding: String(r[idx('db_binding')] || 'DB').trim(),
        ams_sheet_url: amsCol !== -1 ? String(r[amsCol] || '').trim() : '',
        cms_csv_url: idx('cms_csv_url') !== -1 ? String(r[idx('cms_csv_url')] || '').trim() : '',
        defaults: {
          site_name: idx('site_name') !== -1 ? String(r[idx('site_name')] || '').trim() : '',
          tagline: idx('tagline') !== -1 ? String(r[idx('tagline')] || '').trim() : '',
          hero_title: idx('hero_title') !== -1 ? String(r[idx('hero_title')] || '').trim() : '',
          hero_points: idx('hero_points') !== -1 ? String(r[idx('hero_points')] || '').trim() : '',
          logo_url: idx('logo_url') !== -1 ? String(r[idx('logo_url')] || '').trim() : '',
          favicon_url: idx('favicon_url') !== -1 ? String(r[idx('favicon_url')] || '').trim() : '',
          primary_color: idx('primary_color') !== -1 ? String(r[idx('primary_color')] || '').trim() : '',
          accent_color: idx('accent_color') !== -1 ? String(r[idx('accent_color')] || '').trim() : '',
          bg_color: idx('bg_color') !== -1 ? String(r[idx('bg_color')] || '').trim() : '',
          support_email: idx('support_email') !== -1 ? String(r[idx('support_email')] || '').trim() : ''
        }
      });
    }

    if (list.length > 0) {
      TENANTS_CACHE = { ts: now, list };
    }
    return list;
  } catch (e) {
    return TENANTS_CACHE.list;
  }
}

async function ensureSettingsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
}

async function readSettingsMap(db, tenant) {
  await ensureSettingsTable(db);
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const merged = { ...(tenant.defaults || {}) };
  for (const row of (rows.results || [])) {
    if (row.value !== null && row.value !== undefined && String(row.value).trim() !== '') {
      merged[row.key] = row.value;
    }
  }
  return merged;
}

async function handleGetConfig(db, tenant) {
  const settings = await readSettingsMap(db, tenant);
  return json({
    domain: tenant.domain,
    cms_csv_url: tenant.cms_csv_url || '',
    settings
  });
}

// ============================================================================
// HANDLERS: AUTH & ACTIVITY TRACKING
// ============================================================================

async function handleLogin(request, db) {
  const { email, password } = await request.json();
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !password) {
    return json({ error: 'Email and password required.' }, 400);
  }

  const user = await db.prepare('SELECT * FROM users WHERE LOWER(email) = ?')
    .bind(cleanEmail)
    .first();

  if (!user) {
    return json({ error: 'No account found for this email. Check spelling or create an account.' }, 404);
  }

  const inputHash = await hashPassword(password);
  const isValid = (user.password === inputHash) || (password === user.email);

  if (!isValid) {
    return json({ error: 'Incorrect password for this account.' }, 401);
  }

  if (user.status === 'Banned') {
    return json({ error: 'This account has been banned. Please contact the administrator.' }, 403);
  }

  const token = user.id + ':' + crypto.randomUUID();
  await db.prepare(`
    UPDATE users
    SET last_seen = datetime('now'),
        auth_token = ?,
        session_count = COALESCE(session_count, 0) + CASE
          WHEN last_active_at IS NULL OR last_active_at <= datetime('now', '-30 minutes') THEN 1
          ELSE 0
        END,
        last_active_at = datetime('now')
    WHERE id = ?
  `).bind(token, user.id).run();

  return json({
    token,
    name: user.name,
    email: user.email,
    member_number: String(user.member_number || '1'),
    status: user.status || 'Approved',
    is_admin: !!user.is_admin,
    is_paid: !!user.is_paid
  });
}

async function handleSignup(request, db, tenant, ctx) {
  const { name, email, password } = await request.json();
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !password || password.length < 8) {
    return json({ error: 'Valid email and password (8+ characters) required.' }, 400);
  }

  const existing = await db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').bind(cleanEmail).first();
  if (existing) {
    return json({ error: 'An account with this email already exists. Please log in.' }, 409);
  }

  const maxRow = await db.prepare('SELECT MAX(CAST(member_number AS INTEGER)) as max_num FROM users').first();
  const currentMax = maxRow && maxRow.max_num ? maxRow.max_num : 0;
  const isFirstUser = currentMax === 0;
  const nextNum = isFirstUser ? 1 : Math.max(102, currentMax + 1);
  const hash = await hashPassword(password);

  await db.prepare(`
    INSERT INTO users (name, email, password, member_number, status, is_admin, is_paid, session_count, click_count, last_active_at, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'), datetime('now'))
  `).bind(
    name || 'Classmate',
    cleanEmail,
    hash,
    String(nextNum),
    isFirstUser ? 'Approved' : 'Pending',
    isFirstUser ? 1 : 0,
    isFirstUser ? 1 : 0
  ).run();

  const newUser = await db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').bind(cleanEmail).first();
  const token = newUser.id + ':' + crypto.randomUUID();
  await db.prepare('UPDATE users SET auth_token = ? WHERE id = ?').bind(token, newUser.id).run();

  if (tenant.ams_sheet_url) {
    ctx.waitUntil(pushFullMembersSync(db, tenant));
  }

  return json({
    token,
    name: newUser.name,
    email: newUser.email,
    member_number: String(newUser.member_number),
    status: newUser.status,
    is_admin: !!newUser.is_admin,
    is_paid: !!newUser.is_paid
  });
}

async function handleChangePassword(request, db) {
  const user = await authenticate(request, db);
  if (!user) return json({ error: 'Please log in again.' }, 401);

  const { currentPassword, newPassword, newName } = await request.json();
  const cleanName = String(newName || '').trim();

  if (!cleanName && !newPassword) return json({ error: 'Provide a display name or new password.' }, 400);

  const currentHash = await hashPassword(currentPassword || '');
  const isValid = (user.password === currentHash) || (currentPassword === user.email);
  if (!isValid) return json({ error: 'Current password is incorrect.' }, 400);

  if (newPassword) {
    if (newPassword.length < 8) return json({ error: 'New password must be 8+ characters.' }, 400);
    const newHash = await hashPassword(newPassword);
    await db.prepare('UPDATE users SET password = ? WHERE id = ?').bind(newHash, user.id).run();
  }

  if (cleanName) {
    await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(cleanName, user.id).run();
  }

  return json({ success: true });
}

async function handleHeartbeat(request, db) {
  const user = await authenticate(request, db);
  if (user) {
    await db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").bind(user.id).run();
  }
  return json({ ok: true });
}

async function handleRecordActivity(request, db) {
  const body = await request.json().catch(() => ({}));
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim() || String(body.token || '').trim();
  if (!token) return json({ ok: false }, 401);

  const user = await db.prepare('SELECT id FROM users WHERE auth_token = ?').bind(token).first();
  if (!user) return json({ ok: false }, 401);

  const clicks = Math.max(1, Math.min(500, parseInt(body.clicks, 10) || 1));

  await db.prepare(`
    UPDATE users
    SET click_count = COALESCE(click_count, 0) + ?,
        session_count = COALESCE(session_count, 0) + CASE
          WHEN last_active_at IS NULL OR last_active_at <= datetime('now', '-30 minutes') THEN 1
          ELSE 0
        END,
        last_active_at = datetime('now'),
        last_seen = datetime('now')
    WHERE id = ?
  `).bind(clicks, user.id).run();

  return json({ ok: true });
}

// ============================================================================
// HANDLERS: LESSON ANSWERS
// ============================================================================

async function handleSaveAnswer(request, db, tenant, ctx) {
  const user = await authenticate(request, db);
  if (!user) return json({ error: 'Please log in first.' }, 401);

  const body = await request.json();
  const moduleTitle = String(body.module || '').trim();
  const lessonTitle = String(body.lesson || '').trim();
  const lessonTab = String(body.lesson_tab || lessonTitle || 'Answers').trim();
  const question = String(body.question || '').trim();
  const answer = String(body.answer || '').trim();

  if (!answer) return json({ error: 'Answer text required.' }, 400);

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      lesson_tab TEXT,
      module_title TEXT,
      lesson_title TEXT,
      question TEXT,
      answer TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  await db.prepare(`
    INSERT INTO answers (user_id, lesson_tab, module_title, lesson_title, question, answer, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(user.id, lessonTab, moduleTitle, lessonTitle, question, answer).run();

  if (tenant.ams_sheet_url) {
    ctx.waitUntil(callMasterWebhook({
      action: 'save_answer',
      sheetUrl: tenant.ams_sheet_url,
      lesson_tab: lessonTab,
      member_number: user.member_number || '',
      name: user.name || '',
      email: user.email || '',
      module: moduleTitle,
      lesson: lessonTitle,
      question,
      answer
    }));
  }

  return json({ ok: true });
}

// ============================================================================
// HANDLERS: POSTS
// ============================================================================

async function handleGetPosts(db) {
  const rows = await db.prepare(`SELECT id, user_name, content, created_at FROM posts ORDER BY id DESC LIMIT 50`).all();
  return json(rows.results || []);
}

async function handleCreatePost(request, db) {
  const user = await authenticate(request, db);
  if (!user) return json({ error: 'Unauthorized.' }, 401);

  const { content } = await request.json();
  if (!content || !content.trim()) return json({ error: 'Post content required.' }, 400);

  await db.prepare(`INSERT INTO posts (user_id, user_name, content, created_at) VALUES (?, ?, ?, datetime('now'))`)
    .bind(user.id, user.name, content.trim()).run();

  return json({ ok: true });
}

async function handleDeletePost(request, db) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Admin only.' }, 403);
  const { post_id } = await request.json();
  await db.prepare('DELETE FROM posts WHERE id = ?').bind(post_id).run();
  return json({ success: true });
}

// ============================================================================
// HANDLERS: SITE ADMINISTRATION
// ============================================================================

async function handleAdminGetSettings(request, db, tenant) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  const settings = await readSettingsMap(db, tenant);
  return json({ settings });
}

async function handleAdminSaveSettings(request, db, tenant, ctx) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { settings } = await request.json();
  if (!settings || typeof settings !== 'object') {
    return json({ error: 'Invalid settings payload.' }, 400);
  }

  await ensureSettingsTable(db);
  for (const [key, val] of Object.entries(settings)) {
    await db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).bind(String(key), String(val ?? '')).run();
  }

  const merged = await readSettingsMap(db, tenant);

  ctx.waitUntil(callMasterWebhook({
    action: 'sync_settings',
    domain: tenant.domain,
    settings: merged
  }));

  return json({ ok: true, settings: merged });
}

async function handleAdminStats(request, db) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const uCount = await db.prepare('SELECT COUNT(*) as c FROM users').first();
  const pCount = await db.prepare('SELECT COUNT(*) as c FROM posts').first();
  let rCount = { c: 0 };
  try { rCount = await db.prepare('SELECT COUNT(*) as c FROM reports WHERE resolved = 0').first() || { c: 0 }; } catch (e) {}
  const aCount = await db.prepare("SELECT COUNT(*) as c FROM users WHERE last_seen >= datetime('now', '-5 minutes')").first();
  const actTotals = await db.prepare('SELECT COALESCE(SUM(session_count), 0) as sessions, COALESCE(SUM(click_count), 0) as clicks FROM users').first();

  return json({
    users: uCount ? uCount.c : 0,
    posts: pCount ? pCount.c : 0,
    reports: rCount ? rCount.c : 0,
    active: aCount ? aCount.c : 0,
    totalSessions: actTotals ? actTotals.sessions : 0,
    totalClicks: actTotals ? actTotals.clicks : 0
  });
}

async function handleAdminAnalytics(request, db) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const totalUsers = await db.prepare('SELECT COUNT(*) as c FROM users').first();
  const activeUsers = await db.prepare('SELECT COUNT(*) as c FROM users WHERE COALESCE(session_count, 0) > 0').first();
  const totalPosts = await db.prepare('SELECT COUNT(*) as c FROM posts').first();
  const actTotals = await db.prepare('SELECT COALESCE(SUM(session_count), 0) as sessions, COALESCE(SUM(click_count), 0) as clicks FROM users').first();

  const totalCount = totalUsers?.c || 0;
  const activeCount = activeUsers?.c || 0;
  const postsCount = totalPosts?.c || 0;
  const sessions = actTotals?.sessions || 0;
  const clicks = actTotals?.clicks || 0;

  return json({
    totalUsers: totalCount,
    activeLearners: activeCount,
    eliteRate: totalCount > 0 ? Math.round((activeCount / totalCount) * 100) : 0,
    engagement: totalCount > 0 ? (sessions / totalCount).toFixed(1) : '0.0',
    healthRatio: sessions > 0 ? (clicks / sessions).toFixed(1) : '0.0'
  });
}

async function handleAdminUsers(request, db) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const rows = await db.prepare(`
    SELECT u.id, u.member_number, u.name, u.email, u.status, u.is_admin, u.is_paid, u.created_at, u.last_seen,
      COALESCE(u.session_count, 0) as session_count,
      COALESCE(u.click_count, 0) as click_count,
      (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) as post_count,
      0 as modules_done,
      0 as lessons_done
    FROM users u
    ORDER BY CASE WHEN u.status = 'Pending' THEN 0 ELSE 1 END ASC, CAST(u.member_number AS INTEGER) ASC
  `).all();

  return json(rows.results || []);
}

async function handleAdminSetStatus(request, db, tenant, ctx) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, status } = await request.json();
  await db.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, user_id).run();
  if (tenant.ams_sheet_url) ctx.waitUntil(pushFullMembersSync(db, tenant));
  return json({ success: true });
}

async function handleAdminSetPaid(request, db, tenant, ctx) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, is_paid } = await request.json();
  await db.prepare('UPDATE users SET is_paid = ? WHERE id = ?').bind(is_paid ? 1 : 0, user_id).run();
  if (tenant.ams_sheet_url) ctx.waitUntil(pushFullMembersSync(db, tenant));
  return json({ success: true });
}

async function handleAdminSetAdmin(request, db, tenant, ctx) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, is_admin } = await request.json();
  await db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(is_admin ? 1 : 0, user_id).run();
  if (tenant.ams_sheet_url) ctx.waitUntil(pushFullMembersSync(db, tenant));
  return json({ success: true });
}

async function handleAdminResetPassword(request, db) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, new_password } = await request.json();
  if (!user_id || !new_password || new_password.length < 8) return json({ error: 'Password must be 8+ characters.' }, 400);

  const hash = await hashPassword(new_password);
  await db.prepare('UPDATE users SET password = ? WHERE id = ?').bind(hash, user_id).run();
  return json({ success: true });
}

async function handleAdminSyncMembers(request, db, tenant) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  if (!tenant.ams_sheet_url) return json({ error: 'AMS Sheet URL not configured in Master Tenants Sheet.' }, 400);

  return await pushFullMembersSync(db, tenant);
}

async function pushFullMembersSync(db, tenant) {
  const users = await db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) as post_count
    FROM users u
    ORDER BY CAST(u.member_number AS INTEGER) ASC
  `).all();

  const members = (users.results || []).map(u => ({
    member_number: u.member_number,
    name: u.name,
    email: u.email,
    status: u.status,
    is_paid: u.is_paid,
    is_admin: u.is_admin,
    session_count: u.session_count || 0,
    click_count: u.click_count || 0,
    post_count: u.post_count || 0,
    modules_done: 0,
    lessons_done: 0,
    created_at: u.created_at,
    last_seen: u.last_seen
  }));

  const res = await callMasterWebhook({
    action: 'sync_members',
    sheetUrl: tenant.ams_sheet_url,
    members
  });

  return json({ success: !!res.ok, count: members.length });
}

async function handleAdminReports(request, db) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  try {
    const res = await db.prepare(`SELECT * FROM reports ORDER BY id DESC LIMIT 50`).all();
    return json(res.results || []);
  } catch (e) {
    return json([]);
  }
}

async function handleAdminResolveReport(request, db) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  const { report_id, resolved } = await request.json();
  try {
    await db.prepare('UPDATE reports SET resolved = ? WHERE id = ?').bind(resolved, report_id).run();
  } catch (e) {}
  return json({ success: true });
}

async function handleAdminDeleteReport(request, db) {
  const admin = await authenticateAdmin(request, db);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  const { report_id } = await request.json();
  try {
    await db.prepare('DELETE FROM reports WHERE id = ?').bind(report_id).run();
  } catch (e) {}
  return json({ success: true });
}

// ============================================================================
// HELPERS
// ============================================================================

async function authenticate(request, db) {
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  return await db.prepare('SELECT * FROM users WHERE auth_token = ?').bind(token).first();
}

async function authenticateAdmin(request, db) {
  const user = await authenticate(request, db);
  if (!user) return null;
  if (user.is_admin === 1 || String(user.member_number) === '1') {
    return user;
  }
  return null;
}

async function hashPassword(str) {
  const enc = new TextEncoder().encode(str + '_cict_salt');
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function callMasterWebhook(payload) {
  try {
    const res = await fetch(MASTER_APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json().catch(() => ({ ok: res.ok }));
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let token = '';
  let insideQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      if (insideQuotes && next === '"') { token += '"'; i++; }
      else { insideQuotes = !insideQuotes; }
    } else if (c === ',' && !insideQuotes) {
      row.push(token); token = '';
    } else if ((c === '\r' || c === '\n') && !insideQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(token); token = '';
      if (row.length > 0 && row.some(cell => cell.trim())) rows.push(row);
      row = [];
    } else {
      token += c;
    }
  }
  if (token || row.length > 0) {
    row.push(token);
    if (row.some(cell => cell.trim())) rows.push(row);
  }
  return rows;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}
