## Event Futures 2.0.0

### Nouveautés

- Refonte complète de l’interface en graphite et vert d’eau, avec une hiérarchie plus claire, des vues compactes et des panneaux techniques repliables.
- Ajout des marchés Event Futures BTC/USDT et ETH/USDT, chacun avec son prix, ses chandelles, son analyse et ses alertes sur l’indice MEXC.
- Ajout du contexte support/résistance multi-horizons à partir de pivots confirmés. Les zones restent des estimations; le volume d’indice Event Futures n’est pas fourni par cette intégration.
- Ajout de métriques de contexte des perpétuels lorsqu’elles sont publiées par MEXC : volume et montant 24 h, positions ouvertes, funding et ATR.
- Confirmation de la règle d’entrée du bot perpétuel : croisement MACD en 1 minute confirmé par la tendance en 5 et 15 minutes.

### Fiabilité des données

- Le graphique Event Futures et l’horloge de référence utilisent l’indice MEXC, sans dépendre de Binance.
- Actualisation historique toutes les 30 secondes, ping WebSocket et reconnexion progressive.
- Les signaux restent suspendus si le tick dépasse 15 secondes ou si une série de chandelles dépasse 90 secondes ou manque.
- La liste BTC/ETH est vérifiée manuellement à partir du sélecteur officiel MEXC; elle se met à jour dans `event-markets.json` lorsqu’un marché crypto est ajouté ou retiré.

### À savoir

- Les ordres Event Futures restent manuels; aucun ordre n’est transmis par cette vue.
- Le bot perpétuel peut envoyer de vrais ordres seulement après configuration locale et confirmation explicite. Il conserve les contrôles de contrat, les protections MEXC SL/TP et le mécanisme d’arrêt d’urgence.
- Les installateurs ne contiennent aucune clé. Les builds macOS et Windows sont non signés et peuvent afficher les avertissements Gatekeeper ou SmartScreen.
