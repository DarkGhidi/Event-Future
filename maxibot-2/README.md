# Maxibot 2.0 — Windows, version 2.1.9 bêta

Simulation de trading d'une semaine sur les marchés MEXC en direct. GPT choisit
automatiquement les opportunités, les marchés, la direction, la taille, les
stops, les objectifs et le levier. Les positions et les résultats restent
fictifs : cette version n'envoie aucun ordre réel, y compris après la semaine.

## Installer

Télécharger Maxibot-Setup-2.1.9-x64.exe ou Maxibot-Portable-2.1.9-x64.exe
dans la release maxibot-v2.1.9-beta.1 de DarkGhidi/Event-Future.
Windows x64, dépendances incluses. Binaires non signés ; SHA256 joints.
Les versions 2.0.0 sont des versions antérieures de simulation seulement.

## Connecter, allouer, mettre ON

1. Ouvrir Connexions, puis Continue with ChatGPT. L'identification se fait
   dans le navigateur officiel OpenAI. Un forfait éligible et l'autorisation
   de son usage sont requis. Le modèle GPT disponible est choisi automatiquement.
2. Pour la simulation Spot, créer une clé MEXC dédiée avec lecture du compte
   et lecture des marchés. Aucun droit d'envoi d'ordres n'est requis.
   Coller Access Key et Secret Key dans l'application et tester/enregistrer.
3. Pour lire le compte Futures, ajouter ses permissions de lecture à la clé
   utilisée dans les champs Futures. Aucun droit d'envoi d'ordres n'est requis.
   La clé peut être la même que pour Spot.
   Les deux clés doivent appartenir au même compte ; l'UID est vérifié.
   KYC, restrictions de compte/pays, marchés et permissions restent ceux de MEXC.
4. Indiquer le capital virtuel global en USDT, puis ON. GPT prend des décisions
   à partir des prix, bougies et volumes MEXC en direct ; Maxibot simule les
   entrées et les sorties avec frais estimés. La semaine compte les périodes où
   les données sont disponibles. À 100 %, l'application reste en simulation.
5. OFF arrête les nouvelles décisions ; les positions simulées restent suivies
   par les cotations tant que l'application est ouverte.

Le montant virtuel n'est pas prélevé sur MEXC. Aucun ordre réel, transfert ou
retrait n'est envoyé. N'activez pas les permissions d'écriture sur votre clé.

## Données et plafonds

- Les prix, bougies d'une minute, volumes et données de funding viennent des
  endpoints publics MEXC. Les ordres de la simulation utilisent les cours
  d'achat/vente disponibles ; les frais sont estimés dans le portefeuille fictif.
- Maxibot n'ajoute aucun plafond quotidien d'appels ni de tokens de sortie.
  ChatGPT peut toutefois appliquer ses propres limites de compte ; Maxibot ne
  peut pas les retirer. En cas de limite ChatGPT, le moteur arrête les nouvelles
  décisions et garde le suivi local des positions.
- Les données d'entraînement ne sont pas une promesse de performance future.
- Registre de simulation SQLite local ; les trades simulés et les frais estimés
  sont enregistrés pour examiner les décisions de GPT pendant la semaine.
- Après redémarrage, Maxibot reste OFF ; cliquez ON pour reprendre les décisions.
  Le verrou d'instance empêche deux copies d'utiliser le même journal sur ce PC.

## FOMO et copie

Le scan dynamique utilise les actifs MEXC visibles dans les marchés publics. GPT reçoit
prix, volumes, momentum, spread et données des positions. Les résultats
clôturés et les événements récents lui donnent un retour sur les décisions.
Cela ne réentraîne pas les poids de GPT et ne prouve pas une rentabilité.

Le module de copie peut lire un flux externe JSONL MEXC sélectionné dans
Connexions. Le fichier doit être alimenté par une source extérieure. Chaque
ligne contient id, venue="mexc", market="spot" ou "futures", symbol MEXC,
leader, time (millisecondes), action LONG/SHORT/CLOSE. Un signal ne reste
valide que deux minutes ; les identifiants sont dédupliqués. GPT évalue les
entrées ; les sorties du leader ne touchent que ses propres positions copiées.
Ce module ne vérifie pas l'identité on-chain d'un wallet : la source externe
est responsable de la correspondance d'actif et de l'authenticité des données.

