# Maxibot 2.0 — Windows

Application locale open source de **simulation** crypto avec connexion
officielle ChatGPT et lecture MEXC. Chaque personne utilise ses propres
connexions. Le programme ne contient ni clé partagée, ni mot de passe,
ni compte du créateur. Aucun ordre réel n'est implémenté dans cette version.

Les installateurs et la version portable Windows x64 sont publiés dans les
Releases du dépôt DarkGhidi/Event-Future avec le préfixe Maxibot 2.0.
L'application Event Futures existante est un autre programme.

## Installer et connecter

1. Télécharger **Maxibot-Setup-2.0.0-x64.exe**, ou le fichier Portable.
   Node.js et les dépendances sont inclus. Première version non signée ;
   les empreintes SHA256 sont jointes à la release.
2. Ouvrir Maxibot 2.0. Cliquer **Continue with ChatGPT**. L'authentification
   se fait dans le navigateur officiel OpenAI. Choisir son compte et
   autoriser l'utilisation du forfait, si celui-ci est éligible.
3. Choisir un modèle GPT proposé par ce compte. Plus/Pro éligible et
   permission de forfait sont nécessaires. La disponibilité et les limites
   sont celles appliquées par OpenAI ; l'application ne les contourne pas.
4. Facultatif pendant la simulation : créer une clé MEXC dédiée en lecture,
   sans retraits/transferts, puis saisir Access Key et Secret Key dans
   Maxibot 2.0. Cliquer **Tester et enregistrer**. La lecture Futures peut
   être ajoutée séparément. La simulation utilise les prix publics MEXC.
5. Choisir le capital fictif et les marchés, puis démarrer. Garder le PC
   allumé, Internet disponible et Maxibot 2.0 ouvert. Réduire la fenêtre
   laisse le moteur fonctionner ; fermer l'app l'arrête.

Le guide complet est aussi intégré à l'application.

## Fonctionnement

- Spot et Futures classiques, exposition simulée 1× ; pas d'Event Futures.
- GPT seul : requêtes officielles Responses API avec le forfait autorisé,
  JSON validé, refus et réponses incomplètes ignorés.
- Sept jours calendrier : cinq jours d'exploration de trois profils de
  confiance, puis deux jours de validation avec sélection/règles gelées.
  Cette comparaison ne réentraîne pas les poids du modèle GPT.
- Collecte environ une fois par minute, décisions environ toutes les dix
  minutes ; plafonds de 144 appels et 300 000 tokens réservés par jour.
- Frais/slippage hypothétiques, funding, stops, durée de détention, plafonds
  de baisse et de perte. Modélisation fictive, sans garantie de performance.
- Pause des entrées : les sorties fictives et observations continuent.
  Arrêt : le moteur s'arrête. Une pause pendant GPT bloque les nouvelles entrées.
- Au redémarrage, la simulation se reprend explicitement avec son journal.
  Les heures sans PC ne sont pas simulées comme une couverture continue.
- Chaque variante conserve son propre portefeuille. Les chiffres de
  démonstration restent dans l'interface et ne sont jamais importés.
- Aucun passage automatique en réel à la fin de la semaine. La copie de
  traders n'a pas de source connectée dans cette version.

## Données et sécurité

Les journaux SQLite et rapports sont enregistrés dans le dossier utilisateur
de Maxibot 2.0. Un nouvel essai archive le précédent sans le supprimer.
Les connexions sont chiffrées avec Electron safeStorage/Windows DPAPI.
Cela les protège des autres comptes Windows ; un logiciel malveillant
s'exécutant sous le même compte Windows reste hors de cette protection.
Le programme refuse une dégradation du stockage en clair.

Les jetons OpenAI ne passent pas au moteur d'affichage. MEXC reçoit ses
requêtes signées en lecture ; OpenAI reçoit les données de marché et les
candidats de décision, jamais les clés MEXC. Aucune télémétrie ni serveur
du créateur n'est ajouté. GitHub ne reçoit que le code et les binaires.

La déconnexion efface les jetons locaux ; la révocation distante n'est pas
confirmée. L'utilisateur peut retirer l'autorisation dans les réglages
ChatGPT. L'application n'est pas un produit officiel OpenAI ou MEXC.

## Développer et compiler

Node 24+ pour développer, puis :

    npm ci
    npm test
    npm run check
    npm start
    npm run dist:win

La compilation Windows et le contrôle de l'application empaquetée
se font sur un runner Windows GitHub Actions. Le test empaqueté exerce
la fenêtre, le pont IPC, SQLite et DPAPI sans comptes ni requêtes privées.

Les tests avec fixtures ne prouvent pas une connexion OAuth réelle,
les droits d'un compte MEXC, les résultats d'une semaine ou une rentabilité.
Ces vérifications nécessitent chaque compte et un essai sur le PC concerné.

## Sources techniques

- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://www.mexc.com/mexc-api
- https://www.mexc.com/announcements/article/futures-api-access-domain-update-17827791532974
- https://www.electronjs.org/docs/latest/api/safe-storage

Licence MIT. Les dépendances conservent leurs propres licences.
