const video = document.getElementById('background-video');
  const btn = document.getElementById('btnPlayPause');

  if (video && btn) {
    btn.addEventListener('click', () => {
      if (video.paused) {
        video.play();
        btn.textContent = "Pause";
      } else {
        video.pause();
        btn.textContent = "Play";
      }
    });
  }
