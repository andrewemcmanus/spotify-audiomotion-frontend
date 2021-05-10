import React, { Component } from 'react';


/**!
 * audioMotion-analyzer
 * High-resolution real-time graphic audio spectrum analyzer JS module
 *
 * @version 3.2.1
 * @author  Henrique Avila Vianna <hvianna@gmail.com> <https://henriquevianna.com>
 * @license AGPL-3.0-or-later
 */

const VERSION = '3.2.1';

// internal constants
const TAU     = 2 * Math.PI,
	  HALF_PI = Math.PI / 2,
	  RPM     = TAU / 3600,           // angle increment per frame for one revolution per minute @60fps
	  ROOT24  = 2 ** ( 1 / 24 ),      // 24th root of 2
	  C0      = 440 * ROOT24 ** -114; // ~16.35 Hz

export default class AudioMotionAnalyzer extends React.Component {

/**
 * CONSTRUCTOR
 *
 * @param {object} [container] DOM element where to insert the analyzer; if undefined, uses the document body
 * @param {object} [options]
 * @returns {object} AudioMotionAnalyzer object
 */
	super( container, options = {} ) {

		this._ready = false;

		// Gradient definitions

		this._gradients = {
			classic: {
				bgColor: '#111',
				colorStops: [
					'hsl( 0, 100%, 50% )',
					{ pos: .6, color: 'hsl( 60, 100%, 50% )' },
					'hsl( 120, 100%, 50% )'
				]
			},
			prism:   {
				bgColor: '#111',
				colorStops: [
					'hsl( 0, 100%, 50% )',
					'hsl( 60, 100%, 50% )',
					'hsl( 120, 100%, 50% )',
					'hsl( 180, 100%, 50% )',
					'hsl( 240, 100%, 50% )'
				]
			},
			rainbow: {
				bgColor: '#111',
				dir: 'h',
				colorStops: [
					'hsl( 0, 100%, 50% )',
					'hsl( 60, 100%, 50% )',
					'hsl( 120, 100%, 50% )',
					'hsl( 180, 100%, 47% )',
					'hsl( 240, 100%, 58% )',
					'hsl( 300, 100%, 50% )',
					'hsl( 360, 100%, 50% )'
				]
			},
		};

		// Set container
		this._container = container || document.body;

		// Make sure we have minimal width and height dimensions in case of an inline container
		this._defaultWidth  = this._container.clientWidth  || 640;
		this._defaultHeight = this._container.clientHeight || 270;

		// Use audio context provided by user, or create a new one

		let audioCtx;

		if ( options.source && ( audioCtx = options.source.context ) ) {
			// get audioContext from provided source audioNode
		}
		else if ( audioCtx = options.audioCtx ) {
			// use audioContext provided by user
		}
		else {
			try {
				audioCtx = new ( window.AudioContext || window.webkitAudioContext )();
			}
			catch( err ) {
				throw new AudioMotionError( 'ERR_AUDIO_CONTEXT_FAIL', 'Could not create audio context. Web Audio API not supported?' );
			}
		}

		// make sure audioContext is valid
		if ( ! audioCtx.createGain )
			throw new AudioMotionError( 'ERR_INVALID_AUDIO_CONTEXT', 'Provided audio context is not valid' );

		/*
			Connection routing:
			===================

			for STEREO:                              +--->  analyzer[0]  ---+
		    	                                     |                      |
			(source) --->  input  --->  splitter  ---+                      +--->  merger  --->  output  ---> (destination)
		    	                                     |                      |
		        	                                 +--->  analyzer[1]  ---+

			for MONO:

			(source) --->  input  ----------------------->  analyzer[0]  --------------------->  output  ---> (destination)

		*/

		// create the analyzer nodes, channel splitter and merger, and gain nodes for input/output connections
		const analyzer = this._analyzer = [ audioCtx.createAnalyser(), audioCtx.createAnalyser() ];
		const splitter = this._splitter = audioCtx.createChannelSplitter(2);
 		const merger   = this._merger   = audioCtx.createChannelMerger(2);
 		this._input    = audioCtx.createGain();
 		this._output   = audioCtx.createGain();

 		// initialize sources array and connect audio source if provided in the options
		this._sources = [];
		if ( options.source )
			this.connectInput( options.source );

 		// connect splitter -> analyzers
 		for ( const i of [0,1] )
			splitter.connect( analyzer[ i ], i );

		// connect merger -> output
		merger.connect( this._output );

		// connect output -> destination (speakers)
		this._outNodes = [];
		if ( options.connectSpeakers !== false )
			this.connectOutput();

		// initialize object to save energy
		this._energy = { val: 0, peak: 0, hold: 0 };

		// create analyzer canvas
		const canvas = document.createElement('canvas');
		canvas.style = 'max-width: 100%;';
		this._container.appendChild( canvas );
		this._canvasCtx = canvas.getContext('2d');

		// create auxiliary canvases for the X-axis and radial scale labels
		for ( const ctx of [ '_scaleX', '_scaleR' ] )
			this[ ctx ] = document.createElement('canvas').getContext('2d');

		// Update canvas size on container / window resize and fullscreen events

		// Fullscreen changes are handled quite differently across browsers:
		// 1. Chromium browsers will trigger a `resize` event followed by a `fullscreenchange`
		// 2. Firefox triggers the `fullscreenchange` first and then the `resize`
		// 3. Chrome on Android (TV) won't trigger a `resize` event, only `fullscreenchange`
		// 4. Safari won't trigger `fullscreenchange` events at all, and on iPadOS the `resize`
		//    event is triggered **on the window** only (last tested on iPadOS 14)

		// helper function for resize events
		const onResize = () => {
			if ( ! this._fsTimeout ) {
				// delay the resize to prioritize a possible following `fullscreenchange` event
				this._fsTimeout = window.setTimeout( () => {
					if ( ! this._fsChanging ) {
						this._setCanvas('resize');
						this._fsTimeout = 0;
					}
				}, 60 );
			}
		}

		// if browser supports ResizeObserver, listen for resize on the container
		if ( window.ResizeObserver ) {
			const resizeObserver = new ResizeObserver( onResize );
			resizeObserver.observe( this._container );
		}

		// listen for resize events on the window - required for fullscreen on iPadOS
		window.addEventListener( 'resize', onResize );

		// listen for fullscreenchange events on the canvas - not available on Safari
		canvas.addEventListener( 'fullscreenchange', () => {
			// set flag to indicate a fullscreen change in progress
			this._fsChanging = true;

			// if there is a scheduled resize event, clear it
			if ( this._fsTimeout )
				window.clearTimeout( this._fsTimeout );

			// update the canvas
			this._setCanvas('fschange');

			// delay clearing the flag to prevent any shortly following resize event
			this._fsTimeout = window.setTimeout( () => {
				this._fsChanging = false;
				this._fsTimeout = 0;
			}, 60 );
		});

		// Resume audio context if in suspended state (browsers' autoplay policy)
		const unlockContext = () => {
			if ( audioCtx.state === 'suspended' )
				audioCtx.resume();
			window.removeEventListener( 'click', unlockContext );
		}
		window.addEventListener( 'click', unlockContext );

		// initialize internal variables
		this._calcAux();

		// Set configuration options and use defaults for any missing properties
		this._setProps( options, true );

		// Finish canvas setup
		this._ready = true;
		this._setCanvas('create');
	}

