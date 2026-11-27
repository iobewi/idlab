# API HTTP d’IDLab v1

L’interface web, l’API et l’agent WebSocket utilisent le même point d’entrée,
`http://127.0.0.1:8080`. Toute commande HTTP versionnée commence par
`/api/v1`.

| Famille | Rôle | Jeton pour les scripts |
|---|---|---|
| `/api/v1/httpd/*` | Cycle de vie du processus HTTP | `IDLAB_MANAGER_TOKEN` |
| `/api/v1/web/session` | Ouverture et vérification de la session du navigateur | Cookie `idlab_session` |
| `/api/v1/devices/*` | Observation et pilotage des cartes | `IDLAB_TOKEN` pour l’observation, jeton de session de pilotage pour les commandes |
| `/api/v1/campaigns/*` | Suivi des campagnes pilotées par les scripts | `IDLAB_TOKEN` |
| `/health` | Vérification de la disponibilité HTTP | Aucun depuis le point d’entrée local |

Envoyer le jeton avec `Authorization: Bearer <jeton>`. Les requêtes JSON
utilisent `Content-Type: application/json`. La page d’accueil est accessible sans
cookie. `POST /api/v1/web/session` remet un cookie `HttpOnly`, `SameSite=Strict`
et `Secure` sur HTTPS. `GET /api/v1/web/session` répond `204` avec ce cookie et
`401` en l’absence de session. Les modifications et WebSockets du navigateur
exigent un en-tête `Origin` correspondant à une origine Web configurée. Les routes
`httpd` sont réservées aux scripts authentifiés et refusent les requêtes
avec `Origin`.

Le WebSocket `/api/v1/activity` indique à l’interface si une action API est
en cours. Il envoie `{"active": true}` à la première action et
`{"active": false}` à la fin de la dernière. Le maintien de l’écran suit
les actions du navigateur et des clients qui pilotent ses cartes. Les requêtes de consultation restent
passives par défaut. Un client peut signaler une lecture ponctuelle avec
`X-IDLab-Action: 1`.

Les noms de cartes et les campagnes sont propres à chaque session Web. Avec
`IDLAB_TOKEN`, l’observation globale omet les noms de cartes ambigus et les
routes de campagne accèdent à l’espace des scripts, qui contient aussi les
campagnes créées avant l’isolation. Pour rattacher une opération déléguée à
une campagne de cet espace, joindre `X-IDLab-API-Authorization: Bearer <IDLAB_TOKEN>`
avec le jeton de pilotage habituel dans `Authorization`. Le SDK ajoute cet en-tête
aux opérations avec `campaign_id` quand `IDLAB_TOKEN` est configuré.

L’ouverture de session crée un espace anonyme. Le cookie reconnaît cet
espace et permet de retrouver ses campagnes après redémarrage du serveur.
Si le navigateur supprime le cookie ou termine sa session sans le restaurer,
les campagnes restent en base et la session anonyme n’a pas de mécanisme de
récupération. L’expiration et la révocation des sessions Web ne sont pas
encore implémentées.

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
créer un jeton avec le bouclier dans **Autorisations**. Le bouclier
coché indique que le jeton est émis et permet de le révoquer. Le jeton
est réutilisable tant que la carte
reste associée au même connecteur, y compris après une reconnexion dans
la même page. En cas de retrait de la carte ou de rechargement de la page,
révoquer l’ancien jeton et en créer un autre. Les jetons sont conservés
en mémoire jusqu’à leur révocation ou au redémarrage du serveur.

| Méthode et chemin sous `/api/v1/devices/{name}` | Accès et effet |
|---|---|
| `POST /control/token` | Session navigateur locale. Renvoie le jeton une fois. |
| `GET /control/connect` (WebSocket) | Le jeton de pilotage est envoyé en Bearer. Renvoie un identifiant secret de session et la génération. La connexion ouverte réserve la carte. |
| `POST /control/stop` | Session navigateur locale. Arrête le pilotage externe ou demande l’arrêt de l’opération locale en cours sur la carte. Le jeton peut resservir. |
| `POST /control/revoke` | Session navigateur locale. Supprime le jeton et arrête le pilotage externe. |

