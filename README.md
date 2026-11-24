# IDLab

IOBEWI Device Lab relie des cartes embarquées aux scripts et à l'interface
opérateur. Le navigateur possède les ports Web Serial. Le serveur local
coordonne les appels. Les deux utilisent la même opération de lecture.

- `core/` contient les services HTTP, l’API et le connecteur Web Serial avec son pilote ESP32.
- `web/` contient l’interface opérateur servie par IDLab.
- `clients/` regroupe les clients tiers qui utilisent l’API. Le client Python et son paquet sont dans `clients/python/`.

## Démarrer

Avec Python 3.12+, npm et un navigateur compatible Web Serial, depuis la
racine du dépôt :

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r core/requirements.txt
npm ci --ignore-scripts --prefix core
python core/server.py
```

Ouvrir <http://127.0.0.1:8080>. Choisir un nom et le port de la carte.
En mode stub standard, le pilote peut faire entrer automatiquement la carte
en mode téléchargement sur un pont UART reconnu ou sur USB Serial/JTAG.
Si le câblage ou le transport exige une entrée manuelle, placer d’abord
la carte en mode téléchargement avec BOOT et RESET. Le stub standard
s’exécute en RAM.
Le mode ROM seule donne l'identité sans charger de stub.

## Console série

Dans **Cartes actives**, saisir un nom et cliquer sur **Ajouter une carte**.
IDLab cherche automatiquement une réponse du chargeur sans demander de
reset. Si le chargeur répond, IDLab identifie la puce et prépare la lecture
flash. Si le chargeur ne répond pas, IDLab ouvre la console à 115 200 bauds.
Sur un pont USB–UART, le débit flash choisi dans les options avancées
s’applique après synchronisation et démarrage du stub. IDLab vérifie
sa réponse au nouveau débit avant de commencer une lecture. Si le débit
n’est pas confirmé, redémarrer manuellement en téléchargement et ajouter
la carte avec un débit inférieur. En USB natif, la vitesse utile se lit
dans **Dernière lecture flash**, en Kio/s.
Quand la carte est détectée en téléchargement à la connexion, le reset depuis IDLab et
l’onglet **Consoles** sont indisponibles. L’API des cartes n’expose aucune
commande de reset matériel. Pour retrouver la console,
déconnecte la carte dans IDLab, appuie sur RESET sans maintenir BOOT,
puis reconnecte-la depuis la liste des cartes.
Si IDLab a ouvert le chargeur depuis une console déjà active, le même
bouton devient **Revenir à la console**. Le retour est disponible sur les
ports à reset automatique quand le web a la main.
Le panneau Identification reprend les indices du démarrage ESP-IDF visibles
sur l’UART, dont la puce, la révision et la taille flash configurée.
**Identifier**, **Relire la table** et **Lire la flash** passent par le
connecteur de la carte. Sur un pont UART reconnu ou USB Serial/JTAG, elles
ouvrent le chargeur si nécessaire, puis rétablissent le mode de départ.
La carte peut redémarrer et la capture UART est suspendue pendant
l’opération. Si le port exige une entrée manuelle, place la carte en mode
téléchargement et reconnecte-la avant la lecture.
L’identité mesurée et la capture restent affichées au retour en console.
Une lecture couvrant une grande plage reste une seule requête API et une
seule opération dans l’historique. Le connecteur transmet les données au
serveur par blocs de 4 Mio maximum.
Dans **Opérations → Historique des opérations**, le bouton **Inspecter**
rouvre le résultat d’une lecture flash de la carte sélectionnée. Le détail
peut être copié ou téléchargé en JSON. L’historique est conservé tant que
la page reste ouverte et que la carte reste dans la liste.
**Opérations → ROM seule** ouvre une session
sans stub sur la carte sélectionnée, affiche son identité et permet une
lecture du JEDEC. Pendant cette session, **Consoles**, **Partitions**,
**Plan flash**, **Lecture mémoire** et **Déclencheurs et outils** sont grisés
pour la carte sélectionnée. Une boîte de dialogue propose un reset
automatique depuis une console sur un port compatible. Elle guide
l’entrée manuelle avec BOOT et RESET dans les autres cas. Si le navigateur détecte à
nouveau le même port, IDLab tente la connexion automatiquement. La boîte
se ferme une fois la session ROM confirmée. La tentative manuelle reste
disponible via **Essayer la connexion**.

## Piloter depuis Python

Installer le client avec `python -m pip install ./clients/python`. Utiliser la
même valeur de `IDLAB_TOKEN` pour le serveur et le script, puis connecter la
carte dans le navigateur.

```python
from idlab_client import IDLabClient