	/**
	 * ==========================================================================
	 *
	 * PUBLIC PROPERTIES GETTERS AND SETTERS
	 *
	 * ==========================================================================
	 */

	// Bar spacing (for octave bands modes)

	get barSpace() {
		return this._barSpace;
	}
	set barSpace( value ) {
		this._barSpace = +value || 0;
		this._calcAux();
	}

	// FFT size

	get fftSize() {
		return this._analyzer[0].fftSize;
	}
	set fftSize( value ) {
		for ( const i of [0,1] )
			this._analyzer[ i ].fftSize = value;
		const binCount = this._analyzer[0].frequencyBinCount;
		this._fftData = [ new Uint8Array( binCount ), new Uint8Array( binCount ) ];
		this._calcBars();
	}

	// Gradient

	get gradient() {
		return this._gradient;
	}
	set gradient( value ) {
		if ( ! this._gradients.hasOwnProperty( value ) )
			throw new AudioMotionError( 'ERR_UNKNOWN_GRADIENT', `Unknown gradient: '${value}'` );

		this._gradient = value;
		this._makeGrad();
	}

	// Canvas size

	get height() {
		return this._height;
	}
	set height( h ) {
		this._height = h;
		this._setCanvas('user');
	}
	get width() {
		return this._width;
	}
	set width( w ) {
		this._width = w;
		this._setCanvas('user');
	}

	// Visualization mode

	get mode() {
		return this._mode;
	}
	set mode( value ) {
		const mode = value | 0;
		if ( mode >= 0 && mode <= 10 && mode !== 9 ) {
			this._mode = mode;
			this._calcAux();
			this._calcBars();
			this._makeGrad();
		}
		else
			throw new AudioMotionError( 'ERR_INVALID_MODE', `Invalid mode: ${value}` );
	}

	// Low-resolution mode

	get loRes() {
		return this._loRes;
	}
	set loRes( value ) {
		this._loRes = !! value;
		this._setCanvas('lores');
	}

	// Luminance bars

	get lumiBars() {
		return this._lumiBars;
	}
	set lumiBars( value ) {
		this._lumiBars = !! value;
		this._calcAux();
		this._calcLeds();
		this._makeGrad();
	}

	// Radial mode

	get radial() {
		return this._radial;
	}
	set radial( value ) {
		this._radial = !! value;
		this._calcAux();
		this._calcLeds();
		this._makeGrad();
	}

	// Radial spin speed

	get spinSpeed() {
		return this._spinSpeed;
	}
	set spinSpeed( value ) {
		value = +value || 0;
		if ( this._spinSpeed === undefined || value === 0 )
			this._spinAngle = -HALF_PI; // initialize or reset the rotation angle
		this._spinSpeed = value;
	}

	// Reflex

	get reflexRatio() {
		return this._reflexRatio;
	}
	set reflexRatio( value ) {
		value = +value || 0;
		if ( value < 0 || value >= 1 )
			throw new AudioMotionError( 'ERR_REFLEX_OUT_OF_RANGE', `Reflex ratio must be >= 0 and < 1` );
		else {
			this._reflexRatio = value;
			this._calcAux();
			this._makeGrad();
			this._calcLeds();
		}
	}

	// Current frequency range

	get minFreq() {
		return this._minFreq;
	}
	set minFreq( value ) {
		if ( value < 1 )
			throw new AudioMotionError( 'ERR_FREQUENCY_TOO_LOW', `Frequency values must be >= 1` );
		else {
			this._minFreq = value;
			this._calcBars();
		}
	}
	get maxFreq() {
		return this._maxFreq;
	}
	set maxFreq( value ) {
		if ( value < 1 )
			throw new AudioMotionError( 'ERR_FREQUENCY_TOO_LOW', `Frequency values must be >= 1` );
		else {
			this._maxFreq = value;
			this._calcBars();
		}
	}

	// Analyzer's sensitivity

	get minDecibels() {
		return this._analyzer[0].minDecibels;
	}
	set minDecibels( value ) {
		for ( const i of [0,1] )
			this._analyzer[ i ].minDecibels = value;
	}
	get maxDecibels() {
		return this._analyzer[0].maxDecibels;
	}
	set maxDecibels( value ) {
		for ( const i of [0,1] )
			this._analyzer[ i ].maxDecibels = value;
	}

	// LEDs effect

	get showLeds() {
		return this._showLeds;
	}
	set showLeds( value ) {
		this._showLeds = !! value;
		this._calcAux();
	}

	// Analyzer's smoothing time constant

	get smoothing() {
		return this._analyzer[0].smoothingTimeConstant;
	}
	set smoothing( value ) {
		for ( const i of [0,1] )
			this._analyzer[ i ].smoothingTimeConstant = value;
	}

	// Split gradient (in stereo mode)

	get splitGradient() {
		return this._splitGradient;
	}
	set splitGradient( value ) {
		this._splitGradient = !! value;
		this._makeGrad();
	}

	// Stereo

	get stereo() {
		return this._stereo;
	}
	set stereo( value ) {
		this._stereo = !! value;

		// update node connections
		this._input.disconnect();
		this._input.connect( this._stereo ? this._splitter : this._analyzer[0] );
		this._analyzer[0].disconnect();
		if ( this._outNodes.length ) // connect analyzer only if the output is connected to other nodes
			this._analyzer[0].connect( this._stereo ? this._merger : this._output );

		// update properties affected by stereo
		this._calcAux();
		this._createScales();
		this._calcLeds();
		this._makeGrad();
	}

	// Volume

	get volume() {
		return this._output.gain.value;
	}
	set volume( value ) {
		this._output.gain.value = value;
	}

	// Read only properties

	get audioCtx() {
		return this._input.context;
	}
	get canvas() {
		return this._canvasCtx.canvas;
	}
	get canvasCtx() {
		return this._canvasCtx;
	}
	get connectedSources() {
		return this._sources;
	}
	get connectedTo() {
		return this._outNodes;
	}
	get energy() {
		// DEPRECATED - to be removed in v4.0.0
		return this.getEnergy();
	}
	get fsWidth() {
		return this._fsWidth;
	}
	get fsHeight() {
		return this._fsHeight;
	}
	get fps() {
		return this._fps;
	}
	get isFullscreen() {
		return ( document.fullscreenElement || document.webkitFullscreenElement ) === this.canvas;
	}
	get isOctaveBands() {
		return this._isOctaveBands;
	}
	get isLedDisplay() {
		return this._isLedDisplay;
	}
	get isLumiBars() {
		return this._isLumiBars;
	}
	get isOn() {
		return this._runId !== undefined;
	}
	get peakEnergy() {
		// DEPRECATED - to be removed in v4.0.0
		return this.getEnergy('peak');
	}
	get pixelRatio() {
		return this._pixelRatio;
	}
	static get version() {
		return VERSION;
	}

	/**
	 * ==========================================================================
     *
	 * PUBLIC METHODS
	 *
	 * ==========================================================================
	 */

