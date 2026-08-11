const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || '';
const MAX_RENDER_MS = Number(process.env.MAX_RENDER_MS || 30 * 60 * 1000);
const TMP_ROOT = process.env.TMP_ROOT || os.tmpdir();
const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES || 256 * 1024);

app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!SHARED_SECRET) return next();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// POST /thumbnail — download a base image, overlay bold yellow title text, return JPEG
// Body: { imageUrl: string, title: string }
app.post('/thumbnail', (req, res) => {
  const { imageUrl, title } = req.body || {};
  if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
    return res.status(400).json({ error: 'missing imageUrl' });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(TMP_ROOT, `thumb-${id}`);
  fs.mkdirSync(workDir, { recursive: true });

  // Sanitize title for ffmpeg drawtext: strip risky chars, escape colon, wrap to 2 lines
  const rawTitle = (title || '').slice(0, 90);
  const safeOneLine = rawTitle
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^a-zA-Z0-9 ?!.,&'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  // Naive 2-line split at the nearest space to the midpoint, only if title > 30 chars
  let line1 = safeOneLine, line2 = '';
  if (safeOneLine.length > 30) {
    const mid = Math.floor(safeOneLine.length / 2);
    let splitAt = safeOneLine.lastIndexOf(' ', mid + 5);
    if (splitAt < 10) splitAt = safeOneLine.indexOf(' ', mid);
    if (splitAt > 0) {
      line1 = safeOneLine.slice(0, splitAt).trim();
      line2 = safeOneLine.slice(splitAt + 1).trim();
    }
  }
  // ffmpeg drawtext escape: backslash and colon
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '');

  const bashCmd = [
    '#!/bin/bash',
    'set -e',
    `cd "${workDir}"`,
    `curl -L -s --fail --max-time 60 "${imageUrl.replace(/"/g, '%22')}" -o base.jpg`,
    // pick a bold-ish font that exists in this image
    `FONT=$(find /usr/share/fonts -iname '*Bold*.ttf' 2>/dev/null | head -1)`,
    `if [ -z "$FONT" ]; then FONT=$(find /usr/share/fonts -iname 'DejaVu*Bold*' 2>/dev/null | head -1); fi`,
    `if [ -z "$FONT" ]; then FONT=$(find /usr/share/fonts -iname '*.ttf' 2>/dev/null | head -1); fi`,
    `if [ -z "$FONT" ]; then echo "no font available" >&2; exit 1; fi`,
    `echo "Using font: $FONT"`,
    line2
      ? `ffmpeg -y -loglevel error -i base.jpg ` +
        `-vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
        // semi-opaque black bar behind 2 lines, large bold yellow text on top
        `drawtext=text='${esc(line1)}':fontfile=$FONT:fontsize=82:fontcolor=yellow:bordercolor=black:borderw=6:shadowcolor=black@0.85:shadowx=5:shadowy=5:x=(w-text_w)/2:y=h-220,` +
        `drawtext=text='${esc(line2)}':fontfile=$FONT:fontsize=82:fontcolor=yellow:bordercolor=black:borderw=6:shadowcolor=black@0.85:shadowx=5:shadowy=5:x=(w-text_w)/2:y=h-110" ` +
        `-frames:v 1 -q:v 2 output.jpg`
      : `ffmpeg -y -loglevel error -i base.jpg ` +
        `-vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
        // semi-opaque black bar behind 1 line, large bold yellow text on top
        `drawtext=text='${esc(line1)}':fontfile=$FONT:fontsize=92:fontcolor=yellow:bordercolor=black:borderw=6:shadowcolor=black@0.85:shadowx=5:shadowy=5:x=(w-text_w)/2:y=h-130" ` +
        `-frames:v 1 -q:v 2 output.jpg`,
  ].join('\n');

  const scriptPath = path.join(workDir, 'thumb.sh');
  fs.writeFileSync(scriptPath, bashCmd, { mode: 0o755 });

  console.log(`[thumb ${id}] starting`);
  const start = Date.now();
  const child = spawn('bash', [scriptPath], { cwd: workDir });

  let stderr = '';
  let stdout = '';
  let responded = false;
  const respondOnce = (fn) => { if (!responded) { responded = true; fn(); } };
  const appendBounded = (buf, chunk) => {
    const next = buf + chunk;
    if (next.length <= MAX_LOG_BYTES) return next;
    return next.slice(next.length - MAX_LOG_BYTES);
  };
  child.stdout.on('data', (d) => { stdout = appendBounded(stdout, d); process.stdout.write(`[${id}|t-out] ${d}`); });
  child.stderr.on('data', (d) => { stderr = appendBounded(stderr, d); process.stderr.write(`[${id}|t-err] ${d}`); });

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    respondOnce(() => {
      cleanup(workDir);
      res.status(504).json({ error: 'thumbnail timeout', stderr: tail(stderr), stdout: tail(stdout) });
    });
  }, 5 * 60 * 1000);

  child.on('error', (err) => {
    clearTimeout(timer);
    respondOnce(() => {
      cleanup(workDir);
      res.status(500).json({ error: err.message });
    });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    console.log(`[thumb ${id}] exited code=${code} in ${Date.now() - start}ms`);
    if (code !== 0) {
      return respondOnce(() => {
        cleanup(workDir);
        res.status(500).json({
          error: 'thumbnail render failed',
          exitCode: code,
          stderr: tail(stderr),
          stdout: tail(stdout),
        });
      });
    }
    const outputPath = path.join(workDir, 'output.jpg');
    if (!fs.existsSync(outputPath)) {
      return respondOnce(() => {
        cleanup(workDir);
        res.status(500).json({ error: 'output file not produced', stderr: tail(stderr) });
      });
    }
    respondOnce(() => {
      const stat = fs.statSync(outputPath);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="thumb-${id}.jpg"`);
      const stream = fs.createReadStream(outputPath);
      stream.on('close', () => cleanup(workDir));
      stream.on('error', (err) => { console.error(`[thumb ${id}] stream error:`, err); cleanup(workDir); });
      stream.pipe(res);
    });
  });
});

app.post('/render', (req, res) => {
  const { command } = req.body || {};
  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'missing command' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(TMP_ROOT, `render-${id}`);
  fs.mkdirSync(workDir, { recursive: true });

  const adjustedCommand = command.replace(/\/tmp\/n8n\/test/g, workDir);
  const scriptPath = path.join(workDir, 'render.sh');
  fs.writeFileSync(scriptPath, adjustedCommand, { mode: 0o755 });

  console.log(`[${id}] starting render in ${workDir}`);
  const start = Date.now();

  const child = spawn('bash', [scriptPath], { cwd: workDir });

  let stderr = '';
  let stdout = '';
  let responded = false;
  const respondOnce = (fn) => { if (!responded) { responded = true; fn(); } };

  // Bounded append: keep only the most recent MAX_LOG_BYTES of each buffer
  // so a flood of child output cannot blow past V8's max string length.
  const appendBounded = (buf, chunk) => {
    const next = buf + chunk;
    if (next.length <= MAX_LOG_BYTES) return next;
    return next.slice(next.length - MAX_LOG_BYTES);
  };

  child.stdout.on('data', (d) => {
    stdout = appendBounded(stdout, d);
    process.stdout.write(`[${id}|out] ${d}`);
  });
  child.stderr.on('data', (d) => {
    stderr = appendBounded(stderr, d);
    process.stderr.write(`[${id}|err] ${d}`);
  });

  const timer = setTimeout(() => {
    console.error(`[${id}] timeout after ${MAX_RENDER_MS}ms — killing`);
    child.kill('SIGKILL');
    respondOnce(() => {
      cleanup(workDir);
      res.status(504).json({ error: 'render timeout', stderr: tail(stderr), stdout: tail(stdout) });
    });
  }, MAX_RENDER_MS);

  child.on('error', (err) => {
    clearTimeout(timer);
    console.error(`[${id}] spawn error:`, err);
    respondOnce(() => {
      cleanup(workDir);
      res.status(500).json({ error: err.message });
    });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    const ms = Date.now() - start;
    console.log(`[${id}] exited code=${code} in ${ms}ms`);

    if (code !== 0) {
      return respondOnce(() => {
        cleanup(workDir);
        res.status(500).json({
          error: 'render failed',
          exitCode: code,
          stderr: tail(stderr),
          stdout: tail(stdout),
        });
      });
    }

    const outputPath = path.join(workDir, 'final_output.mp4');
    if (!fs.existsSync(outputPath)) {
      return respondOnce(() => {
        cleanup(workDir);
        res.status(500).json({
          error: 'output file not produced',
          expected: outputPath,
          stderr: tail(stderr),
          stdout: tail(stdout),
        });
      });
    }

    respondOnce(() => {
      const stat = fs.statSync(outputPath);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="video-${id}.mp4"`);
      const stream = fs.createReadStream(outputPath);
      stream.on('close', () => cleanup(workDir));
      stream.on('error', (err) => {
        console.error(`[${id}] stream error:`, err);
        cleanup(workDir);
      });
      stream.pipe(res);
    });
  });
});

