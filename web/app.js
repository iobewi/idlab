import { BoardConnector } from './board-connector.js';
import { ConsoleBuffer } from './console-buffer.js';
import { BootIdentity } from './boot-identity.js';
import { activeCampaignId } from './campaign-view.js';
import { $, element, number, run, say } from './dom.js';
import { renderConsole, renderConsoleControls, renderFlashProgress, renderJournal, watchConsole, wireConsole } from './console-view.js';
import { renderOperationHistory, renderOperations, renderPartitions, wireOperations } from './operations-view.js';
import { renderRom, wireRomDialog } from './rom-dialog.js';
import { externallyControlled, wireWorkbenchShell } from './workbench-shell.js';
import { renderGuide } from './context-guide.js';

const cards = new Map();
let nextBoardNumber = 1;
let selected = null;
let adding = false;
let choosingPort = false;
const manualConsoleReturn = 'Pour retrouver la console, déconnecte la carte dans IDLab, appuie sur RESET sans maintenir BOOT, puis reconnecte-la.';

async function observeCard(card) {
  const generation = card.identity?.generation;
  if (!generation || card.polling) return;
  card.polling = true;
  try {
    const response = await fetch('/api/v1/devices/' + card.name + '/activity?generation=' + generation);
    if (!response.ok) return;
    const activity = await response.json();
    if (card.identity?.generation !== generation) return;
    const previous = card.observation;
    const controlChanged = previous?.device.control !== activity.device.control ||
      previous?.external_control !== activity.external_control;
    const historyChanged = JSON.stringify(previous?.operations) !== JSON.stringify(activity.operations);
    const journalChanged = previous?.journal.at(-1)?.at !== activity.journal.at(-1)?.at;
    card.observation = activity;
    card.lastJournal = activity.journal;
    if (controlChanged) render();
    else if (card === selected) {
      renderIdentification();
      if (journalChanged) renderJournal(card);
      else renderFlashProgress(card);
      if (historyChanged) {
        renderRom(card, !externallyControlled(card) && !card.busy && !card.requesting);
        renderOperationHistory(card);
      }
    }
  } catch {
    // A disappearing generation or a transient HTTP failure is retried on the next poll.
  } finally {
    card.polling = false;
  }
}
setInterval(() => { for (const card of cards.values()) void observeCard(card); }, 500);

function renderIdentification() {
  const card = selected;
  const current = card?.mode === 'loader' ? card.identity : null;
  const info = current ?? card?.lastIdentity;
  const transport = info?.transport ?? card?.transport;
  const nativeUsb = transport === 'usb_otg' || transport === 'usb_serial_jtag';
  const activeBaud = card?.activeBaud;
  const rate = card?.observation?.operations.find(entry => entry.bytesPerSecond)?.bytesPerSecond;
  const boot = card?.boot;
  const chip = boot?.chip?.toUpperCase().replace(/^ESP32(?=[A-Z])/, 'ESP32-');
  const chipHint = [chip, boot?.revision].filter(Boolean).join(' · ');
  const measuredFlash = info?.flash_size ? info.flash_size / (1024 * 1024) + ' Mio' : null;
  const configuredFlash = boot?.flashMiB ? boot.flashMiB + ' Mio configurés (logs UART)' : null;
  const flash = measuredFlash && configuredFlash && info.flash_size !== boot.flashMiB * 1024 * 1024
    ? measuredFlash + ' mesurés · ' + configuredFlash : measuredFlash ?? configuredFlash;
  for (const [id, value] of Object.entries({
    'status-label-card': card?.name,
    'card-mode-info': card?.mode === 'loader'
      ? (current?.loader === 'stub' ? 'Téléchargement · stub actif' : 'Téléchargement · ROM seule')
      : {console: 'Console série', connecting: 'Détection…', disconnected: 'Déconnectée', closing: 'Déconnexion…'}[card?.mode],
    'chip-info': info?.model ?? info?.chip ?? (chipHint ? chipHint + ' (logs UART)' : null),
    'mac-info': info?.mac,
    'flash-info': flash,
    'rdid-info': info?.flash_id == null ? null : '0x' + info.flash_id.toString(16).padStart(6, '0'),
    'interface-info': [{usb_serial_jtag: 'USB Serial/JTAG', usb_otg: 'USB OTG',
      usb_uart: 'Pont USB–UART'}[transport], card?.portLabel].filter(Boolean).join(' · ') || null,
    'serial-speed-info': activeBaud ? (nativeUsb ? 'USB natif' : number.format(activeBaud) + ' bauds') : null,
    'transfer-rate-info': rate ? number.format(rate / 1024) + ' Kio/s' : null,
  })) $(id).textContent = value ?? '—';

  const hint = $('identity-source');
  hint.textContent = card?.mode === 'console'
    ? (info ? 'Mesures conservées du dernier passage en chargeur sur ce port.'
      : card.canEnterLoader ? 'Identifier mesure la flash, la MAC et le RDID via le chargeur.'
      : 'Pour mesurer l’identité complète, place la carte en téléchargement puis reconnecte-la dans IDLab.')
    : card?.consoleUnavailable && !card.canReturnToConsole
      ? manualConsoleReturn : (current ? 'Identité lue par le chargeur.' : '');
  hint.hidden = !hint.textContent;

}