	/**
	 * Connects an HTML media element or audio node to the analyzer
	 *
	 * @param {object} an instance of HTMLMediaElement or AudioNode
	 * @returns {object} a MediaElementAudioSourceNode object if created from HTML element, or the same input object otherwise
	 */
	connectInput( source ) {
		const isHTML = source instanceof HTMLMediaElement;

		if ( ! ( isHTML || source.connect ) )
			throw new AudioMotionError( 'ERR_INVALID_AUDIO_SOURCE', 'Audio source must be an instance of HTMLMediaElement or AudioNode' );

		// if source is an HTML element, create an audio node for it; otherwise, use the provided audio node
		const node = isHTML ? this.audioCtx.createMediaElementSource( source ) : source;

		if ( ! this._sources.includes( node ) ) {
			node.connect( this._input );
			this._sources.push( node );
		}

		return node;
	}

	/**
	 * Disconnects audio sources from the analyzer
	 *
	 * @param [{object|array}] a connected AudioNode object or an array of such objects; if undefined, all connected nodes are disconnected
	 */
	disconnectInput( sources ) {
		if ( ! sources )
			sources = Array.from( this._sources );
		else if ( ! Array.isArray( sources ) )
			sources = [ sources ];

		for ( const node of sources ) {
			const idx = this._sources.indexOf( node );
			if ( idx >= 0 ) {
				node.disconnect( this._input );
				this._sources.splice( idx, 1 );
			}
		}
	}

	/**
	 * Connects the analyzer output to another audio node
	 *
	 * @param [{object}] an AudioNode; if undefined, the output is connected to the audio context destination (speakers)
	 */
	connectOutput( node = this.audioCtx.destination ) {
		if ( this._outNodes.includes( node ) )
			return;

		this._output.connect( node );
		this._outNodes.push( node );

		// when connecting the first node, also connect the analyzer nodes to the merger / output nodes
		if ( this._outNodes.length === 1 ) {
			for ( const i of [0,1] )
				this._analyzer[ i ].connect( ( ! this._stereo && ! i ? this._output : this._merger ), 0, i );
		}
	}

	/**
	 * Disconnects the analyzer output from other audio nodes
	 *
	 * @param [{object}] a connected AudioNode object; if undefined, all connected nodes are disconnected
	 */
	disconnectOutput( node ) {
		if ( node && ! this._outNodes.includes( node ) )
			return;

		this._output.disconnect( node );
		this._outNodes = node ? this._outNodes.filter( e => e !== node ) : [];

		// if disconnected from all nodes, also disconnect the analyzer nodes so they keep working on Chromium
		// see https://github.com/hvianna/audioMotion-analyzer/issues/13#issuecomment-808764848
		if ( this._outNodes.length === 0 ) {
			for ( const i of [0,1] )
				this._analyzer[ i ].disconnect();
		}
	}

	/**
	 * Returns the energy of a frequency, or average energy of a range of frequencies
	 *
	 * @param [{number|string}] single or initial frequency (Hz), or preset name; if undefined, returns the overall energy
	 * @param [{number}] ending frequency (Hz)
	 * @returns {number|null} energy value (0 to 1) or null, if the specified preset is unknown
	 */
	getEnergy( startFreq, endFreq ) {
		if ( startFreq === undefined )
			return this._energy.val;

		// if startFreq is a string, check for presets
		if ( startFreq !== ( startFreq | 0 ) ) {
			if ( startFreq === 'peak' )
				return this._energy.peak;

			const presets = {
				bass:    [ 20, 250 ],
				lowMid:  [ 250, 500 ],
				mid:     [ 500, 2e3 ],
				highMid: [ 2e3, 4e3 ],
				treble:  [ 4e3, 16e3 ]
			}

			if ( ! presets[ startFreq ] )
				return null;

			[ startFreq, endFreq ] = presets[ startFreq ];
		}

		const startBin = this._freqToBin( startFreq ),
		      endBin   = endFreq ? this._freqToBin( endFreq ) : startBin,
		      chnCount = this._stereo + 1;

		let energy = 0;
		for ( let channel = 0; channel < chnCount; channel++ ) {
			for ( let i = startBin; i <= endBin; i++ )
				energy += this._fftData[ channel ][ i ];
		}

		return energy / ( endBin - startBin + 1 ) / chnCount / 255;
	}

	/**
	 * Registers a custom gradient
	 *
	 * @param {string} name
	 * @param {object} options
	 */
	registerGradient( name, options ) {
		if ( typeof name !== 'string' || name.trim().length === 0 )
			throw new AudioMotionError( 'ERR_GRADIENT_INVALID_NAME', 'Gradient name must be a non-empty string' );

		if ( typeof options !== 'object' )
			throw new AudioMotionError( 'ERR_GRADIENT_NOT_AN_OBJECT', 'Gradient options must be an object' );

		if ( options.colorStops === undefined || options.colorStops.length < 2 )
			throw new AudioMotionError( 'ERR_GRADIENT_MISSING_COLOR', 'Gradient must define at least two colors' );

		this._gradients[ name ] = {};

		if ( options.bgColor !== undefined )
			this._gradients[ name ].bgColor = options.bgColor;
		else
			this._gradients[ name ].bgColor = '#111';

		if ( options.dir !== undefined )
			this._gradients[ name ].dir = options.dir;

		this._gradients[ name ].colorStops = options.colorStops;
	}

	/**
	 * Set dimensions of analyzer's canvas
	 *
	 * @param {number} w width in pixels
	 * @param {number} h height in pixels
	 */
	setCanvasSize( w, h ) {
		this._width = w;
		this._height = h;
		this._setCanvas('user');
	}

	/**
	 * Set desired frequency range
	 *
	 * @param {number} min lowest frequency represented in the x-axis
	 * @param {number} max highest frequency represented in the x-axis
	 */
	setFreqRange( min, max ) {
		if ( min < 1 || max < 1 )
			throw new AudioMotionError( 'ERR_FREQUENCY_TOO_LOW', `Frequency values must be >= 1` );
		else {
			this._minFreq = Math.min( min, max );
			this._maxFreq = Math.max( min, max );
			this._calcBars();
		}
	}

	/**
	 * Set custom parameters for LED effect
	 * If called with no arguments or if any property is invalid, clears any previous custom parameters
	 *
	 * @param {object} [params]
	 */
	setLedParams( params ) {
		let maxLeds, spaceV, spaceH;

		// coerce parameters to Number; `NaN` results are rejected in the condition below
		if ( params ) {
			let maxLeds = params.maxLeds; // ensure integer
			let spaceV  = +params.spaceV;
			let spaceH  = +params.spaceH;
		}

		this._ledParams = maxLeds > 0 && spaceV > 0 && spaceH >= 0 ? [ maxLeds, spaceV, spaceH ] : undefined;
		this._calcLeds();
	}

	/**
	 * Shorthand function for setting several options at once
	 *
	 * @param {object} options
	 */
	setOptions( options ) {
		this._setProps( options );
	}

	/**
	 * Adjust the analyzer's sensitivity
	 *
	 * @param {number} min minimum decibels value
	 * @param {number} max maximum decibels value
	 */
	setSensitivity( min, max ) {
		for ( const i of [0,1] ) {
			this._analyzer[ i ].minDecibels = Math.min( min, max );
			this._analyzer[ i ].maxDecibels = Math.max( min, max );
		}
	}

