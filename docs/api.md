# API HTTP d’IDLab v1

L’interface web, l’API et l’agent WebSocket utilisent le même point d’entrée,
`http://127.0.0.1:8080`. Toute commande HTTP versionnée commence par
`/api/v1`.

| Famille | Rôle | Jeton pour les scripts |
|---|---|---|
| `/api/v1/httpd/*` | Cycle de vie du processus HTTP | `IDLAB_MANAGER_TOKEN` |
| `/api/v1/devices/*` | Identification et lectures flash | `IDLAB_TOKEN` |
| `/api/v1/campaigns/*` | Suivi des campagnes pilotées par les scripts | `IDLAB_TOKEN` |
| `/health` | Vérification de la disponibilité HTTP | Aucun depuis le point d’entrée local |

Envoyer le jeton avec `Authorization: Bearer <jeton>`. Les requêtes JSON
utilisent `Content-Type: application/json`. Le navigateur utilise son
cookie local pour les opérations des cartes et des campagnes. Ses requêtes de modification
doivent porter un en-tête `Origin` correspondant à l’hôte IDLab. Les routes
`httpd` sont réservées aux scripts authentifiés et refusent les requêtes
avec `Origin`.

Le WebSocket `/api/v1/activity` indique à l’interface si une action API est
en cours. Il envoie `{"active": true}` à la première action et
`{"active": false}` à la fin de la dernière. Le maintien de l’écran suit
cet état pour tous les clients. Les requêtes de consultation restent
passives par défaut. Un client peut signaler une lecture ponctuelle avec
`X-IDLab-Action: 1`.

## Processus HTTP

Ces routes sont disponibles lorsque le gestionnaire est démarré, y compris
pendant l’arrêt du processus HTTP des cartes. Les POST ont un corps vide.

| Méthode et chemin | Succès | Effet |
|---|---|---|
| `POST /api/v1/httpd/start` | `200 {"action":"start"}` | Lance le processus HTTP. Répéter la requête laisse en place un processus déjà actif. |
| `POST /api/v1/httpd/stop` | `200 {"action":"stop"}` | Arrête le processus HTTP et attend sa fin. Répéter la requête sur un processus arrêté réussit. |
| `POST /api/v1/httpd/restart` | `200 {"action":"restart"}` | Arrête le processus existant, puis lance un nouveau processus. |
| `GET /api/v1/httpd/status` | `200` et objet d’état | Renvoie `state` et `ready`. |

`state` vaut `stopped`, `running` ou `exited`. Dans ce dernier cas,
`exit_code` contient le code de sortie du processus. Après `start` ou
`restart`, attendre `ready: true` avant d’appeler les opérations du banc.
`GET /health` renvoie `200 {"status":"ready"}` quand le processus répond
et que le bundle du navigateur est disponible.

Un arrêt ou redémarrage invalide les sessions des cartes et interrompt leurs
lectures. Le navigateur doit reconnecter les cartes et obtenir de nouvelles
générations.

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${IDLAB_MANAGER_TOKEN}" \
  http://127.0.0.1:8080/api/v1/httpd/start

curl --fail-with-body \
  -H "Authorization: Bearer ${IDLAB_MANAGER_TOKEN}" \
  http://127.0.0.1:8080/api/v1/httpd/status
