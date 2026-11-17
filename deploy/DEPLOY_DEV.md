# Fleet Intelligence — deployment DEV terisolasi

Branch integrasi Fleet DEV yang telah lulus E2E:

`dev/fleet-pr103-pr110-stabilization-20261117`

**Jangan gunakan `main` untuk deployment Fleet DEV.** Branch `main` adalah sumber Hostinger Fleet PROD dan sengaja tidak diubah dalam integrasi PR #103–#110.

## Menjalankan workflow GitHub

Buka **Actions → Deploy Fleet DEV — pinned integration branch → Run workflow**:

1. Pilih branch `dev/fleet-pr103-pr110-stabilization-20261117`, **bukan** `main`.
2. Pilih `validate-only` (default) untuk checkout commit persis yang dipilih, typecheck, test, build, dan pemeriksaan Docker. GitHub Actions juga menjalankan **smoke test sementara Docker Compose web→API** dengan konfigurasi sintetis (tanpa DB/Google/WA/Gojek/Finance asli), lalu menghapus container/network dan file konfigurasi uji. Pengujiannya membuktikan web/API HTTP 200, redirect API lokal 308 tanpa header HTTPS, dan autentikasi anonim HTTP 401. Tidak ada SSH, deploy ke VPS, atau perubahan server.
3. `stage-dev` hanya jika benar-benar ingin membuat/memperbarui **kandidat terpisah** di VPS; butuh konfigurasi staging yang disiapkan khusus.

Selain uji sintetis, `validate-only` menjalankan pemeriksaan **GET publik tanpa cookie** terhadap `https://dev-fleet.cstlogistic.co.id`: status Google DEV-only, OAuth redirect Supabase CST-DEV tanpa mengikuti redirect, halaman Vehicles/Transactions HTTP 200, dan API anonim HTTP 401. Pemeriksaan tidak mengirim POST atau menggunakan token dan **tidak mengklaim akses Google Super Admin dengan sesi nyata telah PASS**.

Workflow versi branch DEV **menolak** eksekusi bila `github.ref` tidak cocok dengan branch integrasi tersebut, dan mencocokkan commit `github.sha` sampai ke checkout di VPS. File workflow pada branch `main` masih versi lama; jangan memilih `main` saat menjalankan workflow. Hanya workflow DEV branch ini yang memiliki pengaman tersebut.

## Lingkungan GitHub dan staging VPS

Environment GitHub Actions: `fleet-dev`. Secret yang diperlukan untuk mode `stage-dev`:

**Pengaman baru:** `validate-only` menguji preflight konfigurasi staging secara offline (17 kasus sintetis). Sebelum memulai Docker, `stage-dev` menjalankan `deploy/dev-only/check-stage-config.py` dan menolak konfigurasi nonprivat, target database salah, koneksi tidak terenkripsi, writer aktif, atau otorisasi Google yang tidak lengkap. Tidak mencetak kredensial. Ikuti [checklist staging berwenang](dev-only/STAGE_CONFIG_CHECKLIST.md); preflight bukan bukti login Google asli sudah PASS.

- `HOSTINGER_SSH_HOST`, `HOSTINGER_SSH_PORT`, `HOSTINGER_SSH_USER`
- `HOSTINGER_SSH_PRIVATE_KEY`, `HOSTINGER_SSH_KNOWN_HOSTS`
- `FLEET_DEV_DEPLOY_PATH` **harus** `/opt/fleet-intelligence-dev`

Checkout staging harus sudah tersedia di direktori tersebut, berasal dari repository `Travelintrips/Fleet-Intelligence`, serta mempunyai file privat `deploy/.env.dev`. Workflow **tidak** mengambil atau menyalin kredensial dari PROD maupun container canary yang sudah PASS.

Sebelum staging, workflow menolak koneksi DB yang tidak mengarah ke Supabase **CST-DEV** (`xssrfshdrtdfupgqwfdw`) atau tidak menggunakan PostgreSQL role baca-saja `fleet_dev_cst_inventory_reader`.

