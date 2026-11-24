import { BoardConnector } from './board-connector.js';
import { decodePartitions, PARTITION_TABLE_BYTES } from './partitions.js';

const $ = id => document.getElementById(id);
const cards = new Map();
let selected = null;
let adding = false;
let redrawPending = false;
const say = message => { $('client-state').textContent = message; };
const clock = new Intl.DateTimeFormat('fr', { timeStyle: 'medium' });
const number = new Intl.NumberFormat('fr', {maximumFractionDigits: 1});
const manualConsoleReturn = 'Pour retrouver la console, déconnecte la carte dans IDLab, appuie sur RESET sans maintenir BOOT, puis reconnecte-la.';
const externallyControlled = card => ['external', 'stopping'].includes(card?.control);
let wakeLock;
let requestingWakeLock = false;

async function updateWakeLock() {
  const needed = [...cards.values()].some(externallyControlled);
  if (!needed && wakeLock) await wakeLock.release();
  if (needed && !document.hidden && navigator.wakeLock && !wakeLock && !requestingWakeLock) {
    requestingWakeLock = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        renderWakeState();
      }, {once: true});
      if (![...cards.values()].some(externallyControlled)) await wakeLock.release();
    } catch {
      wakeLock = null;
    } finally {
      requestingWakeLock = false;
    }
  }
  renderWakeState();
}

function renderWakeState() {
  const state = wakeLock ? 'Maintien éveillé'
    : [...cards.values()].some(externallyControlled) ? 'Maintien éveillé indisponible' : 'Veille normale';
  $('status-label-wake').textContent = state;
  $('wake-state').textContent = state;
}
document.addEventListener('visibilitychange', updateWakeLock);

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
document.addEventListener('keydown', event => { if (event.key === 'Escape') selectBand(null); });
$('access-toggle').onclick = event => {
  $('access-panel').hidden = !$('access-panel').hidden;
  event.currentTarget.setAttribute('aria-expanded', !$('access-panel').hidden);
};

function element(tag, content, cls) {
  const el = document.createElement(tag);
  if (content !== undefined) el.textContent = content;
  if (cls) el.className = cls;
  return el;
}

function note(card, message) {
  card.journal.push(clock.format(new Date()) + ' · ' + message);
  if (card.journal.length > 300) card.journal.shift();
  if (card === selected) renderJournal();
}

function renderJournal() {
  const log = $('agent-log');
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  $('agent-log-entries').replaceChildren(...(selected?.journal ?? []).map(line => element('p', line, 'journal-row')));
  renderFlashProgress();
  if (follow) log.scrollTop = log.scrollHeight;
}

function renderFlashProgress() {
  const line = $('agent-read-progress');
  const log = $('agent-log');
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  const progress = selected?.flashProgress;
  line.hidden = !progress;
  if (progress) {
    const {address, received, total} = progress;
    line.textContent = 'Lecture flash à 0x' + address.toString(16) + ' · ' +
      number.format(received) + ' / ' + number.format(total) + ' octets · ' +
      Math.floor(received * 100 / total) + ' %';
  }
  if (follow) log.scrollTop = log.scrollHeight;
}

function renderConsole() {
  const buffer = selected?.capture;
  const timestamps = $('timestamps').checked;
  const rows = buffer?.visible({
    format: $('format-hex').getAttribute('aria-pressed') === 'true' ? 'hex' : 'text',
    query: $('console-search').value, before: selected?.pausedAt ?? Infinity,
  }) ?? [];
  const log = $('uart-log');
  const scroll = log.scrollTop;
  log.replaceChildren(...rows.map(row => {
    const div = element('div', undefined, 'console-row' + (timestamps ? '' : ' no-time'));
    div.append(element('span', row.seq, 'seq'));
    if (timestamps) div.append(element('time', clock.format(new Date(row.at))));
    div.append(element('span', row.kind, 'kind'), element('span', row.display, 'payload'));
    return div;
  }));
  if (!rows.length) log.append(element('p', 'Aucune donnée à afficher.', 'console-empty'));
  log.scrollTop = selected?.follow ? log.scrollHeight : scroll;
  $('capture-state').textContent = buffer?.byteLength ? buffer.byteLength + ' octets capturés'
    : selected?.mode === 'console' ? 'Console ouverte · en attente d’octets UART' : 'Aucune capture';
}

