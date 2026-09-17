#!/usr/bin/env node
/**
 * 9Router Migration Server
 * Temporary rootless HTTP migration server for blitz.cloud.
 * Listens on port 20128 when MIGRATION_MODE=true.
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
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100 MB
const TMP_DIR = process.env.TMPDIR || os.tmpdir() || '/tmp';
const MARKER_FILE = path.join(DATA_DIR, 'migration-complete');

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[migration-server ${ts}] ${msg}`);
}

function logErr(msg) {
  const ts = new Date().toISOString();
  console.error(`[migration-server ${ts}] ERROR: ${msg}`);
}

// Timing-safe token comparison
function isAuthorized(req, queryToken, bodyToken) {
  if (!MIGRATION_TOKEN) return false;
  let provided = null;
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    provided = authHeader.slice(7).trim();
  } else if (req.headers['x-migration-token']) {
    provided = String(req.headers['x-migration-token']).trim();
  } else if (queryToken) {
    provided = String(queryToken).trim();
  } else if (bodyToken) {
    provided = String(bodyToken).trim();
  }
  if (!provided) return false;
  try {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(MIGRATION_TOKEN, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Parse ZIP Central Directory in pure Node.js
function inspectZipCentralDirectory(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  const stat = fs.fstatSync(fd);
  const fileSize = stat.size;

  const readSize = Math.min(fileSize, 65557);
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, fileSize - readSize);

  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = fileSize - readSize + i;
      break;
    }
  }

  if (eocdOffset === -1) {
    fs.closeSync(fd);
    throw new Error('Invalid ZIP: End of Central Directory record not found');
  }

  const eocdBuf = Buffer.alloc(22);
  fs.readSync(fd, eocdBuf, 0, 22, eocdOffset);
  const totalEntries = eocdBuf.readUInt16LE(10);
  const cdSize = eocdBuf.readUInt32LE(12);
  const cdOffset = eocdBuf.readUInt32LE(16);

  const cdBuf = Buffer.alloc(cdSize);
  fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);
  fs.closeSync(fd);

  let p = 0;
  const entries = [];
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cdBuf.length) break;
    if (cdBuf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = cdBuf.readUInt16LE(p + 28);
    const extraLen = cdBuf.readUInt16LE(p + 30);
    const commentLen = cdBuf.readUInt16LE(p + 32);
    const filename = cdBuf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push(filename);
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// Validate ZIP structure and paths
function validateZipEntries(entries) {
  if (!entries || entries.length === 0) {
    return { valid: false, error: 'ZIP archive is empty' };
  }

  for (const entry of entries) {
    // Reject path traversal
    if (entry.includes('..') || entry.includes('../') || entry.includes('..\\')) {
      return { valid: false, error: `Security violation: Path traversal detected in entry "${entry}"` };
    }
    // Reject absolute paths
    if (entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry)) {
      return { valid: false, error: `Security violation: Absolute path detected in entry "${entry}"` };
    }
    // All entries must be under 9router-old-data/
    if (!entry.startsWith('9router-old-data/')) {
      return { valid: false, error: `Invalid archive structure: Entry "${entry}" is outside "9router-old-data/" root prefix` };
    }
  }

  // Mandatory file check
  if (!entries.includes('9router-old-data/db/data.sqlite')) {
    return { valid: false, error: 'Missing mandatory file: "9router-old-data/db/data.sqlite" was not found in archive' };
  }

  return { valid: true };
}

// Test ZIP integrity using unzip CLI
function testZipIntegrity(zipPath) {
  return new Promise((resolve) => {
    execFile('unzip', ['-t', '-q', zipPath], (err, stdout, stderr) => {
      if (err) {
        resolve({ valid: false, error: `ZIP integrity test failed: ${stderr || err.message}` });
      } else {
        resolve({ valid: true });
      }
    });
  });
}

// Test SQLite database integrity using sqlite3 CLI
function testSqliteIntegrity(sqlitePath) {
  return new Promise((resolve) => {
    execFile('sqlite3', [sqlitePath, 'PRAGMA integrity_check;'], (err, stdout, stderr) => {
      if (err) {
        resolve({ valid: false, error: `SQLite integrity check command failed: ${stderr || err.message}` });
      } else {
        const out = (stdout || '').trim();
        if (out === 'ok') {
          resolve({ valid: true });
        } else {
          resolve({ valid: false, error: `SQLite database corrupted: ${out}` });
        }
      }
    });
  });
}

// Extract single file from ZIP using unzip CLI
function extractSingleFile(zipPath, fileInZip, outPath) {
  return new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(outPath);
    const child = execFile('unzip', ['-p', zipPath, fileInZip], { maxBuffer: 100 * 1024 * 1024 });
    child.stdout.pipe(outStream);
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip -p exited with code ${code}`));
    });
  });
}

// Extract entire ZIP to directory
function extractAll(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile('unzip', ['-q', '-o', zipPath, '-d', destDir], (err, stdout, stderr) => {
      if (err) reject(new Error(`Failed to extract ZIP: ${stderr || err.message}`));
      else resolve();
    });
  });
}

// Create pre-migration backup of current DATA_DIR
function createPreMigrationBackup(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    return null;
  }
  const items = fs.readdirSync(dataDir);
  const itemsToBackup = items.filter(i => !i.startsWith('_pre_migration_backup_'));
  if (itemsToBackup.length === 0) {
    return null;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dataDir, `_pre_migration_backup_${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const item of itemsToBackup) {
    const src = path.join(dataDir, item);
    const dest = path.join(backupDir, item);
    try {
      fs.cpSync(src, dest, { recursive: true, force: true, preserveTimestamps: true });
    } catch (e) {
      logErr(`Failed to backup item "${item}": ${e.message}`);
    }
  }
  return backupDir;
}

// Extract file from multipart body
function extractFileFromMultipart(rawPath, outPath, boundary) {
  const fd = fs.openSync(rawPath, 'r');
  const stat = fs.fstatSync(fd);
  const fileSize = stat.size;

  const headBuf = Buffer.alloc(Math.min(fileSize, 8192));
  fs.readSync(fd, headBuf, 0, headBuf.length, 0);

  const headerEndMarker = Buffer.from('\r\n\r\n');
  const headerEndIdx = headBuf.indexOf(headerEndMarker);
  if (headerEndIdx === -1) {
    fs.closeSync(fd);
    throw new Error('Malformed multipart payload: header separator not found');
  }
  const fileStartOffset = headerEndIdx + 4;

  const tailReadSize = Math.min(fileSize - fileStartOffset, 8192);
  const tailBuf = Buffer.alloc(tailReadSize);
  fs.readSync(fd, tailBuf, 0, tailReadSize, fileSize - tailReadSize);

  const boundaryMarker = Buffer.from(`\r\n--${boundary}`);
  const boundaryIdx = tailBuf.indexOf(boundaryMarker);
  if (boundaryIdx === -1) {
    fs.closeSync(fd);
    throw new Error('Malformed multipart payload: closing boundary not found');
  }
  const fileEndOffset = fileSize - tailReadSize + boundaryIdx;
  const fileLen = fileEndOffset - fileStartOffset;

  const outFd = fs.openSync(outPath, 'w');
  const CHUNK_SIZE = 64 * 1024;
  const chunk = Buffer.alloc(CHUNK_SIZE);
  let bytesRemaining = fileLen;
  let pos = fileStartOffset;

  while (bytesRemaining > 0) {
    const toRead = Math.min(bytesRemaining, CHUNK_SIZE);
    const bytesRead = fs.readSync(fd, chunk, 0, toRead, pos);
    if (bytesRead === 0) break;
    fs.writeSync(outFd, chunk, 0, bytesRead);
    pos += bytesRead;
    bytesRemaining -= bytesRead;
  }

  fs.closeSync(fd);
  fs.closeSync(outFd);
}

// HTML Web Interface
const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>9Router Blitz Migration Mode</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --primary: #58a6ff;
      --primary-hover: #1f6feb;
      --success: #3fb950;
      --error: #f85149;
      --warning: #d29922;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 2rem 1rem; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 680px; }
    .header { text-align: center; margin-bottom: 2rem; }
    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; background: rgba(88, 166, 255, 0.15); color: var(--primary); font-size: 0.85rem; font-weight: 600; margin-bottom: 0.75rem; border: 1px solid rgba(88, 166, 255, 0.3); }
    h1 { font-size: 1.8rem; font-weight: 700; color: #fff; margin-bottom: 0.5rem; }
    p.desc { color: var(--text-muted); font-size: 0.95rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .form-group { margin-bottom: 1.25rem; }
    label { display: block; font-size: 0.9rem; font-weight: 600; margin-bottom: 0.5rem; color: #fff; }
    input[type="password"], input[type="text"] { width: 100%; padding: 0.75rem; background: #0d1117; border: 1px solid var(--border); border-radius: 6px; color: #fff; font-size: 0.95rem; }
    input[type="password"]:focus, input[type="text"]:focus { outline: none; border-color: var(--primary); }
    .drop-zone { border: 2px dashed var(--border); border-radius: 8px; padding: 2rem; text-align: center; cursor: pointer; transition: border-color 0.2s; background: rgba(255,255,255,0.01); }
    .drop-zone:hover, .drop-zone.dragover { border-color: var(--primary); background: rgba(88, 166, 255, 0.05); }
    .drop-icon { font-size: 2.5rem; margin-bottom: 0.5rem; display: block; }
    .btn { width: 100%; padding: 0.85rem; background: var(--primary); color: #fff; border: none; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    .btn:hover { background: var(--primary-hover); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .progress-wrap { display: none; margin-top: 1.25rem; }
    .progress-bar-bg { width: 100%; height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; }
    .progress-bar { width: 0%; height: 100%; background: var(--primary); transition: width 0.15s; }
    .progress-text { display: flex; justify-content: space-between; font-size: 0.85rem; color: var(--text-muted); margin-top: 0.4rem; }
    .log-box { display: none; margin-top: 1.25rem; background: #0d1117; border: 1px solid var(--border); border-radius: 6px; padding: 1rem; font-family: monospace; font-size: 0.85rem; max-height: 200px; overflow-y: auto; white-space: pre-wrap; line-height: 1.4; color: var(--text-muted); }
    .success-card { display: none; background: rgba(63, 185, 80, 0.1); border: 1px solid var(--success); border-radius: 8px; padding: 1.5rem; margin-top: 1.5rem; }
    .success-card h3 { color: var(--success); margin-bottom: 0.5rem; font-size: 1.2rem; }
    .success-card ol { margin-left: 1.25rem; margin-top: 0.75rem; line-height: 1.6; font-size: 0.95rem; }
    .error-card { display: none; background: rgba(248, 81, 73, 0.1); border: 1px solid var(--error); border-radius: 8px; padding: 1rem; margin-top: 1rem; color: var(--error); font-size: 0.95rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="badge">TEMPORARY MIGRATION MODE</span>
      <h1>9Router Blitz Migration</h1>
      <p class="desc">Restore full 9Router DATA_DIR archive into /app/data on Blitz</p>
    </div>

    <div class="card">
      <div class="form-group">
        <label for="token">Migration Token</label>
        <input type="password" id="token" placeholder="Enter MIGRATION_TOKEN..." autocomplete="off">
      </div>

      <div class="form-group">
        <label>Backup ZIP File (Max 100 MB)</label>
        <div class="drop-zone" id="dropZone" onclick="document.getElementById('fileInput').click()">
          <span class="drop-icon">📦</span>
          <p id="fileLabel"><strong>Click to select</strong> or drag and drop <code>9router-old-data-*.zip</code></p>
          <input type="file" id="fileInput" accept=".zip" style="display:none">
        </div>
      </div>

      <button class="btn" id="submitBtn" onclick="uploadBackup()">Start Migration</button>

      <div class="progress-wrap" id="progressWrap">
        <div class="progress-bar-bg">
          <div class="progress-bar" id="progressBar"></div>
        </div>
        <div class="progress-text">
          <span id="statusText">Uploading...</span>
          <span id="percentText">0%</span>
        </div>
      </div>

      <div class="error-card" id="errorCard"></div>
      <div class="log-box" id="logBox"></div>
    </div>

    <div class="success-card" id="successCard">
      <h3>Migration Succeeded!</h3>
      <p>All accounts, keys, settings, and database tables have been restored into <code>/app/data</code>.</p>
      <ol>
        <li>Go to Blitz dashboard -> App Settings -> <strong>Environment Variables</strong>.</li>
        <li>Set <code>MIGRATION_MODE=false</code> (or remove it).</li>
        <li>Delete <code>MIGRATION_TOKEN</code>.</li>
        <li><strong>Restart</strong> the application on Blitz. 9Router will boot normally.</li>
      </ol>
    </div>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('token')) {
      document.getElementById('token').value = urlParams.get('token');
    }

    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const fileLabel = document.getElementById('fileLabel');

    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) {
        fileLabel.innerHTML = '<strong>' + fileInput.files[0].name + '</strong> (' + (fileInput.files[0].size / (1024*1024)).toFixed(2) + ' MB)';
      }
    });

    ['dragenter', 'dragover'].forEach(name => {
      dropZone.addEventListener(name, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(name => {
      dropZone.addEventListener(name, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); });
    });
    dropZone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files[0]) {
        fileInput.files = e.dataTransfer.files;
        fileLabel.innerHTML = '<strong>' + fileInput.files[0].name + '</strong> (' + (fileInput.files[0].size / (1024*1024)).toFixed(2) + ' MB)';
      }
    });

    function addLog(msg) {
      const box = document.getElementById('logBox');
      box.style.display = 'block';
      box.textContent += msg + '\\n';
      box.scrollTop = box.scrollHeight;
    }

    function uploadBackup() {
      const token = document.getElementById('token').value.trim();
      const file = fileInput.files[0];
      const errorCard = document.getElementById('errorCard');
      const successCard = document.getElementById('successCard');
      const submitBtn = document.getElementById('submitBtn');
      const progressWrap = document.getElementById('progressWrap');
      const progressBar = document.getElementById('progressBar');
      const percentText = document.getElementById('percentText');
      const statusText = document.getElementById('statusText');

      errorCard.style.display = 'none';
      successCard.style.display = 'none';

      if (!token) {
        errorCard.textContent = 'Please provide MIGRATION_TOKEN.';
        errorCard.style.display = 'block';
        return;
      }
      if (!file) {
        errorCard.textContent = 'Please choose a backup ZIP file.';
        errorCard.style.display = 'block';
        return;
      }
      if (file.size > 100 * 1024 * 1024) {
        errorCard.textContent = 'File exceeds maximum size of 100 MB.';
        errorCard.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      progressWrap.style.display = 'block';
      progressBar.style.width = '0%';
      percentText.textContent = '0%';
      statusText.textContent = 'Uploading backup...';
      document.getElementById('logBox').textContent = '';
      addLog('[client] Starting upload of ' + file.name + ' (' + (file.size / (1024*1024)).toFixed(2) + ' MB)...');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/migrate?token=' + encodeURIComponent(token));
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = pct + '%';
          percentText.textContent = pct + '%';
          if (pct >= 100) {
            statusText.textContent = 'Verifying & restoring on server...';
            addLog('[client] Upload completed. Server is verifying ZIP and SQLite...');
          }
        }
      };

      xhr.onload = () => {
        submitBtn.disabled = false;
        try {
          const res = JSON.parse(xhr.responseText);
          if (xhr.status === 200 && res.success) {
            addLog('[client] ' + (res.message || 'Migration successful!'));
            if (res.details) {
              addLog('[client] Restored files: ' + res.details.restored_files);
              addLog('[client] SQLite integrity: ' + res.details.sqlite_integrity);
              if (res.details.backup_created) {
                addLog('[client] Pre-migration backup saved: ' + res.details.backup_created);
              }
            }
            successCard.style.display = 'block';
            statusText.textContent = 'Completed!';
            progressBar.style.background = 'var(--success)';
          } else {
            errorCard.textContent = res.error || ('Server returned HTTP ' + xhr.status);
            errorCard.style.display = 'block';
            addLog('[error] ' + (res.error || 'Failed'));
            progressBar.style.background = 'var(--error)';
          }
        } catch (e) {
          errorCard.textContent = 'Unexpected server response: ' + xhr.responseText;
          errorCard.style.display = 'block';
          progressBar.style.background = 'var(--error)';
        }
      };

      xhr.onerror = () => {
        submitBtn.disabled = false;
        errorCard.textContent = 'Network error during upload.';
        errorCard.style.display = 'block';
        progressBar.style.background = 'var(--error)';
      };

      xhr.send(file);
    }
  </script>
</body>
</html>`;

// Handle migration upload
async function handleMigrationUpload(req, res, query) {
  const queryToken = query.get('token') || '';

  // 1. Authenticate
  if (!isAuthorized(req, queryToken)) {
    logErr('Unauthorized migration attempt: missing or invalid MIGRATION_TOKEN');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing MIGRATION_TOKEN' }));
    return;
  }

  // 2. Check Content-Length
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_UPLOAD_SIZE) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `File too large. Maximum size is 100 MB (got ${contentLength} bytes)` }));
    return;
  }

  log('Authorized migration upload received. Streaming to disk...');

  const tempId = crypto.randomBytes(8).toString('hex');
  const tempRawPath = path.join(TMP_DIR, `migration_raw_${tempId}.tmp`);
  const tempZipPath = path.join(TMP_DIR, `migration_pkg_${tempId}.zip`);
  const stageDir = path.join(TMP_DIR, `migration_stage_${tempId}`);

  let receivedBytes = 0;
  const writeStream = fs.createWriteStream(tempRawPath);

  writeStream.on('error', (err) => {
    logErr(`File write error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Server write error: ${err.message}` }));
    }
  });

  req.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_UPLOAD_SIZE) {
      req.destroy(new Error('Payload exceeded 100 MB limit'));
    }
  });

  req.pipe(writeStream);

  req.on('error', (err) => {
    logErr(`Upload streaming error: ${err.message}`);
    try { fs.unlinkSync(tempRawPath); } catch {}
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upload error: ${err.message}` }));
    }
  });

  writeStream.on('finish', async () => {
    try {
      log(`Received ${receivedBytes} bytes. Preparing archive...`);

      // Determine if multipart form or raw binary stream
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('multipart/form-data')) {
        const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
        if (!boundaryMatch) throw new Error('Malformed multipart Content-Type: missing boundary');
        const boundary = boundaryMatch[1].trim().replace(/^["']|["']$/g, '');
        extractFileFromMultipart(tempRawPath, tempZipPath, boundary);
        try { fs.unlinkSync(tempRawPath); } catch {}
      } else {
        // Raw stream
        fs.renameSync(tempRawPath, tempZipPath);
      }

      const zipSize = fs.statSync(tempZipPath).size;
      log(`Archive size on disk: ${zipSize} bytes. Inspecting ZIP structure...`);

      // 3. Inspect ZIP Central Directory & Validate Paths
      const entries = inspectZipCentralDirectory(tempZipPath);
      log(`Archive contains ${entries.length} entries. Validating paths...`);

      const pathValidation = validateZipEntries(entries);
      if (!pathValidation.valid) {
        logErr(`Path validation rejected: ${pathValidation.error}`);
        throw new Error(pathValidation.error);
      }
      log('Path traversal & structure validation: PASSED');

      // 4. Test ZIP Integrity
      log('Running ZIP integrity test...');
      const zipIntegrity = await testZipIntegrity(tempZipPath);
      if (!zipIntegrity.valid) {
        logErr(`ZIP integrity failed: ${zipIntegrity.error}`);
        throw new Error(zipIntegrity.error);
      }
      log('ZIP integrity test: PASSED');

      // 5. Test SQLite Integrity from Archive
      log('Extracting data.sqlite for pre-flight integrity check...');
      const testDbPath = path.join(TMP_DIR, `pre_check_${tempId}.sqlite`);
      await extractSingleFile(tempZipPath, '9router-old-data/db/data.sqlite', testDbPath);

      log('Running SQLite PRAGMA integrity_check on extracted DB...');
      const sqliteIntegrity = await testSqliteIntegrity(testDbPath);
      try { fs.unlinkSync(testDbPath); } catch {}

      if (!sqliteIntegrity.valid) {
        logErr(`SQLite check failed: ${sqliteIntegrity.error}`);
        throw new Error(sqliteIntegrity.error);
      }
      log('SQLite integrity check: PASSED (ok)');

      // 6. Pre-migration Backup of existing DATA_DIR
      log(`Checking existing data in ${DATA_DIR}...`);
      const backupDir = createPreMigrationBackup(DATA_DIR);
      if (backupDir) {
        log(`Created pre-migration backup of existing data at: ${backupDir}`);
      } else {
        log('No previous data existed to backup.');
      }

      // 7. Extract archive to staging
      log('Extracting archive to staging folder...');
      await extractAll(tempZipPath, stageDir);

      const stagedDataRoot = path.join(stageDir, '9router-old-data');
      if (!fs.existsSync(stagedDataRoot)) {
        throw new Error('Expected extracted folder "9router-old-data" was not found');
      }

      // 8. Restore contents into DATA_DIR
      log(`Restoring archive contents into ${DATA_DIR}...`);
      const itemsToRestore = fs.readdirSync(stagedDataRoot);
      for (const item of itemsToRestore) {
        const src = path.join(stagedDataRoot, item);
        const dest = path.join(DATA_DIR, item);
        fs.cpSync(src, dest, { recursive: true, force: true, preserveTimestamps: true });
      }

      // 9. Post-restore Verification
      const targetDb = path.join(DATA_DIR, 'db', 'data.sqlite');
      if (!fs.existsSync(targetDb) || fs.statSync(targetDb).size === 0) {
        throw new Error(`Restoration failed: ${targetDb} does not exist or is empty`);
      }

      const finalDbCheck = await testSqliteIntegrity(targetDb);
      if (!finalDbCheck.valid) {
        throw new Error(`Final SQLite integrity verification failed: ${finalDbCheck.error}`);
      }
      log('Post-restore database verification: PASSED (ok)');

      // 10. Write migration marker
      const markerPayload = {
        migrated_at: new Date().toISOString(),
        restored_entries: entries.length,
        status: 'complete',
        sqlite_integrity: 'ok',
        pre_migration_backup: backupDir || null
      };
      fs.writeFileSync(MARKER_FILE, JSON.stringify(markerPayload, null, 2), 'utf8');
      log(`Migration marker created at ${MARKER_FILE}`);

      // 11. Cleanup temporary files
      try { fs.unlinkSync(tempZipPath); } catch {}
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}

      log('SUCCESS: Migration process completed successfully.');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: '9Router DATA_DIR migration completed successfully!',
        details: {
          restored_files: entries.length,
          sqlite_integrity: 'ok',
          backup_created: backupDir,
          marker_created: MARKER_FILE
        },
        next_steps: [
          '1. In Blitz dashboard, go to Settings -> Environment Variables',
          '2. Set MIGRATION_MODE=false (or delete the variable)',
          '3. Remove MIGRATION_TOKEN',
          '4. Restart the Blitz application to start 9Router with restored data'
        ]
      }));

    } catch (err) {
      logErr(`Migration failed: ${err.message}`);
      try { fs.unlinkSync(tempRawPath); } catch {}
      try { fs.unlinkSync(tempZipPath); } catch {}
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}

      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Internal migration error' }));
      }
    }
  });
}

// Start HTTP Server
const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // Status / Health check
  if (pathname === '/health' || pathname === '/api/status') {
    const isComplete = fs.existsSync(MARKER_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'migration_mode',
      ready: true,
      migration_complete: isComplete,
      uptime: process.uptime()
    }));
    return;
  }

  // Upload endpoint
  if (pathname === '/api/migrate' && req.method === 'POST') {
    handleMigrationUpload(req, res, reqUrl.searchParams);
    return;
  }

  // Web UI
  if ((pathname === '/' || pathname === '/migration') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_UI);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, HOSTNAME, () => {
  log('========================================================');
  log(` 9Router TEMPORARY MIGRATION SERVER RUNNING`);
  log(` Port:     ${PORT}`);
  log(` Hostname: ${HOSTNAME}`);
  log(` DATA_DIR: ${DATA_DIR}`);
  log(` Token:    ${MIGRATION_TOKEN ? '[CONFIGURED]' : '[NOT SET - ACTION REQUIRED]'}`);
  log(` Web UI:   http://${HOSTNAME === '0.0.0.0' ? 'localhost' : HOSTNAME}:${PORT}/`);
  log('========================================================');
  if (!MIGRATION_TOKEN) {
    logErr('CRITICAL: MIGRATION_TOKEN is not set! Set the MIGRATION_TOKEN environment variable.');
  }
});
