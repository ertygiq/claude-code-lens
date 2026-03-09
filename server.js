#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function getPort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '-p' || arg === '--port') && args[i + 1]) return args[i + 1];
    if (arg.startsWith('--port=')) return arg.slice('--port='.length);
  }
  return process.env.PORT || 3000;
}

const PORT = getPort();
const PROJECTS_DIRS = [path.join(os.homedir(), '.claude', 'projects')];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)?$/;

function pathToId(p) { return Buffer.from(p).toString('base64url'); }
function idToPath(id) { return Buffer.from(id, 'base64url').toString(); }

function safePath(id) {
  try {
    const p = path.resolve(idToPath(id));
    if (!p.endsWith('.jsonl')) return null;
    if (!PROJECTS_DIRS.some(d => p.startsWith(d))) return null;
    if (!fs.existsSync(p)) return null;
    return p;
  } catch { return null; }
}

async function extractSessionMeta(filePath) {
  const meta = { summary: null, firstMessage: null, lineCount: 0, cwd: null };
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream });
  for await (const line of rl) {
    meta.lineCount++;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'summary' && obj.summary) meta.summary = obj.summary;
      if (!meta.firstMessage && obj.type === 'user' && obj.message?.content) {
        const text = Array.isArray(obj.message.content)
          ? obj.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
          : typeof obj.message.content === 'string' ? obj.message.content : '';
        const clean = text.replace(/<[^>]+>/g, '').trim();
        if (clean) meta.firstMessage = clean.slice(0, 400);
      }
      if (!meta.cwd && obj.cwd) meta.cwd = obj.cwd;
    } catch {}
  }
  return meta;
}

async function listSessions() {
  const sessions = [];

  for (const PROJECTS_DIR of PROJECTS_DIRS) {
  let projectDirs;
  try { projectDirs = fs.readdirSync(PROJECTS_DIR); } catch { continue; }

  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    try { if (!fs.statSync(projPath).isDirectory()) continue; } catch { continue; }

    let files;
    try { files = fs.readdirSync(projPath); } catch { continue; }

    for (const file of files) {
      if (!UUID_RE.test(file)) continue;
      const filePath = path.join(projPath, file);
      let fileStat;
      try { fileStat = fs.statSync(filePath); } catch { continue; }

      if (fileStat.isFile()) {
        const meta = await extractSessionMeta(filePath);
        sessions.push({
          id: pathToId(filePath),
          uid: file.replace(/\.jsonl$/, ''),
          projectDir: projDir,
          projectPath: meta.cwd || projDir.replace(/^-/, '/').replace(/-/g, '/'),
          summary: meta.summary,
          firstMessage: meta.firstMessage,
          lastModified: fileStat.mtimeMs,
          size: fileStat.size,
          lineCount: meta.lineCount,
        });
      }

      // scan subagents dir inside uuid directories
      if (fileStat.isDirectory()) {
        const subDir = path.join(filePath, 'subagents');
        let subFiles;
        try { subFiles = fs.readdirSync(subDir); } catch { continue; }
        for (const sf of subFiles) {
          if (!sf.endsWith('.jsonl')) continue;
          const subPath = path.join(subDir, sf);
          let subStat;
          try { subStat = fs.statSync(subPath); } catch { continue; }
          if (!subStat.isFile()) continue;
          const meta = await extractSessionMeta(subPath);
          sessions.push({
            id: pathToId(subPath),
            uid: file + '/subagents/' + sf.replace(/\.jsonl$/, ''),
            projectDir: projDir,
            projectPath: meta.cwd || projDir.replace(/^-/, '/').replace(/-/g, '/'),
            summary: meta.summary,
            firstMessage: meta.firstMessage,
            lastModified: subStat.mtimeMs,
            size: subStat.size,
            lineCount: meta.lineCount,
          });
        }
      }
    }
  }
  }

  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions;
}

function sendNewLines(filePath, start, end, res) {
  const buf = Buffer.alloc(end - start);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, end - start, start);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }
}

function streamSession(filePath, startOffset, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let offset = startOffset;

  try {
    const curr = fs.statSync(filePath).size;
    if (curr > offset) {
      sendNewLines(filePath, offset, curr, res);
      offset = curr;
    }
  } catch {}

  res.write(`: connected\n\n`);

  const heartbeat = setInterval(() => res.write(`: heartbeat\n\n`), 15000);

  const listener = (curr) => {
    if (curr.size > offset) {
      sendNewLines(filePath, offset, curr.size, res);
      offset = curr.size;
    }
  };

  fs.watchFile(filePath, { interval: 500 }, listener);

  res.on('close', () => {
    clearInterval(heartbeat);
    fs.unwatchFile(filePath, listener);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (p === '/api/sessions') {
    const sessions = await listSessions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  const contentMatch = p.match(/^\/api\/session\/([A-Za-z0-9_-]+)\/content$/);
  if (contentMatch) {
    const filePath = safePath(contentMatch[1]);
    if (!filePath) { res.writeHead(404); res.end('Not found'); return; }
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: buf.toString('utf8'), byteLength: buf.length }));
    return;
  }

  const streamMatch = p.match(/^\/api\/session\/([A-Za-z0-9_-]+)\/stream$/);
  if (streamMatch) {
    const filePath = safePath(streamMatch[1]);
    if (!filePath) { res.writeHead(404); res.end('Not found'); return; }
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    streamSession(filePath, offset, res);
    return;
  }

  if (p === '/api/restart') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('restarting');
    setTimeout(() => process.exit(0), 100);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Claude Code Lens → http://localhost:${PORT}`);
});
