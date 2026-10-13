# Lush Wishlist App

Cloudflare Worker backend for the Shopify wishlist feature on `p1mtpu-cr.myshopify.com`.

## What is included

- `worker/` - Cloudflare Worker source and `wrangler.toml`
- `shopify-app/` - Shopify app configuration reference
- `.github/workflows/deploy-worker.yml` - deploys the Worker on pushes to `main`

## GitHub Actions setup

Add these repository secrets before relying on auto-deploy:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Current Cloudflare account ID:

```text
e4f5b05ceb80a20df3afe41f056b2554
```

The Worker already stores Shopify secrets in Cloudflare. Do not commit Shopify API secrets or Admin tokens.

## Local deploy

```bash
cd worker
npm install
npm run deploy
```

## Second merchant deployment

Use `worker/wrangler.second-store.toml` for a separate Cloudflare Worker deployment for
a different merchant or Shopify organization.

The Shopify app has already been created with this client ID:

```text
2103be1907ad7d7057c951aecb7cd07c
```

Before deploying, update this value in `worker/wrangler.second-store.toml`:

- `SHOPIFY_SHOP`

Then set the Shopify app client secret in Cloudflare:

```bash
cd worker
npm run secret:second-store
```

Deploy the second Worker:

```bash
npm run deploy:second-store
```

Use the deployed Worker URL in the second Shopify app:

```text
App URL: https://lush-wishlist-worker-second-store.<your-workers-subdomain>.workers.dev/auth/start
Redirect URL: https://lush-wishlist-worker-second-store.<your-workers-subdomain>.workers.dev/auth/callback
App proxy URL: https://lush-wishlist-worker-second-store.<your-workers-subdomain>.workers.dev
Prefix: apps
Subpath: wishlist
```

