

// ============================================================================
// STUDIO PLATFORM — MULTI-TENANT BACKEND WORKER (worker.js)
// ============================================================================

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

  // --- AUTH & PROFILE ---
  if (path === '/api/login' && method === 'POST') {
    return await handleLogin(request, env);
  }
  if (path === '/api/signup' && method === 'POST') {
    return await handleSignup(request, env, ctx);
  }
  if (path === '/api/change-password' && method === 'POST') {
    return await handleChangePassword(request, env, ctx);
  }
  if (path === '/api/heartbeat' && method === 'GET') {
    return await handleHeartbeat(request, env);
  }

  // --- COMMUNITY POSTS ---
  if (path === '/api/posts') {
    if (method === 'GET') return await handleGetPosts(request, env);
    if (method === 'POST') return await handleCreatePost(request, env);
  }
  if (path === '/api/posts/delete' && method === 'POST') {
    return await handleDeletePost(request, env);
  }

  // --- SITE ADMINISTRATION ---
  if (path === '/api/admin/stats' && method === 'GET') {
    return await handleAdminStats(request, env);
  }
  if (path === '/api/admin/analytics' && method === 'GET') {
    return await handleAdminAnalytics(request, env);
  }
  if (path === '/api/admin/users' && method === 'GET') {
    return await handleAdminUsers(request, env);
  }
  if (path === '/api/admin/status' && method === 'POST') {
    return await handleAdminSetStatus(request, env);
  }
  if (path === '/api/admin/set-paid' && method === 'POST') {
    return await handleAdminSetPaid(request, env);
  }
  if (path === '/api/admin/set-admin' && method === 'POST') {
    return await handleAdminSetAdmin(request, env);
  }
  if (path === '/api/admin/reset-password' && method === 'POST') {
    return await handleAdminResetPassword(request, env);
  }
  if (path === '/api/admin/sync-members' && method === 'POST') {
    return await handleAdminSyncMembers(request, env);
  }
  if (path === '/api/admin/reports' && method === 'GET') {
    return await handleAdminReports(request, env);
  }
  if (path === '/api/admin/reports/resolve' && method === 'POST') {
    return await handleAdminResolveReport(request, env);
  }
  if (path === '/api/admin/reports/delete' && method === 'POST') {
    return await handleAdminDeleteReport(request, env);
  }

  return json({ error: 'Endpoint not found.' }, 404);
}

// ============================================================================
// HANDLERS: AUTH
// ============================================================================

