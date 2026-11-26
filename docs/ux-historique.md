# Référence UX historique d’IDLab

La page d’accueil reprend la navigation, les panneaux et le CSS de
[l’interface historique](https://github.com/iobewi/rust_dev/tree/79fd7bf943751755de65b4212f08c5bd88a51e7c/bench/web).
Les cartes connectées sont réelles. La console gère la capture UART, les
filtres, l’affichage hexadécimal, l’export, l’envoi et les repères. La lecture
flash, les partitions et la programmation avec relecture utilisent la session chargeur
et l’API du banc. Les campagnes se
consultent depuis le nouvel onglet correspondant.

Les panneaux historiques restent visibles pour la revue. Les commandes
qui attendent un raccordement au nouveau cœur sont grisées, notamment
l’import de manifestes, les artefacts et l’effacement global. La
[documentation historique](https://github.com/iobewi/rust_dev/blob/79fd7bf943751755de65b4212f08c5bd88a51e7c/bench/docs/interface.md)
décrit leurs anciens comportements. En mode console, le reset est disponible
sur les ponts UART reconnus et USB Serial/JTAG. Sur un autre transport,
utiliser le bouton Reset de la carte pour revoir les logs de démarrage.

## Éléments à revoir ensemble

| Zone de l’interface | Contenu historique |
|---|---|
| En-tête | Identité IOBEWI Device Lab, état de l’agent, pilotage et veille, bandes de détail, paramètres du banc et reconnexion au serveur. |
| Cartes actives | Ajout, sélection, états de connexion et actions associées, options BOOT manuel, débit du chargeur et ROM seule. |
| Identification | Puce, capacité, RDID, interface, débits du chargeur et de la console, débit de transfert et action Identifier. |
| Autorisations | Durée, autorisation distante, révocation et état par carte. |
| Commandes de la carte | Retour console, Reset EN ou USB selon le transport, maintien de BOOT et récupération locale. |
| Consoles | Capture UART redimensionnable, texte ou hexadécimal, horodatage, recherche, pause et suivi, effacement d’affichage, export, saisie UART et repères. |
| Opérations › Partitions | Adresse, lecture, table et suggestion d’adresse selon le résultat. |
| Opérations › Plan flash | Images, adresses, validation du plan, confirmations, manifestes et artefacts, écriture et effacement. |
| Opérations › Lecture mémoire | Adresse, taille, options de lecture et téléchargement. |
| Opérations › Historique | Opérations, détails, annulation, événements et export. |
| Opérations › Déclencheurs et outils | Débit de la console, diagnostic et bring-up P4, déclencheur UART et requête HTTP locale. |
| Journal de l’agent | Journal commun aux deux vues, progression et résultats, réduction et effacement de l’affichage. |
| Campagnes | Vue ajoutée après la migration, accessible depuis l’onglet Campagnes. |

Pour la revue, commencer par le parcours carte → identification → console,
puis examiner les autres zones dans leur emplacement d’origine. Cet inventaire
sert à décider ensuite quels écrans et interactions conserver ou raccorder.
