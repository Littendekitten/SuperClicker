let points = 0;

function PointsButton() {
    points = points + 1;
    document.getElementById('score').innerText = points;
}

function ShopButton() {
    window.location.href = "/game/shop";
}
