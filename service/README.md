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

## Appels HTTP

Chaque requête de gestion doit porter
`Authorization: Bearer <IDLAB_MANAGER_TOKEN>`. Les POST ont un corps vide.

| Requête | Effet |
|---|---|
| `GET /v1/httpd/status` | Renvoie `state` (`stopped`, `running` ou `exited`) et `ready`. En cas de sortie du processus, donne aussi `exit_code`. |
| `POST /v1/httpd/start` | Lance le serveur HTTP. Si le processus tourne déjà, le laisse en place. |
| `POST /v1/httpd/stop` | Arrête le serveur HTTP et attend la fin du processus. |
| `POST /v1/httpd/restart` | Arrête le serveur HTTP, puis démarre un nouveau processus. |

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${IDLAB_MANAGER_TOKEN}" \
  http://127.0.0.1:8080/v1/httpd/start

curl --fail-with-body \
  -H "Authorization: Bearer ${IDLAB_MANAGER_TOKEN}" \
  http://127.0.0.1:8080/v1/httpd/status
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
`python -m unittest discover -s service/tests -v` depuis la racine.
Le test de cycle de vie lance le véritable serveur HTTP comme processus
enfant, sur un port de test.
