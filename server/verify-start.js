// Run explicitly: node server/verify-start.js
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'cqa-start-'));
const port = 32000 + Math.floor(Math.random() * 10000);
const child = spawn('npm', ['start'], { env: { ...process.env, PORT: String(port), CQA_DB_PATH: join(dir, 'test.db') }, stdio: 'pipe' });
let log = '';
child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
try {
  let ok = false;
  for (let i = 0; i < 70; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) { ok = true; break; } } catch {}
    if (child.exitCode !== null) break;
  }
  if (!ok) throw Error(log || 'Server did not start');
  console.log('npm start: health OK');
} finally { child.kill('SIGTERM'); await new Promise(r => child.once('close', r)); rmSync(dir, { recursive: true, force: true }); }