FOMOAPI est intégré à partir de la version 2.1.2. La clé se saisit dans
Connexions et est conservée dans le même coffre chiffré Windows que les clés
MEXC. Elle est vérifiée par une lecture du classement 7 jours avant
l’enregistrement et l’ouverture du WebSocket `wss://api.fomoapi.io/ws/alerts`.
La connexion reprend à l’ouverture de l’application ; les entrées restent OFF
jusqu’au clic ON. Le statut montre la connexion réelle, le délai annoncé,
les signaux reçus, les correspondances MEXC et les erreurs de permission.

GPT évalue les signaux avec les classements 24h/7j/30j, quand disponibles,
actualisés toutes les 6 heures. Aucun trader ne doit être sélectionné par
l’utilisateur. Les achats rejoués à la reconnexion, transferts, messages
sans identité de token vérifiable et événements périmés sont écartés. Les
identifiants consommés sont conservés dans SQLite avant la décision GPT.
Chaque achat copié utilise le capital virtuel global ; aucun ordre ni
financement on-chain n'est envoyé. Les achats sont examinés par lots de
16 événements par cycle ; ce nombre ne limite pas les positions ouvertes.

La clé Spot MEXC doit autoriser `SPOT_WITHDRAW_READ`, permission de lecture
nécessaire pour `/api/v3/capital/config/getall`. Aucun endpoint de retrait ou
transfert n’est appelé et les droits WRITE correspondants sont refusés.
La correspondance exige le réseau ET l’adresse du contrat dans les données
MEXC : le ticker ne suffit jamais. Les actifs non listés, ambigus ou non
négociables par API sont ignorés. Un contrat Futures ne reçoit un candidat
que si son actif de base correspond exactement à la monnaie MEXC identifiée ;
les variantes à multiplicateur non identifiées sont ignorées.

Une vente du leader clôture la position simulée copiée correspondante sur le
même token, même en mode OFF, sans appel GPT ou catalogue de monnaies. Le stop/TP
simulé peut la fermer avant ce signal. Une vente ne crée pas de SHORT. Le flux app
FOMO peut omettre des transactions : ce n’est pas une copie intégrale ou une
vitesse d’exécution garantie. En cas de coupure, les sorties locales restent
suivies ; les nouvelles copies attendent une connexion valide. Une vente
reçue pendant l’analyse invalide le nouvel achat concerné.

FOMOAPI est un fournisseur de données indépendant ; ce connecteur n’est pas
une connexion au compte de trading CopyFOMO. La source FOMOAPI ne change
pas le décideur : GPT reste le seul modèle utilisé. Sans clé FOMOAPI,
l’analyse autonome et le momentum continuent.
Les limites de requêtes et de forfait GPT peuvent suspendre l'analyse des
entrées. Elles ne désactivent pas le suivi des sorties.

## Validation et limites de cette bêta

Tests automatisés avec fixtures d'ordres, signatures, budget, reprises,
permissions et protections, puis test de démarrage empaqueté Windows.
Ces tests ne constituent pas des essais d'exécution avec un compte réel.
L'accès OAuth personnel, les permissions MEXC et les exécutions doivent
être vérifiés sur le PC et le compte de chaque utilisateur.

Connexions chiffrées localement via Windows DPAPI. Les clés MEXC et FOMOAPI ne sont
jamais envoyées à GPT, au tableau de bord, à GitHub ou au créateur.
Le programme n'est pas un produit officiel OpenAI ou MEXC. Déconnecter
ChatGPT supprime ses jetons locaux ; révocation distante non confirmée.

## Développement

    npm ci
    npm run check
    npm test
    npm start
    npm run dist:win

## Documentation

- https://fomoapi.io/docs
- https://fomoapi.io/pricing
- https://www.mexc.com/api-docs/spot-v3/wallet-endpoints/query-the-currency-information

- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- https://www.mexc.com/api-docs/spot-v3/spot-account-trade/new-order
- https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-order
- https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-api-key-info
- https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/place-order
- https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-open-positions
- https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-fee-details
- https://www.mexc.com/api-docs/futures/integration-guide

Licence MIT ; les dépendances conservent leurs licences respectives.
