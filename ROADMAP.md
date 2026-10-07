# Feuille de route

## v1.0.2 — Mises à jour sans doublon

- Windows : mettre à jour l’installation existante au même emplacement et dans le même mode (utilisateur ou machine), sans créer une seconde installation. Après téléchargement, fermer proprement l’application, lancer l’installation de mise à jour, attendre sa fin, puis redémarrer l’application.
- macOS : ajouter une mise à jour intégrée qui remplace la copie existante dans Applications, sans demander de glisser manuellement une nouvelle copie depuis un DMG.
- Publier les métadonnées et paquets requis par le mécanisme de mise à jour Electron. Garder les DMG disponibles pour les installations initiales.
- Signer les installateurs Windows; signer et notarier l’application macOS avec une identité Developer ID stable. Les mises à jour macOS doivent conserver la même équipe de signature.
- Nettoyer le programme d’installation téléchargé après confirmation de l’installation. Conserver les données utilisateur et les clés MEXC chiffrées pendant une mise à jour.
- Vérifier la mise à niveau depuis v1.0.1, le cas d’une application déjà ouverte, les erreurs de téléchargement et d’installation, le redémarrage, l’espace disque, et l’absence d’installation en double.

## Comportement de v1.0.1

v1.0.1 télécharge l’installateur choisi dans le dossier Téléchargements puis l’ouvre. Windows passe par l’assistant NSIS; macOS ouvre un DMG à copier manuellement dans Applications. Le programme téléchargé n’est pas supprimé automatiquement.
