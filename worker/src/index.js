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

const bytesToBase64 = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)));

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

const hmacBase64 = async (message, secret) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToBase64(digest);
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

async function verifyWebhookHmac(rawBody, signature, secret) {
  if (!signature) return false;
  return timingSafeEqual(await hmacBase64(rawBody, secret), signature);
}

const tokenKey = (shop) => `shop:${shop}:admin_token`;
const detailsKey = (env) => `${env.WISHLIST_KEY || 'wishlist'}_details`;
const adminSessionKey = (session) => `admin_session:${session}`;
const customerPurchaseKey = (customerId) => `customer_purchase:${customerId}`;
const webhookDeliveryKey = (webhookId) => `webhook_delivery:${webhookId}`;

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

const formatIndiaTime = (value) =>
  value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';

const formatAge = (value) => {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [label, size] of units) {
    const amount = Math.floor(seconds / size);
    if (amount >= 1) return `${amount} ${label}${amount === 1 ? '' : 's'}`;
  }
  return 'Just now';
};

const csvEscape = (value = '') => `"${String(value).replace(/"/g, '""')}"`;

const legacyId = (gid = '') => String(gid).split('/').pop();

const storefrontUrl = (env, path = '') =>
  `${String(env.STOREFRONT_URL || `https://${env.SHOPIFY_SHOP}`).replace(/\/+$/, '')}${path}`;

const followUpEmailUrl = (env, customer, product) => {
  if (!customer.email || !product) return '';
  const customerName = customer.displayName || 'there';
  const productUrl = storefrontUrl(env, product.url || '');
  const subject = `Still interested in ${product.title}?`;
  const body = [
    `Hi ${customerName},`,
    '',
    `You saved ${product.title} to your House of Sandhya wishlist.`,
    'It is still waiting for you:',
    productUrl,
    '',
    'Regards,',
    'House of Sandhya',
  ].join('\n');
  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: customer.email,
    su: subject,
    body,
  });
  return `https://mail.google.com/mail/?${params}`;
};

const paidStatuses = new Set(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);

const normalizePurchase = (order) => ({
  orderId: order.id,
  orderName: order.name || '',
  purchasedAt: order.processedAt || order.createdAt || '',
  cancelledAt: order.cancelledAt || null,
  financialStatus: order.displayFinancialStatus || 'PAID',
  productIds: [...new Set((order.productIds || []).filter(Boolean))],
});

async function getStoredPurchases(env, customerId) {
  const value = await env.WISHLIST_TOKENS.get(customerPurchaseKey(legacyId(customerId)));
  return parseJsonArray(value).map(normalizePurchase);
}

async function getRecentPurchases(env, customerId) {
  const data = await shopifyGraphql(
    env,
    `query CustomerPurchases($id: ID!) {
      customer(id: $id) {
        orders(first: 100, reverse: true) {
          nodes {
            id
            name
            processedAt
            cancelledAt
            displayFinancialStatus
            lineItems(first: 100) {
              nodes { product { id } }
            }
          }
        }
      }
    }`,
    { id: customerId }
  );

  return (data.customer?.orders?.nodes || []).map((order) =>
    normalizePurchase({
      ...order,
      productIds: (order.lineItems?.nodes || []).map((item) => item.product?.id),
    })
  );
}

async function getCustomerPurchases(env, customerId) {
  const stored = await getStoredPurchases(env, customerId);
  let recent = [];
  try {
    recent = await getRecentPurchases(env, customerId);
  } catch {
    recent = [];
  }

  const byOrderId = new Map(stored.map((order) => [order.orderId, order]));
  for (const order of recent) byOrderId.set(order.orderId, order);
  return [...byOrderId.values()];
}

const getPurchaseStatus = (purchases, productId, addedAt) => {
  const addedTime = addedAt ? new Date(addedAt).getTime() : null;
  const matches = purchases
    .filter((order) => order.productIds.includes(productId))
    .filter((order) => !addedTime || new Date(order.purchasedAt).getTime() >= addedTime)
    .sort((a, b) => new Date(a.purchasedAt) - new Date(b.purchasedAt));
  const order = matches.find((item) => !item.cancelledAt && paidStatuses.has(item.financialStatus));

  if (!order) {
    const cancelled = matches.find((item) => item.cancelledAt);
    return cancelled
      ? { label: `Cancelled${cancelled.orderName ? ` (${cancelled.orderName})` : ''}`, order: cancelled }
      : { label: 'Awaiting purchase', order: null };
  }

  const suffix = !addedAt
    ? ' - wishlist date unknown'
    : order.financialStatus === 'REFUNDED'
      ? ' - refunded'
      : order.financialStatus === 'PARTIALLY_REFUNDED'
        ? ' - partially refunded'
        : '';
  return {
    label: `Purchased${order.orderName ? ` (${order.orderName})` : ''}${suffix}`,
    order,
  };
};