function cleanup(workDir) {
  fs.rm(workDir, { recursive: true, force: true }, (err) => {
    if (err) console.error('cleanup error:', err.message);
  });
}

function tail(str, lines = 50) {
  return str.split('\n').slice(-lines).join('\n');
}

// ===========================================================================
// ASYNC RENDER JOBS
//
// Added 2026-08-11 for long-form documentary renders (20-30 min output, 100+
// source clips) which cannot complete inside the synchronous path:
//   - MAX_RENDER_MS caps a sync render at 30 minutes; these take 45-60+
//   - the finished mp4 is several hundred MB, and streaming that back through
//     n8n as a single response buffers the whole file in the worker
//
// The existing POST /render is UNCHANGED and still used by the three live
// long-form channels. This is purely additive.
//
//   POST /render/async        {command}  -> 202 {job_id}
//   GET  /render/status/:id              -> {status, ...}
//   GET  /render/download/:id            -> streams the mp4, then cleans up
//   DELETE /render/job/:id               -> abandon and clean up
// ===========================================================================

const MAX_ASYNC_RENDER_MS = Number(process.env.MAX_ASYNC_RENDER_MS || 3 * 60 * 60 * 1000);
const MAX_CONCURRENT_ASYNC = Number(process.env.MAX_CONCURRENT_ASYNC || 2);
// How long a finished job is kept before its work directory is reclaimed.
// A render is a few hundred MB, so abandoned jobs must not accumulate.
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 6 * 60 * 60 * 1000);

