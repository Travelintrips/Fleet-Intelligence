# CST Gojek Export Bridge

Bridge ini menghilangkan langkah manual **download → cari file → upload ke CST Fleet**.

Alur:

1. Jalankan bridge pada mesin/VM connector yang memiliki tampilan desktop.
2. Browser Chromium dibuka ke `https://fleetpartner.gojek.com`.
3. User login dan menyelesaikan OTP/CAPTCHA secara normal.
4. User memakai tombol **Export/Download resmi** di Fleet Partner.
5. File ditangkap sebagai file sementara pada mesin connector.
6. Bridge POST isi CSV ke endpoint CST Fleet:
   `/api/logistics/fleet/gojek-connector/handoff`.
7. CST Fleet memproses data ke `gojek_raw_transactions` dan `fleet_transactions`.
8. File sementara langsung dihapus setelah handoff.

## Yang tidak dilakukan

- tidak menyimpan username/password Gojek;
- tidak mengisi OTP otomatis;
- tidak membypass CAPTCHA;
- tidak memakai stealth plugin;
- tidak mengubah user-agent untuk menghindari deteksi;
- tidak memakai proxy rotation;
- tidak memanggil private endpoint portal;
- tidak menghapus atau menyamarkan atribut automation.

Jika portal menolak automation, hentikan proses dan gunakan jalur export resmi/manual sampai izin/dukungan partner tersedia.

## Environment

```env
FLEET_BASE_URL=https://fleet.cstlogistic.co.id
GOJEK_FLEET_PORTAL_URL=https://fleetpartner.gojek.com
GOJEK_CONNECTOR_ALLOWED_HOST=fleetpartner.gojek.com
GOJEK_CONNECTOR_SHARED_SECRET=<same secret configured in Fleet production>
GOJEK_CONNECTOR_MAX_FILE_MB=10
```

## Install

```bash
cd connector/gojek-export-bridge
cp package.bridge.json package.json
npm install
npx playwright install chromium
npm start
```

Bridge sengaja berada di luar root npm workspace agar dependency Playwright tidak ikut ke build Hostinger Fleet.


## Hostinger production note

File manifest bridge sengaja bernama `package.bridge.json`, bukan `package.json`, agar Hostinger hanya mendeteksi aplikasi Fleet utama di root repository. Saat bridge dijalankan di mesin/VM connector, copy manifest ini menjadi `package.json` terlebih dahulu seperti contoh di atas.