async function handleOrderWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Shopify-Hmac-Sha256') || '';
  if (!(await verifyWebhookHmac(rawBody, signature, env.SHOPIFY_API_SECRET))) {
    return new Response('Invalid webhook signature', { status: 401 });
  }

  const shop = request.headers.get('X-Shopify-Shop-Domain') || '';
  if (shop !== env.SHOPIFY_SHOP) return new Response('Unexpected shop', { status: 403 });

  const webhookId = request.headers.get('X-Shopify-Webhook-Id') || '';
  if (webhookId && (await env.WISHLIST_TOKENS.get(webhookDeliveryKey(webhookId)))) {
    return new Response(null, { status: 200 });
  }

  const topic = request.headers.get('X-Shopify-Topic') || '';
  const payload = JSON.parse(rawBody);
  const customerId = payload.customer?.id;
  if (!customerId || !['orders/paid', 'orders/cancelled'].includes(topic)) {
    return new Response(null, { status: 200 });
  }

  const orderId = payload.admin_graphql_api_id || `gid://shopify/Order/${payload.id}`;
  const purchases = await getStoredPurchases(env, customerId);
  const record = normalizePurchase({
    id: orderId,
    name: payload.name,
    processedAt: payload.processed_at || payload.created_at,
    cancelledAt: topic === 'orders/cancelled' ? payload.cancelled_at || new Date().toISOString() : null,
    displayFinancialStatus: String(payload.financial_status || 'paid').toUpperCase(),
    productIds: (payload.line_items || []).map((item) =>
      item.product_id ? `gid://shopify/Product/${item.product_id}` : null
    ),
  });
  const existingIndex = purchases.findIndex((item) => item.orderId === orderId);
  if (existingIndex >= 0) purchases[existingIndex] = { ...purchases[existingIndex], ...record };
  else purchases.unshift(record);

  await env.WISHLIST_TOKENS.put(
    customerPurchaseKey(customerId),
    JSON.stringify(purchases.slice(0, 250))
  );
  if (webhookId) {
    await env.WISHLIST_TOKENS.put(webhookDeliveryKey(webhookId), '1', { expirationTtl: 2592000 });
  }
  return new Response(null, { status: 200 });
}

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
              ids: metafield(namespace: $namespace, key: $key) { value updatedAt }
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
      if (ids.length) {
        customers.push({
          ...edge.node,
          ids,
          idsUpdatedAt: edge.node.ids?.updatedAt || null,
          details: parseJsonArray(edge.node.details?.value),
        });
      }
    }

    if (!data.customers?.pageInfo?.hasNextPage) break;
    after = data.customers.pageInfo.endCursor;
  }

  return customers;
}

