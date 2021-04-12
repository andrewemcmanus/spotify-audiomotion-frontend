import logo from './logo.svg';
import './App.css';
// import AudiomotionAnalyzer from './components/AudiomotionAnalyzer.js';
import AudioMotionAnalyzer from 'audiomotion-analyzer';
import Analyzer from './components/Analyzer.js'

function App() {
  return (
    <div className="App">
      <header className="App-header">
      <AudioMotionAnalyzer />
      </header>
    </div>
  );
}

export default App;
