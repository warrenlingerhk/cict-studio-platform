

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env, ctx, url); }
      catch (e) { return json({ error: e.message }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  // --- MIGRATIONS & SCHEMA SETUP ---
  if (path === '/api/migrate' && method === 'GET') {
    const results = [];
    const statements = [
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, name TEXT, user_number INTEGER, is_admin INTEGER DEFAULT 0, banned INTEGER DEFAULT 0, status TEXT DEFAULT 'Approved', last_seen DATETIME, welcomed INTEGER DEFAULT 0, is_active INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, user_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, item_id TEXT, completed INTEGER DEFAULT 0, note TEXT, type TEXT DEFAULT 'answer', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, content TEXT, parent_id INTEGER, pinned INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS likes (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, user_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, reporter_id INTEGER, reason TEXT, resolved INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS password_resets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, token TEXT, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_user_item ON progress(user_id, item_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_post_user ON likes(post_id, user_id)"
    ];
    for (const s of statements) {
      try { await env.DB.prepare(s).run(); results.push('ready: ' + s.slice(0, 30)); }
      catch (e) { results.push('error: ' + e.message); }
    }
    return json({ results });
  }

  // --- AUTH ---
  if (path === '/api/signup' && method === 'POST') {
    const { name, email, password } = await request.json();
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password || String(password).length < 8)
      return json({ error: 'Email and password (8+ chars) required.' }, 400);

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(cleanEmail).first();
    if (existing) return json({ error: 'That email is already registered. Please log in.' }, 409);

    const hash = await hashPassword(password);
    const maxUser = await env.DB.prepare('SELECT MAX(user_number) as max_num FROM users').first();
    const nextUserNumber = Math.max(101, (maxUser?.max_num || 0) + 1);

    try {
      await env.DB.prepare("INSERT INTO users (email, password, name, user_number, status, created_at) VALUES (?, ?, ?, ?, 'Approved', datetime('now'))")
        .bind(cleanEmail, hash, String(name || '').trim(), nextUserNumber).run();
    } catch (e) {
      return json({ error: 'Sign-up failed: ' + e.message }, 500);
    }

    const user = await env.DB.prepare('SELECT id, name, user_number FROM users WHERE email = ?').bind(cleanEmail).first();
    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, user.id).run();

    const mrow = await memberRow(env, user.id);
    if (mrow) ctx.waitUntil(syncMember(env, mrow));
    return json({ token, name: user.name, user_number: user.user_number, is_admin: 0, status: 'Approved' });
  }

  if (path === '/api/login' && method === 'POST') {
    const { email, password } = await request.json();
    const clean = String(email || '').trim().toLowerCase();
    const user = await env.DB.prepare('SELECT id, password, name, user_number, is_admin, status FROM users WHERE email = ?').bind(clean).first();
    if (!user) return json({ error: 'No account found for this email.' }, 404);
    if (user.password !== await hashPassword(password || '')) return json({ error: 'Incorrect password.' }, 401);
    if (user.status === 'Banned') return json({ error: 'This account has been suspended.' }, 403);

    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, user.id).run();
    return json({ token, name: user.name, user_number: user.user_number, is_admin: user.is_admin, status: user.status });
  }

  if (path === '/api/me' && method === 'GET') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const user = await env.DB.prepare('SELECT name, is_admin, user_number, status, welcomed, is_active FROM users WHERE id = ?').bind(userId).first();
    if (!user) return json({ error: 'Please log in.' }, 401);
    const out = { name: user.name, is_admin: user.is_admin, user_number: user.user_number, status: user.status, welcomed: user.welcomed, is_active: user.is_active || 0 };
    if (out.is_active) {
      out.score = await scoreOf(env, userId);
      out.ref_score = await refScore(env);
    }
    return json(out);
  }

  if (path === '/api/heartbeat' && method === 'GET') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    try { await env.DB.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").bind(userId).run(); } catch (e) {}
    return json({ ok: true });
  }

  // --- PROGRESS SYNC (TO D1 & AMS SHEET) ---
  if (path === '/api/progress') {
    const g = await gateUser(request, env);
    if (!g.id) return json({ error: 'Please log in.' }, 401);
    if (g.status !== 'Approved') return json({ error: 'Access pending approval.' }, 403);

    if (method === 'GET') {
      const res = await env.DB.prepare('SELECT item_id, completed, note, type FROM progress WHERE user_id = ?').bind(g.id).all();
      return json(res.results);
    }

    if (method === 'POST') {
      const { progress, lesson } = await request.json();
      for (const item of (progress || [])) {
        await env.DB.prepare("INSERT OR REPLACE INTO progress (user_id, item_id, completed, note, type, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
          .bind(g.id, item.item_id, item.completed ? 1 : 0, item.note || '', item.type || 'answer').run();
      }
      if (env.AMS_WEBHOOK_URL) {
        const user = await env.DB.prepare('SELECT email, name, user_number FROM users WHERE id = ?').bind(g.id).first();
        ctx.waitUntil(syncSheet(env.AMS_WEBHOOK_URL, user.email, user.name, user.user_number, lesson, progress || []));
      }
      return json({ success: true });
    }
  }

  // --- COMMUNITY POSTS ---
  if (path === '/api/posts' && method === 'GET') {
    const g = await gateUser(request, env);
    if (!g.id) return json({ error: 'Please log in.' }, 401);
    const posts = await env.DB.prepare(`SELECT p.*, u.name as user_name, (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count, (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?) as user_liked FROM posts p JOIN users u ON p.user_id = u.id WHERE p.parent_id IS NULL AND u.status <> 'Banned' ORDER BY p.pinned DESC, p.created_at DESC LIMIT 50`).bind(g.id).all();
    for (let post of posts.results) {
      post.replies = await env.DB.prepare(`SELECT p.*, u.name as user_name, (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count, (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?) as user_liked FROM posts p JOIN users u ON p.user_id = u.id WHERE p.parent_id = ? AND u.status <> 'Banned' ORDER BY p.created_at ASC`).bind(g.id, post.id).all();
    }
    return json(posts.results);
  }

  if (path === '/api/posts' && method === 'POST') {
    const g = await gateUser(request, env);
    if (!g.id) return json({ error: 'Please log in.' }, 401);
    const { content, parent_id } = await request.json();
    if (!content) return json({ error: 'Post cannot be empty.' }, 400);
    const res = await env.DB.prepare('INSERT INTO posts (user_id, content, parent_id) VALUES (?, ?, ?)').bind(g.id, content, parent_id || null).run();
    return json({ id: res.meta.last_row_id });
  }

  if (path === '/api/likes' && method === 'POST') {
    const g = await gateUser(request, env);
    if (!g.id) return json({ error: 'Please log in.' }, 401);
    const { post_id } = await request.json();
    try {
      await env.DB.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').bind(post_id, g.id).run();
      return json({ liked: true });
    } catch (e) {
      await env.DB.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').bind(post_id, g.id).run();
      return json({ liked: false });
    }
  }

  return json({ error: 'Not found.' }, 404);
}

