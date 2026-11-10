/*
  Sistem Penyiraman Tanaman Otomatis dengan Monitoring Kelembaban dan Suhu
  TAHAP 2: sensor, aktuator, LCD, logika AUTO/MANUAL + WiFi/MQTT ke backend
    publish  : <MQTT_PREFIX>/<DEVICE_ID>/telemetry  (JSON tiap 2 detik)
    subscribe: <MQTT_PREFIX>/<DEVICE_ID>/cmd        ("MODE_AUTO" / "MODE_MANUAL")
  Board : ESP32 DevKit C (Wokwi)

  Pin (sesuai Tabel 3 laporan rancangan):
    DHT22 DATA       -> GPIO 15
    Potensiometer    -> GPIO 34 (ADC)  = pengganti sensor kelembaban tanah
    Tombol manual    -> GPIO 4  (INPUT_PULLUP, aktif LOW)
    Relay IN         -> GPIO 26 (relay -> LED = pompa)
    Servo PWM        -> GPIO 18 (katup air)
    Buzzer (+)       -> GPIO 25
    LCD I2C SDA/SCL  -> GPIO 21 / GPIO 22 (alamat 0x27)
*/

#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ESP32Servo.h>
#include "DHTesp.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>

// ===================== Jaringan / MQTT (EMQX Cloud Serverless) =====================
// MQTT_HOST: alamat deployment di halaman Overview EMQX Cloud (port TLS 8883).
// MQTT_USER/MQTT_PASS: dibuat di deployment -> Access Control -> Authentication.
// MQTT_PREFIX dan DEVICE_ID harus cocok dengan MQTT_TOPIC_PREFIX di .env dan id device di database.
const char* WIFI_SSID   = "Wokwi-GUEST";
const char* WIFI_PASS   = "";
const char* MQTT_HOST   = "-.emqxsl.com";   // hostname saja, tanpa mqtts:// dan port
const int   MQTT_PORT   = 8883;
const char* MQTT_USER   = "-";
const char* MQTT_PASS   = "-";
const char* MQTT_PREFIX = "siram-tanaman";
const char* DEVICE_ID   = "esp32-01";

// DigiCert Global Root CA, dipakai EMQX Serverless (sumber: docs.emqx.com, berlaku s.d. 2031)
const char* CA_CERT = R"EOF(
-----BEGIN CERTIFICATE-----
MIIDrzCCApegAwIBAgIQCDvgVpBCRrGhdWrJWZHHSjANBgkqhkiG9w0BAQUFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBD
QTAeFw0wNjExMTAwMDAwMDBaFw0zMTExMTAwMDAwMDBaMGExCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxGTAXBgNVBAsTEHd3dy5kaWdpY2VydC5j
b20xIDAeBgNVBAMTF0RpZ2lDZXJ0IEdsb2JhbCBSb290IENBMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4jvhEXLeqKTTo1eqUKKPC3eQyaKl7hLOllsB
CSDMAZOnTjC3U/dDxGkAV53ijSLdhwZAAIEJzs4bg7/fzTtxRuLWZscFs3YnFo97
nh6Vfe63SKMI2tavegw5BmV/Sl0fvBf4q77uKNd0f3p4mVmFaG5cIzJLv07A6Fpt
43C/dxC//AH2hdmoRBBYMql1GNXRor5H4idq9Joz+EkIYIvUX7Q6hL+hqkpMfT7P
T19sdl6gSzeRntwi5m3OFBqOasv+zbMUZBfHWymeMr/y7vrTC0LUq7dBMtoM1O/4
gdW7jVg/tRvoSSiicNoxBN33shbyTApOB6jtSj1etX+jkMOvJwIDAQABo2MwYTAO
BgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUA95QNVbR
TLtm8KPiGxvDl7I90VUwHwYDVR0jBBgwFoAUA95QNVbRTLtm8KPiGxvDl7I90VUw
DQYJKoZIhvcNAQEFBQADggEBAMucN6pIExIK+t1EnE9SsPTfrgT1eXkIoyQY/Esr
hMAtudXH/vTBH1jLuG2cenTnmCmrEbXjcKChzUyImZOMkXDiqw8cvpOp/2PV5Adg
06O/nVsJ8dWO41P0jmP6P6fbtGbfYmbW0W5BjfIttep3Sp+dWOIrWcBAI+0tKIJF
PnlUkiaY4IBIqDfv8NZ5YBberOgOzW6sRBc4L0na4UU+Krk2U886UAb3LujEV0ls
YSEY1QSteDwsOoBrp+uvFRTp2InBuThs4pFsiv9kuXclVzDAGySj4dzp30d8tbQk
CAUw7C29C79Fv1C5qfPrmAESrciIxpg0X40KPMbp1ZWVbd4=
-----END CERTIFICATE-----
)EOF";

// ===================== Pin =====================
const int PIN_DHT    = 15;
const int PIN_TANAH  = 34;
const int PIN_TOMBOL = 4;
const int PIN_RELAY  = 26;
const int PIN_SERVO  = 18;
const int PIN_BUZZER = 25;
const int PIN_SDA    = 21;
const int PIN_SCL    = 22;

