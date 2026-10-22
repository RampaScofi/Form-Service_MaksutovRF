'use strict';

/**
 * JSON-file storage with atomic writes.
 *
 * Layout:
 *   <dataDir>/forms.json           — array of forms
 *   <dataDir>/answers/<formId>.json — array of answers of one form
 *
 * Write path is always "temp file + rename", so a concurrent or interrupted
 * write never leaves a half-written file behind. A damaged or empty file is
 * read as an empty array instead of throwing, so the server keeps running.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const FORMS_FILE = 'forms.json';
const ANSWERS_DIR = 'answers';

const FIELD_TYPES = ['text_short', 'text_long', 'email', 'select'];
const MAX_FIELDS = 50;
const MAX_OPTIONS = 200;

let dataDir = DEFAULT_DATA_DIR;
let tmpCounter = 0;

// ---------------------------------------------------------------------------
// Paths and directories
// ---------------------------------------------------------------------------

function formsFile() {
  return path.join(dataDir, FORMS_FILE);
}

function answersDir() {
  return path.join(dataDir, ANSWERS_DIR);
}

function answersFile(formId) {
  return path.join(answersDir(), `${formId}.json`);
}

function ensureDataDir() {
  fs.mkdirSync(answersDir(), { recursive: true });
}

/** Point the store at another directory (used by tests). Creates it. */
function setDataDir(dir) {
  dataDir = path.resolve(dir);
  ensureDataDir();
  return dataDir;
}

function getDataDir() {
  return dataDir;
}

// ---------------------------------------------------------------------------
// Low level read/write
// ---------------------------------------------------------------------------

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/**
 * renameSync with a short retry loop. On Windows a concurrent reader can hold
 * the destination file for a moment (EBUSY/EPERM/EACCES).
 */
function renameWithRetry(from, to) {
  const delays = [0, 25, 50, 100, 200, 400];
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const retriable = ['EBUSY', 'EPERM', 'EACCES'].includes(err.code);
      if (!retriable || attempt >= delays.length - 1) {
        try {
          fs.unlinkSync(from);
        } catch (cleanupError) {
          console.error(`[store] cannot remove temp file ${from}: ${cleanupError.message}`);
        }
        throw err;
      }
      sleepSync(delays[attempt]);
    }
  }
}

/** Read a JSON array file. Missing, empty or damaged file yields []. */
function readArray(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[store] cannot read ${file}: ${err.message}`);
    }
    return [];
  }
  if (!raw || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error(`[store] ${file} is not an array, treated as empty`);
      return [];
    }
    return parsed;
  } catch (err) {
    console.error(`[store] ${file} is not valid JSON, treated as empty: ${err.message}`);
    return [];
  }
}

/** Write a JSON array atomically: temp file in the same dir, then rename. */
function writeArray(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  tmpCounter += 1;
  const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.${tmpCounter}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupError) {
      console.error(`[store] cannot remove temp file ${tmp}: ${cleanupError.message}`);
    }
    throw err;
  }
  // Legacy backup file from an older write strategy — no longer needed.
  const backup = `${file}.bak`;
  try {
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  } catch (err) {
    console.error(`[store] cannot remove backup ${backup}: ${err.message}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Identifiers and field helpers
// ---------------------------------------------------------------------------

function makeId() {
  return crypto.randomUUID();
}

/** 16 hex characters. */
function makeSlug() {
  return crypto.randomBytes(8).toString('hex');
}

function isSupportedType(type) {
  return FIELD_TYPES.includes(type);
}

/**
 * Bring incoming fields to the stored shape. Existing fieldId values are kept
 * so answers stay comparable after an edit; new fields get a uuid.
 */
function normalizeFields(fields) {
  const source = Array.isArray(fields) ? fields : [];
  return source.slice(0, MAX_FIELDS).map((raw) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const incomingId = typeof item.fieldId === 'string' ? item.fieldId.trim() : '';
    const field = {
      fieldId: incomingId || makeId(),
      type: isSupportedType(item.type) ? item.type : 'text_short',
      label: String(item.label === undefined || item.label === null ? '' : item.label).trim(),
      required: item.required === true,
    };
    if (field.type === 'select') {
      const options = Array.isArray(item.options) ? item.options : [];
      field.options = options
        .map((option) => String(option).trim())
        .filter((option) => option !== '')
        .slice(0, MAX_OPTIONS);
    }
    return field;
  });
}

