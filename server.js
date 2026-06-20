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
        `drawtext=text='${esc(line1)}':fontfile=$FONT:fontsize=78:fontcolor=yellow:bordercolor=black:borderw=5:x=(w-text_w)/2:y=h-text_h-150,` +
        `drawtext=text='${esc(line2)}':fontfile=$FONT:fontsize=78:fontcolor=yellow:bordercolor=black:borderw=5:x=(w-text_w)/2:y=h-text_h-50" ` +
        `-frames:v 1 -q:v 2 output.jpg`
      : `ffmpeg -y -loglevel error -i base.jpg ` +
        `-vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
        `drawtext=text='${esc(line1)}':fontfile=$FONT:fontsize=80:fontcolor=yellow:bordercolor=black:borderw=5:x=(w-text_w)/2:y=h-text_h-60" ` +
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ffmpeg-renderer listening on :${PORT} (auth=${SHARED_SECRET ? 'on' : 'OFF — internal only!'})`);
});
