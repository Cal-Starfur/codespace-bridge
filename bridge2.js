#!/usr/bin/env node
/**
 * bridge2.js — Gist-based relay bridge for Claude
 *
 * Claude writes a command to a GitHub Gist (inbox).
 * This bridge polls the Gist, runs the command, writes output back (outbox).
 * No tunnels needed — everything goes through api.github.com.
 *
 * SETUP:
 *   export BRIDGE_TOKEN=your_github_pat
 *   node ~/bridge2.js
 */

const https = require('https');
const { exec } = require('child_process');
const crypto = require('crypto');

const GH_TOKEN = process.env.BRIDGE_TOKEN;
if (!GH_TOKEN) {
  console.error('ERROR: Set BRIDGE_TOKEN env var first:');
  console.error('  export BRIDGE_TOKEN=your_github_pat');
  console.error('  node ~/bridge2.js');
  process.exit(1);
}

const POLL_MS = 2000;
const TIMEOUT_MS = 60_000;
const MAX_BYTES = 64 * 1024;
const SESSION_ID = crypto.randomBytes(8).toString('hex');

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
        'User-Agent': 'codespace-bridge/2.0',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`GitHub API ${res.statusCode}: ${data.slice(0, 200)}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Gist helpers ──────────────────────────────────────────────────────────────

async function createGists() {
  const result = await ghRequest('POST', '/gists', {
    description: `codespace-bridge session ${SESSION_ID}`,
    public: false,
    files: {
      'inbox.json': { content: JSON.stringify({ cmd: null, id: null }) },
      'outbox.json': { content: JSON.stringify({ result: null, id: null, ready: false }) },
    },
  });
  return result.id;
}

async function readGist(gistId) {
  const result = await ghRequest('GET', `/gists/${gistId}`);
  return {
    inbox: JSON.parse(result.files['inbox.json'].content),
    outbox: JSON.parse(result.files['outbox.json'].content),
  };
}

async function writeOutbox(gistId, data) {
  await ghRequest('PATCH', `/gists/${gistId}`, {
    files: {
      'outbox.json': { content: JSON.stringify(data, null, 2) },
    },
  });
}

async function clearInbox(gistId) {
  await ghRequest('PATCH', `/gists/${gistId}`, {
    files: {
      'inbox.json': { content: JSON.stringify({ cmd: null, id: null }) },
    },
  });
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

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║        Codespace Bridge v2 — Gist Relay Mode        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Creating relay Gist...');

  let gistId;
  try {
    gistId = await createGists();
  } catch (e) {
    console.error('  ✗ Failed to create Gist:', e.message);
    process.exit(1);
  }

  console.log(`  ✓ Gist ID:   ${gistId}`);
  console.log(`  ✓ Session:   ${SESSION_ID}`);
  console.log('');
  console.log('  ┌─ Give Claude these two values ──────────────────────┐');
  console.log(`  │  GIST_ID:  ${gistId}  │`);
  console.log(`  │  GH_TOKEN: (the same token you used for BRIDGE_TOKEN) │`);
  console.log('  └──────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  Polling every ${POLL_MS}ms for commands...`);
  console.log('  (Ctrl+C to stop)\n');

  let lastId = null;

  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));

    let state;
    try {
      state = await readGist(gistId);
    } catch (e) {
      console.error(`  poll error: ${e.message}`);
      continue;
    }

    const { inbox } = state;
    if (!inbox.cmd || inbox.id === lastId) continue;

    lastId = inbox.id;
    const cmd = inbox.cmd.trim();

    console.log(`  → CMD [${inbox.id}]: ${cmd}`);

    if (BLOCKED.some(p => p.test(cmd))) {
      console.log(`  ✗ BLOCKED`);
      await writeOutbox(gistId, {
        id: inbox.id,
        ready: true,
        error: 'Command blocked by safety rules.',
        exitCode: -1,
        stdout: '',
        stderr: '',
      });
      await clearInbox(gistId);
      continue;
    }

    // Write "running" status
    await writeOutbox(gistId, { id: inbox.id, ready: false, running: true });

    const result = await runCommand(cmd, inbox.cwd);
    console.log(`  ✓ EXIT ${result.exitCode} (${result.durationMs}ms)`);
    if (result.stdout) console.log('  stdout:', result.stdout.slice(0, 120));
    if (result.stderr) console.log('  stderr:', result.stderr.slice(0, 120));

    await writeOutbox(gistId, { id: inbox.id, ready: true, ...result });
    await clearInbox(gistId);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
