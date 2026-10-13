# Maxibot 2.0 — Windows, version 2.1.6 bêta

Un montant global en USDT, un bouton ON/OFF. GPT choisit automatiquement
les opportunités, les marchés disponibles, la direction, la taille,
les prix de stop/prise de bénéfices et le levier permis par MEXC.
Plusieurs positions peuvent partager le même budget. Aucun choix de
profil ou de modèle GPT n'est demandé dans le fonctionnement normal.

## Installer

Télécharger Maxibot-Setup-2.1.6-x64.exe ou Maxibot-Portable-2.1.6-x64.exe
dans la release maxibot-v2.1.6-beta.1 de DarkGhidi/Event-Future.
Windows x64, dépendances incluses. Binaires non signés ; SHA256 joints.
Les versions 2.0.0 sont des versions antérieures de simulation seulement.

## Connecter, allouer, mettre ON

1. Ouvrir Connexions, puis Continue with ChatGPT. L'identification se fait
   dans le navigateur officiel OpenAI. Un forfait éligible et l'autorisation
   de son usage sont requis. Le modèle GPT disponible est choisi automatiquement.
2. Dans la gestion API MEXC, créer une clé dédiée avec SPOT_ACCOUNT_READ,
   SPOT_DEAL_READ, SPOT_DEAL_WRITE. Sans retrait ni transfert en écriture.
   Coller Access Key et Secret Key dans l'application et tester/enregistrer.
3. Pour autoriser aussi Futures, ajouter CONTRACT_ACCOUNT_READ,
   CONTRACT_DEAL_READ, CONTRACT_DEAL_WRITE et SPOT_ACCOUNT_READ à la clé
   utilisée dans les champs Futures. La clé peut être la même que pour Spot.
   Les deux clés doivent appartenir au même compte ; l'UID est vérifié.
   KYC, restrictions de compte/pays, marchés et permissions restent ceux de MEXC.
4. Indiquer le montant GLOBAL alloué en USDT, puis ON. Le programme observe
   pendant sept jours de couverture puis passe automatiquement au réel si
   ON reste actif et si les permissions et les soldes disponibles le permettent.
   La progression est affichée. Les périodes sans données ne comptent pas.
   Les gains fictifs ne sont jamais ajoutés au capital réel.
5. OFF interdit de nouvelles entrées. Les positions existantes continuent
   d'être suivies et leurs sorties peuvent être exécutées. Fermer l'application
   est différent d'OFF : le suivi local s'arrête.

Un montant alloué n'est pas un transfert ni un coffre séparé sur MEXC.
Le logiciel limite ses réservations et demandes d'ordre à son budget ;
utiliser un compte/sous-compte dédié pour isoler ses fonds et éviter
les modifications de positions par d'autres applications. Aucun endpoint
pour transférer ou retirer des fonds n'est inclus.

## Moteur réel

- Endpoints officiels signés : Spot MARKET et Futures MARKET en marge isolée.
- Pas de plafond de levier arbitraire : compte, pays, contrat, paliers de risque,
  volumes et marge de maintenance sont relus et validés. Un levier demandé
  hors limite ou un stop au-delà de la liquidation estimée est refusé.
- Le stop et TP Futures sont joints à l'ordre. Leur présence est vérifiée
  dans le retour officiel et la marge automatique est désactivée. Une protection
  non confirmée provoque OFF et une tentative de clôture de protection.
- Spot : l'API d'envoi documentée n'expose pas de stop natif utilisable ici.
  Les sorties sont locales : PC et application ouverts, Internet et API
  disponibles sont nécessaires. OFF conserve ce suivi ; quitter le coupe.
- Registre SQLite unique ; fonds réservés AVANT chaque envoi. Une réponse
  réseau incertaine conserve la réserve et est recherchée par identifiant.
  Aucun renvoi automatique d'un ordre dont le résultat n'est pas connu.
- Quantités réellement exécutées, frais et réductions partielles sont suivis.
  Le résultat final Futures attend l'historique confirmé de la position.
  Les frais Spot dans une troisième devise sont valorisés au cours observé,
  ce qui constitue une estimation ; les montants de commission restent distincts.
- Une intervention externe ou un solde incompatible suspend les entrées.
- Au redémarrage les entrées restent OFF ; les positions/ordres conservés sont
  réconciliés et leurs sorties suivies. Mettre ON est nécessaire pour reprendre
  de nouvelles entrées. Ne pas utiliser plusieurs copies sur différents PC
  pour le même compte : le verrou d'instance est local au PC.

## FOMO et copie

Le scan dynamique utilise les actifs MEXC négociables via API. GPT reçoit
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
Chaque achat copié utilise le budget global et le circuit habituel MEXC,
sans achat ou financement on-chain. Les achats sont examinés par lots de
16 événements par cycle ; ce nombre ne limite pas les positions ouvertes.

La clé Spot MEXC doit autoriser `SPOT_WITHDRAW_READ`, permission de lecture
nécessaire pour `/api/v3/capital/config/getall`. Aucun endpoint de retrait ou
transfert n’est appelé et les droits WRITE correspondants sont refusés.
La correspondance exige le réseau ET l’adresse du contrat dans les données
MEXC : le ticker ne suffit jamais. Les actifs non listés, ambigus ou non
négociables par API sont ignorés. Un contrat Futures ne reçoit un candidat
que si son actif de base correspond exactement à la monnaie MEXC identifiée ;
les variantes à multiplicateur non identifiées sont ignorées.

Une vente du leader ferme entièrement sa propre position copiée sur le même
token, même en mode OFF, sans appel GPT ou catalogue de monnaies. Le stop/TP
peut la fermer avant ce signal. Une vente ne crée pas de SHORT. Le flux app
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
