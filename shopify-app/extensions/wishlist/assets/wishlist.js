(() => {
  const contextEl = document.getElementById('wishlist-app-context');
  if (!contextEl) return;

  let context;
  try {
    context = JSON.parse(contextEl.textContent || '{}');
  } catch {
    return;
  }

  const productCache = new Map();
  const pendingProducts = new Set();
  let wishlistIds = [];
  const isProductPage = Boolean(context.productId);

  const style = document.createElement('style');
  style.textContent = `
    .wishlist-app-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      width: 100%;
      margin-top: 12px;
      padding: 12px 18px;
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      text-transform: inherit;
    }

    .wishlist-app-card-button {
      position: absolute;
      z-index: 3;
      top: 10px;
      right: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.92);
      color: #111;
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    }

    .wishlist-app-product-heart {
      position: absolute;
      z-index: 4;
      top: 14px;
      right: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 42px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.96);
      color: #111;
      cursor: pointer;
      font-size: 22px;
      line-height: 1;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
    }

    @media (max-width: 749px) {
      .wishlist-app-product-heart {
        top: 10px;
        right: 10px;
      }
    }

    .wishlist-app-button[aria-pressed="true"],
    .wishlist-app-card-button[aria-pressed="true"],
    .wishlist-app-product-heart[aria-pressed="true"] {
      background: #111;
      color: #fff;
    }
  `;
  document.head.appendChild(style);

  const request = async (path, options = {}) => {
    const { redirectOnAuth = false, ...fetchOptions } = options;
    const response = await fetch(`/apps/wishlist${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...fetchOptions,
    });

    if (response.status === 401) {
      if (redirectOnAuth) {
        window.location.href = context.loginUrl || '/account/login';
      }
      return null;
    }

    if (!response.ok) throw new Error('Wishlist request failed');
    return response.json();
  };

  const productGid = (id) => `gid://shopify/Product/${id}`;

  const buttonLabels = {
    add: context.buttonLabel || 'Add to wishlist',
    added: context.addedLabel || 'Added to wishlist',
  };

  const setPressed = (button, isAdded) => {
    button.dataset.added = isAdded ? 'true' : 'false';
    button.setAttribute('aria-pressed', isAdded ? 'true' : 'false');

    if (button.classList.contains('wishlist-app-button')) {
      button.textContent = isAdded ? buttonLabels.added : buttonLabels.add;
      return;
    }

    button.textContent = isAdded ? '♥' : '♡';
    button.setAttribute('aria-label', isAdded ? 'Remove from wishlist' : 'Add to wishlist');
    button.setAttribute('title', isAdded ? 'Remove from wishlist' : 'Add to wishlist');
  };

  const syncButtons = (id, isAdded) => {
    document.querySelectorAll(`[data-wishlist-product-id="${id}"]`).forEach((item) => setPressed(item, isAdded));
  };

  const toggleProduct = async (button, id) => {
    const gid = productGid(id);
    const isAdded = button.dataset.added === 'true';
    const nextIds = isAdded
      ? wishlistIds.filter((productId) => productId !== gid)
      : [...new Set([...wishlistIds, gid])];
    const previousIds = wishlistIds;

    if (pendingProducts.has(gid)) return;
    pendingProducts.add(gid);
    wishlistIds = nextIds;
    syncButtons(id, !isAdded);

    try {
      const action = isAdded ? '/remove' : '/add';
      await request(action, {
        redirectOnAuth: true,
        method: 'POST',
        body: JSON.stringify({ productId: gid }),
      });
    } catch {
      wishlistIds = previousIds;
      syncButtons(id, isAdded);
    } finally {
      pendingProducts.delete(gid);
    }
  };

  const productHandleFromUrl = (href) => {
    try {
      const url = new URL(href, window.location.origin);
      const match = url.pathname.match(/\/products\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  };

  const fetchProductByHandle = async (handle) => {
    if (productCache.has(handle)) return productCache.get(handle);

    const promise = fetch(`/products/${encodeURIComponent(handle)}.js`, {
      credentials: 'same-origin',
    })
      .then((response) => {
        if (!response.ok) throw new Error('Product lookup failed');
        return response.json();
      })
      .then((product) => ({ id: product.id, handle }));

    productCache.set(handle, promise);
    return promise;
  };

  const findProductCard = (link) =>
    link.closest(
      '.wishlist-card, .card-wrapper, .card, .product-card, .product-item, .product-grid-item, .grid__item, [class*="product-card"], [class*="product-item"], li, article'
    ) || link.parentElement;

  const mountCardButtons = (root = document, minTop = 0) => {
    const links = [...root.querySelectorAll('a[href*="/products/"]')];

    for (const link of links) {
      if (minTop && link.getBoundingClientRect().top + window.scrollY < minTop) continue;
      const handle = productHandleFromUrl(link.href);
      if (!handle) continue;

      const card = findProductCard(link);
      if (!card || card.dataset.wishlistMounted === 'true') continue;
      card.dataset.wishlistMounted = 'true';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wishlist-app-card-button';
      button.textContent = '♡';
      button.setAttribute('aria-label', 'Add to wishlist');

      if (getComputedStyle(card).position === 'static') {
        card.style.position = 'relative';
      }

      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();

        try {
          const product = await fetchProductByHandle(handle);
          button.dataset.wishlistProductId = String(product.id);
          await toggleProduct(button, product.id);
        } catch {
          button.textContent = '!';
        }
      });

      card.appendChild(button);

      fetchProductByHandle(handle)
        .then((product) => {
          button.dataset.wishlistProductId = String(product.id);
          setPressed(button, wishlistIds.includes(productGid(product.id)));
        })
        .catch(() => {});
    }
  };

  const mountProductPageCards = () => {
    const roots = [
      ...document.querySelectorAll(
        'product-recommendations,.product-recommendations,[id*="recommend"],[class*="recommend"]'
      ),
    ];
    document.querySelectorAll('h2,h3').forEach((heading) => {
      if (!/you may also like|recommend/i.test(heading.textContent || '')) return;
      const section = heading.closest('section,.shopify-section,div');
      if (section) roots.push(section);
      mountCardButtons(document, heading.getBoundingClientRect().bottom + window.scrollY);
    });
    [...new Set(roots)].forEach((root) => mountCardButtons(root));
  };

  const mountProductPageButton = () => {
    if (!context.productId) return;

    const id = context.productId;
    const gid = productGid(id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wishlist-app-button';
    button.dataset.wishlistProductId = String(id);

    setPressed(button, wishlistIds.includes(gid));

    const form = document.querySelector('form[action*="/cart/add"]');
    if (!form || form.parentElement?.querySelector('.wishlist-app-button')) return;
    form.insertAdjacentElement('afterend', button);

    button.addEventListener('click', () => toggleProduct(button, id));
  };

  const productMediaSelector =
    '[data-product-media-gallery],media-gallery,.product__media-wrapper,.product-media-wrapper,.product-gallery';

  const findProductMediaBlock = () => {
    const candidates = [...document.querySelectorAll(productMediaSelector)].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 240 && rect.height >= 240 && rect.top > -120 && element.querySelector('img');
    });

    if (candidates.length) {
      return candidates.sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return bRect.width * bRect.height - aRect.width * aRect.height;
      })[0];
    }

    const image = [...document.querySelectorAll('img')]
      .filter((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width >= 240 && rect.height >= 240 && rect.top > 0;
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return bRect.width * bRect.height - aRect.width * aRect.height;
      })[0];

    return (
      image?.closest('.product__media, .product-media, .product-gallery__media, .product-single__media, .media') ||
      image?.parentElement ||
      null
    );
  };

  const mountProductPageHeart = () => {
    if (!context.productId) return;

    const id = String(context.productId);
    const media = findProductMediaBlock();
    if (!media) return;

    const heart = document.querySelector('.wishlist-app-product-heart') || document.createElement('button');
    const isNew = !heart.parentElement;
    if (isNew) {
      heart.type = 'button';
      heart.className = 'wishlist-app-product-heart';
      heart.addEventListener('click', () => toggleProduct(heart, id));
    }
    heart.dataset.wishlistProductId = id;
    setPressed(heart, wishlistIds.includes(productGid(id)));

    if (getComputedStyle(media).position === 'static') {
      media.style.position = 'relative';
    }

    if (heart.parentElement !== media) media.appendChild(heart);
  };

  const mountAll = () => {
    mountProductPageHeart();
    mountProductPageButton();
    if (isProductPage) {
      mountProductPageCards();
    } else {
      mountCardButtons();
    }
  };

  request('/ids')
    .then((data) => {
      wishlistIds = data?.productIds || [];
      mountAll();
    })
    .catch(() => {
      mountAll();
    });

  if (!isProductPage) {
    window.setTimeout(mountCardButtons, 1000);
    window.setTimeout(mountCardButtons, 3000);
  } else {
    window.setTimeout(mountProductPageHeart, 1000);
    window.setTimeout(mountProductPageHeart, 3000);
    window.setTimeout(mountProductPageCards, 1000);
    window.setTimeout(mountProductPageCards, 3000);
  }
})();
