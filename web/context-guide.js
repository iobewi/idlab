import { $ } from './dom.js';
import { externallyControlled } from './workbench-shell.js';

function nextStep(card, choosingPort) {
  if (choosingPort) return ['Choisis le port série de la carte dans le sélecteur du navigateur.'];
  if (!card) return ['Ajoute une carte pour ouvrir sa console ou accéder à sa flash.', [$('add-device')]];
  if (card.mode === 'connecting') return [
    card.requesting || card.busy ? 'IDLab change le mode de la carte…' : 'IDLab détecte la carte…',
  ];
  if (card.mode === 'closing') return ['IDLab ferme la connexion série…'];
  if (card.mode === 'disconnected') return [
    'Reconnecte la carte depuis la liste pour reprendre.', [card.status], true,
  ];
  if (card.requesting || card.busy || ['busy', 'stopping'].includes(card.observation?.device.control)) {
    return ['Suis l’opération dans le journal de l’agent.', [$('agent-log')]];
  }
  if (externallyControlled(card)) return ['Tu peux consulter la carte pendant que le client externe la pilote.'];
  if (card.dump) return ['Télécharge le dump dans Lecture mémoire.', [$('download').querySelector('button')]];
  if (card.mode === 'console') {
    return card.canEnterLoader
      ? ['Envoie une commande UART ou ouvre le chargeur pour accéder à la flash.', [$('uart'), $('enter-loader')]]
      : ['Envoie une commande UART. Pour accéder à la flash, démarre la carte en mode téléchargement.', [$('uart')], true];
  }
  if (card.identity?.loader === 'rom') {
    return ['Lis le JEDEC pour identifier la flash depuis la ROM.', [$('rom-jedec')]];
  }
  if (card.identity?.capabilities.includes('flash.read')) return [
    'Lis la table des partitions ou indique une plage dans Lecture mémoire.', [$('read-partitions')],
  ];
  return ['Identifie la carte pour vérifier les informations de la flash.', [$('identify-live')]];
}

function visibleTarget(control) {
  for (let panel = control?.closest('[role="tabpanel"][hidden]'); panel;
    panel = control?.closest('[role="tabpanel"][hidden]')) {
    control = $(panel.getAttribute('aria-labelledby'));
    if (panel.contains(control)) break;
  }
  return control;
}

let highlighted = new Set();
let hoveredControl;
let focusedControl;
let explainedControl;
let updateGuide = () => {};

function controlWithHelp(element) {
  const control = element?.closest?.('[data-guide-help], [aria-describedby]');
  if (control?.dataset.guideHelp || tooltip(control)) return control;
}

function tooltip(control) {
  return control?.getAttribute('aria-describedby')?.split(/\s+/)
    .map($).find(description => description?.getAttribute('role') === 'tooltip');
}

export function wireGuideHelp() {
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const control = controlWithHelp(event.target);
    if (hoveredControl === control) return;
    hoveredControl = control;
    updateGuide();
  });
  document.addEventListener('pointerout', event => {
    if (event.pointerType === 'touch' || !hoveredControl ||
        hoveredControl === controlWithHelp(event.relatedTarget)) return;
    hoveredControl = undefined;
    updateGuide();
  });
  document.addEventListener('focusin', event => {
    focusedControl = event.target.matches(':focus-visible') ? controlWithHelp(event.target) : undefined;
    updateGuide();
  });
  document.addEventListener('focusout', () => {
    focusedControl = undefined;
    updateGuide();
  });
}

export function renderGuide(card, choosingPort = false) {
  const [message, targets = [], manual] = nextStep(card, choosingPort);
  const hint = $('guide-next');
  const guide = $('context-guide');
  const help = $('guide-boot');
  updateGuide = () => {
    const control = choosingPort ? undefined : [hoveredControl, focusedControl]
      .find(candidate => candidate?.isConnected && !candidate.closest('[hidden]'));
    const detail = control?.dataset.guideHelp ?? tooltip(control)?.textContent.trim();
    if (explainedControl !== control) {
      explainedControl?.classList.remove('guide-help-target');
      control?.classList.add('guide-help-target');
      explainedControl = control;
    }
    const text = detail || message;
    if (hint.textContent !== text) hint.textContent = text;
    guide.toggleAttribute('data-explaining', Boolean(detail));
    help.hidden = !manual || Boolean(detail);
    if (help.hidden) help.open = false;
  };
  updateGuide();

  function markTargets() {
    const visible = new Set(targets.map(visibleTarget).filter(Boolean));
    for (const control of highlighted) {
      if (!visible.has(control)) control.classList.remove('guide-highlight');
    }
    for (const control of visible) control.classList.add('guide-highlight');
    highlighted = visible;
  }
  guide.onpointerenter = guide.onfocusin = markTargets;
  guide.tabIndex = targets.some(Boolean) ? 0 : -1;
  markTargets();
}