const jobs = new Map();

function runningCount() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'running') n++;
  return n;
}

app.post('/render/async', (req, res) => {
  const { command } = req.body || {};
  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'missing command' });
  }
  if (runningCount() >= MAX_CONCURRENT_ASYNC) {
    return res.status(429).json({
      error: 'too many concurrent renders',
      running: runningCount(),
      limit: MAX_CONCURRENT_ASYNC,
    });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(TMP_ROOT, `arender-${id}`);
  fs.mkdirSync(workDir, { recursive: true });

  // Same substitution the sync path performs, so commands are interchangeable.
  const adjustedCommand = command.replace(/\/tmp\/n8n\/test/g, workDir);
  const scriptPath = path.join(workDir, 'render.sh');
  fs.writeFileSync(scriptPath, adjustedCommand, { mode: 0o755 });

  const job = {
    id,
    status: 'running',
    workDir,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    error: null,
    stdout: '',
    stderr: '',
    bytes: null,
  };
  jobs.set(id, job);

  console.log(`[async ${id}] starting in ${workDir}`);
  const child = spawn('bash', [scriptPath], { cwd: workDir });
  job.pid = child.pid;

  const appendBounded = (buf, chunk) => {
    const next = buf + chunk;
    if (next.length <= MAX_LOG_BYTES) return next;
    return next.slice(next.length - MAX_LOG_BYTES);
  };
  child.stdout.on('data', (d) => { job.stdout = appendBounded(job.stdout, d); });
  child.stderr.on('data', (d) => { job.stderr = appendBounded(job.stderr, d); });

  const timer = setTimeout(() => {
    console.error(`[async ${id}] timeout after ${MAX_ASYNC_RENDER_MS}ms — killing`);
    job.status = 'failed';
    job.error = 'render timeout';
    job.finishedAt = Date.now();
    child.kill('SIGKILL');
  }, MAX_ASYNC_RENDER_MS);

  child.on('error', (err) => {
    clearTimeout(timer);
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = Date.now();
    console.error(`[async ${id}] spawn error:`, err);
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (job.status === 'failed') return;   // already timed out
    job.exitCode = code;
    job.finishedAt = Date.now();

    if (code !== 0) {
      job.status = 'failed';
      job.error = 'render failed';
      console.error(`[async ${id}] exit ${code} in ${job.finishedAt - job.startedAt}ms`);
      return;
    }
    const outputPath = path.join(workDir, 'final_output.mp4');
    if (!fs.existsSync(outputPath)) {
      job.status = 'failed';
      job.error = 'output file not produced';
      job.expected = outputPath;
      return;
    }
    job.status = 'done';
    job.bytes = fs.statSync(outputPath).size;
    console.log(`[async ${id}] done in ${job.finishedAt - job.startedAt}ms, ${job.bytes} bytes`);
  });

  res.status(202).json({ job_id: id, status: 'running' });
});

