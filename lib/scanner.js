const fs = require('fs/promises');
const path = require('path');
const { simpleGit } = require('simple-git');

// Never let git stop to prompt for credentials - fail fast instead of hanging.
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_SSH_COMMAND =
  process.env.GIT_SSH_COMMAND ||
  'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new';

// simple-git strips ambient GIT_* env vars from spawned git processes by
// default (an env-injection guard). Explicitly allow-listing the names we
// set ourselves (GIT_TERMINAL_PROMPT, GIT_SSH_COMMAND, and any GIT_CONFIG_*
// credential helper config from docker-compose) lets them through unchanged.
const ALLOWED_GIT_ENV_NAMES = Object.keys(process.env).filter((key) => key.startsWith('GIT_'));

const FETCH_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// git often prints an informational line (e.g. "Updating a..b") before the
// actual error, so a plain "first line" can hide the real reason. Prefer
// the first line that looks like an actual error/fatal/remote message.
function meaningfulErrorLine(message) {
  const lines = String(message)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const notable = lines.find((l) => /^(error|fatal|remote):/i.test(l));
  return notable || lines[0] || String(message).trim();
}

async function isGitRepo(dir) {
  try {
    await fs.access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

// These flags relax simple-git's env-injection guard for GIT_* vars we set
// ourselves on purpose (credential helper config, SSH batch mode) - not
// attacker input, so safe to allow explicitly.
function createGit(repoPath) {
  return simpleGit({
    baseDir: repoPath,
    allowEnvironment: ALLOWED_GIT_ENV_NAMES,
    unsafe: {
      allowUnsafeConfigEnvCount: true,
      allowUnsafeSshCommand: true,
      allowUnsafeCredentialHelper: true,
    },
  });
}

// simple-git's status().files gives each changed path an `index` code
// (staged/index state) and a `working_dir` code (unstaged/worktree state) -
// ' ' means no change in that half. A path untracked in both shows '?' in
// both and is reported separately rather than as "staged".
function splitFilesByStage(files) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const f of files) {
    if (f.index === '?' && f.working_dir === '?') {
      untracked.push(f.path);
    } else {
      if (f.index !== ' ' && f.index !== '?') staged.push({ path: f.path, code: f.index });
      if (f.working_dir !== ' ' && f.working_dir !== '?')
        unstaged.push({ path: f.path, code: f.working_dir });
    }
  }
  return { staged, unstaged, untracked };
}

async function getRepoStatus(repoPath) {
  const result = {
    name: path.basename(repoPath),
    path: repoPath,
    branch: null,
    tracking: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    branches: [],
    lastChecked: new Date().toISOString(),
    error: null,
  };

  const git = createGit(repoPath);

  try {
    await withTimeout(git.fetch(['--prune']), FETCH_TIMEOUT_MS, 'fetch');
  } catch (e) {
    result.error = `fetch failed: ${meaningfulErrorLine(e.message)}`;
  }

  try {
    const status = await git.status();
    result.branch = status.current;
    result.tracking = status.tracking;
    result.ahead = status.ahead;
    result.behind = status.behind;
    result.changedFiles = status.files.length;
    result.dirty = status.files.length > 0;

    const { staged, unstaged, untracked } = splitFilesByStage(status.files);
    result.staged = staged;
    result.unstaged = unstaged;
    result.untracked = untracked;

    const localBranches = await git.branchLocal();
    result.branches = Object.keys(localBranches.branches);
  } catch (e) {
    const msg = `status failed: ${meaningfulErrorLine(e.message)}`;
    result.error = result.error ? `${result.error}; ${msg}` : msg;
  }

  return result;
}

// Fast-forward only: never creates a merge commit or rewrites history
// unexpectedly. If the branch has diverged, this fails with a clear error
// instead of silently doing something the user didn't ask for.
async function pullRepo(repoPath) {
  const git = createGit(repoPath);
  try {
    await withTimeout(git.raw(['pull', '--ff-only']), FETCH_TIMEOUT_MS, 'pull');
    return { error: null };
  } catch (e) {
    return { error: `pull failed: ${meaningfulErrorLine(e.message)}` };
  }
}

// Stashes tracked and untracked changes under a message that includes the
// current timestamp, so it's identifiable later with `git stash list`.
async function stashRepo(repoPath) {
  const git = createGit(repoPath);
  const message = `local-repo-monitor ${new Date().toISOString()}`;
  try {
    const output = await withTimeout(
      git.raw(['stash', 'push', '--include-untracked', '-m', message]),
      FETCH_TIMEOUT_MS,
      'stash'
    );
    const stashed = !/no local changes to save/i.test(output || '');
    return { error: null, message, stashed };
  } catch (e) {
    return { error: `stash failed: ${meaningfulErrorLine(e.message)}`, message, stashed: false };
  }
}

async function scanRepos(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (e) {
    return { repos: [], rootError: `Cannot read directory "${rootDir}": ${meaningfulErrorLine(e.message)}` };
  }

  const subDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(rootDir, e.name));

  const candidates = [];
  for (const dir of subDirs) {
    if (await isGitRepo(dir)) candidates.push(dir);
  }
  // Fall back to treating rootDir itself as the repo if no sub-repos were found.
  if (candidates.length === 0 && (await isGitRepo(rootDir))) {
    candidates.push(rootDir);
  }

  const repos = [];
  for (const repoPath of candidates) {
    repos.push(await getRepoStatus(repoPath));
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));

  return { repos, rootError: null };
}

module.exports = { scanRepos, getRepoStatus, pullRepo, stashRepo };
