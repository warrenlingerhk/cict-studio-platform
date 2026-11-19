

// ============================================================================
// MULTI-TENANT SAAS CLOUDFLARE WORKER (worker.js)
// Routes requests by hostname via Master Tenants Sheet & binds D1 dynamically
// ============================================================================

const MASTER_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTgotv2zBG-2uYmMPtCyXUP1z6TtgJ1Cg6WxocccVq29lbixrkiGvpkVawVtxz-_-I-OZHIJNHN58el/pub?gid=0&single=true&output=csv';

let tenantCache = { data: null, expiresAt: 0 };

function parseCSV(text) {
  const rows = [];
  let row = [];
  let token = '';
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (insideQuotes && next === '"') {
        token += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (c === ',' && !insideQuotes) {
      row.push(token);
      token = '';
    } else if ((c === '\r' || c === '\n') && !insideQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(token);
      token = '';
      if (row.length > 0 && row.some((cell) => cell.trim() !== '')) {
        rows.push(row);
      }
      row = [];
    } else {
      token += c;
    }
  }
  if (token !== '' || row.length > 0) {
    row.push(token);
    if (row.some((cell) => cell.trim() !== '')) {
      rows.push(row);
    }
  }
  return rows;
}

async function getTenantConfig(hostname, env) {
  const now = Date.now();
  if (!tenantCache.data || now > tenantCache.expiresAt) {
    try {
      const res = await fetch(MASTER_CSV_URL, { cf: { cacheTtl: 30 } });
      if (!res.ok) throw new Error('Failed to fetch Master Tenants Sheet (' + res.status + ')');
      const csvText = await res.text();
      const rows = parseCSV(csvText);

      const tenants = {};
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 2) continue;
        const domain = (r[0] || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!domain) continue;

        tenants[domain] = {
          domain,
          db_binding: (r[1] || 'DB').trim(),
          apps_script_url: (r[2] || '').trim(),
          ams_sheet_url: (r[3] || '').trim(),
          cms_sheet_url: (r[4] || '').trim(),
          cms_csv_url: (r[5] || '').trim(),
          settings: {
            site_name: (r[6] || '').trim(),
            tagline: (r[7] || '').trim(),
            hero_title: (r[8] || '').trim(),
            hero_points: (r[9] || '').trim(),
            logo_url: (r[10] || '').trim(),
            favicon_url: (r[11] || '').trim(),
            primary_color: (r[12] || '').trim(),
            accent_color: (r[13] || '').trim(),
            bg_color: (r[14] || '').trim(),
            support_email: (r[15] || '').trim(),
          },
        };
      }
      if (Object.keys(tenants).length > 0) {
        tenantCache = { data: tenants, expiresAt: now + 60 * 1000 };
      }
    } catch (err) {
      if (!tenantCache.data) throw err;
    }
  }

  const cleanHost = hostname.toLowerCase().replace(/^www\./, '');
  if (tenantCache.data[cleanHost]) return tenantCache.data[cleanHost];

  if (cleanHost.startsWith('aethera.') && env.aethera) {
    const matchKey = Object.keys(tenantCache.data).find((k) => k.includes('aethera'));
    if (matchKey) return tenantCache.data[matchKey];
  }

  const firstKey = Object.keys(tenantCache.data)[0];
  return tenantCache.data[firstKey] || null;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

