# Event Futures 3.0.0

## Nouveautés

- Nouvelle identité visuelle plus vive : accents cyan et violet, halo radar, effets de profondeur, animations de données et transitions plus fluides. Les animations respectent le réglage « réduire les animations » du système.
- Le suivi Event Futures peut afficher des notifications de pré-alerte et de GO lorsque les notifications de bureau sont autorisées. L’ordre Event Futures reste manuel.
- Correctif de connexion Mac : les réponses vides ou malformées d’une passerelle MEXC déclenchent une nouvelle tentative via l’autre passerelle, pour l’horloge, l’index et les chandelles.
- L’écran affiche la cause de panne du flux MEXC et propose une reconnexion manuelle; les recommandations restent suspendues tant que les données ne sont pas fraîches.
- Synchronisation de l’horloge MEXC renforcée par plusieurs mesures et sélection de l’échantillon ayant la latence la plus faible.
- Le bot perpétuel vérifie maintenant le spread et la profondeur récente du carnet avant une nouvelle entrée; une donnée absente ou trop ancienne bloque l’entrée.
- Nouvelle jauge de risque par position (0,1 à 1,0 % du budget affecté). La taille est réduite en fonction du stop initial, des frais estimés et du spread; le plafond affiché est une estimation et ne garantit pas la perte maximale.
- L’application de bureau tente de garder l’ordinateur éveillé pendant que le bot tourne. La surveillance s’arrête si l’application est fermée; les protections déjà enregistrées sur MEXC demeurent soumises aux règles et à l’exécution de l’exchange.
- Le journal local continue de suivre les recherches, positions et ajustements TP/SL confirmés.

## Vérifications et limites

- Les paquets Windows, macOS Apple Silicon et macOS Intel sont générés et contrôlés par GitHub Actions avant publication.
- Le robot n’a pas été validé par des ordres réels et aucune rentabilité n’est garantie. Aucune clé API réelle n’a été utilisée pendant la construction.
- Sur Mac non signé, l’installation et le remplacement de l’application restent manuels; une mise à jour macOS sans interaction nécessite une application signée et une configuration de mise à jour correspondante.
