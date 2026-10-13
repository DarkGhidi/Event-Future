# Maxibot 2.0 — Windows v2.1.7 bêta 1

Le code générique `NETWORK_OR_DATA_ERROR` est remplacé par des diagnostics
sûrs qui distinguent un échec réseau ChatGPT, une interruption de flux, une
réponse GPT illisible, un échec réseau MEXC ou des données JSON invalides.
Les messages et données privées des erreurs ne sont jamais exportés.

Le lecteur GPT tolère du texte autour d’un objet JSON valide, puis vérifie
toujours chaque décision. Une erreur ou une décision invalide coupe les
nouvelles entrées; le suivi des positions existantes continue.

Tests ciblés et contrôle syntaxique validés localement. La CI Windows exécute
la suite complète et vérifie la compilation empaquetée.

Installateur et portable x64, non signés ; empreintes dans SHA256SUMS.txt.

---

# Maxibot 2.0 — Windows v2.1.6 bêta 1

Corrige la requête GPT pour utiliser le format documenté de ChatGPT plan :
un message utilisateur dans `input`, sans paramètres de format JSON strict ni
options facultatives non nécessaires. GPT doit renvoyer un objet JSON que
Maxibot valide avant toute décision.

Tout HTTP 400 arrête désormais les entrées, même lorsque le corps contient
un diagnostic de catégorie inconnue. Cela évite les répétitions de requête.

Tests de format de requête, sécurité OFF, FOMOAPI et simulation validés.
Contrôle final Windows et démarrage empaqueté effectués par la CI.

Installateur et portable x64, non signés ; empreintes dans SHA256SUMS.txt.

---

# Maxibot 2.0 — Windows v2.1.5 bêta 1

Corrige le diagnostic GPT HTTP 400 : Maxibot relève désormais les réponses
`detail` en catégories sûres (schéma, capacité, modèle, accès) et inclut
l’identifiant de requête OpenAI. Le texte de réponse brut reste exclu.
L’export JSON indique maintenant la version exacte installée.

Validation locale ciblée du diagnostic et vérification syntaxique réussies.
Aucun ordre réel utilisé pour cette validation.

Installateur et portable x64, non signés ; empreintes dans SHA256SUMS.txt.

---

# Maxibot 2.0 — Windows v2.1.4 bêta 1

Le journal ajoute, après un refus HTTP 400 de GPT, les identifiants sûrs
du code, du type et du champ concernés. Le texte de réponse brut, les clés
et les données du compte ne sont jamais copiés dans le journal. Les entrées
restent automatiquement OFF après ce refus.

72 tests automatisés, compilation et démarrage empaqueté Windows. Aucun
ordre avec des fonds réels n’a été utilisé pour la validation.

Installateur et portable x64, non signés ; empreintes dans SHA256SUMS.txt.

---

# Maxibot 2.0 — Windows v2.1.3 bêta 1

Corrige le traitement des erreurs de requête GPT : les erreurs HTTP 400
sont classées sans exposer le corps de réponse, puis les nouvelles entrées
sont automatiquement mises OFF. Le journal peut désormais distinguer les
problèmes de schéma, de paramètre, de modèle ou de taille de requête.

70+ tests automatisés, compilation et démarrage empaqueté Windows. Aucun
ordre avec des fonds réels n’a été utilisé pour la validation.

Installateur et portable x64, non signés ; empreintes dans SHA256SUMS.txt.

---

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
