# Gestion du service HTTP IDLab

Le gestionnaire et le serveur HTTP tournent dans le même conteneur.
Le gestionnaire démarre avec le conteneur. Le serveur HTTP démarre sur
commande et peut être arrêté ou redémarré indépendamment.

## Lancer le conteneur

Sur l'hôte Docker, définir un secret aléatoire `IDLAB_MANAGER_TOKEN` et
exécuter `docker compose up -d --build core` depuis la racine du dépôt.
Définir séparément `IDLAB_TOKEN` si des scripts doivent aussi accéder à
l'API du banc. Le gestionnaire, l’interface, l’API et Web Serial utilisent le même port public `8080`.
Compose le publie sur `127.0.0.1` de l’hôte. Le serveur HTTP enfant écoute
sur un port privé du conteneur. Utiliser Docker Engine 28 ou plus récent.

Pour servir IDLab sur une autre machine, placer un reverse proxy HTTPS devant
le port du gestionnaire et définir `IDLAB_PUBLIC_ORIGIN` avec l’origine exacte,
par exemple `https://lab.example.org`. Le proxy doit conserver `Host` et
transmettre les WebSockets. Le SDK Python accepte cette URL HTTPS. Pour une
interface publique, réserver `/api/v1/httpd/` à l’accès d’administration dans
la configuration du proxy.

## Connecter un client depuis Docker

Depuis le conteneur client, vérifier d’abord la connectivité avec
`curl --fail --connect-timeout 3 http://host.docker.internal:8080/health`.
Si la publication sur la boucle locale de l’hôte est inaccessible depuis
ce conteneur, utiliser un réseau Docker partagé et l’alias du service sur
ce réseau comme adresse du SDK.

Avec le SDK 0.1.1 ou plus récent et une carte connectée dans l’interface,
générer son jeton via **Autorisations**, puis lire la capture UART depuis
le conteneur client. Le bloc `with` libère le pilotage en sortant.

```python
from getpass import getpass
from idlab_client import IDLabClient

lab = IDLabClient("http://host.docker.internal:8080", allow_insecure_http=True)
with lab.control("board_1", getpass("Jeton de pilotage : ")) as board:
    data, cursor, dropped = board.read_uart()
    print(f"{len(data)} octets, curseur {cursor}, {dropped} octets perdus")
```

Réserver `allow_insecure_http=True` aux réseaux privés de confiance.
Sur HTTP, les jetons circulent en clair. Pour une instance HTTPS, utiliser
l’URL HTTPS sans cette option.

## Depuis VS Code sur Windows

Ouvrir le dépôt dans une **fenêtre locale Windows** de VS Code. Si la fenêtre
est attachée au Dev Container, ouvrir le même dossier dans une deuxième fenêtre
locale. Dans la palette `Ctrl+Maj+P`, choisir **Tasks: Run Task**, puis une
tâche **IDLab**.

1. **Préparer le conteneur** construit et lance le conteneur Compose. Si aucun
   jeton ni fichier `.env` n’existe, cette tâche génère un jeton de gestion
   dans le fichier local `.env`, ignoré par Git.
2. **Démarrer le serveur HTTP** lance le processus HTTP et attend qu’il soit
   prêt. Ouvrir ensuite `http://127.0.0.1:8080/` dans le navigateur Windows.
3. **État du serveur HTTP**, **Arrêter le serveur HTTP** et **Redémarrer le
   serveur HTTP** pilotent le même processus par API sur le port 8080.

Après une modification des fichiers web, lancer **IDLab : Rechargement
complet**. Cette tâche reconstruit l’image avec le code de la branche
ouverte, recrée le conteneur `core`, puis démarre le serveur HTTP et attend
`ready: true`. Le volume des campagnes est conservé. Les sessions de carte
sont fermées pendant la recréation. Une fois la tâche terminée, recharger la
page Firefox et reconnecter les cartes au besoin.

Les tâches utilisent `IDLAB_MANAGER_TOKEN` dans l’environnement de VS Code
ou une ligne `IDLAB_MANAGER_TOKEN=valeur` sans guillemets dans `.env`.
Pour un conteneur déjà lancé, reprendre le jeton utilisé au démarrage. Un
jeton défini dans une session PowerShell séparée doit être ajouté au `.env`
local ou transmis à l’environnement de VS Code.
Le conteneur de développement peut être fermé indépendamment du serveur.

## Appels HTTP

Voir la [référence API v1](api.md) pour les cartes et les campagnes.

Chaque requête de gestion doit porter
`Authorization: Bearer <IDLAB_MANAGER_TOKEN>`. Les POST ont un corps vide.

| Requête | Effet |
|---|---|
| `GET /api/v1/httpd/status` | Renvoie `state` (`stopped`, `running` ou `exited`) et `ready`. En cas de sortie du processus, donne aussi `exit_code`. |
| `POST /api/v1/httpd/start` | Lance le serveur HTTP. Si le processus tourne déjà, le laisse en place. |
| `POST /api/v1/httpd/stop` | Arrête le serveur HTTP et attend la fin du processus. |
| `POST /api/v1/httpd/restart` | Arrête le serveur HTTP, puis démarre un nouveau processus. |

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${IDLAB_MANAGER_TOKEN}" \
  http://127.0.0.1:8080/api/v1/httpd/start

curl --fail-with-body \
  -H "Authorization: Bearer ${IDLAB_MANAGER_TOKEN}" \
  http://127.0.0.1:8080/api/v1/httpd/status
```

Après `start` ou `restart`, attendre `ready: true`. Ce champ indique
que le processus HTTP démarré par le gestionnaire répond à `/health`.
Quand le serveur HTTP est arrêté, les routes de gestion restent accessibles
et les autres routes renvoient `503 idlab_http_unavailable`.
Une commande concurrente donne `409 manager_busy`. Un arrêt ou
redémarrage ferme les sessions de carte. Reconnecter les cartes dans
le navigateur.

Docker Compose reste l'outil de déploiement du conteneur. Pour appliquer
une image ou une configuration modifiée, relancer
`docker compose up -d --build core` sur l'hôte Docker.

## Depuis le devcontainer

Si le devcontainer a son propre réseau, établir un tunnel SSH depuis
celui-ci vers l'hôte Docker pour conserver les mêmes URL HTTP.

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8080:127.0.0.1:8080 utilisateur@hote-docker
```

Le navigateur reste propriétaire des ports Web Serial. Il ouvre
`http://127.0.0.1:8080` sur le poste opérateur, avec un transfert du
port 8080 si l'hôte Docker est distant.

## Tests sans Docker

Après installation des dépendances de `core/` et
`npm ci --ignore-scripts --prefix core`, exécuter
`python -m unittest discover -s tests -p test_manager.py -v` depuis `core/`.
Le test de cycle de vie lance le véritable serveur HTTP comme processus
enfant, sur un port de test.
