const rootDirInput = document.getElementById('root-dir');
const intervalInput = document.getElementById('interval');
const scanBtn = document.getElementById('scan-btn');
const lastScanEl = document.getElementById('last-scan');
const rootErrorEl = document.getElementById('root-error');
const rowsEl = document.getElementById('repo-rows');
const emptyStateEl = document.getElementById('empty-state');

const POLL_MS = 10000;
let inputsTouched = false;

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

function renderRow(repo) {
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
  return `
    <tr>
      <td><span class="repo-name">${escapeHtml(repo.name)}</span>${errorLine}</td>
      <td>${branch}${tracking}</td>
      <td>${aheadBehind(repo)}</td>
      <td>${statusBadge(repo)}</td>
      <td>${escapeHtml(repo.branches.join(', '))}</td>
      <td>${checked}</td>
    </tr>
  `;
}

function render(data) {
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
    rowsEl.innerHTML = data.repos.map(renderRow).join('');
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

rootDirInput.addEventListener('input', () => (inputsTouched = true));
intervalInput.addEventListener('input', () => (inputsTouched = true));
scanBtn.addEventListener('click', triggerScan);

refresh();
setInterval(refresh, POLL_MS);
