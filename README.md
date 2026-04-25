# Two Tipps One Cup

Poker-ähnliches Wissensspiel ohne Karten: Spieler geben verdeckte Zahlenantworten ab, setzen Coins, bekommen zwei Tipps und am Ende gewinnt die Antwort, die am nächsten an der Lösung liegt.

## Lokal starten

1. Abhängigkeiten installieren:

```bash
npm install
```

2. `.env.example` als `.env.local` kopieren und die Firebase-Werte eintragen.

3. Entwicklungsserver starten:

```bash
npm run dev
```

## Vercel Environment Variables

Diese Werte in Vercel unter `Settings -> Environment Variables` eintragen:

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MEASUREMENT_ID=...
```

## Firebase

Benötigt werden:

- Authentication: Anonymous aktivieren
- Cloud Firestore: Spark-Tarif reicht für Tests
- Regeln für den Start:

```js
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId}/{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```