function render() {
  syncConsole(selected);
  for (const card of cards.values()) {
    const active = card === selected;
    card.row.dataset.selected = active;
    card.nameButton.setAttribute('aria-pressed', active);
    card.status.textContent = {connecting: 'Connexion…', console: 'Connectée', loader: 'Connectée',
      closing: 'Déconnexion…', disconnected: 'Déconnectée'}[card.mode];
    card.status.dataset.state = {console: 'connected', loader: 'connected'}[card.mode] ?? card.mode;
    card.status.disabled = card.busy || card.requesting || card.mode === 'connecting' || card.mode === 'closing';
    card.remove.hidden = card.mode !== 'disconnected';
  }
  $('empty-cards').hidden = cards.size !== 0;
  $('card-details').hidden = !selected;
  const info = selected?.identity;
  const romActive = selected?.mode === 'loader' && info?.loader === 'rom';
  const romTab = $('tab-rom');
  const consolesTab = $('workspace-tab-consoles');
  const consoleUnavailable = Boolean(selected?.consoleUnavailable);
  if (consoleUnavailable && consolesTab.getAttribute('aria-selected') === 'true') {
    const active = document.activeElement;
    const operationsTab = $('workspace-tab-operations');
    const moveFocus = active === consolesTab || $('workspace-consoles').contains(active);
    operationsTab.click();
    if (romActive) romTab.click();
    if (moveFocus) operationsTab.focus();
  }
  consolesTab.disabled = consoleUnavailable;
  consolesTab.title = consoleUnavailable
    ? selected.canReturnToConsole ? 'Utilise « Revenir à la console » dans les commandes de la carte.' : manualConsoleReturn
    : '';
  for (const id of ['tab-partitions', 'tab-flash', 'tab-memory', 'tab-tools']) {
    const tab = $(id);
    if (romActive && tab.getAttribute('aria-selected') === 'true') {
      const active = document.activeElement;
      const panel = $(tab.getAttribute('aria-controls'));
      const moveFocus = active === tab || panel.contains(active);
      romTab.click();
      if (moveFocus) romTab.focus();
    }
    tab.disabled = romActive;
    tab.title = romActive ? 'Indisponible pendant la session ROM seule.' : '';
  }
  renderIdentification();
  const external = externallyControlled(selected);
  const available = selected && !external && !selected.busy && !selected.requesting;
  const loader = available && selected.mode === 'loader';
  renderRom(selected, available);
  const autoLoader = available && selected.mode === 'console' && selected.canEnterLoader;
  const canRead = autoLoader || (loader && info?.capabilities.includes('flash.read'));
  $('read').disabled = !canRead;
  renderPartitions(selected, canRead);
  const flashHint = $('flash-availability');
  flashHint.textContent = selected?.mode === 'connecting' && selected.requesting ? 'Transition console / chargeur…'
    : selected?.mode === 'console' ? (selected.canEnterLoader
      ? 'La lecture passe au chargeur puis revient en console. La carte peut redémarrer.'
      : 'Place la carte en téléchargement, puis reconnecte-la dans IDLab.')
    : selected?.mode === 'loader' && info?.loader === 'rom' ? 'ROM active. Le stub requis pour cette lecture est indisponible ou désactivé.'
    : selected?.mode === 'loader' && !info?.flash_size ? 'Capacité flash inconnue. Vérifie le RDID et la connexion à la flash.'
    : '';
  flashHint.hidden = !flashHint.textContent;
  const reset = $('reset-device');
  reset.disabled = !(available && selected.mode === 'console' && selected.resetWait);
  reset.textContent = selected?.resetWait === 200 ? 'Reset USB' : 'Reset EN';
  reset.title = consoleUnavailable ? consolesTab.title : 'Redémarre la carte depuis la console.';
  $('identify-live').disabled = !(loader || autoLoader);
  const modeButton = $('enter-loader');
  modeButton.textContent = selected?.mode === 'loader' ? 'Revenir à la console' : 'Ouvrir le chargeur flash';
  modeButton.disabled = !(autoLoader || (available && selected.canReturnToConsole));
  renderConsoleControls(selected, available);
  $('control-state').textContent = selected?.observation?.device.control === 'stopping' ? 'Arrêt en cours'
    : selected?.observation?.device.control === 'busy' || selected?.requesting ? 'Opération en cours' : external ? 'Pilotage externe' : 'Disponible';
  $('grant').disabled = !selected?.identity || selected.hasControlToken || !['console', 'loader'].includes(selected.mode);
  $('revoke').disabled = !selected?.hasControlToken;
  $('release-control').disabled = !external || selected?.observation?.device.control === 'stopping';
  $('grant-state').textContent = selected?.hasControlToken ? 'Jeton émis' : 'Aucun jeton';
  void updateWakeLock();
  renderConsole(selected);
  renderOperations(selected);
  renderJournal(selected);
  renderGuide(selected, choosingPort);
}