	/**
	 * Start / stop canvas animation
	 *
	 * @param {boolean} [value] if undefined, inverts the current status
	 * @returns {boolean} resulting status after the change
	 */
	toggleAnalyzer( value ) {
		const started = this.isOn;

		if ( value === undefined )
			value = ! started;

		if ( started && ! value ) {
			cancelAnimationFrame( this._runId );
			this._runId = undefined;
		}
		else if ( ! started && value ) {
			this._frame = this._fps = 0;
			this._time = performance.now();
			this._runId = requestAnimationFrame( timestamp => this._draw( timestamp ) );
		}

		return this.isOn;
	}

	/**
	 * Toggles canvas full-screen mode
	 */
	toggleFullscreen() {
		if ( this.isFullscreen ) {
			if ( document.exitFullscreen )
				document.exitFullscreen();
			else if ( document.webkitExitFullscreen )
				document.webkitExitFullscreen();
		}
		else {
			const canvas = this.canvas;
			if ( canvas.requestFullscreen )
				canvas.requestFullscreen();
			else if ( canvas.webkitRequestFullscreen )
				canvas.webkitRequestFullscreen();
		}
	}

	/**
	 * ==========================================================================
	 *
	 * PRIVATE METHODS
	 *
	 * ==========================================================================
	 */

	/**
	 * Calculate auxiliary values and flags
	 */
	_calcAux() {
		const canvas = this.canvas;

		this._radius         = canvas.height * ( this._stereo ? .375 : .125 ) | 0;
		this._barSpacePx     = Math.min( this._barWidth - 1, ( this._barSpace > 0 && this._barSpace < 1 ) ? this._barWidth * this._barSpace : this._barSpace );
		this._isOctaveBands  = ( this._mode % 10 !== 0 );
		this._isLedDisplay   = ( this._showLeds && this._isOctaveBands && ! this._radial );
		this._isLumiBars     = ( this._lumiBars && this._isOctaveBands && ! this._radial );
		// CHECK PARSING
		this._maximizeLeds   = ! this._stereo || ( this._reflexRatio > 0 && ! this._isLumiBars );

		const isDual = this._stereo && ! this._radial;
		this._channelHeight  = canvas.height - ( isDual && ! this._isLedDisplay ? .5 : 0 ) >> isDual;
		this._analyzerHeight = this._channelHeight * ( this._isLumiBars || this._radial ? 1 : 1 - this._reflexRatio ) | 0;

		// channelGap is **0** if isLedDisplay == true (LEDs already have spacing); **1** if canvas height is odd (windowed); **2** if it's even
		// TODO: improve this, make it configurable?
		this._channelGap     = isDual ? canvas.height - this._channelHeight * 2 : 0;
	}

	/**
	 * Calculate attributes for the vintage LEDs effect, based on visualization mode and canvas resolution
	 */
	_calcLeds() {
		if ( ! this._isOctaveBands || ! this._ready )
			return;

		// adjustment for high pixel-ratio values on low-resolution screens (Android TV)
		const dPR = this._pixelRatio / ( window.devicePixelRatio > 1 && window.screen.height <= 540 ? 2 : 1 );

		const params = [ [],
			[ 128,  3, .45  ], // mode 1
			[ 128,  4, .225 ], // mode 2
			[  96,  6, .225 ], // mode 3
			[  80,  6, .225 ], // mode 4
			[  80,  6, .125 ], // mode 5
			[  64,  6, .125 ], // mode 6
			[  48,  8, .125 ], // mode 7
			[  24, 16, .125 ], // mode 8
		];

		// use custom LED parameters if set, or the default parameters for the current mode
		const customParams = this._ledParams,
			  [ maxLeds, spaceVRatio, spaceHRatio ] = customParams || params[ this._mode ];

		let ledCount, spaceV,
			analyzerHeight = this._analyzerHeight;

		if ( customParams ) {
			const minHeight = 2 * dPR;
			let blockHeight;
			ledCount = maxLeds + 1;
			do {
				ledCount--;
				blockHeight = analyzerHeight / ledCount / ( 1 + spaceVRatio );
				spaceV = blockHeight * spaceVRatio;
			} while ( ( blockHeight < minHeight || spaceV < minHeight ) && ledCount > 1 );
		}
		else {
			// calculate vertical spacing - aim for the reference ratio, but make sure it's at least 2px
			const refRatio = 540 / spaceVRatio;
			spaceV = Math.min( spaceVRatio * dPR, Math.max( 2, analyzerHeight / refRatio + .1 | 0 ) );
		}

		// remove the extra spacing below the last line of LEDs
		if ( this._maximizeLeds )
			analyzerHeight += spaceV;

		// recalculate the number of leds, considering the effective spaceV
		if ( ! customParams )
			ledCount = Math.min( maxLeds, analyzerHeight / ( spaceV * 2 ) | 0 );

		this._leds = [
			ledCount,
			spaceHRatio >= 1 ? spaceHRatio : this._barWidth * spaceHRatio, // spaceH
			spaceV,
			analyzerHeight / ledCount - spaceV // ledHeight
		];
	}

