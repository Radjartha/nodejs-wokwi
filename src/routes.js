const express = require('express');
const pool = require('./db');
const { HttpError, deviceExists, saveReading, events } = require('./readings');
const mqtt = require('./mqtt');

const router = express.Router();

// Format respons seragam untuk front-end:
//   sukses -> { success: true, data, meta? }
//   gagal  -> { success: false, error: { code, message } }   (code: lihat server.js)
const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta && { meta }) });

const intParam = (v, def, min, max) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `parameter harus bilangan bulat ${min}-${max}`);
  return n;
};

router.get('/health', async (req, res) => {
  await pool.query('SELECT 1');
  ok(res, {
    status: 'ok',
    database: 'ok',
    mqtt: { connected: mqtt.client.connected, broker: mqtt.url, topic_prefix: mqtt.prefix },
    time: new Date().toISOString(),
  });
});

// ---------- Devices ----------
// Perangkat + status online + data sensor terakhir (latest = null jika belum ada data).
// ESP32 kirim tiap 2 detik; > 10 detik tanpa data = offline.
const DEVICE_SQL = `
  SELECT d.id, d.name, d.location, d.created_at,
    COALESCE(r.created_at > now() - interval '10 seconds', false) AS online,
    r.created_at AS last_seen,
    r.id AS r_id, r.soil_moisture, r.temperature, r.air_humidity, r.pump_on, r.mode
  FROM devices d
  LEFT JOIN LATERAL (SELECT * FROM readings WHERE device_id = d.id ORDER BY created_at DESC LIMIT 1) r ON true`;

const toDevice = ({ r_id, soil_moisture, temperature, air_humidity, pump_on, mode, ...d }) => ({
  ...d,
  latest: r_id == null ? null : { id: r_id, soil_moisture, temperature, air_humidity, pump_on, mode, created_at: d.last_seen },
});

router.get('/devices', async (req, res) => {
  const { rows } = await pool.query(`${DEVICE_SQL} ORDER BY d.id`);
  ok(res, rows.map(toDevice));
});

router.get('/devices/:id', async (req, res) => {
  const { rows } = await pool.query(`${DEVICE_SQL} WHERE d.id = $1`, [req.params.id]);
  if (!rows.length) throw new HttpError(404, `device '${req.params.id}' tidak ditemukan`);
  ok(res, toDevice(rows[0]));
});

router.post('/devices', async (req, res) => {
  const { id, name, location = null } = req.body ?? {};
  if (typeof id !== 'string' || !/^[\w-]{1,50}$/.test(id)) throw new HttpError(400, 'id wajib (huruf/angka/-/_, maks 50)');
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name wajib diisi');
  const { rows } = await pool.query(
    'INSERT INTO devices (id, name, location) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING *',
    [id, name.trim(), location],
  );
  if (!rows.length) throw new HttpError(409, `device '${id}' sudah ada`);
  ok(res, rows[0], 201);
});

// ---------- Readings ----------
router.get('/devices/:id/readings', async (req, res) => {
  const limit = intParam(req.query.limit, 50, 1, 1000);
  const page = intParam(req.query.page, 1, 1, 1e6);
  await deviceExists(req.params.id);
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    pool.query('SELECT * FROM readings WHERE device_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.params.id, limit, (page - 1) * limit]),
    pool.query('SELECT count(*)::int AS total FROM readings WHERE device_id = $1', [req.params.id]),
  ]);
  ok(res, rows, 200, { page, limit, total });
});

router.get('/devices/:id/readings/latest', async (req, res) => {
  await deviceExists(req.params.id);
  const { rows } = await pool.query('SELECT * FROM readings WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1', [req.params.id]);
  ok(res, rows[0] ?? null);
});

// Realtime (Server-Sent Events): tiap data baru dari ESP32 langsung dikirim.
// Front-end: new EventSource('/api/devices/esp32-01/stream').onmessage = (e) => JSON.parse(e.data)
router.get('/devices/:id/stream', async (req, res) => {
  await deviceExists(req.params.id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (r) => { if (r.device_id === req.params.id) res.write(`data: ${JSON.stringify(r)}\n\n`); };
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);   // jaga koneksi tetap hidup lewat proxy
  events.on('reading', send);
  req.on('close', () => { events.off('reading', send); clearInterval(ping); });
});

// Data utama masuk via MQTT; endpoint ini untuk uji manual tanpa ESP32
router.post('/devices/:id/readings', async (req, res) => {
  ok(res, await saveReading(req.params.id, req.body), 201);
});

router.get('/devices/:id/stats', async (req, res) => {
  const hours = intParam(req.query.hours, 24, 1, 720);
  await deviceExists(req.params.id);
  const { rows } = await pool.query(`
    SELECT count(*)::int AS count,
      round(avg(soil_moisture)::numeric, 1)::float AS soil_avg, min(soil_moisture) AS soil_min, max(soil_moisture) AS soil_max,
      round(avg(temperature)::numeric, 1)::float AS temp_avg, min(temperature) AS temp_min, max(temperature) AS temp_max,
      round(avg(air_humidity)::numeric, 1)::float AS humidity_avg,
      round(100.0 * avg(pump_on::int), 1)::float AS pump_on_percent
    FROM readings WHERE device_id = $1 AND created_at >= now() - make_interval(hours => $2)`,
  [req.params.id, hours]);
  ok(res, { hours, ...rows[0] });
});

// ---------- Commands (dikirim ke ESP32 via MQTT) ----------
router.post('/devices/:id/commands', async (req, res) => {
  const { command } = req.body ?? {};
  if (!['MODE_AUTO', 'MODE_MANUAL'].includes(command)) throw new HttpError(400, "command wajib 'MODE_AUTO' atau 'MODE_MANUAL'");
  await deviceExists(req.params.id);
  // cek dulu: saat offline mqtt.js mengantre pesan dan request akan menggantung
  if (!mqtt.client.connected) throw new HttpError(503, 'MQTT broker tidak terhubung, perintah tidak terkirim');
  await mqtt.publishCommand(req.params.id, command);
  const { rows } = await pool.query('INSERT INTO commands (device_id, command) VALUES ($1, $2) RETURNING *', [req.params.id, command]);
  ok(res, rows[0], 201);
});

router.get('/devices/:id/commands', async (req, res) => {
  const limit = intParam(req.query.limit, 20, 1, 200);
  await deviceExists(req.params.id);
  const { rows } = await pool.query('SELECT * FROM commands WHERE device_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
  ok(res, rows);
});

module.exports = router;
