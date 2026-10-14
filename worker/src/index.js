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
const detailsKey = (env) => `${env.WISHLIST_KEY || 'wishlist'}_details`;
const adminSessionKey = (session) => `admin_session:${session}`;

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

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const parseJsonArray = (value) => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
};

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

  return parseJsonArray(data.customer?.metafield?.value);
}

async function getWishlistData(env, customerId) {
  const data = await shopifyGraphql(
    env,
    `query CustomerWishlist($id: ID!, $namespace: String!, $key: String!, $detailsKey: String!) {
      customer(id: $id) {
        ids: metafield(namespace: $namespace, key: $key) { value }
        details: metafield(namespace: $namespace, key: $detailsKey) { value }
      }
    }`,
    {
      id: customerGid(customerId),
      namespace: env.WISHLIST_NAMESPACE || 'custom',
      key: env.WISHLIST_KEY || 'wishlist',
      detailsKey: detailsKey(env),
    }
  );

  return {
    ids: parseJsonArray(data.customer?.ids?.value),
    details: parseJsonArray(data.customer?.details?.value),
  };
}

async function setWishlistData(env, customerId, productIds, details) {
  const uniqueIds = [...new Set(productIds)].slice(0, 100);
  const cleanDetails = details
    .filter((item) => uniqueIds.includes(item.productId))
    .slice(0, 100)
    .map((item) => ({
      productId: item.productId,
      addedAt: item.addedAt || null,
    }));
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
        {
          ownerId: customerGid(customerId),
          namespace: env.WISHLIST_NAMESPACE || 'custom',
          key: detailsKey(env),
          type: 'json',
          value: JSON.stringify(cleanDetails),
        },
      ],
    }
  );

  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(JSON.stringify(errors));
  return uniqueIds;
}

