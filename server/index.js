// Owner: Азамат. Entry point: serves web/ as static files and mounts /api.
import express from 'express';
import { openDatabase } from './db.js';
const db = openDatabase();
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockRouter } from './routes/mock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// TODO(Азамат): replace mock routes with real ones (routes/*.js) as they land.
app.use('/api', mockRouter);

app.use(express.static(path.join(root, 'web')));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`CQA running at http://localhost:${port}`));