const SCORE_SQL = `(SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id AND ((p.type IN ('module_completion','lesson_completion') AND p.completed = 1) OR (p.type IN ('answer','poll') AND TRIM(p.note) <> '')))`;

async function scoreOf(env, userId) {
  const r = await env.DB.prepare(`SELECT ${SCORE_SQL} AS s FROM users u WHERE u.id = ?`).bind(userId).first();
  return r?.s || 0;
}

async function refScore(env) {
  const ref = await env.DB.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY user_number ASC LIMIT 1').first();
  if (!ref) return 0;
  return await scoreOf(env, ref.id);
}

async function memberRow(env, userId) {
  return await env.DB.prepare(`SELECT u.email, u.name, u.created_at, u.status, u.user_number, u.is_active FROM users u WHERE u.id = ?`).bind(userId).first();
}

async function gateUser(request, env) {
  const userId = await auth(request, env);
  if (!userId) return { id: null, status: null };
  const u = await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first();
  return { id: userId, status: u ? u.status : 'Approved' };
}

async function auth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const s = await env.DB.prepare('SELECT user_id FROM sessions WHERE token = ?').bind(token).first();
  return s ? s.user_id : null;
}

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function syncSheet(webhookUrl, email, name, user_number, lesson, progress) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ email, name, user_number, lesson, progress })
    });
  } catch (e) {}
}

async function syncMember(env, u) {
  if (!env.AMS_WEBHOOK_URL || !u) return;
  try {
    await fetch(env.AMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        type: 'member',
        email: u.email,
        name: u.name,
        joined: (u.created_at || '').slice(0, 10),
        status: u.status,
        user_number: u.user_number
      })
    });
  } catch (e) {}
}
