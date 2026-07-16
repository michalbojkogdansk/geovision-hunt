/**
 * GeoVision Hunt — Worker v3
 * Auth + Submission + Artifact Config (KV-only, never public repo)
 *
 * KV keys:
 *   team:{name}          → { name, salt, hash, created_at }
 *   session:{token}      → { team, created_at }
 *   rate:{token}         → { count, window_start }
 *   find:{team}:{id}     → timestamp (duplicate guard)
 *   art-cfg              → { artifacts: { "1": { rare, description, maps_url, released }, ... } }
 */

const CORS = {
  'Access-Control-Allow-Origin':  'https://michalbojkogdansk.github.io',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
};

const SESSION_TTL = 60 * 60 * 24 * 7;
const RATE_WINDOW = 60 * 60;
const RATE_MAX    = 10;
const OWNER       = 'michalbojkogdansk';
const REPO        = 'geovision-hunt';

const PHRASE = 'Innovate with Passion, Engage with Purpose, and Win with Integrity';
const ARTIFACTS = (() => {
  const out = {}; let id = 1;
  for (const ch of PHRASE)
    if (/[a-zA-Z]/.test(ch)) out[id++] = ch.toUpperCase();
  return out;
})();

// ── Crypto ────────────────────────────────────────────────────
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

function normalizeTeam(name) { return name.trim().toLowerCase().replace(/\s+/g,' '); }

// ── Admin auth ────────────────────────────────────────────────
async function verifyAdmin(request, env) {
  const pwd = request.headers.get('X-Admin-Password');
  if (!pwd) return false;
  const raw = await env.GEOVISION_TEAMS.get('admin:password');
  if (!raw) return false;
  const { salt, hash } = JSON.parse(raw);
  return await hashPassword(pwd, salt) === hash;
}

// ── Artifact config (KV) ──────────────────────────────────────
async function getArtCfg(env) {
  const raw = await env.GEOVISION_TEAMS.get('art-cfg');
  return raw ? JSON.parse(raw) : { artifacts: {} };
}

async function saveArtCfg(env, cfg) {
  await env.GEOVISION_TEAMS.put('art-cfg', JSON.stringify(cfg));
}

// ── Rate limiting ─────────────────────────────────────────────
async function checkRateLimit(env, token) {
  const key = `rate:${token}`;
  const raw = await env.GEOVISION_TEAMS.get(key);
  const now = Math.floor(Date.now() / 1000);
  let rec = raw ? JSON.parse(raw) : { count: 0, window_start: now };
  if (now - rec.window_start > RATE_WINDOW) rec = { count: 0, window_start: now };
  if (rec.count >= RATE_MAX) return false;
  rec.count++;
  await env.GEOVISION_TEAMS.put(key, JSON.stringify(rec), { expirationTtl: RATE_WINDOW + 60 });
  return true;
}

async function isDuplicate(env, teamNorm, id) {
  return (await env.GEOVISION_TEAMS.get(`find:${teamNorm}:${id}`)) !== null;
}

async function recordFind(env, teamNorm, id, ts) {
  await env.GEOVISION_TEAMS.put(`find:${teamNorm}:${id}`, ts, { expirationTtl: 60 * 60 * 24 * 30 });
}