```

## Cartes

| Méthode et chemin | Succès |
|---|---|
| `GET /api/v1/devices` | `200`, objet indexé par nom de carte et vide quand aucune carte n’est connectée |
| `GET /api/v1/devices/{name}` | `200`, description de la session |
| `POST /api/v1/devices/{name}/flash/read` | `200`, octets bruts en `application/octet-stream` |

Le reset via l’API des cartes est disponible en console sur les transports
compatibles. En téléchargement, le retour automatique est réservé aux
connexions ayant ouvert le chargeur depuis la console. Si IDLab a détecté
le chargeur à la connexion, déconnecter la carte dans IDLab, appuyer
physiquement sur RESET sans maintenir BOOT, puis reconnecter la carte.
`POST /api/v1/httpd/restart` redémarre le processus HTTP.

### Pilotage exclusif

Pour une carte connectée en console ou en téléchargement, le web peut
créer un jeton avec **Get token**. Il est réutilisable tant que la carte
reste associée au même connecteur, y compris après une reconnexion dans
la même page. En cas de retrait de la carte ou de rechargement de la page,
révoquer l’ancien jeton et en créer un autre. Les jetons sont conservés
en mémoire jusqu’à leur révocation ou au redémarrage du serveur.

| Méthode et chemin sous `/api/v1/devices/{name}` | Accès et effet |
|---|---|
| `POST /control/token` | Session navigateur locale. Renvoie le jeton une fois. |
| `GET /control/connect` (WebSocket) | Le jeton de pilotage est envoyé en Bearer. Renvoie un identifiant secret de session et la génération. La connexion ouverte réserve la carte. |
| `POST /control/stop` | Session navigateur locale. Arrête le pilotage externe. Le jeton peut resservir. |
| `POST /control/revoke` | Session navigateur locale. Supprime le jeton et arrête le pilotage externe. |

Pendant le pilotage externe, la lecture flash exige l’identifiant secret
de la session en Bearer. Le jeton général `IDLAB_TOKEN` permet de consulter
l’état de la carte et de piloter les campagnes. Une deuxième session de
pilotage est refusée avec `409`. Une lecture interrompue par le web renvoie
`403 control_stopped` ou `403 control_revoked`. Si l’arrêt coupe un
transfert série, reconnecter la carte pour reprendre les commandes.

Le navigateur et Python appellent `POST /api/v1/devices/{name}/command`
avec `generation` et `command`. La réponse est la description actualisée
de la carte. Les bascules console–chargeur gardent la même génération et
le même canal agent.

| Commande | Effet |
|---|---|
| `uart.write` | Envoie de 1 à 1 900 octets en console. Champ `hex` sans séparateur. |
| `console.reset` | Redémarre le firmware depuis la console si le transport le permet. |
| `mode.loader` | Ouvre le chargeur flash depuis la console si le transport le permet. |
| `mode.console` | Revient en console depuis un chargeur ouvert par IDLab sur cette connexion. |
| `mode.rom` | Ouvre la ROM sur une carte connectée. Le booléen `reset` demande le reset automatique, autorisé depuis la console sur un transport compatible. |
| `rom.jedec` | Lit le JEDEC depuis la ROM. Le résultat est renvoyé dans `result`. |
| `identify` | Mesure l’identité matérielle. Depuis la console, passe par le chargeur puis revient à la console si le transport le permet. |

En cas d’échec de `mode.loader`, le connecteur tente de rétablir la
console si le port et la session sont encore actifs. La réponse
`502 device_command_failed` peut inclure un champ `detail` avec la
cause de l’échec.
Si le connecteur ne rend aucun résultat dans le délai de la commande,
l’API renvoie `504 device_command_timeout` et ferme la session de la carte.

`GET /api/v1/devices/{name}/uart?generation=…&cursor=…` renvoie les octets
RX en hexadécimal, le prochain curseur et le nombre d’octets perdus avant
ce curseur (`hex`, `cursor`, `dropped`). Sans curseur, la lecture commence
au plus ancien octet conservé. Le serveur conserve au plus 1 Mio par carte
et renvoie jusqu’à 64 Kio par appel. L’observation utilise le jeton général
ou celui de la session de pilotage. En Python, utiliser `board.read_uart()`.
L’interface web utilise `wait_ms=5000`. Au bout du journal, le serveur
attend l’arrivée de nouveaux octets ou l’expiration du délai. La réponse
est immédiate si des octets sont déjà disponibles. `wait_ms` est compris
entre 0 et 5000 et vaut 0 par défaut.

`GET /api/v1/devices/{name}/activity?generation=…` renvoie l’état de la
carte, la progression en cours, jusqu’à 300 messages du journal et les
100 dernières opérations de cette génération. La consultation utilise
les mêmes droits que la lecture UART. En Python, utiliser `board.activity()`.

Un nom de carte contient de 1 à 48 caractères ASCII parmi les lettres,
chiffres, tirets et underscores. Le premier caractère est alphanumérique.
Une description de session ressemble à ceci.

```json
{
  "generation": "85b2ec77efbf4fa597cc694633511718",
  "chip": "esp32s3",
  "mac": "10:20:30:40:50:60",
  "flash_size": 16777216,
  "transport": "usb_uart",
  "loader": "stub",
  "capabilities": ["identify", "flash.read"]
}
```

`flash_size` est exprimé en octets et peut valoir `null`. Le transport est
`usb_uart`, `usb_serial_jtag`, `usb_otg` ou `unknown`. Le chargeur est
`rom` ou `stub`. Vérifier `flash.read` dans les capacités avant de lancer
une lecture. `generation` change lorsque la carte se reconnecte.

Le corps d’une lecture contient la génération actuelle, une adresse entière
positive ou nulle et une taille entière de 1 octet jusqu’à la capacité de
la flash, avec un maximum de 64 Mio. Le connecteur transmet les octets
au serveur par blocs de 4 Mio maximum. Le champ `campaign_id` est facultatif. Une carte accepte une
lecture à la fois. Une lecture incomplète renvoie une erreur, ferme la session
et ne livre aucun résultat partiel.

## Campagnes

Une campagne regroupe les opérations d’un essai et son verdict. Le web
et les scripts associent une opération en envoyant `campaign_id` dans
le corps de `/command` ou de `/flash/read`. Ce champ est facultatif et
s’applique à la requête. Une campagne peut couvrir plusieurs cartes.

| Méthode et chemin | Corps JSON | Succès |
|---|---|---|
| `GET /api/v1/campaigns` | — | `200`, liste filtrée avec totaux et pagination |
| `POST /api/v1/campaigns` | `{"name":"Lecture de référence","metadata":{"scenario":"backup"}}` | `201`, campagne active et en-tête `Location` |
| `GET /api/v1/campaigns/{id}` | — | `200`, état, métadonnées, verdict et opérations en cours |
| `PATCH /api/v1/campaigns/{id}` | `{"name":"Nouveau nom"}`, `{"metadata":{…}}` ou les deux | `200`, campagne active mise à jour |
| `GET /api/v1/campaigns/{id}/operations` | — | `200`, historique paginé des opérations rattachées |
| `POST /api/v1/campaigns/{id}/finish` | `{"verdict":"PASS"}` | `200`, campagne terminée |
| `POST /api/v1/campaigns/{id}/abort` | `{"reason":"Arrêt opérateur"}` | `202` pendant une opération active, `200` une fois arrêtée |

Le nom, le verdict et le motif sont des chaînes non vides après suppression
des espaces aux extrémités, limitées respectivement à 120, 80 et 500
caractères. Le verdict est libre. Les métadonnées forment un objet JSON
facultatif, vide par défaut et limité à 3 000 octets sérialisés. Lors d’un
`PATCH`, fournir `metadata` remplace l’objet entier. Le statut évolue via
les actions de cycle de vie.

```json
{
  "id": "b3caa50230c14c978a8867f1bbbe8de9",
  "name": "Lecture de référence",
  "metadata": {"scenario": "backup"},
  "state": "active",
  "started_at": "2026-11-24T08:15:00.000+00:00",
  "ended_at": null,
  "abort_requested_at": null,
  "verdict": null,
  "reason": null,
  "in_flight": 0
}
```

- **`active`** accepte les opérations associées. `finish` réussit lorsqu’il
  n’y a plus d’opération en cours.
- **`abort_requested`** bloque les nouvelles opérations associées. Les
  opérations déjà admises continuent jusqu’à leur résultat ou leur échec.
  Interroger la campagne avec `GET` pour suivre l’arrêt.
- **`aborted`** indique que l’arrêt a été enregistré et qu’aucune opération
  associée n’est encore suivie. Le premier motif est conservé. Répéter
  `abort` sur une campagne déjà arrêtée conserve le même enregistrement.
- **`finished`** conserve le verdict du script. Répéter `finish` avec le
  même verdict conserve le même enregistrement.

Les horodatages sont en UTC. Les campagnes et leurs opérations survivent au redémarrage dans
`campaigns.sqlite3`. Compose conserve le fichier sur son volume `state`.
Hors conteneur, `IDLAB_STATE_DIR` choisit le dossier, avec
`~/.local/state/idlab` par défaut. Au redémarrage, les opérations
interrompues apparaissent en échec. Une campagne active reste active.
Pour une campagne encore en `abort_requested`, répéter `abort` pour
clôturer l’arrêt.

La liste des opérations accepte `limit` (1 à 100, 25 par défaut) et
`offset` (0 par défaut). Elle renvoie `items`, `total`, `limit` et
`offset`. Chaque entrée indique la carte, la génération, la commande,
l’état et le résultat disponible. Les dumps complets sont retournés
par la lecture flash.

### Liste, résumé et recherche

`GET /api/v1/campaigns` trie les campagnes du début le plus récent au plus
ancien (identifiant décroissant en cas d’égalité). Les filtres se cumulent,
sauf les valeurs répétées de `state` qui sont alternatives.

| Paramètre | Effet |
|---|---|
| `q` | Sous-chaîne du nom ou de l’identifiant, sans distinction de casse. Maximum 120 caractères. |
| `state` | `active`, `abort_requested`, `aborted` ou `finished`. Répétable. |
| `verdict` | Verdict exact, sensible à la casse. Maximum 80 caractères. |
| `from`, `to` | Dates de début incluses, au format `AAAA-MM-JJ` en UTC. |
| `limit` | De 1 à 100 résultats par page. Par défaut 25. |
| `offset` | Nombre de résultats à omettre, de 0 à 1 milliard. Par défaut 0. |

La réponse contient `items` (objets campagne), `total` (nombre de
correspondances avant pagination), `counts` (même total réparti par état,
y compris les états à zéro), `limit` et `offset`. Un décalage au-delà
des résultats donne une liste vide. Un filtre invalide donne
`400 invalid_campaign_filters`.

Pour le résumé des essais en cours, utiliser
`GET /api/v1/campaigns?state=active&state=abort_requested`.
Pour chercher un essai terminé, utiliser par exemple
`GET /api/v1/campaigns?q=ota&state=finished&verdict=PASS`.

### Exemple de bout en bout

Cet exemple utilise `jq`, une carte déjà connectée nommée `ma-carte` et
le jeton `IDLAB_TOKEN`.

```sh
base=http://127.0.0.1:8080/api/v1
auth="Authorization: Bearer ${IDLAB_TOKEN}"

