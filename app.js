import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDD-FIJF2L5e7oCzlSIdC2EIt7CMZxV7P0",
  authDomain: "kitacat-sushiclicker.firebaseapp.com",
  projectId: "kitacat-sushiclicker",
  storageBucket: "kitacat-sushiclicker.firebasestorage.app",
  messagingSenderId: "113712170507",
  appId: "1:113712170507:web:d8d2d2ee5ea0fb9deb290e",
  measurementId: "G-EVDN6DJE68"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- Game state ----------
let points = 0;
let autoLevel = 0;
let autoCost = 10;

let currentUser = null;  // set only after the player's data has loaded
let unsaved = false;     // true when there are changes not yet in Firestore

// ---------- Screens ----------
function showScreen(screenId) {
    const screens = document.querySelectorAll('.screen');
    for (const screen of screens) {
        screen.classList.add('hidden');
    }
    document.getElementById(screenId).classList.remove('hidden');
    updateDisplay();
}

function updateDisplay() {
    document.getElementById('score').innerText = points;
    document.getElementById('shop-score').innerText = points;
    document.getElementById('auto-level').innerText = autoLevel;
    document.getElementById('auto-cost').innerText = autoCost;
}

// ---------- Game ----------
function pointsButton() {
    points = points + 1;
    unsaved = true;
    updateDisplay();
}

function buyAutoClicker() {
    if (points < autoCost) {
        return;
    }
    points = points - autoCost;
    autoLevel = autoLevel + 1;
    autoCost = autoCost * 2;
    unsaved = true;
    updateDisplay();
}

setInterval(function () {
    if (autoLevel > 0) {
        points = points + autoLevel;
        unsaved = true;
        updateDisplay();
    }
}, 1000);

// ---------- Saving ----------
async function save() {
    if (!currentUser || !unsaved) {
        return;
    }
    unsaved = false;
    try {
        await setDoc(doc(db, 'users', currentUser.uid), {
            name: currentUser.displayName,
            points: points,
            autoLevel: autoLevel,
            autoCost: autoCost
        });
    } catch (error) {
        unsaved = true; // try again next time
        console.error('Save failed:', error);
    }
}

setInterval(save, 10000);

document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
        save();
    }
});

// ---------- Login ----------
const provider = new GoogleAuthProvider();

document.getElementById('login-btn').addEventListener('click', async function () {
    try {
        await signInWithPopup(auth, provider);
    } catch (error) {
        console.error('Login failed:', error.code);
        document.getElementById('login-error').innerText = 'Login failed: ' + error.code;
    }
});

document.getElementById('logout-btn').addEventListener('click', async function () {
    await save();          // don't lose progress
    await signOut(auth);
});

// Runs at page load and every time someone logs in or out
onAuthStateChanged(auth, async function (user) {
    if (user) {
        try {
            const snapshot = await getDoc(doc(db, 'users', user.uid));
            if (snapshot.exists()) {
                const data = snapshot.data();
                points = data.points || 0;
                autoLevel = data.autoLevel || 0;
                autoCost = data.autoCost || 10;
                unsaved = false;
            } else {
                points = 0;
                autoLevel = 0;
                autoCost = 10;
                unsaved = true; // new player: create their document
            }
            currentUser = user;
            document.getElementById('login-status').innerText = 'Signed in as ' + user.displayName;
            showScreen('menu-screen');
        } catch (error) {
            console.error('Load failed:', error);
            document.getElementById('login-error').innerText = 'Could not load your progress. Check the Firestore rules.';
            showScreen('login-screen');
        }
    } else {
        currentUser = null;
        points = 0;
        autoLevel = 0;
        autoCost = 10;
        unsaved = false;
        showScreen('login-screen');
    }
});

// ---------- Buttons ----------
// Every button with data-goto="..." switches to that screen
for (const button of document.querySelectorAll('[data-goto]')) {
    button.addEventListener('click', function () {
        showScreen(button.dataset.goto);
    });
}

document.getElementById('click-btn').addEventListener('click', pointsButton);
document.getElementById('buy-auto-btn').addEventListener('click', buyAutoClicker);
