// Seeder contoh: 1 perangkat (sesuai ESP32 di Wokwi) + data sensor 24 jam terakhir (tiap 10 menit) + beberapa perintah.
// Meniru logika sketch.ino: pompa ON jika tanah < 30%, OFF jika >= 60% (histeresis).
// PERINGATAN: menghapus semua data lama (TRUNCATE).
const pool = require('../src/db');

const devices = [
  { id: 'esp32-01', name: 'Kebun Depan', location: 'Halaman depan' },
];

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE commands, readings, devices RESTART IDENTITY CASCADE');

    for (const d of devices) {
      await client.query('INSERT INTO devices (id, name, location) VALUES ($1, $2, $3)', [d.id, d.name, d.location]);

      let soil = 45, pump = false;
      const rows = [];
      for (let i = 144; i >= 0; i--) {
        const t = new Date(Date.now() - i * 10 * 60 * 1000);
        const hour = t.getHours() + t.getMinutes() / 60;
        // tanah mengering perlahan, naik cepat saat pompa ON
        soil = Math.max(0, Math.min(100, soil + (pump ? 6 : -1.2) + (Math.random() - 0.5)));
        if (soil < 30) pump = true; else if (soil >= 60) pump = false;
        const temp = 27 + 8 * Math.sin(((hour - 8) / 24) * 2 * Math.PI) + Math.random();
        const hum = 75 - (temp - 27) * 2 + Math.random() * 3;
        const mode = i % 50 === 0 ? 'MANUAL' : 'AUTO';
        rows.push([d.id, Math.round(soil), +temp.toFixed(1), +hum.toFixed(1), pump || mode === 'MANUAL', mode, t]);
      }
      // satu INSERT multi-row per perangkat
      const values = rows.map((_, r) => `(${[1, 2, 3, 4, 5, 6, 7].map((c) => `$${r * 7 + c}`).join(',')})`).join(',');
      await client.query(
        `INSERT INTO readings (device_id, soil_moisture, temperature, air_humidity, pump_on, mode, created_at) VALUES ${values}`,
        rows.flat(),
      );
    }

    await client.query(
      `INSERT INTO commands (device_id, command, created_at) VALUES
        ('esp32-01', 'MODE_MANUAL', now() - interval '2 hours'),
        ('esp32-01', 'MODE_AUTO',   now() - interval '1 hour')`,
    );

    await client.query('COMMIT');
    console.log(`Seed selesai: ${devices.length} perangkat, ${devices.length * 145} data sensor, 2 perintah`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
