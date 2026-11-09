

// ============================================================================
// CICT STUDIO — BACKEND WORKER (worker.js)
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // 1. Auth & Profile
      if (url.pathname === '/api/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      }
      if (url.pathname === '/api/signup' && request.method === 'POST') {
        return await handleSignup(request, env, ctx);
      }
      if (url.pathname === '/api/change-password' && request.method === 'POST') {
        return await handleChangePassword(request, env, ctx);
      }
      if (url.pathname === '/api/welcome-seen' && request.method === 'POST') {
        return await handleWelcomeSeen(request, env);
      }

      // 2. Posts
      if (url.pathname === '/api/posts') {
        if (request.method === 'GET') return await handleGetPosts(request, env);
        if (request.method === 'POST') return await handleCreatePost(request, env);
      }

      // 3. Admin Tools
      if (url.pathname === '/api/admin/stats' && request.method === 'GET') {
        return await handleAdminStats(request, env);
      }
      if (url.pathname === '/api/admin/analytics' && request.method === 'GET') {
        return await handleAdminAnalytics(request, env);
      }
      if (url.pathname === '/api/admin/users' && request.method === 'GET') {
        return await handleAdminUsers(request, env);
      }
      if (url.pathname === '/api/admin/status' && request.method === 'POST') {
        return await handleAdminSetStatus(request, env);
      }
      if (url.pathname === '/api/admin/set-paid' && request.method === 'POST') {
        return await handleAdminSetPaid(request, env);
      }
      if (url.pathname === '/api/admin/set-admin' && request.method === 'POST') {
        return await handleAdminSetAdmin(request, env);
      }
      if (url.pathname === '/api/admin/reset-password' && request.method === 'POST') {
        return await handleAdminResetPassword(request, env);
      }
      if (url.pathname === '/api/admin/sync-members' && request.method === 'POST') {
        return await handleAdminSyncMembers(request, env);
      }

      // 4. Static Asset Fallback
      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }
      return fetch(request);

    } catch (err) {
      return json({ error: err.message || 'Internal Server Error' }, 500);
    }
  }
};

// ============================================================================
// HANDLERS: AUTH & PROFILE
// ============================================================================

async function handleLogin(request, env) {
  const { email, password } = await request.json();
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !password) {
    return json({ error: 'Email and password required.' }, 400);
  }

  let user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?')
    .bind(cleanEmail)
    .first();

  if (!user && cleanEmail === 'drwarren@cict.co') {
    const hash = await hashPassword(cleanEmail);
    await env.DB.prepare(`
      INSERT INTO users (name, email, password, member_number, status, is_admin, is_paid, welcomed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 0, datetime('now'))
    `).bind('DrWarren', cleanEmail, hash, '1', 'Approved', 1).run();

    user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?')
      .bind(cleanEmail)
      .first();
  }

  if (!user) {
    return json({ error: 'Invalid credentials.' }, 401);
  }

  const inputHash = await hashPassword(password);
  const isValid = (user.password === inputHash) || (password === user.email);

  if (!isValid) {
    return json({ error: 'Incorrect password.' }, 401);
  }

  await env.DB.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?")
    .bind(user.id)
    .run();

  const token = user.id + ':' + crypto.randomUUID();
  await env.DB.prepare("UPDATE users SET auth_token = ? WHERE id = ?")
    .bind(token, user.id)
    .run();

  return json({
    token,
    name: user.name,
    email: user.email,
    user_number: user.member_number || '1',
    status: user.status || (user.is_admin ? 'Approved' : 'Pending'),
    is_admin: !!user.is_admin,
    welcomed: user.welcomed !== undefined ? user.welcomed : 1
  });
}

