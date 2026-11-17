# Fleet Intelligence — deployment DEV terisolasi

Branch integrasi Fleet DEV yang telah lulus E2E:

`dev/fleet-pr103-pr110-stabilization-20261117`

**Jangan gunakan `main` untuk deployment Fleet DEV.** Branch `main` adalah sumber Hostinger Fleet PROD dan sengaja tidak diubah dalam integrasi PR #103–#110.

## Menjalankan workflow GitHub

Buka **Actions → Deploy Fleet DEV — pinned integration branch → Run workflow**:

1. Pilih branch `dev/fleet-pr103-pr110-stabilization-20261117`, **bukan** `main`.
2. Pilih `validate-only` (default) untuk checkout commit persis yang dipilih, typecheck, test, build, dan pemeriksaan Docker. GitHub Actions juga menjalankan **smoke test sementara Docker Compose web→API** dengan konfigurasi sintetis (tanpa DB/Google/WA/Gojek/Finance asli), lalu menghapus container/network dan file konfigurasi uji. Pengujiannya membuktikan web/API HTTP 200, redirect API lokal 308 tanpa header HTTPS, dan autentikasi anonim HTTP 401. Tidak ada SSH, deploy ke VPS, atau perubahan server.
3. `stage-dev` hanya jika benar-benar ingin membuat/memperbarui **kandidat terpisah** di VPS; butuh konfigurasi staging yang disiapkan khusus.

Workflow versi branch DEV **menolak** eksekusi bila `github.ref` tidak cocok dengan branch integrasi tersebut, dan mencocokkan commit `github.sha` sampai ke checkout di VPS. File workflow pada branch `main` masih versi lama; jangan memilih `main` saat menjalankan workflow. Hanya workflow DEV branch ini yang memiliki pengaman tersebut.

## Lingkungan GitHub dan staging VPS

Environment GitHub Actions: `fleet-dev`. Secret yang diperlukan untuk mode `stage-dev`:

- `HOSTINGER_SSH_HOST`, `HOSTINGER_SSH_PORT`, `HOSTINGER_SSH_USER`
- `HOSTINGER_SSH_PRIVATE_KEY`, `HOSTINGER_SSH_KNOWN_HOSTS`
- `FLEET_DEV_DEPLOY_PATH` **harus** `/opt/fleet-intelligence-dev`

Checkout staging harus sudah tersedia di direktori tersebut, berasal dari repository `Travelintrips/Fleet-Intelligence`, serta mempunyai file privat `deploy/.env.dev`. Workflow **tidak** mengambil atau menyalin kredensial dari PROD maupun container canary yang sudah PASS.

Sebelum staging, workflow menolak koneksi DB yang tidak mengarah ke Supabase **CST-DEV** (`xssrfshdrtdfupgqwfdw`) atau tidak menggunakan PostgreSQL role baca-saja `fleet_dev_cst_inventory_reader`.

Mode `stage-dev` hanya memakai Docker Compose project `fleet-integration-stage` dan port loopback **127.0.0.1:18460**. `CENTRAL_FINANCE_WRITE_ENABLED=false`, `GOJEK_CONNECTOR_ENABLED=false`, dan `DISABLE_BACKGROUND_SCHEDULERS=true` dipaksakan oleh `deploy/docker-compose.dev.yml`. Tidak ada `--remove-orphans`. Pengujian sintetis sengaja memasang `GOJEK_CONNECTOR_ENABLED=true` di file contoh untuk memastikan override Compose tetap menonaktifkan endpoint handoff (HTTP 409), tanpa pernah mengirim data atau menggunakan kredensial nyata.

Container dan network staging memakai nama otomatis yang dibatasi oleh Compose project (tidak memakai `container_name` atau network global `cst-fleet-dev`). Dengan demikian, `stage-dev` tidak dapat mengambil alih container Fleet DEV lain akibat benturan nama. Pengecekan konfigurasi Compose dan tes regresi DEV memverifikasi batasan ini.

**Health check staging harus HTTP 200/200.** Karena API menerapkan HTTPS di belakang reverse proxy, probe `/api/healthz` pada port HTTP lokal tanpa header proxy akan mengembalikan redirect 308. Workflow meneruskan `X-Forwarded-Proto: https` hanya pada pemeriksaan API localhost dan memvalidasi kode HTTP **200 secara tepat** untuk `/healthz` (web) dan `/api/healthz` (API). Redirect 308 bukan bukti API siap.

**Workflow tidak melakukan cutover Nginx.** Public Fleet DEV tetap menggunakan rute yang sudah diverifikasi, dan tidak ada deploy ke Fleet PROD.

## Baseline yang wajib dipertahankan

- Fleet DEV Google Super Admin, kendaraan, dan Transactions: E2E GET **PASS**.
- Sumber resmi: 428 baris CSV, 425 unik tersimpan, 3 duplikat, tanpa impor ulang.
- Transaksi 413 driver aktif, 12 historis tetap tersimpan; biaya sewa tidak disebut pendapatan perjalanan.
- Tidak menulis jurnal, mengirim WhatsApp, mengubah scheduler, atau mengaktifkan worker Gojek PROD.
- Simpan konfigurasi Nginx rollback dan container DEV lama sampai pengujian pengganti selesai.

Jangan jalankan migrasi manual khusus DEV pada database yang sudah berisi transaksi hanya karena workflow atau checkout baru diperbarui. Migrasi `deploy/dev-only/002...` dan `003...` mempunyai prasyarat tabel kosong dan sudah diterapkan sebelum impor nyata.
