// ════════════════════════════════════════════════════════
//  FIREBASE INIT — compat SDK (no ES modules needed)
// ════════════════════════════════════════════════════════

// IMPORTANT: Set Firestore rules in Firebase Console:
// match /dashboards/{userId} {
//   allow read, write: if request.auth != null && request.auth.uid == userId;
// }

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
        DASH_KEY = user.uid;
        DASH_REF = db.collection('dashboards').doc(user.uid);
        // Migration: if old UUID key exists and UID doc is empty, migrate
        const oldKey = localStorage.getItem('wealth_key');
        if (oldKey && oldKey.length > 20) {
          try {
            const uidSnap = await DASH_REF.get();
            if (!uidSnap.exists) {
              const oldSnap = await db.collection('dashboards').doc(oldKey).get();
              if (oldSnap.exists) {
                await DASH_REF.set(oldSnap.data());
                setTimeout(() => toast('Your data has been migrated to your Google account ✓'), 1500);
              }
            }
          } catch(e) { console.warn('Migration failed', e); }
          localStorage.removeItem('wealth_key');
        }
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