function scheduleConsole(card) {
  if (card !== selected || redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => { redrawPending = false; renderIdentification(); renderConsole(); });
}

function operationDetails(entry) {
  const proof = JSON.stringify(entry, null, 2);
  const row = element('tr', undefined, 'operation-detail-row');
  row.id = 'operation-detail-' + entry.id;
  const cell = element('td');
  cell.colSpan = 6;
  const panel = element('div', undefined, 'operation-proof-panel');
  const toolbar = element('div', undefined, 'operation-proof-toolbar');
  const actions = element('div', undefined, 'operation-proof-actions');
  const copy = element('button', 'Copier le JSON');
  copy.onclick = () => run(async () => {
    await navigator.clipboard.writeText(proof);
    say('JSON de l’opération copié.');
  });
  const save = element('button', 'Télécharger le JSON');
  save.onclick = () => download(new Blob([proof + '\n'], {type: 'application/json'}),
    'idlab-' + entry.device + '-operation-' + entry.id + '.json');
  actions.append(copy, save);
  toolbar.append(element('span', 'Détail de l’opération'), actions);
  panel.append(toolbar, element('pre', proof, 'operation-detail-json result'));
  cell.append(panel);
  row.append(cell);
  return row;
}

function renderOperationHistory() {
  const card = selected;
  const entries = card?.operations ?? [];
  const body = $('operations-body');
  $('empty-operations').hidden = entries.length !== 0;
  body.replaceChildren();
  for (const entry of entries) {
    const row = element('tr');
    for (const value of [entry.id, entry.device, 'Lecture flash', entry.state, entry.duration]) {
      row.append(element('td', value ?? '—'));
    }
    const expanded = card.inspectedOperation === entry;
    const cell = element('td');
    const inspect = element('button', expanded ? 'Masquer' : 'Inspecter');
    inspect.id = 'inspect-operation-' + entry.id;
    inspect.setAttribute('aria-expanded', expanded);
    inspect.setAttribute('aria-label', inspect.textContent + ' l’opération ' + entry.id);
    if (expanded) inspect.setAttribute('aria-controls', 'operation-detail-' + entry.id);
    inspect.onclick = () => {
      card.inspectedOperation = expanded ? null : entry;
      renderOperationHistory();
      $(inspect.id).focus({preventScroll: true});
    };
    cell.append(inspect);
    row.append(cell);
    body.append(row);
    if (expanded) body.append(operationDetails(entry));
  }
}

function renderOperations() {
  renderOperationHistory();
  $('dump-state').textContent = selected?.dump?.summary ?? 'Aucune relecture.';
  $('hex-dump').textContent = selected?.dump?.preview ?? 'Aucune donnée lue.';
  const link = $('download');
  link.replaceChildren();
  if (selected?.dump) {
    const card = selected;
    const button = element('button', 'Télécharger le dump');
    button.onclick = () => download(card.dump.blob, card.dump.filename);
    link.append(button);
  }
}

function renderPartitions(loader) {
  const table = selected?.partitions;
  $('read-partitions').disabled = !loader;
  $('try-partition-address').disabled = !loader;
  $('partition-suggestion').hidden = !selected?.suggestPartition;
  $('partition-state').textContent = selected?.partitionStatus ?? 'Aucune table lue.';
  $('partitions-body').replaceChildren(...(table ?? []).map(part => {
    const row = element('tr');
    const hex = value => '0x' + value.toString(16);
    for (const value of [part.label, hex(part.type) + ' / ' + hex(part.subtype),
      hex(part.address), hex(part.size), hex(part.address + part.size)]) row.append(element('td', value));
    const action = element('td');
    const read = element('button', 'Sélectionner la plage');
    read.onclick = () => {
      $('address').value = hex(part.address);
      $('size').value = hex(part.size);
      $('tab-memory').click();
    };
    action.append(read);
    row.append(action);
    return row;
  }));
}

