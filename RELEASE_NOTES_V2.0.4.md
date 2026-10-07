## Event Futures 2.0.4

- Correctif de sécurité : restaure la lecture MEXC des limites Futures configurées pour la région de l’utilisateur avant d’autoriser le bot.
- Conserve le secours par requête à l’index MEXC quand le flux WebSocket est interrompu; les signaux restent bloqués si l’horodatage est périmé.
- Garde l’affichage clarifié du rythme des bougies et le correctif du téléchargement de mise à jour de la V2.0.2.

Les limites de levier, tailles, autorisations API et fraîcheur des données continuent à bloquer le démarrage si MEXC ne les confirme pas.

Installateurs Windows et macOS (Apple Silicon et Intel) générés et vérifiés par GitHub Actions. Les images macOS ne sont pas signées.
