'use strict';

/**
 * Public routes: the published form page and the submit endpoint.
 * Server-side validation is authoritative; the client check is only UX.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const store = require('../store/json-store');

const TEMPLATE = path.join(__dirname, '..', 'public', 'form.html');
const NOT_FOUND_PAGE = path.join(__dirname, '..', 'public', 'index.html');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NUMBER_RE = /^\d+([.,]\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_ALLOWED_RE = /^[+\d\s\-()]+$/;
const MAX_SHORT = 300;
const MAX_LONG = 5000;

const router = express.Router();

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Escape a JSON string for safe embedding inside a <script type="application/json">
 * block.  We only need to neutralise <, >, & (and U+2028/U+2029 for safety).
 * The double-quote is NOT escaped — the block is parsed by JSON.parse(),
 * and escaping quotes would break the JSON structure. User data is rendered
 * through textContent, so no XSS is possible.
 */
function escapeJsonForScript(value) {
  return String(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ---------------------------------------------------------------------------
// Server-side validation
// ---------------------------------------------------------------------------

function validateSubmission(form, answers) {
  const errors = [];
  const values = [];
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const answerMap = new Map();
  if (Array.isArray(answers)) {
    answers.forEach((item) => {
      if (item && typeof item === 'object' && item.fieldId) {
        answerMap.set(item.fieldId, item);
      }
    });
  }

  fields.forEach((field) => {
    const incoming = answerMap.get(field.fieldId);
    let rawValue = '';
    if (incoming && incoming.value !== undefined && incoming.value !== null) {
      rawValue = String(incoming.value);
    }
    const trimmed = rawValue.trim();
    values.push({ fieldId: field.fieldId, value: trimmed });

    if (field.required && !trimmed) {
      errors.push({ fieldId: field.fieldId, message: 'Поле обязательно для заполнения' });
      return;
    }

    if (!trimmed) return;

    if (field.type === 'email' && !EMAIL_RE.test(trimmed)) {
      errors.push({ fieldId: field.fieldId, message: 'Укажите корректный email' });
    }

    if (field.type === 'number' && !NUMBER_RE.test(trimmed)) {
      errors.push({ fieldId: field.fieldId, message: 'Укажите число' });
    }

    if (field.type === 'date') {
      if (!DATE_RE.test(trimmed)) {
        errors.push({ fieldId: field.fieldId, message: 'Укажите корректную дату' });
      } else {
        const [y, m, d] = trimmed.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
          errors.push({ fieldId: field.fieldId, message: 'Укажите корректную дату' });
        }
      }
    }

    if (field.type === 'phone') {
      if (!PHONE_ALLOWED_RE.test(trimmed)) {
        errors.push({ fieldId: field.fieldId, message: 'Укажите корректный номер телефона' });
      } else {
        const digitCount = (trimmed.match(/\d/g) || []).length;
        if (digitCount < 7 || digitCount > 15) {
          errors.push({ fieldId: field.fieldId, message: 'Укажите корректный номер телефона' });
        }
      }
    }

    if ((field.type === 'select' || field.type === 'radio') && !Array.isArray(field.options)) {
      errors.push({ fieldId: field.fieldId, message: 'Недопустимое значение' });
      return;
    }
    if ((field.type === 'select' || field.type === 'radio') && field.options && !field.options.includes(trimmed)) {
      errors.push({ fieldId: field.fieldId, message: 'Выберите значение из списка' });
    }

    if (field.type === 'checkbox_group') {
      if (!Array.isArray(field.options)) {
        errors.push({ fieldId: field.fieldId, message: 'Недопустимое значение' });
        return;
      }
      const parts = trimmed.split(', ');
      const seen = new Set();
      for (const part of parts) {
        if (!field.options.includes(part) || seen.has(part)) {
          errors.push({ fieldId: field.fieldId, message: 'Выберите значения из списка' });
          break;
        }
        seen.add(part);
      }
    }

    if (field.type === 'text_short' && trimmed.length > MAX_SHORT) {
      errors.push({ fieldId: field.fieldId, message: `Не более ${MAX_SHORT} символов` });
    }
    if (field.type === 'text_long' && trimmed.length > MAX_LONG) {
      errors.push({ fieldId: field.fieldId, message: `Не более ${MAX_LONG} символов` });
    }
  });

  return { errors, values };
}

// ---------------------------------------------------------------------------
// HTML template rendering
// ---------------------------------------------------------------------------

function renderFormHtml(form) {
  let template;
  try {
    template = fs.readFileSync(TEMPLATE, 'utf-8');
  } catch (err) {
    return null;
  }
  if (!template) return null;

  const schema = {
    id: form.id,
    slug: form.slug,
    name: form.name,
    description: form.description,
    fields: form.fields || [],
  };

  return template
    .replace(
      '<script id="form-schema" type="application/json">',
      `<script id="form-schema" type="application/json">`,
    )
    .replace('__FORM_SCHEMA_JSON__', escapeJsonForScript(JSON.stringify(schema)))
    .replace('__FORM_TITLE__', escapeHtml(form.name))
    .replace('__FORM_DESCRIPTION__', escapeHtml(form.description));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /f/:slug — published form page (or 404 for draft / unknown). */
router.get('/f/:slug', (req, res) => {
  const form = store.getFormBySlug(req.params.slug);
  if (!form || form.status !== 'published') {
    res.status(404).sendFile(NOT_FOUND_PAGE, (err) => {
      if (err) res.send('404 Not found');
    });
    return;
  }
  const html = renderFormHtml(form);
  if (!html) {
    res.status(500).send('Form template is missing');
    return;
  }
  res.type('text/html').send(html);
});

/**
 * POST /api/forms/:slug/submit
 * Body: { answers: [{fieldId, value}, ...] }
 */
router.post('/api/forms/:slug/submit', (req, res) => {
  const form = store.getFormBySlug(req.params.slug);
  if (!form || form.status !== 'published') {
    return res.status(404).json({ error: 'Form not found' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.answers)) {
    return res.status(400).json({
      error: 'Некорректный запрос',
      errors: [{ fieldId: '', message: 'Ожидается массив answers' }],
    });
  }

  const { errors, values } = validateSubmission(form, body.answers);
  if (errors.length) {
    return res.status(400).json({ error: 'Ошибки валидации', errors });
  }

  const answer = store.createAnswer(form.id, { answers: values });
  return res.status(201).json(answer);
});

module.exports = router;
