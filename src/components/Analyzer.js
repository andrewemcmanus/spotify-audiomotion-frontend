import AudioMotionAnalyzer from 'audiomotion-analyzer';
// import AudioMotionAnalyzer from 'https://cdn.skypack.dev/audiomotion-analyzer?min';
function Analyzer() {
  const audioMotion = new AudioMotionAnalyzer(document.getElementById('container'), {
    source: document.getElementById('audio')
    }
  );
  return audioMotion;
}

export default Analyzer;
