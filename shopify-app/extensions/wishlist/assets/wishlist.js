(() => {
  const contextNode = document.getElementById('wishlist-app-context');
  if (!contextNode || location.pathname.replace(/\/+$/, '') === '/cart') return;

  let context;
  try {
    context = JSON.parse(contextNode.textContent || '{}');
  } catch {
    return;
  }

  const gidPrefix = 'gid://shopify/Product/';
  const cardSelector = 'product-card[data-product-id],.product-card[data-product-id]';
  const buttonSelector = '.wishlist-app-button,.wishlist-app-card-button,.wishlist-app-product-heart';
  const cartSelector = 'cart-drawer,cart-items,mini-cart,[data-cart-drawer],[data-cart-items],[class*="cart-drawer" i],[class*="mini-cart" i]';
  const cacheKey = `lush-wishlist:${context.customerId || 'guest'}`;
  const labels = {
    add: context.buttonLabel || 'Add to wishlist',
    added: context.addedLabel || 'Added to wishlist',
  };
  const pending = new Map();
  const mountQueue = new Set();
  let productMedia;
  let frame;

  const normalizeId = (value) => {
    const match = String(value || '').match(/(\d+)$/);
    return match ? match[1] : '';
  };
  const gid = (id) => `${gidPrefix}${id}`;

  const loadCache = () => {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}');
      return Date.now() - cached.savedAt < 86400000 && Array.isArray(cached.ids) ? cached.ids : [];
    } catch {
      return [];
    }
  };
  let wishlistIds = new Set(loadCache());

  const saveCache = () => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ids: [...wishlistIds], savedAt: Date.now() }));
    } catch {}
  };

  const request = async (path, options = {}) => {
    const { redirectOnAuth = false, ...fetchOptions } = options;
    const response = await fetch(`/apps/wishlist${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...fetchOptions,
    });
    if (response.status === 401) {
      if (redirectOnAuth) location.href = context.loginUrl || '/account/login';
      return null;
    }
    if (!response.ok) throw new Error('Wishlist request failed');
    return response.json();
  };

  const setPressed = (button, added) => {
    const pressed = String(added);
    button.dataset.added = pressed;
    button.setAttribute('aria-pressed', pressed);
    if (button.classList.contains('wishlist-app-button')) {
      button.textContent = added ? labels.added : labels.add;
      return;
    }
    const label = added ? 'Remove from wishlist' : 'Add to wishlist';
    button.textContent = added ? '♥' : '♡';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  };

  const syncButtons = (id) => {
    const added = wishlistIds.has(gid(id));
    document.querySelectorAll(`[data-wishlist-product-id="${id}"]`).forEach((button) => setPressed(button, added));
  };

  const syncAll = () => {
    document.querySelectorAll(buttonSelector).forEach((button) => {
      const id = normalizeId(button.dataset.wishlistProductId);
      if (id) setPressed(button, wishlistIds.has(gid(id)));
    });
  };

  const setState = (id, added) => {
    if (added) wishlistIds.add(gid(id));
    else wishlistIds.delete(gid(id));
    saveCache();
    syncButtons(id);
  };

  const toggle = async (button) => {
    const id = normalizeId(button.dataset.wishlistProductId);
    if (!id) return;
    const productGid = gid(id);
    const fallback = wishlistIds.has(productGid);
    const target = !fallback;
    const active = pending.get(productGid);
    setState(id, target);
    if (active) {
      active.target = target;
      return;
    }

    const state = { target };
    pending.set(productGid, state);
    try {
      let sent;
      do {
        sent = state.target;
        await request(sent ? '/add' : '/remove', {
          redirectOnAuth: true,
          method: 'POST',
          body: JSON.stringify({ productId: productGid }),
        });
      } while (sent !== state.target);
    } catch {
      setState(id, fallback);
    } finally {
      if (pending.get(productGid) === state) pending.delete(productGid);
    }
  };

  const createButton = (className, id) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.wishlistProductId = id;
    setPressed(button, wishlistIds.has(gid(id)));
    return button;
  };

  const mountCard = (card) => {
    if (card.closest(cartSelector)) return;
    const id = normalizeId(card.dataset.productId);
    if (!id) return;
    const buttons = [...card.querySelectorAll(':scope > .wishlist-app-card-button')];
    const button = buttons.shift() || createButton('wishlist-app-card-button', id);
    buttons.forEach((duplicate) => duplicate.remove());
    button.dataset.wishlistProductId = id;
    setPressed(button, wishlistIds.has(gid(id)));
    if (!button.parentElement) card.appendChild(button);
  };

  const mountCards = (root = document) => {
    if (root.matches?.(cardSelector)) mountCard(root);
    root.querySelectorAll?.(cardSelector).forEach(mountCard);
  };

  const findProductMedia = () => {
    if (productMedia?.isConnected) return productMedia;
    const selector = '[data-product-media-gallery],media-gallery,.product__media-wrapper,.product-media-wrapper,.product-gallery';
    productMedia = [...document.querySelectorAll(selector)]
      .filter((element) => element.querySelector('img') && !element.closest('product-recommendations,.product-recommendations'))
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    return productMedia;
  };

  const mountProductControls = () => {
    const id = normalizeId(context.productId);
    if (!id) return;
    const form = document.querySelector('form[action*="/cart/add"]');
    const productButton = document.querySelector('.wishlist-app-button');
    if (!context.showProductButton) productButton?.remove();
    else if (form && !productButton) {
      form.insertAdjacentElement('afterend', createButton('wishlist-app-button', id));
    }
    const media = findProductMedia();
    if (!media) return;
    let heart = document.querySelector('.wishlist-app-product-heart');
    if (!heart) heart = createButton('wishlist-app-product-heart', id);
    heart.dataset.wishlistProductId = id;
    setPressed(heart, wishlistIds.has(gid(id)));
    media.classList.add('wishlist-app-media-host');
    if (heart.parentElement !== media) media.appendChild(heart);
  };

  const scheduleMount = (root) => {
    if (root) mountQueue.add(root);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const roots = [...mountQueue];
      mountQueue.clear();
      roots.forEach(mountCards);
      if (context.productId) mountProductControls();
    });
  };

  document.addEventListener('click', (event) => {
    const button = event.target.closest(buttonSelector);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    toggle(button);
  }, true);

  scheduleMount(document);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleMount(document), { once: true });
  }
  window.addEventListener('pageshow', () => {
    scheduleMount(document);
  });

  request('/ids')
    .then((data) => {
      if (!data) return;
      wishlistIds = new Set(data.productIds || []);
      saveCache();
      syncAll();
    })
    .catch(() => {});

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        scheduleMount(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE || node.closest?.(cartSelector)) continue;
        if (node.matches?.(cardSelector) || node.querySelector?.(cardSelector)) {
          scheduleMount(node);
        }
      }
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-product-id'],
  });
})();
