import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

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
// To add a new machine, add one line here. The factory, the saving and the
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

// ---------- The factory ----------
// Every item is a "lane" on the factory floor. Each one you own shows up as a tile
// on its lane, and the "+" tile at the end builds the next one.
const MAX_TILES = 5;      // show at most this many tiles per lane, then a "+N" tile
const lanes = {};         // item id -> the parts of its lane, so we can update them later
const shownCount = {};    // item id -> how many tiles are drawn right now

function buildFactory() {
    const floor = document.getElementById('factory-lanes');
    for (const item of ITEMS) {
        // Describe what it does, e.g. "+1 per click" or "+0.1/s each"
        let effect = '';
        if (item.perClick) {
            effect = '+' + formatRate(item.perClick) + ' per click each';
        }
        if (item.perSecond) {
            effect = '+' + formatRate(item.perSecond) + '/s each';
        }

        const lane = document.createElement('div');
        lane.className = 'lane';
        lane.innerHTML =
            '<div class="lane-head">' +
                '<span class="lane-title">' + item.emoji + ' ' + item.name +
                    ' <span class="lane-count">x0</span></span>' +
                '<span class="lane-effect">' + effect + '</span>' +
            '</div>' +
            '<div class="lane-belt">' +
                '<button class="build-tile" aria-label="Build ' + item.name + '">' +
                    '<span class="plus">+</span><span class="build-cost"></span>' +
                '</button>' +
            '</div>';

        const belt = lane.querySelector('.lane-belt');
        const buildButton = lane.querySelector('.build-tile');
        buildButton.addEventListener('click', function () {
            buyItem(item);
        });

        floor.appendChild(lane);
        lanes[item.id] = {
            belt: belt,
            buildButton: buildButton,
            count: lane.querySelector('.lane-count'),
            cost: lane.querySelector('.build-cost'),
        };
        shownCount[item.id] = 0;
    }
}
buildFactory();

// Draws the tiles for one lane. We only call this when the amount you own changed,
// so the little "pop" animation doesn't restart ten times a second.
function drawTiles(item) {
    const lane = lanes[item.id];
    const amount = owned[item.id];

    // Remove the old tiles (everything except the build button)
    for (const tile of lane.belt.querySelectorAll('.tile')) {
        tile.remove();
    }

    const visible = Math.min(amount, MAX_TILES);
    for (let i = 0; i < visible; i++) {
        const tile = document.createElement('span');
        tile.className = 'tile';
        tile.innerText = item.emoji;
        // Only the newest tile pops in, and only if you just bought it
        if (i === visible - 1 && amount > shownCount[item.id] && shownCount[item.id] > 0) {
            tile.classList.add('pop');
        }
        lane.belt.insertBefore(tile, lane.buildButton);
    }

    if (amount > MAX_TILES) {
        const more = document.createElement('span');
        more.className = 'tile more';
        more.innerText = '+' + (amount - MAX_TILES);
        lane.belt.insertBefore(more, lane.buildButton);
    }

    shownCount[item.id] = amount;
}

// ---------- Showing numbers on the page ----------
function updateDisplay() {
    document.getElementById('score').innerText = format(points);
    document.getElementById('per-second').innerText =
        formatRate(totalPerSecond()) + ' per second, ' + formatRate(clickPower()) + ' per click';

    for (const item of ITEMS) {
        const lane = lanes[item.id];
        const cost = itemCost(item);
        lane.cost.innerText = format(cost);
        lane.count.innerText = 'x' + owned[item.id];
        lane.buildButton.disabled = points < cost; // can't afford it -> greyed out
        lane.buildButton.setAttribute('aria-label', 'Build ' + item.name + ' for ' + format(cost) + ' points');

        if (owned[item.id] !== shownCount[item.id]) {
            drawTiles(item);
        }
    }
}

// ---------- Anti-autoclicker ----------
const MAX_CLICKS_PER_SECOND = 12; // a fast human is around 6-10, so 12 leaves some room
let recentClicks = [];            // when your last few clicks happened

function clickAllowed(event) {
    // Check 1: was this click made by a real mouse, touch or key?
    // A script like button.click() creates a fake event, and isTrusted is false for those.
    if (!event.isTrusted) {
        return false;
    }

    // Check 2: speed limit. Forget clicks older than 1 second, then count what's left.
    const now = performance.now();
    recentClicks = recentClicks.filter(function (time) {
        return now - time < 1000;
    });
    if (recentClicks.length >= MAX_CLICKS_PER_SECOND) {
        return false;
    }

    recentClicks.push(now);
    return true;
}

// ---------- Game ----------
function pointsButton(event) {
    if (!clickAllowed(event)) {
        return; // ignore this click completely
    }
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
            owned: owned,
            savedAt: serverTimestamp() // Google's clock, not the player's. The rules use it to check the earnings are possible.
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
                // New player: create their document right away, empty.
                // The rules only allow a brand-new document to start at zero.
                await setDoc(doc(db, 'users', user.uid), {
                    name: user.displayName,
                    points: 0,
                    owned: owned,
                    savedAt: serverTimestamp()
                });
                unsaved = false;
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
