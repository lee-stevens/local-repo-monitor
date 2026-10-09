const fs = require('fs');
const path = require('path');
const express = require('express');
const { scanRepos, getRepoStatus, pullRepo, stashRepo } = require('./lib/scanner');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PORT = process.env.PORT || 3000;
// The scan root can be changed from the UI, but only to somewhere under this
// base - otherwise an unauthenticated caller could point the scanner (and
// its git credentials) at arbitrary paths inside the container.
const ALLOWED_BASE_DIR = path.resolve(process.env.ROOT_DIR || '/repos');

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      rootDir: saved.rootDir || process.env.ROOT_DIR || '/repos',
      intervalMinutes: saved.intervalMinutes || Number(process.env.SCAN_INTERVAL_MINUTES) || 5,
    };
  } catch {
    return {
      rootDir: process.env.ROOT_DIR || '/repos',
      intervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES) || 5,
    };
  }
}

function saveConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ rootDir: config.rootDir, intervalMinutes: config.intervalMinutes }, null, 2)
  );
}

const config = loadConfig();

const state = {
  rootDir: config.rootDir,
  intervalMinutes: config.intervalMinutes,
  repos: [],
  rootError: null,
  scanning: false,
  lastScan: null,
  notice: null,
};

// Pull/stash only ever act on a path the server itself already discovered
// via scanning - never on arbitrary input from the request. This also
// means a deleted/renamed repo just fails normally rather than opening up
// an arbitrary-path primitive.
function findKnownRepo(repoPath) {
  return state.repos.find((r) => r.path === repoPath);
}

async function refreshOneRepo(repoPath) {
  const updated = await getRepoStatus(repoPath);
  const idx = state.repos.findIndex((r) => r.path === repoPath);
  if (idx !== -1) state.repos[idx] = updated;
  return updated;
}

let timer = null;

async function runScan() {
  state.scanning = true;
  try {
    const { repos, rootError } = await scanRepos(state.rootDir);
    state.repos = repos;
    state.rootError = rootError;
  } catch (e) {
    state.rootError = e.message;
  }
  state.lastScan = new Date().toISOString();
  state.scanning = false;
}

function restartTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(runScan, state.intervalMinutes * 60 * 1000);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight CSRF guard: a cross-site <form> POST can't set a custom
// header, and a cross-origin fetch()/XHR that tries to would be blocked by
// the browser's CORS preflight (this server sends no CORS headers). This
// doesn't require a secret - it just rules out both common CSRF vectors.
function requireSameOrigin(req, res, next) {
  if (req.get('X-Requested-With') !== 'local-repo-monitor') {
    return res.status(403).json({ error: 'Missing or invalid X-Requested-With header' });
  }
  next();
}

app.get('/api/status', (req, res) => {
  res.json(state);
});

app.post('/api/scan', requireSameOrigin, async (req, res) => {
  const { rootDir, intervalMinutes } = req.body || {};
  if (typeof rootDir === 'string' && rootDir.trim()) {
    const resolved = path.resolve(rootDir.trim());
    const withinAllowedBase =
      resolved === ALLOWED_BASE_DIR || resolved.startsWith(ALLOWED_BASE_DIR + path.sep);
    if (!withinAllowedBase) {
      return res.status(400).json({
        error: `rootDir must be "${ALLOWED_BASE_DIR}" or a subfolder of it`,
      });
    }
    state.rootDir = resolved;
  }
  if (Number(intervalMinutes) > 0) {
    state.intervalMinutes = Number(intervalMinutes);
    restartTimer();
  }
  saveConfig(state);
  await runScan();
  res.json(state);
});

app.post('/api/repos/pull', requireSameOrigin, async (req, res) => {
  const { path: repoPath } = req.body || {};
  const known = findKnownRepo(repoPath);
  if (!known) return res.status(404).json({ error: 'Unknown repo path' });

  const result = await pullRepo(known.path);
  const updated = await refreshOneRepo(known.path);
  state.notice = {
    repoName: updated.name,
    action: 'pull',
    ok: !result.error,
    message: result.error || 'Pulled latest changes.',
    at: new Date().toISOString(),
  };
  res.json({ repo: updated, notice: state.notice });
});

app.post('/api/repos/stash', requireSameOrigin, async (req, res) => {
  const { path: repoPath } = req.body || {};
  const known = findKnownRepo(repoPath);
  if (!known) return res.status(404).json({ error: 'Unknown repo path' });

  const result = await stashRepo(known.path);
  const updated = await refreshOneRepo(known.path);
  state.notice = {
    repoName: updated.name,
    action: 'stash',
    ok: !result.error,
    message: result.error || (result.stashed ? `Stashed as "${result.message}"` : 'No local changes to stash.'),
    at: new Date().toISOString(),
  };
  res.json({ repo: updated, notice: state.notice });
});

app.listen(PORT, () => {
  console.log(`local-repo-monitor listening on port ${PORT}`);
  restartTimer();
  runScan();
});
