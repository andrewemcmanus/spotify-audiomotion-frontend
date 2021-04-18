import logo from './logo.svg';
import './App.css';
// import AudiomotionAnalyzer from './components/AudiomotionAnalyzer.js';
import AudioMotionAnalyzer from 'audiomotion-analyzer';
// import Analyzer from './components/Analyzer.js'

function Analyzer() {
  const audioMotion = new AudioMotionAnalyzer(document.getElementById('container'), {
    source: document.getElementById('audio')
    }
  );
  return audioMotion;
}


function App() {
  return (
    <div className="App">
      <header className="App-header">
      </header>
      <Analyzer />
    </div>
  );
}

export default App;
