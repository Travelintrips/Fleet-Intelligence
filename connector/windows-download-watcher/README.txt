CST Fleet Windows Download Watcher

Cara pakai:
1. Ekstrak ZIP.
2. Double-click INSTALL.bat.
3. Masukkan GOJEK_CONNECTOR_SHARED_SECRET dari Hostinger satu kali.
4. Buka CST Fleet > Gojek Connector > Refresh.
5. Jika status lokal Terhubung, klik Buka Fleet Partner Gojek.
6. Gunakan Export resmi seperti biasa.

Watcher memantau folder Downloads Windows. CSV baru akan otomatis dikirim ke CST Fleet.
Backend otomatis membedakan export Drivers/Outstanding dan Transactions.
File lokal dihapus setelah import sukses atau terdeteksi duplikat.
Tidak perlu Git clone, npm install, atau Playwright.

Log:
%LOCALAPPDATA%\CSTFleetWatcher\watcher.log

Uninstall:
hapus shortcut:
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CST Fleet Watcher.vbs
dan folder:
%LOCALAPPDATA%\CSTFleetWatcher
