/**
 * GeoVision Hunt — Worker v4
 * KV keys:
 *   team:{name}          → { name, salt, hash, created_at }
 *   session:{token}      → { team, created_at }
 *   rate:{token}         → { count, window_start }
 *   find:{team}:{id}     → timestamp
 *   art-cfg              → { artifacts: { "1": { rare, description, maps_url, batch_id } } }
 *   event-cfg            → { start_date, end_date, batches: [{ id, name, start_date }] }
 *   admin:password       → { salt, hash, set_at }
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

// ── Event config ──────────────────────────────────────────────
async function getEventCfg(env) {
  const raw = await env.GEOVISION_TEAMS.get('event-cfg');
  return raw ? JSON.parse(raw) : { start_date: null, end_date: null, batches: [] };
}

function getEventStatus(eventCfg) {
  const now = Date.now();
  const start = eventCfg.start_date ? new Date(eventCfg.start_date).getTime() : null;
  const end   = eventCfg.end_date   ? new Date(eventCfg.end_date).getTime()   : null;
  if (start && now < start) return { status: 'before', start: eventCfg.start_date, end: eventCfg.end_date };
  if (end   && now > end)   return { status: 'ended',  start: eventCfg.start_date, end: eventCfg.end_date };
  return { status: 'active', start: eventCfg.start_date, end: eventCfg.end_date };
}

// ── Artifact config ───────────────────────────────────────────
async function getArtCfg(env) {
  const raw = await env.GEOVISION_TEAMS.get('art-cfg');
  return raw ? JSON.parse(raw) : { artifacts: {} };
}

async function saveArtCfg(env, cfg) {
  await env.GEOVISION_TEAMS.put('art-cfg', JSON.stringify(cfg));
}

function isArtifactVisible(artEntry, eventCfg) {
  const now = Date.now();
  if (artEntry.batch_id != null) {
    const batch = (eventCfg.batches || []).find(b => b.id === artEntry.batch_id);
    // Batch not found in event-cfg (not saved yet) — show hints so admin can verify
    if (!batch || !batch.start_date) return true;
    return now >= new Date(batch.start_date).getTime();
  }
  return artEntry.released === true;
}

// ── Admin auth ────────────────────────────────────────────────
async function verifyAdmin(request, env) {
  const pwd = request.headers.get('X-Admin-Password');
  if (!pwd) return false;
  const raw = await env.GEOVISION_TEAMS.get('admin:password');
  if (!raw) return false;
  const { salt, hash } = JSON.parse(raw);
  return await hashPassword(pwd, salt) === hash;
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
  const eventCfg = await getEventCfg(env);
  const { status, start } = getEventStatus(eventCfg);
  if (status === 'before') return err(`Registration opens on ${new Date(start).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' })}.`, 403);
  if (status === 'ended')  return err('The event has ended. No new registrations are accepted.', 403);

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
  const eventCfg = await getEventCfg(env);
  const { status, start, end } = getEventStatus(eventCfg);
  if (status === 'before') return err(`The event has not started yet. It begins on ${new Date(start).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' })}.`, 403);
  if (status === 'ended')  return err('The event has ended. No further submissions are accepted.', 403);

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

  const artCfg = await getArtCfg(env);
  const artEntry = artCfg.artifacts?.[num] || {};
  const isRare = artEntry.rare === true;
  const letter = ARTIFACTS[num];
  const ts    = new Date().toISOString();
  const slug  = team.replace(/[^a-z0-9]/gi,'_').slice(0,30);
  const fname = `photos/${ts.replace(/[:.]/g,'-')}_${slug}_${String(num).padStart(2,'00')}.jpg`;

  const upRes = await githubRequest(env.GITHUB_PAT, 'PUT', `/repos/${OWNER}/${REPO}/contents/${fname}`, {
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

  const issRes = await githubRequest(env.GITHUB_PAT, 'POST', `/repos/${OWNER}/${REPO}/issues`, {
    title: `[HUNT] #${String(num).padStart(2,'00')} ${letter} | ${team}`,
    body: issueBody, labels: ['submission'],
  });
  if (!issRes.ok) { const e = await issRes.json(); return err(`Submission failed: ${e.message}`, 502); }
  await recordFind(env, teamNorm, num, ts);
  return ok({ ok: true, issue_url: (await issRes.json()).html_url, team, artifact_id: num, letter });
}

// ── Public: event config ──────────────────────────────────────
async function handlePublicEventConfig(env) {
  const cfg = await getEventCfg(env);
  const { status } = getEventStatus(cfg);
  return ok({ ...cfg, status });
}

// ── Public: released artifacts ────────────────────────────────
async function handlePublicArtifacts(env) {
  const [artCfg, eventCfg] = await Promise.all([getArtCfg(env), getEventCfg(env)]);
  const visible = {};
  for (const [id, art] of Object.entries(artCfg.artifacts || {})) {
    // rare is always visible; hints/maps only when batch is live
    const hintsVisible = isArtifactVisible(art, eventCfg);
    visible[id] = {
      rare: art.rare,
      batch_id: art.batch_id,
      ...(hintsVisible ? { description: art.description, maps_url: art.maps_url } : {})
    };
  }
  return ok({ artifacts: visible });
}

// ── Admin: get full artifact config ──────────────────────────
async function handleAdminGetArtifacts(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  return ok(await getArtCfg(env));
}

// ── Admin: save single artifact ───────────────────────────────
async function handleAdminSaveArtifact(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  const { id, rare, description, maps_url, batch_id } = await request.json();
  if (!id || id < 1 || id > 55) return err('Invalid artifact ID.');
  const cfg = await getArtCfg(env);
  if (!cfg.artifacts) cfg.artifacts = {};
  cfg.artifacts[id] = {
    rare: rare === true,
    description: (description || '').trim(),
    maps_url: (maps_url || '').trim(),
    batch_id: batch_id != null ? batch_id : null,
  };
  await saveArtCfg(env, cfg);
  return ok({ saved: true, id });
}

// ── Admin: get event config ───────────────────────────────────
async function handleAdminGetEventConfig(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  return ok(await getEventCfg(env));
}

// ── Admin: save event config ──────────────────────────────────
async function handleAdminSaveEventConfig(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  const { start_date, end_date, batches } = await request.json();
  await env.GEOVISION_TEAMS.put('event-cfg', JSON.stringify({ start_date: start_date || null, end_date: end_date || null, batches: batches || [] }));
  return ok({ saved: true });
}

// ── Admin: list teams ─────────────────────────────────────────
async function handleAdminTeams(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  const list = await env.GEOVISION_TEAMS.list({ prefix: 'team:' });
  const teams = await Promise.all(list.keys.map(async k => {
    const raw = await env.GEOVISION_TEAMS.get(k.name);
    const t = raw ? JSON.parse(raw) : {};
    return { name: t.name, created_at: t.created_at };
  }));
  return ok({ teams });
}

// ── Admin: reset team password ────────────────────────────────
async function handleAdminResetPassword(request, env) {
  if (!await verifyAdmin(request, env)) return err('Unauthorized.', 401);
  const { team_name, new_password } = await request.json();
  if (!team_name || !new_password) return err('team_name and new_password required.');
  if (new_password.length < 4) return err('Password must be at least 4 characters.');
  const key = `team:${normalizeTeam(team_name)}`;
  const raw = await env.GEOVISION_TEAMS.get(key);
  if (!raw) return err('Team not found.', 404);
  const team = JSON.parse(raw);
  const salt = await generateToken();
  const hash = await hashPassword(new_password, salt);
  await env.GEOVISION_TEAMS.put(key, JSON.stringify({ ...team, salt, hash }));
  return ok({ ok: true, team: team.name });
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
      if (path === '/register'                 && request.method === 'POST') return handleRegister(request, env);
      if (path === '/login'                    && request.method === 'POST') return handleLogin(request, env);
      if (path === '/logout'                   && request.method === 'POST') return handleLogout(request, env);
      if (path === '/verify'                   && request.method === 'GET')  return handleVerify(request, env);
      if (path === '/submit'                   && request.method === 'POST') return handleSubmit(request, env);
      if (path === '/public/artifacts'         && request.method === 'GET')  return handlePublicArtifacts(env);
      if (path === '/public/event-config'      && request.method === 'GET')  return handlePublicEventConfig(env);
      if (path === '/admin/verify'             && request.method === 'GET')  return handleAdminVerify(request, env);
      if (path === '/admin/artifacts'          && request.method === 'GET')  return handleAdminGetArtifacts(request, env);
      if (path === '/admin/save-artifact'      && request.method === 'POST') return handleAdminSaveArtifact(request, env);
      if (path === '/admin/event-config'       && request.method === 'GET')  return handleAdminGetEventConfig(request, env);
      if (path === '/admin/save-event-config'  && request.method === 'POST') return handleAdminSaveEventConfig(request, env);
      if (path === '/admin/teams'              && request.method === 'GET')  return handleAdminTeams(request, env);
      if (path === '/admin/reset-team-password'&& request.method === 'POST') return handleAdminResetPassword(request, env);
      if (path === '/admin/set-password'       && request.method === 'POST') return handleAdminSetPassword(request, env);
      return err('Not found.', 404);
    } catch(e) {
      return err(`Server error: ${e.message}`, 500);
    }
  }
};
