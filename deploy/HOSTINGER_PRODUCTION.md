# Hostinger production deployment

Target: `https://fleet.cstlogistic.co.id`

This repository is prepared for Hostinger native Git deployment.

## Hostinger build contract

- Node: 22.x
- Install: `npm install`
- Build: `npm run build`
- Start: `npm start`
- Public app and API run from the same Node process.
- Frontend is embedded into `apps/api/dist/public` during build.

## Required production environment

Use the values from `deploy/.env.prod.example` and set at minimum:

- `APP_ENV=production`
- `NODE_ENV=production`
- `APP_BASE_URL=https://fleet.cstlogistic.co.id`
- `SUPABASE_DATABASE_URL` for the known PROD Supabase project only
- `SESSION_SECRET`
- SMTP settings required by production login
- CST WA Gateway URL/token/device
- Central Finance base URL/token

Keep:

`CENTRAL_FINANCE_WRITE_ENABLED=false`

for the initial production boot. Enable accounting writes only after authenticated smoke tests pass.

## Production cutover sequence

1. Connect this GitHub repository and `main` branch to a new Hostinger Node application.
2. Configure the environment above.
3. Attach `fleet.cstlogistic.co.id`.
4. Deploy.
5. Confirm:
   - `/healthz` = 200
   - `/api/readyz` = 200
   - unauthenticated Fleet API = 401
   - login works
   - dashboard/outstanding/report reads match embedded Fleet
6. Keep BizPortal embedded Fleet available as rollback until parity is approved.
7. Only after accounting smoke passes may `CENTRAL_FINANCE_WRITE_ENABLED` be changed to `true`.

Do not delete or disable the embedded BizPortal Fleet during the first production deployment.
