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

app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!SHARED_SECRET) return next();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

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

  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

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