Mode `stage-dev` hanya memakai Docker Compose project `fleet-integration-stage` dan port loopback **127.0.0.1:18460**. `CENTRAL_FINANCE_WRITE_ENABLED=false`, `GOJEK_CONNECTOR_ENABLED=false`, dan `DISABLE_BACKGROUND_SCHEDULERS=true` dipaksakan oleh `deploy/docker-compose.dev.yml`. Tidak ada `--remove-orphans`. Pengujian sintetis sengaja memasang `GOJEK_CONNECTOR_ENABLED=true` di file contoh untuk memastikan override Compose tetap menonaktifkan endpoint handoff (HTTP 409), tanpa pernah mengirim data atau menggunakan kredensial nyata.

Container dan network staging memakai nama otomatis yang dibatasi oleh Compose project (tidak memakai `container_name` atau network global `cst-fleet-dev`). Dengan demikian, `stage-dev` tidak dapat mengambil alih container Fleet DEV lain akibat benturan nama. Pengecekan konfigurasi Compose dan tes regresi DEV memverifikasi batasan ini.

**Proxy web staging dibatasi baca-saja.** Docker Compose memasang `deploy/dev-only/nginx-staging-readonly.conf` hanya pada container web staging (bukan konfigurasi Nginx aplikasi PROD maupun Fleet DEV publik). Hanya dua halaman utama, aset statis, health check, sesi/login Google, GET kendaraan, dan GET Transactions yang diteruskan. Rute impor CSV, aksi worker Gojek, upload laporan, dan pengiriman WA ditolak **HTTP 404** sebelum masuk API; POST Transactions ditolak **HTTP 403**. Tes sintetis juga memeriksa penolakan **HTTP 409** langsung di API untuk Gojek Connector yang sudah dipaksa nonaktif. Seluruhnya tanpa token ataupun transaksi nyata.

**Health check staging harus HTTP 200/200.** Karena API menerapkan HTTPS di belakang reverse proxy, probe `/api/healthz` pada port HTTP lokal tanpa header proxy akan mengembalikan redirect 308. Workflow meneruskan `X-Forwarded-Proto: https` hanya pada pemeriksaan API localhost dan memvalidasi kode HTTP **200 secara tepat** untuk `/healthz` (web) dan `/api/healthz` (API). Redirect 308 bukan bukti API siap.

**Workflow tidak melakukan cutover Nginx.** Public Fleet DEV tetap menggunakan rute yang sudah diverifikasi, dan tidak ada deploy ke Fleet PROD.

## Baseline yang wajib dipertahankan

- Fleet DEV Google Super Admin, kendaraan, dan Transactions: E2E GET **PASS**.
- Sumber resmi: 428 baris CSV, 425 unik tersimpan, 3 duplikat, tanpa impor ulang.
- Transaksi 413 driver aktif, 12 historis tetap tersimpan; biaya sewa tidak disebut pendapatan perjalanan.
- Tidak menulis jurnal, mengirim WhatsApp, mengubah scheduler, atau mengaktifkan worker Gojek PROD.
- Simpan konfigurasi Nginx rollback dan container DEV lama sampai pengujian pengganti selesai.

Jangan jalankan migrasi manual khusus DEV pada database yang sudah berisi transaksi hanya karena workflow atau checkout baru diperbarui. Migrasi `deploy/dev-only/002...` dan `003...` mempunyai prasyarat tabel kosong dan sudah diterapkan sebelum impor nyata.

## Tujuan Finance Fleet: PT Diva Servis (DEV)

Konfigurasi kandidat ini memakai `FLEET_FINANCE_COMPANY_MAP={"1":3}` pada Fleet dan receiver canonical BizPortal DEV. `1` adalah perusahaan **sumber operasional Fleet**; `3` adalah PT Diva Servis sebagai **tujuan pembukuan Finance**. Mapping tidak memindahkan kendaraan, driver, transaksi Gojek, outstanding, pembayaran sumber, atau riwayat perusahaan 1.

