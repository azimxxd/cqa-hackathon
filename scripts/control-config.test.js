import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, getChecklist, saveChecklist } from '../server/db.js';
import { submissionChecklist, controlModel } from './control-config.js';
import { resetRouter } from '../ai/router.js';

test('jury additions do not replace official control rules and an explicit custom version fails early', () => {
  const db = openDatabase(':memory:');
  try {
    const official = getChecklist(db, 1);
    const custom = saveChecklist(db, { ...official, criteria: [...official.criteria,
      { ...official.criteria[0], id: 'jury-new', title: 'Новое правило жюри' }] });
    assert.equal(submissionChecklist(db).id, 1);
    assert.throws(() => submissionChecklist(db, custom.id), /not compatible/);
    assert.throws(() => submissionChecklist(db, 'nope'), /Invalid/);
    assert.equal(getChecklist(db).id, custom.id, 'demo rules remain available');
  } finally { db.close(); }
});

test('control auto mode actually probes Ollama before choosing and pinning its model', async () => {
  const keys = ['LLM_PROVIDER', 'OLLAMA_MODEL', 'OLLAMA_URL', 'OLLAMA_ENDPOINT_FILE', 'CQA_FAKE_LLM'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const fetchBefore = globalThis.fetch;
  try {
    Object.assign(process.env, { LLM_PROVIDER: 'auto', OLLAMA_MODEL: 'qwen-control',
      OLLAMA_URL: 'http://ollama.example', OLLAMA_ENDPOINT_FILE: '', CQA_FAKE_LLM: '0' });
    resetRouter();
    let probes = 0;
    globalThis.fetch = async url => {
      assert.equal(url, 'http://ollama.example/api/tags'); probes++;
      return Response.json({ models: [{ name: 'qwen-control' }] });
    };
    assert.equal(await controlModel(), 'ollama/qwen-control');
    assert.equal(probes, 1);
  } finally {
    globalThis.fetch = fetchBefore;
    resetRouter();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