	/**
	 * Redraw the canvas
	 * this is called 60 times per second by requestAnimationFrame()
	 */
	_draw( timestamp ) {
		const ctx            = this._canvasCtx,
			  canvas         = ctx.canvas,
			  canvasX        = this._scaleX.canvas,
			  canvasR        = this._scaleR.canvas,
			  energy         = this._energy,
			  isOctaveBands  = this._isOctaveBands,
			  isLedDisplay   = this._isLedDisplay,
			  isLumiBars     = this._isLumiBars,
			  isRadial       = this._radial,
			  isStereo       = this._stereo,
			  mode           = this._mode,
			  channelHeight  = this._channelHeight,
			  channelGap     = this._channelGap,
			  analyzerHeight = this._analyzerHeight;

		// radial related constants
		const centerX        = canvas.width >> 1,
			  centerY        = canvas.height >> 1,
			  radius         = this._radius;

		if ( energy.val > 0 )
			this._spinAngle += this._spinSpeed * RPM;

		// helper function - convert planar X,Y coordinates to radial coordinates
		const radialXY = ( x, y ) => {
			const height = radius + y,
				  angle  = TAU * ( x / canvas.width ) + this._spinAngle;

			return [ centerX + height * Math.cos( angle ), centerY + height * Math.sin( angle ) ];
		}

		// helper function - draw a polygon of width `w` and height `h` at (x,y) in radial mode
		const radialPoly = ( x, y, w, h ) => {
			ctx.moveTo( ...radialXY( x, y ) );
			ctx.lineTo( ...radialXY( x, y + h ) );
			ctx.lineTo( ...radialXY( x + w, y + h ) );
			ctx.lineTo( ...radialXY( x + w, y ) );
		}

		// LED attributes
		const [ ledCount, ledSpaceH, ledSpaceV, ledHeight ] = this._leds || [];

		// select background color
		const bgColor = ( ! this.showBgColor || ( isLedDisplay && ! this.overlay ) ) ? '#000' : this._gradients[ this._gradient ].bgColor;

		// compute the effective bar width, considering the selected bar spacing
		// if led effect is active, ensure at least the spacing from led definitions
		let width = this._barWidth - ( ! isOctaveBands ? 0 : Math.max( isLedDisplay ? ledSpaceH : 0, this._barSpacePx ) );

		// make sure width is integer for pixel accurate calculation, when no bar spacing is required
		if ( this._barSpace === 0 && ! isLedDisplay )
			width |= 0;

		let currentEnergy = 0;

		const nBars = this._bars.length;

		for ( let channel = 0; channel < isStereo + 1; channel++ ) {

			const channelTop     = channelHeight * channel + channelGap * channel,
				  channelBottom  = channelTop + channelHeight,
				  analyzerBottom = channelTop + analyzerHeight - ( isLedDisplay && ! this._maximizeLeds ? ledSpaceV : 0 );

			// clear the channel area, if in overlay mode
			// this is done per channel to clear any residue below 0 off the top channel (especially in line graph mode with lineWidth > 1)
			if ( this.overlay )
				ctx.clearRect( 0, channelTop - channelGap, canvas.width, channelHeight + channelGap );

			// fill the analyzer background if needed (not overlay or overlay + showBgColor)
			if ( ! this.overlay || this.showBgColor ) {
				if ( this.overlay )
					ctx.globalAlpha = this.bgAlpha;

				ctx.fillStyle = bgColor;

				// exclude the reflection area when overlay is true and reflexAlpha == 1 (avoids alpha over alpha difference, in case bgAlpha < 1)
				if ( ! isRadial || channel === 0 )
					ctx.fillRect( 0, channelTop - channelGap, canvas.width, ( this.overlay && this.reflexAlpha === 1 ? analyzerHeight : channelHeight ) + channelGap );

				ctx.globalAlpha = 1;
			}

			// draw dB scale (Y-axis)
			if ( this.showScaleY && ! isLumiBars && ! isRadial ) {
				const scaleWidth = canvasX.height,
					  fontSize   = scaleWidth >> 1,
					  mindB      = this._analyzer[0].minDecibels,
					  maxdB      = this._analyzer[0].maxDecibels,
					  interval   = analyzerHeight / ( maxdB - mindB );

				ctx.fillStyle = '#888';
				ctx.font = `${fontSize}px sans-serif`;
				ctx.textAlign = 'right';
				ctx.lineWidth = 1;

				for ( let db = maxdB; db > mindB; db -= 5 ) {
					const posY = channelTop + ( maxdB - db ) * interval,
						  even = ( db % 2 === 0 ) | 0;

					if ( even ) {
						const labelY = posY + fontSize * ( posY === channelTop ? .8 : .35 );
						ctx.fillText( db, scaleWidth * .85, labelY );
						ctx.fillText( db, canvas.width - scaleWidth * .1, labelY );
						ctx.strokeStyle = '#888';
						ctx.setLineDash([2,4]);
						ctx.lineDashOffset = 0;
					}
					else {
						ctx.strokeStyle = '#555';
						ctx.setLineDash([2,8]);
						ctx.lineDashOffset = 1;
					}

					ctx.beginPath();
					ctx.moveTo( scaleWidth * even, ~~posY + .5 ); // for sharp 1px line (https://stackoverflow.com/a/13879402/2370385)
					ctx.lineTo( canvas.width - scaleWidth * even, ~~posY + .5 );
					ctx.stroke();
				}
				// restore line properties
				ctx.setLineDash([]);
				ctx.lineDashOffset = 0;
			}

			// set line width and dash for LEDs effect
			if ( isLedDisplay ) {
				ctx.setLineDash( [ ledHeight, ledSpaceV ] );
				ctx.lineWidth = width;
			}

			// set selected gradient for fill and stroke
			ctx.fillStyle = ctx.strokeStyle = this._canvasGradient;

			// get a new array of data from the FFT
			const fftData = this._fftData[ channel ];
			this._analyzer[ channel ].getByteFrequencyData( fftData );

			// start drawing path
			ctx.beginPath();

			// draw bars / lines

			for ( let i = 0; i < nBars; i++ ) {

				let bar       = this._bars[ i ],
					barHeight = 0;

				if ( bar.endIdx === 0 ) { // single FFT bin
					barHeight = fftData[ bar.dataIdx ];
					// perform value interpolation when several bars share the same bin, to generate a smooth curve
					if ( bar.factor ) {
						const prevBar = bar.dataIdx ? fftData[ bar.dataIdx - 1 ] : barHeight;
						barHeight = prevBar + ( barHeight - prevBar ) * bar.factor;
					}
				}
				else { 					// range of bins
					// use the highest value in the range
					for ( let j = bar.dataIdx; j <= bar.endIdx; j++ )
						barHeight = Math.max( barHeight, fftData[ j ] );
				}

				barHeight /= 255;
				currentEnergy += barHeight;

				// set opacity for lumi bars before barHeight value is normalized
				if ( isLumiBars )
					ctx.globalAlpha = barHeight;

				if ( isLedDisplay ) { // normalize barHeight to match one of the "led" elements
					barHeight = ( barHeight * ledCount | 0 ) * ( ledHeight + ledSpaceV ) - ledSpaceV;
					if ( barHeight < 0 )
						barHeight = 0; // prevent showing leds below 0 when overlay and reflex are active
				}
				else
					barHeight = barHeight * ( isRadial ? centerY - radius : analyzerHeight ) | 0;

				if ( barHeight >= bar.peak[ channel ] ) {
					bar.peak[ channel ] = barHeight;
					bar.hold[ channel ] = 30; // set peak hold time to 30 frames (0.5s)
					bar.accel[ channel ] = 0;
				}

				if ( isRadial && channel === 1 )
					barHeight *= -1;

				let adjWidth = width,    // bar width may need small adjustments for some bars, when barSpace == 0
					posX     = bar.posX;

				// Draw current bar or line segment

				if ( mode === 10 ) {
					if ( isRadial ) {
						// in radial graph mode, use value of previous FFT bin (if available) as the initial amplitude
						if ( i === 0 && bar.dataIdx && bar.posX )
							ctx.lineTo( ...radialXY( 0, fftData[ bar.dataIdx - 1 ] / 255 * ( centerY - radius ) * ( channel === 1 ? -1 : 1 ) ) );
						// draw line to current point, avoiding overlapping wrap-around frequencies
						if ( bar.posX >= 0 )
							ctx.lineTo( ...radialXY( bar.posX, barHeight ) );
					}
					else {
						if ( i === 0 ) {
							// in linear mode, start the line off screen
							ctx.moveTo( -this.lineWidth, analyzerBottom );
							// use value of previous FFT bin
							if ( bar.dataIdx )
								ctx.lineTo( -this.lineWidth, analyzerBottom - fftData[ bar.dataIdx - 1 ] / 255 * analyzerHeight );
						}
						// draw line to current point
						ctx.lineTo( bar.posX, analyzerBottom - barHeight );
					}
				}
				else {
					if ( mode > 0 ) {
						if ( isLedDisplay )
							posX += Math.max( ledSpaceH / 2, this._barSpacePx / 2 );
						else {
							if ( this._barSpace === 0 ) {
								posX |= 0;
								if ( i > 0 && posX > this._bars[ i - 1 ].posX + width ) {
									posX--;
									adjWidth++;
								}
							}
							else
								posX += this._barSpacePx / 2;
						}
					}

					if ( isLedDisplay ) {
						const x = posX + width / 2;
						// draw "unlit" leds
						if ( this.showBgColor && ! this.overlay ) {
							const alpha = ctx.globalAlpha;
							ctx.beginPath();
							ctx.moveTo( x, channelTop );
							ctx.lineTo( x, analyzerBottom );
							ctx.strokeStyle = '#7f7f7f22';
							ctx.globalAlpha = 1;
							ctx.stroke();
							// restore properties
							ctx.strokeStyle = ctx.fillStyle;
							ctx.globalAlpha = alpha;
						}
						ctx.beginPath();
						ctx.moveTo( x, isLumiBars ? channelTop : analyzerBottom );
						ctx.lineTo( x, isLumiBars ? channelBottom : analyzerBottom - barHeight );
						ctx.stroke();
					}
					else if ( ! isRadial ) {
						ctx.fillRect( posX, isLumiBars ? channelTop : analyzerBottom, adjWidth, isLumiBars ? channelBottom : -barHeight );
					}
					else if ( bar.posX >= 0 ) {
						radialPoly( posX, 0, adjWidth, barHeight );
					}
				}

				// Draw peak
				if ( bar.peak[ channel ] > 1 ) { // avoid half "negative" peaks on top channel (peak height is 2px)
					if ( this.showPeaks && ! isLumiBars ) {
						if ( isLedDisplay ) {
							// convert the bar height to the position of the corresponding led element
							const fullLeds = bar.peak[ channel ] / ( analyzerHeight + ledSpaceV ) * ledCount | 0,
								  posY     = ( ledCount - fullLeds - 1 ) * ( ledHeight + ledSpaceV );

							ctx.fillRect( posX,	channelTop + posY, width, ledHeight );
						}
						else if ( ! isRadial ) {
							ctx.fillRect( posX, analyzerBottom - bar.peak[ channel ], adjWidth, 2 );
						}
						else if ( mode !== 10 && bar.posX >= 0 ) { // radial - no peaks for mode 10 or wrap-around frequencies
							radialPoly( posX, bar.peak[ channel ] * ( channel === 1 ? -1 : 1 ), adjWidth, -2 );
						}
					}

					if ( bar.hold[ channel ] )
						bar.hold[ channel ]--;
					else {
						bar.accel[ channel ]++;
						bar.peak[ channel ] -= bar.accel[ channel ];
					}
				}
			} // for ( let i = 0; i < nBars; i++ )

			// restore global alpha
			ctx.globalAlpha = 1;

			// Fill/stroke drawing path for mode 10 and radial
			if ( mode === 10 ) {
				if ( isRadial )
					ctx.closePath();
				else
					ctx.lineTo( canvas.width + this.lineWidth, analyzerBottom );

				if ( this.lineWidth > 0 ) {
					ctx.lineWidth = this.lineWidth;
					ctx.stroke();
				}

				if ( this.fillAlpha > 0 ) {
					if ( isRadial ) {
						// exclude the center circle from the fill area
						ctx.moveTo( centerX + radius, centerY );
						ctx.arc( centerX, centerY, radius, 0, TAU, true );
					}
					ctx.globalAlpha = this.fillAlpha;
					ctx.fill();
					ctx.globalAlpha = 1;
				}
			}
			else if ( isRadial ) {
				ctx.fill();
			}

			// Reflex effect
			if ( this._reflexRatio > 0 && ! isLumiBars ) {
				let posY, height;
				if ( this.reflexFit || isStereo ) { // always fit reflex in stereo mode
					posY   = isStereo && channel === 0 ? channelHeight + channelGap : 0;
					height = channelHeight - analyzerHeight;
				}
				else {
					posY   = canvas.height - analyzerHeight * 2;
					height = analyzerHeight;
				}

				// set alpha and brightness for the reflection
				ctx.globalAlpha = this.reflexAlpha;
				if ( this.reflexBright !== 1 )
					ctx.filter = `brightness(${this.reflexBright})`;

				// create the reflection
				ctx.setTransform( 1, 0, 0, -1, 0, canvas.height );
				ctx.drawImage( canvas, 0, channelTop, canvas.width, analyzerHeight, 0, posY, canvas.width, height );

				// reset changed properties
				ctx.setTransform( 1, 0, 0, 1, 0, 0 );
				ctx.filter = 'none';
				ctx.globalAlpha = 1;
			}

		} // for ( let channel = 0; channel < isStereo + 1; channel++ ) {

		// Update energy
		energy.val = currentEnergy / ( nBars << isStereo );
		if ( energy.val >= energy.peak ) {
			energy.peak = energy.val;
			energy.hold = 30;
		}
		else {
			if ( energy.hold > 0 )
				energy.hold--;
			else if ( energy.peak > 0 )
				energy.peak *= ( 30 + energy.hold-- ) / 30; // decay (drops to zero in 30 frames)
		}

		// restore solid lines
		ctx.setLineDash([]);

		// draw frequency scale (X-axis)
		if ( this.showScaleX ) {
			if ( isRadial ) {
				ctx.save();
				ctx.translate( centerX, centerY );
				if ( this._spinSpeed !== 0 )
					ctx.rotate( this._spinAngle + HALF_PI );
				ctx.drawImage( canvasR, -canvasR.width >> 1, -canvasR.width >> 1 );
				ctx.restore();
			}
			else
				ctx.drawImage( canvasX, 0, canvas.height - canvasX.height );
		}

		// calculate and update current frame rate

		this._frame++;
		const elapsed = timestamp - this._time;

		if ( elapsed >= 1000 ) {
			this._fps = this._frame / ( elapsed / 1000 );
			this._frame = 0;
			this._time = timestamp;
		}
		if ( this.showFPS ) {
			const size = canvasX.height;
			ctx.font = `bold ${size}px sans-serif`;
			ctx.fillStyle = '#0f0';
			ctx.textAlign = 'right';
			ctx.fillText( Math.round( this._fps ), canvas.width - size, size * 2 );
		}

		// call callback function, if defined
		if ( this.onCanvasDraw ) {
			ctx.save();
			ctx.fillStyle = ctx.strokeStyle = this._canvasGradient;
			this.onCanvasDraw( this );
			ctx.restore();
		}

		// schedule next canvas update
		this._runId = requestAnimationFrame( timestamp => this._draw( timestamp ) );
	}