Pendant le pilotage externe, la lecture flash exige l’identifiant secret
de la session en Bearer. Le jeton général `IDLAB_TOKEN` permet de consulter
l’état de la carte et de piloter les campagnes. Une deuxième session de
pilotage est refusée avec `409`. Une lecture interrompue par le web renvoie
`403 control_stopped` ou `403 control_revoked`. Si l’arrêt coupe un
transfert série, reconnecter la carte pour reprendre les commandes.
Dans le navigateur, clique sur **Opération en cours** pour demander
l’arrêt. Une opération locale annulée renvoie `409 operation_cancelled`.
L’arrêt coopératif attend que le connecteur termine le traitement en cours.

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
La commande `identify`, utilisée à la connexion par l’interface web,
peut renvoyer le même champ `detail` en cas d’échec.
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
Les opérations, la progression et les messages associés contiennent `source`
(`web`, `python` ou `api`) et `session_id`. L’identifiant sert à corréler les
opérations d’une session et ne donne aucun accès. Le SDK déclare `python` via
`X-IDLab-Client: python`. Cet en-tête sert à l’affichage et ne donne aucun droit.

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

L’historique conserve le dernier nombre d’octets communiqué par l’agent
(`bytesReceived`), l’offset absolu de fin exclue (`lastOffset`) et le nombre
d’octets binaires acceptés par le serveur (`bytesTransferred`). En l’absence
d’un événement de progression, `bytesReceived` et `lastOffset` valent `null`.
Le débit UART du chargeur est indiqué par `baudrate` lorsqu’il est connu.
Une lecture échouée conserve son `error` d’origine dans l’historique, ainsi
que `consoleRestored` et, si disponible, `consoleRecoveryError`. Un résultat
de récupération inconnu vaut `null`. Le code de la réponse HTTP reste le
même. Les échecs récents sont récupérables après une reconnexion du même
connecteur dans la session Web en cours, dans la limite de l’historique. Les
lectures associées à une campagne conservent leur diagnostic dans la campagne.

## Programmation flash

La programmation exige un stub actif, une capacité connue et la capacité
`flash.program`. La préparation du plan peut ouvrir ce stub depuis une console
compatible, sous réservation exclusive par le serveur. Le Web et une session Python déléguée utilisent
les mêmes routes sous `/api/v1/devices/{name}/flash`.

| Méthode et chemin | Corps JSON | Résultat |
|---|---|---|
| `POST /plan` | `generation` et `images` avec `address`, `size`, `sha256` pour chaque image | `201` avec `plan_id` et les images validées |
| `POST /program` | `generation`, `plan_id`, `binaries` en base64 dans l’ordre du plan et `campaign_id` facultatif | `200` avec le résultat d’écriture et `verification` par image |

Un plan comprend de 1 à 16 images pour un total de 64 Mio maximum, dans la
limite de la capacité mesurée. Chaque adresse de départ est alignée sur 4 Kio.
Les secteurs occupés sont arrondis au secteur supérieur et ne peuvent pas se
chevaucher. La validation des descripteurs ne modifie pas la flash ; depuis la console,
la préparation peut toutefois provoquer une transition matérielle. Le plan est valable dix
minutes dans la même génération et le même contexte de pilotage. Un nouveau
plan remplace le précédent. Un plan consommé doit être validé à nouveau.

Le serveur contrôle la taille et le SHA-256 de chaque binaire avant l’écriture.
Pendant l’opération, le connecteur série récupère les binaires avec le cookie
de la session Web propriétaire de la carte. Le chargeur préserve les paramètres
flash présents dans les images. L’écriture cible les secteurs du plan.

La vérification relit les octets des images sur la même session chargeur.
Chaque résultat contient `address`, `size`, `sha256`, `readback_sha256` et
`matches`. Le connecteur transmet aussi `readback_preview`, les 256 premiers
octets relus au format hexadécimal, ou tous les octets si l’image est plus courte.
Un écart retourne `502 flash_verification_failed` et apparaît dans
l’historique comme un échec. L’arrêt peut laisser la flash partiellement
programmée. Après vérification, la carte reste dans le chargeur.

En Python, préparer le plan et examiner ses adresses, tailles et empreintes
avant de confirmer par un appel distinct à `program_flash`.

