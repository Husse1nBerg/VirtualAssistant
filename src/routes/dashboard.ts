import { Router, Request, Response } from 'express';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import { getRecentCalls, getAllContacts, upsertContact, deleteContact, searchCalls, getCallAnalytics, type CallAnalytics } from '../services/database';
import type { CallLog, Transcript } from '@prisma/client';
import type { Contact } from '../services/database';

const router = Router();

type CallWithTranscripts = CallLog & { transcripts: Transcript[] };

// ── HTML helpers ─────────────────────────────────────

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDate(d: Date): string {
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function urgencyBadge(urgency: string | null): string {
  const u = urgency || 'low';
  const cls = u === 'high' ? 'badge-high' : u === 'medium' ? 'badge-medium' : 'badge-low';
  const emoji = u === 'high' ? '🔴' : u === 'medium' ? '🟡' : '🟢';
  return `<span class="badge ${cls}">${emoji} ${u.toUpperCase()}</span>`;
}

function sentimentBadge(sentiment: string | null): string {
  if (!sentiment || sentiment === 'neutral') return '';
  const map: Record<string, string> = {
    positive: 'badge-positive',
    frustrated: 'badge-frustrated',
    angry: 'badge-angry',
    distressed: 'badge-angry',
  };
  const cls = map[sentiment] || 'badge-low';
  const emoji = sentiment === 'positive' ? '😊' : sentiment === 'frustrated' ? '😤' : '😠';
  return ` <span class="badge ${cls}">${emoji} ${sentiment}</span>`;
}

function renderAnalytics(analytics: CallAnalytics): string {
  const avgDur = analytics.avgDurationSeconds !== null
    ? formatDuration(Math.round(analytics.avgDurationSeconds))
    : '—';

  const urgencyOrder = ['high', 'medium', 'low', 'unknown'];
  const urgencyMap = Object.fromEntries(analytics.urgencyDistribution.map((u) => [u.urgency, u.count]));
  const urgencyHtml = urgencyOrder
    .filter((u) => (urgencyMap[u] ?? 0) > 0)
    .map((u) => {
      const emoji = u === 'high' ? '🔴' : u === 'medium' ? '🟡' : u === 'low' ? '🟢' : '⚪';
      const pct = analytics.totalCalls > 0 ? Math.round(((urgencyMap[u] ?? 0) / analytics.totalCalls) * 100) : 0;
      return `<div class="stat-row"><span>${emoji} ${u.toUpperCase()}</span><span>${urgencyMap[u] ?? 0} (${pct}%)</span></div>`;
    })
    .join('');

  const topCallersHtml = analytics.topCallers.length === 0
    ? '<div class="stat-row"><span style="color:#aaa">None yet</span></div>'
    : analytics.topCallers.map((c) =>
        `<div class="stat-row"><span>${escapeHtml(c.callerName || c.fromNumber)}</span><span>${c.count} call${c.count !== 1 ? 's' : ''}</span></div>`
      ).join('');

  return `
    <h2>Analytics</h2>
    <div class="analytics-grid">
      <div class="stat-card">
        <div class="stat-value">${analytics.totalCalls}</div>
        <div class="stat-label">Total Calls</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${analytics.callsLast7Days}</div>
        <div class="stat-label">Last 7 Days</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${analytics.callsLast30Days}</div>
        <div class="stat-label">Last 30 Days</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${avgDur}</div>
        <div class="stat-label">Avg Duration</div>
      </div>
    </div>
    <div class="analytics-detail-grid">
      <div class="card">
        <h3>Urgency Distribution</h3>
        ${urgencyHtml || '<p style="color:#aaa;font-size:.82rem">No data yet</p>'}
      </div>
      <div class="card">
        <h3>Top Callers</h3>
        ${topCallersHtml}
      </div>
    </div>`;
}

function renderDashboard(calls: CallWithTranscripts[], contacts: Contact[], token: string, searchQuery = '', analytics?: CallAnalytics): string {
  const callRows = calls.map((call) => {
    const callerDisplay = call.callerName
      ? `${escapeHtml(call.callerName)}<br><span class="phone">${escapeHtml(call.fromNumber)}</span>`
      : escapeHtml(call.fromNumber);

    const summaryText = escapeHtml(call.summary || call.reasonForCall || '—');

    const recordingBtn = call.recordingUrl
      ? `<a href="/voice/recording/${call.id}" target="_blank" class="btn">▶ Recording</a>`
      : '';
    const callbackBtn = `<a href="tel:${escapeHtml(call.fromNumber)}" class="btn">📞 Call back</a>`;
    const lowConfidenceBadge = (call.confidenceScore !== null && call.confidenceScore < 0.5)
      ? `<span class="badge badge-review" title="Confidence ${Math.round((call.confidenceScore ?? 0) * 100)}% — summary may be incomplete">⚠ Review transcript</span>`
      : '';

    const transcriptLines = (call.transcripts || [])
      .map((t) => {
        const label = t.role === 'caller' ? 'Caller' : 'Agent';
        const cls = t.role === 'caller' ? 'caller' : 'assistant';
        return `<div class="${cls}"><b>${label}:</b> ${escapeHtml(t.content)}</div>`;
      })
      .join('');
    const transcriptSection = transcriptLines
      ? `<details><summary>View transcript</summary><div class="transcript">${transcriptLines}</div></details>`
      : '';

    const directionLabel = call.direction === 'sms'
      ? `<span class="badge badge-low" style="background:#e3f2fd;color:#1565c0">💬 SMS</span>`
      : `<span class="badge badge-low" style="background:#f3e5f5;color:#6a1b9a">📞 Call</span>`;

    return `<tr>
      <td>${callerDisplay}</td>
      <td class="nowrap">${escapeHtml(formatDate(call.startedAt))}</td>
      <td>${directionLabel}</td>
      <td class="summary-text">${summaryText}</td>
      <td>${urgencyBadge(call.urgency)}${sentimentBadge(call.sentiment)}</td>
      <td class="nowrap">${escapeHtml(formatDuration(call.durationSeconds))}</td>
      <td class="actions">${lowConfidenceBadge}${lowConfidenceBadge ? '<br>' : ''}${recordingBtn} ${callbackBtn}${transcriptSection}</td>
    </tr>`;
  }).join('\n');

  const LANG_LABELS: Record<string, string> = { en: '🇬🇧 English', fr: '🇫🇷 French' };
  const contactRows = contacts.map((c) => `<tr>
    <td>${escapeHtml(c.name)}</td>
    <td class="phone">${escapeHtml(c.phoneNumber)}</td>
    <td>${c.isVip ? '<span class="badge badge-high">⭐ VIP</span>' : 'Regular'}</td>
    <td>${LANG_LABELS[c.language ?? 'en'] ?? escapeHtml(c.language ?? 'en')}</td>
    <td>${escapeHtml(c.notes || '')}</td>
    <td class="actions">
      <button class="btn edit-btn"
        data-id="${escapeHtml(c.id)}"
        data-phone="${escapeHtml(c.phoneNumber)}"
        data-name="${escapeHtml(c.name)}"
        data-vip="${c.isVip}"
        data-language="${escapeHtml(c.language ?? 'en')}"
        data-notes="${escapeHtml(c.notes || '')}">Edit</button>
      <button class="btn btn-danger delete-btn" data-id="${escapeHtml(c.id)}">Delete</button>
    </td>
  </tr>`).join('\n');

  const noCallsMsg = '<p class="empty">No calls recorded yet.</p>';
  const noContactsMsg = '<p class="empty">No contacts saved yet.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Call Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#222;padding:24px}
    .container{max-width:1280px;margin:0 auto}
    h1{font-size:1.5rem;margin-bottom:24px;color:#111}
    h2{font-size:1.1rem;font-weight:600;margin:28px 0 10px;color:#333}
    h3{font-size:0.95rem;font-weight:600;margin:0 0 14px;color:#444}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:8px}
    th{background:#2c3e50;color:#fff;padding:10px 14px;text-align:left;font-size:.8rem;font-weight:600;white-space:nowrap}
    td{padding:10px 14px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:.85rem}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#fafafa}
    .phone{font-size:.75rem;color:#777}
    .summary-text{max-width:300px;line-height:1.45}
    .nowrap{white-space:nowrap}
    .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:.72rem;font-weight:700;white-space:nowrap}
    .badge-high{background:#fde8e8;color:#c0392b}
    .badge-medium{background:#fef9e7;color:#7d6608}
    .badge-low{background:#eafaf1;color:#1e8449}
    .badge-positive{background:#e8f5e9;color:#1b5e20}
    .badge-frustrated{background:#fff3e0;color:#bf360c}
    .badge-angry{background:#fce4ec;color:#880e4f}
    .badge-review{background:#fff8e1;color:#e65100;cursor:help}
    .btn{display:inline-block;padding:4px 10px;background:#555;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:.78rem;text-decoration:none;margin:2px 1px;vertical-align:middle}
    .btn:hover{background:#333}
    .btn-danger{background:#c0392b}.btn-danger:hover{background:#922b21}
    .btn-primary{background:#2980b9}.btn-primary:hover{background:#1f6692}
    .actions{white-space:nowrap}
    details{margin-top:6px}
    details summary{cursor:pointer;font-size:.78rem;color:#666;user-select:none}
    .transcript{padding:8px;background:#f8f8f8;border-radius:4px;margin-top:6px;font-size:.78rem;line-height:1.5;max-height:200px;overflow-y:auto}
    .transcript .caller{color:#2c3e50}
    .transcript .assistant{color:#7d3c98}
    .empty{padding:20px;text-align:center;color:#aaa;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .card{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .form-group{display:flex;flex-direction:column;gap:5px}
    .form-group.checkbox{flex-direction:row;align-items:center;gap:8px;padding-top:20px}
    label{font-size:.82rem;font-weight:500;color:#444}
    input[type=text],input[type=tel]{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:5px;font-size:.87rem}
    input:focus{outline:none;border-color:#2980b9}
    .form-actions{margin-top:14px;display:flex;gap:8px;align-items:center}
    #form-msg{font-size:.82rem;margin-top:8px}
    .analytics-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:16px}
    .stat-card{background:#fff;border-radius:8px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:center}
    .stat-value{font-size:1.8rem;font-weight:700;color:#2c3e50}
    .stat-label{font-size:.75rem;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:.05em}
    .analytics-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
    .stat-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f5f5f5;font-size:.84rem}
    .stat-row:last-child{border-bottom:none}
    @media(max-width:640px){.analytics-detail-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="container">
    <h1>📞 Call Dashboard</h1>

    ${analytics ? renderAnalytics(analytics) : ''}

    <form method="GET" action="/dashboard/${escapeHtml(token)}" style="margin-bottom:16px;display:flex;gap:8px">
      <input type="text" name="q" value="${escapeHtml(searchQuery)}" placeholder="Search by name, company, keyword…" style="flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:5px;font-size:.87rem">
      <button type="submit" class="btn btn-primary" style="padding:8px 16px">Search</button>
      ${searchQuery ? `<a href="/dashboard/${escapeHtml(token)}" class="btn">Clear</a>` : ''}
    </form>

    <h2>${searchQuery ? `Search results for "${escapeHtml(searchQuery)}" (${calls.length})` : `Recent Calls (${calls.length})`}</h2>
    ${calls.length === 0 ? noCallsMsg : `<table>
      <thead><tr>
        <th>Caller</th><th>Date</th><th>Via</th><th>Summary</th><th>Urgency</th><th>Duration</th><th>Actions</th>
      </tr></thead>
      <tbody>${callRows}</tbody>
    </table>`}

    <h2>Contacts (${contacts.length})</h2>
    ${contacts.length === 0 ? noContactsMsg : `<table>
      <thead><tr>
        <th>Name</th><th>Phone</th><th>Type</th><th>Language</th><th>Notes</th><th>Actions</th>
      </tr></thead>
      <tbody>${contactRows}</tbody>
    </table>`}

    <div class="card" style="margin-top:16px">
      <h3 id="form-title">Add Contact</h3>
      <form id="contact-form">
        <input type="hidden" id="c-id">
        <div class="form-grid">
          <div class="form-group">
            <label for="c-name">Name *</label>
            <input type="text" id="c-name" required placeholder="Sarah Smith">
          </div>
          <div class="form-group">
            <label for="c-phone">Phone Number *</label>
            <input type="tel" id="c-phone" required placeholder="+15141234567">
          </div>
          <div class="form-group">
            <label for="c-language">Language</label>
            <select id="c-language">
              <option value="en">🇬🇧 English</option>
              <option value="fr">🇫🇷 French</option>
            </select>
          </div>
          <div class="form-group">
            <label for="c-notes">Notes</label>
            <input type="text" id="c-notes" placeholder="e.g. dad, best client">
          </div>
          <div class="form-group checkbox">
            <input type="checkbox" id="c-vip">
            <label for="c-vip">VIP contact (warm, first-name basis)</label>
          </div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save Contact</button>
          <button type="button" id="cancel-btn" class="btn" style="display:none">Cancel</button>
        </div>
      </form>
      <div id="form-msg"></div>
    </div>
  </div>

  <script>
    const TOKEN = '${escapeHtml(token)}';

    document.addEventListener('click', function(e) {
      const editBtn = e.target.closest('.edit-btn');
      if (editBtn) {
        const d = editBtn.dataset;
        document.getElementById('c-id').value = d.id || '';
        document.getElementById('c-phone').value = d.phone || '';
        document.getElementById('c-name').value = d.name || '';
        document.getElementById('c-vip').checked = d.vip === 'true';
        document.getElementById('c-language').value = d.language || 'en';
        document.getElementById('c-notes').value = d.notes || '';
        document.getElementById('form-title').textContent = 'Edit Contact';
        document.getElementById('cancel-btn').style.display = '';
        document.getElementById('contact-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      const deleteBtn = e.target.closest('.delete-btn');
      if (deleteBtn) {
        if (!confirm('Delete this contact?')) return;
        fetch('/dashboard/' + TOKEN + '/contacts/' + deleteBtn.dataset.id, { method: 'DELETE' })
          .then(r => r.ok ? deleteBtn.closest('tr').remove() : alert('Failed to delete.'))
          .catch(() => alert('Network error.'));
      }
    });

    document.getElementById('cancel-btn').addEventListener('click', function() {
      document.getElementById('contact-form').reset();
      document.getElementById('c-id').value = '';
      document.getElementById('form-title').textContent = 'Add Contact';
      this.style.display = 'none';
      document.getElementById('form-msg').textContent = '';
    });

    document.getElementById('contact-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const msg = document.getElementById('form-msg');
      msg.textContent = '';
      const payload = {
        name: document.getElementById('c-name').value.trim(),
        phoneNumber: document.getElementById('c-phone').value.trim(),
        isVip: document.getElementById('c-vip').checked,
        language: document.getElementById('c-language').value || 'en',
        notes: document.getElementById('c-notes').value.trim() || undefined,
      };
      try {
        const r = await fetch('/dashboard/' + TOKEN + '/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (r.ok) {
          msg.style.color = 'green';
          msg.textContent = 'Contact saved!';
          setTimeout(() => location.reload(), 600);
        } else {
          const err = await r.json().catch(() => ({}));
          msg.style.color = 'red';
          msg.textContent = err.error || 'Failed to save contact.';
        }
      } catch {
        msg.style.color = 'red';
        msg.textContent = 'Network error.';
      }
    });
  </script>
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────

router.get('/:token', async (req: Request, res: Response) => {
  const env = getEnv();
  if (!env.DASHBOARD_TOKEN || req.params.token !== env.DASHBOARD_TOKEN) {
    return res.status(404).send('Not found');
  }
  try {
    const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const [calls, contacts, analytics] = await Promise.all([
      searchQuery ? searchCalls(searchQuery, 50) : getRecentCalls(50),
      getAllContacts(),
      getCallAnalytics(),
    ]);
    return res.send(renderDashboard(calls as CallWithTranscripts[], contacts, env.DASHBOARD_TOKEN, searchQuery, analytics));
  } catch (err) {
    getLogger().error({ err }, 'Dashboard render failed');
    return res.status(500).send('Internal error');
  }
});

router.post('/:token/contacts', async (req: Request, res: Response) => {
  const env = getEnv();
  if (!env.DASHBOARD_TOKEN || req.params.token !== env.DASHBOARD_TOKEN) {
    return res.status(404).send('Not found');
  }
  const { phoneNumber, name, isVip, notes, language } = req.body as Record<string, unknown>;
  if (!phoneNumber || !name) {
    return res.status(400).json({ error: 'phoneNumber and name are required' });
  }
  try {
    const contact = await upsertContact({
      phoneNumber: String(phoneNumber),
      name: String(name),
      isVip: isVip === true || isVip === 'true',
      notes: notes ? String(notes) : undefined,
      language: language ? String(language) : 'en',
    });
    return res.json(contact);
  } catch (err) {
    getLogger().error({ err }, 'Failed to upsert contact');
    return res.status(500).json({ error: 'Failed to save contact' });
  }
});

router.delete('/:token/contacts/:id', async (req: Request, res: Response) => {
  const env = getEnv();
  if (!env.DASHBOARD_TOKEN || req.params.token !== env.DASHBOARD_TOKEN) {
    return res.status(404).send('Not found');
  }
  try {
    await deleteContact(req.params.id as string);
    return res.json({ success: true });
  } catch (err) {
    getLogger().error({ err }, 'Failed to delete contact');
    return res.status(500).json({ error: 'Failed to delete contact' });
  }
});

export default router;