function addCard(name, port, flashBaud) {
  const card = new BoardConnector(name, port, {
    flashBaud,
    campaignId: () => activeCampaignId,
    onLinkLost: () => say('Liaison perdue avec « ' + name + ' ».'),
    onChange: () => {
      if (!card.identity) card.observation = null;
      render();
      onRomCardChange(card);
    },
  });
  Object.assign(card, {follow: true, pausedAt: null, capture: new ConsoleBuffer(), boot: new BootIdentity()});
  const row = element('div', undefined, 'active-board');
  card.row = row;
  card.nameButton = element('button', name, 'board-name');
  card.status = element('button', '', 'board-status');
  card.remove = element('button', 'Retirer');
  card.nameButton.onclick = () => {
    if (selected !== card) say('');
    selected = card;
    render();
    void observeCard(card);
  };
  card.status.onclick = () => run(() => card.mode === 'disconnected' ? connectCard(card) : card.disconnect());
  card.remove.onclick = () => run(async () => {
    await card.disconnect();
    cards.delete(name);
    row.remove();
    if (selected === card) selected = cards.values().next().value ?? null;
    render();
  });
  row.append(card.nameButton, card.status, card.remove);
  $('active-cards').append(row);
  cards.set(name, card);
  selected = card;
  return card;
}

async function controlAction(action) {
  const card = selected;
  if (!card) return;
  const response = await fetch('/api/v1/devices/' + card.name + '/control/' + action, {method: 'POST'});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? ('HTTP ' + response.status));
  if (result.token) {
    $('control-token-card').textContent = card.name;
    $('control-token').value = result.token;
    $('control-token-feedback').textContent = '';
    $('control-token-dialog').showModal();
  } else if (action === 'revoke' && card.mode === 'disconnected') {
    card.hasControlToken = false;
    render();
  }
}
$('grant').onclick = () => run(() => controlAction('token'));
$('revoke').onclick = () => run(() => controlAction('revoke'));
$('release-control').onclick = () => run(() => controlAction('stop'));
$('control-token-copy').onclick = async () => {
  const dialog = $('control-token-dialog');
  const input = $('control-token');
  const token = input.value;
  if (!dialog.open || !token) return;
  try {
    await navigator.clipboard.writeText(token);
    if (dialog.open && input.value === token) $('control-token-feedback').textContent = 'Jeton copié.';
  } catch {
    if (!dialog.open || input.value !== token) return;
    input.focus();
    input.select();
    $('control-token-feedback').textContent = 'Copie automatique indisponible. Appuie sur Ctrl+C.';
  }
};
$('control-token-dialog').onclose = () => {
  $('control-token').value = '';
  $('control-token-feedback').textContent = '';
};

