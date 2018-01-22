import {html, render} from './node_modules/lit-html/lit-html.js';

async function start() {
  const initialRender = html`
  <h2>Your notifications</h2>

  <div class="toggle-option">
      <button class="toggle-option__toggle">
          Toggle
      </button>
      <div class="toggle-option__details">
          <h4>Push Notifications</h4>
          <p>Push notifications are enabled. Toggle to no longer receive push notifications on this device.</p>
      </div>
  </div>

  <style>
  :root {
    --padding: 8px;
  }
  
  .toggle-option {
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  .toggle-option__toggle {
    margin-right: var(--padding);
  }

  .toggle-option__details h4, .toggle-option__details p {
    margin: 0;
  }
  </style>
  `;
  render(
      initialRender,
      (document.querySelector('.settings-container') as Element));
}

start();
