# Publier Event Futures et récupérer les compilations

## Mettre les fichiers dans GitHub

1. Ouvrez https://github.com/DarkGhidi/Event-Future. Connectez-vous à GitHub.
2. Cliquez sur **Add file** puis **Upload files**.
3. Décompressez `Event-Futures-source-et-workflow.zip` sur votre ordinateur.
4. Dans le dossier décompressé, sélectionnez tous les fichiers et dossiers, y compris `.github`, puis déposez-les dans la page GitHub. Si `.github` est masqué par Windows, activez **Affichage > Afficher > Éléments masqués** dans l’Explorateur.
5. Saisissez un message comme `Publier Event Futures et ses installateurs`, puis cliquez sur **Commit changes** en bas de la page. Gardez la branche proposée `main`.

## Lancer les compilations sans publier de release

1. Sur la page du dépôt, cliquez sur **Actions**.
2. Dans la liste à gauche, choisissez **Construire les installateurs de bureau**.
3. Cliquez sur **Run workflow**, gardez la branche `main`, puis cliquez à nouveau sur le bouton vert **Run workflow**.
4. Attendez que les trois tâches (Windows et les deux macOS) soient terminées en vert. Le premier lancement peut prendre plusieurs minutes.

Cette action manuelle crée des artefacts de compilation; elle ne publie pas de nouvelle page Release.

## Télécharger le DMG macOS

1. Ouvrez l’exécution verte la plus récente dans l’onglet **Actions**.
2. En bas de la page, dans **Artifacts**, cliquez sur `event-futures-macos-arm64` pour les Mac Apple Silicon ou `event-futures-macos-x64` pour les Mac Intel.
3. GitHub télécharge une archive ZIP contenant le fichier `.dmg`. Ouvrez cette archive pour extraire l’image disque.

Pour obtenir aussi l’installateur Windows, téléchargez l’artefact `event-futures-windows`.

Les DMG produits par ce flux ne sont pas signés ni notariés par Apple. macOS peut donc demander une confirmation supplémentaire avant l’ouverture.