async function connectCard(card) {
  await card.connect();
  if (card !== selected) return;
  $(card.mode === 'console' ? 'workspace-tab-consoles' : 'workspace-tab-operations').click();
  if (card.identity?.capabilities.includes('flash.read')) $('tab-memory').click();
}

function suggestBoardName() {
  while (cards.has('board_' + nextBoardNumber)) nextBoardNumber++;
  return 'board_' + nextBoardNumber;
}

async function addFromPicker() {
  if (adding) return;
  function feedback(message) {
    $('add-card-feedback').textContent = message;
    say(message);
  }
  const input = $('add-device-id');
  const enteredName = input.value;
  const name = enteredName.trim();
  const flashBaud = Number($('flash-baud').value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name)) return feedback('Saisis un nom de carte valide.');
  if (cards.has(name)) return feedback('Ce nom est déjà utilisé.');
  if (!flashBaud) return feedback('Choisis un débit flash.');
  if (!navigator.serial) return feedback('Web Serial est indisponible dans ce navigateur.');
  adding = $('add-device').disabled = true;
  try {
    say('');
    $('add-card-feedback').textContent = '';
    choosingPort = true;
    renderGuide(selected, choosingPort);
    const port = await navigator.serial.requestPort();
    choosingPort = false;
    if ([...cards.values()].some(card => card.port === port)) return feedback('Ce port est déjà associé à une carte.');
    const card = addCard(name, port, flashBaud);
    if (input.value === enteredName) input.value = suggestBoardName();
    await connectCard(card);
    $('add-card-feedback').textContent = '';
  } catch (error) {
    feedback(error.name === 'NotFoundError' ? 'Aucun port sélectionné.' : error.message);
  } finally {
    adding = $('add-device').disabled = false;
    choosingPort = false;
    renderGuide(selected, choosingPort);
  }
}
$('add-device').onclick = addFromPicker;
$('add-device-id').onkeydown = event => { if (event.key === 'Enter') addFromPicker(); };
navigator.serial?.addEventListener('disconnect', event => {
  for (const card of cards.values()) {
    if (event.target === card.port || event.port === card.port) run(() => card.disconnect(true));
  }
});

$('reset-device').onclick = () => run(() => selected?.restart());
$('enter-loader').onclick = () => run(async () => {
  const card = selected;
  if (!card || $('enter-loader').disabled) return;
  if (card.mode === 'loader') {
    await card.returnConsole();
    if (card === selected) $('workspace-tab-consoles').click();
  } else {
    try {
      await card.enterLoader();
    } catch (error) {
      const messages = {
        'Failed to connect with the device': 'La carte ne répond pas en mode téléchargement.',
        device_command_timeout: 'Le connecteur série n’a pas répondu à temps.',
        device_session_changed: card.lost ? 'Le port USB s’est déconnecté pendant la bascule.'
          : 'La session de la carte a été interrompue.',
      };
      const detail = messages[error.message] ?? error.message;
      throw new Error('Impossible d’ouvrir le chargeur sur « ' + card.name + ' ». ' + detail);
    }
    if (card !== selected) return;
    $('workspace-tab-operations').click();
    $('tab-memory').click();
  }
});
$('identify-live').onclick = () => run(async () => {
  const identity = await selected?.identify();
  if (identity) say((identity.model ?? identity.chip) + ' · MAC ' + identity.mac);
});

const getSelected = () => selected;
const syncConsole = watchConsole(card => {
  renderIdentification();
  renderConsole(card);
});
const updateWakeLock = wireWorkbenchShell(cards);
const onRomCardChange = wireRomDialog({getSelected, hasCard: card => cards.get(card.name) === card});
wireConsole({getSelected, render, observeCard});
wireOperations({getSelected, render, observeCard});

const emptyCards = element('p', 'Aucune carte connectée dans cette fenêtre.', 'hint');
emptyCards.id = 'empty-cards';
$('active-cards').replaceChildren(emptyCards);
$('add-device-id').value = suggestBoardName();
$('server-origin').textContent = location.origin;
render();
