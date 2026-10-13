# Maxibot 2.0 — version 2.1.1 bêta 1

Moteur d'ordres réels MEXC Spot/Futures intégré. Une allocation globale et
ON/OFF remplacent le choix de modèle GPT, de marché et de profil.

- Sept jours de couverture sans ordre réel, puis réel automatique si ON,
  permissions vérifiées et fonds disponibles. Capital réel initial, sans
  transfert des gains fictifs. Reprise avec nouvelles entrées OFF.
- Budget partagé, réserves persistées avant envoi et recherche des ordres
  dont le résultat est inconnu, sans les renvoyer automatiquement.
- MEXC officiel signé, paliers de risque, limites du compte et marge isolée.
  Aucun plafond de levier arbitraire. Stops/TP Futures joints et vérifiés.
- Scan dynamique, momentum et retour de l'historique vers GPT.
- Copie via flux externe JSONL MEXC ; aucune connexion directe CopyFOMO.
- Stops Spot locaux : PC et application doivent rester ouverts.

Bêta non signée. Les tests utilisent des fixtures et le lancement Windows ;
aucun compte personnel ni ordre financé n'a été utilisé pour ces tests.
Voir le guide intégré et README pour les permissions, étapes et limites.
