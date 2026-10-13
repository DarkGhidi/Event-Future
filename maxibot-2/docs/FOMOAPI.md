# Connecter FOMOAPI dans Maxibot 2.0 — version 2.1.2

1. Installer la nouvelle version Windows et ouvrir Connexions.
2. Ouvrir « Créer ma clé gratuite », s’identifier par email dans le dashboard
   officiel https://fomoapi.io/dashboard, puis copier sa propre clé.
3. Coller la clé uniquement dans le champ FOMOAPI de Maxibot. Cliquer
   « Tester et connecter ». Le champ est vidé après l’opération ; le secret
   est conservé chiffré dans le coffre Windows. Chaque utilisateur a sa clé.
4. Vérifier la clé Spot MEXC : lecture compte/ordres et trading pour le
   moteur, ainsi que SPOT_WITHDRAW_READ pour lire les informations de monnaies.
   Ce droit READ ne permet pas d’envoyer un retrait. Ne pas activer
   SPOT_WITHDRAW_WRITE ou SPOT_TRANSFER_WRITE : le bot les refuse.
   Après avoir changé les permissions, tester et enregistrer MEXC à nouveau.
5. Vérifier le statut FOMOAPI et son délai, puis revenir au tableau de bord,
   saisir le montant alloué et cliquer ON. Aucun choix de trader à faire.

## Ce que reçoit GPT

Les nouveaux achats et les classements 24h/7j/30j lorsqu’ils sont disponibles,
avec identifiant stable du trader, taille observée, réseau, contrat et heure.
Les données externes sont traitées comme des faits non fiables en tant
qu’instructions. GPT peut choisir WAIT ou LONG sur les occasions identifiées.
Une vente d’un token clôture la position copiée correspondante, sans créer
un SHORT. Les positions des autres leaders sont indépendantes.

## Budget et qualité du flux

Le budget partagé couvre toutes les sources, avec les mêmes réservations,
réconciliations, stops et limitations MEXC. Aucune clé privée blockchain,
aucun dépôt chez FOMOAPI et aucun transfert de fonds ne sont nécessaires.
Le bot n’exécute rien à partir des achats rejoués à l’ouverture du flux,
des transferts ou d’un ticker seul. Il écarte les tokens sans correspondance
exacte réseau + contrat dans le catalogue MEXC.

Les classements sont lus toutes les 6h (3 appels à chaque actualisation).
Le WebSocket évite de sonder les trades en boucle. Les quotas et prix sont
ceux du compte FOMOAPI : Maxibot n’achète aucun forfait automatiquement.
Le forfait gratuit annonce 7 jours en temps réel, puis 15 secondes de retard ;
le délai annoncé effectivement par le serveur s’affiche dans l’application.
Le flux de l’application FOMO peut omettre des transactions. Il ne garantit
pas de copier chaque achat ou de reproduire la performance du leader.

OFF empêche les nouvelles entrées, tout en suivant les sorties existantes.
La déconnexion FOMOAPI est bloquée pendant ses positions ou ordres actifs,
car elle supprimerait leur suivi des ventes de leaders. On peut remplacer
une clé expirée en mode OFF lorsque le cycle est terminé. Fermer le programme
arrête le suivi local ; les protections Futures confirmées restent chez MEXC.

## Vérifications de cette version

Tests automatiques sur messages, délais, clés rejetées, quotas, doublons,
contrats et réseaux, budget commun, circuits MEXC sur fixtures, OFF et reprise.
Compilation Windows et test de démarrage de l’application empaquetée.
Le flux public de démonstration peut être vérifié sans clé ni ordre.
Aucun test n’est réalisé avec le capital réel d’un utilisateur.

Références : https://fomoapi.io/docs et
https://www.mexc.com/api-docs/spot-v3/wallet-endpoints/query-the-currency-information
