# IDLab

IOBEWI Device Lab relie des cartes embarquées aux scripts et à l'interface
opérateur. Le navigateur possède les ports Web Serial. Le serveur local
coordonne les appels. Les deux utilisent la même opération de lecture.

`core/` contient le serveur, le navigateur et le pilote ESP32.
`client/` fournit le connecteur Python. Le banc couvre la connexion,
l'identification et la lecture flash.

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
Si le câblage ne permet pas le reset automatique, cocher l'option de mode
téléchargement manuel. Pour un transport inconnu ou USB-OTG, placer d'abord
la carte en mode téléchargement. Le stub standard s'exécute en RAM.
Le mode ROM seule donne l'identité sans charger de stub.

## Console série

Dans **Cartes actives**, saisir un nom et cliquer sur **Ajouter une carte**.
Le mode **Automatique** cherche une réponse du chargeur sans demander de
reset. Si le chargeur répond, IDLab identifie la puce et prépare la lecture
flash. Si le chargeur ne répond pas, IDLab ouvre la console. Le mode
**Console série** ouvre directement le port, sans envoyer de trame SYNC.
Le panneau Identification reprend les indices du démarrage ESP-IDF visibles
sur l’UART, dont la puce, la révision et la taille flash configurée.
**Identifier**, **Relire la table** et **Lire la flash** passent par le
connecteur de la carte. Sur un pont UART reconnu ou USB Serial/JTAG, elles
ouvrent le chargeur si nécessaire, puis rétablissent le mode de départ.
La carte peut redémarrer et la capture UART est suspendue pendant
l’opération. Pour un port à entrée manuelle, place la carte en mode
téléchargement et reconnecte-la en **Automatique** avant la lecture.
L’identité mesurée et la capture restent affichées au retour en console.
Les options avancées règlent le débit UART, l’ouverture en console seule
et l’entrée BOOT manuelle. **Opérations → ROM seule** ouvre une session
sans stub sur la carte sélectionnée, affiche son identité et permet une
lecture du JEDEC. Une boîte de dialogue demande confirmation du reset automatique ou
guide l’entrée manuelle avec BOOT et RESET. Si le navigateur détecte à
nouveau le même port, IDLab tente la connexion automatiquement. La boîte
se ferme une fois la session ROM confirmée. La tentative manuelle reste
disponible via **Essayer la connexion**. En ROM avec entrée manuelle,
le retour console passe par une déconnexion et un RESET sans maintenir
BOOT, puis une reconnexion.

## Piloter depuis Python

Installer le connecteur avec `python -m pip install ./client`. Utiliser la
même valeur de `IDLAB_TOKEN` pour le serveur et le script, puis connecter la
carte dans le navigateur.

```python
from idlab_client import IDLabClient

lab = IDLabClient()
print(lab.devices())
board = lab.identify("ma-carte")
data = board.read_flash(address=0x10000, size=4096)
```

Chaque objet `Board` est lié à une génération. Après une reconnexion,
appeler de nouveau `identify`. Le client transmet les refus du serveur
avec `IDLabHTTPError.status` et `IDLabHTTPError.code`.

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
| `POST /api/v1/devices/{name}/flash/read` | Octets bruts demandés, de 1 octet à 4 Mio |

Pour lire, envoyer `{"generation":"…","address":0,"size":4096}` avec le
type `application/json`. La génération de l'identification empêche
d'exécuter la demande sur une autre session. Une seule lecture est active
par carte. Une lecture incomplète ferme la session sans rendre de
résultat partiel. Pour lire de nouveau, reconnecter la carte et l'identifier.

## Service web dédié

IDLab peut tourner dans un conteneur Docker indépendant du devcontainer.
L'[API de gestion du service](docs/service.md) permet de le démarrer,
de l'arrêter, de le redémarrer et de vérifier son état depuis un script.

## Développer dans VS Code

Sur Windows, les [tâches IDLab dans VS Code](docs/service.md#depuis-vs-code-sur-windows)
pilotent le serveur depuis la palette de commandes.

Avec l’extension **Dev Containers**, ouvrir le dépôt dans VS Code puis choisir
**Dev Containers: Reopen in Container**. Le conteneur de développement installe
Python 3.12, Node.js 22, le connecteur Python en mode éditable et les dépendances
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

Pour tester le connecteur contre le serveur avec un agent simulé, depuis la
racine après installation des dépendances de `core/` :

```sh
python -m pip install -e ./client
python -m unittest discover -s client/tests -v
```
