// ════════════════════════════════════════════════════════
//  FIREBASE INIT — compat SDK (no ES modules needed)
// ════════════════════════════════════════════════════════

// IMPORTANT: Update Firestore rules in Firebase Console:
// match /dashboards/{docId} {
//   allow read, write: if request.auth != null && (
//     (request.auth.token.email != null && docId == request.auth.token.email) ||
//     (request.auth.token.email == null && docId == request.auth.uid)
//   );
// }
// Accounts are keyed by email so Google + Apple logins with the same email share one document.

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCPKwgdPoH0b6_8lKFBFkPZP3pO3IN45VQ",
  authDomain: "wealth-vishalparwani.firebaseapp.com",
  projectId: "wealth-vishalparwani",
  storageBucket: "wealth-vishalparwani.firebasestorage.app",
  messagingSenderId: "900472326085",
  appId: "1:900472326085:web:9610f00561728cc53f6dac"
};

firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore();
db.enablePersistence().catch(e => {
  if (e.code !== 'failed-precondition' && e.code !== 'unimplemented')
    console.warn('Persistence failed:', e);
});

let DASH_KEY = null;
let DASH_REF = null;
let currentUser = null;
let _appStarted = false;

function initAuth() {
  return new Promise(resolve => {
    firebase.auth().onAuthStateChanged(async user => {
      if (user) {
        currentUser = user;
        document.getElementById('login-overlay').style.display = 'none';
        // Use email as canonical key so Google + Apple with same email share one document.
        // Fall back to UID for accounts without an email (e.g. Apple private relay).
        const emailKey = user.email || user.uid;
        DASH_KEY = emailKey;
        DASH_REF = db.collection('dashboards').doc(emailKey);
        // Migration: move data from older UID/UUID keys to the email-based key
        try {
          const emailSnap = await DASH_REF.get();
          if (!emailSnap.exists) {
            // Check for existing data stored under the Firebase UID (pre-email-linking era)
            const uidSnap = await db.collection('dashboards').doc(user.uid).get();
            if (uidSnap.exists) {
              await DASH_REF.set(uidSnap.data());
              setTimeout(() => toast('Your data has been linked to your email account ✓'), 1500);
            } else {
              // Check for legacy UUID-based data (pre-Firebase era)
              const oldKey = localStorage.getItem('wealth_key');
              if (oldKey && oldKey.length > 20) {
                const oldSnap = await db.collection('dashboards').doc(oldKey).get();
                if (oldSnap.exists) {
                  await DASH_REF.set(oldSnap.data());
                  setTimeout(() => toast('Your data has been migrated to your account ✓'), 1500);
                }
              }
            }
          }
        } catch(e) { console.warn('Migration failed', e); }
        localStorage.removeItem('wealth_key');
        if (window.location.hash) history.replaceState(null, '', window.location.pathname);
        if (!_appStarted) {
          _appStarted = true;
          resolve(user);
        } else {
          // Auth state fired again after popup sign-in — run full boot
          if (typeof window._bootPortfolio === 'function') window._bootPortfolio();
        }
      } else {
        currentUser = null;
        document.getElementById('login-overlay').style.display = 'flex';
        if (!_appStarted) {
          _appStarted = true;
          resolve(null);
        }
      }
    });
  });
}

function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  // Use popup — redirect fails in Safari due to ITP blocking cross-site storage
  firebase.auth().signInWithPopup(provider)
    .then(result => {
      // Popup succeeded — onAuthStateChanged will fire and handle the rest
      console.log('Signed in:', result.user.email);
    })
    .catch(e => {
      console.warn('Sign-in failed', e);
      if (e.code === 'auth/popup-blocked') {
        toast('Popup was blocked. Please allow popups for this site and try again.');
      } else if (e.code !== 'auth/popup-closed-by-user') {
        toast('Sign-in failed: ' + e.message);
      }
    });
}

function signInWithApple() {
  const provider = new firebase.auth.OAuthProvider('apple.com');
  provider.addScope('email');
  provider.addScope('name');
  firebase.auth().signInWithPopup(provider)
    .then(result => {
      console.log('Signed in with Apple:', result.user.email);
    })
    .catch(e => {
      console.warn('Apple sign-in failed', e);
      if (e.code === 'auth/popup-blocked') {
        toast('Popup was blocked. Please allow popups for this site and try again.');
      } else if (e.code !== 'auth/popup-closed-by-user') {
        toast('Sign-in failed: ' + e.message);
      }
    });
}

function signOut() {
  firebase.auth().signOut();
}


async function loadAllState() {
  const snap = await DASH_REF.get();
  return snap.exists ? snap.data() : {};
}

const _saveTimers = {};
function saveSection(section, data) {
  clearTimeout(_saveTimers[section]);
  _saveTimers[section] = setTimeout(() => {
    DASH_REF.set({ [section]: data }, { merge: true })
      .catch(e => console.warn('Save failed:', section, e));
  }, 1200);
}

const NAV_KEY = 'mfd_nav';
function getNavCache() {
  try { return JSON.parse(localStorage.getItem(NAV_KEY)) || {}; } catch(e) { return {}; }
}
function saveNavCache(cache) {
  try { localStorage.setItem(NAV_KEY, JSON.stringify(cache)); } catch(e) {}
}
