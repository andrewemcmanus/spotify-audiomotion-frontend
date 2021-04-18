import AudioMotionAnalyzer from 'https://cdn.skypack.dev/audiomotion-analyzer?min';
//
const audioMotion = new AudiomotionAnalyzer(document.getElementById('container'), {
    source: document.getElementById('audio')
  }
)

export default audioMotion;
