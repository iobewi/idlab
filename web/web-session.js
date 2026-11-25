const path = '/api/v1/web/session';
let creatingSession;

export async function hasWebSession() {
  return (await fetch(path, {cache: 'no-store'})).ok;
}

export function ensureWebSession() {
  creatingSession ??= (async () => {
    const response = await fetch(path, {method: 'POST'});
    if (!response.ok) throw new Error('Impossible d’ouvrir une session IDLab (' + response.status + ').');
    window.dispatchEvent(new Event('idlab-session-ready'));
  })().finally(() => { creatingSession = null; });
  return creatingSession;
}
