const video = document.getElementById('rickroll');
  const btn = document.getElementById('btnPlayPause');

  btn.addEventListener('click', () => {
    if (video.paused) {
      video.play();
      btn.textContent = "Pause";
    } else {
      video.pause();
      btn.textContent = "Play";
    }
  });