campaign=$(curl -fsS -H "$auth" -H 'Content-Type: application/json' \
  --data '{"name":"Lecture de référence"}' "$base/campaigns" | jq -er .id)
generation=$(curl -fsS -H "$auth" "$base/devices/ma-carte" | jq -er .generation)

payload=$(jq -n --arg generation "$generation" --arg campaign "$campaign" \
  '{generation:$generation,address:0,size:4096,campaign_id:$campaign}')
curl --fail-with-body -H "$auth" -H 'Content-Type: application/json' \
  --data "$payload" "$base/devices/ma-carte/flash/read" --output readback.bin
```

Après vérification du fichier, le script peut clôturer l’essai. Cet appel
illustre un verdict `PASS` décidé par le script.

```sh
curl --fail-with-body -H "$auth" -H 'Content-Type: application/json' \
  --data '{"verdict":"PASS"}' "$base/campaigns/$campaign/finish"
```

## Erreurs à traiter

Les erreurs métier utilisent un objet `{"error":"code"}`. Les erreurs de
routage ou de taille émises par le serveur HTTP peuvent avoir un autre format.

| HTTP | Codes courants | Action côté script |
|---|---|---|
| `400` | `invalid_json`, `invalid_arguments`, `invalid_flash_range`, `unexpected_arguments`, `invalid_campaign_filters` | Corriger la requête. |
| `401` | `authentication_required` | Utiliser le jeton du bon service. |
| `403` | `local_host_required`, `local_access_required`, `local_script_required`, `origin_mismatch` | Vérifier le point d’entrée et le mode d’accès. |
| `404` | `device_disconnected`, `campaign_not_found` | Vérifier le nom de carte ou l’identifiant de campagne. |
| `409` | `device_busy`, `campaign_busy`, `manager_busy` | Attendre la fin de l’opération en cours. |
| `409` | `device_session_changed`, `operation_unsupported`, `campaign_not_active` | Relire respectivement la session, les capacités ou l’état de la campagne. |
| `502` | `read_incomplete_reconnect_required`, `http_start_failed` | Reconnecter la carte pour la lecture, ou consulter l’état du service HTTP. |
| `503` | `idlab_http_unavailable`, `browser_bundle_unavailable`, `manager_stopping` | Vérifier la disponibilité du service. |

En cas de perte de la réponse à la création d’une campagne, une nouvelle
requête `POST /api/v1/campaigns` crée un autre identifiant.
