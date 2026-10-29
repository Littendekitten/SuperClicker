import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

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

console.log(auth, db);

let points = 0;
let autoLevel = 0;
let autoCost = 10;

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

function pointsButton() {
    points = points + 1;
    updateDisplay();
}

function buyAutoClicker() {
    if (points < autoCost) {
        return;
    }
    points = points - autoCost;
    autoLevel = autoLevel + 1;
    autoCost = autoCost * 2;
    updateDisplay();
}

setInterval(function () {
    points = points + autoLevel;
    updateDisplay();
}, 1000);
