document.querySelector('.nav-hamburger')?.addEventListener('click', event => {
  const expanded = event.currentTarget.getAttribute('aria-expanded') === 'true';
  event.currentTarget.setAttribute('aria-expanded', String(!expanded));
  document.querySelector('.nav-links')?.classList.toggle('is-open', !expanded);
});

for (const selector of ['.colour-options', '.storage-options', '.contract-options', '.topup-options', '.threshold-options']) {
  document.querySelectorAll(selector).forEach(group => {
    group.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', () => {
        group.querySelectorAll('button').forEach(option => option.classList.remove('active'));
        button.classList.add('active');
        const price = document.getElementById('price-upfront');
        if (price && button.dataset.upfront) {
          price.textContent = button.dataset.upfront;
          document.querySelector('[data-paylater-message]')?.setAttribute('data-paylater-amount', button.dataset.upfront);
        }
        if (button.dataset.price) {
          document.getElementById('plan-price').textContent = button.dataset.price;
          document.getElementById('contract-summary').textContent = button.dataset.label;
          const badge = document.getElementById('discount-badge');
          badge.style.display = Number(button.dataset.discount) ? '' : 'none';
          badge.querySelector('.saving-badge').textContent = `Save ${button.dataset.discount}% vs monthly`;
        }
        if (button.dataset.amount) {
          document.getElementById('topup-display').textContent = button.dataset.amount;
          document.getElementById('summary-amount').textContent = button.dataset.amount;
        }
        if (button.dataset.threshold) document.getElementById('summary-threshold').textContent = button.dataset.threshold;
      });
    });
  });
}

document.getElementById('add-to-basket')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  const feedback = document.getElementById('basket-feedback');
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    const response = await fetch('/cart/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: button.dataset.deviceId,
        storageIndex: Number(document.querySelector('.storage-pill.active')?.dataset.storageIndex || 0),
        colour: document.querySelector('.colour-pill.active')?.dataset.colour,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not add this device. Please try again.');
    const link = document.querySelector('.nav-cart');
    let badge = link.querySelector('.nav-cart-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-cart-count';
      link.appendChild(badge);
    }
    badge.textContent = result.cartCount;
    feedback.textContent = 'Added to basket';
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    feedback.style.display = 'block';
    button.disabled = false;
    button.textContent = 'Add to basket';
  }
});
