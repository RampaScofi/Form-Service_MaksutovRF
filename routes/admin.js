'use strict';

/**
 * Admin routes: HTML page plus forms/answers API.
 * There is no authorization — see README, local demo only.
 */

const path = require('path');
const express = require('express');

const store = require('../store/json-store');

const ADMIN_PAGE = path.join(__dirname, '..', 'public', 'admin.html');
const NOT_FOUND_PAGE = path.join(__dirname, '..', 'public', 'index.html');

const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;
const MAX_LABEL = 200;
const MAX_OPTION = 100;

const router = express.Router();

function badRequest(res, errors) {
  res.status(400).json({ error: 'Validation failed', errors });
}

function send404(res) {
  res.status(404);
  if (res.req.path.startsWith('/api/')) {
    res.json({ error: 'Form not found' });
    return;
  }
  res.sendFile(NOT_FOUND_PAGE, (err) => {
    if (err) res.send('404 Not found');
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the incoming form payload.
 * Returns { errors, values } — values holds only the keys present in the body.
 */
function validateFormPayload(body, { partial }) {
  const errors = [];
  const values = {};

  if (!isPlainObject(body)) {
    return { errors: [{ field: 'body', message: 'Ожидается JSON-объект' }], values };
  }

  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      errors.push({ field: 'name', message: 'Укажите название формы' });
    } else if (body.name.trim().length > MAX_NAME) {
      errors.push({ field: 'name', message: `Название не длиннее ${MAX_NAME} символов` });
    } else {
      values.name = body.name.trim();
    }
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      errors.push({ field: 'description', message: 'Описание должно быть текстом' });
    } else if (body.description.length > MAX_DESCRIPTION) {
      errors.push({ field: 'description', message: `Описание не длиннее ${MAX_DESCRIPTION} символов` });
    } else {
      values.description = body.description.trim();
    }
  }

  if (!partial || body.fields !== undefined) {
    if (!Array.isArray(body.fields)) {
      errors.push({ field: 'fields', message: 'Список полей должен быть массивом' });
    } else if (body.fields.length > store.MAX_FIELDS) {
      errors.push({ field: 'fields', message: `Полей не больше ${store.MAX_FIELDS}` });
    } else {
      body.fields.forEach((raw, index) => {
        const field = isPlainObject(raw) ? raw : {};
        const where = (name) => `fields[${index}].${name}`;

        if (!store.isSupportedType(field.type)) {
          errors.push({
            field: where('type'),
            message: `Поле ${index + 1}: тип должен быть одним из ${store.FIELD_TYPES.join(', ')}`,
          });
        }
        if (typeof field.label !== 'string' || !field.label.trim()) {
          errors.push({ field: where('label'), message: `Поле ${index + 1}: укажите название поля` });
        } else if (field.label.trim().length > MAX_LABEL) {
          errors.push({
            field: where('label'),
            message: `Поле ${index + 1}: название не длиннее ${MAX_LABEL} символов`,
          });
        }
        if (field.required !== undefined && typeof field.required !== 'boolean') {
          errors.push({ field: where('required'), message: `Поле ${index + 1}: обязательность — да или нет` });
        }
        if (field.fieldId !== undefined && typeof field.fieldId !== 'string') {
          errors.push({ field: where('fieldId'), message: `Поле ${index + 1}: неверный идентификатор поля` });
        }
        if (field.type === 'select') {
          if (!Array.isArray(field.options) || !field.options.length) {
            errors.push({
              field: where('options'),
              message: `Поле ${index + 1}: для выпадающего списка нужны варианты`,
            });
          } else if (field.options.length > store.MAX_OPTIONS) {
            errors.push({
              field: where('options'),
              message: `Поле ${index + 1}: вариантов не больше ${store.MAX_OPTIONS}`,
            });
          } else if (field.options.some((option) => typeof option !== 'string' || !option.trim())) {
            errors.push({ field: where('options'), message: `Поле ${index + 1}: пустой вариант не допускается` });
          } else if (field.options.some((option) => option.length > MAX_OPTION)) {
            errors.push({
              field: where('options'),
              message: `Поле ${index + 1}: вариант не длиннее ${MAX_OPTION} символов`,
            });
          }
        }
      });
      if (!errors.length) values.fields = body.fields;
    }
  }

  return { errors, values };
}

function publicFormView(form) {
  return {
    id: form.id,
    name: form.name,
    description: form.description,
    fields: form.fields || [],
    status: form.status,
    slug: form.slug || null,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
  };
}

// --- HTML -------------------------------------------------------------------

router.get('/admin', (req, res) => {
  res.sendFile(ADMIN_PAGE, (err) => {
    if (err) res.status(500).send('Admin page is missing');
  });
});

// --- Forms API --------------------------------------------------------------

router.get('/api/forms', (req, res) => {
  const list = store.getAllForms().map((form) => ({
    id: form.id,
    name: form.name,
    status: form.status,
    slug: form.slug || null,
    fieldsCount: Array.isArray(form.fields) ? form.fields.length : 0,
    answersCount: store.getAllAnswers(form.id).length,
    updatedAt: form.updatedAt,
  }));
  res.json(list);
});

router.get('/api/forms/:id', (req, res) => {
  const form = store.getFormById(req.params.id);
  if (!form) return send404(res);
  return res.status(200).json(publicFormView(form));
});

router.post('/api/forms', (req, res) => {
  const { errors, values } = validateFormPayload(req.body, { partial: false });
  if (errors.length) return badRequest(res, errors);
  const form = store.createForm({
    name: values.name,
    description: values.description || '',
    fields: values.fields || [],
  });
  return res.status(201).json(publicFormView(form));
});

router.put('/api/forms/:id', (req, res) => {
  const { errors, values } = validateFormPayload(req.body, { partial: true });
  if (errors.length) return badRequest(res, errors);
  const updated = store.updateForm(req.params.id, values);
  if (!updated) return send404(res);
  return res.status(200).json(publicFormView(updated));
});

router.put('/api/forms/:id/publish', (req, res) => {
  const form = store.getFormById(req.params.id);
  if (!form) return send404(res);
  const published = store.publishForm(form.id);
  return res.status(200).json({ id: published.id, slug: published.slug, status: published.status });
});

router.put('/api/forms/:id/unpublish', (req, res) => {
  const form = store.getFormById(req.params.id);
  if (!form) return send404(res);
  const draft = store.unpublishForm(form.id);
  return res.status(200).json({ id: draft.id, slug: draft.slug, status: draft.status });
});

router.delete('/api/forms/:id', (req, res) => {
  const deleted = store.deleteForm(req.params.id);
  if (!deleted) return send404(res);
  return res.status(200).json({ deleted: true, id: req.params.id });
});

// --- Answers API ------------------------------------------------------------

router.get('/api/forms/:id/answers', (req, res) => {
  const form = store.getFormById(req.params.id);
  if (!form) return send404(res);
  return res.status(200).json(store.getAllAnswers(form.id));
});

router.get('/api/forms/:id/answers/:answerId', (req, res) => {
  const form = store.getFormById(req.params.id);
  if (!form) return send404(res);
  const answer = store.getAnswerById(form.id, req.params.answerId);
  if (!answer) return res.status(404).json({ error: 'Answer not found' });
  return res.status(200).json(answer);
});

module.exports = router;
module.exports.validateFormPayload = validateFormPayload;
