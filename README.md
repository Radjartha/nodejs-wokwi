# Backend Sistem Penyiraman Tanaman Otomatis

Express + PostgreSQL + MQTT untuk proyek ESP32 di folder `wokwi/`.

```
ESP32 (Wokwi) --publish telemetry--> MQTT broker --subscribe--> Backend --> PostgreSQL
ESP32 (Wokwi) <--------cmd---------- MQTT broker <--publish---- Backend <-- Front-end (REST API)
```

## Menjalankan

Butuh Node.js 20+ dan Docker Desktop (untuk PostgreSQL).

```bash
npm install
cp .env.example .env      # sesuaikan bila perlu
npm run db:up             # jalankan PostgreSQL (docker compose)
npm run db:migrate        # buat tabel (db/schema.sql)
npm run db:seed           # data contoh — MENGHAPUS semua data lama
npm run dev               # server + auto-reload, http://localhost:3000
```

| URL | Isi |
|-----|-----|
| http://localhost:3000/ | Dashboard preview (auto-refresh 5 detik) |
| http://localhost:3000/docs | Dokumentasi API (Swagger UI) |
| http://localhost:3000/openapi.json | Spesifikasi OpenAPI (bisa di-import ke Postman) |

Sudah punya PostgreSQL sendiri? Lewati `db:up`, cukup ubah `DATABASE_URL` di `.env`.

## Deploy ke server Linux (Docker)

`docker-compose.server.yml` hanya menjalankan API (port **8067**). PostgreSQL pakai milik sendiri.

1. Salin proyek ke server (tanpa `node_modules`).
2. Buat `.env` di server (lihat `.env.example`). Isi `DATABASE_URL` sesuai lokasi PostgreSQL:
   - PostgreSQL di host yang sama: `postgres://user:pass@host.docker.internal:5432/siram`.
     PostgreSQL harus menerima koneksi dari jaringan Docker. Set `listen_addresses` di `postgresql.conf`, lalu tambahkan `172.16.0.0/12` ke `pg_hba.conf`.
   - PostgreSQL di server lain: `postgres://user:pass@<ip-atau-domain>:5432/siram`.
3. Build, jalankan, lalu buat tabel (sekali saja):
   ```bash
   docker compose -f docker-compose.server.yml up -d --build
   docker compose -f docker-compose.server.yml run --rm api node db/migrate.js
   docker compose -f docker-compose.server.yml exec api node -e "fetch('http://127.0.0.1:8067/api/health').then(r=>r.text()).then(console.log)"
   ```
4. Daftarkan perangkat (tanpa seeder, karena seeder menghapus semua data):
   ```bash
   curl -X POST http://localhost:8067/api/devices -H 'Content-Type: application/json' -d '{"id":"esp32-01","name":"Kebun Depan"}'
   ```

Dashboard: `http://<server>:8067/`, docs: `http://<server>:8067/docs`.

Lihat log: `docker compose -f docker-compose.server.yml logs -f`. Update: `git pull` lalu ulangi `up -d --build`.

## MQTT

| Topik | Arah | Payload |
|-------|------|---------|
| `<prefix>/<device_id>/telemetry` | ESP32 → backend | `{"soil_moisture":42,"temperature":30.5,"air_humidity":65,"pump_on":false,"mode":"AUTO"}` (`temperature`/`air_humidity` = `null` jika DHT22 error) |
| `<prefix>/<device_id>/cmd` | backend → ESP32 | `MODE_AUTO` atau `MODE_MANUAL` |

### Setup EMQX Cloud Serverless

1. Buat deployment Serverless di https://cloud.emqx.com.
2. Halaman **Overview**: salin alamat deployment (`xxxxxxxx.ala.<region>.emqxsl.com`, port TLS `8883`).
3. **Access Control → Authentication**: buat 2 user, misalnya `backend` dan `esp32-01`.
4. Isi `.env`:
   ```
   MQTT_URL=mqtts://xxxxxxxx.ala.<region>.emqxsl.com:8883
   MQTT_USERNAME=backend
   MQTT_PASSWORD=...
   ```
5. Isi `MQTT_HOST`, `MQTT_USER`, `MQTT_PASS` di `wokwi/sketch.ino`. Sketch sudah memuat CA DigiCert Global Root (TLS wajib di Serverless).
6. Jalankan ulang server. Cek `GET /api/health` → `mqtt.connected: true`.

