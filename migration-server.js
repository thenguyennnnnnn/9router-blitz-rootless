#!/usr/bin/env node
/**
 * 9Router temporary migration server for blitz.cloud.
 * Chunked-upload build to bypass Blitz/nginx request-body limits.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '20128', 10);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const MIGRATION_TOKEN = (process.env.MIGRATION_TOKEN || '').trim();
const TMP_DIR = process.env.TMPDIR || os.tmpdir() || '/tmp';

const MAX_FILE_SIZE = 5 * 1024 * 1024;      // slim migration package only
const MAX_CHUNK_SIZE = 64 * 1024;            // 64 KB/request, safely below proxy limit
const MAX_CHUNKS = 128;
const UPLOAD_ROOT = path.join(TMP_DIR, '9router-migration-chunks');
const MARKER_FILE = path.join(DATA_DIR, 'migration-complete');

function log(msg) {
  console.log(`[migration-server ${new Date().toISOString()}] ${msg}`);
}
function logErr(msg) {
  console.error(`[migration-server ${new Date().toISOString()}] ERROR: ${msg}`);
}
function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}
function safeEqual(a, b) {
  try {
    const aa = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}
function authorized(req, queryToken = '') {
  if (!MIGRATION_TOKEN) return false;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const hdr = String(req.headers['x-migration-token'] || '').trim();
  return safeEqual(bearer || hdr || queryToken, MIGRATION_TOKEN);
}
function validUploadId(id) {
  return /^[A-Za-z0-9_-]{8,100}$/.test(id || '');
}
function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim()));
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
async function sqliteOk(dbPath) {
  const { stdout } = await execFileP('sqlite3', [dbPath, 'PRAGMA integrity_check;']);
  return stdout.trim() === 'ok';
}
async function listZip(zipPath) {
  const { stdout } = await execFileP('unzip', ['-Z1', zipPath]);
  return stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}
function validateZipEntries(entries) {
  if (!entries.length) throw new Error('ZIP archive is empty');

  for (const raw of entries) {
    const e = raw.replace(/\\/g, '/');
    if (
      e.startsWith('/') ||
      /^[A-Za-z]:/.test(e) ||
      e.split('/').includes('..')
    ) {
      throw new Error(`Unsafe ZIP path: ${raw}`);
    }
    if (!e.startsWith('9router-old-data/')) {
      throw new Error(`Entry outside 9router-old-data/: ${raw}`);
    }
  }

  const required = '9router-old-data/db/data.sqlite';
  if (!entries.some(e => e.replace(/\\/g, '/') === required)) {
    throw new Error(`Missing ${required}`);
  }
}
function createPreMigrationBackup() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const items = fs.readdirSync(DATA_DIR)
    .filter(n => !n.startsWith('_pre_migration_backup_'));

  if (!items.length) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(DATA_DIR, `_pre_migration_backup_${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const item of items) {
    fs.cpSync(
      path.join(DATA_DIR, item),
      path.join(backupDir, item),
      { recursive: true, force: true, preserveTimestamps: true }
    );
  }
  return backupDir;
}
function restoreStage(stageRoot) {
  for (const item of fs.readdirSync(stageRoot)) {
    fs.cpSync(
      path.join(stageRoot, item),
      path.join(DATA_DIR, item),
      { recursive: true, force: true, preserveTimestamps: true }
    );
  }
}
function cleanupOldUploads() {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  const now = Date.now();
  for (const name of fs.readdirSync(UPLOAD_ROOT)) {
    const p = path.join(UPLOAD_ROOT, name);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > 60 * 60 * 1000) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  }
}
async function processZip(zipPath, uploadId) {
  await execFileP('unzip', ['-t', '-q', zipPath]);

  const entries = await listZip(zipPath);
  validateZipEntries(entries);
  log(`ZIP validation passed (${entries.length} entries)`);

  const stageDir = path.join(TMP_DIR, `migration-stage-${uploadId}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  await execFileP('unzip', ['-q', '-o', zipPath, '-d', stageDir]);

  const stageRoot = path.join(stageDir, '9router-old-data');
  const stageDb = path.join(stageRoot, 'db', 'data.sqlite');

  if (!fs.existsSync(stageDb) || fs.statSync(stageDb).size === 0) {
    throw new Error('Extracted data.sqlite missing or empty');
  }

  if (!(await sqliteOk(stageDb))) {
    throw new Error('SQLite integrity_check failed before restore');
  }
  log(`SQLite pre-check OK (${fs.statSync(stageDb).size} bytes)`);

  const backupDir = createPreMigrationBackup();
  if (backupDir) log(`Pre-migration backup: ${backupDir}`);

  restoreStage(stageRoot);

  const finalDb = path.join(DATA_DIR, 'db', 'data.sqlite');
  if (!(await sqliteOk(finalDb))) {
    throw new Error('SQLite integrity_check failed after restore');
  }

  fs.writeFileSync(
    MARKER_FILE,
    JSON.stringify({
      migrated_at: new Date().toISOString(),
      restored_entries: entries.length,
      sqlite_integrity: 'ok',
      pre_migration_backup: backupDir
    }, null, 2),
    'utf8'
  );

  fs.rmSync(stageDir, { recursive: true, force: true });

  return {
    restored_files: entries.length,
    sqlite_integrity: 'ok',
    backup_created: backupDir,
    marker_created: MARKER_FILE
  };
}

async function readSmallBody(req, maxBytes) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body too large: ${total} > ${maxBytes}`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleChunk(req, res, u) {
  if (!authorized(req, u.searchParams.get('token') || '')) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const uploadId = u.searchParams.get('uploadId') || '';
  const index = Number(u.searchParams.get('index'));
  const total = Number(u.searchParams.get('total'));
  const size = Number(u.searchParams.get('size'));

  if (!validUploadId(uploadId)) return json(res, 400, { error: 'Invalid uploadId' });
  if (!Number.isInteger(index) || index < 0) return json(res, 400, { error: 'Invalid chunk index' });
  if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) return json(res, 400, { error: 'Invalid total chunks' });
  if (index >= total) return json(res, 400, { error: 'Chunk index >= total' });
  if (!Number.isInteger(size) || size < 1 || size > MAX_FILE_SIZE) return json(res, 400, { error: 'Invalid file size' });

  const len = Number(req.headers['content-length'] || 0);
  if (!Number.isInteger(len) || len < 1 || len > MAX_CHUNK_SIZE) {
    return json(res, 413, { error: `Chunk must be <= ${MAX_CHUNK_SIZE} bytes` });
  }

  const dir = path.join(UPLOAD_ROOT, uploadId);
  fs.mkdirSync(dir, { recursive: true });

  const body = await readSmallBody(req, MAX_CHUNK_SIZE);
  if (body.length !== len) return json(res, 400, { error: 'Incomplete chunk body' });

  const chunkPath = path.join(dir, `chunk-${String(index).padStart(4, '0')}`);
  fs.writeFileSync(chunkPath, body);

  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ total, size, updated: Date.now() }),
    'utf8'
  );

  json(res, 200, { ok: true, index, received: body.length });
}

async function handleFinalize(req, res, u) {
  if (!authorized(req, u.searchParams.get('token') || '')) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const raw = await readSmallBody(req, 16 * 1024);
  let meta;
  try {
    meta = JSON.parse(raw.toString('utf8'));
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const uploadId = String(meta.uploadId || '');
  const total = Number(meta.total);
  const size = Number(meta.size);
  const sha256 = String(meta.sha256 || '').toLowerCase();

  if (!validUploadId(uploadId)) return json(res, 400, { error: 'Invalid uploadId' });
  if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) return json(res, 400, { error: 'Invalid total' });
  if (!Number.isInteger(size) || size < 1 || size > MAX_FILE_SIZE) return json(res, 400, { error: 'Invalid size' });
  if (!/^[a-f0-9]{64}$/.test(sha256)) return json(res, 400, { error: 'Invalid SHA256' });

  const dir = path.join(UPLOAD_ROOT, uploadId);
  if (!fs.existsSync(dir)) return json(res, 404, { error: 'Upload session not found' });

  const zipPath = path.join(TMP_DIR, `migration-${uploadId}.zip`);
  const out = fs.openSync(zipPath, 'w');
  const hash = crypto.createHash('sha256');
  let written = 0;

  try {
    for (let i = 0; i < total; i++) {
      const p = path.join(dir, `chunk-${String(i).padStart(4, '0')}`);
      if (!fs.existsSync(p)) throw new Error(`Missing chunk ${i}/${total - 1}`);
      const buf = fs.readFileSync(p);
      fs.writeSync(out, buf);
      hash.update(buf);
      written += buf.length;
    }
  } finally {
    fs.closeSync(out);
  }

  if (written !== size) {
    fs.unlinkSync(zipPath);
    return json(res, 400, { error: `Size mismatch: expected ${size}, got ${written}` });
  }

  const actualHash = hash.digest('hex');
  if (actualHash !== sha256) {
    fs.unlinkSync(zipPath);
    return json(res, 400, { error: 'SHA256 mismatch' });
  }

  try {
    const details = await processZip(zipPath, uploadId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.unlinkSync(zipPath);

    json(res, 200, {
      success: true,
      message: 'Migration completed successfully',
      details
    });
  } catch (e) {
    logErr(e.message);
    try { fs.unlinkSync(zipPath); } catch {}
    json(res, 500, { error: e.message });
  }
}

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>9Router Migration</title>
<style>
body{font-family:system-ui;background:#0d1117;color:#c9d1d9;margin:0;padding:28px}
.card{max-width:700px;margin:auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px}
h1{color:#fff;margin-top:0}
label{display:block;margin:18px 0 7px;font-weight:650}
input{width:100%;box-sizing:border-box;padding:12px;background:#0d1117;color:#fff;border:1px solid #30363d;border-radius:8px}
button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:8px;background:#58a6ff;color:#fff;font-weight:700;cursor:pointer}
button:disabled{opacity:.5}
.bar{height:9px;background:#21262d;border-radius:99px;overflow:hidden;margin-top:18px}
.fill{height:100%;width:0;background:#58a6ff}
pre{white-space:pre-wrap;background:#0d1117;padding:14px;border-radius:8px;margin-top:14px}
.ok{color:#3fb950}.err{color:#f85149}
</style>
</head>
<body>
<div class="card">
<h1>9Router Migration — Chunked Upload</h1>
<p>Each request is only 64 KB, so Blitz/nginx cannot reject the whole backup with HTTP 413.</p>

<label>Migration token</label>
<input id="token" type="password" autocomplete="off">

<label>Slim backup ZIP</label>
<input id="file" type="file" accept=".zip">

<button id="go">Start Migration</button>
<div class="bar"><div class="fill" id="fill"></div></div>
<pre id="out">Ready.</pre>
</div>

<script>
const CHUNK = ${MAX_CHUNK_SIZE};

function hex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function sendChunk(file, uploadId, i, total, token) {
  const start = i * CHUNK;
  const end = Math.min(file.size, start + CHUNK);
  const blob = file.slice(start, end);

  const url =
    '/api/chunk?token=' + encodeURIComponent(token) +
    '&uploadId=' + encodeURIComponent(uploadId) +
    '&index=' + i +
    '&total=' + total +
    '&size=' + file.size;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/octet-stream'
      },
      body: blob
    });

    if (r.ok) return;

    if (attempt === 3) {
      throw new Error('Chunk ' + (i+1) + ' failed: HTTP ' + r.status + ' ' + await r.text());
    }
    await sleep(400 * attempt);
  }
}

document.getElementById('go').onclick = async () => {
  const token = document.getElementById('token').value.trim();
  const file = document.getElementById('file').files[0];
  const out = document.getElementById('out');
  const fill = document.getElementById('fill');
  const btn = document.getElementById('go');

  if (!token) { out.className='err'; out.textContent='Missing MIGRATION_TOKEN'; return; }
  if (!file) { out.className='err'; out.textContent='Choose the slim ZIP first'; return; }
  if (file.size > ${MAX_FILE_SIZE}) {
    out.className='err'; out.textContent='File too large for slim migration mode'; return;
  }

  btn.disabled = true;
  out.className='';
  fill.style.width='0%';

  try {
    out.textContent='Calculating SHA256...';
    const sha256 = hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));

    const uploadId =
      'mig_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 12);

    const total = Math.ceil(file.size / CHUNK);

    for (let i = 0; i < total; i++) {
      out.textContent='Uploading chunk ' + (i+1) + '/' + total + '...';
      await sendChunk(file, uploadId, i, total, token);
      fill.style.width = Math.round(((i+1)/total)*90) + '%';
    }

    out.textContent='All chunks uploaded. Verifying and restoring...';

    const r = await fetch('/api/finalize?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uploadId,
        total,
        size: file.size,
        sha256
      })
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(text || ('HTTP ' + r.status)); }

    if (!r.ok || !data.success) throw new Error(data.error || ('HTTP ' + r.status));

    fill.style.width='100%';
    fill.style.background='#3fb950';
    out.className='ok';
    out.textContent =
      'SUCCESS\\n' +
      'SQLite integrity: ' + data.details.sqlite_integrity + '\\n' +
      'Restored entries: ' + data.details.restored_files + '\\n\\n' +
      'Now set MIGRATION_MODE=false, remove MIGRATION_TOKEN, then Restart.';
  } catch (e) {
    fill.style.background='#f85149';
    out.className='err';
    out.textContent='ERROR: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};
</script>
</body>
</html>`;

cleanupOldUploads();

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (u.pathname === '/health' || u.pathname === '/api/status') {
      return json(res, 200, {
        status: 'migration_mode',
        ready: true,
        migration_complete: fs.existsSync(MARKER_FILE),
        upload_mode: 'chunked',
        chunk_bytes: MAX_CHUNK_SIZE,
        uptime: process.uptime()
      });
    }

    if (u.pathname === '/api/chunk' && req.method === 'POST') {
      return await handleChunk(req, res, u);
    }

    if (u.pathname === '/api/finalize' && req.method === 'POST') {
      return await handleFinalize(req, res, u);
    }

    if ((u.pathname === '/' || u.pathname === '/migration') && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(HTML);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (e) {
    logErr(e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOSTNAME, () => {
  log('========================================================');
  log('9Router TEMPORARY MIGRATION SERVER RUNNING — CHUNKED');
  log(`Port: ${PORT}`);
  log(`Chunk size: ${MAX_CHUNK_SIZE} bytes`);
  log(`DATA_DIR: ${DATA_DIR}`);
  log(`Token: ${MIGRATION_TOKEN ? '[CONFIGURED]' : '[NOT SET]'}`);
  log('========================================================');

  if (!MIGRATION_TOKEN) logErr('MIGRATION_TOKEN is not set');
});
