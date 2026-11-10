const { EventEmitter } = require('node:events');
const pool = require('./db');

// Tiap data tersimpan dipancarkan ke sini -> diteruskan ke dashboard/front-end lewat SSE
const events = new EventEmitter().setMaxListeners(0);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function deviceExists(id) {
  const { rowCount } = await pool.query('SELECT 1 FROM devices WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, `device '${id}' tidak ditemukan`);
}

// Validasi + simpan satu data sensor. Dipakai oleh MQTT (telemetry) dan HTTP POST.
async function saveReading(deviceId, body) {
  const { soil_moisture, temperature = null, air_humidity = null, pump_on, mode } = body ?? {};
  if (!Number.isInteger(soil_moisture) || soil_moisture < 0 || soil_moisture > 100) throw new HttpError(400, 'soil_moisture wajib bilangan bulat 0-100');
  if (temperature !== null && !Number.isFinite(temperature)) throw new HttpError(400, 'temperature harus angka atau null');
  if (air_humidity !== null && !Number.isFinite(air_humidity)) throw new HttpError(400, 'air_humidity harus angka atau null');
  if (typeof pump_on !== 'boolean') throw new HttpError(400, 'pump_on wajib boolean');
  if (!['AUTO', 'MANUAL'].includes(mode)) throw new HttpError(400, "mode wajib 'AUTO' atau 'MANUAL'");
  await deviceExists(deviceId);
  const { rows } = await pool.query(
    `INSERT INTO readings (device_id, soil_moisture, temperature, air_humidity, pump_on, mode)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [deviceId, soil_moisture, temperature, air_humidity, pump_on, mode],
  );
  events.emit('reading', rows[0]);
  return rows[0];
}

module.exports = { HttpError, deviceExists, saveReading, events };