```python
from pathlib import Path

firmware = Path(firmware_path).read_bytes()
with lab.control(board_name, board_token) as board:
    plan = board.prepare_flash([(firmware_address, firmware)])
    print(plan["images"])
    if input("Confirmer la programmation [oui/non] ? ") == "oui":
        operation = board.program_flash(plan["plan_id"], [firmware])
        print(operation["verification"])
```

Le Web et le SDK acceptent un manifeste ESP Web Tools avec `builds` et
`chipFamily`, ou un plan simple avec `parts`. Chaque élément de `parts`
contient `path` (fichier local relatif au manifeste) et `offset` (entier en
octets). Pour le SDK, `plan, binaries = board.prepare_flash_manifest(path)`
prépare les mêmes données que l’ajout manuel. `board.program_flash(plan["plan_id"], binaries)`
confirme ensuite l’écriture. IDLab ouvre le chargeur depuis une console compatible pendant la préparation
ou l’effacement. La programmation exige toujours un plan valide et un stub actif.
Pour sélectionner un manifeste par famille lorsque le MCU est inconnu, le SDK
utilise `flash.prepare` (commande sans écriture), qui ouvre un stub persistant
si nécessaire et renvoie son identité. La préparation du plan réutilise cette
session ; aucun retour intermédiaire en console. Si le manifeste est invalide,
le stub reste ouvert. `identify_live()` conserve son contrat de retour au mode initial.

### Effacement intégral

`POST /api/v1/devices/{name}/command` accepte `command: "flash.erase"`, la
`generation` actuelle et `confirmation` égale au nom exact de la carte.
Le navigateur propriétaire ou le client Python délégué détient le contrôle
exclusif pendant l’effacement et la vérification. La capacité `flash.erase`
est annoncée quand le stub est actif, la taille est connue et la ROM a confirmé
que le démarrage sécurisé et le téléchargement sécurisé sont désactivés et que
le compteur de chiffrement flash est nul. Si l’état est inconnu, la commande
est indisponible.

Le connecteur utilise la commande matérielle d’effacement et relit toute la
capacité par blocs. Le champ `result` contient `address: 0`, `size` et
`first_non_ff`. Un résultat réussi a `first_non_ff: null`. Une différence
renvoie `502 flash_erase_verification_failed` et l’historique indique la première
adresse différente. L’arrêt ne restaure aucune donnée déjà effacée. La carte
reste en mode chargeur. En Python, appeler `board.erase_flash(confirmation=nom_saisi)`
après avoir fait confirmer le nom de la carte à l’opérateur.

`flash.erase.region` accepte le même corps avec deux champs entiers
supplémentaires, `address` et `size`, et exige la capacité `flash.erase.region`.
Le début et la taille doivent être alignés sur 4 Kio, et la plage doit tenir en
flash. Les secteurs demandés et eux seuls sont effacés et relus. Le résultat
utilise la même structure, avec l’adresse absolue de la première différence s’il
y en a une. Depuis Python, appeler
`board.erase_flash_region(address, size, confirmation=nom_saisi)`.

## Campagnes

Une campagne regroupe les opérations d’un essai et son verdict. Le web
et les scripts associent une opération en envoyant `campaign_id` dans
le corps de `/command`, `/flash/read` ou `/flash/program`. Ce champ est facultatif et
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

Lorsqu'une opération matérielle rencontre une interruption HTTP incertaine,
le SDK ferme le contrôle délégué et refuse de réutiliser cette session.
Une demande d'annulation ne constitue pas une confirmation de terminaison.
Les enregistrements d'opération peuvent inclure `cancelRequestedAt`,
`termination` (`completed`, `cancelled` ou `unknown`) et
`recoveryRequired`. Une terminaison inconnue ou un transfert interrompu
nécessite une vérification de la carte avant toute nouvelle opération.
Aucun rejeu automatique n'est effectué.

Le marqueur SQLite est conservé entre générations et redémarrages. Il est rapproché par nom logique, `port_key` ou MAC connue, dans la session propriétaire. Une MAC distincte connue permet de distinguer les cartes sans interrogation supplémentaire. Si les identifiants disponibles ne permettent pas de trancher, la carte est bloquée à l'enregistrement et l'opérateur doit résoudre l'ambiguïté.

