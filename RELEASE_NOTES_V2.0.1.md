## Event Futures 2.0.1

### Correctif macOS et données de marché

- Synchronisation de l’horloge avec le point de contrôle horaire MEXC, conversion des réponses en secondes ou millisecondes et nouvelle tentative rapprochée quand la référence n’est pas disponible.
- Le blocage des décisions reste actif si l’index ou les chandelles MEXC ne sont pas confirmés à jour.
- Le graphique Event Futures affiche les chandelles Binance au comptant en aperçu de secours quand celles de l’index MEXC sont indisponibles; la source est signalée et aucune décision ne s’appuie sur cet aperçu.
- Le cache local est renouvelé afin que le correctif soit chargé au redémarrage.

### Suivi du bot Futures

- Ajout d’un panneau de suivi de recherche : dernière analyse, prix MEXC, croisement MACD en 1 minute et tendances en 5/15 minutes.
- Journal local des phases de recherche, entrées confirmées, protections SL/TP relues sur MEXC, déplacements de stop suiveur et états de clôture ou d’intervention.
- Le journal est conservé sur l’appareil dans le profil utilisateur; il ne contient pas de clé API.

### Distribution

- Builds Windows, macOS Apple Silicon et macOS Intel vérifiés avant publication.
- La mise à jour vérifie les nouvelles versions au démarrage. Sur macOS, le DMG s’ouvre et l’utilisateur doit remplacer l’application dans le dossier Applications; l’installateur macOS n’est pas signé.