Catatan:
- Opsional, di **Access Control → Authorization**: batasi user `esp32-01` hanya ke `siram-tanaman/esp32-01/#`.
- Password ESP32 tertulis di `sketch.ino`. Jangan bagikan proyek Wokwi itu secara publik. Kalau bocor, ganti password di EMQX.
- Jalankan hanya **satu** instance backend. Tiap instance subscribe telemetry, jadi dua instance = data tersimpan dobel.
- `device_id` di sketch (`DEVICE_ID`) harus sudah terdaftar di tabel `devices` (seeder membuat `esp32-01`). Pesan dari device tak terdaftar atau payload tidak valid diabaikan.
- Library Wokwi ada di `wokwi/libraries.txt` (tambahan: `PubSubClient`).

## Format respons API

Semua endpoint di bawah `/api`.

```json
{ "success": true, "data": { ... }, "meta": { "page": 1, "limit": 50, "total": 145 } }
{ "success": false, "error": { "code": "NOT_FOUND", "message": "device 'x' tidak ditemukan" } }
```

- `meta` hanya ada di endpoint berhalaman.
- Semua `id` berupa angka (kecuali id perangkat, mis. `"esp32-01"`). Waktu dalam ISO 8601 UTC (`2026-11-10T01:06:19.482Z`).
- Cek error lewat `error.code` (stabil), bukan `message`:

| HTTP | `error.code` | Arti |
|------|--------------|------|
| 400 | `VALIDATION_ERROR` | Input/parameter salah |
| 400 | `INVALID_JSON` | Body bukan JSON valid |
| 404 | `NOT_FOUND` | Perangkat/endpoint tidak ada |
| 409 | `CONFLICT` | Perangkat sudah ada |
| 503 | `MQTT_UNAVAILABLE` | Backend tidak terhubung ke EMQX, perintah tidak terkirim |
| 500 | `INTERNAL_ERROR` | Error server |

Contoh `GET /api/devices/esp32-01`:

```json
{
  "success": true,
  "data": {
    "id": "esp32-01", "name": "Kebun Depan", "location": "Halaman depan",
    "created_at": "2026-11-09T23:51:33.366Z",
    "online": true,
    "last_seen": "2026-11-10T01:06:19.482Z",
    "latest": { "id": 375, "soil_moisture": 48, "temperature": 30, "air_humidity": 65, "pump_on": true, "mode": "AUTO", "created_at": "2026-11-10T01:06:19.482Z" }
  }
}
```

`online` = ada data dalam 10 detik terakhir. `latest` = `null` jika belum ada data.

| Method | Endpoint | Keterangan |
|--------|----------|------------|
| GET | `/api/health` | Status server, DB, MQTT |
| GET | `/api/devices` | Daftar perangkat + `online` + data sensor terakhir |
| POST | `/api/devices` | Tambah perangkat `{ id, name, location? }` |
| GET | `/api/devices/:id` | Detail perangkat + `online` + data sensor terakhir |
| GET | `/api/devices/:id/readings?limit=50&page=1` | Riwayat sensor (terbaru dulu) |
| GET | `/api/devices/:id/readings/latest` | Data sensor terakhir |
| GET | `/api/devices/:id/stream` | Realtime (SSE): `new EventSource(url).onmessage = (e) => JSON.parse(e.data)` |
| POST | `/api/devices/:id/readings` | Kirim data sensor via HTTP (uji tanpa ESP32) |
| GET | `/api/devices/:id/stats?hours=24` | Rata-rata / min / max, % waktu pompa ON |
| GET | `/api/devices/:id/commands` | Riwayat perintah |
| POST | `/api/devices/:id/commands` | `{ "command": "MODE_AUTO" \| "MODE_MANUAL" }` → dikirim ke ESP32 via MQTT |

Contoh dari front-end:

```js
const res = await fetch('http://localhost:3000/api/devices/esp32-01/readings/latest');
const { success, data, error } = await res.json();
```

CORS terbuka untuk semua origin. Batasi di `src/server.js` sebelum produksi.

## Struktur

```
db/schema.sql      tabel devices, readings, commands
db/migrate.js      jalankan schema.sql
db/seed.js         data contoh 24 jam untuk 1 perangkat
src/server.js      Express app, CORS, error handler
src/routes.js      endpoint REST
src/mqtt.js        subscribe telemetry -> DB, publish cmd
src/readings.js    validasi + simpan data sensor (dipakai MQTT & HTTP)
public/            dashboard (index.html), docs (docs.html), openapi.json
wokwi/             sketch ESP32 + diagram + libraries.txt
```
