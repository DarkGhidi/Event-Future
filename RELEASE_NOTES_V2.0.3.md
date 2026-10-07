## Event Futures 2.0.3

- Ajoute un secours par requête à l’index MEXC quand le flux WebSocket ne transmet plus de prix. La recommandation reste bloquée si le prix reçu de MEXC est lui-même périmé.
- Remplace le compte à rebours trompeur vers la prochaine bougie par l’état réel de l’analyse et de l’actualisation des chandelles.
- Corrige la lecture publique des limites de contrat Futures via l’endpoint documenté MEXC, et rend cohérente la vérification du champ d’autorisation API.
- Conserve la correction du plantage pendant le téléchargement des mises à jour introduite en 2.0.2.

Les contrats restent protégés par les contrôles de marge, de taille, de levier, d’autorisation MEXC et de fraîcheur. Si MEXC ne confirme pas une limite ou l’autorisation API, le démarrage reste bloqué.

Installateurs Windows et macOS (Apple Silicon et Intel) générés et vérifiés dans GitHub Actions. Les images macOS ne sont pas signées et peuvent demander une autorisation manuelle au premier lancement.
