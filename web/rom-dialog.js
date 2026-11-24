import { $, run, say } from './dom.js';

export function renderRom(card, available) {
  const active = card?.mode === 'loader' && card.identity?.loader === 'rom';
  const canOpen = available && !['connecting', 'closing'].includes(card.mode);
  $('open-rom').disabled = !canOpen || active;
  $('rom-jedec').disabled = !available || !active;
  $('rom-help').textContent = !card ? 'Ajoute et sélectionne une carte.'
    : active ? 'Session ROM active. Les lectures du contenu flash utilisent le stub standard.'
    : 'Ouvre une session ROM pour identifier la carte ou lire son JEDEC.';
  $('rom-identity').textContent = active
    ? (card.identity.model ?? card.identity.chip) + ' · MAC ' + card.identity.mac : '';
  const jedec = active ? card.observation?.device.jedec : null;
  $('rom-flash-id').textContent = jedec
    ? 'RDID 0x' + jedec.flash_id.toString(16).padStart(6, '0') + ' · ' +
      (jedec.flash_size ? jedec.flash_size / (1024 * 1024) + ' Mio' : 'capacité inconnue')
    : '';
}

export function wireRomDialog({getSelected, hasCard}) {
  const romDialog = $('rom-reset-dialog');
  const romProgress = $('rom-reset-progress');
  const romConfirm = $('rom-reset-confirm');
  const romCancel = $('rom-reset-cancel');
  let romTarget;
  let romAutomatic = false;
  let romConnecting = false;
  let romPortSeen = false;

  $('open-rom').onclick = () => {
    const card = getSelected();
    if (!card || romDialog.open) return;
    romTarget = card;
    romAutomatic = romTarget.canResetIntoRom;
    $('rom-reset-device').textContent = 'Carte : ' + romTarget.name;
    $('rom-reset-auto').hidden = !romAutomatic;
    $('rom-reset-steps').hidden = romAutomatic;
    romConfirm.textContent = romAutomatic ? 'Redémarrer en ROM' : 'Essayer la connexion';
    romProgress.textContent = '';
    romDialog.showModal();
  };

  function matchRomPort(event) {
    return romTarget && (event.target === romTarget.port || event.port === romTarget.port);
  }

  function openRomWhenReady() {
    if (!romPortSeen || !romTarget || romTarget.mode === 'closing' || romTarget.mode === 'connecting' ||
        romTarget.busy || romTarget.requesting || romConnecting) return;
    romPortSeen = false;
    tryOpenRom();
  }

  navigator.serial?.addEventListener('connect', event => {
    if (!romDialog.open || !matchRomPort(event) || romAutomatic || romConnecting) return;
    romPortSeen = true;
    openRomWhenReady();
  });

  async function tryOpenRom() {
    const card = romTarget;
    if (!romDialog.open || romConnecting || !card || !hasCard(card)) return;
    romPortSeen = false;
    romConnecting = romConfirm.disabled = romCancel.disabled = true;
    romProgress.textContent = 'Connexion à la ROM…';
    try {
      const identity = await card.enterRom({reset: romAutomatic});
      if (identity?.loader !== 'rom') throw new Error('La session ROM n’a pas été confirmée.');
      romDialog.close('connected');
      say('Session ROM ouverte sur ' + (identity.model ?? identity.chip) + '.');
    } catch (error) {
      romProgress.textContent = 'Connexion ROM impossible : ' + error.message;
    } finally {
      romConnecting = romConfirm.disabled = romCancel.disabled = false;
    }
  }

  romDialog.querySelector('form').onsubmit = event => {
    if (event.submitter === romCancel) return;
    event.preventDefault();
    tryOpenRom();
  };
  romDialog.oncancel = event => {
    if (romConnecting) event.preventDefault();
  };
  romDialog.onclose = () => {
    romTarget = null;
    romPortSeen = false;
  };
  $('rom-jedec').onclick = () => run(() => getSelected()?.readRomJedec());

  return card => {
    if (card === romTarget && romPortSeen) queueMicrotask(openRomWhenReady);
  };
}