`POST /api/v1/devices/{name}/control/recover` est réservé à l'opérateur Web. Corps JSON : `{"generation":"…","confirmation":"nom"}`. Après vérification physique de l'arrêt, il libère les marqueurs correspondants. En cas de `409 recovery_identity_indeterminate`, `candidates` liste les anciens noms possibles. Répéter avec `candidate` égal au nom effectivement récupéré, ou `distinct: true` si la carte est physiquement différente. Cette dernière attestation est limitée à la génération et ne supprime aucun marqueur. Une opération en finalisation refuse la récupération (`409`). Aucun reset automatique.

Les erreurs métier utilisent un objet `{"error":"code"}`. Les erreurs de
routage ou de taille émises par le serveur HTTP peuvent avoir un autre format.
Les refus de négociation WebSocket conservent le statut HTTP et le code métier
dans le corps JSON, également via le manager. Le SDK les expose via
`IDLabHTTPError.status` et `IDLabHTTPError.code`.
Un timeout série (`502 serial_timeout`) est distinct d'un délai serveur
(`504 flash_read_server_timeout`, `device_command_timeout` ou
`idlab_http_timeout`). Les opérations flash ne sont pas rejouées automatiquement. Pour une lecture en cours,
une révocation ou un arrêt explicite prime sur la déconnexion, puis sur
l'annulation locale et l'erreur matérielle. Le diagnostic agent distinct reste
conservé dans `agentError`. La fermeture de récupération ne change pas le code
initial ni son statut HTTP. Seuls les codes agent reconnus sont exposés.
Une lecture incomplète sans diagnostic reconnu utilise le même code
`read_incomplete_reconnect_required` dans la réponse et l'historique.
Une requête en cours lors d'une révocation reçoit `403 control_revoked`.
Après suppression du contrôle, son ancien jeton de session n'est plus reconnu :
une nouvelle requête reçoit `401 authentication_required`. Aucun historique de
jetons révoqués ni surveillance WebSocket supplémentaire n'est nécessaire.

| HTTP | Codes courants | Action côté script |
|---|---|---|
| `400` | `invalid_json`, `invalid_arguments`, `invalid_flash_range`, `unexpected_arguments`, `invalid_campaign_filters` | Corriger la requête. |
| `401` | `authentication_required` | Utiliser le jeton du bon service. |
| `403` | `local_host_required`, `local_access_required`, `local_script_required`, `origin_mismatch` | Vérifier le point d’entrée et le mode d’accès. |
| `404` | `device_disconnected`, `campaign_not_found` | Vérifier le nom de carte ou l’identifiant de campagne. |
| `409` | `device_busy`, `campaign_busy`, `manager_busy` | Attendre la fin de l’opération en cours. |
| `409` | `device_session_changed`, `operation_unsupported`, `campaign_not_active` | Relire respectivement la session, les capacités ou l’état de la campagne. |
| `502` | `serial_timeout`, `agent_disconnected`, `read_incomplete_reconnect_required`, `http_start_failed` | Reconnecter la carte pour la lecture, ou consulter l’état du service HTTP. |
| `504` | `flash_read_server_timeout`, `device_command_timeout`, `flash_program_timeout`, `idlab_http_timeout` | Examiner le diagnostic et la session avant toute nouvelle opération. |
| `503` | `idlab_http_unavailable`, `browser_bundle_unavailable`, `manager_stopping` | Vérifier la disponibilité du service. |

En cas de perte de la réponse à la création d’une campagne, une nouvelle
requête `POST /api/v1/campaigns` crée un autre identifiant.


### Diagnostics des opérations flash destructives

Les opérations de programmation et d’effacement réutilisent l’historique des
opérations et les enregistrements de campagne existants. Une réponse HTTP
échec après démarrage de l’opération peut contenir un objet `operation` avec
le diagnostic final ; le SDK le rend disponible via `IDLabHTTPError.operation`.
Un refus avant création d’une opération peut ne pas contenir cet objet.

L’état `flashState` distingue `unchanged` (absence de modification par cette
opération établie par un résultat terminal), `indeterminate` (état inconnu),
`unverified` (phase de vérification interrompue), `mismatch` (relecture non
conforme) et `verified` (vérification réussie). Un retour en console ne prouve
pas l’intégrité de la flash. En cas d’état non vérifié, privilégier une
relecture autorisée après la récupération de session requise ; ne pas rejouer
automatiquement une opération destructive.

