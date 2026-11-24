import { EspDriver } from './esp-driver.js';
import { openSerialConsole } from './serial-console.js';
import { ConsoleBuffer } from './console-buffer.js';

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
  $('capture-state').textContent = buffer ? buffer.byteLength + ' octets capturés' : 'Aucune capture';
}

function scheduleConsole(card) {
  if (card !== selected || card.pausedAt !== null || redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => { redrawPending = false; renderConsole(); });
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
  const info = selected?.identity;
  for (const [id, value] of Object.entries({
    'status-label-card': selected?.name, 'chip-info': info?.chip, 'flash-info': info?.flash_size ? info.flash_size + ' octets' : null,
    'interface-info': info?.transport ?? selected?.portLabel, 'console-speed-info': selected?.baud,
    'loader-speed-info': info ? '115 200' : null, 'footer-target': selected?.name,
  })) $(id).textContent = value ?? '—';
  const available = selected && !selected.busy && !selected.requesting;
  const loader = available && selected.mode === 'loader';
  $('read').disabled = !(loader && info?.capabilities.includes('flash.read'));
  $('identify-live').disabled = !loader;
  $('return-console').disabled = !loader;
  $('enter-loader').disabled = !(available && selected.mode === 'console');
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
  const portInfo = port.getInfo();
  const portLabel = portInfo.usbVendorId == null ? 'Port série' :
    [portInfo.usbVendorId, portInfo.usbProductId].filter(Number.isInteger)
      .map(value => value.toString(16).padStart(4, '0')).join(':');
  const card = {name, port, baud, manual, use, portLabel, mode: 'disconnected', busy: false,
    follow: true, pausedAt: null, capture: new ConsoleBuffer(), operations: [], journal: []};
  const row = element('div', undefined, 'active-board');
  card.nameButton = element('button', name, 'board-name');
  card.status = element('button', '', 'board-status');
  card.remove = element('button', 'Retirer');
  card.nameButton.onclick = () => { selected = card; render(); };
  card.status.onclick = () => card.mode === 'disconnected' ? connect(card) : disconnect(card);
  card.remove.onclick = () => {
    cards.delete(name);
    row.remove();
    if (selected === card) selected = cards.values().next().value ?? null;
    render();
  };
  row.append(card.nameButton, card.status, card.remove);
  $('active-cards').append(row);
  cards.set(name, card);
  selected = card;
  return card;
}

async function api(path, options) {
  const response = await fetch('/api/v1' + path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? ('HTTP ' + response.status));
  }
  return response;
}

function requestUsbSession(card, driver) {
  return new Promise((resolve, reject) => {
    const url = new URL('/agent', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('device', card.name);
    const socket = new WebSocket(url);
    card.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify(driver.identity));
    socket.onclose = () => {
      reject(new Error('Liaison au serveur interrompue.'));
      if (card.mode === 'loader' && card.socket === socket) disconnect(card);
    };
    socket.onmessage = async event => {
      const command = JSON.parse(event.data);
      if (command.generation) {
        try {
          const info = await api('/devices/' + card.name).then(response => response.json());
          if (socket.readyState !== WebSocket.OPEN) throw new Error('Liaison au serveur interrompue.');
          resolve(info);
        } catch (error) { reject(error); }
        return;
      }
      card.busy = true;
      if (selected === card) render();
      const check = () => {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('device_session_changed');
      };
      try {
        if (command.command !== 'flash.read') throw new Error('operation_unsupported');
        note(card, 'Lecture flash en cours');
        socket.send(await driver.readFlash(command.address, command.size, check));
        note(card, 'Lecture flash terminée');
      } catch {
        if (socket.readyState === WebSocket.OPEN) socket.send(command.id);
      } finally {
        card.busy = false;
        if (selected === card) render();
      }
    };
  });
}

async function connect(card) {
  if (card.mode !== 'disconnected') return false;
  card.mode = 'connecting';
  render();
  try {
    if (card.use === 'console') {
      const session = await openSerialConsole(card.port, card.baud, null, bytes => {
        card.capture.append(bytes);
        scheduleConsole(card);
      });
      card.session = session;
      card.mode = 'console';
      session.done.then(() => {
        if (card.session === session && card.mode === 'console') disconnect(card);
      }, error => {
        note(card, error.message);
        if (card.session === session && card.mode === 'console') disconnect(card);
      });
      note(card, 'Console ouverte à ' + card.baud + ' bauds');
    } else {
      const driver = new EspDriver(card.port, await import('/esptool.js'));
      card.session = driver;
      await driver.connect({romOnly: card.use === 'rom', manualEntry: card.manual});
      card.identity = await requestUsbSession(card, driver);
      card.mode = 'loader';
      note(card, 'Chargeur connecté');
    }
    say(card.name + ' connectée.');
    render();
    return true;
  } catch (error) {
    await disconnect(card);
    note(card, error.message);
    say(error.message);
    return false;
  }
}

async function disconnect(card) {
  if (card.mode === 'disconnected' || card.mode === 'closing') return false;
  card.mode = 'closing';
  card.socket?.close();
  render();
  try {
    await card.session?.close();
    note(card, 'Port fermé');
    return true;
  } catch (error) {
    note(card, error.message);
    say(error.message);
    return false;
  } finally {
    card.session = card.socket = null;
    card.mode = 'disconnected';
    card.busy = false;
    render();
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
    if (await connect(card)) {
      $(use === 'console' ? 'workspace-tab-consoles' : 'workspace-tab-operations').click();
      if (use === 'stub') $('tab-memory').click();
    }
  } catch (error) { say(error.message); }
  finally { adding = $('add-device').disabled = false; }
}
$('add-device').onclick = addFromPicker;
$('add-device-id').onkeydown = event => { if (event.key === 'Enter') addFromPicker(); };
navigator.serial?.addEventListener('disconnect', event => {
  for (const card of cards.values()) {
    if (card.mode !== 'connecting' && (event.target === card.port || event.port === card.port)) disconnect(card);
  }
});

async function switchMode(use) {
  const card = selected;
  if (!card || card.busy || card.requesting || (card.mode !== 'console' && card.mode !== 'loader')) return;
  if (!await disconnect(card)) return;
  card.use = use;
  if (await connect(card)) {
    $(use === 'console' ? 'workspace-tab-consoles' : 'workspace-tab-operations').click();
    if (use === 'stub') $('tab-memory').click();
  }
}
$('return-console').onclick = () => switchMode('console');
$('enter-loader').onclick = () => switchMode('stub');
$('identify-live').onclick = async () => {
  const card = selected;
  try {
    card.identity = await api('/devices/' + card.name).then(response => response.json());
    note(card, 'Identité de la session : ' + card.identity.chip + ' · ' + card.identity.mac);
    say(card.identity.chip + ' · MAC ' + card.identity.mac);
    render();
  } catch (error) { say(error.message); }
};

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
$('read').onclick = async () => {
  const card = selected;
  if (!card || card.busy || card.requesting || card.mode !== 'loader') return;
  card.requesting = true;
  const started = Date.now();
  const entry = {id: card.operations.length + 1, state: 'En cours'};
  card.operations.unshift(entry);
  $('read').disabled = true;
  renderOperations();
  try {
    const address = flashNumber($('address').value.trim());
    const size = flashNumber($('size').value.trim());
    const response = await api('/devices/' + card.name + '/flash/read', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({generation: card.identity.generation, address, size}),
    });
    const blob = await response.blob();
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
    card.requesting = false;
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
    await card.session.write(payload);
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
