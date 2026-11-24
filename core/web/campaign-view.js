const labels = {
  active: 'Active',
  abort_requested: 'Avortement demandé',
  aborted: 'Avortée',
  finished: 'Terminée',
};
const dateFormat = new Intl.DateTimeFormat('fr', { dateStyle: 'short', timeStyle: 'short' });
const pageSize = 10;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function duration(campaign) {
  const start = Date.parse(campaign.started_at);
  const end = campaign.ended_at ? Date.parse(campaign.ended_at) : Date.now();
  const minutes = Math.max(0, Math.floor((end - start) / 60000));
  if (minutes < 1) return '< 1 min';
  const hours = Math.floor(minutes / 60);
  return hours ? hours + ' h ' + (minutes % 60) + ' min' : minutes + ' min';
}

function row(campaign) {
  const tr = element('tr');
  const name = element('td', campaign.name);
  const details = element('details');
  details.append(element('summary', 'Détails'), element('code', campaign.id));
  if (campaign.reason) details.append(element('p', campaign.reason));
  name.append(details);
  tr.append(name, element('td', labels[campaign.state]));
  const started = element('td');
  const time = element('time', dateFormat.format(new Date(campaign.started_at)));
  time.dateTime = campaign.started_at;
  started.append(time);
  tr.append(started, element('td', duration(campaign)), element('td', campaign.in_flight),
    element('td', campaign.verdict ?? '—'));
  return tr;
}

function campaignList(section, emptyMessage, onResult = () => {}) {
  section.append(document.querySelector('#campaign-list').content.cloneNode(true));
  const output = section.querySelector('output');
  const table = section.querySelector('.campaign-table');
  const body = table.querySelector('tbody');
  const pages = section.querySelector('.campaign-pages');
  const previous = pages.querySelector('[data-page=previous]');
  const next = pages.querySelector('[data-page=next]');
  let filters = new URLSearchParams();
  let offset = 0;
  let pending;

  async function load() {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const query = new URLSearchParams(filters);
    query.set('limit', pageSize);
    query.set('offset', offset);
    try {
      const response = await fetch('/api/v1/campaigns?' + query, { signal: controller.signal });
      if (!response.ok) throw new Error('Campagnes indisponibles (' + response.status + ').');
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (offset > 0 && offset >= data.total) {
        offset = Math.floor(Math.max(0, data.total - 1) / pageSize) * pageSize;
        return load();
      }
      onResult(data);
      body.replaceChildren(...data.items.map(row));
      table.hidden = data.items.length === 0;
      pages.hidden = data.total <= pageSize;
      previous.disabled = offset === 0;
      next.disabled = offset + data.items.length >= data.total;
      const message = data.total
        ? (offset + 1) + '–' + (offset + data.items.length) + ' sur ' + data.total
        : emptyMessage;
      if (output.value !== message) output.value = message;
    } catch (error) {
      if (controller.signal.aborted) return;
      onResult(null);
      table.hidden = pages.hidden = true;
      output.value = error.message;
    } finally {
      if (pending === controller) pending = null;
    }
  }

  previous.onclick = () => { offset = Math.max(0, offset - pageSize); load(); };
  next.onclick = () => { offset += pageSize; load(); };
  return {
    reload() { if (!pending) load(); },
    search(params) {
      filters = params;
      offset = 0;
      load();
    },
  };
}

const counts = document.querySelector('#campaign-counts');
const live = campaignList(document.querySelector('#campaign-live'), 'Aucune campagne en cours.', result => {
  counts.textContent = result
    ? 'Actives : ' + result.counts.active + ' · Avortement demandé : ' + result.counts.abort_requested
    : '';
});
live.search(new URLSearchParams([['state', 'active'], ['state', 'abort_requested']]));
setInterval(() => { if (!document.hidden) live.reload(); }, 15000);

const history = campaignList(document.querySelector('#campaign-history'), 'Aucune campagne trouvée.');
const form = document.querySelector('#campaign-search');
form.onsubmit = event => {
  event.preventDefault();
  const { from, to } = form.elements;
  to.setCustomValidity(from.value && to.value && from.value > to.value ? 'Choisir une date de fin après la date de début.' : '');
  if (!form.reportValidity()) return;
  const query = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (value.trim()) query.set(name, value.trim());
  }
  history.search(query);
  live.reload();
};
form.oninput = () => form.elements.to.setCustomValidity('');
history.search(new URLSearchParams());
