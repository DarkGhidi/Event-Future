# Maxibot 2.0 — Windows v2.1.2 bêta 1

Ajoute FOMOAPI au moteur autonome GPT/MEXC. La clé est saisie dans
Connexions, vérifiée et stockée dans le coffre chiffré Windows. Aucun
serveur personnel ou fichier JSONL n’est nécessaire pour cette source.

- Flux WebSocket d’achats/ventes avec statut, délai et reconnexion automatique.
- Classements 24h/7j/30j pour que GPT évalue les traders, sans sélection manuelle.
- Identité du token par réseau + contrat MEXC ; les noms seuls sont insuffisants.
- Achats rejoués, transferts, doublons et tokens non identifiés écartés.
- Budget commun et circuit d’ordres MEXC existant, Spot/Futures accessibles.
- Ventes reçues fermant entièrement la position copiée correspondante, même OFF.
- Guide FOMOAPI intégré ; aucun achat automatique de forfait, aucun dépôt on-chain.

Pour utiliser FOMOAPI, ajouter aussi SPOT_WITHDRAW_READ à la clé Spot MEXC
pour lire les informations de monnaies. Ne pas activer SPOT_WITHDRAW_WRITE
ni les transferts : les droits d’envoi correspondants sont refusés.

Le flux app FOMO ne garantit pas toutes les transactions d’un trader.
FOMOAPI est indépendant de CopyFOMO. La clé gratuite annonce un retard
après 7 jours ; le délai effectif annoncé s’affiche dans l’application.
La période d’observation et le journal existant sont conservés. Les entrées
reprennent uniquement après ON. Les stops Spot nécessitent le PC ouvert.

Validation : 70 tests automatisés, compilation et démarrage empaqueté Windows.
Aucun ordre avec des fonds réels n’a été utilisé pour cette validation.
Installateur et portable x64, non signés ; empreintes dans SHA256SUMS.txt.
