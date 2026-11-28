

// ============================================================================
// MULTI-TENANT SAAS WORKER (worker.js)
// Cloudflare Workers + D1 + Google Sheets CMS/AMS
// ============================================================================

const MASTER_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTgotv2zBG-2uYmMPtCyXUP1z6TtgJ1Cg6WxocccVq29lbixrkiGvpkVawVtxz-_-I-OZHIJNHN58el/pub?gid=0&single=true&output=csv';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!path.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not Found', { status: 404 });
    }

    try {
      await ensureSchema(env.DB);
      const domain = url.hostname.toLowerCase();
      const tenant = await getTenantConfig(domain);

      // 1. PUBLIC CONFIG
      if (path === '/api/config' && request.method === 'GET') {
        const dbSettings = await getDbSettings(env.DB, domain);
        const mergedSettings = {
          site_name: dbSettings.site_name || tenant.settings.site_name || 'Platform',
          tagline: dbSettings.tagline || tenant.settings.tagline || '',
          hero_title: dbSettings.hero_title || tenant.settings.hero_title || 'Your Legacy, Scaled by Design.',
          hero_points: dbSettings.hero_points || tenant.settings.hero_points || '',
          logo_url: dbSettings.logo_url || tenant.settings.logo_url || '',
          favicon_url: dbSettings.favicon_url || tenant.settings.favicon_url || '',
          primary_color: dbSettings.primary_color || tenant.settings.primary_color || '#0B2545',
          accent_color: dbSettings.accent_color || tenant.settings.accent_color || '#D4AF37',
          bg_color: dbSettings.bg_color || tenant.settings.bg_color || '#FFFFFF',
          support_email: dbSettings.support_email || tenant.settings.support_email || '',
          email_signing_name: dbSettings.email_signing_name || tenant.settings.email_signing_name || '',
          // Offer Slot 1
          offer_1_enabled: dbSettings.offer_1_enabled || '0',
          offer_1_title: dbSettings.offer_1_title || '',
          offer_1_subtitle: dbSettings.offer_1_subtitle || '',
          offer_1_bullets: dbSettings.offer_1_bullets || '',
          offer_1_timer_mins: dbSettings.offer_1_timer_mins || '60',
          offer_1_fast_price: dbSettings.offer_1_fast_price || '',
          offer_1_fast_url: dbSettings.offer_1_fast_url || '',
          offer_1_reg_price: dbSettings.offer_1_reg_price || '',
          offer_1_reg_url: dbSettings.offer_1_reg_url || '',
          offer_1_secret: dbSettings.offer_1_secret || '',
          // Offer Slot 2
          offer_2_enabled: dbSettings.offer_2_enabled || '0',
          offer_2_title: dbSettings.offer_2_title || '',
          offer_2_subtitle: dbSettings.offer_2_subtitle || '',
          offer_2_bullets: dbSettings.offer_2_bullets || '',
          offer_2_timer_mins: dbSettings.offer_2_timer_mins || '60',
          offer_2_fast_price: dbSettings.offer_2_fast_price || '',
          offer_2_fast_url: dbSettings.offer_2_fast_url || '',
          offer_2_reg_price: dbSettings.offer_2_reg_price || '',
          offer_2_reg_url: dbSettings.offer_2_reg_url || '',
          offer_2_secret: dbSettings.offer_2_secret || ''
        };
        return json({ cms_csv_url: tenant.cms_csv_url, settings: mergedSettings });
      }

      // 2. AUTH ROUTES
      if (path === '/api/signup' && request.method === 'POST') {
        const body = await request.json();
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!name || !email || password.length < 8) {
          return json({ error: 'Name, email, and 8+ character password required.' }, 400);
        }

        const existing = await env.DB.prepare(
          'SELECT id FROM users WHERE tenant_domain = ? AND email = ?'
        ).bind(domain, email).first();
        if (existing) return json({ error: 'Email already registered.' }, 400);

        const countRow = await env.DB.prepare(
          'SELECT COUNT(*) as cnt FROM users WHERE tenant_domain = ?'
        ).bind(domain).first();
        const memberNum = (countRow?.cnt || 0) + 1;
        const isFirst = memberNum === 1;
        const status = isFirst ? 'Approved' : 'Pending';
        const isAdmin = isFirst ? 1 : 0;
        const isPaid = isFirst ? 1 : 0;
        const hash = await hashPassword(password);
        const now = new Date().toISOString();

        const res = await env.DB.prepare(
          `INSERT INTO users (tenant_domain, member_number, name, email, password_hash, status, is_paid, is_admin, session_count, click_count, last_seen, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
        ).bind(domain, memberNum, name, email, hash, status, isPaid, isAdmin, now, now).run();

        const userId = res.meta.last_row_id;
        const token = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO sessions (token, user_id, tenant_domain, created_at) VALUES (?, ?, ?, ?)'
        ).bind(token, userId, domain, now).run();

        return json({ token, name, email, member_number: memberNum, status, is_admin: isAdmin, is_paid: isPaid });
      }

      if (path === '/api/login' && request.method === 'POST') {
        const body = await request.json();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');

        const user = await env.DB.prepare(
          'SELECT * FROM users WHERE tenant_domain = ? AND email = ?'
        ).bind(domain, email).first();
        if (!user) return json({ error: 'Invalid email or password.' }, 401);

        const hash = await hashPassword(password);
        if (user.password_hash !== hash) return json({ error: 'Invalid email or password.' }, 401);

        const now = new Date().toISOString();
        await env.DB.prepare(
          'UPDATE users SET session_count = session_count + 1, last_seen = ? WHERE id = ?'
        ).bind(now, user.id).run();

        const token = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO sessions (token, user_id, tenant_domain, created_at) VALUES (?, ?, ?, ?)'
        ).bind(token, user.id, domain, now).run();

        return json({
          token,
          name: user.name,
          email: user.email,
          member_number: user.member_number,
          status: user.status,
          is_admin: user.is_admin,
          is_paid: user.is_paid
        });
      }

      if (path === '/api/forgot-password' && request.method === 'POST') {
        return json({ ok: true });
      }

      // Check auth for routes below (optional for GET /api/events and POST /api/events/enroll)
      const user = await getAuthUser(request, env.DB, domain);

      if (path === '/api/change-password' && request.method === 'POST') {
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const body = await request.json();
        const currentHash = await hashPassword(String(body.currentPassword || ''));
        if (currentHash !== user.password_hash) {
          return json({ error: 'Current password is incorrect.' }, 400);
        }

        const newName = String(body.newName || '').trim() || user.name;
        const newPass = String(body.newPassword || '').trim();
        const nextHash = newPass ? await hashPassword(newPass) : user.password_hash;

        await env.DB.prepare(
          'UPDATE users SET name = ?, password_hash = ? WHERE id = ?'
        ).bind(newName, nextHash, user.id).run();

        return json({ success: true, name: newName });
      }

      // 3. ACTIVITY & HEARTBEAT
      if (path === '/api/activity' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        let activeUser = user;
        if (!activeUser && body.token) {
          activeUser = await getAuthUserByToken(body.token, env.DB, domain);
        }
        if (!activeUser) return json({ ok: false }, 401);

        const clicks = Math.max(0, Number(body.clicks) || 0);
        const now = new Date().toISOString();
        await env.DB.prepare(
          'UPDATE users SET click_count = click_count + ?, last_seen = ? WHERE id = ?'
        ).bind(clicks, now, activeUser.id).run();
        return json({ ok: true });
      }

      if (path === '/api/heartbeat' && request.method === 'GET') {
        if (!user) return json({ ok: false }, 401);
        await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?')
          .bind(new Date().toISOString(), user.id).run();
        return json({ ok: true });
      }

      // 4. COMMUNITY POSTS
      if (path === '/api/posts' && request.method === 'GET') {
        if (!user) return json([], 401);
        const { results } = await env.DB.prepare(
          'SELECT * FROM posts WHERE tenant_domain = ? ORDER BY id DESC LIMIT 100'
        ).bind(domain).all();
        return json(results || []);
      }

      if (path === '/api/posts' && request.method === 'POST') {
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const body = await request.json();
        const content = String(body.content || '').trim();
        if (!content) return json({ error: 'Empty post' }, 400);

        await env.DB.prepare(
          'INSERT INTO posts (tenant_domain, user_id, user_name, content, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(domain, user.id, user.name, content, new Date().toISOString()).run();
        return json({ ok: true });
      }

      // 5. ANSWERS & PROGRESS
      if (path === '/api/my-answers' && request.method === 'GET') {
        if (!user) return json({ answers: [] }, 401);
        const { results } = await env.DB.prepare(
          'SELECT lesson_tab, module, item_code, question, answer FROM answers WHERE tenant_domain = ? AND user_id = ?'
        ).bind(domain, user.id).all();
        return json({ answers: results || [] });
      }

      if (path === '/api/answers' && request.method === 'POST') {
        if (!user) return json({ error: 'Unauthorized' }, 401);
        const body = await request.json();
        const lessonTab = String(body.lesson_tab || 'L1').trim();
        const moduleName = String(body.module || '').trim();
        const itemCode = String(body.item_code || '').trim();
        const question = String(body.question || '').trim();
        const answer = String(body.answer ?? '');
        const now = new Date().toISOString();

        // Upsert in D1
        const existing = await env.DB.prepare(
          'SELECT id FROM answers WHERE tenant_domain = ? AND user_id = ? AND lesson_tab = ? AND item_code = ?'
        ).bind(domain, user.id, lessonTab, itemCode).first();

        if (existing) {
          await env.DB.prepare(
            'UPDATE answers SET answer = ?, question = ?, module = ?, updated_at = ? WHERE id = ?'
          ).bind(answer, question, moduleName, now, existing.id).run();
        } else {
          await env.DB.prepare(
            'INSERT INTO answers (tenant_domain, user_id, lesson_tab, module, item_code, question, answer, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(domain, user.id, lessonTab, moduleName, itemCode, question, answer, now).run();
        }

        // Forward to Central AMS Apps Script
        if (env.AMS_WEBHOOK_URL && tenant.ams_sheet_url) {
          ctx.waitUntil(
            fetch(env.AMS_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'save_answer',
                sheetUrl: tenant.ams_sheet_url,
                lesson_tab: lessonTab,
                module: moduleName,
                lesson: body.lesson || '',
                item_code: itemCode,
                title: body.title || question,
                question: question,
                answer: answer,
                email: user.email,
                name: user.name,
                member_number: user.member_number
              })
            }).catch(() => {})
          );
        }

        return json({ ok: true });
      }

      // 6. EVENTS & CALENDAR
      if (path === '/api/events' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM events WHERE tenant_domain = ? ORDER BY event_date ASC, start_time ASC'
        ).bind(domain).all();

        const isAdmin = user && (Number(user.is_admin) === 1 || String(user.member_number) === '1');
        const events = [];

        for (const ev of results || []) {
          const cntRow = await env.DB.prepare(
            'SELECT COUNT(*) as cnt FROM event_rsvps WHERE event_id = ?'
          ).bind(ev.id).first();

          let enrolled = false;
          if (user) {
            const rsvp = await env.DB.prepare(
              'SELECT id FROM event_rsvps WHERE event_id = ? AND (user_id = ? OR email = ?)'
            ).bind(ev.id, user.id, user.email).first();
            enrolled = Boolean(rsvp);
          }

          events.push({
            ...ev,
            enrolled: enrolled || isAdmin,
            rsvp_count: cntRow?.cnt || 0,
            location_url: (enrolled || isAdmin) ? ev.location_url : ''
          });
        }
        return json({ events });
      }

      if (path === '/api/events/enroll' && request.method === 'POST') {
        const body = await request.json();
        const ev = await env.DB.prepare(
          'SELECT * FROM events WHERE id = ? AND tenant_domain = ?'
        ).bind(body.event_id, domain).first();
        if (!ev) return json({ error: 'Event not found.' }, 404);

        const name = user ? user.name : String(body.guest_name || '').trim();
        const email = user ? user.email : String(body.guest_email || '').trim().toLowerCase();
        if (!name || !email) return json({ error: 'Name and email are required.' }, 400);

        const existing = await env.DB.prepare(
          'SELECT id FROM event_rsvps WHERE event_id = ? AND email = ?'
        ).bind(ev.id, email).first();

        const now = new Date().toISOString();
        if (!existing) {
          await env.DB.prepare(
            'INSERT INTO event_rsvps (event_id, tenant_domain, user_id, name, email, enrolled_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(ev.id, domain, user ? user.id : null, name, email, now).run();

          if (env.AMS_WEBHOOK_URL && tenant.ams_sheet_url) {
            ctx.waitUntil(
              fetch(env.AMS_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'save_rsvp',
                  sheetUrl: tenant.ams_sheet_url,
                  enrolled_at: now,
                  event_title: ev.title,
                  event_date: ev.event_date,
                  start_time: ev.start_time,
                  access_level: ev.access_level,
                  member_number: user ? user.member_number : 'Guest',
                  name,
                  email
                })
              }).catch(() => {})
            );
          }
        }

        const cntRow = await env.DB.prepare(
          'SELECT COUNT(*) as cnt FROM event_rsvps WHERE event_id = ?'
        ).bind(ev.id).first();

        return json({ ok: true, location_url: ev.location_url, rsvp_count: cntRow?.cnt || 1 });
      }

      if (path === '/api/events/save' && request.method === 'POST') {
        if (!isAdminUser(user)) return json({ error: 'Admin access required.' }, 403);
        const b = await request.json();

        if (b.id) {
          await env.DB.prepare(
            `UPDATE events SET title=?, event_date=?, start_time=?, duration_mins=?, recurring=?, location_type=?, location_url=?, cover_url=?, description=?, access_level=?
             WHERE id=? AND tenant_domain=?`
          ).bind(
            b.title, b.event_date, b.start_time, Number(b.duration_mins) || 60, b.recurring || 'none',
            b.location_type || 'Zoom', b.location_url || '', b.cover_url || '', b.description || '',
            b.access_level || 'all', b.id, domain
          ).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO events (tenant_domain, title, event_date, start_time, duration_mins, recurring, location_type, location_url, cover_url, description, access_level, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            domain, b.title, b.event_date, b.start_time, Number(b.duration_mins) || 60, b.recurring || 'none',
            b.location_type || 'Zoom', b.location_url || '', b.cover_url || '', b.description || '',
            b.access_level || 'all', new Date().toISOString()
          ).run();
        }
        return json({ ok: true });
      }

      if (path === '/api/events/delete' && request.method === 'POST') {
        if (!isAdminUser(user)) return json({ error: 'Admin access required.' }, 403);
        const b = await request.json();
        await env.DB.prepare('DELETE FROM events WHERE id = ? AND tenant_domain = ?').bind(b.id, domain).run();
        await env.DB.prepare('DELETE FROM event_rsvps WHERE event_id = ?').bind(b.id).run();
        return json({ ok: true });
      }

      // 7. ADMIN ROUTES
      if (path.startsWith('/api/admin/')) {
        if (!isAdminUser(user)) return json({ error: 'Admin access required.' }, 403);

        if (path === '/api/admin/settings' && request.method === 'POST') {
          const body = await request.json();
          const allowedKeys = [
            'site_name', 'tagline', 'hero_title', 'hero_points', 'logo_url', 'favicon_url',
            'primary_color', 'accent_color', 'bg_color', 'support_email', 'email_signing_name',
            'offer_1_enabled', 'offer_1_title', 'offer_1_subtitle', 'offer_1_bullets', 'offer_1_timer_mins',
            'offer_1_fast_price', 'offer_1_fast_url', 'offer_1_reg_price', 'offer_1_reg_url', 'offer_1_secret',
            'offer_2_enabled', 'offer_2_title', 'offer_2_subtitle', 'offer_2_bullets', 'offer_2_timer_mins',
            'offer_2_fast_price', 'offer_2_fast_url', 'offer_2_reg_price', 'offer_2_reg_url', 'offer_2_secret'
          ];

          for (const key of allowedKeys) {
            if (body[key] !== undefined) {
              await env.DB.prepare(
                'INSERT INTO settings (tenant_domain, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_domain, key) DO UPDATE SET value = excluded.value'
              ).bind(domain, key, String(body[key])).run();
            }
          }
          return json({ ok: true });
        }

        if (path === '/api/admin/users' && request.method === 'GET') {
          const { results: users } = await env.DB.prepare(
            `SELECT u.*,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) as post_count,
              (SELECT COUNT(*) FROM answers a WHERE a.user_id = u.id AND a.item_code LIKE '%_done' AND a.item_code NOT LIKE 'L%_done' AND a.answer = 'Done') as modules_done,
              (SELECT COUNT(*) FROM answers a WHERE a.user_id = u.id AND a.item_code LIKE 'L%_done' AND a.answer = 'Done') as lessons_done
             FROM users u WHERE u.tenant_domain = ? ORDER BY u.member_number ASC`
          ).bind(domain).all();

          const postRow = await env.DB.prepare(
            'SELECT COUNT(*) as cnt FROM posts WHERE tenant_domain = ?'
          ).bind(domain).first();

          return json({ users: users || [], total_posts: postRow?.cnt || 0 });
        }

        if (path === '/api/admin/user-status' && request.method === 'POST') {
          const b = await request.json();
          await env.DB.prepare('UPDATE users SET status = ? WHERE id = ? AND tenant_domain = ?')
            .bind(b.status, b.userId, domain).run();
          return json({ ok: true });
        }

        if (path === '/api/admin/user-paid' && request.method === 'POST') {
          const b = await request.json();
          await env.DB.prepare('UPDATE users SET is_paid = ? WHERE id = ? AND tenant_domain = ?')
            .bind(Number(b.is_paid) ? 1 : 0, b.userId, domain).run();
          return json({ ok: true });
        }

        if (path === '/api/admin/user-admin' && request.method === 'POST') {
          const b = await request.json();
          await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ? AND tenant_domain = ?')
            .bind(Number(b.is_admin) ? 1 : 0, b.userId, domain).run();
          return json({ ok: true });
        }

        if (path === '/api/admin/reset-password' && request.method === 'POST') {
          const b = await request.json();
          const target = await env.DB.prepare(
            'SELECT email FROM users WHERE id = ? AND tenant_domain = ?'
          ).bind(b.userId, domain).first();
          if (!target) return json({ error: 'User not found.' }, 404);

          const hash = await hashPassword(target.email);
          await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            .bind(hash, b.userId).run();
          return json({ ok: true });
        }

        if (path === '/api/admin/sync-members' && request.method === 'POST') {
          if (!env.AMS_WEBHOOK_URL || !tenant.ams_sheet_url) {
            return json({ error: 'AMS Webhook or Sheet URL not configured.' }, 400);
          }

          const { results: members } = await env.DB.prepare(
            `SELECT u.member_number, u.name, u.email, u.status, u.is_paid, u.is_admin,
                    u.session_count, u.click_count, u.created_at, u.last_seen,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) as post_count,
              (SELECT COUNT(*) FROM answers a WHERE a.user_id = u.id AND a.item_code LIKE '%_done' AND a.item_code NOT LIKE 'L%_done' AND a.answer = 'Done') as modules_done,
              (SELECT COUNT(*) FROM answers a WHERE a.user_id = u.id AND a.item_code LIKE 'L%_done' AND a.answer = 'Done') as lessons_done
             FROM users u WHERE u.tenant_domain = ? ORDER BY u.member_number ASC`
          ).bind(domain).all();

          const res = await fetch(env.AMS_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync_members',
              sheetUrl: tenant.ams_sheet_url,
              members: members || []
            })
          });
          if (!res.ok) return json({ error: 'Failed to sync with Google Sheet.' }, 500);
          return json({ ok: true, message: `Synced ${(members || []).length} members to Google Sheet!` });
        }
      }

      return json({ error: 'Endpoint not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'Server error' }, 500);
    }
  }
};

// ============================================================================
// HELPERS
// ============================================================================

async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_domain TEXT NOT NULL,
      member_number INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT DEFAULT 'Pending',
      is_paid INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      session_count INTEGER DEFAULT 0,
      click_count INTEGER DEFAULT 0,
      last_seen TEXT,
      created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_domain TEXT NOT NULL,
      created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_domain TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_domain TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      lesson_tab TEXT NOT NULL,
      module TEXT,
      item_code TEXT,
      question TEXT,
      answer TEXT,
      updated_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (
      tenant_domain TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (tenant_domain, key)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_domain TEXT NOT NULL,
      title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      duration_mins INTEGER DEFAULT 60,
      recurring TEXT DEFAULT 'none',
      location_type TEXT DEFAULT 'Zoom',
      location_url TEXT,
      cover_url TEXT,
      description TEXT,
      access_level TEXT DEFAULT 'all',
      created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS event_rsvps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      tenant_domain TEXT NOT NULL,
      user_id INTEGER,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      enrolled_at TEXT
    )`)
  ]);
}