async function renderDashboard(env, session, customerId = '', view = '') {
  const storedShop = await env.WISHLIST_TOKENS.get(adminSessionKey(session || ''));
  if (storedShop !== env.SHOPIFY_SHOP) {
    return new Response('Unauthorized dashboard session. Open the app again from Shopify admin.', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const customers = await getWishlistCustomers(env);
  const isAllCustomersView = view === 'all';
  const selectedCustomer = customerId ? customers.find((customer) => customer.id === customerId) : null;
  const visibleCustomers = selectedCustomer ? [selectedCustomer] : isAllCustomersView ? customers : [];
  const productIds = [...new Set(visibleCustomers.flatMap((customer) => customer.ids))];
  const products = await getProducts(env, productIds);
  const productById = new Map(products.map((product) => [product.id, product]));
  const purchaseEntries = await Promise.all(
    visibleCustomers.map(async (customer) => [customer.id, await getCustomerPurchases(env, customer.id)])
  );
  const purchasesByCustomer = new Map(purchaseEntries);
  const totalItems = customers.reduce((sum, customer) => sum + customer.ids.length, 0);

  const customerCards = customers
    .map(
      (customer) => `
        <a class="customer-card" href="/dashboard?session=${encodeURIComponent(session)}&customer=${encodeURIComponent(customer.id)}">
          <strong>${escapeHtml(customer.displayName || 'Unknown customer')}</strong>
          <span>${escapeHtml(customer.email || '')}</span>
          <span>${escapeHtml(customer.phone || '')}</span>
          <b>${customer.ids.length} wishlist item${customer.ids.length === 1 ? '' : 's'}</b>
        </a>`
    )
    .join('');

  const rows = visibleCustomers
    .flatMap((customer) =>
      customer.ids.map((productId) => {
        const product = productById.get(productId);
        const detail = customer.details.find((item) => item.productId === productId) || {};
        const trackedTime = detail.addedAt ? formatIndiaTime(detail.addedAt) : '';
        const age = detail.addedAt ? formatAge(detail.addedAt) : '';
        const oldTime = formatIndiaTime(customer.idsUpdatedAt);
        const purchaseStatus = getPurchaseStatus(
          purchasesByCustomer.get(customer.id) || [],
          productId,
          detail.addedAt
        );
        const emailUrl = followUpEmailUrl(env, customer, product);
        return `
          <tr>
            ${
              selectedCustomer
                ? ''
                : `<td>
                    <strong>${escapeHtml(customer.displayName || 'Unknown customer')}</strong>
                    <small>${escapeHtml(customer.email || '')}</small>
                    <small>${escapeHtml(customer.phone || '')}</small>
                    <small>${escapeHtml(customer.id)}</small>
                  </td>`
            }
            <td>
              <strong>${escapeHtml(product?.title || productId)}</strong>
              ${product?.url ? `<a href="https://${escapeHtml(env.SHOPIFY_SHOP)}${escapeHtml(product.url)}" target="_blank" rel="noreferrer">View product</a>` : ''}
              <small>${escapeHtml(productId)}</small>
            </td>
            <td>${escapeHtml(product?.price || '')}</td>
            <td>
              ${trackedTime ? escapeHtml(trackedTime) : 'Not tracked for old entry'}
              ${!trackedTime && oldTime ? `<small>Wishlist last changed: ${escapeHtml(oldTime)}</small>` : ''}
            </td>
            <td>${age ? escapeHtml(age) : 'Unknown for old entry'}</td>
            <td>
              ${escapeHtml(purchaseStatus.label)}
              ${purchaseStatus.order?.purchasedAt ? `<small>${escapeHtml(formatIndiaTime(purchaseStatus.order.purchasedAt))}</small>` : ''}
            </td>
            <td>
              ${
                emailUrl
                  ? `<a class="follow-up" href="${escapeHtml(emailUrl)}" target="_blank" rel="noreferrer">Email follow-up</a>`
                  : '<span class="unavailable">Email unavailable</span>'
              }
            </td>
          </tr>`;
      })
    )
    .join('');

  const tableHead = selectedCustomer
    ? '<tr><th>Product</th><th>Price</th><th>Wishlist time</th><th>Wishlist age</th><th>Purchase status</th><th>Follow-up</th></tr>'
    : '<tr><th>Customer</th><th>Product</th><th>Price</th><th>Wishlist time</th><th>Wishlist age</th><th>Purchase status</th><th>Follow-up</th></tr>';
  const dashboardContent = selectedCustomer
    ? `<div class="toolbar"><a class="back" href="/dashboard?session=${encodeURIComponent(session)}">Back to customers</a></div>
       <h2>${escapeHtml(selectedCustomer.displayName || selectedCustomer.email || 'Customer wishlist')}</h2>
       <p><a class="button-link" href="/dashboard.csv?session=${encodeURIComponent(session)}&customer=${encodeURIComponent(selectedCustomer.id)}">Export this customer CSV</a></p>
       ${
         rows
           ? `<table><thead>${tableHead}</thead><tbody>${rows}</tbody></table>`
           : '<div class="empty">No wishlist products found for this customer.</div>'
       }`
    : isAllCustomersView
      ? `<div class="toolbar"><a class="back" href="/dashboard?session=${encodeURIComponent(session)}">Back to customers</a></div>
         <h2>All customers wishlist</h2>
         <p><a class="button-link" href="/dashboard.csv?session=${encodeURIComponent(session)}&view=all">Export all CSV</a></p>
         ${
           rows
             ? `<table><thead>${tableHead}</thead><tbody>${rows}</tbody></table>`
             : '<div class="empty">No customer wishlist data found yet.</div>'
         }`
    : customerCards
      ? `<div class="customer-grid">${customerCards}</div>`
      : '<div class="empty">No customer wishlist data found yet.</div>';

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
          .customer-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
          .customer-card{display:block;background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;text-decoration:none;color:inherit}
          .customer-card:hover{border-color:#111}
          .customer-card strong,.customer-card span,.customer-card b{display:block;margin-top:5px}
          .toolbar{margin-bottom:16px}
          .back,.button-link{color:#111}
          .button-link{display:inline-flex;background:#111;color:#fff;text-decoration:none;border-radius:6px;padding:10px 14px}
          .follow-up{display:inline-flex;white-space:nowrap;background:#111;color:#fff;text-decoration:none;border-radius:6px;padding:9px 12px;font-weight:600}
          .unavailable{color:#8c9196;font-size:13px;white-space:nowrap}
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
            <a class="stat" href="/dashboard?session=${encodeURIComponent(session)}&view=all"><span>All Customers</span><strong>View</strong></a>
          </div>
          ${dashboardContent}
        </main>
      </body>
    </html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

async function exportDashboardCsv(env, session, customerId = '', view = '') {
  const storedShop = await env.WISHLIST_TOKENS.get(adminSessionKey(session || ''));
  if (storedShop !== env.SHOPIFY_SHOP) {
    return new Response('Unauthorized dashboard session. Open the app again from Shopify admin.', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const customers = await getWishlistCustomers(env);
  const selectedCustomer = customerId ? customers.find((customer) => customer.id === customerId) : null;
  const visibleCustomers = selectedCustomer ? [selectedCustomer] : view === 'all' ? customers : [];
  const productIds = [...new Set(visibleCustomers.flatMap((customer) => customer.ids))];
  const products = await getProducts(env, productIds);
  const productById = new Map(products.map((product) => [product.id, product]));
  const purchaseEntries = await Promise.all(
    visibleCustomers.map(async (customer) => [customer.id, await getCustomerPurchases(env, customer.id)])
  );
  const purchasesByCustomer = new Map(purchaseEntries);

  const lines = [
    [
      'Customer Name',
      'Customer Email',
      'Customer Phone',
      'Customer ID',
      'Product Title',
      'Product ID',
      'Product URL',
      'Price',
      'Wishlist Time',
      'Wishlist Age',
      'Wishlist Last Changed',
      'Purchase Status',
      'Purchase Order',
      'Purchase Time',
    ].map(csvEscape).join(','),
  ];

  for (const customer of visibleCustomers) {
    for (const productId of customer.ids) {
      const product = productById.get(productId);
      const detail = customer.details.find((item) => item.productId === productId) || {};
      const purchaseStatus = getPurchaseStatus(
        purchasesByCustomer.get(customer.id) || [],
        productId,
        detail.addedAt
      );
      lines.push(
        [
          customer.displayName || '',
          customer.email || '',
          customer.phone || '',
          customer.id,
          product?.title || productId,
          productId,
          product?.url ? `https://${env.SHOPIFY_SHOP}${product.url}` : '',
          product?.price || '',
          detail.addedAt ? formatIndiaTime(detail.addedAt) : '',
          detail.addedAt ? formatAge(detail.addedAt) : '',
          formatIndiaTime(customer.idsUpdatedAt),
          purchaseStatus.label,
          purchaseStatus.order?.orderName || '',
          purchaseStatus.order?.purchasedAt ? formatIndiaTime(purchaseStatus.order.purchasedAt) : '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }
  }

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="wishlist-dashboard.csv"',
      'Cache-Control': 'no-store',
    },
  });
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
  const scopes = 'read_customers,write_customers,read_products,read_orders,write_app_proxy';
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

  if (url.pathname === '/webhooks/orders') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    return handleOrderWebhook(request, env);
  }

  if (url.pathname === '/auth/start') {
    return handleAuthStart(request, env);
  }

  if (url.pathname === '/auth/callback') {
    return handleAuthCallback(request, env);
  }

  if (url.pathname === '/dashboard') {
    return renderDashboard(
      env,
      url.searchParams.get('session'),
      url.searchParams.get('customer') || '',
      url.searchParams.get('view') || ''
    );
  }

  if (url.pathname === '/dashboard.csv') {
    return exportDashboardCsv(
      env,
      url.searchParams.get('session'),
      url.searchParams.get('customer') || '',
      url.searchParams.get('view') || ''
    );
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
