#!/bin/bash
cat > src/firebase-config.js << EOF
window.FIREBASE_CONFIG = {
  apiKey: "$FIREBASE_API_KEY",
  authDomain: "$FIREBASE_AUTH_DOMAIN",
  projectId: "$FIREBASE_PROJECT_ID",
  storageBucket: "$FIREBASE_PROJECT_ID.appspot.com",
  messagingSenderId: "$FIREBASE_MESSAGING_SENDER_ID",
  appId: "$FIREBASE_APP_ID"
};
EOF