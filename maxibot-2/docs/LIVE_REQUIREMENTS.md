# Maxibot 2.0 — exigences du mode réel

Décisions de Max, 13 octobre 2026. Le moteur, le budget partagé et ON/OFF sont implémentés dans le code
de la version 2.1.0 bêta. Les essais ne font pas intervenir de fonds réels.
Le connecteur direct CopyFOMO reste à développer.

## Commande utilisateur : un bot, un montant, ON/OFF

Précision de Max à 08:50 le 13 octobre 2026 : aucun choix de bot,
de profil ou de stratégie à effectuer. Après la connexion initiale des
comptes, les seules commandes opérationnelles sont le montant alloué
au bot et ON/OFF. Les résultats, positions et raisons restent visibles.

Le montant correspond à un budget GLOBAL partagé. Le système ne donne
pas ce montant à chacun des profils, marchés ou sources de signaux.
Le levier et l'exposition notionnelle restent affichés séparément de la
marge réellement mobilisée dans ce budget.

L'orchestrateur GPT décide des actifs, de la source du signal, du marché
accessible, de la direction, de la taille, du levier et des sorties.
Il choisit automatiquement un modèle GPT disponible ; aucune sélection
manuelle du modèle ou d'un bot n'est requise pour le fonctionnement normal.
La disponibilité des sources et les permissions effectives sont vérifiées.
Il peut ne rien ouvrir, lancer plusieurs opérations, renforcer ou réduire
une position. Aucun menu n'oblige à choisir entre copie et momentum.

Plusieurs activités peuvent coexister : observations du marché, suivi de
leaders, recherche de mouvements rapides, positions Spot, positions
Futures, gestion des sorties et suivi des performances. Chaque position
conserve sa provenance pour mesurer les résultats et attribuer les sorties.
Les allocations des différentes activités sont décidées par le bot.

## Budget global et concurrence

- Un registre unique conserve capital alloué, fonds disponibles, réserves
  des ordres en attente, marge/actifs engagés et frais/funding constatés.
- Réserver le budget AVANT l'envoi d'un ordre, dans une transaction atomique.
  Deux stratégies concurrentes ne peuvent pas dépenser la même disponibilité.
- Calculer les réductions, sorties partielles et réserves libérées depuis
  les exécutions confirmées ; une requête envoyée n'est pas un ordre rempli.
- Réconcilier ordres, exécutions et positions avec MEXC au redémarrage et
  après coupure. Réutiliser des identifiants d'ordre idempotents et vérifier
  le résultat d'un envoi incertain avant de le répéter.
- Les anciens portefeuilles comparatifs de simulation ne constituent pas
  des budgets réels indépendants et ne doivent pas être additionnés.
- Ne pas exploiter le solde MEXC hors allocation. Vérifier les effets du
  mode de marge et prévoir l'isolement opérationnel des fonds du bot.
- OFF bloque immédiatement les nouvelles entrées et leur financement.
  Les ordres en cours sont réconciliés ; les protections et la gestion
  des positions existantes continuent. OFF ne vend pas tout au marché.
  L'arrêt complet du programme doit expliquer quelles protections restent
  réellement actives sur l'exchange.
- Une modification du montant ne retire pas instantanément une marge
  engagée : ne jamais afficher comme disponible un capital encore bloqué.

## FOMO : les deux sources

- Copie : suivre achats, renforcements, réductions et sorties de traders ou
  wallets vérifiés. GPT évalue les entrées avec les données de marché.
- Momentum : détecter accélération des prix, volumes inhabituels et
  changements de liquidité ; GPT décide de suivre, attendre ou sortir.
- Les deux sources peuvent fonctionner ensemble, avec déduplication des
  signaux. Chaque position copiée conserve son lien avec son leader.
- Univers MEXC dynamique plutôt que cinq actifs fixes. Vérifier l'identité
  de chaque token et sa correspondance avec une paire négociable : un
  ticker identique ne garantit pas que ce soit le même actif.
- Le connecteur de copie reste à réaliser. La documentation CopyFOMO décrit
  un bot Telegram de copie on-chain ; elle n'établit pas un accès développeur
  utilisable par Maxibot. Ne pas annoncer cette intégration comme disponible.
  Les actifs absents de MEXC ne sont pas exécutables dans le périmètre actuel.

## Leviers

- Aucun plafond arbitraire ajouté par Maxibot et aucun verrou 1x pour le
  futur moteur Futures. GPT propose le levier pour chaque décision.
- Respecter les limites effectives du contrat, de la taille de position,
  du palier de risque et du compte ; les relire avant l'envoi d'ordre.
- Séparer marge engagée, exposition et levier ; calculer correctement frais,
  funding, marge de maintenance et liquidation. Un stop théorique ne
  garantit pas une sortie avant liquidation.
- Garder les validations de solde, quantité, pas d'ordre, état du marché,
  doublons et arrêts : elles sont distinctes du plafond de levier.
- La page MEXC sur les leviers élevés mentionne une exclusion de la France
  pour le service décrit. Vérifier l'accès réel du compte ; ne pas promettre
  300x ou 500x et ne pas contourner une restriction.

## Avant activation réelle

Vérifier marge/liquidation, droits API, exécutions partielles, frais,
réconciliation après reconnexion et protections de sortie de l'exchange.
La version 2.1.0 utilise les endpoints officiels d’envoi d’ordre.
Le contrôle avec les comptes de chaque utilisateur reste nécessaire.

## Sources

- https://www.copyfomo.com/docs
- https://www.mexc.com/api-docs/futures/market-endpoints/get-contract-info
- https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-risk-limits
- https://www.mexc.com/learn/article/mexc-futures-guide-leverage-trading-strategies-risk-management/1
