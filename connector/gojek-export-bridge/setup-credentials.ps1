param()

$ErrorActionPreference = "Stop"

$dir = Join-Path $env:LOCALAPPDATA "CSTFleet"
$file = Join-Path $dir "gojek-credentials.json"

New-Item -ItemType Directory -Force -Path $dir | Out-Null

$email = Read-Host "Email Fleet Partner Gojek"
if ([string]::IsNullOrWhiteSpace($email)) {
  throw "Email wajib diisi."
}

$secure = Read-Host "Password Fleet Partner Gojek" -AsSecureString
$encrypted = ConvertFrom-SecureString $secure

$payload = @{
  email = $email.Trim()
  password = $encrypted
  protectedBy = "Windows DPAPI current user"
  createdAt = (Get-Date).ToString("o")
} | ConvertTo-Json

Set-Content -Path $file -Value $payload -Encoding UTF8

Write-Host ""
Write-Host "Credential tersimpan terenkripsi untuk user Windows saat ini:"
Write-Host $file
Write-Host "Password tidak disimpan plaintext dan tidak dikirim ke GitHub/Hostinger."