**Limite de persistance :** les diagnostics terminaux des opérations rattachées
à une campagne sont persistés dans SQLite. La progression intermédiaire est
conservée en mémoire du serveur et n’est pas écrite périodiquement en base.
Après un redémarrage brutal avec une opération inachevée, son enregistrement de
campagne est marqué en échec (`server_restarted`), avec état `indeterminate`,
terminaison inconnue, récupération requise et progression/offset inconnus
(`null`). La dernière progression observée avant le redémarrage peut donc être
perdue. Cette limitation est volontaire ; aucune progression n’est reconstruite
par estimation et aucune écriture SQLite supplémentaire n’est introduite.


### Contrats de mode et de génération (IDL-05)

| Opération Python | Précondition / transition | Mode final nominal |
|---|---|---|
| `lab.identify(name)` | Observation passive | Inchangé |
| `board.refresh()` | Observation de la même génération | Inchangé |
| `board.identify_live()` | Identification matérielle, stub temporaire si nécessaire et compatible | Initial |
| `board.read_flash()` | Stub actif ou ouverture temporaire compatible | Initial |
| `board.prepare_flash()` | Validation puis ouverture persistante si nécessaire | Stub |
| `board.program_flash()` | Plan valide, stub actif, contrôle exclusif | Stub |
| `board.erase_flash()` / `erase_flash_region()` | Confirmation, ouverture persistante si nécessaire, capacités réelles et sécurité vérifiées | Stub |
| `board.reset()` | Console compatible uniquement | Console |
| `board.read_uart()` | Consultation du tampon de la génération | Inchangé |

Un objet Board est un instantané immuable, lié à une génération et non au mode
courant. Les transitions internes préservent la génération. Utiliser refresh()
pour actualiser le mode et les capacités sans accès matériel. identify_live()
retourne les mesures matérielles et le mode final de la session, pas le mode
transitoire de mesure. Une génération absente ou remplacée est refusée avec
409 device_session_changed pour les requêtes liées à cette génération ; une
recherche passive sans génération peut retourner 404 device_disconnected.
Une perte d'autorisation peut être refusée avant le contrôle de génération.
Aucune reconnexion implicite, aucun rejeu destructif. Les commandes explicites
mode.loader, mode.console et mode.rom restent disponibles pour les usages avancés.
Un échec de transition suit les règles de récupération existantes ; ne pas
interpréter un retour console comme une preuve d'intégrité de la flash.


### Version installée et ergonomie du SDK (IDL-06)

`idlab --version` et `idlab_client.__version__` exposent la version des
métadonnées de la distribution installée `idlab-client`, sans connexion au
serveur. Installer le wheel avant utilisation. La version seule ne prouve pas
la provenance exacte d'un wheel de qualification non publié.

```python
from idlab_client import IDLabClient, IDLabError, IDLabHTTPError, __version__

print(__version__)
lab = IDLabClient()
with lab.control(board_name, board_token) as board:
    current = board.refresh()
    data, cursor, dropped = current.read_uart()
```

Les instantanés ne se mettent pas à jour automatiquement. `refresh()` conserve
la génération et ne commande pas le matériel. Tous les instantanés délégués
expirent à la sortie du contexte, même en cas d'exception ; une requête via
ces objets est alors refusée localement avec `403 control_stopped`. Le client
parent reste utilisable selon ses propres autorisations.

Intercepter `IDLabHTTPError` avant `IDLabError` (sa classe de base). Le premier
expose `status`, `code`, `operation` et `detail` ; les deux derniers peuvent
être absents (`None`). Le code local `control_stopped` signale également un
contrôle invalidé. Les autres `IDLabError` signalent notamment une erreur de
transport ou de réponse. `ValueError` peut signaler un argument local invalide.
Une erreur de transport ou une interruption ne prouve pas l'absence d'effet
matériel : consulter le diagnostic et appliquer la procédure de récupération,
sans rejeu automatique. `idlab init` génère uniquement une recette pytest,
sans écraser les fichiers existants ni implémenter de moteur métier.