// ── GitHub API ────────────────────────────────────────────────
async function githubRequest(pat, method, path, body) {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${pat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'geovision-hunt-worker',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Responses ─────────────────────────────────────────────────
const ok  = d => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
const err = (msg, status=400) => new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// ── Auth handlers ─────────────────────────────────────────────
async function handleRegister(request, env) {
  const { name, password } = await request.json();
  if (!name || name.trim().length < 2)  return err('Team name must be at least 2 characters.');
  if (!password || password.length < 4) return err('Password must be at least 4 characters.');
  if (name.trim().length > 60)          return err('Team name too long.');
  const key = `team:${normalizeTeam(name)}`;
  if (await env.GEOVISION_TEAMS.get(key)) return err('Team name already taken.', 409);
  const salt = await generateToken();
  const hash = await hashPassword(password, salt);
  await env.GEOVISION_TEAMS.put(key, JSON.stringify({ name: name.trim(), salt, hash, created_at: new Date().toISOString() }));
  const token = await generateToken();
  await env.GEOVISION_TEAMS.put(`session:${token}`, JSON.stringify({ team: name.trim(), created_at: new Date().toISOString() }), { expirationTtl: SESSION_TTL });
  return ok({ token, team: name.trim(), registered: true });
}

async function handleLogin(request, env) {
  const { name, password } = await request.json();
  if (!name || !password) return err('Name and password required.');
  const raw = await env.GEOVISION_TEAMS.get(`team:${normalizeTeam(name)}`);
  if (!raw) return err('Team not found. Check the name or register first.', 404);
  const team = JSON.parse(raw);
  if (await hashPassword(password, team.salt) !== team.hash) return err('Incorrect password.', 401);
  const token = await generateToken();
  await env.GEOVISION_TEAMS.put(`session:${token}`, JSON.stringify({ team: team.name, created_at: new Date().toISOString() }), { expirationTtl: SESSION_TTL });
  return ok({ token, team: team.name });
}

async function handleLogout(request, env) {
  const { token } = await request.json();
  if (token) await env.GEOVISION_TEAMS.delete(`session:${token}`);
  return ok({ ok: true });
}

async function handleVerify(request, env) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return err('Token required.', 400);
  const raw = await env.GEOVISION_TEAMS.get(`session:${token}`);
  if (!raw) return err('Invalid or expired session.', 401);
  return ok({ team: JSON.parse(raw).team, valid: true });
}

// ── Submission ────────────────────────────────────────────────
async function handleSubmit(request, env) {
  const { token, artifact_id, photo_b64 } = await request.json();
  const sessRaw = await env.GEOVISION_TEAMS.get(`session:${token}`);
  if (!sessRaw) return err('Invalid or expired session. Please sign in again.', 401);
  const { team } = JSON.parse(sessRaw);
  const teamNorm = normalizeTeam(team);

  const num = parseInt(artifact_id);
  if (!num || num < 1 || num > 55) return err('Invalid artifact number.');
  if (!photo_b64) return err('Photo required.');

  if (!await checkRateLimit(env, token)) return err(`Too many submissions. Maximum ${RATE_MAX} per hour.`, 429);
  if (await isDuplicate(env, teamNorm, num)) return err(`Your team already submitted artifact #${num}.`, 409);

  // Read rare status from KV — no hardcoded values
  const artCfg = await getArtCfg(env);
  const artEntry = artCfg.artifacts?.[num] || {};
  const isRare = artEntry.rare === true;
  const letter = ARTIFACTS[num];

  const ts   = new Date().toISOString();
  const slug = team.replace(/[^a-z0-9]/gi,'_').slice(0,30);
  const fname = `photos/${ts.replace(/[:.]/g,'-')}_${slug}_${String(num).padStart(2,'00')}.jpg`;
  const pat  = env.GITHUB_PAT;

  const upRes = await githubRequest(pat, 'PUT', `/repos/${OWNER}/${REPO}/contents/${fname}`, {
    message: `photo: ${team} #${num}`, content: photo_b64, branch: 'main',
  });
  if (!upRes.ok) { const e = await upRes.json(); return err(`Photo upload failed: ${e.message}`, 502); }
  const photoUrl = (await upRes.json()).content.html_url;

  const issueBody = [
    `## Hunt Submission`, `| | |`, `|---|---|`,
    `| **Team** | ${team} |`,
    `| **Artifact** | #${num} — ${letter}${isRare?' (Rare)':''} |`,
    `| **Timestamp** | ${ts} |`,
    `| **Photo** | [View](${photoUrl}) |`,
    ``, `*Submitted via GeoVision Hunt*`,
  ].join('\n');

  const issRes = await githubRequest(pat, 'POST', `/repos/${OWNER}/${REPO}/issues`, {
    title: `[HUNT] #${String(num).padStart(2,'00')} ${letter} | ${team}`,
    body: issueBody, labels: ['submission'],
  });
  if (!issRes.ok) { const e = await issRes.json(); return err(`Submission failed: ${e.message}`, 502); }

  await recordFind(env, teamNorm, num, ts);
  const issue = await issRes.json();
  return ok({ ok: true, issue_url: issue.html_url, team, artifact_id: num, letter });
}

// ── Public artifacts (released only) ─────────────────────────
async function handlePublicArtifacts(env) {
  const cfg = await getArtCfg(env);
  const released = {};
  for (const [id, art] of Object.entries(cfg.artifacts || {})) {
    if (art.released) {
      released[id] = { rare: art.rare, description: art.description, maps_url: art.maps_url };
    }
  }
  return ok({ artifacts: released });
}

// ── Admin: get full artifact config ──────────────────────────
async function handleAdminGetArtifacts(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  const cfg = await getArtCfg(env);
  return ok(cfg);
}

// ── Admin: save single artifact config ───────────────────────
async function handleAdminSaveArtifact(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  const { id, rare, description, maps_url, released } = await request.json();
  if (!id || id < 1 || id > 55) return err('Invalid artifact ID.');
  const cfg = await getArtCfg(env);
  if (!cfg.artifacts) cfg.artifacts = {};
  cfg.artifacts[id] = {
    rare: rare === true,
    description: (description || '').trim(),
    maps_url: (maps_url || '').trim(),
    released: released === true,
  };
  await saveArtCfg(env, cfg);
  return ok({ saved: true, id });
}

// ── Admin: release a batch of artifacts ──────────────────────
async function handleAdminRelease(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  const { ids, released } = await request.json();
  if (!Array.isArray(ids)) return err('ids must be an array.');
  const cfg = await getArtCfg(env);
  if (!cfg.artifacts) cfg.artifacts = {};
  for (const id of ids) {
    if (!cfg.artifacts[id]) cfg.artifacts[id] = { rare: false, description: '', maps_url: '', released: false };
    cfg.artifacts[id].released = released !== false;
  }
  await saveArtCfg(env, cfg);
  return ok({ released: ids.length });
}

// ── Admin: set admin password ─────────────────────────────────
async function handleAdminSetPassword(request, env) {
  const { setup_key, password } = await request.json();
  if (setup_key !== env.ADMIN_SETUP_KEY) return err('Invalid setup key.', 401);
  if (!password || password.length < 6) return err('Password must be at least 6 characters.');
  const salt = await generateToken();
  const hash = await hashPassword(password, salt);
  await env.GEOVISION_TEAMS.put('admin:password', JSON.stringify({ salt, hash, set_at: new Date().toISOString() }));
  return ok({ ok: true });
}

// ── Admin: verify admin password ─────────────────────────────
async function handleAdminVerify(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  return ok({ ok: true });
}

// ── Router ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const path = new URL(request.url).pathname;
    try {
      if (path === '/register'              && request.method === 'POST') return handleRegister(request, env);
      if (path === '/login'                 && request.method === 'POST') return handleLogin(request, env);
      if (path === '/logout'                && request.method === 'POST') return handleLogout(request, env);
      if (path === '/verify'                && request.method === 'GET')  return handleVerify(request, env);
      if (path === '/submit'                && request.method === 'POST') return handleSubmit(request, env);
      if (path === '/public/artifacts'      && request.method === 'GET')  return handlePublicArtifacts(env);
      if (path === '/admin/artifacts'       && request.method === 'GET')  return handleAdminGetArtifacts(request, env);
      if (path === '/admin/save-artifact'   && request.method === 'POST') return handleAdminSaveArtifact(request, env);
      if (path === '/admin/release'         && request.method === 'POST') return handleAdminRelease(request, env);
      if (path === '/admin/set-password'    && request.method === 'POST') return handleAdminSetPassword(request, env);
      if (path === '/admin/verify'          && request.method === 'GET')  return handleAdminVerify(request, env);
      return err('Not found.', 404);
    } catch(e) {
      return err(`Server error: ${e.message}`, 500);
    }
  }
};
