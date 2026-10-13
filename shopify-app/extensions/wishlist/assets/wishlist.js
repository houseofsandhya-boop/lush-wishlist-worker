(() => {
  const contextEl = document.getElementById('wishlist-app-context');
  if (!contextEl) return;

  let context;
  try {
    context = JSON.parse(contextEl.textContent || '{}');
  } catch {
    return;
  }

  if (!context.productId) return;

  const productGid = `gid://shopify/Product/${context.productId}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wishlist-app-button';
  button.textContent = context.buttonLabel || 'Add to wishlist';
  button.setAttribute('aria-pressed', 'false');

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

    .wishlist-app-button[aria-pressed="true"] {
      background: currentColor;
    }
  `;
  document.head.appendChild(style);

  const request = async (path, options = {}) => {
    const response = await fetch(`/apps/wishlist${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });

    if (response.status === 401) {
      window.location.href = context.loginUrl || '/account/login';
      return null;
    }

    if (!response.ok) throw new Error('Wishlist request failed');
    return response.json();
  };

  const setAdded = (isAdded) => {
    button.dataset.added = isAdded ? 'true' : 'false';
    button.setAttribute('aria-pressed', isAdded ? 'true' : 'false');
    button.textContent = isAdded
      ? context.addedLabel || 'Added to wishlist'
      : context.buttonLabel || 'Add to wishlist';
  };

  const mount = () => {
    const form = document.querySelector('form[action*="/cart/add"]');
    if (!form || form.parentElement?.querySelector('.wishlist-app-button')) return;
    form.insertAdjacentElement('afterend', button);
  };

  button.addEventListener('click', async () => {
    const isAdded = button.dataset.added === 'true';
    button.disabled = true;

    try {
      const action = isAdded ? '/remove' : '/add';
      await request(action, {
        method: 'POST',
        body: JSON.stringify({ productId: productGid }),
      });
      setAdded(!isAdded);
    } catch {
      button.textContent = 'Try again';
    } finally {
      button.disabled = false;
    }
  });

  mount();

  request('/ids')
    .then((data) => {
      if (!data) return;
      setAdded((data.productIds || []).includes(productGid));
    })
    .catch(() => {});
})();