	/**
	 * Generate currently selected gradient
	 */
	_makeGrad() {

		if ( ! this._ready )
			return;

		const ctx            = this._canvasCtx,
			  canvas         = ctx.canvas,
			  isLumiBars     = this._isLumiBars,
			  gradientHeight = isLumiBars ? canvas.height : canvas.height * ( 1 - this._reflexRatio * ! this._stereo ) | 0,
			  					// for stereo we keep the full canvas height and handle the reflex areas while generating the color stops
			  analyzerRatio  = 1 - this._reflexRatio;

		// for radial mode
		const centerX = canvas.width >> 1,
			  centerY = canvas.height >> 1,
			  radius  = this._radius;

		const currGradient = this._gradients[ this._gradient ],
			  colorStops   = currGradient.colorStops,
			  isHorizontal = currGradient.dir === 'h';

		let grad;

		if ( this._radial )
			grad = ctx.createRadialGradient( centerX, centerY, centerY, centerX, centerY, radius - ( centerY - radius ) * this._stereo );
		else
			grad = ctx.createLinearGradient( 0, 0, isHorizontal ? canvas.width : 0, isHorizontal ? 0 : gradientHeight );

		if ( colorStops ) {
			const dual = this._stereo && ! this._splitGradient && ! isHorizontal;

			// helper function
			const addColorStop = ( offset, colorInfo ) => grad.addColorStop( offset, colorInfo.color || colorInfo );

			for ( let channel = 0; channel < 1 + dual; channel++ ) {
				colorStops.forEach( ( colorInfo, index ) => {

					const maxIndex = colorStops.length - 1;

					let offset = colorInfo.pos !== undefined ? colorInfo.pos : index / maxIndex;

					// in dual mode (not split), use half the original offset for each channel
					if ( dual )
						offset /= 2;

					// constrain the offset within the useful analyzer areas (avoid reflex areas)
					if ( this._stereo && ! isLumiBars && ! this._radial && ! isHorizontal ) {
						offset *= analyzerRatio;
						// skip the first reflex area in split mode
						if ( ! dual && offset > .5 * analyzerRatio )
							offset += .5 * this._reflexRatio;
					}

					// only for split mode
					if ( channel === 1 ) {
						// add colors in reverse order if radial or lumi are active
						if ( this._radial || isLumiBars ) {
							const revIndex = maxIndex - index;
							colorInfo = colorStops[ revIndex ];
							offset = 1 - ( colorInfo.pos !== undefined ? colorInfo.pos : revIndex / maxIndex ) / 2;
						}
						else {
							// if the first offset is not 0, create an additional color stop to prevent bleeding from the first channel
							if ( index === 0 && offset > 0 )
								addColorStop( .5, colorInfo );
							// bump the offset to the second half of the gradient
							offset += .5;
						}
					}

					// add gradient color stop
					addColorStop( offset, colorInfo );

					// create additional color stop at the end of first channel to prevent bleeding
					if ( this._stereo && index === maxIndex && offset < .5 )
						addColorStop( .5, colorInfo );
				});
			}
		}

		this._canvasGradient = grad;
	}

