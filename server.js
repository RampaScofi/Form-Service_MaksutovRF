'use strict';

/**
 * Application entry point.
 * Exports { app, start } so tests can bind an ephemeral port and a temp data dir.
 */

const path = require('path');
const express = require('express');

const store = require('./store/json-store');
const adminRouter = require('./routes/admin');
const publicRouter = require('./routes/public');

const PUBLIC_DIR = path.join(__dirname, 'public');
const NOT_FOUND_PAGE = path.join(PUBLIC_DIR, 'index.html');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use('/static', express.static(PUBLIC_DIR, { index: false }));

app.get('/', (req, res) => res.redirect('/admin'));

app.use(adminRouter);
app.use(publicRouter);

// Anything else: readable 404 page.
app.use((req, res) => {
  res.status(404);
  if (req.path.startsWith('/api/')) {
    res.json({ error: 'Not found' });
    return;
  }
  res.sendFile(NOT_FOUND_PAGE, (err) => {
    if (err) res.send('404 Not found');
  });
});

// Single error handler: malformed body is a client error (400), never 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    res.status(400).json({ error: 'Malformed JSON body', errors: [] });
    return;
  }
  if (err && err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large', errors: [] });
    return;
  }
  console.error('[form-service] unhandled error:', err && err.message ? err.message : err);
  res.status(500).json({ error: 'Internal server error', errors: [] });
});

/**
 * Start the HTTP server. Port comes from PORT or defaults to 3000.
 * @param {number} [port]
 * @returns {import('http').Server}
 */
function start(port = Number(process.env.PORT) || 3000) {
  store.ensureDataDir();
  const server = app.listen(port, () => {
    console.log(`form-service listening on http://localhost:${server.address().port}`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
