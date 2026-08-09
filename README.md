# TK Trading — Service WhatsApp (Baileys)

Passerelle WhatsApp de **Guangzhou TK Trading**, branchée sur le **numéro chinois
+86 186 2017 6205**. Le site tk-trading.netlify.app appelle ce service pour
envoyer les notifications de suivi aux clients.

## Démarrage local

```bash
npm install
API_TOKEN="un-token-aleatoire" npm start
```

Au premier lancement, un QR code s'affiche (terminal ou page `/qr`) :

1. Ouvrir **WhatsApp** sur le téléphone du numéro chinois
2. **Paramètres → Appareils connectés → Connecter un appareil**
3. Scanner le code

La session est enregistrée dans `./auth_state/` : le scan n'est nécessaire
qu'une seule fois.

## Points d'entrée

- `GET /health` — public, état de la connexion
- `GET /qr` — public, page de scan du QR code
- `POST /send` — protégé (`Authorization: Bearer <API_TOKEN>`),
  corps `{ "to": "237693780981", "message": "Bonjour…" }`

## Déploiement sur Render

1. Pousser ce dossier sur un dépôt GitHub
2. Sur render.com : **New → Web Service**, connecter le dépôt
3. Build : `npm install` · Start : `npm start`
4. Variables d'environnement :
   - `API_TOKEN` — la même valeur que `BAILEYS_TOKEN` côté Netlify
5. Déployer, puis ouvrir `https://<service>.onrender.com/qr` pour scanner

Côté site (Netlify → Environment variables) :

- `BAILEYS_URL` = `https://<service>.onrender.com`
- `BAILEYS_TOKEN` = la même valeur que `API_TOKEN`

## Précautions

Baileys utilise le protocole non officiel de WhatsApp Web. WhatsApp peut
bloquer un numéro dont l'usage paraît automatisé. Pour limiter le risque :

- Utiliser un numéro dédié à l'entreprise (pas un numéro personnel)
- Les messages sont déjà personnalisés (prénom du client, n° de suivi)
- Rester sous ~200 messages par jour
- Ne pas envoyer en rafale (le service attend 1,5 s entre deux envois)
