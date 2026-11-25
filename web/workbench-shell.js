import { $ } from './dom.js';

export const externallyControlled = card => Boolean(card?.identity && card.observation?.external_control);

function wireTabs(attribute) {
  const tabs = [...document.querySelectorAll('[' + attribute + ']')];
  function select(tab) {
    if (tab.disabled) return;
    for (const element of tabs) {
      const active = element === tab;
      element.setAttribute('aria-selected', active);
      element.tabIndex = active ? 0 : -1;
      $(element.getAttribute('aria-controls')).hidden = !active;
    }
  }
  for (const tab of tabs) {
    tab.onclick = () => select(tab);
    tab.onkeydown = event => {
      const enabled = tabs.filter(element => !element.disabled);
      const index = enabled.indexOf(tab);
      if (index === -1) return;
      const last = enabled.length - 1;
      const target = {ArrowLeft: (index + last) % enabled.length, ArrowRight: (index + 1) % enabled.length,
        Home: 0, End: last}[event.key];
      if (target === undefined) return;
      event.preventDefault();
      select(enabled[target]);
      enabled[target].focus();
    };
  }
}

async function checkServer() {
  const alert = $('server-alert');
  let message;
  try {
    const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    message = response.ok ? '' : 'Service IDLab indisponible.';
  } catch {
    message = 'Connexion au serveur perdue.';
  }
  if (alert.textContent !== message) alert.textContent = message;
  setTimeout(checkServer, 5000);
}

export function wireWorkbenchShell(cards) {
  let apiActive = false;
  const needsWakeLock = () => apiActive || [...cards.values()].some(card =>
    card.requesting || card.busy || card.mode === 'connecting' || card.mode === 'closing' ||
    (card.identity && (['busy', 'stopping'].includes(card.observation?.device.control) || externallyControlled(card))));
  let wakeLock;
  let requestingWakeLock = false;

  async function updateWakeLock() {
    if (wakeLock && (!needsWakeLock() || document.hidden)) await wakeLock.release();
    if (needsWakeLock() && !document.hidden && navigator.wakeLock && !wakeLock && !requestingWakeLock) {
      requestingWakeLock = true;
      renderWakeState();
      try {
        const lock = await navigator.wakeLock.request('screen');
        wakeLock = lock;
        lock.addEventListener('release', () => {
          if (wakeLock === lock) wakeLock = null;
          renderWakeState();
        }, {once: true});
        if (!needsWakeLock() || document.hidden) await lock.release();
      } catch {
        wakeLock = null;
      } finally {
        requestingWakeLock = false;
      }
    }
    renderWakeState();
  }

  function renderWakeState() {
    const active = needsWakeLock();
    const label = $('status-label-control');
    const controlState = active ? 'Opération en cours' : 'Disponible';
    if (label.textContent !== controlState) {
      label.textContent = controlState;
      $('status-icon-control').setAttribute('href', active ? '#icon-busy' : '#icon-check');
    }
    const state = !active ? 'Veille normale'
      : wakeLock && !wakeLock.released ? 'Maintien éveillé'
      : requestingWakeLock ? 'Activation du maintien éveillé…' : 'Maintien éveillé indisponible';
    $('wake-state').textContent = state;
  }
  document.addEventListener('visibilitychange', updateWakeLock);

  function watchApiActivity() {
    const url = new URL('/api/v1/activity', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    socket.onmessage = event => {
      apiActive = JSON.parse(event.data).active === true;
      void updateWakeLock();
    };
    socket.onclose = () => {
      apiActive = false;
      void updateWakeLock();
      setTimeout(watchApiActivity, 2000);
    };
  }

  wireTabs('data-workspace-tab');
  wireTabs('data-tab');

  const bands = [...document.querySelectorAll('[data-status]')];
  function selectBand(active) {
    for (const button of bands) {
      button.setAttribute('aria-expanded', button === active);
      $(button.getAttribute('aria-controls')).hidden = button !== active;
    }
  }
  for (const button of bands) button.onclick = () => selectBand(button.getAttribute('aria-expanded') === 'true' ? null : button);
  for (const button of document.querySelectorAll('[data-close-status]')) {
    button.onclick = () => { selectBand(null); $('status-' + button.dataset.closeStatus).focus(); };
  }
  const bankInfo = $('bank-info');
  document.addEventListener('pointerdown', event => {
    if (bankInfo.open && !bankInfo.contains(event.target)) bankInfo.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (bankInfo.open) {
      bankInfo.open = false;
      bankInfo.querySelector('summary').focus();
    } else selectBand(null);
  });
  void checkServer();
  watchApiActivity();

  return updateWakeLock;
}
