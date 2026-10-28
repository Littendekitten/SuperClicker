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
