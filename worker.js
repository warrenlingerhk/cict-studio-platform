

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
      // 1. Auth Endpoints
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
      if (url.pathname === '/api/forgot-password' && request.method === 'POST') {
        return await handleForgotPassword(request, env, ctx);
      }
      if (url.pathname === '/api/reset-check' && request.method === 'GET') {
        return await handleResetCheck(request, env);
      }
      if (url.pathname === '/api/reset-password' && request.method === 'POST') {
        return await handleResetPassword(request, env, ctx);
      }

      // 2. Discussion Posts
      if (url.pathname === '/api/posts') {
        if (request.method === 'GET') return await handleGetPosts(request, env);
        if (request.method === 'POST') return await handleCreatePost(request, env);
      }

      // 3. Admin Tools
      if (url.pathname === '/api/admin/stats' && request.method === 'GET') {
        return await handleAdminStats(request, env);
      }
      if (url.pathname === '/api/admin/users' && request.method === 'GET') {
        return await handleAdminUsers(request, env);
      }
      if (url.pathname === '/api/admin/reset-password' && request.method === 'POST') {
        return await handleAdminResetPassword(request, env);
      }
      if (url.pathname === '/api/admin/set-admin' && request.method === 'POST') {
        return await handleAdminSetAdmin(request, env);
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
// HANDLERS: AUTHENTICATION & PROFILE
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
      INSERT INTO users (name, email, password, member_number, status, is_admin, welcomed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `).bind('DrWarren', cleanEmail, hash, '1', 'Admin', 1).run();

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
    status: user.status || (user.is_admin ? 'Admin' : 'Member'),
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
    INSERT INTO users (name, email, password, member_number, status, is_admin, welcomed, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).bind(name || 'Classmate', cleanEmail, hash, nextNum, isFirstUser ? 'Admin' : 'Member', isFirstUser ? 1 : 0).run();

  const newUser = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?')
    .bind(cleanEmail)
    .first();

  const token = newUser.id + ':' + crypto.randomUUID();
  await env.DB.prepare('UPDATE users SET auth_token = ? WHERE id = ?').bind(token, newUser.id).run();

  if (env.AMS_WEBHOOK_URL) {
    ctx.waitUntil(fetch(env.AMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'member',
        name: newUser.name,
        email: newUser.email,
        user_number: newUser.member_number,
        status: newUser.status,
        joined: new Date().toISOString()
      })
    }).catch(() => {}));
  }

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
    if (env.AMS_WEBHOOK_URL) {
      ctx.waitUntil(fetch(env.AMS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'member-update',
          email: user.email,
          name: cleanName
        })
      }).catch(() => {}));
    }
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

async function handleForgotPassword(request, env, ctx) {
  const { email } = await request.json();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?').bind(cleanEmail).first();

  if (user && env.AMS_WEBHOOK_URL) {
    const resetToken = crypto.randomUUID();
    await env.DB.prepare("UPDATE users SET reset_token = ?, reset_expires = datetime('now', '+1 hour') WHERE id = ?")
      .bind(resetToken, user.id)
      .run();

    const resetUrl = new URL(request.url).origin + '/?reset=' + resetToken;

    ctx.waitUntil(fetch(env.AMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'reset-email',
        to: user.email,
        name: user.name,
        url: resetUrl
      })
    }).catch(() => {}));
  }

  return json({ ok: true });
}

async function handleResetCheck(request, env) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return json({ valid: false });

  const user = await env.DB.prepare("SELECT id FROM users WHERE reset_token = ? AND reset_expires > datetime('now')")
    .bind(token)
    .first();

  return json({ valid: !!user });
}

async function handleResetPassword(request, env, ctx) {
  const { token, newPassword } = await request.json();
  if (!token || !newPassword || newPassword.length < 8) {
    return json({ error: 'Valid token and minimum 8-character password required.' }, 400);
  }

  const user = await env.DB.prepare("SELECT * FROM users WHERE reset_token = ? AND reset_expires > datetime('now')")
    .bind(token)
    .first();

  if (!user) {
    return json({ error: 'Reset token is expired or invalid.' }, 400);
  }

  const hash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?")
    .bind(hash, user.id)
    .run();

  return json({ ok: true });
}

// ============================================================================
// HANDLERS: COMMUNITY & ADMIN
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

async function handleAdminStats(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized Admin.' }, 403);

  const uCount = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
  const pCount = await env.DB.prepare('SELECT COUNT(*) as count FROM posts').first();

  return json({
    users: uCount ? uCount.count : 0,
    posts: pCount ? pCount.count : 0
  });
}

async function handleAdminUsers(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized Admin.' }, 403);

  const rows = await env.DB.prepare(`
    SELECT id, member_number, name, email, status, is_admin, last_seen, created_at
    FROM users
    ORDER BY CAST(member_number AS INTEGER) ASC
  `).all();

  return json(rows.results || []);
}

async function handleAdminResetPassword(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized Admin.' }, 403);

  const { user_id, new_password } = await request.json();
  if (!user_id || !new_password || new_password.length < 8) {
    return json({ error: 'User ID and 8+ character password required.' }, 400);
  }

  const hash = await hashPassword(new_password);
  await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?')
    .bind(hash, user_id)
    .run();

  return json({ ok: true });
}

async function handleAdminSetAdmin(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized Admin.' }, 403);

  const { user_id, is_admin } = await request.json();
  await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?')
    .bind(is_admin ? 1 : 0, user_id)
    .run();

  return json({ ok: true });
}

async function handleAdminSyncMembers(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized Admin.' }, 403);
  if (!env.AMS_WEBHOOK_URL) return json({ error: 'AMS_WEBHOOK_URL not configured.' }, 500);

  const users = await env.DB.prepare('SELECT * FROM users ORDER BY CAST(member_number AS INTEGER) ASC').all();

  const membersPayload = (users.results || []).map(u => ({
    user_number: u.member_number,
    name: u.name,
    email: u.email,
    status: u.status || (u.is_admin ? 'Admin' : 'Member'),
    joined: u.created_at
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