- Settings dibaca melalui API canonical perusahaan 3 dengan `sourceCompanyId=1`. Pembayaran dan pembalikan mempertahankan identitas sumber pada body dan kunci idempotensi; respons harus mengonfirmasi kedua ID perusahaan yang sama.
- Saat mapping aktif, tidak ada fallback SELECT langsung ke database perusahaan sumber maupun tujuan. Konfigurasi URL/token receiver, mapping server, master perusahaan aktif, serta COA/jurnal Diva harus diverifikasi melalui receiver yang benar. Indikator kesehatan integrasi umum tidak membuktikan settings Diva siap.
- Tanpa mapping, hanya perilaku baca lama yang masih dapat memakai perusahaan sumber. Semua penulisan wajib memiliki mapping eksplisit. Map kosong, salah format, sumber tanpa mapping, dan respons beda perusahaan ditolak.
- `CENTRAL_FINANCE_WRITE_ENABLED=false` tetap menjadi default, dan Compose staging tetap memaksanya OFF. Patch ini tidak mengaktifkan writer, membuka route publik, mengubah konfigurasi aktif, atau menyebarkan perubahan ke PROD. Receiver memiliki pengaman penulisan sendiri.
- Pengujian pembayaran/reversal memakai fixture sintetis di lingkungan terisolasi melalui receiver yang sudah ada. Pastikan posting ulang menghasilkan entry yang sama, company 1 tidak memperoleh jurnal target, perusahaan lain ditolak, pembalikan memakai entry asli yang sesuai, dan seluruh fixture dibersihkan/di-rollback.
- Jalur yang dihubungkan saat ini adalah **pembayaran kas driver dan reversal** yang sudah ada. Impor Gojek tetap menyimpan data sumber Fleet; pengeluaran dan anggaran tetap catatan Fleet; jurnal laporan tetap draft/perlu review dan endpoint posting laporan tetap menolak. Mapping ini tidak menyatakan seluruh jenis transaksi Fleet sudah diposting ke Finance.

Tes lokal sumber kandidat (tanpa layanan atau database asli):

```sh
npm run test -w @workspace/fleet-api
npm run typecheck
```


### Pemulihan pembayaran yang sudah tercatat

Create melakukan preflight settings canonical sebelum menyimpan sumber. Setelah sumber committed, receiver dapat memverifikasi pembayaran tersebut sebelum membuat jurnal Diva. Status `confirmed` ditampilkan sebagai **Menunggu Posting**; pembayaran ini belum mengurangi outstanding lokal. Jika respons Finance terputus, tombol **Lanjutkan Posting** memanggil `POST /api/logistics/fleet/cash-payments/:id/retry` memakai ID dan data sumber yang sama. Endpoint tidak membuat pembayaran pengganti atau menerima jumlah/perusahaan baru dari body.

- Pembuatan pembayaran ditolak selama driver atau outstanding yang sama masih memiliki pembayaran menunggu posting. Outstanding eksplisit harus milik perusahaan dan driver pembayaran tersebut; bila kedua external ID tersedia, nilainya juga harus sama.
- Pembatalan pembayaran menunggu posting ditolak sampai link jurnal tersimpan. Tombol batal tersedia untuk pembayaran `posted` yang memiliki link jurnal.
- Retry dan pembatalan memperoleh ulang row lock setelah respons receiver lalu memeriksa status terbaru. Outstanding dikurangi atau dikembalikan satu kali walaupun beberapa request berjalan bersama. Tidak ada row lock sumber yang ditahan selama HTTP ke receiver.
- Nilai atau tanggal sumber yang berubah ditolak. Receiver tetap memegang validasi mapping, provenance, idempotensi jurnal, dan reversal entry asli. Writer default OFF dan batas route staging publik tetap berlaku.

Uji pemulihan PostgreSQL memakai helper yang sama dengan route Fleet, client sebenarnya, receiver HTTP canonical sebenarnya, dua role non-superuser, dan fixture PostgreSQL sekali pakai tanpa network Docker. Script ini **tidak** menguji sesi Google atau route publik Fleet, dan bukan bukti Finance aktif di DEV/PROD.

Siapkan fixture baru lewat `scripts/test-fleet-finance-dsv-postgres.mjs` di checkout BizPortal kandidat, kemudian jalankan dari checkout Fleet:

```sh
FLEET_QA_FINANCE_REPO=/path/to/bizportal-candidate \
FLEET_QA_DEPENDENCIES=/path/to/bizportal-with-dependencies \
FLEET_QA_PG_SOCKET=/tmp/fleet-finance-dsv-qa-YYYYMMDD/pgsocket \
node scripts/test-fleet-cash-payment-recovery-postgres.mjs
```

