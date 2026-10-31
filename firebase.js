// Firebase setup: the project settings, plus the two things the game uses (auth = login, db = Firestore).
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
export const auth = getAuth(app);
export const db = getFirestore(app);
