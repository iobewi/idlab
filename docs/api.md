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
cookie local pour les opérations des cartes et des campagnes. Ses POST
doivent porter un en-tête `Origin` correspondant à l’hôte IDLab. Les routes
`httpd` sont réservées aux scripts authentifiés et refusent les requêtes
avec `Origin`.

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
positive ou nulle et une taille entière de 1 octet à 4 Mio. La plage doit tenir
dans la flash. Le champ `campaign_id` est facultatif. Une carte accepte une
lecture à la fois. Une lecture incomplète renvoie une erreur, ferme la session
et ne livre aucun résultat partiel.

## Campagnes

Une campagne suit un essai composé par un script. Le script choisit les
opérations et le verdict. Chaque lecture qui doit être suivie par la campagne
envoie son `campaign_id`. Les lectures qui omettent ce champ restent
indépendantes.

| Méthode et chemin | Corps JSON | Succès |
|---|---|---|
| `POST /api/v1/campaigns` | `{"name":"Lecture de référence"}` | `201`, campagne active et en-tête `Location` |
| `GET /api/v1/campaigns/{id}` | — | `200`, campagne connue |
| `POST /api/v1/campaigns/{id}/finish` | `{"verdict":"PASS"}` | `200`, campagne terminée |
| `POST /api/v1/campaigns/{id}/abort` | `{"reason":"Arrêt opérateur"}` | `202` pendant une lecture active, `200` une fois arrêtée |

Le nom, le verdict et le motif sont des chaînes non vides après suppression
des espaces aux extrémités, limitées respectivement à 120, 80 et 500
caractères. Le verdict est libre. Une campagne suit les lectures admises
par le serveur. Elle peut couvrir plusieurs cartes.

```json
{
  "id": "b3caa50230c14c978a8867f1bbbe8de9",
  "name": "Lecture de référence",
  "state": "active",
  "started_at": "2026-11-24T08:15:00.000+00:00",
  "ended_at": null,
  "abort_requested_at": null,
  "verdict": null,
  "reason": null,
  "in_flight": 0
}
```

- **`active`** accepte les lectures associées. `finish` réussit lorsqu’il
  n’y a plus de lecture en cours.
- **`abort_requested`** bloque les nouvelles lectures associées. Les
  lectures déjà admises continuent jusqu’à leur résultat ou leur échec.
  Interroger la campagne avec `GET` pour suivre l’arrêt.
- **`aborted`** indique que l’arrêt a été enregistré et qu’aucune lecture
  associée n’est encore suivie. Le premier motif est conservé. Répéter
  `abort` sur une campagne déjà arrêtée conserve le même enregistrement.
- **`finished`** conserve le verdict du script. Répéter `finish` avec le
  même verdict conserve le même enregistrement.

Les horodatages sont en UTC. Les campagnes survivent au redémarrage dans
`campaigns.sqlite3`. Compose conserve le fichier sur son volume `state`.
Hors conteneur, `IDLAB_STATE_DIR` choisit le dossier, avec
`~/.local/state/idlab` par défaut. Le nombre de lectures en cours concerne
le processus courant. Après une coupure brutale, une campagne active reste
active. Si elle est encore en `abort_requested`, examiner le résultat
éventuel de l’ancienne lecture puis répéter `abort` pour clôturer l’arrêt.
Le serveur ne rejoue aucune lecture ni aucun verdict.

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
| `400` | `invalid_json`, `invalid_arguments`, `invalid_flash_range`, `unexpected_arguments` | Corriger la requête. |
| `401` | `authentication_required` | Utiliser le jeton du bon service. |
| `403` | `local_host_required`, `local_access_required`, `local_script_required`, `origin_mismatch` | Vérifier le point d’entrée et le mode d’accès. |
| `404` | `device_disconnected`, `campaign_not_found` | Vérifier le nom de carte ou l’identifiant de campagne. |
| `409` | `device_busy`, `campaign_busy`, `manager_busy` | Attendre la fin de l’opération en cours. |
| `409` | `device_session_changed`, `operation_unsupported`, `campaign_not_active` | Relire respectivement la session, les capacités ou l’état de la campagne. |
| `502` | `read_incomplete_reconnect_required`, `http_start_failed` | Reconnecter la carte pour la lecture, ou consulter l’état du service HTTP. |
| `503` | `idlab_http_unavailable`, `browser_bundle_unavailable`, `manager_stopping` | Vérifier la disponibilité du service. |

En cas de perte de la réponse à la création d’une campagne, une nouvelle
requête `POST /api/v1/campaigns` crée un autre identifiant.