	/**
	 * Generate the X-axis and radial scales in auxiliary canvases
	 */
	_createScales() {
		const freqLabels  = [ 16, 31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 ],
			  canvas      = this._canvasCtx.canvas,
			  scaleX      = this._scaleX,
			  scaleR      = this._scaleR,
			  canvasX     = scaleX.canvas,
			  canvasR     = scaleR.canvas,
			  scaleHeight = canvas.height * .03 | 0; // circular scale height (radial mode)

		// in radial stereo mode, the scale is positioned exactly between both channels, by making the canvas a bit larger than the central diameter
		canvasR.width = canvasR.height = ( this._radius << 1 ) + ( this._stereo * scaleHeight );

		const radius  = canvasR.width >> 1, // this is also used as the center X and Y coordinates of the circular scale canvas
			  radialY = radius - scaleHeight * .7;	// vertical position of text labels in the circular scale

		// clear scale canvas
		canvasX.width |= 0;

		scaleX.fillStyle = scaleR.strokeStyle = '#000c';
		scaleX.fillRect( 0, 0, canvasX.width, canvasX.height );

		scaleR.arc( radius, radius, radius - scaleHeight / 2, 0, TAU );
		scaleR.lineWidth = scaleHeight;
		scaleR.stroke();

		scaleX.fillStyle = scaleR.fillStyle = '#fff';
		scaleX.font = `${ canvasX.height >> 1 }px sans-serif`;
		scaleR.font = `${ scaleHeight >> 1 }px sans-serif`;
		scaleX.textAlign = scaleR.textAlign = 'center';

		for ( const freq of freqLabels ) {
			const label = ( freq >= 1000 ) ? `${ freq / 1000 }k` : freq,
				  x     = this._logWidth * ( Math.log10( freq ) - this._minLog );

			scaleX.fillText( label, x, canvasX.height * .75 );

			// avoid overlapping wrap-around labels in the circular scale
			if ( x > 0 && x < canvas.width ) {
				const angle  = TAU * ( x / canvas.width ),
					  adjAng = angle - HALF_PI, // rotate angles so 0 is at the top
					  posX   = radialY * Math.cos( adjAng ),
					  posY   = radialY * Math.sin( adjAng );

				scaleR.save();
				scaleR.translate( radius + posX, radius + posY );
				scaleR.rotate( angle );
				scaleR.fillText( label, 0, 0 );
				scaleR.restore();
			}
		}
	}

