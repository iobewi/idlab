const family = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function importManifest(document, files, chip) {
  let parts = document?.parts;
  if (Array.isArray(document?.builds)) {
    const builds = document.builds;
    const matching = builds.filter(build => build && family(build.chipFamily) === family(chip));
    const build = matching.length === 1 ? matching[0] : !chip && builds.length === 1 ? builds[0] : null;
    if (!build) throw new Error('Aucun build unique pour cette puce dans le manifeste.');
    parts = build.parts;
  }
  if (!Array.isArray(parts) || !parts.length || parts.length > 16) throw new Error('Le manifeste doit contenir de 1 à 16 binaires.');
  return parts.map(part => {
    const {path, offset} = part ?? {};
    if (typeof path !== 'string' || /[\\:?#]/.test(path) || path.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
        !Number.isSafeInteger(offset) || offset < 0) throw new Error('Chemin ou offset invalide dans le manifeste.');
    const exact = files.filter(file => file.webkitRelativePath?.split('/').slice(1).join('/') === path);
    const matches = exact.length ? exact : files.filter(file => !file.webkitRelativePath && file.name === path.split('/').at(-1));
    if (matches.length !== 1) throw new Error('Choisis un fichier unique pour ' + path + '.');
    return {file: matches[0], address: '0x' + offset.toString(16)};
  });
}

export async function importManifestForBoard(document, files, card, generation, isSelected) {
  const check = () => {
    if (!generation || card.identity?.generation !== generation || !isSelected()) {
      throw new Error('La carte ou sa session a changé.');
    }
  };
  check();
  let chip = card.identity.chip;
  if (Array.isArray(document?.builds) && !chip) {
    const prepared = await card.prepareFlashSession();
    check();
    if (prepared.generation !== generation) throw new Error('La session de la carte a changé.');
    chip = prepared.chip;
    if (!chip) throw new Error('Identité matérielle indisponible.');
  }
  return importManifest(document, files, chip);
}
