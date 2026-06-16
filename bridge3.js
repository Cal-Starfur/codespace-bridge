#!/usr/bin/env node
/**
 * bridge3.js — Repo-file relay bridge for Claude
 *
 * Uses a GitHub repo as the relay instead of Gists.
 * Claude writes a command to repo file → bridge polls → runs it → writes result back.
 * No tunnels, no gist scope needed — just repo write access.
 *
 * SETUP:
 *   export BRIDGE_TOKEN=your_github_pat
 *   node ~/bridge3.js
 */

const https = require('https');
const { exec } = require('child_process');
const crypto = require('crypto');

const GH_TOKEN = process.env.BRIDGE_TOKEN;
if (!GH_TOKEN) {
  console.error('ERROR: Set BRIDGE_TOKEN first:');
  console.error('  export BRIDGE_TOKEN=your_github_pat && node ~/bridge3.js');
  process.exit(1);
}

const OWNER      = 'Cal-Starfur';
const REPO       = 'codespace-bridge';
const INBOX_PATH = 'relay/inbox.json';
const OUTBOX_PATH= 'relay/outbox.json';
const POLL_MS    = 3000;
const TIMEOUT_MS = 60_000;
const MAX_BYTES  = 64 * 1024;
const SESSION_ID = crypto.randomBytes(6).toString('hex');

const BLOCKED = [
  /rm\s+-rf\s+[/~]/,
  /dd\s+if=/,
  /mkfs/,
  /curl.*\|\s*sh/,
  /wget.*\|\s*sh/,
  />\s*\/etc\//,
];

// ── GitHub API ────────────────────────────────────────────────────────────────

function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'codespace-bridge/3.0',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode}: ${data.slice(0,200)}`));
        else resolve(JSON.parse(data));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Repo file helpers ─────────────────────────────────────────────────────────

async function readRepoFile(path) {
  const data = await ghRequest('GET', `/repos/${OWNER}/${REPO}/contents/${path}`);
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { content: JSON.parse(content), sha: data.sha };
}

async function writeRepoFile(path, content, sha, message) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const payload = { message, content: encoded };
  if (sha) payload.sha = sha;
  await ghRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${path}`, payload);
}

// ── Command runner ────────────────────────────────────────────────────────────

function runCommand(cmd, cwd) {
  return new Promise((resolve) => {
    const start = Date.now();
    exec(cmd, {
      cwd: cwd || process.env.HOME || '/root',
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BYTES,
      env: { ...process.env, FORCE_COLOR: '0' },
    }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? (err.code ?? 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        durationMs: Date.now() - start,
        timedOut: err?.killed ?? false,
      });
    });
  });
}

// ── Init relay files if missing ───────────────────────────────────────────────

async function ensureRelayFiles() {
  for (const [path, content] of [
    [INBOX_PATH,  { cmd: null, id: null }],
    [OUTBOX_PATH, { ready: false, id: null }],
  ]) {
    try {
      await readRepoFile(path);
    } catch (e) {
      if (e.message.startsWith('404')) {
        await writeRepoFile(path, content, null, `bridge3: init ${path}`);
        console.log(`  ✓ created ${path}`);
      } else {
        throw e;
      }
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║        Codespace Bridge v3 — Repo Relay Mode        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Initialising relay files in repo...');

  await ensureRelayFiles();

  console.log(`  ✓ Session: ${SESSION_ID}`);
  console.log(`  ✓ Relay:   ${OWNER}/${REPO}/relay/`);
  console.log('');
  console.log('  Bridge is live — tell Claude:');
  console.log(`    REPO: ${OWNER}/${REPO}`);
  console.log('');
  console.log(`  Polling every ${POLL_MS/1000}s... (Ctrl+C to stop)\n`);

  let lastId = null;

  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));

    let inbox, inboxSha;
    try {
      ({ content: inbox, sha: inboxSha } = await readRepoFile(INBOX_PATH));
    } catch (e) {
      console.error(`  poll error: ${e.message}`);
      continue;
    }

    if (!inbox.cmd || inbox.id === lastId) continue;

    lastId = inbox.id;
    const cmd = inbox.cmd.trim();
    const cwd = inbox.cwd || `/workspaces/Wigglers_Room`;

    console.log(`  → [${inbox.id}] ${cmd}`);

    if (BLOCKED.some(p => p.test(cmd))) {
      console.log('  ✗ BLOCKED');
      const { sha: outSha } = await readRepoFile(OUTBOX_PATH);
      await writeRepoFile(OUTBOX_PATH, {
        id: inbox.id, ready: true,
        error: 'Blocked by safety rules.',
        exitCode: -1, stdout: '', stderr: '',
      }, outSha, `bridge3: blocked [${inbox.id}]`);
      await writeRepoFile(INBOX_PATH, { cmd: null, id: null }, inboxSha, `bridge3: clear inbox`);
      continue;
    }

    // Mark running — always fetch fresh SHA immediately before writing
    const { sha: outSha1 } = await readRepoFile(OUTBOX_PATH);
    await writeRepoFile(OUTBOX_PATH, { id: inbox.id, ready: false, running: true },
      outSha1, `bridge3: running [${inbox.id}]`);

    const result = await runCommand(cmd, cwd);
    console.log(`  ✓ exit ${result.exitCode} (${result.durationMs}ms)`);

    // Always fetch fresh SHAs right before each write to avoid 409 conflicts
    const { sha: outSha2 } = await readRepoFile(OUTBOX_PATH);
    await writeRepoFile(OUTBOX_PATH, { id: inbox.id, ready: true, ...result },
      outSha2, `bridge3: result [${inbox.id}]`);

    const { sha: freshInboxSha } = await readRepoFile(INBOX_PATH);
    await writeRepoFile(INBOX_PATH, { cmd: null, id: null },
      freshInboxSha, `bridge3: clear inbox [${inbox.id}]`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