lab = IDLabClient()
with lab.control("ma-carte", token_de_pilotage) as board:
    if board.mode == "console":
        board.write_uart("status\n")
        board = board.enter_loader()
    data = board.read_flash(address=0x10000, size=4096)
    if "mode.console" in board.capabilities:
        board = board.return_console()
```

Dans l’interface, **Get token** crée le jeton de pilotage de la carte
connectée en console ou en mode chargeur. Le bloc `with` tient la session exclusive et rend
la main en sortant. Utiliser `IDLAB_TOKEN` pour `devices()` et
`identify()` en observation. Le client transmet les refus du serveur
avec `IDLabHTTPError.status` et `IDLabHTTPError.code`.

Pour rattacher des opérations à une campagne, crée-la avec
`lab.create_campaign("Lecture de référence", metadata={"scenario": "backup"})`
puis utilise `board.for_campaign(campaign["id"])` dans la session de
pilotage. `lab.campaign_operations(campaign["id"])` consulte le suivi,
et `lab.finish_campaign(campaign["id"], "PASS")` enregistre le verdict.
Dans le web, **Utiliser cette campagne** applique ce même rattachement
aux opérations lancées dans la page.

## Appeler l'API HTTP

La [référence API v1](docs/api.md) décrit les commandes HTTP, les opérations
des cartes et le cycle de vie des campagnes.

Définir `IDLAB_TOKEN` dans l'environnement du serveur et du script. Garder
sa valeur hors du dépôt. Le navigateur local fonctionne avec son propre
cookie de session. Le serveur écoute uniquement sur la boucle locale.

| Requête | Résultat |
|---|---|
| `GET /api/v1/devices` | Cartes présentes et capacités de chaque session |
| `GET /api/v1/devices/{name}` | Identité, transport, chargeur et génération |
| `POST /api/v1/devices/{name}/flash/read` | Octets bruts demandés, jusqu’à la capacité détectée et 64 Mio maximum |
| `GET /api/v1/devices/{name}/uart` | Capture UART, avec génération et curseur |
| `GET /api/v1/devices/{name}/activity` | Journal, progression et opérations récentes de la génération |

Pour lire, envoyer `{"generation":"…","address":0,"size":4096}` avec le
type `application/json`. La génération de l'identification empêche
d'exécuter la demande sur une autre session. Une seule lecture est active
par carte. Une lecture incomplète ferme la session sans rendre de
résultat partiel. Pour lire de nouveau, reconnecter la carte et l'identifier.
Le navigateur autorise et ouvre le port Web Serial. Une fois la carte
connectée, le web et Python utilisent les mêmes commandes et les mêmes
routes de consultation. Les données UART reçues passent du connecteur au
serveur par le WebSocket de la carte.

## Service web dédié

IDLab peut tourner dans un conteneur Docker indépendant du devcontainer.
L'[API de gestion du service](docs/service.md) permet de le démarrer,
de l'arrêter, de le redémarrer et de vérifier son état depuis un script.

## Développer dans VS Code

Sur Windows, les [tâches IDLab dans VS Code](docs/service.md#depuis-vs-code-sur-windows)
pilotent le serveur depuis la palette de commandes.

Avec l’extension **Dev Containers**, ouvrir le dépôt dans VS Code puis choisir
**Dev Containers: Reopen in Container**. Le conteneur de développement installe
Python 3.12, Node.js 22, le client Python en mode éditable et les dépendances
du cœur. VS Code sélectionne l’environnement Python dédié. Dans un terminal,
l’activer avec `. "$HOME/.venv/idlab/bin/activate"`.

Le serveur IDLab déployé reste dans son conteneur Compose. Pour l’utiliser depuis
un conteneur de développement isolé, suivre le
[transfert du port 8080](docs/service.md#depuis-le-devcontainer). Le navigateur
du poste opérateur conserve l’accès aux cartes via Web Serial.

## Tests sans matériel

```sh
cd core
python -m unittest discover -s tests -v
node --test tests/*.test.js
```

Pour tester le client Python contre le serveur avec un agent simulé, depuis la
racine après installation des dépendances de `core/` :

```sh
python -m pip install -e ./clients/python
python -m unittest discover -s clients/python/tests -v
```
