const rootDirInput = document.getElementById('root-dir');
const intervalInput = document.getElementById('interval');
const scanBtn = document.getElementById('scan-btn');
const lastScanEl = document.getElementById('last-scan');
const rootErrorEl = document.getElementById('root-error');
const rowsEl = document.getElementById('repo-rows');
const emptyStateEl = document.getElementById('empty-state');
const noticeEl = document.getElementById('notice');

const POLL_MS = 10000;
let inputsTouched = false;
let lastData = null;
const expandedRepos = new Set();

const STATUS_CODE_LABELS = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflict',
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadge(repo) {
  if (repo.error) return `<span class="badge badge-bad">error</span>`;
  if (repo.behind > 0) return `<span class="badge badge-bad">${repo.behind} behind</span>`;
  if (repo.dirty) return `<span class="badge badge-warn">uncommitted</span>`;
  return `<span class="badge badge-ok">up to date</span>`;
}

function aheadBehind(repo) {
  const parts = [];
  if (repo.ahead) parts.push(`+${repo.ahead}`);
  if (repo.behind) parts.push(`-${repo.behind}`);
  return parts.length ? parts.join(' / ') : '—';
}

function fileItems(items, codeOf) {
  return items
    .map((item) => {
      const path = escapeHtml(codeOf ? item.path : item);
      const code = codeOf ? `<span class="file-code">${escapeHtml(codeOf(item))}</span>` : '';
      return `<li>${code}<span class="file-path">${path}</span></li>`;
    })
    .join('');
}

function fileSection(title, items, codeOf) {
  if (!items.length) return '';
  return `
    <div class="file-section">
      <h4>${escapeHtml(title)} (${items.length})</h4>
      <ul class="file-list">${fileItems(items, codeOf)}</ul>
    </div>
  `;
}

function renderDetailsRow(repo) {
  const codeLabel = (f) => STATUS_CODE_LABELS[f.code] || f.code;
  const sections =
    [
      fileSection('Staged', repo.staged, codeLabel),
      fileSection('Unstaged', repo.unstaged, codeLabel),
      fileSection('Untracked', repo.untracked),
    ].join('') || '<p class="muted">Working tree clean.</p>';

  return `<tr class="details-row"><td colspan="7">${sections}</td></tr>`;
}

function renderRow(repo, expanded) {
  const checked = repo.lastChecked ? new Date(repo.lastChecked).toLocaleTimeString() : '—';
  // Branch names, tracking refs, and especially git error text can contain
  // characters supplied by a remote server - never trust them as HTML.
  const errorLine = repo.error
    ? `<span class="repo-error">${escapeHtml(repo.error)}</span>`
    : '';
  const branch = repo.branch ? escapeHtml(repo.branch) : '—';
  const tracking = repo.tracking
    ? ` <span class="muted">(${escapeHtml(repo.tracking)})</span>`
    : '';
  const mainRow = `
    <tr class="repo-row" data-path="${escapeHtml(repo.path)}">
      <td><span class="chevron">${expanded ? '▾' : '▸'}</span><span class="repo-name">${escapeHtml(repo.name)}</span>${errorLine}</td>
      <td>${branch}${tracking}</td>
      <td>${aheadBehind(repo)}</td>
      <td>${statusBadge(repo)}</td>
      <td>${escapeHtml(repo.branches.join(', '))}</td>
      <td>${checked}</td>
      <td class="actions">
        <button type="button" class="action-btn" data-action="pull" data-path="${escapeHtml(repo.path)}">Pull</button>
        <button type="button" class="action-btn" data-action="stash" data-path="${escapeHtml(repo.path)}">Stash</button>
      </td>
    </tr>
  `;
  return expanded ? mainRow + renderDetailsRow(repo) : mainRow;
}

// textContent, never innerHTML - the message can include verbatim git/
// remote-server error text.
function showNotice(message, ok) {
  noticeEl.textContent = message;
  noticeEl.className = ok ? 'notice-ok' : 'notice-bad';
  noticeEl.hidden = false;
}

function render(data) {
  lastData = data;

  if (!inputsTouched) {
    rootDirInput.value = data.rootDir || '';
    intervalInput.value = data.intervalMinutes || 5;
  }

  lastScanEl.textContent = data.scanning
    ? 'Scanning...'
    : data.lastScan
    ? `Last scanned ${new Date(data.lastScan).toLocaleString()}`
    : 'Not scanned yet';

  if (data.rootError) {
    rootErrorEl.textContent = data.rootError;
    rootErrorEl.hidden = false;
  } else {
    rootErrorEl.hidden = true;
  }

  if (!data.repos || data.repos.length === 0) {
    rowsEl.innerHTML = '';
    emptyStateEl.hidden = Boolean(data.rootError);
  } else {
    emptyStateEl.hidden = true;
    rowsEl.innerHTML = data.repos
      .map((repo) => renderRow(repo, expandedRepos.has(repo.path)))
      .join('');
  }
}

async function refresh() {
  const res = await fetch('/api/status');
  render(await res.json());
}

async function triggerScan() {
  scanBtn.disabled = true;
  scanBtn.textContent = 'Scanning...';
  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'local-repo-monitor',
      },
      body: JSON.stringify({
        rootDir: rootDirInput.value,
        intervalMinutes: Number(intervalInput.value),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      rootErrorEl.textContent = data.error || 'Scan request failed.';
      rootErrorEl.hidden = false;
      return;
    }
    inputsTouched = false;
    render(data);
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = 'Scan now';
  }
}

async function handleRepoAction(action, path, btn) {
  if (action === 'stash' && !confirm(`Stash all uncommitted changes (including untracked files) in:\n\n${path}`)) {
    return;
  }

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === 'pull' ? 'Pulling...' : 'Stashing...';

  try {
    const res = await fetch(`/api/repos/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'local-repo-monitor',
      },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!res.ok) {
      showNotice(data.error || `${action} failed.`, false);
      return;
    }
    showNotice(`${data.repo.name}: ${data.notice.message}`, data.notice.ok);
    await refresh();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

rowsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) {
    handleRepoAction(btn.dataset.action, btn.dataset.path, btn);
    return;
  }

  const row = e.target.closest('tr.repo-row');
  if (!row) return;
  const path = row.dataset.path;
  if (expandedRepos.has(path)) {
    expandedRepos.delete(path);
  } else {
    expandedRepos.add(path);
  }
  if (lastData) render(lastData);
});

rootDirInput.addEventListener('input', () => (inputsTouched = true));
intervalInput.addEventListener('input', () => (inputsTouched = true));
scanBtn.addEventListener('click', triggerScan);

refresh();
setInterval(refresh, POLL_MS);
