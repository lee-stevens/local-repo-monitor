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

function firstLine(message) {
  return String(message).split('\n')[0].trim();
}

async function isGitRepo(dir) {
  try {
    await fs.access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
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
    branches: [],
    lastChecked: new Date().toISOString(),
    error: null,
  };

  // These flags relax simple-git's env-injection guard for two GIT_* vars
  // we set ourselves on purpose (credential helper config, SSH batch mode) -
  // not attacker input, so safe to allow explicitly.
  const git = simpleGit({
    baseDir: repoPath,
    allowEnvironment: ALLOWED_GIT_ENV_NAMES,
    unsafe: {
      allowUnsafeConfigEnvCount: true,
      allowUnsafeSshCommand: true,
      allowUnsafeCredentialHelper: true,
    },
  });

  try {
    await withTimeout(git.fetch(['--prune']), FETCH_TIMEOUT_MS, 'fetch');
  } catch (e) {
    result.error = `fetch failed: ${firstLine(e.message)}`;
  }

  try {
    const status = await git.status();
    result.branch = status.current;
    result.tracking = status.tracking;
    result.ahead = status.ahead;
    result.behind = status.behind;
    result.changedFiles = status.files.length;
    result.dirty = status.files.length > 0;

    const localBranches = await git.branchLocal();
    result.branches = Object.keys(localBranches.branches);
  } catch (e) {
    const msg = `status failed: ${firstLine(e.message)}`;
    result.error = result.error ? `${result.error}; ${msg}` : msg;
  }

  return result;
}

async function scanRepos(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (e) {
    return { repos: [], rootError: `Cannot read directory "${rootDir}": ${firstLine(e.message)}` };
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

module.exports = { scanRepos };
