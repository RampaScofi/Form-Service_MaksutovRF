'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Temp data dir — never touches the real data/ directory
// ---------------------------------------------------------------------------

const tmpId = crypto.randomUUID();
const tmpDir = path.join(os.tmpdir(), `form-service-test-${tmpId}`);

// Set the store to the temp dir BEFORE requiring the app.
const store = require('../store/json-store');
store.setDataDir(tmpDir);

const { app } = require('../server');

let server;
let baseUrl;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(method, urlPath, body, rawBody) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {},
    };
    if (body !== undefined) {
      const payload = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    } else if (rawBody !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(rawBody);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, data: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    else if (rawBody !== undefined) req.write(rawBody);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

before(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Store unit tests
// ---------------------------------------------------------------------------

describe('json-store', () => {
  test('createForm → 201, id, status draft, slug null', () => {
    const form = store.createForm({
      name: 'Unit Test Form',
      description: 'desc',
      fields: [{ type: 'text_short', label: 'Name', required: true }],
    });
    assert.ok(form.id);
    assert.strictEqual(form.name, 'Unit Test Form');
    assert.strictEqual(form.status, 'draft');
    assert.strictEqual(form.slug, null);
    assert.strictEqual(form.fields.length, 1);
    assert.ok(form.fields[0].fieldId);
  });

  test('publishForm → slug 16 hex', () => {
    const form = store.createForm({ name: 'Pub Test', fields: [] });
    const pub = store.publishForm(form.id);
    assert.strictEqual(pub.status, 'published');
    assert.match(pub.slug, /^[0-9a-f]{16}$/);
  });

  test('publishForm idempotent — slug stays the same', () => {
    const form = store.createForm({ name: 'Idem', fields: [] });
    const p1 = store.publishForm(form.id);
    const p2 = store.publishForm(form.id);
    assert.strictEqual(p1.slug, p2.slug);
  });

  test('createAnswer + getAnswerById', () => {
    const form = store.createForm({ name: 'Ans Test', fields: [] });
    const ans = store.createAnswer(form.id, { answers: [{ fieldId: 'x', value: 'y' }] });
    assert.strictEqual(ans.formId, form.id);
    assert.strictEqual(ans.answers[0].value, 'y');
    const got = store.getAnswerById(form.id, ans.id);
    assert.strictEqual(got.id, ans.id);
  });

  test('getFormById unknown → null', () => {
    assert.strictEqual(store.getFormById('no-such-id'), null);
  });

  test('getAllForms returns array', () => {
    const forms = store.getAllForms();
    assert.ok(Array.isArray(forms));
  });

  test('updateForm partial', () => {
    const form = store.createForm({ name: 'Before', description: 'old', fields: [] });
    const upd = store.updateForm(form.id, { name: 'After' });
    assert.strictEqual(upd.name, 'After');
    assert.strictEqual(upd.description, 'old');
  });

  test('deleteForm removes form and answers', () => {
    const form = store.createForm({ name: 'Del', fields: [] });
    store.createAnswer(form.id, { answers: [] });
    assert.strictEqual(store.deleteForm(form.id), true);
    assert.strictEqual(store.getFormById(form.id), null);
    assert.strictEqual(store.getAllAnswers(form.id).length, 0);
  });

  test('damaged JSON file → empty array, no throw', () => {
    const file = path.join(tmpDir, 'forms.json');
    fs.writeFileSync(file, '{ broken json', 'utf-8');
    const forms = store.getAllForms();
    assert.ok(Array.isArray(forms));
    assert.strictEqual(forms.length, 0);
  });

  test('empty file → empty array', () => {
    const file = path.join(tmpDir, 'forms.json');
    fs.writeFileSync(file, '', 'utf-8');
    assert.deepStrictEqual(store.getAllForms(), []);
  });

  test('atomic write: no .tmp files left', () => {
    store.createForm({ name: 'Tmp check', fields: [] });
    const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    assert.strictEqual(tmpFiles.length, 0);
  });

  test('.bak file removed after write', () => {
    const file = path.join(tmpDir, 'forms.json');
    const bak = `${file}.bak`;
    fs.writeFileSync(bak, '[]', 'utf-8');
    store.createForm({ name: 'Bak test', fields: [] });
    assert.strictEqual(fs.existsSync(bak), false);
  });

  test('concurrent createAnswer — no lost records', () => {
    const form = store.createForm({ name: 'Concurrent', fields: [] });
    const promises = Array.from({ length: 5 }, (_, i) =>
      Promise.resolve().then(() => store.createAnswer(form.id, { answers: [{ fieldId: 'f', value: String(i) }] })),
    );
    return Promise.all(promises).then(() => {
      const answers = store.getAllAnswers(form.id);
      assert.strictEqual(answers.length, 5);
    });
  });
});

// ---------------------------------------------------------------------------
// Route integration tests
// ---------------------------------------------------------------------------

describe('routes', () => {
  test('GET /admin → 200 HTML', async () => {
    const res = await request('GET', '/admin');
    assert.strictEqual(res.status, 200);
    assert.ok(res.raw.includes('Админка'), 'admin HTML contains title');
  });

  test('POST /api/forms → 201', async () => {
    const res = await request('POST', '/api/forms', {
      name: 'Route Test',
      description: 'test desc',
      fields: [{ type: 'text_short', label: 'Name', required: true }],
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.data.id);
    assert.strictEqual(res.data.status, 'draft');
    assert.strictEqual(res.data.slug, null);
  });

  test('PUT /api/forms/:id → 200', async () => {
    const form = store.createForm({ name: 'Update Route', fields: [] });
    const res = await request('PUT', `/api/forms/${form.id}`, { name: 'Updated Name' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.name, 'Updated Name');
  });

  test('PUT /api/forms/:id/publish → 200 with slug', async () => {
    const form = store.createForm({ name: 'Publish Route', fields: [] });
    const res = await request('PUT', `/api/forms/${form.id}/publish`);
    assert.strictEqual(res.status, 200);
    assert.match(res.data.slug, /^[0-9a-f]{16}$/);
    assert.strictEqual(res.data.status, 'published');
  });

  test('GET /api/forms → 200 list', async () => {
    const res = await request('GET', '/api/forms');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data));
  });

  test('GET /f/:slug draft → 404', async () => {
    const form = store.createForm({ name: 'Draft Only', fields: [] });
    const res = await request('GET', `/f/${form.slug}`);
    assert.strictEqual(res.status, 404);
  });

  test('GET /f/:slug unknown → 404', async () => {
    const res = await request('GET', '/f/nonexist1234567890');
    assert.strictEqual(res.status, 404);
  });

  test('GET /f/:slug published → 200 HTML', async () => {
    const form = store.createForm({ name: 'Public Form', fields: [{ type: 'text_short', label: 'Name', required: true, fieldId: 'name-field' }] });
    const pub = store.publishForm(form.id);
    const res = await request('GET', `/f/${pub.slug}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.raw.includes('name-field'), 'fieldId in HTML');
    assert.ok(res.raw.includes('Public Form'), 'form name in HTML');
  });

  test('POST submit valid → 201', async () => {
    const form = store.createForm({
      name: 'Submit Test',
      fields: [{ type: 'text_short', label: 'Q1', required: true, fieldId: 'q1' }],
    });
    const pub = store.publishForm(form.id);
    const res = await request('POST', `/api/forms/${pub.slug}/submit`, {
      answers: [{ fieldId: 'q1', value: 'hello' }],
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.answers[0].value, 'hello');
    assert.ok(res.data.submittedAt);
  });

  test('POST submit required empty → 400', async () => {
    const form = store.createForm({
      name: 'Required Test',
      fields: [{ type: 'text_short', label: 'Q1', required: true, fieldId: 'q1' }],
    });
    const pub = store.publishForm(form.id);
    const res = await request('POST', `/api/forms/${pub.slug}/submit`, {
      answers: [{ fieldId: 'q1', value: '' }],
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.data.errors.length > 0);
    assert.strictEqual(res.data.errors[0].fieldId, 'q1');
  });

  test('POST submit bad email → 400', async () => {
    const form = store.createForm({
      name: 'Email Test',
      fields: [{ type: 'email', label: 'Email', required: true, fieldId: 'em' }],
    });
    const pub = store.publishForm(form.id);
    const res = await request('POST', `/api/forms/${pub.slug}/submit`, {
      answers: [{ fieldId: 'em', value: 'not-an-email' }],
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.errors[0].fieldId, 'em');
  });

  test('POST submit select value not in options → 400', async () => {
    const form = store.createForm({
      name: 'Select Test',
      fields: [{ type: 'select', label: 'Pick', required: true, fieldId: 'sel', options: ['A', 'B'] }],
    });
    const pub = store.publishForm(form.id);
    const res = await request('POST', `/api/forms/${pub.slug}/submit`, {
      answers: [{ fieldId: 'sel', value: 'C' }],
    });
    assert.strictEqual(res.status, 400);
  });

  test('POST submit select valid → 201', async () => {
    const form = store.createForm({
      name: 'Select Valid',
      fields: [{ type: 'select', label: 'Pick', required: true, fieldId: 'sel', options: ['A', 'B'] }],
    });
    const pub = store.publishForm(form.id);
    const res = await request('POST', `/api/forms/${pub.slug}/submit`, {
      answers: [{ fieldId: 'sel', value: 'A' }],
    });
    assert.strictEqual(res.status, 201);
  });

  test('POST submit malformed JSON → 400, not 500', async () => {
    const form = store.createForm({ name: 'Malformed', fields: [] });
    const pub = store.publishForm(form.id);
    const res = await request('POST', `/api/forms/${pub.slug}/submit`, undefined, '{ broken');
    assert.strictEqual(res.status, 400);
  });

  test('POST /api/forms malformed JSON → 400', async () => {
    const res = await request('POST', '/api/forms', undefined, '{ broken');
    assert.strictEqual(res.status, 400);
  });

  test('GET /api/forms/:id/answers → 200', async () => {
    const form = store.createForm({ name: 'Answers List', fields: [] });
    store.createAnswer(form.id, { answers: [{ fieldId: 'x', value: 'v' }] });
    const res = await request('GET', `/api/forms/${form.id}/answers`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.length, 1);
  });

  test('GET /api/forms/:id/answers/:aid → 200', async () => {
    const form = store.createForm({ name: 'Single Answer', fields: [] });
    const ans = store.createAnswer(form.id, { answers: [] });
    const res = await request('GET', `/api/forms/${form.id}/answers/${ans.id}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.id, ans.id);
  });

  test('GET /api/forms/:id/answers/:aid unknown → 404', async () => {
    const form = store.createForm({ name: 'No Answer', fields: [] });
    const res = await request('GET', `/api/forms/${form.id}/answers/nonexist`);
    assert.strictEqual(res.status, 404);
  });

  test('XSS: user input escaped in HTML', async () => {
    const xss = '<script>alert(1)</script>';
    const form = store.createForm({
      name: xss,
      fields: [{ type: 'text_short', label: xss, required: false, fieldId: 'xss-f' }],
    });
    const pub = store.publishForm(form.id);
    const res = await request('GET', `/f/${pub.slug}`);
    assert.strictEqual(res.status, 200);
    assert.ok(!res.raw.includes('<script>alert(1)</script>'), 'no raw script tag in HTML');
    assert.ok(res.raw.includes('\u003c'), 'escaped < present');
  });

  test('POST submit concurrent: 2 parallel → no lost answers', async () => {
    const form = store.createForm({
      name: 'Concurrent Submit',
      fields: [{ type: 'text_short', label: 'Q', required: true, fieldId: 'cq' }],
    });
    const pub = store.publishForm(form.id);
    const p1 = request('POST', `/api/forms/${pub.slug}/submit`, { answers: [{ fieldId: 'cq', value: 'a' }] });
    const p2 = request('POST', `/api/forms/${pub.slug}/submit`, { answers: [{ fieldId: 'cq', value: 'b' }] });
    await Promise.all([p1, p2]);
    const answers = store.getAllAnswers(form.id);
    assert.strictEqual(answers.length, 2);
  });

  test('POST /api/forms empty name → 400', async () => {
    const res = await request('POST', '/api/forms', { name: '', fields: [] });
    assert.strictEqual(res.status, 400);
  });

  test('DELETE /api/forms/:id → 200', async () => {
    const form = store.createForm({ name: 'Delete Route', fields: [] });
    const res = await request('DELETE', `/api/forms/${form.id}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(store.getFormById(form.id), null);
  });

  // P0-1: GET /api/forms/:id → 200
  test('GET /api/forms/:id → 200', async () => {
    const form = store.createForm({
      name: 'GetById Test',
      description: 'desc',
      fields: [{ type: 'text_short', label: 'Q', required: true, fieldId: 'q1' }],
    });
    const res = await request('GET', `/api/forms/${form.id}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.id, form.id);
    assert.strictEqual(res.data.name, 'GetById Test');
    assert.strictEqual(res.data.description, 'desc');
    assert.strictEqual(res.data.fields.length, 1);
    assert.strictEqual(res.data.fields[0].fieldId, 'q1');
    assert.strictEqual(res.data.status, 'draft');
    assert.strictEqual(res.data.slug, null);
    assert.ok(res.data.createdAt);
    assert.ok(res.data.updatedAt);
  });

  // P0-1: GET /api/forms/:id unknown → 404
  test('GET /api/forms/:id unknown → 404', async () => {
    const res = await request('GET', '/api/forms/nonexistent-id-12345');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.data.error, 'Form not found');
  });

  // P1-6: unpublishForm store method
  test('unpublishForm → status draft, slug preserved', () => {
    const form = store.createForm({ name: 'Unpub Test', fields: [] });
    const pub = store.publishForm(form.id);
    assert.strictEqual(pub.status, 'published');
    const slug = pub.slug;
    const unpub = store.unpublishForm(form.id);
    assert.strictEqual(unpub.status, 'draft');
    assert.strictEqual(unpub.slug, slug);
    assert.ok(unpub.updatedAt);
  });

  // P1-6: PUT /api/forms/:id/unpublish → 200
  test('PUT /api/forms/:id/unpublish → 200', async () => {
    const form = store.createForm({ name: 'Unpub Route', fields: [] });
    store.publishForm(form.id);
    const res = await request('PUT', `/api/forms/${form.id}/unpublish`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'draft');
    assert.ok(res.data.slug);
  });

  // P0-2: HTML публичной формы содержит type="submit" кнопку
  test('HTML публичной формы содержит button type="submit"', async () => {
    const form = store.createForm({
      name: 'Submit Button Test',
      fields: [{ type: 'text_short', label: 'Q', required: true, fieldId: 'f1' }],
    });
    const pub = store.publishForm(form.id);
    const res = await request('GET', `/f/${pub.slug}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.raw.includes('type="submit"'), 'HTML contains submit button');
    assert.ok(res.raw.includes('Отправить заявку'), 'Button text present');
  });

  // P0-2: Публичная схема содержит slug
  test('Публичная схема содержит slug', async () => {
    const form = store.createForm({
      name: 'Slug Schema Test',
      fields: [],
    });
    const pub = store.publishForm(form.id);
    const res = await request('GET', `/f/${pub.slug}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.raw.includes(`"slug":"${pub.slug}"`), 'slug in form schema');
  });

  // Data persistence: create form, reload, verify data not lost
  test('Данные сохраняются после перезагрузки store', () => {
    const form = store.createForm({
      name: 'Persist Test',
      description: 'persist desc',
      fields: [{ type: 'email', label: 'Email', required: false, fieldId: 'em1' }],
    });
    store.createAnswer(form.id, { answers: [{ fieldId: 'em1', value: 'test@example.com' }] });
    // Simulate reload: read from file again
    const reloaded = store.getFormById(form.id);
    assert.strictEqual(reloaded.name, 'Persist Test');
    assert.strictEqual(reloaded.description, 'persist desc');
    assert.strictEqual(reloaded.fields.length, 1);
    assert.strictEqual(reloaded.fields[0].fieldId, 'em1');
    const answers = store.getAllAnswers(form.id);
    assert.strictEqual(answers.length, 1);
    assert.strictEqual(answers[0].answers[0].value, 'test@example.com');
  });
});
