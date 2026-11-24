import { BoardConnector } from './board-connector.js';
import { decodePartitions, PARTITION_TABLE_BYTES } from './partitions.js';

const $ = id => document.getElementById(id);
const cards = new Map();
let selected = null;
let adding = false;
let redrawPending = false;
const say = message => { $('client-state').textContent = message; };
const clock = new Intl.DateTimeFormat('fr', { timeStyle: 'medium' });

function wireTabs(attribute) {
  const tabs = [...document.querySelectorAll('[' + attribute + ']')];
  function select(tab) {
    for (const element of tabs) {
      const active = element === tab;
      element.setAttribute('aria-selected', active);
      element.tabIndex = active ? 0 : -1;
      $(element.getAttribute('aria-controls')).hidden = !active;
    }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.onclick = () => select(tab);
    tab.onkeydown = event => {
      const last = tabs.length - 1;
      const target = {ArrowLeft: (index + last) % tabs.length, ArrowRight: (index + 1) % tabs.length,
        Home: 0, End: last}[event.key];
      if (target === undefined) return;
      event.preventDefault();
      select(tabs[target]);
      tabs[target].focus();
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
  $('agent-log').replaceChildren(...(selected?.journal ?? []).map(line => element('p', line, 'padded')));
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

function renderOperations() {
  const entries = selected?.operations ?? [];
  $('operations-body').replaceChildren(...entries.map(entry => {
    const tr = element('tr');
    for (const value of [entry.id, selected.name, 'Lecture flash', entry.state, entry.duration, entry.detail]) {
      tr.append(element('td', value ?? '—'));
    }
    return tr;
  }));
  $('result').textContent = entries.length ? JSON.stringify(entries[0], null, 2) : '{}';
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
  const current = card?.identity;
  const info = current ?? card?.lastIdentity;
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
    'interface-info': [info?.transport ?? (card?.transport === 'usb_serial_jtag' ? 'USB Serial/JTAG' :
      card?.transport === 'usb_uart' ? 'Pont USB–UART' : null), card?.portLabel].filter(Boolean).join(' · ') || null,
    'console-speed-info': card?.baud,
    'loader-speed-info': current ? '115 200' : null,
    'footer-target': card?.name,
  })) $(id).textContent = value ?? '—';

  const hint = $('identity-source');
  hint.textContent = card?.mode === 'console'
    ? (info ? 'Mesures conservées du dernier passage en chargeur sur ce port.'
      : card.canEnterLoader ? 'Identifier mesure la flash, la MAC et le RDID via le chargeur.'
      : 'Pour mesurer l’identité complète, place la carte en téléchargement puis reconnecte-la en mode Automatique.')
    : (current ? 'Identité lue par le chargeur.' : '');
  hint.hidden = !hint.textContent;

}

function render() {
  for (const card of cards.values()) {
    card.nameButton.setAttribute('aria-pressed', card === selected);
    card.status.textContent = {connecting: 'Connexion…', console: 'Connectée', loader: 'Connectée',
      closing: 'Déconnexion…', disconnected: 'Déconnectée'}[card.mode];
    card.status.dataset.state = {console: 'connected', loader: 'connected'}[card.mode] ?? card.mode;
    card.status.disabled = card.busy || card.requesting || card.mode === 'connecting' || card.mode === 'closing';
    card.remove.hidden = card.mode !== 'disconnected';
  }
  $('empty-cards').hidden = cards.size !== 0;
  $('card-details').hidden = !selected;
  renderIdentification();
  const info = selected?.identity;
  const available = selected && !selected.busy && !selected.requesting;
  const loader = available && selected.mode === 'loader';
  const autoLoader = available && selected.mode === 'console' && selected.canEnterLoader;
  const canRead = autoLoader || (loader && info?.capabilities.includes('flash.read'));
  $('read').disabled = !canRead;
  renderPartitions(canRead);
  const flashHint = $('flash-availability');
  flashHint.textContent = selected?.mode === 'connecting' && selected.requesting ? 'Transition console / chargeur…'
    : selected?.mode === 'console' ? (selected.canEnterLoader
      ? 'La lecture passe au chargeur puis revient en console. La carte peut redémarrer.'
      : 'Place la carte en téléchargement, puis reconnecte-la en mode Automatique.')
    : selected?.mode === 'loader' && info?.loader === 'rom' ? 'ROM active. Le stub requis pour cette lecture est indisponible ou désactivé.'
    : selected?.mode === 'loader' && !info?.flash_size ? 'Capacité flash inconnue. Vérifie le RDID et la connexion à la flash.'
    : '';
  flashHint.hidden = !flashHint.textContent;
  const reset = $('reset-device');
  reset.disabled = !(available && selected.mode === 'console' && selected.resetWait);
  reset.textContent = selected?.resetWait === 200 ? 'Reset USB' : 'Reset EN';
  $('identify-live').disabled = !(loader || autoLoader);
  $('return-console').disabled = !loader;
  $('enter-loader').disabled = !autoLoader;
  $('send').disabled = !(available && selected.mode === 'console');
  $('mark').disabled = !selected;
  $('export').disabled = !selected;
  $('pause').disabled = !selected;
  $('pause').setAttribute('aria-pressed', selected?.pausedAt != null);
  $('pause').textContent = selected?.pausedAt != null ? 'Reprendre l’affichage' : 'Pause affichage';
  $('follow').hidden = !selected || selected.follow;
  $('follow-state').textContent = selected?.follow ? 'Suivi du direct' : 'Défilement manuel';
  $('status-label-agent').textContent = [...cards.values()].some(c => c.mode === 'loader')
    ? 'Agent connecté' : 'Agent hors ligne';
  $('server-state').textContent = $('status-label-agent').textContent;
  $('control-state').textContent = selected?.busy ? 'Opération en cours' : 'Disponible';
  $('status-label-control').textContent = $('control-state').textContent;
  renderConsole();
  renderOperations();
  renderJournal();
}

