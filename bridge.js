#!/usr/bin/env node
/**
 * bridge.js — Codespace Bridge for Claude
 * 
 * Lets Claude send terminal commands into this Codespace via HTTP.
 * 
 * SETUP (run once in your Codespace terminal):
 *   node ~/bridge.js
 * 
 * Then paste the forwarded URL into Claude (looks like):
 *   https://xxxx-3000.app.github.dev
 * 
 * SECURITY: Token is printed on startup. Claude must send it in every request.
 * Never share the token or the forwarded URL publicly.
 */

const http = require('http');
const { exec } = require('child_process');
const crypto = require('crypto');
const os = require('os');

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = 3000;
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB cap on output
const TIMEOUT_MS = 60_000;          // 60s max per command

// Commands Claude is never allowed to run, no matter what
const BLOCKED = [
  /rm\s+-rf\s+[/~]/,         // nuke filesystem
  /dd\s+if=/,                // disk write
  /mkfs/,                    // format disk
  /curl.*\|\s*sh/,           // curl-pipe-shell
  /wget.*\|\s*sh/,
  /chmod\s+777\s+\//,
  />\s*\/etc\//,             // overwrite system files
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function isBlocked(cmd) {
  return BLOCKED.some(pattern => pattern.test(cmd));
}

function runCommand(cmd, cwd) {
  return new Promise((resolve) => {
    const startMs = Date.now();
    const child = exec(
      cmd,
      {
        cwd: cwd || process.env.HOME || '/root',
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, FORCE_COLOR: '0' },
      },
      (err, stdout, stderr) => {
        resolve({
          exitCode: err ? (err.code ?? 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          durationMs: Date.now() - startMs,
          timedOut: err?.killed ?? false,
        });
      }
    );
  });
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res) {
  jsonResponse(res, 401, { error: 'Unauthorized — wrong or missing token.' });
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  // CORS for local testing
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Health check (no token required — just confirms the server is alive)
  if (req.method === 'GET' && req.url === '/ping') {
    return jsonResponse(res, 200, { ok: true, hostname: os.hostname() });
  }

  // Everything else needs the token
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${TOKEN}`) {
    return unauthorized(res);
  }

  // ── POST /run ───────────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return jsonResponse(res, 400, { error: 'Invalid JSON body.' });
      }

      const cmd = (parsed.cmd || '').trim();
      const cwd = parsed.cwd || undefined;

      if (!cmd) {
        return jsonResponse(res, 400, { error: '`cmd` field is required.' });
      }

      if (isBlocked(cmd)) {
        console.warn(`[bridge] BLOCKED command: ${cmd}`);
        return jsonResponse(res, 403, { error: 'Command is blocked by safety rules.' });
      }

      console.log(`[bridge] RUN: ${cmd}`);
      const result = await runCommand(cmd, cwd);
      console.log(`[bridge] EXIT: ${result.exitCode} (${result.durationMs}ms)`);

      return jsonResponse(res, 200, result);
    });
    return;
  }

  // ── GET /env ────────────────────────────────────────────────────────────────
  // Returns safe env info so Claude knows where it is
  if (req.method === 'GET' && req.url === '/env') {
    return jsonResponse(res, 200, {
      hostname: os.hostname(),
      home: process.env.HOME,
      user: process.env.USER || process.env.LOGNAME,
      cwd: process.cwd(),
      node: process.version,
      codespaceRepo: process.env.GITHUB_REPOSITORY || null,
      codespaceName: process.env.CODESPACE_NAME || null,
    });
  }

  // 404
  return jsonResponse(res, 404, { error: 'Unknown endpoint.' });
}

// ── Start ─────────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║           Codespace Bridge — Ready for Claude        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Port:    ${PORT}`);
  console.log(`  Token:   ${TOKEN}`);
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Go to the PORTS tab in VS Code (next to Terminal)');
  console.log('  2. Find port 3000 → right-click → "Port Visibility" → Public');
  console.log('  3. Copy the Forwarded Address (looks like https://xxxx-3000.app.github.dev)');
  console.log('  4. Paste the URL + token into Claude');
  console.log('');
  console.log('  Endpoints:');
  console.log('  GET  /ping        — health check (no token needed)');
  console.log('  GET  /env         — Codespace info (token required)');
  console.log('  POST /run         — run a command (token required)');
  console.log('                      body: { "cmd": "git pull", "cwd": "/workspaces/Wigglers_Room" }');
  console.log('');
  console.log('  Waiting for Claude...');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill the other process first:`);
    console.error(`  lsof -ti:${PORT} | xargs kill`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[bridge] Shutting down.');
  server.close(() => process.exit(0));
});
