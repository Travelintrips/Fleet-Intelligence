# Fleet Intelligence

Standalone CST Fleet Intelligence application extracted from CST-BIZPORTAL.

## Applications

- `apps/web` — Fleet Intelligence React/Vite frontend
- `apps/api` — Fleet Intelligence API
- `deploy` — isolated DEV and PROD Docker Compose definitions

## Domains

- DEV: `dev-fleet.cstlogistic.co.id`
- PROD: `fleet.cstlogistic.co.id`

## Safety model

- DEV and PROD use different Supabase credentials.
- The Fleet API refuses a database URL that points at the wrong known Supabase project.
- Central Finance remains a separate system. Fleet posting uses an HTTP integration contract with idempotency and is disabled unless `CENTRAL_FINANCE_WRITE_ENABLED=true`.
- Fleet WhatsApp delivery uses the CST WA Gateway.
- Existing embedded Fleet in BizPortal remains the rollback path until production cutover is validated.

## Local checks

```bash
npm install
npm run typecheck
npm run build
```

## DEV deployment

Copy `deploy/.env.dev.example` to `deploy/.env.dev`, fill DEV-only values, then:

```bash
docker compose -f deploy/docker-compose.dev.yml up -d --build
```

The DEV web service binds only to `127.0.0.1:18460`. Put the public TLS reverse proxy for `dev-fleet.cstlogistic.co.id` in front of that port.

## Production deployment

Copy `deploy/.env.prod.example` to `deploy/.env.prod`, fill production secrets, validate DEV parity first, then:

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

The production web service binds only to `127.0.0.1:18461`. Do not enable Central Finance writes until accounting parity and idempotency tests are green.
