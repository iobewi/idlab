# IDLab

IOBEWI Device Lab relie des cartes embarquées aux scripts et à l'interface
opérateur. Le navigateur possède les ports Web Serial. Le serveur local
coordonne les appels. Les deux utilisent la même opération de lecture.

Ce premier lot contient le serveur, le navigateur et le pilote ESP32.
Il couvre la connexion, l'identification et la lecture flash. L'API HTTP
peut déjà être utilisée depuis un script.

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

## Appeler l'API

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
L'[API de gestion du service](service/README.md) permet de le démarrer,
de l'arrêter, de le redémarrer et de vérifier son état depuis un script.

## Tests sans matériel

```sh
cd core
python -m unittest discover -s tests -v
node --test tests/*.test.js
```
