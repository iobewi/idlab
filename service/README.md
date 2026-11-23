# Gestion du service web IDLab

Le serveur web tourne dans le conteneur `core`. Le gestionnaire tourne sur
l'hôte Docker et reste disponible quand le conteneur est arrêté. Le
devcontainer peut appeler les deux API par HTTP. Le navigateur reste
propriétaire des ports Web Serial.

## Première installation

Depuis la racine du dépôt, sur l'hôte Docker, avec Docker Engine 28 ou plus
récent, le plugin Docker Compose et Python 3.12+ :

```sh
python -m pip install -r core/requirements.txt
docker compose build core
python service/manager.py
```

Avant de lancer le gestionnaire, définir dans son environnement un secret
aléatoire `IDLAB_MANAGER_TOKEN`. Si des scripts doivent aussi accéder à
l'API du banc, définir séparément `IDLAB_TOKEN` dans le même environnement.
Compose transmet seulement `IDLAB_TOKEN` au conteneur. Garder les secrets
hors de Git. Le compte qui lance le gestionnaire doit pouvoir appeler Docker.

## Appels HTTP

Le gestionnaire écoute sur `127.0.0.1:8081`. Chaque requête doit porter
`Authorization: Bearer <IDLAB_MANAGER_TOKEN>`. Les POST ont un corps vide.

| Requête | Effet |
|---|---|
| `GET /v1/status` | Renvoie `state`, `health` et `ready`. `ready` vaut vrai si le conteneur est en cours d'exécution et que Docker le déclare sain. |
| `POST /v1/start` | Démarre le conteneur à partir de l'image construite. |
| `POST /v1/stop` | Arrête le conteneur. |
| `POST /v1/restart` | Redémarre un conteneur déjà créé. Pour le premier démarrage, utiliser `start`. |

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${IDLAB_MANAGER_TOKEN}" \
  http://127.0.0.1:8081/v1/start

curl --fail-with-body \
  -H "Authorization: Bearer ${IDLAB_MANAGER_TOKEN}" \
  http://127.0.0.1:8081/v1/status
```

Le gestionnaire redémarre les conteneurs existants avec leur image actuelle.
Pour appliquer une image ou une configuration modifiée, exécuter
`docker compose up -d --build core` sur l'hôte Docker.

Un succès sur `start` ou `restart` indique que Compose a terminé sa commande.
Attendre `ready: true` via `status` avant de lancer un script. Le contrôle
de santé du conteneur utilise `GET http://127.0.0.1:8080/health`.
Une autre commande en cours donne `409 manager_busy`. Un échec de Compose
donne `502 compose_failed`. Après un délai dépassé (`504 compose_timeout`),
relire l'état avant de réessayer.

Un arrêt ou redémarrage ferme les sessions des cartes et interrompt les
lectures actives. Reconnecter les cartes dans le navigateur après reprise.

## Depuis le devcontainer

Sur l'hôte Docker, les deux ports sont publiés en boucle locale. Si le
devcontainer a son propre réseau, établir un tunnel SSH depuis celui-ci
vers l'hôte Docker, puis conserver les mêmes URL HTTP :

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8080:127.0.0.1:8080 \
  -L 127.0.0.1:8081:127.0.0.1:8081 utilisateur@hote-docker
```

Utiliser les jetons correspondants depuis le devcontainer. Seul le
conteneur IDLab rejoint le réseau Compose du service. L'interface web
s'ouvre sur le poste opérateur à l'adresse `http://127.0.0.1:8080`, avec le
même transfert du port 8080 si l'hôte Docker est distant.

## Tests logiciels

Depuis la racine, `python -m unittest discover -s service/tests -v`
teste l'API du gestionnaire avec des réponses Compose simulées.