	/**
	 * Precalculate the actual X-coordinate on screen for each analyzer bar
	 *
	 * Since the frequency scale is logarithmic, each position in the X-axis actually represents a power of 10.
	 * To improve performace, the position of each frequency is calculated in advance and stored in an array.
	 * Canvas space usage is optimized to accommodate exactly the frequency range the user needs.
	 * Positions need to be recalculated whenever the frequency range, FFT size or canvas size change.
	 *
	 *                              +-------------------------- canvas --------------------------+
	 *                              |                                                            |
	 *    |-------------------|-----|-------------|-------------------!-------------------|------|------------|
	 *    1                  10     |            100                  1K                 10K     |           100K (Hz)
	 * (10^0)              (10^1)   |          (10^2)               (10^3)              (10^4)   |          (10^5)
	 *                              |-------------|<--- logWidth ---->|--------------------------|
	 *                  minFreq--> 20                   (pixels)                                22K <--maxFreq
	 *                          (10^1.3)                                                     (10^4.34)
	 *                           minLog
	 */
	_calcBars() {

		const bars = this._bars = []; // initialize object property

		if ( ! this._ready )
			return;

		// helper function
		const binToFreq = bin => bin * this.audioCtx.sampleRate / this._analyzer[0].fftSize;

		const canvas  = this._canvasCtx.canvas,
			  maxFreq = this._maxFreq,
			  minFreq = this._minFreq;

		let minLog,	logWidth;

		if ( ! this._isOctaveBands ) {
		// Discrete frequencies or area fill modes
			this._barWidth = 1;

			minLog = Math.log10( minFreq );
			logWidth = canvas.width / ( Math.log10( maxFreq ) - minLog );

			const minIndex = this._freqToBin( minFreq, 'floor' ),
				  maxIndex = this._freqToBin( maxFreq );

	 		let lastPos = -999;

			for ( let i = minIndex; i <= maxIndex; i++ ) {
				const freq = binToFreq( i ), // frequency represented by this index
					  pos  = Math.round( logWidth * ( Math.log10( freq ) - minLog ) ); // avoid fractionary pixel values

				// if it's on a different X-coordinate, create a new bar for this frequency
				if ( pos > lastPos ) {
					bars.push( { posX: pos, dataIdx: i, endIdx: 0, factor: 0, peak: [0,0], hold: [], accel: [] } );
					lastPos = pos;
				} // otherwise, add this frequency to the last bar's range
				else if ( bars.length )
					bars[ bars.length - 1 ].endIdx = i;
			}
		}
		else {
		// Octave bands modes

			// generate a table of frequencies based on the equal tempered scale

			const notesPerBand = [0,1,2,3,4,6,8,12,24][ this._mode ];

			let i = 0,
				freq,
				temperedScale = [];

			while ( ( freq = C0 * ROOT24 ** i ) <= maxFreq ) {
				if ( freq >= minFreq && i % notesPerBand === 0 )
					temperedScale.push( freq );
				i++;
			}

			minLog = Math.log10( temperedScale[0] );
			logWidth = canvas.width / ( Math.log10( temperedScale[ temperedScale.length - 1 ] ) - minLog );

			// divide canvas space by the number of frequencies (bars) to display
			this._barWidth = canvas.width / temperedScale.length;

			let prevBin = 0,  // last bin included in previous frequency band
				prevIdx = -1, // previous bar FFT array index
				nBars   = 0;  // count of bars with the same index

			temperedScale.forEach( ( freq, index ) => {
				// which FFT bin best represents this frequency?
				const bin = this._freqToBin( freq );

				let idx, nextBin;
				// start from the last used FFT bin
				if ( prevBin > 0 && prevBin + 1 <= bin )
					idx = prevBin + 1;
				else
					idx = bin;

				// FFT does not provide many coefficients for low frequencies, so several bars may end up using the same data
				if ( idx === prevIdx ) {
					nBars++;
				}
				else {
					// update previous bars using the same index with a interpolation factor
					if ( nBars > 1 ) {
						for ( let i = 0; i < nBars; i++ )
							bars[ bars.length - nBars + i ].factor = ( i + 1 ) / nBars;
					}
					prevIdx = idx;
					nBars = 1;
				}

				prevBin = nextBin = bin;
				// check if there's another band after this one
				if ( index < temperedScale.length - 1 ) {
					nextBin = this._freqToBin( temperedScale[ index + 1 ] );
					// and use half the bins in between for this band
					if ( nextBin - bin > 1 )
						prevBin += Math.round( ( nextBin - bin ) / 2 );
				}

				const endIdx = prevBin - idx > 0 ? prevBin : 0;

				bars.push( {
					posX: index * this._barWidth,
					dataIdx: idx,
					endIdx,
					factor: 0,
					peak: [0,0],
					hold: [],
					accel: []
				} );

			} );
		}

		// save these for scale generation
		this._minLog = minLog;
		this._logWidth = logWidth;

		// update internal variables
		this._calcAux();

		// generate the X-axis and radial scales
		this._createScales();

		// update LED properties
		this._calcLeds();
	}

	/**
	 * Return the FFT data bin (array index) which represents a given frequency
	 */
	_freqToBin( freq, rounding = 'round' ) {
		const max = this._analyzer[0].frequencyBinCount - 1,
			  bin = Math[ rounding ]( freq * this._analyzer[0].fftSize / this.audioCtx.sampleRate );

		return bin < max ? bin : max;
	}

	/**
	 * Internal function to change canvas dimensions on demand
	 */
	_setCanvas( reason ) {
		// if initialization is not finished, quit
		if ( ! this._ready )
			return;

		const ctx    = this._canvasCtx,
			  canvas = ctx.canvas;

		this._pixelRatio = window.devicePixelRatio; // for Retina / HiDPI devices

		if ( this._loRes )
			this._pixelRatio /= 2;

		this._fsWidth = Math.max( window.screen.width, window.screen.height ) * this._pixelRatio;
		this._fsHeight = Math.min( window.screen.height, window.screen.width ) * this._pixelRatio;

		const isFullscreen = this.isFullscreen,
			  newWidth  = isFullscreen ? this._fsWidth  : ( this._width  || this._container.clientWidth  || this._defaultWidth )  * this._pixelRatio | 0,
			  newHeight = isFullscreen ? this._fsHeight : ( this._height || this._container.clientHeight || this._defaultHeight ) * this._pixelRatio | 0;

		// if canvas dimensions haven't changed, quit
		if ( canvas.width === newWidth && canvas.height === newHeight )
			return;

		// apply new dimensions
		canvas.width  = newWidth;
		canvas.height = newHeight;

		// update internal variables
		this._calcAux();

		// if not in overlay mode, paint the canvas black
		if ( ! this.overlay ) {
			ctx.fillStyle = '#000';
			ctx.fillRect( 0, 0, canvas.width, canvas.height );
		}

		// set lineJoin property for area fill mode (this is reset whenever the canvas size changes)
		ctx.lineJoin = 'bevel';

		// update dimensions of the scale canvas
		const canvasX = this._scaleX.canvas;
		canvasX.width = canvas.width;
		canvasX.height = Math.max( 20 * this._pixelRatio, canvas.height / 27 | 0 );

		// (re)generate gradient
		this._makeGrad();

		// calculate bar positions and led options
		this._calcBars();

		// detect fullscreen changes (for Safari)
		if ( this._fsStatus !== undefined && this._fsStatus !== isFullscreen )
			reason = 'fschange';
		this._fsStatus = isFullscreen;

		// call the callback function, if defined
		if ( this.onCanvasResize )
			this.onCanvasResize( reason, this );
	}

	/**
	 * Set object properties
	 */
	_setProps( options, useDefaults ) {

		// settings defaults
		const defaults = {
			mode         : 0,
			fftSize      : 8192,
			minFreq      : 20,
			maxFreq      : 22000,
			smoothing    : 0.5,
			gradient     : 'classic',
			minDecibels  : -85,
			maxDecibels  : -25,
			showBgColor  : true,
			showLeds     : false,
			showScaleX   : true,
			showScaleY   : false,
			showPeaks    : true,
			showFPS      : false,
			lumiBars     : false,
			loRes        : false,
			reflexRatio  : 0,
			reflexAlpha  : 0.15,
			reflexBright : 1,
			reflexFit    : true,
			lineWidth    : 0,
			fillAlpha    : 1,
			barSpace     : 0.1,
			overlay      : false,
			bgAlpha      : 0.7,
			radial		 : false,
			spinSpeed    : 0,
			stereo       : false,
			splitGradient: false,
			start        : true,
			volume       : 1
		};

		// callback functions properties
		const callbacks = [ 'onCanvasDraw', 'onCanvasResize' ];

		// compile valid properties; `start` is not an actual property and is handled after setting everything else
		const validProps = Object.keys( defaults ).concat( callbacks, ['height', 'width'] ).filter( e => e !== 'start' );

		if ( useDefaults || options === undefined )
			options = Object.assign( defaults, options ); // NOTE: defaults is modified!

		for ( const prop of Object.keys( options ) ) {
			if ( callbacks.includes( prop ) && typeof options[ prop ] !== 'function' ) // check invalid callback
				this[ prop ] = undefined;
			else if ( validProps.includes( prop ) ) // set only valid properties
				this[ prop ] = options[ prop ];
		}

		if ( options.start !== undefined )
			this.toggleAnalyzer( options.start );
	}

  render() {
    return <div id="app"></div>;

  }
}

/* Custom error class */

class AudioMotionError extends Error {
	constructor( code, message ) {
		super( message );
		this.name = 'AudioMotionError';
		this.code = code;
	}
}