app.get('/render/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json({
    job_id: job.id,
    status: job.status,                       // running | done | failed
    elapsed_ms: (job.finishedAt || Date.now()) - job.startedAt,
    exitCode: job.exitCode,
    error: job.error,
    bytes: job.bytes,
    // Logs are the only diagnostic once the work directory is gone.
    stderr: job.status === 'failed' ? tail(job.stderr) : undefined,
    stdout: job.status === 'failed' ? tail(job.stdout) : undefined,
  });
});

app.get('/render/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  if (job.status === 'running') return res.status(409).json({ error: 'still running' });
  if (job.status !== 'done') {
    return res.status(500).json({ error: job.error || 'render failed', stderr: tail(job.stderr) });
  }
  const outputPath = path.join(job.workDir, 'final_output.mp4');
  if (!fs.existsSync(outputPath)) {
    return res.status(410).json({ error: 'output already reclaimed' });
  }
  const stat = fs.statSync(outputPath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `attachment; filename="video-${job.id}.mp4"`);
  const stream = fs.createReadStream(outputPath);
  stream.on('close', () => {
    // Only reclaim once the bytes are actually delivered.
    cleanup(job.workDir);
    job.status = 'collected';
  });
  stream.on('error', (err) => console.error(`[async ${job.id}] stream error:`, err));
  stream.pipe(res);
});

app.delete('/render/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  cleanup(job.workDir);
  jobs.delete(req.params.id);
  res.json({ ok: true });
});

// Reclaim abandoned jobs. Without this a failed poller leaks a few hundred MB
// per run until the disk fills.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const age = now - (job.finishedAt || job.startedAt);
    if (job.status !== 'running' && age > JOB_TTL_MS) {
      cleanup(job.workDir);
      jobs.delete(id);
      console.log(`[async ${id}] reclaimed after ${Math.round(age / 60000)}m`);
    }
  }
}, 10 * 60 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ffmpeg-renderer listening on :${PORT} (auth=${SHARED_SECRET ? 'on' : 'OFF — internal only!'})`);
});
