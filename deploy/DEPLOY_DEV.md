# Fleet DEV deployment

The DEV deployment is intentionally separate from production.

## Required GitHub environment

Create an Actions environment named `fleet-dev`.

Required secrets:

- `HOSTINGER_SSH_HOST`
- `HOSTINGER_SSH_PORT`
- `HOSTINGER_SSH_USER`
- `HOSTINGER_SSH_PRIVATE_KEY`
- `HOSTINGER_SSH_KNOWN_HOSTS`
- `FLEET_DEV_DEPLOY_PATH` (recommended: `/opt/fleet-intelligence-dev`)

The workflow never writes application secrets to the server. The server must already contain:

`<FLEET_DEV_DEPLOY_PATH>/deploy/.env.dev`

That file must contain DEV-only database, authentication, WA Gateway and Central Finance configuration.

## Safety

- Deployment only runs manually through `workflow_dispatch`.
- CI/typecheck/build/Docker builds must pass before SSH deployment starts.
- The deployment resets only the dedicated Fleet DEV checkout.
- Central Finance writes remain disabled by `deploy/docker-compose.dev.yml`.
- Health checks validate both the web container and Fleet API before success is reported.
