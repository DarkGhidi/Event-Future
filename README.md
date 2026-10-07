# Event Futures — Assistant local BTC/USDT

**Suivez l’index BTC/USDT, recevez des alertes vocales en français et consignez vos positions MEXC Event Futures.** L’application observe les marchés et vous aide à décider; vous passez chaque ordre vous-même.

[Télécharger les installateurs Windows et macOS](https://github.com/DarkGhidi/Event-Future/releases/latest)

### En bref

- Graphique et indicateurs fondés sur l’index MEXC, avec confirmation du marché au comptant Binance.
- Pré-alerte puis GO confirmé, avec une courte fenêtre d’action réglable; aucun ordre n’est exécuté par l’application.
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

GitHub Releases peut servir de page unique de téléchargement pour vos amis. Le flux GitHub Actions défini dans `.github/workflows/desktop-packages.yml` construit l’installateur Windows et les deux images macOS. Un lancement manuel conserve les fichiers comme artefacts de compilation; une étiquette de version telle que `v1.0.1` publie aussi une page de version avec les fichiers joints. Pour préparer une version, mettre à jour la version dans `package.json`, créer l’étiquette Git correspondante et la pousser. Pour l’utiliser, placer ce dossier à la racine d’un dépôt GitHub. Les images macOS sont compilées sur des machines macOS; cet environnement Windows ne peut pas produire le `.dmg` localement.

Au lancement, l’application de bureau vérifie la dernière version publiée et affiche « Mise à jour disponible — Télécharger la mise à jour » si une version plus récente existe. Après confirmation, elle télécharge l’installateur correspondant, vérifie sa taille et son empreinte SHA-256 publiée par GitHub, puis l’ouvre. Windows lance l’installateur; sur macOS, ouvrez l’image disque et glissez la nouvelle application dans Applications. La vérification consulte uniquement les versions publiques GitHub et n’envoie aucune clé MEXC.

La vérification est configurée pour le dépôt public [DarkGhidi/Event-Future](https://github.com/DarkGhidi/Event-Future). Vos amis peuvent aussi consulter sa page **Releases** et télécharger l’installateur correspondant à leur ordinateur. Ce dépôt étant public, son code source est visible à tous.

L’installation après confirmation est manuelle sur macOS : les mises à jour silencieuses intégrées exigent une application signée. La distribution actuelle du flux est non signée; une signature et une notarisation Apple restent nécessaires pour une ouverture directe sans avertissement Gatekeeper. L’installateur Windows non signé peut également déclencher SmartScreen.

Les compilations macOS de ce flux sont non signées. La signature et la notarisation pour une distribution sans avertissement Gatekeeper nécessitent un compte Apple Developer, un certificat Developer ID et des identifiants de notarisation conservés dans les secrets CI. L’installateur Windows n’est pas signé dans cette configuration et peut afficher l’avertissement SmartScreen.

## Prix et signaux

- Le prix affiché et les niveaux de référence viennent du flux public WebSocket d’index MEXC Futures BTC_USDT (`wss://contract.mexc.com/edge`, canal `sub.index.price`). Les chandelles d’index MEXC alimentent les EMA, MACD, bandes de Bollinger, Fibonacci, structure et la projection à 10 minutes.
- Binance au comptant fournit les chandelles du graphique et le volume. L’écart entre l’index MEXC et le marché au comptant Binance est surveillé; un écart notable bloque le signal.
- Le flux MEXC doit rester frais (15 s maximum), tout comme le flux spot Binance et les chandelles. Si une source est périmée, l’app affiche « Données périmées · Pas d’entrée » et suspend les alertes.
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

## Références officielles

- [MEXC Futures WebSocket — canal Index Price](https://mexcdevelop.github.io/apidocs/contract_v1_en/)
- [MEXC Futures API — Index Price](https://www.mexc.io/api-docs/futures/market-endpoints/get-index-price)
- [MEXC Futures API — chandelles d’index](https://www.mexc.fm/api-docs/futures/market-endpoints/get-index-price-candles)
- [MEXC — aide Event Futures](https://www.mexc.com/support/futures-trading/event-futures)
- [MEXC — guide Event Futures](https://www.mexc.com/support/article/how-to-use-event-futures-on-mexc-a-simple-and-accessible-futures-trading-method-395277582692768768)
- [MEXC Futures API — actifs du compte](https://www.mexc.io/api-docs/futures/account-and-trading-endpoints/get-all-account-assets)
- [Binance Spot — flux de transactions](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md#trade-streams)
