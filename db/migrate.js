const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/db');

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  console.log('Migrasi selesai');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
