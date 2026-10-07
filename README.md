# Event Futures — Analyse locale BTC/ETH et Futures

**Choisissez BTC ou ETH sur l’index MEXC Event Futures, consignez vos positions, ou passez au bot MEXC Futures BTC/RIVER.** Chaque marché Event Futures garde ses propres prix, chandelles et indicateurs. Les ordres Event Futures restent manuels; le bot perpétuels peut passer de vrais ordres après configuration locale et confirmation explicite.

[Télécharger les installateurs Windows et macOS](https://github.com/DarkGhidi/Event-Future/releases/latest)

### En bref

- Graphique, prix et indicateurs fondés sur l’index MEXC; les chandelles du marché au comptant Binance servent seulement de confirmation facultative.
- Marchés crypto BTC/USDT et ETH/USDT vérifiés depuis le sélecteur Event Futures officiel le 7 octobre 2026. Les autres marchés visibles à cette date sont des actions. La configuration se trouve dans `event-markets.json`; en l’absence d’API catalogue documentée, vérifiez le sélecteur MEXC avant de modifier cette liste.
- Pré-alerte puis GO confirmé, avec une courte fenêtre d’action réglable; les positions Event Futures restent manuelles.
- Journal local des positions et consultation facultative du solde MEXC en lecture seule.
- Les clés API restent sur votre appareil et ne sont jamais incluses dans le code ou les installateurs.

Application en français, disponible en PWA et en application de bureau Windows/macOS. Consultez les instructions et les limites ci-dessous avant de la connecter à votre compte.

## Lancer sur Windows

1. Installer Node.js si `node` n’est pas reconnu.
2. Ouvrir `start-windows.bat`.
3. Consulter `http://localhost:4173`. Garder le serveur ouvert pendant l’usage.

Le téléphone peut afficher l’application via l’adresse Wi‑Fi indiquée par le lanceur. La connexion portefeuille est réservée à `localhost` sur l’ordinateur. Une page ouverte via l’adresse Wi‑Fi ne peut pas envoyer de clé API au serveur.

## Installateurs Windows et macOS

L’application web progressive (PWA) reste disponible sur `http://localhost:4173`. L’application de bureau utilise la même interface et le même serveur local, sur `127.0.0.1:4174`; les deux peuvent coexister. Chaque ordinateur configure ses propres clés MEXC dans l’application. Les installateurs ne contiennent aucune clé API.

Depuis Windows, installer les dépendances avec `pnpm install`, puis créer l’installateur français avec `pnpm run dist:win`. Le fichier `.exe` apparaît dans `release/`. Sur macOS, `pnpm run dist:mac:arm64` crée l’image `.dmg` Apple Silicon et `pnpm run dist:mac:x64` celle des Mac Intel.

GitHub Releases sert de page de téléchargement. Le flux GitHub Actions défini dans `.github/workflows/desktop-packages.yml` construit l’installateur Windows et les images macOS arm64 et Intel, puis teste l’application empaquetée sur chaque système. Le lancement manuel conserve les fichiers comme artefacts; une étiquette de version publie la release uniquement après réussite des trois builds, des tests de démarrage et de la vérification des trois installateurs. La version courante 2.0.2 cible le dépôt public [DarkGhidi/Event-Future](https://github.com/DarkGhidi/Event-Future). Les images macOS sont compilées et testées sur des machines macOS; cet environnement Windows ne peut pas produire le `.dmg` localement.

Au lancement, l’application de bureau vérifie la dernière version publiée et affiche « Mise à jour disponible — Télécharger la mise à jour » si une version plus récente existe. Après confirmation, elle télécharge l’installateur correspondant, vérifie sa taille et son empreinte SHA-256 publiée par GitHub, puis l’ouvre. Windows lance l’installateur; sur macOS, ouvrez l’image disque et glissez la nouvelle application dans Applications. La vérification consulte uniquement les versions publiques GitHub et n’envoie aucune clé MEXC.

La V2.0.2 corrige le téléchargement des mises à jour, dont la progression interrompait le processus principal. La V2.0.1 ajoute un aperçu graphique Binance explicitement étiqueté lorsque les chandelles d’index MEXC échouent, tandis que les décisions restent bloquées sans index MEXC frais. L’horloge utilise désormais le point de synchronisation MEXC et retente plus souvent en cas d’échec. Le bot Futures présente également un journal local de recherche, d’entrées, de protections et d’ajustements SL/TP confirmés.

La vérification est configurée pour le dépôt public [DarkGhidi/Event-Future](https://github.com/DarkGhidi/Event-Future). Vos amis peuvent aussi consulter sa page **Releases** et télécharger l’installateur correspondant à leur ordinateur. Ce dépôt étant public, son code source est visible à tous.

L’installation après confirmation est manuelle sur macOS : les mises à jour silencieuses intégrées exigent une application signée. La distribution actuelle du flux est non signée; une signature et une notarisation Apple restent nécessaires pour une ouverture directe sans avertissement Gatekeeper. L’installateur Windows non signé peut également déclencher SmartScreen.

Les compilations macOS de ce flux sont non signées. La signature et la notarisation pour une distribution sans avertissement Gatekeeper nécessitent un compte Apple Developer, un certificat Developer ID et des identifiants de notarisation conservés dans les secrets CI. L’installateur Windows n’est pas signé dans cette configuration et peut afficher l’avertissement SmartScreen.

## Prix et signaux

- Le prix affiché et les niveaux de référence viennent du flux public WebSocket d’index MEXC Futures du marché sélectionné (`BTC_USDT` ou `ETH_USDT`, canal `sub.index.price`). Les chandelles d’index MEXC alimentent le graphique, les EMA, MACD, bandes de Bollinger, Fibonacci, structure et la projection à 10 minutes. Le scanner surveille le marché sélectionné; changer de marché arrête le scanner pour éviter de reporter un signal d’un actif à l’autre.
- Binance au comptant apporte une comparaison facultative et des repères de volume lorsque son flux est disponible. L’absence de Binance n’empêche pas le suivi de l’index MEXC; un écart supérieur au seuil configuré bloque le signal.
- Le flux d’index MEXC doit rester frais (15 s maximum) et toutes les séries de chandelles MEXC utilisées doivent avoir été actualisées dans les 90 s. Si une série manque ou est périmée, l’app suspend les signaux. Les chandelles d’index ne fournissent pas de volume exploitable dans cette intégration.
- Les zones de support/résistance sont des estimations issues de pivots sur chandelles clôturées, confirmés par deux chandelles de chaque côté; leur proximité multi-horizons est indicative et ne garantit pas un niveau de réaction.
- L’indication d’achat ou de vente est une estimation directionnelle incertaine fondée sur des signaux techniques et une projection de pente récente sur 10 minutes. Le seuil affiché est une zone d’alerte construite depuis la structure récente de l’index. Ce n’est ni un ordre limite ni une garantie. Le prix d’entrée réel est fixé par MEXC au passage de l’ordre.
- La zone d’invalidation demande d’annuler le signal si l’index franchit le repère opposé, si les conditions changent ou si les données périment. Les conditions sont réévaluées en continu.

## Surveillance vocale

Démarrer la surveillance. Quand une configuration approche de sa zone, une pré-alerte invite visuellement à préparer MEXC; la voix reste silencieuse avant le signal confirmé. Après confirmation persistante de 1,5 seconde, la voix dit « Position Long » ou « Position Short », compte de 10 à 1 puis dit « GO ». Les boutons restent désactivés avant GO; le signal reste ensuite valable de 15 à 45 secondes selon le réglage. Un changement bref suspend le compte, tandis qu’une invalidation durable ou des données périmées annulent le signal et font dire « Annulé » trois fois. Aucun ordre n’est passé par l’application.

L’onglet doit rester ouvert. Windows, le navigateur ou le téléphone peuvent suspendre une page en arrière-plan; la parole et les alertes peuvent alors être retardées ou manquer. Ce n’est pas un service d’alerte toujours actif.

## Position réelle et journal

Après avoir exécuté votre ordre manuellement dans MEXC, cliquer sur « Position prise · Achat (position longue) » ou « Position prise · Vente (position courte) » enregistre l’heure et l’index MEXC observé à cet instant comme référence estimée. Ce n’est pas le prix d’entrée vérifié de votre ordre. Pendant les 10 minutes de suivi, aucun nouveau signal n’est affiché. À l’échéance, l’app compare automatiquement le dernier index MEXC à jour avec la référence : une hausse indique un résultat gagnant estimé pour l’achat; une baisse, pour la vente; une égalité est conservée comme égalité estimée. Le résultat est une estimation par index, pas le règlement confirmé par MEXC. Vous pouvez saisir ou corriger le résultat déclaré sur MEXC, y compris une égalité remboursée. Si l’index n’est pas à jour dans les 30 secondes autour de l’échéance, le résultat reste à vérifier plutôt que d’être inventé.

Le journal reste dans le stockage local du navigateur. Il n’enregistre ni mise ni payout. Les résultats saisis par l’utilisateur sont marqués comme déclarés; l’estimation par index reste une mesure distincte, et l’app ne peut pas vérifier le règlement d’un ordre Event Futures. Les snapshots de pré-alertes et de GO conservent les facteurs, scores, prix, sources et âges des données; les GO sans position saisie sont aussi suivis. La revue descriptive compare les conditions associées aux résultats déclarés sans inférer de causalité. Une règle candidate est évaluée en ombre sur les résultats par index les plus récents, à partir d’un seuil fixé avant observation; elle ne remplace jamais automatiquement la règle active. La règle d’ombre ne prouve pas un gain futur, et aucune conclusion n’est retenue sur un petit échantillon. Le curseur Prudence augmente le seuil de sélection; ce n’est pas une probabilité de gain.

## Portefeuille en lecture seule

Le connecteur facultatif demande une API Key et un Secret Key dans le formulaire local. Créer côté MEXC une clé limitée à la seule permission « View Account Details », sans trading ni retrait, et la restreindre à l’IP si possible. Le serveur signe la requête privée MEXC et conserve les deux valeurs uniquement en mémoire. Dans l’app bureau Windows/macOS, la demande de mémorisation utilise le coffre du système (DPAPI sous Windows, Keychain sous macOS); le fichier local ne contient que le texte chiffré. Si le coffre n’est pas disponible, la clé reste limitée à la session. Déconnecter supprime la copie chiffrée. La PWA reste en session seulement. Aucune clé en clair n’est mise dans le stockage du navigateur, le journal, le service worker ou les fichiers du projet. Les routes privées n’acceptent que les requêtes loopback.

MEXC indique que les ordres Event Futures ne sont pas disponibles via API. Le solde wallet ne prouve pas qu’un ordre Event Futures a été pris ni son résultat.

## Onglet Bot perpétuels · aperçu V2

Un onglet distinct affiche un seul contrat MEXC perpétuel USDT à la fois (BTC_USDT ou RIVER_USDT), son graphique 1 minute et, à la demande, MACD et Fibonacci. Les tailles et limites de contrat sont relues sur MEXC; une donnée absente ou périmée bloque l’indication de limite. Les champs budget, part de marge et levier calculent la marge et le notionnel estimés. Avant une entrée, le bot exige un croisement MACD sur chandelle 1 minute clôturée, aligné avec les tendances EMA 5 et 15 minutes; il bloque aussi si l’ATR est hors plage, si le volume 1 minute est inférieur à 65 % de sa moyenne des 20 dernières chandelles, si le marché manque de volume ou de liquidité, si le funding est hors limite, ou si un pivot de support/résistance opposé est trop proche.

La connexion vérifie le compte et les positions en lecture; l’application chiffre la clé séparément avec le coffre du système dans l’application de bureau. Après configuration locale et confirmation explicite, le bot peut envoyer de vrais ordres Futures : croisement MACD 1 min confirmé par la tendance 5 et 15 min, SL initial à 1,5 ATR, TP à 3 ATR et suivi du stop après un mouvement favorable de 1,5 ATR. L’application vérifie la position et les protections conditionnelles côté MEXC, bloque les nouvelles entrées si elles ne sont pas confirmées et tente une clôture vérifiée. L’arrêt normal cesse les nouvelles entrées et laisse les protections confirmées chez MEXC; l’arrêt d’urgence tente une clôture immédiate. Le stop suiveur est recalculé par l’application, qui doit rester connectée pour le déplacer. Il n’y a pas de mode de simulation ni de bac à sable Futures MEXC; ne configurez que des fonds que vous acceptez de risquer.

## Références officielles

- [MEXC Futures WebSocket — canal Index Price](https://mexcdevelop.github.io/apidocs/contract_v1_en/)
- [MEXC Futures API — Index Price](https://www.mexc.io/api-docs/futures/market-endpoints/get-index-price)
- [MEXC Futures API — chandelles d’index](https://www.mexc.fm/api-docs/futures/market-endpoints/get-index-price-candles)
- [MEXC — aide Event Futures](https://www.mexc.com/support/futures-trading/event-futures)
- [MEXC — guide Event Futures](https://www.mexc.com/support/article/how-to-use-event-futures-on-mexc-a-simple-and-accessible-futures-trading-method-395277582692768768)
- [MEXC Futures API — actifs du compte](https://www.mexc.io/api-docs/futures/account-and-trading-endpoints/get-all-account-assets)
- [MEXC Futures API — contrats](https://www.mexc.io/api-docs/futures/market-endpoints/get-contract-information)
- [MEXC Futures API — chandelles de contrat](https://www.mexc.io/api-docs/futures/market-endpoints/get-contract-kline-data)
- [MEXC Futures API — positions ouvertes](https://www.mexc.io/api-docs/futures/account-and-trading-endpoints/get-open-positions)
- [Binance Spot — flux de transactions](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md#trade-streams)

