-- Skema database Sistem Penyiraman Tanaman Otomatis
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,                -- contoh: 'esp32-01' (sama dengan DEVICE_ID di sketch.ino)
  name        TEXT NOT NULL,
  location    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Data sensor dari topik MQTT <prefix>/<device_id>/telemetry
CREATE TABLE IF NOT EXISTS readings (
  id             BIGSERIAL PRIMARY KEY,
  device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  soil_moisture  SMALLINT NOT NULL CHECK (soil_moisture BETWEEN 0 AND 100), -- %
  temperature    REAL,                                                     -- C, NULL jika DHT error
  air_humidity   REAL,                                                     -- %
  pump_on        BOOLEAN NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('AUTO', 'MANUAL')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS readings_device_time ON readings (device_id, created_at DESC);

-- Riwayat perintah yang dikirim ke topik MQTT <prefix>/<device_id>/cmd
CREATE TABLE IF NOT EXISTS commands (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command     TEXT NOT NULL CHECK (command IN ('MODE_AUTO', 'MODE_MANUAL')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
