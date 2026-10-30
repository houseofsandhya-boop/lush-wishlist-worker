(() => {
  const root = document.getElementById('wishlist-page-root');
  if (!root) return;

  const status = root.querySelector('.wishlist-page__status');
  const grid = root.querySelector('.wishlist-page__grid');
  const consent = root.querySelector('.wishlist-page__consent');
  const consentInput = root.querySelector('.wishlist-page__consent-input');
  const consentStatus = root.querySelector('.wishlist-page__consent-status');
  const loginUrl = root.dataset.loginUrl || '/account/login';
  const emptyText = root.dataset.emptyText || 'Your wishlist is empty.';

  const styles = document.createElement('style');
  styles.textContent = `
    .wishlist-page {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 20px;
    }

    .wishlist-page__heading {
      margin: 0 0 24px;
    }

    .wishlist-page__status {
      padding: 24px 0;
    }

    .wishlist-page__consent {
      max-width: 640px;
      margin: 0 0 24px;
      padding: 16px;
      border: 1px solid rgba(0, 0, 0, 0.16);
      background: #fff;
    }

    .wishlist-page__consent-label {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-weight: 600;
      cursor: pointer;
    }

    .wishlist-page__consent-input {
      width: 18px;
      height: 18px;
      margin: 1px 0 0;
      flex: 0 0 auto;
    }

    .wishlist-page__consent-help,
    .wishlist-page__consent-status {
      margin: 7px 0 0 28px;
      font-size: 13px;
      opacity: 0.72;
    }

    .wishlist-page__consent-status {
      min-height: 18px;
    }

    .wishlist-page__grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 220px));
      justify-content: start;
      align-items: start;
      gap: 28px 18px;
    }

    .wishlist-card {
      display: grid;
      gap: 10px;
      color: inherit;
      max-width: 220px;
    }

    .wishlist-card__image {
      width: 100%;
      aspect-ratio: 3 / 4;
      object-fit: cover;
      background: #f4f4f4;
    }

    .wishlist-card__title {
      margin: 0;
      font: inherit;
      font-weight: 600;
    }

    .wishlist-card__price {
      margin: 0;
      opacity: 0.75;
    }

    .wishlist-card__remove {
      min-height: 40px;
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
    }

    @media (max-width: 749px) {
      .wishlist-page {
        padding: 24px 14px;
      }

      .wishlist-page__grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 22px 12px;
      }

      .wishlist-card {
        max-width: none;
      }
    }
  `;
  document.head.appendChild(styles);

  const request = async (path, options = {}) => {
    const { redirectOnAuth = false, ...fetchOptions } = options;
    const response = await fetch(`/apps/wishlist${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...fetchOptions,
    });

    if (response.status === 401) {
      if (redirectOnAuth) {
        window.location.href = loginUrl;
      }
      return null;
    }

    if (!response.ok) throw new Error('Wishlist request failed');
    return response.json();
  };

  const render = (products) => {
    if (!products.length) {
      status.textContent = emptyText;
      grid.hidden = true;
      return;
    }

    status.hidden = true;
    grid.hidden = false;
    grid.innerHTML = '';

    for (const product of products) {
      const card = document.createElement('article');
      card.className = 'wishlist-card';

      const link = document.createElement('a');
      link.href = product.url;

      if (product.image) {
        const image = document.createElement('img');
        image.className = 'wishlist-card__image';
        image.src = product.image;
        image.alt = product.imageAlt || product.title;
        image.loading = 'lazy';
        link.appendChild(image);
      }

      const title = document.createElement('p');
      title.className = 'wishlist-card__title';
      title.textContent = product.title;

      const price = document.createElement('p');
      price.className = 'wishlist-card__price';
      price.textContent = product.price || '';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'wishlist-card__remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        await request('/remove', {
          redirectOnAuth: true,
          method: 'POST',
          body: JSON.stringify({ productId: product.id }),
        });
        card.remove();
        if (!grid.children.length) {
          status.hidden = false;
          status.textContent = emptyText;
          grid.hidden = true;
        }
      });

      card.append(link, title, price, remove);
      grid.appendChild(card);
    }
  };

  consentInput?.addEventListener('change', async () => {
    const subscribed = consentInput.checked;
    consentInput.disabled = true;
    consentStatus.textContent = 'Saving...';
    try {
      const data = await request('/consent', {
        redirectOnAuth: true,
        method: 'POST',
        body: JSON.stringify({ subscribed }),
      });
      if (!data) return;
      consentInput.checked = Boolean(data.subscribed);
      consentStatus.textContent = data.subscribed
        ? 'Wishlist email reminders are on.'
        : 'Wishlist email reminders are off.';
    } catch {
      consentInput.checked = !subscribed;
      consentStatus.textContent = 'Unable to save your email preference. Please try again.';
    } finally {
      consentInput.disabled = false;
    }
  });

  request('/consent')
    .then((data) => {
      if (!data || !consent || !consentInput) return;
      consent.hidden = false;
      consentInput.checked = Boolean(data.subscribed);
      consentInput.disabled = !data.hasEmail;
      consentStatus.textContent = data.hasEmail
        ? data.subscribed
          ? 'Wishlist email reminders are on.'
          : 'Wishlist email reminders are off.'
        : 'Add an email address to your customer account to enable reminders.';
    })
    .catch(() => {});

  request('')
    .then((data) => {
      if (!data) {
        status.textContent = 'Log in to view your wishlist.';
        return;
      }
      render(data.products || []);
    })
    .catch(() => {
      status.textContent = 'Unable to load wishlist.';
    });
})();
