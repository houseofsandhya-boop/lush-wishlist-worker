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