// ---------------------------------------------------------------------------
// Forms CRUD
// ---------------------------------------------------------------------------

function getAllForms() {
  return readArray(formsFile());
}

function getFormById(id) {
  if (!id) return null;
  return getAllForms().find((form) => form.id === id) || null;
}

function getFormBySlug(slug) {
  if (!slug) return null;
  return getAllForms().find((form) => form.slug === slug) || null;
}

function createForm(input) {
  const source = input && typeof input === 'object' ? input : {};
  const now = new Date().toISOString();
  const form = {
    id: makeId(),
    name: String(source.name === undefined || source.name === null ? '' : source.name).trim(),
    description: String(
      source.description === undefined || source.description === null ? '' : source.description,
    ).trim(),
    fields: normalizeFields(source.fields),
    status: 'draft',
    slug: null,
    createdAt: now,
    updatedAt: now,
  };
  const forms = getAllForms();
  forms.push(form);
  writeArray(formsFile(), forms);
  return form;
}

/** Partial update of name/description/fields. Returns null when id is unknown. */
function updateForm(id, updates) {
  const source = updates && typeof updates === 'object' ? updates : {};
  const forms = getAllForms();
  const index = forms.findIndex((form) => form.id === id);
  if (index === -1) return null;
  const current = forms[index];
  const updated = {
    ...current,
    name: source.name === undefined ? current.name : String(source.name ?? '').trim(),
    description:
      source.description === undefined ? current.description : String(source.description ?? '').trim(),
    fields: source.fields === undefined ? normalizeFields(current.fields) : normalizeFields(source.fields),
    updatedAt: new Date().toISOString(),
  };
  forms[index] = updated;
  writeArray(formsFile(), forms);
  return updated;
}

/**
 * Mark a form as published. A slug is generated once and reused afterwards,
 * so republishing does not break already shared links.
 */
function publishForm(id, slug) {
  const forms = getAllForms();
  const index = forms.findIndex((form) => form.id === id);
  if (index === -1) return null;
  const current = forms[index];
  const existing = typeof current.slug === 'string' && current.slug ? current.slug : '';
  const requested = typeof slug === 'string' && slug.trim() ? slug.trim() : '';
  forms[index] = {
    ...current,
    slug: existing || requested || makeSlug(),
    status: 'published',
    updatedAt: new Date().toISOString(),
  };
  writeArray(formsFile(), forms);
  return forms[index];
}

/** Remove a form and its answers. Returns true when something was deleted. */
function deleteForm(id) {
  const forms = getAllForms();
  const rest = forms.filter((form) => form.id !== id);
  if (rest.length === forms.length) return false;
  writeArray(formsFile(), rest);
  try {
    if (fs.existsSync(answersFile(id))) fs.unlinkSync(answersFile(id));
  } catch (err) {
    console.error(`[store] cannot remove answers of ${id}: ${err.message}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function getAllAnswers(formId) {
  if (!formId) return [];
  return readArray(answersFile(formId));
}

function getAnswerById(formId, answerId) {
  if (!formId || !answerId) return null;
  return getAllAnswers(formId).find((answer) => answer.id === answerId) || null;
}

/** Append one answer. Read-modify-write is synchronous, so appends do not overlap. */
function createAnswer(formId, answer) {
  const source = answer && typeof answer === 'object' ? answer : {};
  const record = {
    id: typeof source.id === 'string' && source.id ? source.id : makeId(),
    formId,
    answers: Array.isArray(source.answers) ? source.answers : [],
    submittedAt:
      typeof source.submittedAt === 'string' && source.submittedAt
        ? source.submittedAt
        : new Date().toISOString(),
  };
  const answers = getAllAnswers(formId);
  answers.push(record);
  writeArray(answersFile(formId), answers);
  return record;
}

module.exports = {
  FIELD_TYPES,
  MAX_FIELDS,
  MAX_OPTIONS,
  setDataDir,
  getDataDir,
  ensureDataDir,
  readArray,
  writeArray,
  makeId,
  makeSlug,
  isSupportedType,
  normalizeFields,
  getAllForms,
  getFormById,
  getFormBySlug,
  createForm,
  updateForm,
  publishForm,
  deleteForm,
  getAllAnswers,
  getAnswerById,
  createAnswer,
};
