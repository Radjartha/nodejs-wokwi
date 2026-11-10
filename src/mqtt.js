// Jembatan MQTT <-> PostgreSQL
//   ESP32  -> <prefix>/<deviceId>/telemetry  (JSON data sensor)  -> disimpan ke tabel readings
//   Server -> <prefix>/<deviceId>/cmd        ('MODE_AUTO' | 'MODE_MANUAL') -> diterima ESP32
const mqtt = require('mqtt');
const { saveReading } = require('./readings');

// EMQX Cloud Serverless: mqtts://<deployment>.emqxsl.com:8883 + username/password (TLS wajib).
// Sertifikat EMQX (DigiCert) sudah dipercaya Node.js, jadi tidak perlu file CA.
const url = process.env.MQTT_URL;
const prefix = process.env.MQTT_TOPIC_PREFIX || 'siram-tanaman';
if (!url) throw new Error('MQTT_URL belum di-set (lihat .env.example)');

const client = mqtt.connect(url, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId: `siram-backend-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 3000,
});

client.on('connect', () => {
  console.log(`MQTT terhubung ke ${url}, subscribe ${prefix}/+/telemetry`);
  client.subscribe(`${prefix}/+/telemetry`, { qos: 0 });
});
client.on('error', (e) => console.error('MQTT error:', e.message));

client.on('message', async (topic, payload) => {
  const deviceId = topic.split('/').at(-2);
  try {
    await saveReading(deviceId, JSON.parse(payload.toString()));
  } catch (e) {
    // payload rusak / device tak terdaftar -> abaikan, jangan crash
    console.warn(`MQTT abaikan pesan ${topic}: ${e.message}`);
  }
});

const publishCommand = (deviceId, command) => client.publishAsync(`${prefix}/${deviceId}/cmd`, command, { qos: 1 });

module.exports = { client, prefix, url, publishCommand };
