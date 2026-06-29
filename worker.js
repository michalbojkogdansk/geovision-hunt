/**
 * GeoVision Hunt — Auth + Submission Worker
 * POST /register  { name, password }
 * POST /login     { name, password } → { token, team }
 * GET  /verify    ?token=xxx         → { team }
 * POST /submit    { token, artifact_id, photo_b64 } → { ok }
 */

const CORS = {
  'Access-Control-Allow-Origin':  'https://michalbojkogdansk.github.io',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SESSION_TTL = 60 * 60 * 24 * 7;
const OWNER = 'michalbojkogdansk';
const REPO  = 'geovision-hunt';

const PHRASE = 'Innovate with Passion, Engage with Purpose, and Win with Integrity';
const RARE   = new Set([7,13,19,25,31,37,43,49,52,55]);

// Build artifact map once
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
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

function normalizeTeam(name) {
  return name.trim().toLowerCase().replace(/\s+/g,' ');
}

// ── GitHub API ────────────────────────────────────────────────
async function githubRequest(pat, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${pat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'geovision-hunt-worker',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

// ── Responses ─────────────────────────────────────────────────
const ok  = d => new Response(JSON.stringify(d),
  { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
const err = (msg, status=400) => new Response(JSON.stringify({ error: msg }),
  { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// ── Handlers ──────────────────────────────────────────────────
async function handleRegister(request, env) {
  const { name, password } = await request.json();
  if (!name || name.trim().length < 2)  return err('Team name must be at least 2 characters.');
  if (!password || password.length < 4) return err('Password must be at least 4 characters.');
  if (name.trim().length > 60)          return err('Team name too long.');

  const key = `team:${normalizeTeam(name)}`;
  if (await env.GEOVISION_TEAMS.get(key)) return err('Team name already taken.', 409);

  const salt = await generateToken();
  const hash = await hashPassword(password, salt);
  await env.GEOVISION_TEAMS.put(key, JSON.stringify({
    name: name.trim(), salt, hash, created_at: new Date().toISOString(),
  }));

  const token = await generateToken();
  await env.GEOVISION_TEAMS.put(`session:${token}`,
    JSON.stringify({ team: name.trim(), created_at: new Date().toISOString() }),
    { expirationTtl: SESSION_TTL }
  );
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
  await env.GEOVISION_TEAMS.put(`session:${token}`,
    JSON.stringify({ team: team.name, created_at: new Date().toISOString() }),
    { expirationTtl: SESSION_TTL }
  );
  return ok({ token, team: team.name });
}

async function handleVerify(request, env) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return err('Token required.', 400);
  const raw = await env.GEOVISION_TEAMS.get(`session:${token}`);
  if (!raw) return err('Invalid or expired session.', 401);
  return ok({ team: JSON.parse(raw).team, valid: true });
}

async function handleSubmit(request, env) {
  const { token, artifact_id, photo_b64 } = await request.json();

  // Verify session
  const sessRaw = await env.GEOVISION_TEAMS.get(`session:${token}`);
  if (!sessRaw) return err('Invalid or expired session. Please sign in again.', 401);
  const { team } = JSON.parse(sessRaw);

  // Validate artifact
  const num = parseInt(artifact_id);
  if (!num || num < 1 || num > 55) return err('Invalid artifact number.');
  if (!photo_b64) return err('Photo required.');

  const letter = ARTIFACTS[num];
  const isRare = RARE.has(num);
  const ts     = new Date().toISOString();
  const slug   = team.replace(/[^a-z0-9]/gi,'_').slice(0,30);
  const fname  = `photos/${ts.replace(/[:.]/g,'-')}_${slug}_${String(num).padStart(2,'0')}.jpg`;
  const pat    = env.GITHUB_PAT;

  // Upload photo
  const upRes = await githubRequest(pat, 'PUT', `/repos/${OWNER}/${REPO}/contents/${fname}`, {
    message: `photo: ${team} #${num}`,
    content: photo_b64,
    branch:  'main',
  });
  if (!upRes.ok) {
    const e = await upRes.json();
    return err(`Photo upload failed: ${e.message}`, 502);
  }
  const photoUrl = (await upRes.json()).content.html_url;

  // Create GitHub Issue
  const issueBody = [
    `## Hunt Submission`,
    `| | |`,
    `|---|---|`,
    `| **Team** | ${team} |`,
    `| **Artifact** | #${num} — ${letter}${isRare?' (Rare)':''} |`,
    `| **Timestamp** | ${ts} |`,
    `| **Photo** | [View](${photoUrl}) |`,
    ``,
    `*Submitted via GeoVision Hunt*`,
  ].join('\n');

  const issRes = await githubRequest(pat, 'POST', `/repos/${OWNER}/${REPO}/issues`, {
    title:  `[HUNT] #${String(num).padStart(2,'0')} ${letter} | ${team}`,
    body:   issueBody,
    labels: ['submission'],
  });
  if (!issRes.ok) {
    const e = await issRes.json();
    return err(`Submission failed: ${e.message}`, 502);
  }
  const issue = await issRes.json();
  return ok({ ok: true, issue_url: issue.html_url, team, artifact_id: num, letter });
}

// ── Router ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });

    const path = new URL(request.url).pathname;
    try {
      if (path === '/register' && request.method === 'POST') return handleRegister(request, env);
      if (path === '/login'    && request.method === 'POST') return handleLogin(request, env);
      if (path === '/verify'   && request.method === 'GET')  return handleVerify(request, env);
      if (path === '/submit'   && request.method === 'POST') return handleSubmit(request, env);
      return err('Not found.', 404);
    } catch(e) {
      return err(`Server error: ${e.message}`, 500);
    }
  }
};
