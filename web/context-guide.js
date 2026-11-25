import { $ } from './dom.js';
import { externallyControlled } from './workbench-shell.js';

function nextStep(card, choosingPort) {
  if (choosingPort) return ['Choisis le port série de la carte dans le sélecteur du navigateur.'];
  if (!card) return ['Ajoute une carte pour ouvrir sa console ou accéder à sa flash.', 'Ajouter une carte', 'add-device'];
  if (card.mode === 'connecting') return [
    card.requesting || card.busy ? 'IDLab change le mode de la carte…' : 'IDLab détecte la carte…',
  ];
  if (card.mode === 'closing') return ['IDLab ferme la connexion série…'];
  if (card.mode === 'disconnected') return [
    'Reconnecte la carte depuis la liste pour reprendre.', 'Reconnecter', card.status, true,
  ];
  if (card.requesting || card.busy || ['busy', 'stopping'].includes(card.observation?.device.control)) {
    return ['Suis l’opération dans le journal de l’agent.'];
  }
  if (externallyControlled(card)) return ['Tu peux consulter la carte pendant que le client externe la pilote.'];
  if (card.dump) return [
    'Le dump est prêt à être téléchargé.', 'Voir le dump', 'download', false, 'tab-memory',
  ];
  if (card.mode === 'console') {
    return card.canEnterLoader
      ? ['Envoie une commande UART ou ouvre le chargeur pour accéder à la flash.', 'Ouvrir le chargeur', 'enter-loader']
      : ['Envoie une commande UART. Pour accéder à la flash, démarre la carte en mode téléchargement.', 'Écrire sur l’UART', 'uart', true];
  }
  if (card.identity?.loader === 'rom') {
    return ['Lis le JEDEC pour identifier la flash depuis la ROM.', 'Lire le JEDEC', 'rom-jedec', false, 'tab-rom'];
  }
  if (card.identity?.capabilities.includes('flash.read')) return [
    'Lis la table des partitions ou indique une plage dans Lecture mémoire.', 'Voir les partitions', 'tab-partitions', false, 'tab-partitions',
  ];
  return ['Identifie la carte pour vérifier les informations de la flash.', 'Identifier', 'identify-live'];
}

export function renderGuide(card, choosingPort = false) {
  const [message, label, target, manual, tab] = nextStep(card, choosingPort);
  const hint = $('guide-next');
  if (hint.textContent !== message) hint.textContent = message;
  const action = $('guide-action');
  action.hidden = !label;
  action.textContent = label ?? '';
  action.onclick = label ? () => {
    if (tab) {
      $('workspace-tab-operations').click();
      $(tab).click();
    }
    const control = typeof target === 'string' ? $(target) : target;
    if (target === 'download') control.querySelector('button')?.focus();
    else if (target === 'uart' || target === tab) {
      if (target === 'uart') $('workspace-tab-consoles').click();
      control.focus();
    } else control.click();
  } : null;
  const help = $('guide-boot');
  help.hidden = !manual;
  if (help.hidden) help.open = false;
}
