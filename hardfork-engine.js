export const HardForkEngine = (function() {
    let ctx = null;
    let masterGain = null;
    let globalVolume = 0.6;
    let effectDepth = 1.0;
    
    // Scale: Pentatonic Minor (very safe, harmonic, synthwave/matrix vibe)
    const scale = [0, 3, 5, 7, 10]; // Intervals from root
    const rootMidi = 48; // C3
    
    // Constants
    const ALPHABET = "abcdefghijklmnopqrstuvwxyzåäö";
    const BPM = 125;
    const SIXTEENTH_DUR = 60 / BPM / 4;
    
    // State
    let traces = [];
    let activeAckordDegrees = [];
    
    // Generative Beat State
    let typeHeat = 0; // Increases when typing, decays over time
    let lastKeyTime = 0;
    let sequencePattern = [0, 2, 4, 1, 3, 0, 2, 4]; // Evolving sequence
    let seqIndex = 0;
    let isTyping = false;
    let heatInterval = null;
    
    function midiToFreq(m) {
        return 440 * Math.pow(2, (m - 69) / 12);
    }
    
    function degreeToMidi(degree, root) {
        const octave = Math.floor(degree / scale.length);
        const pitchClass = scale[degree % scale.length];
        return root + pitchClass + (octave * 12);
    }

    function init(audioContext) {
        if (!audioContext) return;
        ctx = audioContext;
        
        masterGain = ctx.createGain();
        masterGain.gain.value = globalVolume;
        
        // Add a slight delay/echo effect for that synthwave feel
        const delay = ctx.createDelay();
        delay.delayTime.value = SIXTEENTH_DUR * 3; // Dotted eighth delay
        const delayFeedback = ctx.createGain();
        delayFeedback.gain.value = 0.3;
        
        const delayFilter = ctx.createBiquadFilter();
        delayFilter.type = 'lowpass';
        delayFilter.frequency.value = 2000;
        
        delay.connect(delayFeedback);
        delayFeedback.connect(delayFilter);
        delayFilter.connect(delay);
        delay.connect(masterGain);
        
        // Also connect a dry path
        const dryGain = ctx.createGain();
        dryGain.gain.value = 1.0;
        dryGain.connect(masterGain);
        
        // And send to delay
        const sendGain = ctx.createGain();
        sendGain.gain.value = 0.4;
        sendGain.connect(delay);

        // We will route our synths to a bus that goes to both dry and send
        const synthBus = ctx.createGain();
        synthBus.connect(dryGain);
        synthBus.connect(sendGain);
        
        masterGain.connect(ctx.destination);
        
        // Save bus
        ctx.synthBus = synthBus;
        
        // Heat decay loop
        heatInterval = setInterval(() => {
            if (typeHeat > 0) {
                typeHeat = Math.max(0, typeHeat - 0.05); // Decay heat
            }
            if (ctx && ctx.currentTime - lastKeyTime > 2.0) {
                isTyping = false; // Stop beat if idle for 2 seconds
            }
        }, 100);
    }

    function setVolume(val) {
        globalVolume = val;
        if (masterGain) masterGain.gain.setTargetAtTime(val, ctx.currentTime, 0.1);
    }

    function setDepth(val) {
        effectDepth = val;
    }

    function destroy() {
        if (heatInterval) clearInterval(heatInterval);
        if (masterGain) {
            masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
            setTimeout(() => {
                masterGain.disconnect();
                masterGain = null;
            }, 200);
        }
    }
    
    // --- Synths ---
    
    function playPluck(time, degree, velocity, duration = 0.3) {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        
        // Detuned saw for fatness, mix based on heat
        const osc2 = ctx.createOscillator();
        osc2.type = 'sawtooth';
        osc2.detune.value = 15;
        
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        // Filter opens up more when typing faster (higher heat)
        const filterMax = 1000 + (3000 * Math.min(1, typeHeat));
        filter.frequency.setValueAtTime(400, time);
        filter.frequency.exponentialRampToValueAtTime(filterMax * effectDepth, time + 0.05);
        filter.frequency.exponentialRampToValueAtTime(400, time + duration);
        
        const gain = ctx.createGain();
        // Amplitude envelope
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.1 * velocity, time + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, time + duration - 0.05);
        
        // Add random octave jumping based on heat to create variation
        let octaveOffset = 12; // Default octave 4
        if (typeHeat > 0.6 && Math.random() > 0.7) octaveOffset = 24; // Jump up
        if (typeHeat > 0.8 && Math.random() > 0.8) octaveOffset = 0;  // Jump down
        
        const freq = midiToFreq(degreeToMidi(degree, rootMidi + octaveOffset));
        osc.frequency.setValueAtTime(freq, time);
        osc2.frequency.setValueAtTime(freq, time);
        
        osc.connect(filter);
        
        // Osc2 volume depends on heat
        const osc2Gain = ctx.createGain();
        osc2Gain.gain.value = 0.5 * Math.min(1, typeHeat);
        osc2.connect(osc2Gain);
        osc2Gain.connect(filter);
        
        filter.connect(gain);
        gain.connect(ctx.synthBus);
        
        osc.start(time);
        osc2.start(time);
        osc.stop(time + duration);
        osc2.stop(time + duration);
    }
    
    function playKick(time) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.type = 'sine';
        // Pitch drop for punchy kick
        osc.frequency.setValueAtTime(150, time);
        osc.frequency.exponentialRampToValueAtTime(30, time + 0.1);
        
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.3, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
        
        osc.connect(gain);
        gain.connect(ctx.synthBus);
        
        osc.start(time);
        osc.stop(time + 0.3);
    }
    
    function playHat(time) {
        // Simple white noise hi-hat for rhythm texture
        const bufferSize = ctx.sampleRate * 0.1; // 100ms
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 5000;
        
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.05, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
        
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.synthBus);
        
        noise.start(time);
        noise.stop(time + 0.1);
    }
    
    function playGlitch(time) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.type = 'sawtooth';
        // Fast random-ish pitch jumps
        osc.frequency.setValueAtTime(800, time);
        osc.frequency.setValueAtTime(1200, time + 0.05);
        osc.frequency.setValueAtTime(400, time + 0.1);
        osc.frequency.setValueAtTime(2000, time + 0.15);
        
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.1, time + 0.01);
        gain.gain.setValueAtTime(0.1, time + 0.18);
        gain.gain.linearRampToValueAtTime(0, time + 0.2);
        
        osc.connect(gain);
        gain.connect(ctx.synthBus);
        
        osc.start(time);
        osc.stop(time + 0.2);
    }

    function handleKey(key, stats) {
        if (!ctx) return;
        const lowKey = key.toLowerCase();
        const now = ctx.currentTime;
        
        lastKeyTime = now;
        isTyping = true;
        typeHeat = Math.min(1.2, typeHeat + 0.1); // Add heat
        
        // Quantize logic: snap to next 16th note boundary
        const nextBeat = Math.ceil((now + 0.02) / SIXTEENTH_DUR) * SIXTEENTH_DUR;
        
        // Evolve sequence pattern based on heat/speed
        if (typeHeat > 0.8 && Math.random() > 0.5) {
            // Permute pattern slightly
            const i1 = Math.floor(Math.random() * sequencePattern.length);
            const i2 = Math.floor(Math.random() * sequencePattern.length);
            const temp = sequencePattern[i1];
            sequencePattern[i1] = sequencePattern[i2];
            sequencePattern[i2] = temp;
        }
        
        if (key === ' ') {
            playKick(nextBeat);
            // Add a delayed hat for groove if heat is high
            if (typeHeat > 0.4) playHat(nextBeat + SIXTEENTH_DUR * 2);
            addTrace(40, nextBeat);
        } else if (/[.,;:!?]/.test(key)) {
            playGlitch(nextBeat);
            addTrace(90, nextBeat);
        } else if (ALPHABET.includes(lowKey)) {
            const idx = ALPHABET.indexOf(lowKey);
            
            // Generative beat: combine user key with sequence pattern
            seqIndex = (seqIndex + 1) % sequencePattern.length;
            const seqDegree = sequencePattern[seqIndex];
            
            // Map index to scale degree, add sequence offset for variation
            const degree = (idx % scale.length) + seqDegree; 
            
            // Play main pluck
            playPluck(nextBeat, degree, 1.0);
            
            // Generative echo/arpeggio note if typing fast (heat > 0.5)
            if (typeHeat > 0.5) {
                // Play a harmonizing note a 16th note later
                const arpDegree = (degree + 2) % (scale.length * 2); // Third up
                playPluck(nextBeat + SIXTEENTH_DUR, arpDegree, 0.4, 0.15);
            }
            
            addTrace(degreeToMidi(degree, rootMidi + 12), nextBeat);
            
            // Visuals state
            activeAckordDegrees = [degree]; 
        }
    }

    function addTrace(midiNum, time) {
        traces.push({
            m: midiNum,
            born: time * 1000 // To milliseconds for visuals
        });
        if (traces.length > 50) traces.shift();
    }

    function getState() {
        return {
            traces: traces,
            activeAckordDegrees: activeAckordDegrees
        };
    }
    
    // Required callbacks (even if not fully used yet)
    let onSentenceCallback = null;
    function onSentence(cb) {
        onSentenceCallback = cb;
    }

    return {
        init,
        setVolume,
        setDepth,
        destroy,
        handleKey,
        getState,
        onSentence
    };
})();