Harness menolak socket di luar pola fixture privat tersebut. Cakupan meliputi respons hilang sesudah Finance COMMIT, penolakan create duplikat saat pending, retry delapan request dengan satu pengurangan outstanding, cancel yang berlomba dengan penyelesaian create, delapan cancel dengan satu reversal/pengembalian outstanding, penolakan perusahaan sumber salah, ownership driver outstanding, dan seluruh jurnal/ledger tetap perusahaan 3.


## Aktivasi kas DEV yang terbatas

Setelah review dan pengujian kandidat, overlay `deploy/docker-compose.dev-cash.yml` dapat dipakai pada **project dan direktori DEV yang sama**. Compose default dan workflow yang dipin tetap mempertahankan staging baca-saja. Jangan mengubah branch guard atau memakai `main`.

Konfigurasi privat tambahan disediakan server melalui alur secret yang berwenang:

- `FLEET_CASH_DATABASE_ENABLED_DEV=true`
- `FLEET_CASH_DATABASE_URL_DEV`: kredensial khusus `fleet_cash_source_login_dev` pada CST-DEV. Pool hanya dipakai pembayaran/outstanding company 1; reader inventori tidak diganti. Direct TLS memakai public CA Supabase yang dipin; pooler memakai CA sistem dengan verifikasi host. Credential yang berubah memerlukan restart terkontrol.
- `FLEET_FINANCE_COMPANY_MAP={"1":3}`
- `CENTRAL_FINANCE_BASE_URL=http://fleet-finance-dev:19888`, receiver canonical yang privat pada network DEV yang sama, tanpa port publik.
- `CENTRAL_FINANCE_SERVICE_TOKEN`: token khusus yang cocok dengan `FLEET_FINANCE_SERVICE_TOKEN` receiver.
- `CENTRAL_FINANCE_WRITE_ENABLED=true` hanya pada overlay kas setelah receiver/ACL siap. Receiver tetap memiliki flag dan role database sendiri.

Pool memverifikasi login/role yang tepat, bukan superuser/BYPASSRLS, dan RLS aktif pada pembayaran, outstanding, serta header receipt Finance. API kas hanya menerima sesi Google Super Admin perusahaan sumber 1; mutasi juga harus berasal dari origin Fleet DEV yang benar. Kredensial dan DSN tidak boleh dicetak ke log atau PR.

Overlay membuka halaman kas, GET daftar/ringkasan/settings canonical, POST create/retry, PATCH cancel, serta GET status integrasi. Pengaturan akun pada halaman kas ditampilkan baca-saja dan dikelola di Finance. Aksi WA, scheduler, Gojek, impor/upload, pengubahan settings, dan API lain tetap diblokir. Vehicles/Transactions dan reader lamanya dipertahankan.

Sebelum switch pada checkout branch integrasi yang sudah direview dan image SHA yang sama, jalankan:

```sh
python3 deploy/dev-only/check-cash-stage-config.py --read-only deploy/.env.dev /etc/fleet-finance-dev/fleet-caller.env
docker compose --project-name fleet-integration-stage --env-file deploy/.env.dev --env-file /etc/fleet-finance-dev/fleet-caller.env -f deploy/docker-compose.dev.yml -f deploy/docker-compose.dev-cash.yml config --quiet
```

File `/etc/fleet-finance-dev/fleet-caller.env` harus root-only dan tidak mengganti env reader/Google yang sudah ada. Overlay mengikuti flag writer dari file tersebut; default tetap OFF. Setelah gate role dan receiver siap dan writer secara eksplisit diaktifkan oleh coordinator, ulangi preflight tanpa `--read-only` sebelum switch aktivasi. `config --quiet` tidak mencetak nilai secret. Jalankan deployment hanya setelah test/build pada SHA tersebut lulus; coordinator mempertahankan image/config lama untuk rollback dan melakukan switch pada project DEV yang ada. Tidak ada cutover PROD.

`/api/integrationz` sekarang membaca settings receiver sebenarnya. `readReady` gagal bila scope/respons/konfigurasi salah; `writeReady` memerlukan flag caller, capability receiver, serta privilege sumber yang telah diperiksa. Create DEV juga menolak receiver yang belum siap menulis sebelum menyimpan pembayaran sumber. Keberhasilan readiness tidak menggantikan acceptance pembayaran → retry → reversal lewat sesi Google yang sah.