async function createAdminSession(env) {
  const session = randomHex(24);
  await env.WISHLIST_TOKENS.put(adminSessionKey(session), env.SHOPIFY_SHOP, { expirationTtl: 3600 });
  return session;
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

async function getWishlistCustomers(env) {
  const customers = [];
  let after = null;

  for (let page = 0; page < 4; page += 1) {
    const data = await shopifyGraphql(
      env,
      `query WishlistCustomers($after: String, $namespace: String!, $key: String!, $detailsKey: String!) {
        customers(first: 100, after: $after, sortKey: UPDATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              displayName
              email
              phone
              createdAt
              ids: metafield(namespace: $namespace, key: $key) { value }
              details: metafield(namespace: $namespace, key: $detailsKey) { value }
            }
          }
        }
      }`,
      {
        after,
        namespace: env.WISHLIST_NAMESPACE || 'custom',
        key: env.WISHLIST_KEY || 'wishlist',
        detailsKey: detailsKey(env),
      }
    );

    for (const edge of data.customers?.edges || []) {
      const ids = parseJsonArray(edge.node.ids?.value);
      if (ids.length) customers.push({ ...edge.node, ids, details: parseJsonArray(edge.node.details?.value) });
    }

    if (!data.customers?.pageInfo?.hasNextPage) break;
    after = data.customers.pageInfo.endCursor;
  }

  return customers;
}

async function renderDashboard(env, session) {
  const storedShop = await env.WISHLIST_TOKENS.get(adminSessionKey(session || ''));
  if (storedShop !== env.SHOPIFY_SHOP) {
    return new Response('Unauthorized dashboard session. Open the app again from Shopify admin.', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const customers = await getWishlistCustomers(env);
  const productIds = [...new Set(customers.flatMap((customer) => customer.ids))];
  const products = await getProducts(env, productIds);
  const productById = new Map(products.map((product) => [product.id, product]));
  const totalItems = customers.reduce((sum, customer) => sum + customer.ids.length, 0);

  const rows = customers
    .flatMap((customer) =>
      customer.ids.map((productId) => {
        const product = productById.get(productId);
        const detail = customer.details.find((item) => item.productId === productId) || {};
        return `
          <tr>
            <td>
              <strong>${escapeHtml(customer.displayName || 'Unknown customer')}</strong>
              <small>${escapeHtml(customer.email || '')}</small>
              <small>${escapeHtml(customer.phone || '')}</small>
              <small>${escapeHtml(customer.id)}</small>
            </td>
            <td>
              <strong>${escapeHtml(product?.title || productId)}</strong>
              ${product?.url ? `<a href="https://${escapeHtml(env.SHOPIFY_SHOP)}${escapeHtml(product.url)}" target="_blank" rel="noreferrer">View product</a>` : ''}
              <small>${escapeHtml(productId)}</small>
            </td>
            <td>${escapeHtml(product?.price || '')}</td>
            <td>${detail.addedAt ? escapeHtml(new Date(detail.addedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })) : 'Unknown for old entries'}</td>
          </tr>`;
      })
    )
    .join('');

  return new Response(
    `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Wishlist Dashboard</title>
        <style>
          body{margin:0;font-family:Arial,sans-serif;background:#f6f6f7;color:#202223}
          header{padding:24px 32px;background:#111;color:#fff}
          main{padding:24px 32px}
          .stats{display:flex;gap:12px;margin-bottom:18px}
          .stat{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;min-width:160px}
          .stat strong{display:block;font-size:28px}
          table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #ddd}
          th,td{padding:12px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
          th{background:#fafafa;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
          small,a{display:block;margin-top:4px;color:#616161}
          .empty{background:#fff;border:1px solid #ddd;border-radius:8px;padding:24px}
        </style>
      </head>
      <body>
        <header><h1>Wishlist Dashboard</h1><p>${escapeHtml(env.SHOPIFY_SHOP)}</p></header>
        <main>
          <div class="stats">
            <div class="stat"><span>Customers</span><strong>${customers.length}</strong></div>
            <div class="stat"><span>Wishlist items</span><strong>${totalItems}</strong></div>
          </div>
          ${
            rows
              ? `<table><thead><tr><th>Customer</th><th>Product</th><th>Price</th><th>Wishlist time</th></tr></thead><tbody>${rows}</tbody></table>`
              : '<div class="empty">No customer wishlist data found yet.</div>'
          }
        </main>
      </body>
    </html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

async function handleAuthStart(request, env) {
  const url = new URL(request.url);
  const shop = (url.searchParams.get('shop') || env.SHOPIFY_SHOP || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    return badRequest('Missing valid shop');
  }

  if ((await getAdminToken(env)) && url.searchParams.get('hmac') && (await verifyOAuthHmac(url, env.SHOPIFY_API_SECRET))) {
    const session = await createAdminSession(env);
    return Response.redirect(`${url.origin}/dashboard?session=${session}`, 302);
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

  const session = await createAdminSession(env);
  return Response.redirect(`${url.origin}/dashboard?session=${session}`, 302);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/auth/start') {
    return handleAuthStart(request, env);
  }

  if (url.pathname === '/auth/callback') {
    return handleAuthCallback(request, env);
  }

  if (url.pathname === '/dashboard') {
    return renderDashboard(env, url.searchParams.get('session'));
  }

  if (!(await verifyProxySignature(url, env.SHOPIFY_API_SECRET))) {
    return json({ error: 'Invalid app proxy signature' }, 403);
  }

  const customerId = url.searchParams.get('logged_in_customer_id');
  if (!customerId) return json({ error: 'Customer login required' }, 401);

  const suffix = url.pathname.replace(/^\/apps\/wishlist/, '') || '/';
  const wishlist = await getWishlistData(env, customerId);
  const currentIds = wishlist.ids;

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
    const details = wishlist.details.some((item) => item.productId === productId)
      ? wishlist.details
      : [...wishlist.details, { productId, addedAt: new Date().toISOString() }];
    return json({ productIds: await setWishlistData(env, customerId, [...currentIds, productId], details) });
  }

  if (suffix === '/remove') {
    return json({
      productIds: await setWishlistData(
        env,
        customerId,
        currentIds.filter((id) => id !== productId),
        wishlist.details.filter((item) => item.productId !== productId)
      ),
    });
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
