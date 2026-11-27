import { $, clock, download, element, number, operationOrigin, say } from './dom.js';
import { BootIdentity } from './boot-identity.js';
import { ConsoleBuffer } from './console-buffer.js';
import { updateHelp } from './control-help.js';

export function watchConsole(onUpdate) {
  let active;

  async function read(card, generation, {signal}) {
    const url = new URL('/api/v1/devices/' + card.name + '/uart', location.href);
    url.searchParams.set('generation', generation);
    url.searchParams.set('wait_ms', '5000');
    let framePending = false;
    while (!signal.aborted) {
      try {
        url.searchParams.set('cursor', card.uartCursor);
        const response = await fetch(url, {signal});
        if (!response.ok) throw new Error('uart_unavailable');
        const uart = await response.json();
        if (signal.aborted) return;
        card.uartCursor = uart.cursor;
        if (uart.dropped) card.capture.note('MARK', uart.dropped + ' octets perdus');
        if (uart.hex) {
          const bytes = Uint8Array.from(uart.hex.match(/../g), byte => parseInt(byte, 16));
          card.boot.append(card.capture.append(bytes).text);
        }
        if ((uart.hex || uart.dropped) && !framePending) {
          framePending = true;
          setTimeout(() => {
            framePending = false;
            if (!signal.aborted) onUpdate(card);
          }, 32);
        }
      } catch {
        if (signal.aborted) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  return card => {
    const generation = card?.identity?.generation;
    if (active?.card === card && active?.generation === generation) return;
    active?.controller.abort();
    active = null;
    if (!generation) return;
    if (card.uartGeneration !== generation) {
      if (card.uartGeneration) card.capture.note('MARK', 'Nouvelle génération · reconnexion');
      else card.capture = new ConsoleBuffer();
      card.uartGeneration = generation;
      card.uartCursor = 0;
      card.boot = new BootIdentity();
      card.pausedAt = null;
    }
    const controller = new AbortController();
    active = {card, generation, controller};
    void read(card, generation, controller);
  };
}

export function renderJournal(card) {
  const log = $('agent-log');
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  const journal = card?.lastJournal ?? [];
  const rows = journal.filter(entry => entry.at > (card.journalAfter ?? ''))
    .map(entry => element('p', [clock.format(new Date(entry.at)), operationOrigin(entry), entry.message]
      .filter(Boolean).join(' · '), 'journal-row'));
  $('agent-log-entries').replaceChildren(...rows);
  $('agent-log-copy').disabled = rows.length === 0;
  renderFlashProgress(card);
  if (follow) log.scrollTop = log.scrollHeight;
}

export function renderFlashProgress(card) {
  const line = $('agent-read-progress');
  const log = $('agent-log');
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  const progress = card?.observation?.progress;
  line.hidden = !progress;
  if (progress) {
    const {address, received, total, phase} = progress;
    const labels = {write: 'Programmation flash (progression estimée)', verify: 'Vérification flash', 'erase-verify': 'Vérification de l’effacement'};
    const label = labels[phase] ?? 'Lecture flash';
    const message = phase === 'erase' ? 'Effacement flash à 0x' + address.toString(16) + ' · ' +
      number.format(total) + ' octets…' : label + ' à 0x' + address.toString(16) + ' · ' +
      number.format(received) + ' / ' + number.format(total) + ' octets · ' +
      Math.floor(received * 100 / total) + ' %';
    line.textContent = [operationOrigin(progress), message].filter(Boolean).join(' · ');
  }
  if (follow) log.scrollTop = log.scrollHeight;
}

export function renderConsole(card) {
  const buffer = card?.capture;
  const timestamps = $('timestamps').checked;
  const rows = buffer?.visible({
    format: $('format-hex').getAttribute('aria-pressed') === 'true' ? 'hex' : 'text',
    query: $('console-search').value, before: card?.pausedAt ?? Infinity,
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
  log.scrollTop = card?.follow ? log.scrollHeight : scroll;
  $('capture-state').textContent = buffer?.byteLength ? buffer.byteLength + ' octets capturés'
    : card?.mode === 'console' ? 'Console ouverte · en attente d’octets UART' : 'Aucune capture';
}

export function renderConsoleControls(card, available) {
  $('send').disabled = !(available && card.mode === 'console');
  $('mark').disabled = !card;
  $('export').disabled = !card;
  const pause = $('pause');
  const paused = card?.pausedAt != null;
  pause.disabled = !card;
  pause.setAttribute('aria-pressed', paused);
  $('console-pause-icon').setAttribute('href', paused ? '#icon-play' : '#icon-pause');
  const help = paused ? 'Affiche à nouveau les lignes reçues par la console.'
    : 'Fige les lignes affichées. La capture UART continue.';
  if (pause.dataset.guideHelp !== help) {
    pause.dataset.guideHelp = help;
    updateHelp();
  }
  $('follow').hidden = !card || card.follow;
  $('follow-state').textContent = card?.follow ? 'Suivi du direct' : 'Défilement manuel';
}

export function wireConsole({getSelected, render, observeCard}) {
  let sending = false;
  $('send').onclick = async () => {
    const card = getSelected();
    if (!card || card.mode !== 'console' || sending) return;
    sending = true;
    say('');
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
      void observeCard(card);
    } catch (error) { say(error.message); }
    finally { sending = false; }
  };
  $('uart').onkeydown = event => { if (event.key === 'Enter') $('send').click(); };
  $('mark').onclick = () => { getSelected()?.capture.note('MARK', $('marker').value); renderConsole(getSelected()); };
  $('format-hex').onclick = () => setFormat(true);
  $('format-text').onclick = () => setFormat(false);
  function setFormat(hex) {
    $('format-hex').setAttribute('aria-pressed', hex);
    $('format-text').setAttribute('aria-pressed', !hex);
    renderConsole(getSelected());
  }
  $('console-search').oninput = $('timestamps').onchange = () => renderConsole(getSelected());
  $('pause').onclick = () => {
    const card = getSelected();
    if (!card) return;
    card.pausedAt = card.pausedAt === null ? card.capture.sequence : null;
    render();
  };
  const log = $('uart-log');
  log.onscroll = () => {
    const card = getSelected();
    if (!card) return;
    card.follow = log.scrollHeight - log.scrollTop - log.clientHeight < 4;
    $('follow').hidden = card.follow;
    $('follow-state').textContent = card.follow ? 'Suivi du direct' : 'Défilement manuel';
  };
  new ResizeObserver(() => {
    if (getSelected()?.follow) log.scrollTop = log.scrollHeight;
  }).observe(log);
  $('follow').onclick = () => {
    const card = getSelected();
    if (card) { card.follow = true; render(); }
  };
  $('clear-display').onclick = () => { getSelected()?.capture.clearDisplay(); renderConsole(getSelected()); };
  $('export').onclick = () => {
    const card = getSelected();
    if (card) download(new Blob([card.capture.bytes()]), card.name + '-uart.bin');
  };
  $('agent-log-copy').onclick = async () => {
    const rows = $('agent-log-entries').children;
    if (!rows.length) return;
    const text = Array.from(rows, row => row.textContent).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      say('Journal de l’agent copié.', {temporary: true});
    } catch {
      say('Impossible de copier le journal dans le presse-papiers.');
    }
  };
  $('agent-log-clear').onclick = () => {
    const card = getSelected();
    if (card) card.journalAfter = card.lastJournal?.at(-1)?.at;
    renderJournal(getSelected());
  };
}
