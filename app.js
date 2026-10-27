function StartButton() {
    window.location.href = "game/index.html";
}


let points = 0;


function PointsButton() {

    points = points + 1;
    document.getElementById('score').innerText = points;
}
