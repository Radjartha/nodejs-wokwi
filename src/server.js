const path = require('node:path');
const express = require('express');
const router = require('./routes');

const app = express();

// CORS terbuka agar front-end (domain/port lain) bisa memanggil API.
// shortcut: izinkan semua origin; batasi ke domain front-end saat produksi.
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));   // dashboard (/) dan docs (/docs.html)
app.get('/docs', (req, res) => res.redirect('/docs.html'));
app.use('/api', router);

app.use('/api', (req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'endpoint tidak ditemukan' } }));

// Kode error stabil untuk front-end (pesan bisa berubah, code tidak)
const CODES = { 400: 'VALIDATION_ERROR', 404: 'NOT_FOUND', 409: 'CONFLICT', 503: 'MQTT_UNAVAILABLE' };

// Express 5 meneruskan error dari handler async ke sini
app.use((err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'body bukan JSON yang valid' } });
  }
  const code = CODES[status] ?? 'INTERNAL_ERROR';
  if (code === 'INTERNAL_ERROR') console.error(err);
  res.status(code === 'INTERNAL_ERROR' ? 500 : status)
    .json({ success: false, error: { code, message: code === 'INTERNAL_ERROR' ? 'internal server error' : err.message } });
});

const port = process.env.PORT || 3000;
// Express 5 mengirim error listen ke callback; harus dilempar agar proses berhenti
// (kalau tidak, proses ganda tetap subscribe MQTT dan data tersimpan dobel)
app.listen(port, (err) => {
  if (err) throw err;
  console.log(`Server jalan: http://localhost:${port}  (dashboard: /, docs: /docs)`);
});
