# CST Gojek VPS Worker

Production Gojek connector worker for Fleet Intelligence.

The worker:
- polls Fleet API for pending sync jobs;
- authenticates every worker request with an Ed25519 signature;
- launches Chromium in Docker on the VPS;
- uses the official Fleet Partner export flow;
- stops if OTP/CAPTCHA/security verification appears;
- sends the resulting CSV back to Fleet for import.

The private worker key is stored only on the VPS and must never be committed.

Runtime target:
- VPS: srv1792369
- service: cst-gojek-vps-worker
- local health: http://127.0.0.1:18083
