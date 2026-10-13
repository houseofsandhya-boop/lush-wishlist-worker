(() => {
  const root = document.getElementById('wishlist-page-root');
  if (!root) return;

  const status = root.querySelector('.wishlist-page__status');
  const grid = root.querySelector('.wishlist-page__grid');
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

    .wishlist-page__grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 24px;
    }

    .wishlist-card {
      display: grid;
      gap: 10px;
      color: inherit;
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
