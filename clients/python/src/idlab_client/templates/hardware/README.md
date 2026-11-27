# Recette matérielle IDLab

Installer le SDK Python IDLab, puis les dépendances de la recette depuis la
racine du projet.

```bash
idlab --version
python -m pip install -r tests/hardware/requirements.txt
```

Connecter la carte dans IDLab et générer son jeton via **Autorisations**.
Configurer l’environnement du terminal qui exécutera pytest.

| Variable | Valeur |
| --- | --- |
| `IDLAB_URL` | Adresse du serveur IDLab joignable depuis ce terminal |
| `IDLAB_BOARD` | Nom de la carte dans IDLab |
| `IDLAB_BOARD_TOKEN` | Jeton de pilotage de cette carte |
| `IDLAB_ALLOW_INSECURE_HTTP` | `true` uniquement pour un accès HTTP distant sur un réseau privé de confiance |

Dans Bash, `read -rsp 'Jeton de carte IDLab : ' IDLAB_BOARD_TOKEN` permet de
saisir le jeton sans l’inscrire dans l’historique. Exécuter ensuite
`export IDLAB_BOARD_TOKEN`. Garder les secrets hors des fichiers du projet.

```bash
pytest tests/hardware/ -v
```

La recette prend le contrôle exclusif, récupère l’état de la carte et lit la
capture UART disponible. Une capture vide est valide. Elle libère le contrôle
en fin de test, y compris si une assertion échoue. Elle fonctionne avec le
seul jeton de carte et n’envoie aucune commande au matériel.

Les objets `Board` sont des instantanés liés à la génération et au contexte de
contrôle. Utiliser `board.refresh()` pour actualiser l'état sans commande
matérielle. Ne pas conserver un objet délégué pour une utilisation après la
sortie de la fixture.


La fixture utilise un timeout SDK de 10 secondes, adapté à cette observation
passive et non à une recette flash longue. `read_uart(cursor=None)` peut
restituer l'historique antérieur encore disponible ; il ne purge pas le tampon.
Pour suivre les pages suivantes, réutiliser le curseur retourné dans la même
génération et examiner `dropped`. La recette accepte une capture vide ou
avec pertes ; elle ne démontre ni le démarrage du firmware ni l'intégrité de
la flash. Ajouter des tests métier et des critères explicites avant de conclure
à une qualification matérielle. Ne pas rejouer automatiquement une opération
interrompue. Révoquer un jeton exposé via **Autorisations** avant d'en créer un
nouveau ; ne jamais le conserver dans les fichiers de recette.
