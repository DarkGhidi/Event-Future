# Maxibot 2.0 — exigences du mode réel

Décisions de Max, 13 octobre 2026. Fonctions à développer ; elles ne sont
pas actives dans la préversion Windows publiée.

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
La version publiée ne contient aucun endpoint d'envoi d'ordre réel.

## Sources

- https://www.copyfomo.com/docs
- https://www.mexc.com/api-docs/futures/market-endpoints/get-contract-info
- https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-risk-limits
- https://www.mexc.com/learn/article/mexc-futures-guide-leverage-trading-strategies-risk-management/1
