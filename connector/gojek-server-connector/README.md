# CST Gojek Server Connector

Server-side connector for official Fleet Partner export.

## Purpose

Allows CST Fleet to sync Gojek Drivers/Outstanding from any client computer without installing a Windows watcher on each PC.

## Required environment variables

- FLEET_BASE_URL=https://fleet.cstlogistic.co.id
- GOJEK_CONNECTOR_SHARED_SECRET=<same as Fleet backend>
- GOJEK_SERVER_CONNECTOR_TOKEN=<random service token>
- GOJEK_FLEET_PORTAL_URL=https://fleetpartner.gojek.com
- GOJEK_CONNECTOR_ALLOWED_HOST=fleetpartner.gojek.com
- PORT=8080

The connector does not store Gojek username/password. It requests them at runtime from the Fleet backend over HTTPS.

## Endpoints

- GET /health
- POST /sync/drivers with Authorization: Bearer <GOJEK_SERVER_CONNECTOR_TOKEN>

If Gojek presents OTP/CAPTCHA/additional verification, the sync fails safely instead of bypassing it.
