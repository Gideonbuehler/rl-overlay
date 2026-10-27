# RL Overlay shared MMR server

A Cloudflare Worker with a D1 database. Overlays that opt in report their own
MMR (read from the game's log on solo queues); any overlay can look players up
by platform id. No accounts: the first overlay to report an id claims it with a
random secret token, and only that token can update or delete it.

    POST   /v1/mmr               { primaryId, name, playlist, mmr, at }   Authorization: Bearer <token>
    GET    /v1/players?ids=a,b   up to 10 ids
    DELETE /v1/me                { primaryId }                            Authorization: Bearer <token>

## Local

    npm install
    npm run migrate:local
    npm run dev            # http://localhost:8787

## Live

Deployed at https://rl-overlay.gideon-buehler.workers.dev (D1 database `rl-overlay-db`,
id in `wrangler.toml`). The overlay uses it when its "Shared MMR server" setting is empty.
To ship changes: `npm run deploy`; new migrations: `npm run migrate:remote`.

## Deploy from scratch

    npx wrangler d1 create rl-overlay-db      # put the printed id in wrangler.toml
    npm run migrate:remote
    npm run deploy

Then set the overlay's "Shared MMR server" (settings > General) to the Worker's URL.

## Limits

Claims are first come, first served: whoever reports an id first owns it. There's
no proof the reporter is that player, so a bad actor could claim someone's id
before they do. Reports are range-checked (MMR 0–3000, readings from the last 30
days), but there's no rate limiting beyond Cloudflare's own.
