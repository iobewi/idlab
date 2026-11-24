# Référence UX historique d’IDLab

Depuis la page d’IDLab, ouvrir **Référence UX historique** dans la barre
de navigation. Cette page présente la structure complète de l’interface
historique avec la feuille de style d’origine. Les cartes et la capture UART
affichées sont simulées. Les commandes matérielles sont désactivées.

Le point de départ est [rust_dev à la révision 79fd7bf](https://github.com/iobewi/rust_dev/tree/79fd7bf943751755de65b4212f08c5bd88a51e7c/bench/web).
La [documentation historique de l’interface](https://github.com/iobewi/rust_dev/blob/79fd7bf943751755de65b4212f08c5bd88a51e7c/bench/docs/interface.md)
décrit le comportement des commandes et leurs conditions d’affichage.
Dans la référence, on peut parcourir les onglets et les bandes d’état,
sélectionner une carte simulée, utiliser l’affichage texte ou hexadécimal,
la recherche et la pause, et réduire le journal de l’agent.

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
| Campagnes | Vue ajoutée après la migration, accessible depuis la page actuelle. |

Pour la revue, commencer par le parcours carte → identification → console,
puis examiner les autres zones dans leur emplacement d’origine. Cet inventaire
sert à décider ensuite quels écrans et interactions réintégrer au banc actuel.