async function ensureSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        member_number TEXT,
        user_name TEXT,
        user_email TEXT,
        lesson_tab TEXT,
        module TEXT,
        lesson TEXT,
        question TEXT,
        answer TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS poll_votes (
        user_id INTEGER,
        poll_key TEXT,
        choices TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, poll_key)
      )`
    )
    .run();

  const alters = [
    'ALTER TABLE users ADD COLUMN member_number TEXT',
    "ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'Pending'",
    'ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN is_paid INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN auth_token TEXT',
    'ALTER TABLE users ADD COLUMN session_count INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN click_count INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN last_active_at TEXT',
    'ALTER TABLE users ADD COLUMN last_seen TEXT',
    'ALTER TABLE answers ADD COLUMN member_number TEXT',
    'ALTER TABLE answers ADD COLUMN user_email TEXT',
    'ALTER TABLE answers ADD COLUMN lesson_tab TEXT',
    'ALTER TABLE answers ADD COLUMN module TEXT',
    'ALTER TABLE answers ADD COLUMN lesson TEXT',
  ];
  for (const sql of alters) {
    try {
      await db.prepare(sql).run();
    } catch (_) {}
  }
}

async function getAuthUser(request, db) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  return await db.prepare('SELECT * FROM users WHERE auth_token = ?').bind(token).first();
}

function generateToken() {
  return crypto.randomUUID() + '-' + crypto.randomUUID();
}

function extractPollCounts(rows) {
  const counts = {};
  let totalVoters = 0;
  for (const row of rows) {
    let arr = [];
    try {
      arr = JSON.parse(row.choices || '[]');
    } catch (_) {
      arr = row.choices ? [row.choices] : [];
    }
    if (Array.isArray(arr) && arr.length > 0) {
      totalVoters++;
      for (const opt of arr) {
        counts[opt] = (counts[opt] || 0) + 1;
      }
    }
  }
  return { counts, totalVoters };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return jsonResponse({ ok: true }, 204);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      const tenant = await getTenantConfig(url.hostname, env);
      if (!tenant) {
        return jsonResponse({ error: 'Tenant configuration not found for ' + url.hostname }, 404);
      }

      const db = env[tenant.db_binding];
      if (!db) {
        return jsonResponse({ error: `D1 binding "${tenant.db_binding}" is not configured on Worker.` }, 500);
      }

      await ensureSchema(db);

      // 1. GET /api/config
      if (path === '/api/config' && request.method === 'GET') {
        const dbRows = await db.prepare('SELECT key, value FROM settings').all();
        const dbSettings = {};
        for (const row of dbRows.results || []) {
          dbSettings[row.key] = row.value;
        }

        const mergedSettings = {
          site_name: dbSettings.site_name || tenant.settings.site_name || 'Platform',
          tagline: dbSettings.tagline || tenant.settings.tagline || '',
          hero_title: dbSettings.hero_title || tenant.settings.hero_title || 'Your Legacy, Scaled by Design.',
          hero_points: dbSettings.hero_points || tenant.settings.hero_points || '',
          logo_url: dbSettings.logo_url || tenant.settings.logo_url || '',
          favicon_url: dbSettings.favicon_url || tenant.settings.favicon_url || '',
          primary_color: dbSettings.primary_color || tenant.settings.primary_color || '#0B2545',
          accent_color: dbSettings.accent_color || tenant.settings.accent_color || '#D4AF37',
          bg_color: dbSettings.bg_color || tenant.settings.bg_color || '#F8F9FA',
          support_email: dbSettings.support_email || tenant.settings.support_email || '',
        };

        return jsonResponse({
          domain: tenant.domain,
          db_binding: tenant.db_binding,
          cms_csv_url: tenant.cms_csv_url,
          settings: mergedSettings,
        });
      }

      // 2. POST /api/signup
      if (path === '/api/signup' && request.method === 'POST') {
        const body = await request.json();
        const name = (body.name || '').trim();
        const email = (body.email || '').trim().toLowerCase();
        const password = (body.password || '').trim();

        if (!name || !email || !password) {
          return jsonResponse({ error: 'Name, email, and password are required.' }, 400);
        }

        const existing = await db.prepare('SELECT id FROM users WHERE lower(email) = ?').bind(email).first();
        if (existing) {
          return jsonResponse({ error: 'An account with this email already exists.' }, 409);
        }

        const countRow = await db.prepare('SELECT COUNT(*) as cnt FROM users').first();
        const nextNum = String((countRow?.cnt || 0) + 1);
        const isFirstUser = nextNum === '1';
        const status = isFirstUser ? 'Approved' : 'Pending';
        const isAdmin = isFirstUser ? 1 : 0;
        const token = generateToken();
        const nowIso = new Date().toISOString();

        await db
          .prepare(
            `INSERT INTO users (member_number, name, email, password, status, is_admin, is_paid, auth_token, session_count, click_count, last_active_at, created_at, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, 0, ?, ?, ?)`
          )
          .bind(nextNum, name, email, password, status, isAdmin, token, nowIso, nowIso, nowIso)
          .run();

        return jsonResponse({
          token,
          name,
          email,
          member_number: nextNum,
          status,
          is_admin: isAdmin,
          is_paid: 0,
        });
      }

      // 3. POST /api/login
      if (path === '/api/login' && request.method === 'POST') {
        const body = await request.json();
        const email = (body.email || '').trim().toLowerCase();
        const password = (body.password || '').trim();

        const user = await db.prepare('SELECT * FROM users WHERE lower(email) = ?').bind(email).first();
        const storedPw = (user?.password || user?.password_hash || '').trim();
        if (!user || (storedPw !== password && (!storedPw || storedPw.length === 0 ? password !== email : false))) {
          return jsonResponse({ error: 'Invalid email or password.' }, 401);
        }

        const token = generateToken();
        const nowIso = new Date().toISOString();
        const newSessions = (user.session_count || 0) + 1;
        await db
          .prepare('UPDATE users SET auth_token = ?, session_count = ?, last_active_at = ?, last_seen = ? WHERE id = ?')
          .bind(token, newSessions, nowIso, nowIso, user.id)
          .run();

        const isAdminFlag = Number(user.is_admin) === 1 || String(user.member_number) === '1' ? 1 : 0;

        return jsonResponse({
          token,
          name: user.name,
          email: user.email,
          member_number: user.member_number || String(user.id),
          status: user.status || 'Approved',
          is_admin: isAdminFlag,
          is_paid: Number(user.is_paid) === 1 ? 1 : 0,
        });
      }

      // 4. GET /api/heartbeat
      if (path === '/api/heartbeat' && request.method === 'GET') {
        const user = await getAuthUser(request, db);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
        const nowIso = new Date().toISOString();
        await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(nowIso, user.id).run();
        return jsonResponse({ ok: true });
      }

      // 4b. POST /api/activity
      if (path === '/api/activity' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const auth = request.headers.get('Authorization') || '';
        const token = (auth.replace(/^Bearer\s+/i, '').trim()) || (body.token || '').trim();
        if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);

        const user = await db.prepare('SELECT * FROM users WHERE auth_token = ?').bind(token).first();
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

        const clicksToAdd = Math.max(0, Math.min(500, parseInt(body.clicks, 10) || 0));
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const lastActiveMs = user.last_active_at ? Date.parse(user.last_active_at) : 0;
        const isNewSession = !lastActiveMs || nowMs - lastActiveMs > 30 * 60 * 1000;

        const updatedSessions = (user.session_count || 0) + (isNewSession ? 1 : 0);
        const updatedClicks = (user.click_count || 0) + clicksToAdd;

        await db
          .prepare('UPDATE users SET session_count = ?, click_count = ?, last_active_at = ?, last_seen = ? WHERE id = ?')
          .bind(updatedSessions, updatedClicks, nowIso, nowIso, user.id)
          .run();

        return jsonResponse({ ok: true, session_count: updatedSessions, click_count: updatedClicks });
      }

      // 5. POST /api/change-password
      if (path === '/api/change-password' && request.method === 'POST') {
        const user = await getAuthUser(request, db);
        if (!user) return jsonResponse({ error: 'Session expired. Please log out and log in again.' }, 401);

        const body = await request.json();
        const currentPassword = (body.currentPassword || '').trim();
        const storedPw = (user.password || user.password_hash || '').trim();
        if (storedPw !== currentPassword) {
          return jsonResponse({ error: 'Current password is incorrect.' }, 400);
        }

        const newName = (body.newName || '').trim() || user.name;
        const newPassword = (body.newPassword || '').trim() || storedPw;

        await db
          .prepare('UPDATE users SET name = ?, password = ? WHERE id = ?')
          .bind(newName, newPassword, user.id)
          .run();

        return jsonResponse({ success: true, name: newName });
      }

      // 6. POST /api/forgot-password
      if (path === '/api/forgot-password' && request.method === 'POST') {
        return jsonResponse({ ok: true });
      }

      // 7. GET & POST /api/posts
      if (path === '/api/posts') {
        const user = await getAuthUser(request, db);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

        if (request.method === 'GET') {
          const rows = await db.prepare('SELECT * FROM posts ORDER BY id DESC LIMIT 100').all();
          return jsonResponse(rows.results || []);
        }

        if (request.method === 'POST') {
          const body = await request.json();
          const content = (body.content || '').trim();
          if (!content) return jsonResponse({ error: 'Post cannot be empty.' }, 400);

          await db
            .prepare('INSERT INTO posts (user_id, user_name, content, created_at) VALUES (?, ?, ?, ?)')
            .bind(user.id, user.name, content, new Date().toISOString())
            .run();

          return jsonResponse({ ok: true });
        }
      }

      // 8. POST /api/answers
      if (path === '/api/answers' && request.method === 'POST') {
        const user = await getAuthUser(request, db);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

        const body = await request.json();
        const lessonTab = (body.lesson_tab || 'Answers').trim();
        const moduleName = (body.module || '').trim();
        const lessonName = (body.lesson || '').trim();
        const question = (body.question || '').trim();
        const answer = (body.answer || '').trim();

        await db
          .prepare(
            `INSERT INTO answers (user_id, member_number, user_name, user_email, lesson_tab, module, lesson, question, answer)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            user.id,
            user.member_number || String(user.id),
            user.name,
            user.email,
            lessonTab,
            moduleName,
            lessonName,
            question,
            answer
          )
          .run();

        if (tenant.apps_script_url && tenant.ams_sheet_url) {
          ctx.waitUntil(
            fetch(tenant.apps_script_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'save_answer',
                sheetUrl: tenant.ams_sheet_url,
                lesson_tab: lessonTab,
                member_number: user.member_number || String(user.id),
                name: user.name,
                email: user.email,
                module: moduleName,
                lesson: lessonName,
                question,
                answer,
              }),
            }).catch(() => {})
          );
        }

        return jsonResponse({ ok: true });
      }

      // 8b. GET /api/poll-results?poll_key=...
      if (path === '/api/poll-results' && request.method === 'GET') {
        const user = await getAuthUser(request, db);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

        const pollKey = (url.searchParams.get('poll_key') || '').trim();
        if (!pollKey) return jsonResponse({ error: 'Missing poll_key' }, 400);

        const allVotes = await db.prepare('SELECT user_id, choices FROM poll_votes WHERE poll_key = ?').bind(pollKey).all();
        const rows = allVotes.results || [];
        const { counts, totalVoters } = extractPollCounts(rows);

        const myRow = rows.find((r) => r.user_id === user.id);
        let userChoices = [];
        if (myRow) {
          try {
            userChoices = JSON.parse(myRow.choices || '[]');
          } catch (_) {
            userChoices = myRow.choices ? [myRow.choices] : [];
          }
        }

        return jsonResponse({
          ok: true,
          voted: userChoices.length > 0,
          userChoices,
          counts,
          totalVoters,
        });
      }

      // 8c. POST /api/poll-vote
      if (path === '/api/poll-vote' && request.method === 'POST') {
        const user = await getAuthUser(request, db);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

        const body = await request.json();
        const pollKey = (body.poll_key || '').trim();
        const choices = Array.isArray(body.choices) ? body.choices.map((c) => String(c).trim()).filter(Boolean) : [];
        if (!pollKey || choices.length === 0) {
          return jsonResponse({ error: 'Please select at least one option.' }, 400);
        }

        await db
          .prepare(
            `INSERT INTO poll_votes (user_id, poll_key, choices, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, poll_key) DO UPDATE SET choices = excluded.choices, updated_at = excluded.updated_at`
          )
          .bind(user.id, pollKey, JSON.stringify(choices), new Date().toISOString())
          .run();

        const allVotes = await db.prepare('SELECT user_id, choices FROM poll_votes WHERE poll_key = ?').bind(pollKey).all();
        const { counts, totalVoters } = extractPollCounts(allVotes.results || []);

        if (tenant.apps_script_url && tenant.ams_sheet_url) {
          ctx.waitUntil(
            fetch(tenant.apps_script_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'save_answer',
                sheetUrl: tenant.ams_sheet_url,
                lesson_tab: (body.lesson_tab || 'Answers').trim(),
                member_number: user.member_number || String(user.id),
                name: user.name,
                email: user.email,
                module: (body.module || '').trim(),
                lesson: (body.lesson || '').trim(),
                question: '[Poll] ' + (body.question || '').trim(),
                answer: choices.join(', '),
              }),
            }).catch(() => {})
          );
        }

        return jsonResponse({
          ok: true,
          voted: true,
          userChoices: choices,
          counts,
          totalVoters,
        });
      }

      // ======================================================================
      // ADMIN ROUTES
      // ======================================================================
      const adminUser = await getAuthUser(request, db);
      if (!adminUser) {
        return jsonResponse({ error: 'Session token not recognized on ' + tenant.db_binding + '. Please log out and log back in.' }, 401);
      }

      const isAdmin = Number(adminUser.is_admin) === 1 || String(adminUser.member_number) === '1';
      if (!isAdmin) {
        return jsonResponse({ error: 'Account ' + adminUser.email + ' is not marked as Admin.' }, 403);
      }

      if (path === '/api/admin/users' && request.method === 'GET') {
        const usersRes = await db
          .prepare(
            `SELECT u.*,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count,
              (SELECT COUNT(DISTINCT lesson_tab) FROM answers a WHERE a.user_id = u.id) AS lessons_done,
              (SELECT COUNT(DISTINCT module) FROM answers a WHERE a.user_id = u.id AND a.module != '') AS modules_done
             FROM users u
             ORDER BY CAST(u.member_number AS INTEGER) ASC, u.id ASC`
          )
          .all();

        const postsCount = await db.prepare('SELECT COUNT(*) as cnt FROM posts').first();

        return jsonResponse({
          users: usersRes.results || [],
          total_posts: postsCount?.cnt || 0,
          open_reports: 0,
        });
      }

      if (path === '/api/admin/user-status' && request.method === 'POST') {
        const body = await request.json();
        await db.prepare('UPDATE users SET status = ? WHERE id = ?').bind(body.status, body.userId).run();
        return jsonResponse({ ok: true });
      }

      if (path === '/api/admin/user-paid' && request.method === 'POST') {
        const body = await request.json();
        await db.prepare('UPDATE users SET is_paid = ? WHERE id = ?').bind(body.is_paid ? 1 : 0, body.userId).run();
        return jsonResponse({ ok: true });
      }

      if (path === '/api/admin/user-admin' && request.method === 'POST') {
        const body = await request.json();
        await db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(body.is_admin ? 1 : 0, body.userId).run();
        return jsonResponse({ ok: true });
      }

      if (path === '/api/admin/reset-password' && request.method === 'POST') {
        const body = await request.json();
        const target = await db.prepare('SELECT email FROM users WHERE id = ?').bind(body.userId).first();
        if (!target) return jsonResponse({ error: 'User not found' }, 404);
        await db.prepare('UPDATE users SET password = ? WHERE id = ?').bind(target.email, body.userId).run();
        return jsonResponse({ ok: true });
      }

      if (path === '/api/admin/sync-members' && request.method === 'POST') {
        if (!tenant.apps_script_url || !tenant.ams_sheet_url) {
          return jsonResponse({ error: 'Apps Script URL or AMS Sheet URL is missing in Master Tenants Sheet.' }, 400);
        }

        const usersRes = await db
          .prepare(
            `SELECT u.member_number, u.name, u.email, u.status, u.is_paid, u.is_admin,
              u.session_count, u.click_count, u.created_at, u.last_seen,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count,
              (SELECT COUNT(DISTINCT lesson_tab) FROM answers a WHERE a.user_id = u.id) AS lessons_done,
              (SELECT COUNT(DISTINCT module) FROM answers a WHERE a.user_id = u.id AND a.module != '') AS modules_done
             FROM users u
             ORDER BY CAST(u.member_number AS INTEGER) ASC, u.id ASC`
          )
          .all();

        const scriptRes = await fetch(tenant.apps_script_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sync_members',
            sheetUrl: tenant.ams_sheet_url,
            members: usersRes.results || [],
          }),
        });

        const scriptJson = await scriptRes.json();
        return jsonResponse(scriptJson);
      }

      if (path === '/api/admin/settings' && request.method === 'POST') {
        const body = await request.json();
        const allowedKeys = [
          'site_name',
          'tagline',
          'hero_title',
          'hero_points',
          'logo_url',
          'favicon_url',
          'primary_color',
          'accent_color',
          'bg_color',
          'support_email',
        ];

        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            await db
              .prepare(
                `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
              )
              .bind(key, String(body[key]))
              .run();
          }
        }

        tenantCache.expiresAt = 0;

        if (tenant.apps_script_url) {
          ctx.waitUntil(
            fetch(tenant.apps_script_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'sync_settings',
                domain: tenant.domain,
                settings: body,
              }),
            }).catch(() => {})
          );
        }

        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || 'Server error' }, 500);
    }
  },
};