function renderIdentification() {
  const card = selected;
  const current = card?.mode === 'loader' ? card.identity : null;
  const info = current ?? card?.lastIdentity;
  const transport = info?.transport ?? card?.transport;
  const nativeUsb = transport === 'usb_otg' || transport === 'usb_serial_jtag';
  const activeBaud = card?.activeBaud;
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
    'transfer-rate-info': card?.flashReadRate ? number.format(card.flashReadRate / 1024) + ' Kio/s' : null,
    'footer-target': card?.name,
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

function renderRom(available) {
  const card = selected;
  const active = card?.mode === 'loader' && card.identity?.loader === 'rom';
  const canOpen = available && !['connecting', 'closing'].includes(card.mode);
  $('open-rom').disabled = !canOpen || active;
  $('rom-jedec').disabled = !available || !active;
  $('rom-help').textContent = !card ? 'Ajoute et sélectionne une carte.'
    : active ? 'Session ROM active. Les lectures du contenu flash utilisent le stub standard.'
    : 'Ouvre une session ROM pour identifier la carte ou lire son JEDEC.';
  $('rom-identity').textContent = active
    ? (card.identity.model ?? card.identity.chip) + ' · MAC ' + card.identity.mac : '';
  const jedec = active ? card.romJedec : null;
  $('rom-flash-id').textContent = jedec
    ? 'RDID 0x' + jedec.flash_id.toString(16).padStart(6, '0') + ' · ' +
      (jedec.flash_size ? jedec.flash_size / (1024 * 1024) + ' Mio' : 'capacité inconnue')
    : '';
}

function render() {
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
  renderRom(available);
  const autoLoader = available && selected.mode === 'console' && selected.canEnterLoader;
  const canRead = autoLoader || (loader && info?.capabilities.includes('flash.read'));
  $('read').disabled = !canRead;
  renderPartitions(canRead);
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
  $('send').disabled = !(available && selected.mode === 'console');
  $('mark').disabled = !selected;
  $('export').disabled = !selected;
  $('pause').disabled = !selected;
  $('pause').setAttribute('aria-pressed', selected?.pausedAt != null);
  $('pause').textContent = selected?.pausedAt != null ? 'Reprendre l’affichage' : 'Pause affichage';
  $('follow').hidden = !selected || selected.follow;
  $('follow-state').textContent = selected?.follow ? 'Suivi du direct' : 'Défilement manuel';
  $('status-label-agent').textContent = [...cards.values()].some(c => c.socket?.readyState === 1)
    ? 'Agent connecté' : 'Agent hors ligne';
  $('server-state').textContent = $('status-label-agent').textContent;
  $('control-state').textContent = selected?.control === 'stopping' ? 'Arrêt en cours'
    : selected?.busy || selected?.requesting ? 'Opération en cours' : external ? 'Pilotage externe' : 'Disponible';
  $('grant').disabled = !selected?.identity || selected.hasControlToken || !['console', 'loader'].includes(selected.mode);
  $('revoke').disabled = !selected?.hasControlToken;
  $('release-control').disabled = !external || selected.control === 'stopping';
  $('grant-state').textContent = selected?.hasControlToken ? 'Jeton émis' : 'Aucun jeton';
  void updateWakeLock();
  $('status-label-control').textContent = $('control-state').textContent;
  renderConsole();
  renderOperations();
  renderJournal();
}

function addCard(name, port, flashBaud) {
  const card = new BoardConnector(name, port, {
    flashBaud,
    onChange: () => {
      render();
      if (card === romTarget && romPortSeen) queueMicrotask(openRomWhenReady);
    },
    onCapture: () => scheduleConsole(card),
    onJournal: message => note(card, message),
    onProgress: () => { if (card === selected) renderFlashProgress(); },
  });
  Object.assign(card, {follow: true, pausedAt: null, operations: [], journal: []});
  const row = element('div', undefined, 'active-board');
  card.row = row;
  card.nameButton = element('button', name, 'board-name');
  card.status = element('button', '', 'board-status');
  card.remove = element('button', 'Retirer');
  card.nameButton.onclick = () => { selected = card; render(); };
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

async function run(action) {
  try {
    return await action();
  } catch (error) {
    say(error.message);
  }
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
  say(card.name + ' connectée.');
  $(card.mode === 'console' ? 'workspace-tab-consoles' : 'workspace-tab-operations').click();
  if (card.identity?.capabilities.includes('flash.read')) $('tab-memory').click();
}

async function addFromPicker() {
  if (adding) return;
  function feedback(message) {
    $('add-card-feedback').textContent = message;
    say(message);
  }
  const name = $('add-device-id').value.trim();
  const flashBaud = Number($('flash-baud').value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name)) return feedback('Saisis un nom de carte valide.');
  if (cards.has(name)) return feedback('Ce nom est déjà utilisé.');
  if (!flashBaud) return feedback('Choisis un débit flash.');
  if (!navigator.serial) return feedback('Web Serial est indisponible dans ce navigateur.');
  adding = $('add-device').disabled = true;
  try {
    feedback('Choisis le port de la carte dans le sélecteur du navigateur.');
    const port = await navigator.serial.requestPort();
    if ([...cards.values()].some(card => card.port === port)) return feedback('Ce port est déjà associé à une carte.');
    feedback('Détection de la carte…');
    await connectCard(addCard(name, port, flashBaud));
    $('add-card-feedback').textContent = '';
  } catch (error) {
    feedback(error.name === 'NotFoundError' ? 'Aucun port sélectionné.' : error.message);
  } finally {
    adding = $('add-device').disabled = false;
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
    await card.enterLoader();
    if (card !== selected) return;
    $('workspace-tab-operations').click();
    $('tab-memory').click();
  }
});
const romDialog = $('rom-reset-dialog');
const romProgress = $('rom-reset-progress');
const romConfirm = $('rom-reset-confirm');
const romCancel = $('rom-reset-cancel');
let romTarget;
let romAutomatic = false;
let romConnecting = false;
let romPortSeen = false;