// ===================== Parameter (boleh diubah saat pengujian) =====================
const int   BATAS_KERING = 30;      // % : di bawah ini pompa ON
const int   BATAS_BASAH  = 60;      // % : di atas/sama dengan ini pompa OFF
const float BATAS_SUHU   = 35.0;    // derajat C : di atas ini buzzer berbunyi
const unsigned long INTERVAL_SIKLUS = 2000;   // ms : siklus baca sensor
const unsigned long BATAS_MANUAL    = 30000;  // ms : batas waktu mode MANUAL
const unsigned long WAKTU_DEBOUNCE  = 50;     // ms
const int SERVO_BUKA  = 90;         // derajat : katup terbuka
const int SERVO_TUTUP = 0;          // derajat : katup tertutup

// Modul relay Wokwi (atribut default): IN = LOW -> COM tersambung ke NO (LED menyala).
// Jika LED ternyata menyala terbalik, tukar nilai dua konstanta ini.
const int RELAY_ON  = LOW;
const int RELAY_OFF = HIGH;

// ===================== Objek =====================
LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo katup;
DHTesp dht;
WiFiClientSecure wifiClient;
PubSubClient mqtt(wifiClient);
char topikTelemetry[64], topikCmd[64];

// ===================== Status =====================
int   tanahPersen  = 0;
float suhu         = 0;
float lembapUdara  = 0;
bool  dhtOk        = false;
bool  suhuTinggi   = false;
bool  pompaOn      = false;
bool  modeManual   = false;
unsigned long mulaiManual    = 0;
unsigned long terakhirSiklus = 0;

// ===================== Aktuator =====================
void setPompa(bool on) {
  pompaOn = on;
  digitalWrite(PIN_RELAY, on ? RELAY_ON : RELAY_OFF);
  katup.write(on ? SERVO_BUKA : SERVO_TUTUP);
}

// Buzzer berbunyi putus-putus (300 ms) selama suhu tinggi.
// Jika tone() bermasalah di versi core Anda, ganti dengan digitalWrite(PIN_BUZZER, bunyi).
void kelolaBuzzer() {
  static bool bunyi = false;
  static unsigned long tTerakhir = 0;
  if (!suhuTinggi) {
    if (bunyi) { noTone(PIN_BUZZER); bunyi = false; }
    return;
  }
  if (millis() - tTerakhir >= 300) {
    tTerakhir = millis();
    bunyi = !bunyi;
    if (bunyi) tone(PIN_BUZZER, 2000);
    else noTone(PIN_BUZZER);
  }
}

// ===================== Sensor =====================
void bacaSensor() {
  int adc = analogRead(PIN_TANAH);                       // 0..4095
  tanahPersen = constrain(map(adc, 0, 4095, 0, 100), 0, 100);

  TempAndHumidity d = dht.getTempAndHumidity();
  if (dht.getStatus() == DHTesp::ERROR_NONE) {
    suhu = d.temperature;
    lembapUdara = d.humidity;
    dhtOk = true;
  } else {
    dhtOk = false;
  }
  suhuTinggi = dhtOk && (suhu > BATAS_SUHU);
}

// ===================== Logika kontrol =====================
void kontrolOtomatis() {
  if (modeManual) {            // MANUAL: pompa & katup selalu ON
    setPompa(true);
    return;
  }
  // AUTO dengan histeresis: 30-59% -> status dipertahankan
  if (tanahPersen < BATAS_KERING)        setPompa(true);
  else if (tanahPersen >= BATAS_BASAH)   setPompa(false);
}

// ===================== Tampilan =====================
void tampilLCD() {
  char b[28], baris[17];

  snprintf(b, sizeof(b), "Tanah:%d%% H:%d%%", tanahPersen, (int)lembapUdara);
  snprintf(baris, sizeof(baris), "%-16s", b);
  lcd.setCursor(0, 0);
  lcd.print(baris);

  if (!dhtOk) {
    snprintf(b, sizeof(b), "DHT22 error");
  } else if (suhuTinggi) {
    snprintf(b, sizeof(b), "PANAS! P:%s %c", pompaOn ? "ON" : "OFF", modeManual ? 'M' : 'A');
  } else {
    snprintf(b, sizeof(b), "%.1fC P:%s %s", suhu, pompaOn ? "ON" : "OFF", modeManual ? "MANU" : "AUTO");
  }
  snprintf(baris, sizeof(baris), "%-16s", b);
  lcd.setCursor(0, 1);
  lcd.print(baris);
}

void cetakSerial() {
  Serial.printf("Tanah: %d%% | Suhu: %.1f C | Lembap udara: %.0f%% | Pompa: %s | Mode: %s\n",
                tanahPersen, suhu, lembapUdara,
                pompaOn ? "ON" : "OFF", modeManual ? "MANUAL" : "AUTO");
}

