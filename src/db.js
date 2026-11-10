const { Pool, types } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum di-set (lihat .env.example)');

// BIGINT (id BIGSERIAL) dikirim pg sebagai string; ubah ke number agar front-end dapat angka.
// shortcut: aman sampai id 2^53 (~9 kuadriliun baris).
types.setTypeParser(types.builtins.INT8, Number);

module.exports = new Pool({ connectionString: process.env.DATABASE_URL });