function addCard(name, port, baud, manual, use) {
  const card = new BoardConnector(name, port, {
    baud, manual, use,
    onChange: render,
    onCapture: () => scheduleConsole(card),
    onJournal: message => note(card, message),
  });
  Object.assign(card, {follow: true, pausedAt: null, operations: [], journal: []});
  const row = element('div', undefined, 'active-board');
  card.nameButton = element('button', name, 'board-name');
  card.status = element('button', '', 'board-status');
  card.remove = element('button', 'Retirer');
  card.nameButton.onclick = () => { selected = card; render(); };
  card.status.onclick = () => run(() => card.mode === 'disconnected' ? card.connect() : card.disconnect());
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

async function addFromPicker() {
  if (adding) return;
  const name = $('add-device-id').value.trim();
  const baud = Number($('connect-baud').value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name)) return say('Saisis un nom de carte valide.');
  if (cards.has(name)) return say('Ce nom est déjà utilisé.');
  if (!Number.isInteger(baud) || baud < 1200 || baud > 3000000) return say('Débit UART invalide.');
  if (!navigator.serial) return say('Web Serial est indisponible dans ce navigateur.');
  adding = $('add-device').disabled = true;
  try {
    const port = await navigator.serial.requestPort();
    if ([...cards.values()].some(card => card.port === port)) return say('Ce port est déjà associé à une carte.');
    const use = $('connection-mode').value;
    const card = addCard(name, port, baud, $('manual-download').checked, use);
    await card.connect();
    say(card.name + ' connectée.');
    $(card.mode === 'console' ? 'workspace-tab-consoles' : 'workspace-tab-operations').click();
    if (card.identity?.capabilities.includes('flash.read')) $('tab-memory').click();
  } catch (error) { say(error.message); }
  finally { adding = $('add-device').disabled = false; }
}
$('add-device').onclick = addFromPicker;
$('add-device-id').onkeydown = event => { if (event.key === 'Enter') addFromPicker(); };
navigator.serial?.addEventListener('disconnect', event => {
  for (const card of cards.values()) {
    if (event.target === card.port || event.port === card.port) run(() => card.disconnect(true));
  }
});

$('reset-device').onclick = () => run(() => selected?.restart());
$('return-console').onclick = () => run(async () => {
  await selected?.returnConsole();
  $('workspace-tab-consoles').click();
});
$('enter-loader').onclick = () => run(async () => {
  await selected?.enterLoader();
  $('workspace-tab-operations').click();
  $('tab-memory').click();
});
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
  const entry = {id: card.operations.length + 1, state: 'En cours'};
  card.operations.unshift(entry);
  $('read').disabled = true;
  renderOperations();
  try {
    const address = flashNumber($('address').value.trim());
    const size = flashNumber($('size').value.trim());
    const {blob} = await card.readFlash(address, size);
    const preview = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
    card.dump = {blob, filename: card.name + '-0x' + address.toString(16) + '.bin',
      summary: blob.size + ' octets lus • aperçu des ' + preview.length + ' premiers octets',
      preview: Array.from(preview, byte => byte.toString(16).padStart(2, '0')).join(' ')};
    entry.state = 'Terminée';
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
    card.capture.note('TX', value);
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
