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

// ---------- The upgrades ----------
// To add a new upgrade, add one line here. The store, the saving and the
// points-per-second all pick it up automatically.
//   id:         short name used for saving (never change it later!)
//   baseCost:   price of the first one
//   perSecond:  points each one makes every second (optional)
//   perClick:   extra points each one adds to every click (optional)
const ITEMS = [
    { id: 'chopsticks', name: 'Chopsticks',       emoji: '🥢', baseCost: 10,    perClick: 1 },
    { id: 'chef',       name: 'Sushi Chef',       emoji: '🧑‍🍳', baseCost: 5,     perSecond: 0.1 },
    { id: 'ricecooker', name: 'Rice Cooker',      emoji: '🍚', baseCost: 30,    perSecond: 0.5 },
    { id: 'belt',       name: 'Conveyor Belt',    emoji: '🔄', baseCost: 150,   perSecond: 2 },
    { id: 'boat',       name: 'Fishing Boat',     emoji: '⛵', baseCost: 750,   perSecond: 8 },
    { id: 'restaurant', name: 'Sushi Restaurant', emoji: '🏮', baseCost: 4000,  perSecond: 35 },
    { id: 'market',     name: 'Fish Market',      emoji: '🐟', baseCost: 20000, perSecond: 150 },
];

const PRICE_GROWTH = 1.15; // each one you buy makes the next 15% more expensive

// ---------- Game state ----------
let points = 0;
let owned = {};          // how many of each item you have, e.g. { chef: 3, ricecooker: 1 }
let currentUser = null;  // set only after the player's data has loaded
let unsaved = false;     // true when there are changes not yet in Firestore

function resetGame() {
    points = 0;
    owned = {};
    for (const item of ITEMS) {
        owned[item.id] = 0;
    }
}
resetGame();

// ---------- Maths ----------
function itemCost(item) {
    return Math.ceil(item.baseCost * Math.pow(PRICE_GROWTH, owned[item.id]));
}

function totalPerSecond() {
    let total = 0;
    for (const item of ITEMS) {
        total = total + (item.perSecond || 0) * owned[item.id]; // "|| 0" = items without perSecond count as 0
    }
    return total;
}

// How many points one click is worth: 1, plus the bonus from every upgrade that has perClick
function clickPower() {
    let total = 1;
    for (const item of ITEMS) {
        total = total + (item.perClick || 0) * owned[item.id];
    }
    return total;
}

function format(number) {
    return Math.floor(number).toLocaleString('en-US'); // 12345.7 -> "12,345"
}

// For small numbers like 0.01 per second: shows up to 2 decimals, no trailing zeros
function formatRate(number) {
    const rounded = Math.round(number * 100) / 100; // 0.30000000000000004 -> 0.3
    return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ---------- Screens ----------
function showScreen(screenId) {
    const screens = document.querySelectorAll('.screen');
    for (const screen of screens) {
        screen.classList.add('hidden');
    }
    document.getElementById(screenId).classList.remove('hidden');
    updateDisplay();
}

// ---------- The store ----------
// Builds one button per upgrade. This runs once, at page load.
const storeButtons = {}; // item id -> its button, so we can update it later

function buildStore() {
    const list = document.getElementById('store-list');
    for (const item of ITEMS) {
        // Describe what it does, e.g. "+1 per click" or "+0.1/s"
        let effect = '';
        if (item.perClick) {
            effect = '+' + formatRate(item.perClick) + ' per click';
        }
        if (item.perSecond) {
            effect = '+' + formatRate(item.perSecond) + '/s';
        }

        const button = document.createElement('button');
        button.className = 'store-item';
        button.innerHTML =
            '<span class="item-emoji">' + item.emoji + '</span>' +
            '<span class="item-info">' +
                '<span class="item-name">' + item.name + '</span>' +
                '<span class="item-detail">' +
                    '<span class="item-cost"></span> points, ' + effect +
                '</span>' +
            '</span>' +
            '<span class="item-owned">0</span>';
        button.addEventListener('click', function () {
            buyItem(item);
        });
        list.appendChild(button);
        storeButtons[item.id] = button;
    }
}
buildStore();

// ---------- Showing numbers on the page ----------
function updateDisplay() {
    document.getElementById('score').innerText = format(points);
    document.getElementById('per-second').innerText =
        formatRate(totalPerSecond()) + ' per second, ' + formatRate(clickPower()) + ' per click';

    for (const item of ITEMS) {
        const button = storeButtons[item.id];
        const cost = itemCost(item);
        button.querySelector('.item-cost').innerText = format(cost);
        button.querySelector('.item-owned').innerText = owned[item.id];
        button.disabled = points < cost; // can't afford it -> greyed out
    }
}

// ---------- Game ----------
function pointsButton(event) {
    const gained = clickPower();
    points = points + gained;
    unsaved = true;
    updateDisplay();
    floatText(event, gained);
}

function buyItem(item) {
    const cost = itemCost(item);
    if (points < cost) {
        return;
    }
    points = points - cost;
    owned[item.id] = owned[item.id] + 1;
    unsaved = true;
    updateDisplay();
}

// A little "+1" (or "+3"...) that floats up from where you clicked
function floatText(event, amount) {
    const rect = event.currentTarget.getBoundingClientRect();
    // event.clientX is 0 when someone "clicks" with the keyboard, so fall back to the middle
    const x = event.clientX || rect.left + rect.width / 2;
    const y = event.clientY || rect.top + rect.height / 2;

    const bubble = document.createElement('span');
    bubble.className = 'float';
    bubble.innerText = '+' + formatRate(amount);
    bubble.style.left = x + 'px';
    bubble.style.top = y + 'px';
    document.body.appendChild(bubble);

    setTimeout(function () {
        bubble.remove();
    }, 800);
}

// Ten times a second, add a tenth of the points-per-second. Smoother than once a second.
setInterval(function () {
    const perSecond = totalPerSecond();
    if (perSecond > 0) {
        points = points + perSecond / 10;
        unsaved = true;
        updateDisplay();
    }
}, 100);

// ---------- Saving ----------
async function save() {
    if (!currentUser || !unsaved) {
        return;
    }
    unsaved = false;
    try {
        await setDoc(doc(db, 'users', currentUser.uid), {
            name: currentUser.displayName,
            points: Math.round(points * 100) / 100, // keep 2 decimals so slow income isn't lost
            owned: owned
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
            resetGame();
            if (snapshot.exists()) {
                const data = snapshot.data();
                points = Number(data.points) || 0;
                for (const item of ITEMS) {
                    // Number(...) || 0 also handles upgrades added after they last played
                    owned[item.id] = Number(data.owned && data.owned[item.id]) || 0;
                }
                unsaved = false;
            } else {
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
        resetGame();
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