async function getTenantConfig(domain) {
  const fallback = { cms_csv_url: '', ams_sheet_url: '', settings: {} };
  try {
    const res = await fetch(MASTER_CSV_URL);
    if (!res.ok) return fallback;
    const rows = parseCsv(await res.text());
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rowDomain = String(r[0] || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (rowDomain === domain) {
        return {
          cms_csv_url: (r[1] || '').trim(),
          ams_sheet_url: (r[2] || '').trim(),
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
            email_signing_name: (r[16] || '').trim()
          }
        };
      }
    }
  } catch (e) {}
  return fallback;
}

async function getDbSettings(db, domain) {
  const { results } = await db.prepare(
    'SELECT key, value FROM settings WHERE tenant_domain = ?'
  ).bind(domain).all();
  const map = {};
  for (const row of results || []) map[row.key] = row.value;
  return map;
}

async function getAuthUser(request, db, domain) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  return getAuthUserByToken(token, db, domain);
}

async function getAuthUserByToken(token, db, domain) {
  const row = await db.prepare(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.tenant_domain = ?`
  ).bind(token, domain).first();
  return row || null;
}

function isAdminUser(user) {
  return Boolean(user && (Number(user.is_admin) === 1 || String(user.member_number) === '1'));
}

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseCsv(text) {
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