async function handleLogin(request, env) {
  const { email, password } = await request.json();
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !password) {
    return json({ error: 'Email and password required.' }, 400);
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?')
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

  await env.DB.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").bind(user.id).run();

  const token = user.id + ':' + crypto.randomUUID();
  await env.DB.prepare("UPDATE users SET auth_token = ? WHERE id = ?").bind(token, user.id).run();

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

async function handleSignup(request, env, ctx) {
  const { name, email, password } = await request.json();
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !password || password.length < 8) {
    return json({ error: 'Valid email and password (8+ characters) required.' }, 400);
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = ?').bind(cleanEmail).first();
  if (existing) {
    return json({ error: 'An account with this email already exists. Please log in.' }, 409);
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
  const nextNum = (countRow ? countRow.c : 0) + 1;
  const isFirstUser = nextNum === 1;
  const hash = await hashPassword(password);

  await env.DB.prepare(`
    INSERT INTO users (name, email, password, member_number, status, is_admin, is_paid, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).bind(
    name || 'Classmate',
    cleanEmail,
    hash,
    String(nextNum),
    isFirstUser ? 'Approved' : 'Pending',
    isFirstUser ? 1 : 0,
    isFirstUser ? 1 : 0
  ).run();

  const newUser = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?').bind(cleanEmail).first();
  const token = newUser.id + ':' + crypto.randomUUID();
  await env.DB.prepare('UPDATE users SET auth_token = ? WHERE id = ?').bind(token, newUser.id).run();

  if (env.AMS_WEBHOOK_URL) {
    ctx.waitUntil(syncMemberWebhook(env.AMS_WEBHOOK_URL, {
      name: newUser.name,
      email: newUser.email,
      member_number: newUser.member_number,
      status: newUser.status,
      active: newUser.is_paid ? 'Paid' : 'Free',
      joined: new Date().toISOString().slice(0, 10)
    }));
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

async function handleChangePassword(request, env, ctx) {
  const user = await authenticate(request, env);
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
    await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(newHash, user.id).run();
  }

  if (cleanName) {
    await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(cleanName, user.id).run();
  }

  return json({ success: true });
}

async function handleHeartbeat(request, env) {
  const user = await authenticate(request, env);
  if (user) {
    await env.DB.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").bind(user.id).run();
  }
  return json({ ok: true });
}

// ============================================================================
// HANDLERS: POSTS
// ============================================================================

async function handleGetPosts(request, env) {
  const rows = await env.DB.prepare(`SELECT id, user_name, content, created_at FROM posts ORDER BY id DESC LIMIT 50`).all();
  return json(rows.results || []);
}

async function handleCreatePost(request, env) {
  const user = await authenticate(request, env);
  if (!user) return json({ error: 'Unauthorized.' }, 401);

  const { content } = await request.json();
  if (!content || !content.trim()) return json({ error: 'Post content required.' }, 400);

  await env.DB.prepare(`INSERT INTO posts (user_id, user_name, content, created_at) VALUES (?, ?, ?, datetime('now'))`)
    .bind(user.id, user.name, content.trim()).run();

  return json({ ok: true });
}

async function handleDeletePost(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Admin only.' }, 403);
  const { post_id } = await request.json();
  await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(post_id).run();
  return json({ success: true });
}

// ============================================================================
// HANDLERS: SITE ADMINISTRATION
// ============================================================================

async function handleAdminStats(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const uCount = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
  const pCount = await env.DB.prepare('SELECT COUNT(*) as c FROM posts').first();
  let rCount = { c: 0 };
  try { rCount = await env.DB.prepare('SELECT COUNT(*) as c FROM reports WHERE resolved = 0').first() || { c: 0 }; } catch (e) {}
  const aCount = await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE last_seen >= datetime('now', '-5 minutes')").first();

  return json({
    users: uCount ? uCount.c : 0,
    posts: pCount ? pCount.c : 0,
    reports: rCount ? rCount.c : 0,
    active: aCount ? aCount.c : 0
  });
}

async function handleAdminAnalytics(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const totalUsers = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
  const totalPosts = await env.DB.prepare('SELECT COUNT(*) as c FROM posts').first();
  const totalCount = totalUsers?.c || 0;
  const postsCount = totalPosts?.c || 0;

  return json({
    totalUsers: totalCount,
    activeLearners: totalCount > 0 ? totalCount : 0,
    eliteRate: 0,
    engagement: totalCount > 0 ? (postsCount / totalCount).toFixed(1) : '0.0',
    healthRatio: '0.00'
  });
}

async function handleAdminUsers(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const rows = await env.DB.prepare(`
    SELECT u.id, u.member_number, u.name, u.email, u.status, u.is_admin, u.is_paid, u.created_at, u.last_seen,
      (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) as post_count,
      0 as modules_done,
      0 as lessons_done
    FROM users u
    ORDER BY CASE WHEN u.status = 'Pending' THEN 0 ELSE 1 END ASC, CAST(u.member_number AS INTEGER) ASC
  `).all();

  return json(rows.results || []);
}

async function handleAdminSetStatus(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, status } = await request.json();
  await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, user_id).run();
  return json({ success: true });
}

async function handleAdminSetPaid(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, is_paid } = await request.json();
  await env.DB.prepare('UPDATE users SET is_paid = ? WHERE id = ?').bind(is_paid ? 1 : 0, user_id).run();
  return json({ success: true });
}

async function handleAdminSetAdmin(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, is_admin } = await request.json();
  await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(is_admin ? 1 : 0, user_id).run();
  return json({ success: true });
}

async function handleAdminResetPassword(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, new_password } = await request.json();
  if (!user_id || !new_password || new_password.length < 8) return json({ error: 'Password must be 8+ characters.' }, 400);

  const hash = await hashPassword(new_password);
  await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(hash, user_id).run();
  return json({ success: true });
}

async function handleAdminSyncMembers(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  if (!env.AMS_WEBHOOK_URL) return json({ error: 'AMS_WEBHOOK_URL not configured.' }, 400);

  const users = await env.DB.prepare('SELECT * FROM users ORDER BY CAST(member_number AS INTEGER) ASC').all();
  const members = (users.results || []).map(u => ({
    email: u.email,
    name: u.name,
    joined: (u.created_at || '').slice(0, 10),
    status: u.status,
    member_number: u.member_number,
    active: u.is_paid ? 'Paid' : 'Free'
  }));

  const res = await fetch(env.AMS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'members', members })
  });

  return json({ success: res.ok, count: members.length });
}

async function handleAdminReports(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  try {
    const res = await env.DB.prepare(`SELECT * FROM reports ORDER BY id DESC LIMIT 50`).all();
    return json(res.results || []);
  } catch (e) {
    return json([]);
  }
}

async function handleAdminResolveReport(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  const { report_id, resolved } = await request.json();
  try {
    await env.DB.prepare('UPDATE reports SET resolved = ? WHERE id = ?').bind(resolved, report_id).run();
  } catch (e) {}
  return json({ success: true });
}

async function handleAdminDeleteReport(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  const { report_id } = await request.json();
  try {
    await env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(report_id).run();
  } catch (e) {}
  return json({ success: true });
}

// ============================================================================
// HELPERS
// ============================================================================

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE auth_token = ?').bind(token).first();
}

async function authenticateAdmin(request, env) {
  const user = await authenticate(request, env);
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

async function syncMemberWebhook(url, member) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'member', ...member })
    });
  } catch (e) {}
}
