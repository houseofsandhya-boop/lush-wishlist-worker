const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });

const badRequest = (message) => json({ error: message }, 400);

const bytesToHex = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const timingSafeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

const hmacHex = async (message, secret) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(digest);
};

const randomHex = (bytes = 16) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

async function verifyProxySignature(url, secret) {
  const params = new URLSearchParams(url.search);
  const signature = params.get('signature');
  if (!signature) return false;

  params.delete('signature');

  const groupedParams = {};
  for (const [key, value] of params.entries()) {
    groupedParams[key] = groupedParams[key] ? `${groupedParams[key]},${value}` : value;
  }

  const message = Object.entries(groupedParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('');

  return timingSafeEqual(await hmacHex(message, secret), signature);
}

async function verifyOAuthHmac(url, secret) {
  const params = new URLSearchParams(url.search);
  const hmac = params.get('hmac');
  if (!hmac) return false;

  params.delete('hmac');
  params.delete('signature');

  const message = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  return timingSafeEqual(await hmacHex(message, secret), hmac);
}

const tokenKey = (shop) => `shop:${shop}:admin_token`;

async function getAdminToken(env) {
  const token = await env.WISHLIST_TOKENS?.get(tokenKey(env.SHOPIFY_SHOP));
  return token || env.SHOPIFY_ADMIN_TOKEN;
}

async function shopifyGraphql(env, query, variables = {}) {
  const token = await getAdminToken(env);
  if (!token) throw new Error('Wishlist app is not installed');

  const response = await fetch(
    `https://${env.SHOPIFY_SHOP}/admin/api/${env.SHOPIFY_API_VERSION || '2026-01'}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await response.json();
  if (!response.ok || data.errors) {
    throw new Error(JSON.stringify(data.errors || data));
  }
  return data.data;
}

const customerGid = (id) => `gid://shopify/Customer/${id}`;

async function getWishlistIds(env, customerId) {
  const data = await shopifyGraphql(
    env,
    `query CustomerWishlist($id: ID!, $namespace: String!, $key: String!) {
      customer(id: $id) {
        metafield(namespace: $namespace, key: $key) {
          value
        }
      }
    }`,
    {
      id: customerGid(customerId),
      namespace: env.WISHLIST_NAMESPACE || 'custom',
      key: env.WISHLIST_KEY || 'wishlist',
    }
  );

  const value = data.customer?.metafield?.value;
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function setWishlistIds(env, customerId, productIds) {
  const uniqueIds = [...new Set(productIds)].slice(0, 100);
  const data = await shopifyGraphql(
    env,
    `mutation SetCustomerWishlist($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id value }
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: customerGid(customerId),
          namespace: env.WISHLIST_NAMESPACE || 'custom',
          key: env.WISHLIST_KEY || 'wishlist',
          type: 'json',
          value: JSON.stringify(uniqueIds),
        },
      ],
    }
  );

  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(JSON.stringify(errors));
  return uniqueIds;
}

async function getProducts(env, productIds) {
  if (!productIds.length) return [];

  const data = await shopifyGraphql(
    env,
    `query WishlistProducts($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          handle
          featuredImage {
            url(transform: { maxWidth: 700 })
            altText
          }
          priceRangeV2 {
            minVariantPrice {
              amount
              currencyCode
            }
          }
        }
      }
    }`,
    { ids: productIds }
  );

  return (data.nodes || [])
    .filter(Boolean)
    .map((product) => ({
      id: product.id,
      title: product.title,
      url: `/products/${product.handle}`,
      image: product.featuredImage?.url || '',
      imageAlt: product.featuredImage?.altText || product.title,
      price: product.priceRangeV2?.minVariantPrice
        ? `${product.priceRangeV2.minVariantPrice.currencyCode} ${Number(product.priceRangeV2.minVariantPrice.amount).toLocaleString()}`
        : '',
    }));
}

async function handleAuthStart(request, env) {
  const url = new URL(request.url);
  const shop = (url.searchParams.get('shop') || env.SHOPIFY_SHOP || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    return badRequest('Missing valid shop');
  }

  const state = randomHex();
  await env.WISHLIST_TOKENS.put(`state:${state}`, shop, { expirationTtl: 600 });

  const redirectUri = `${url.origin}/auth/callback`;
  const scopes = 'read_customers,write_customers,read_products,write_app_proxy';
  const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authUrl.searchParams.set('client_id', env.SHOPIFY_API_KEY);
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  if (!(await verifyOAuthHmac(url, env.SHOPIFY_API_SECRET))) {
    return json({ error: 'Invalid OAuth hmac' }, 403);
  }

  const shop = url.searchParams.get('shop');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedShop = state ? await env.WISHLIST_TOKENS.get(`state:${state}`) : null;

  if (!shop || !code || !state || expectedShop !== shop) {
    return badRequest('Invalid OAuth callback');
  }

  const tokenBody = new URLSearchParams({
    client_id: env.SHOPIFY_API_KEY,
    client_secret: env.SHOPIFY_API_SECRET.trim(),
    code,
  });

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: tokenBody,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : { error: (await response.text()).match(/<title>(.*?)<\/title>/i)?.[1] || 'Non-JSON token response' };
  if (!response.ok || !data.access_token) {
    return json({ error: data.error_description || data.error || 'Token exchange failed' }, 500);
  }

  await env.WISHLIST_TOKENS.put(tokenKey(shop), data.access_token);
  await env.WISHLIST_TOKENS.delete(`state:${state}`);

  return new Response('Lush Wishlist app installed. You can close this tab.', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/auth/start') {
    return handleAuthStart(request, env);
  }

  if (url.pathname === '/auth/callback') {
    return handleAuthCallback(request, env);
  }

  if (!(await verifyProxySignature(url, env.SHOPIFY_API_SECRET))) {
    return json({ error: 'Invalid app proxy signature' }, 403);
  }

  const customerId = url.searchParams.get('logged_in_customer_id');
  if (!customerId) return json({ error: 'Customer login required' }, 401);

  const suffix = url.pathname.replace(/^\/apps\/wishlist/, '') || '/';
  const currentIds = await getWishlistIds(env, customerId);

  if (request.method === 'GET' && suffix === '/ids') {
    return json({ productIds: currentIds });
  }

  if (request.method === 'GET') {
    const products = await getProducts(env, currentIds);
    return json({ productIds: currentIds, products });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const body = await request.json().catch(() => null);
  const productId = body?.productId;
  if (!productId || !productId.startsWith('gid://shopify/Product/')) {
    return badRequest('Missing valid productId');
  }

  if (suffix === '/add') {
    return json({ productIds: await setWishlistIds(env, customerId, [...currentIds, productId]) });
  }

  if (suffix === '/remove') {
    return json({ productIds: await setWishlistIds(env, customerId, currentIds.filter((id) => id !== productId)) });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return json({ error: error.message || 'Wishlist worker error' }, 500);
    }
  },
};