// ===================== Tombol manual =====================
void tanganiTombol() {
  static bool bacaTerakhir = HIGH;
  static bool stabil = HIGH;
  static unsigned long tUbah = 0;

  bool baca = digitalRead(PIN_TOMBOL);
  if (baca != bacaTerakhir) {
    tUbah = millis();
    bacaTerakhir = baca;
  }
  if ((millis() - tUbah) > WAKTU_DEBOUNCE && baca != stabil) {
    stabil = baca;
    if (stabil == LOW) {                       // tombol ditekan
      modeManual = !modeManual;
      if (modeManual) mulaiManual = millis();
      kontrolOtomatis();
      tampilLCD();
      Serial.println(modeManual ? ">> Mode MANUAL" : ">> Mode AUTO");
    }
  }
}

// Pengaman: mode MANUAL otomatis kembali ke AUTO setelah 30 detik
void cekBatasManual() {
  if (modeManual && (millis() - mulaiManual >= BATAS_MANUAL)) {
    modeManual = false;
    kontrolOtomatis();
    tampilLCD();
    Serial.println(">> Batas waktu MANUAL habis, kembali ke AUTO");
  }
}

// ===================== MQTT =====================
// Perintah dari backend/dashboard
void terimaPerintah(char* topic, byte* payload, unsigned int len) {
  String cmd;
  for (unsigned int i = 0; i < len; i++) cmd += (char)payload[i];
  if (cmd == "MODE_MANUAL") { modeManual = true; mulaiManual = millis(); }
  else if (cmd == "MODE_AUTO") modeManual = false;
  else return;
  kontrolOtomatis();
  tampilLCD();
  Serial.println(">> Perintah MQTT: " + cmd);
}

// Coba sambung ulang tiap 5 detik, logika lokal tetap jalan saat offline.
// Catatan: handshake TLS bisa memblok loop ~1-3 detik per percobaan.
void kelolaMqtt() {
  static unsigned long tCoba = 0;
  if (mqtt.connected()) { mqtt.loop(); return; }
  if (WiFi.status() != WL_CONNECTED || millis() - tCoba < 5000) return;
  tCoba = millis();
  String clientId = String(DEVICE_ID) + "-" + String((uint32_t)esp_random(), HEX);
  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
    mqtt.subscribe(topikCmd);
    Serial.println(">> MQTT terhubung");
  } else {
    char tlsErr[100] = "";
    wifiClient.lastError(tlsErr, sizeof(tlsErr));
    Serial.printf(">> MQTT gagal ke %s:%d, state=%d, tls=%s\n", MQTT_HOST, MQTT_PORT, mqtt.state(), tlsErr);
  }
}

void kirimTelemetry() {
  if (!mqtt.connected()) return;
  char json[160], t[12] = "null", h[12] = "null";
  if (dhtOk) { snprintf(t, sizeof(t), "%.1f", suhu); snprintf(h, sizeof(h), "%.1f", lembapUdara); }
  snprintf(json, sizeof(json),
           "{\"soil_moisture\":%d,\"temperature\":%s,\"air_humidity\":%s,\"pump_on\":%s,\"mode\":\"%s\"}",
           tanahPersen, t, h, pompaOn ? "true" : "false", modeManual ? "MANUAL" : "AUTO");
  mqtt.publish(topikTelemetry, json);
}

// ===================== setup & loop =====================
void setup() {
  Serial.begin(115200);

  pinMode(PIN_TOMBOL, INPUT_PULLUP);
  digitalWrite(PIN_RELAY, RELAY_OFF);          // pastikan pompa mati saat boot
  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  ESP32PWM::allocateTimer(0);
  katup.setPeriodHertz(50);
  katup.attach(PIN_SERVO, 500, 2400);
  katup.write(SERVO_TUTUP);

  dht.setup(PIN_DHT, DHTesp::DHT22);

  Wire.begin(PIN_SDA, PIN_SCL);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Siram Otomatis");
  lcd.setCursor(0, 1);
  lcd.print("Memulai...");
  delay(2000);                                  // DHT22 butuh jeda awal +/- 2 detik
  lcd.clear();

  snprintf(topikTelemetry, sizeof(topikTelemetry), "%s/%s/telemetry", MQTT_PREFIX, DEVICE_ID);
  snprintf(topikCmd, sizeof(topikCmd), "%s/%s/cmd", MQTT_PREFIX, DEVICE_ID);
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);          // channel 6 = koneksi cepat di Wokwi
  wifiClient.setCACert(CA_CERT);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(60);
  mqtt.setCallback(terimaPerintah);

  Serial.println("Sistem penyiraman tanaman otomatis - Tahap 2 (MQTT)");
}

void loop() {
  tanganiTombol();      // respons cepat terhadap tombol
  cekBatasManual();     // pengaman 30 detik
  kelolaBuzzer();       // alarm suhu tinggi (non-blocking)
  kelolaMqtt();         // koneksi & perintah MQTT (non-blocking)

  if (millis() - terakhirSiklus >= INTERVAL_SIKLUS) {
    terakhirSiklus = millis();
    bacaSensor();
    kontrolOtomatis();
    tampilLCD();
    cetakSerial();
    kirimTelemetry();
  }
}