$('open-rom').onclick = () => {
  if (!selected || romDialog.open) return;
  romTarget = selected;
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
  if (!romDialog.open || romConnecting || !card || cards.get(card.name) !== card) return;
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
$('rom-jedec').onclick = () => run(() => selected?.readRomJedec());
$('identify-live').onclick = () => run(async () => {
  const identity = await selected?.identify();
  if (identity) say((identity.model ?? identity.chip) + ' · MAC ' + identity.mac);
});

function download(blob, filename) {
  const link = element('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function flashNumber(value) {
  if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw new Error('Adresse ou taille invalide.');
  return Number(value);
}
async function readPartitions() {
  const card = selected;
  if (!card || card.busy || card.requesting || $('read').disabled) return;
  card.partitions = [];
  card.suggestPartition = false;
  card.partitionStatus = 'Lecture de la table…';
  render();
  let address;
  try {
    address = flashNumber($('partition-address').value.trim());
    const {blob, capacity} = await card.readFlash(address, PARTITION_TABLE_BYTES);
    card.partitions = decodePartitions(new Uint8Array(await blob.arrayBuffer()), capacity);
    card.partitionStatus = card.partitions.length + ' partition(s) lue(s).';
  } catch (error) {
    card.suggestPartition = address === 0x8000 && error.message === 'partition_table_invalid';
    card.partitionStatus = error.message === 'partition_table_invalid' ? 'Aucune table valide à cette adresse.' : error.message;
  } finally {
    note(card, 'Partitions : ' + card.partitionStatus);
    if (card === selected) render();
  }
}
$('read-partitions').onclick = readPartitions;
$('try-partition-address').onclick = () => { $('partition-address').value = '0x10000'; readPartitions(); };

$('read').onclick = async () => {
  const card = selected;
  if (!card || card.busy || card.requesting || $('read').disabled) return;
  const started = Date.now();
  const entry = {
    id: card.operations.length + 1, device: card.name, command: 'flash.read',
    state: 'En cours', startedAt: new Date(started).toISOString(),
  };
  card.operations.unshift(entry);
  card.dump = null;
  $('read').disabled = true;
  renderOperations();
  try {
    const address = flashNumber($('address').value.trim());
    const size = flashNumber($('size').value.trim());
    Object.assign(entry, {address, size});
    const {blob} = await card.readFlash(address, size);
    const preview = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
    card.dump = {blob, filename: card.name + '-0x' + address.toString(16) + '.bin',
      summary: blob.size + ' octets lus • aperçu des ' + preview.length + ' premiers octets',
      preview: Array.from(preview, byte => byte.toString(16).padStart(2, '0')).join(' ')};
    entry.state = 'Terminée';
    entry.bytesRead = blob.size;
    entry.preview = card.dump.preview;
    entry.detail = card.dump.summary;
    say(entry.detail);
  } catch (error) {
    entry.state = 'Échec';
    entry.detail = error.message;
    say(entry.detail);
  } finally {
    entry.duration = (Date.now() - started) + ' ms';
    note(card, 'Lecture flash : ' + entry.detail);
    if (card === selected) render();
  }
};

let sending = false;
$('send').onclick = async () => {
  const card = selected;
  if (!card || card.mode !== 'console' || sending) return;
  sending = true;
  try {
    const value = $('uart').value;
    let payload = value + '\n';
    if ($('uart-format').value === 'hex') {
      const compact = value.replace(/\s/g, '');
      if (!/^(?:[\da-f]{2})+$/i.test(compact)) throw new Error('Saisis des octets hexadécimaux complets.');
      payload = Uint8Array.from(compact.match(/../g), byte => parseInt(byte, 16));
    }
    await card.write(payload);
    $('uart').value = '';
    scheduleConsole(card);
  } catch (error) { say(error.message); }
  finally { sending = false; }
};
$('uart').onkeydown = event => { if (event.key === 'Enter') $('send').click(); };
$('mark').onclick = () => { selected?.capture.note('MARK', $('marker').value); renderConsole(); };
$('format-hex').onclick = () => setFormat(true);
$('format-text').onclick = () => setFormat(false);
function setFormat(hex) {
  $('format-hex').setAttribute('aria-pressed', hex);
  $('format-text').setAttribute('aria-pressed', !hex);
  renderConsole();
}
$('console-search').oninput = $('timestamps').onchange = renderConsole;
$('pause').onclick = () => {
  if (!selected) return;
  selected.pausedAt = selected.pausedAt === null ? selected.capture.sequence : null;
  render();
};
$('uart-log').onscroll = () => {
  if (!selected) return;
  const log = $('uart-log');
  selected.follow = log.scrollHeight - log.scrollTop - log.clientHeight < 4;
  $('follow').hidden = selected.follow;
  $('follow-state').textContent = selected.follow ? 'Suivi du direct' : 'Défilement manuel';
};
$('follow').onclick = () => { if (selected) { selected.follow = true; render(); } };
$('clear-display').onclick = () => { selected?.capture.clearDisplay(); renderConsole(); };
$('export').onclick = () => {
  if (selected) download(new Blob([selected.capture.bytes()]), selected.name + '-uart.bin');
};
$('console-auto-size').onclick = () => $('uart-log').style.height = '';
$('agent-log-toggle').onclick = event => {
  const log = $('agent-log');
  log.hidden = !log.hidden;
  event.currentTarget.setAttribute('aria-expanded', !log.hidden);
  event.currentTarget.textContent = log.hidden ? 'Développer' : 'Réduire';
};
$('agent-log-clear').onclick = () => { if (selected) selected.journal.length = 0; renderJournal(); };
const emptyCards = element('p', 'Aucune carte connectée dans cette fenêtre.', 'hint');
emptyCards.id = 'empty-cards';
$('active-cards').replaceChildren(emptyCards);
$('server-origin').textContent = location.origin;
say('Ajoute une carte pour ouvrir une console ou une session chargeur.');
render();
