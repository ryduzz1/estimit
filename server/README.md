# Estimit API

Backend for photo identification, marketplace evidence, and deterministic resale valuation.

## Local development

```sh
cp .env.example .env
npm install
npm run dev
```

When `OPENAI_API_KEY` is blank in development, identification uses a deterministic preview item. Production refuses to start without an OpenAI key and database. Marketplace search links are research-only until licensed provider credentials are configured, and the API does not calculate a price from them.

Create a valuation:

```sh
curl -X POST http://localhost:3000/v1/valuations \
  -H "Authorization: Bearer $ESTIMIT_API_TOKEN" \
  -F "image=@../assets/icon.png"
```

## Docker deployment

Set strong `POSTGRES_PASSWORD` and `ESTIMIT_API_TOKEN` values in `.env`, then run:

```sh
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/health
```

The API binds only to `127.0.0.1` by default. Put a TLS reverse proxy in front of it before exposing it publicly. Set `ESTIMIT_BIND_ADDRESS=0.0.0.0` only for trusted-LAN testing. Public production-beta enables per-install registration, rate limits registration and scans, stores only image hashes (not uploaded photos), and supports credential revocation in Postgres.

## Current home-server deployment

- Directory: `/home/ryder/estimit-api`
- HTTPS: `https://server.tailc264d2.ts.net:8443`
- Development access: tailnet devices through Tailscale Serve
- Production-beta access: public internet through Tailscale Funnel on port 8443
- API and database: Docker Compose with automatic restart
- Secrets: `/home/ryder/estimit-api/.env` (mode `0600`)

The existing Tailscale Funnel on the default HTTPS port is unrelated and has not been changed.

Useful commands on the server:

```sh
cd /home/ryder/estimit-api
docker compose ps
docker compose logs --tail=100 api
docker compose up -d --build
curl https://server.tailc264d2.ts.net:8443/health
```

## Enabling providers

Edit only the secret file on the server:

```sh
cd /home/ryder/estimit-api
nano .env
docker compose up -d --build
```

Never commit `.env`, paste secrets into source files, or put provider secrets in the Expo app. OpenAI identification is enabled by `OPENAI_API_KEY`. eBay Browse requires `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`. PriceCharting requires a paid `PRICECHARTING_TOKEN`.

Marketplace adapters remain preview-only until their implementation and credentials are both present. Active listings must stay labeled as context; sold data may support valuation only when its license explicitly permits this use.
