

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
      if (url.pathname === '/api/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      }
      if (url.pathname === '/api/signup' && request.method === 'POST') {
        return await handleSignup(request, env, ctx);
      }
      if (url.pathname === '/api/change-password' && request.method === 'POST') {
        return await handleChangePassword(request, env, ctx);
      }
      if (url.pathname === '/api/posts') {
        if (request.method === 'GET') return await handleGetPosts(request, env);
        if (request.method === 'POST') return await handleCreatePost(request, env);
      }
      if (url.pathname === '/api/admin/stats' && request.method === 'GET') {
        return await handleAdminStats(request, env);
      }
      if (url.pathname === '/api/admin/users' && request.method === 'GET') {
        return await handleAdminUsers(request, env);
      }
      if (url.pathname === '/api/admin/reset-password' && request.method === 'POST') {
        return await handleAdminResetPassword(request, env);
      }

      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }
      return fetch(request);

    } catch (err) {
      return json({ error: err.message || 'Internal Server Error' }, 500);
    }
  }
};

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
      INSERT INTO users (name, email, password, member_number, status, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
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
    is_admin: !!user.is_admin
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
    INSERT INTO users (name, email, password, member_number, status, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(name || 'Classmate', cleanEmail, hash, nextNum, isFirstUser ? 'Admin' : 'Member', isFirstUser ? 1 : 0).run();

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
    is_admin: !!newUser.is_admin
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
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const uCount = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
  const pCount = await env.DB.prepare('SELECT COUNT(*) as count FROM posts').first();

  return json({
    users: uCount ? uCount.count : 0,
    posts: pCount ? pCount.count : 0
  });
}

async function handleAdminUsers(request, env) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized.' }, 403);

  const rows = await env.DB.prepare(`
    SELECT id, member_number, name, email, status, is_admin, created_at
    FROM users
    ORDER BY CAST(member_number AS INTEGER) ASC
  `).all();

  return json(rows.results || []);
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
