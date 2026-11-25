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
À l’ajout d’une carte, IDLab complète automatiquement son identification
via le chargeur. Si la carte était en console et que le port permet la
bascule automatique, le firmware redémarre et IDLab revient en console.
Les mesures sont conservées lors d’une reconnexion au même port dans
la page et effacées si la carte est débranchée. Si l’identification
complète est impossible, la console affiche les indices disponibles
dans les logs UART. Le bouton **Ouvrir le chargeur flash** permet
de réessayer sur un port à bascule automatique.

**Relire la table** et **Lire la flash** ouvrent le chargeur si nécessaire,
puis rétablissent le mode de départ. Si le port exige une entrée
manuelle, place la carte en téléchargement avec BOOT et RESET avant de
la reconnecter.
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

Les versions du client sont distribuées dans les
[releases GitHub](https://github.com/iobewi/idlab/releases). Installer le fichier
`.whl` de la version souhaitée avec Python 3.12 ou plus récent.

```powershell
py -m pip install "https://github.com/iobewi/idlab/releases/download/python-client-v0.1.0/idlab_client-0.1.0-py3-none-any.whl"
```

Adapter la version dans l’URL à la release choisie. Pour essayer une version
avant sa publication, télécharger `idlab-client-wheel` depuis une exécution
réussie du [workflow Python client](https://github.com/iobewi/idlab/actions/workflows/python-client.yml),
extraire le `.whl` et passer son chemin à `pip install`. Depuis un dépôt local,
`python -m pip install ./clients/python` reste disponible. Utiliser la même
valeur de `IDLAB_TOKEN` pour le serveur et le script, puis connecter la carte
dans le navigateur.

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

Dans **Autorisations**, le bouclier avec un plus crée un jeton de pilotage.
Le bouclier coché indique que le jeton est émis. Clique à nouveau sur
l’icône pour le révoquer. Le bloc `with` tient la session exclusive et rend
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

Depuis un conteneur `rust_dev`, si IDLab est joignable sur l’hôte Docker,
utiliser `IDLabClient("http://host.docker.internal:8080", allow_insecure_http=True)`
avec le SDK 0.1.1 ou plus récent. Voir le
[test de connexion Docker](docs/service.md#connecter-un-client-depuis-docker).

## Appeler l'API HTTP

La [référence API v1](docs/api.md) décrit les commandes HTTP, les opérations
des cartes et le cycle de vie des campagnes.

L’interface s’ouvre sans connexion. Lorsque le navigateur ajoute une carte
ou crée une campagne, le serveur ouvre une session privée par cookie
`HttpOnly`. Chaque session a ses propres cartes, captures et campagnes.
Le jeton **Autorisations** délègue une seule carte à Python.

Définir `IDLAB_TOKEN` côté serveur et côté script pour consulter le banc ou
gérer les campagnes de service. Garder sa valeur hors du dépôt. Le point
d’entrée est publié sur la boucle locale par défaut. Voir les
[paramètres du service HTTP](docs/service.md) pour une origine HTTPS externe.

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

Pour publier une version du client, ouvrir **Actions → Python client → Run workflow**
et sélectionner la branche `main`. La version est lue dans
`clients/python/pyproject.toml`. La CI construit, installe et teste le `.whl`,
puis crée le tag `python-client-v<VERSION>` sur le commit testé et publie le wheel
dans une release GitHub. Une release existante n'est jamais remplacée : augmenter
la version du paquet avant une nouvelle publication. Les PR et les pushes sur
`main` valident le paquet sans le publier.