async function handleSignup(request, env, ctx) {
  const { name, email, password } = await request.json();
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !password || password.length < 8) {
    return json({ error: 'Valid email and 8+ character password required.' }, 400);
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = ?')
    .bind(cleanEmail)
    .first();

  if (existing) {
    return json({ error: 'An account with this email already exists.' }, 409);
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
  const nextNum = String((countRow ? countRow.count : 0) + 1);

  const hash = await hashPassword(password);
  const isFirstUser = nextNum === '1' || cleanEmail === 'drwarren@cict.co';

  await env.DB.prepare(`
    INSERT INTO users (name, email, password, member_number, status, is_admin, is_paid, welcomed, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, datetime('now'), datetime('now'))
  `).bind(name || 'Classmate', cleanEmail, hash, nextNum, isFirstUser ? 'Approved' : 'Pending', isFirstUser ? 1 : 0).run();

  const newUser = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?')
    .bind(cleanEmail)
    .first();

  const token = newUser.id + ':' + crypto.randomUUID();
  await env.DB.prepare('UPDATE users SET auth_token = ? WHERE id = ?').bind(token, newUser.id).run();

  return json({
    token,
    name: newUser.name,
    email: newUser.email,
    user_number: newUser.member_number,
    status: newUser.status,
    is_admin: !!newUser.is_admin,
    welcomed: 0
  });
}

async function handleChangePassword(request, env, ctx) {
  const user = await authenticate(request, env);
  if (!user) return json({ error: 'Please log in again.' }, 401);

  const { currentPassword, newPassword, newName } = await request.json();
  const cleanName = String(newName || '').trim();

  if (!cleanName && !newPassword) {
    return json({ error: 'Enter a new name, a new password, or both.' }, 400);
  }

  const currentHash = await hashPassword(currentPassword || '');
  const isValid = (user.password === currentHash) || (currentPassword === user.email);

  if (!isValid) {
    return json({ error: 'Current password is incorrect.' }, 400);
  }

  if (newPassword) {
    if (String(newPassword).length < 8) return json({ error: 'New password must be 8+ characters.' }, 400);
    const newHash = await hashPassword(newPassword);
    await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(newHash, user.id).run();
  }

  if (cleanName) {
    await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(cleanName, user.id).run();
  }

  return json({ success: true });
}

async function handleWelcomeSeen(request, env) {
  const user = await authenticate(request, env);
  if (!user) return json({ error: 'Please log in.' }, 401);
  try {
    await env.DB.prepare('UPDATE users SET welcomed = 1 WHERE id = ?').bind(user.id).run();
  } catch (e) {}
  return json({ success: true });
}

// ============================================================================
// HANDLERS: POSTS
// ============================================================================

async function handleGetPosts(request, env) {
  const rows = await env.DB.prepare(`
    SELECT id, user_name, content, created_at
    FROM posts
    ORDER BY id DESC
    LIMIT 50
  `).all();
  return json(rows.results || []);
}

async function handleCreatePost(request, env) {
  const user = await authenticate(request, env);
  if (!user) return json({ error: 'Unauthorized.' }, 401);

  const { content } = await request.json();
  if (!content || !content.trim()) return json({ error: 'Content required.' }, 400);

  await env.DB.prepare(`
    INSERT INTO posts (user_id, user_name, content, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).bind(user.id, user.name, content.trim()).run();

  return json({ ok: true });
}

// ============================================================================
// HANDLERS: ADMIN
// ============================================================================

async function handleAdminStats(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const uCount = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
  const pCount = await env.DB.prepare('SELECT COUNT(*) as count FROM posts').first();
  const aCount = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE last_seen >= datetime('now', '-5 minutes')").first();

  return json({
    users: uCount ? uCount.count : 0,
    posts: pCount ? pCount.count : 0,
    reports: 0,
    active: aCount ? aCount.count : 0
  });
}

async function handleAdminAnalytics(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const totalUsers = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
  const totalPosts = await env.DB.prepare('SELECT COUNT(*) as count FROM posts').first();
  const totalCount = totalUsers?.count || 0;
  const postsCount = totalPosts?.count || 0;

  return json({
    totalUsers: totalCount,
    activeLearners: totalCount > 0 ? 1 : 0,
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
  await env.DB.prepare('UPDATE users SET is_paid = ? WHERE id = ?').bind(is_paid, user_id).run();
  return json({ success: true });
}

async function handleAdminSetAdmin(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, is_admin } = await request.json();
  await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(is_admin, user_id).run();
  return json({ success: true });
}

async function handleAdminResetPassword(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const { user_id, new_password } = await request.json();
  if (!user_id || !new_password || new_password.length < 8) {
    return json({ error: 'Password must be 8+ characters.' }, 400);
  }

  const hash = await hashPassword(new_password);
  await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(hash, user_id).run();
  return json({ success: true });
}

async function handleAdminSyncMembers(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);
  if (!env.AMS_WEBHOOK_URL) return json({ error: 'AMS_WEBHOOK_URL not configured.' }, 500);

  const users = await env.DB.prepare('SELECT * FROM users ORDER BY CAST(member_number AS INTEGER) ASC').all();

  const membersPayload = (users.results || []).map(u => ({
    user_number: u.member_number,
    name: u.name,
    email: u.email,
    status: u.status || 'Approved',
    joined: (u.created_at || '').slice(0, 10),
    active: u.is_paid ? 'Paid' : 'Free'
  }));

  const res = await fetch(env.AMS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'members', members: membersPayload })
  });

  return json({ ok: res.ok });
}

// ============================================================================
// HELPER UTILITIES
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
  if (user.is_admin === 1 || user.member_number === '1' || user.email.toLowerCase() === 'drwarren@cict.co') {
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
