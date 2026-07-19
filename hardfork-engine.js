export const HardForkEngine = (function() {
    let ctx = null;
    let masterGain = null;
    let globalVolume = 0.6;
    let effectDepth = 1.0;

    // Constants
    const ALPHABET = "abcdefghijklmnopqrstuvwxyzåäö";
    const BPM = 125;
    const SIXTEENTH_DUR = 60 / BPM / 4;
    const LOOKAHEAD = 0.12;

    // Scale
    const scale = [0, 3, 5, 7, 10]; // Minor pentatonic

    // Audio nodes
    let synthBus, dryGain, sendGain;
    let compressor, waveshaper;
    let delayL, delayR, delayFB_L, delayFB_R, delayPanL, delayPanR;
    let masterFilter;
    let noiseBuffer = null;

    // State
    let traces = [];
    let activeAckordDegrees = [];
    let isTyping = false;
    let typeHeat = 0;
    let lastKeyTime = 0;
    let heatInterval = null;

    // Sequencer State
    let schedulerInterval = null;
    let nextNoteTime = 0;
    let step16 = 0;
    let barNumber = 0;
    let currentChordOffset = 0;
    let currentKeyShift = 0;
    let isOutro = false;

    // Melody State
    let lastCharIndex = 0;
    let currentMelDegree = 4;
    let melodyBuffer = []; // Last 8 notes for fills
    let currentSentenceLen = 0;
    let fillScheduledForNextBar = false;
    let fillGain = 0;
    let isFillBar = false;

    // PRNG
    let prngState = 0;
    function mulberry32(a) {
        return function() {
            var t = a += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
    }
    let prng = Math.random;

    function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
    function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
    function degreeToMidi(degree, root) {
        const octave = Math.floor(degree / scale.length);
        const pitchClass = scale[((degree % scale.length) + scale.length) % scale.length];
        return root + pitchClass + (octave * 12);
    }

    function getStats() {
        if (window.TextContext && typeof window.TextContext.getStats === 'function') {
            return window.TextContext.getStats();
        }
        return { paragraphs: 0, vowelRatio: 0.38 };
    }

    function createNoiseBuffer() {
        if (noiseBuffer) return;
        const size = ctx.sampleRate * 1.0; // 1s
        noiseBuffer = ctx.createBuffer(1, size, ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < size; i++) {
            output[i] = Math.random() * 2 - 1;
        }
    }

    function makeDistortionCurve(amount) {
        let k = amount,
            n_samples = 44100,
            curve = new Float32Array(n_samples),
            deg = Math.PI / 180,
            i = 0,
            x;
        for ( ; i < n_samples; ++i ) {
            x = i * 2 / n_samples - 1;
            curve[i] = ( 3 + k ) * x * 20 * deg / ( Math.PI + k * Math.abs(x) );
        }
        return curve;
    }

    function init(audioContext) {
        if (!audioContext) return;
        ctx = audioContext;

        createNoiseBuffer();

        masterGain = ctx.createGain();
        masterGain.gain.value = globalVolume;

        // Master chain: synthBus -> softclip -> compressor -> masterGain
        synthBus = ctx.createGain();
        synthBus.gain.value = 1.0;
        
        masterFilter = ctx.createBiquadFilter();
        masterFilter.type = 'lowpass';
        masterFilter.frequency.value = 18000;

        waveshaper = ctx.createWaveShaper();
        waveshaper.curve = makeDistortionCurve(10); // tanh-like soft clip
        waveshaper.oversample = '2x';

        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 12;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.01;
        compressor.release.value = 0.15;

        synthBus.connect(masterFilter);
        masterFilter.connect(waveshaper);
        waveshaper.connect(compressor);

        // Dry and Send
        dryGain = ctx.createGain();
        dryGain.gain.value = 1.0;
        sendGain = ctx.createGain();
        sendGain.gain.value = 0.4; // Default depth

        compressor.connect(dryGain);
        compressor.connect(sendGain);
        dryGain.connect(masterGain);

        // Ping-pong delay
        delayL = ctx.createDelay(); delayL.delayTime.value = SIXTEENTH_DUR * 3;
        delayR = ctx.createDelay(); delayR.delayTime.value = SIXTEENTH_DUR * 4;
        
        delayFB_L = ctx.createGain(); delayFB_L.gain.value = 0.25;
        delayFB_R = ctx.createGain(); delayFB_R.gain.value = 0.25;
        
        delayPanL = ctx.createStereoPanner(); delayPanL.pan.value = -0.8;
        delayPanR = ctx.createStereoPanner(); delayPanR.pan.value = 0.8;
        
        const delayFilterL = ctx.createBiquadFilter(); delayFilterL.type = 'lowpass'; delayFilterL.frequency.value = 3000;
        const delayFilterR = ctx.createBiquadFilter(); delayFilterR.type = 'lowpass'; delayFilterR.frequency.value = 3000;

        // Routing
        sendGain.connect(delayL);
        delayL.connect(delayFilterL);
        delayFilterL.connect(delayPanL);
        delayPanL.connect(masterGain);
        delayFilterL.connect(delayFB_R); // cross L to R

        sendGain.connect(delayR);
        delayR.connect(delayFilterR);
        delayFilterR.connect(delayPanR);
        delayPanR.connect(masterGain);
        delayFilterR.connect(delayFB_L); // cross R to L

        delayFB_R.connect(delayR);
        delayFB_L.connect(delayL);

        masterGain.connect(ctx.destination);
        ctx.synthBus = synthBus;

        heatInterval = setInterval(() => {
            if (typeHeat > 0) {
                typeHeat = Math.max(0, typeHeat - 0.05);
            }
            if (ctx && ctx.currentTime - lastKeyTime > 2.0) {
                if (isTyping) {
                    isTyping = false;
                    isOutro = true; // Trigger outro bar
                }
            }
        }, 100);

        schedulerInterval = setInterval(schedule, 25);
        document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    function setVolume(val) {
        globalVolume = val;
        if (masterGain) masterGain.gain.setTargetAtTime(val, ctx.currentTime, 0.1);
    }

    function setDepth(val) {
        effectDepth = val;
        if (sendGain) sendGain.gain.setTargetAtTime(0.2 + (0.4 * val), ctx.currentTime, 0.1);
    }

    function handleVisibilityChange() {
        if (document.hidden) {
            isTyping = false;
        } else {
            // Wake up if needed? We wait for keypress to wake up fully.
            nextNoteTime = ctx ? ctx.currentTime + 0.05 : 0;
        }
    }

    function destroy() {
        if (heatInterval) clearInterval(heatInterval);
        if (schedulerInterval) clearInterval(schedulerInterval);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        if (masterGain) {
            const oldGain = masterGain;
            oldGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
            setTimeout(() => {
                try { oldGain.disconnect(); } catch(e) {}
            }, 200);
            masterGain = null;
        }
        ctx = null;
    }

    // --- Audio Playback ---

    function duckSidechain(time) {
        synthBus.gain.setValueAtTime(synthBus.gain.value, time);
        synthBus.gain.exponentialRampToValueAtTime(0.4, time + 0.02);
        synthBus.gain.linearRampToValueAtTime(1.0, time + 0.38);
    }

    function playKick(time) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, time);
        osc.frequency.exponentialRampToValueAtTime(30, time + 0.1);
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.4, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
        osc.connect(gain);
        gain.connect(compressor); // Bypass synthbus ducking
        osc.start(time);
        osc.stop(time + 0.3);
        osc.onended = () => { gain.disconnect(); };
        duckSidechain(time);
    }

    function playBass(time, isOctave = false, duration = 0.28) {
        const osc1 = ctx.createOscillator(); osc1.type = 'sine';
        const osc2 = ctx.createOscillator(); osc2.type = 'triangle';
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 600;
        const gain = ctx.createGain();
        
        let root = 48 + currentKeyShift + currentChordOffset - 12;
        if (isOctave) root += 12;
        const freq = midiToFreq(root);
        
        osc1.frequency.setValueAtTime(freq, time);
        osc2.frequency.setValueAtTime(freq * 2, time); // Triangle octave up
        
        const osc2Gain = ctx.createGain(); osc2Gain.gain.value = 0.4;
        osc2.connect(osc2Gain);
        
        osc1.connect(filter);
        osc2Gain.connect(filter);
        filter.connect(gain);
        gain.connect(synthBus);
        
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.3, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
        
        osc1.start(time); osc2.start(time);
        osc1.stop(time + duration + 0.1); osc2.stop(time + duration + 0.1);
        osc1.onended = () => {
            try { filter.disconnect(); gain.disconnect(); osc2Gain.disconnect(); } catch(e){}
        };
    }

    function playHat(time, pan = 0, isOpen = false) {
        const source = ctx.createBufferSource();
        source.buffer = noiseBuffer;
        
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 5000;
        
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.05, time + 0.01);
        const dur = isOpen ? 0.2 : 0.05;
        gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
        
        const panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        
        source.connect(filter);
        filter.connect(gain);
        gain.connect(panner);
        panner.connect(synthBus);
        
        source.start(time);
        source.stop(time + dur + 0.1);
        source.onended = () => { try { filter.disconnect(); gain.disconnect(); panner.disconnect(); } catch(e){} };
    }

    function playSnare(time) {
        // Noise part
        const noise = ctx.createBufferSource(); noise.buffer = noiseBuffer;
        const noiseFilter = ctx.createBiquadFilter(); noiseFilter.type = 'bandpass'; noiseFilter.frequency.value = 2000;
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0, time);
        noiseGain.gain.linearRampToValueAtTime(0.15, time + 0.01);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
        noise.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(synthBus);
        
        // Body part
        const osc = ctx.createOscillator(); osc.type = 'triangle';
        osc.frequency.setValueAtTime(200, time); osc.frequency.exponentialRampToValueAtTime(100, time + 0.1);
        const oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(0, time);
        oscGain.gain.linearRampToValueAtTime(0.2, time + 0.005);
        oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
        osc.connect(oscGain); oscGain.connect(synthBus);
        
        noise.start(time); osc.start(time);
        noise.stop(time + 0.25); osc.stop(time + 0.15);
        noise.onended = () => { try { noiseFilter.disconnect(); noiseGain.disconnect(); oscGain.disconnect(); } catch(e){} };
    }

    function playCrash(time) {
        const noise = ctx.createBufferSource(); noise.buffer = noiseBuffer;
        const filter = ctx.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 6000;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.2, time + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.8);
        noise.connect(filter); filter.connect(gain); gain.connect(synthBus);
        noise.start(time); noise.stop(time + 1.0);
        noise.onended = () => { try { filter.disconnect(); gain.disconnect(); } catch(e){} };
    }

    function playGlitch(time) {
        const osc = ctx.createOscillator(); osc.type = 'sawtooth';
        const gain = ctx.createGain();
        osc.frequency.setValueAtTime(800, time);
        osc.frequency.setValueAtTime(1200, time + 0.05);
        osc.frequency.setValueAtTime(400, time + 0.1);
        osc.frequency.setValueAtTime(2000, time + 0.15);
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.1, time + 0.01);
        gain.gain.setValueAtTime(0.1, time + 0.18);
        gain.gain.linearRampToValueAtTime(0, time + 0.2);
        osc.connect(gain); gain.connect(synthBus);
        osc.start(time); osc.stop(time + 0.25);
        osc.onended = () => { try { gain.disconnect(); } catch(e){} };
    }

    function playPluck(time, degree, velocity, duration = 0.3, volMod = 1.0) {
        const osc = ctx.createOscillator(); osc.type = 'sawtooth';
        const osc2 = ctx.createOscillator(); osc2.type = 'sawtooth';
        
        osc.detune.value = -7;
        osc2.detune.value = 7;
        
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass';
        const filterMax = 1000 + (3000 * Math.min(1, typeHeat));
        filter.frequency.setValueAtTime(400, time);
        filter.frequency.exponentialRampToValueAtTime(filterMax * effectDepth, time + 0.05);
        filter.frequency.exponentialRampToValueAtTime(400, time + duration);
        
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.1 * velocity * volMod, time + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, time + duration - 0.05);
        
        const freq = midiToFreq(degreeToMidi(degree, 48 + currentKeyShift));
        osc.frequency.setValueAtTime(freq, time);
        osc2.frequency.setValueAtTime(freq, time);
        
        const oscGain = ctx.createGain(); oscGain.gain.value = 0.35;
        const osc2Gain = ctx.createGain(); osc2Gain.gain.value = 0.35 * Math.min(1, typeHeat);
        
        osc.connect(oscGain); osc2.connect(osc2Gain);
        oscGain.connect(filter); osc2Gain.connect(filter);
        filter.connect(gain); gain.connect(synthBus);
        
        osc.start(time); osc2.start(time);
        osc.stop(time + duration); osc2.stop(time + duration);
        osc.onended = () => { try { filter.disconnect(); gain.disconnect(); oscGain.disconnect(); osc2Gain.disconnect(); } catch(e){} };
    }

    // --- Sequencer ---

    function scheduleStep(step, time) {
        if (!ctx) return;
        
        // Update PRNG seed at bar start
        if (step === 0) {
            const stats = getStats();
            prng = mulberry32(stats.paragraphs * 1000 + barNumber);
            
            // Chord progression
            const prog = (stats.vowelRatio > 0.42) ? [0, -2, -4, -5] : [0, -4, 3, -2];
            currentChordOffset = prog[barNumber % 4];
            
            // Sync delay feedback with heat
            if (delayFB_L && delayFB_R) {
                const fb = 0.25 + (typeHeat * 0.20);
                delayFB_L.gain.setTargetAtTime(fb, time, 0.5);
                delayFB_R.gain.setTargetAtTime(fb, time, 0.5);
            }
            
            if (isFillBar) {
                // If it's a fill bar, layers thin out
            }
        }
        
        // Outro mode thins out layers and stops clock at end of bar
        if (isOutro && step === 15) {
            isOutro = false;
            // Next schedule tick won't do anything because isTyping is false
        }
        
        const effectiveHeat = (isOutro || isFillBar) ? Math.max(0, typeHeat - 0.5) : typeHeat;
        
        // Layer 0: Bass
        if (step === 0 || step === 3 || step === 8 || step === 11) {
            playBass(time, false);
            if (effectiveHeat > 0.95 && (step === 3 || step === 11)) playBass(time, true);
        }
        
        // Layer 1: Kick
        if (effectiveHeat > 0.25 && (step === 0 || step === 4 || step === 8 || step === 12)) {
            playKick(time);
        }
        
        // Layer 2: Hats
        if (effectiveHeat > 0.5 && (step === 2 || step === 6 || step === 10 || step === 14)) {
            const isOpen = (effectiveHeat > 0.95 && step === 14);
            const pan = step % 4 === 2 ? -0.3 : 0.3;
            playHat(time, pan, isOpen);
        }
        
        // Layer 3: Snare & extra hats
        if (effectiveHeat > 0.75) {
            if (step === 4 || step === 12) playSnare(time);
            if (step % 2 !== 0 && prng() < 0.4 && step !== 14) {
                playHat(time, 0, false);
            }
        }
        
        // Fill logic
        if (isFillBar) {
            // Arp up
            if (step < 8 && step % 2 === 0) {
                const note = melodyBuffer[step/2 % melodyBuffer.length] || 4;
                playPluck(time, note + 7, fillGain, 0.2); // high octave arp
            }
            if (step === 0) playCrash(time); // Or next bar step 0
        }
        
        // Visuals (beat pulse)
        if (step === 0 && window.VisualsEngine) window.VisualsEngine.spawnHardForkBlock('space', 0);
    }

    function schedule() {
        if (!isTyping && !isOutro) return; // Paused
        if (!ctx) return;
        
        // Resume context just in case
        if (ctx.state === 'suspended') ctx.resume();
        
        const now = ctx.currentTime;
        if (nextNoteTime < now) nextNoteTime = now + 0.05; // Catch up if fell behind
        
        while (nextNoteTime < now + LOOKAHEAD) {
            scheduleStep(step16, nextNoteTime);
            
            // Advance time
            const swingRatio = typeHeat < 0.5 ? 0.56 : 0.50;
            const isOdd = (step16 % 2 === 1);
            const stepDur = SIXTEENTH_DUR * 2 * (isOdd ? (1 - swingRatio) : swingRatio);
            
            nextNoteTime += stepDur;
            step16++;
            if (step16 >= 16) {
                step16 = 0;
                barNumber++;
                
                if (fillScheduledForNextBar) {
                    isFillBar = true;
                    fillScheduledForNextBar = false;
                } else if (isFillBar) {
                    isFillBar = false;
                }
                
                if (isOutro) {
                    isOutro = false; // Finished outro bar
                    isTyping = false; // Stop clock
                }
            }
        }
    }

    // --- Input Handling ---

    function handleChar(key, stats) {
        if (!ctx) init();
        if (ctx.state === 'suspended') ctx.resume();
        
        const lowKey = key.toLowerCase();
        
        if (!isTyping) {
            isTyping = true;
            isOutro = false;
            nextNoteTime = Math.ceil((ctx.currentTime + 0.02) / SIXTEENTH_DUR) * SIXTEENTH_DUR;
            step16 = 0; // Start at beginning of bar
            // Upbeat fill
            playBass(ctx.currentTime, false, 0.1);
        }
        
        lastKeyTime = ctx.currentTime;
        typeHeat = Math.min(1.2, typeHeat + 0.1);
        currentSentenceLen++;
        
        const now = ctx.currentTime;
        // Find next 16th boundary relative to the scheduler
        const quantTime = nextNoteTime; // Approximate
        
        if (key === '\n') {
            const s = getStats();
            const verseSteps = [0, -3, 2, -5, 4];
            currentKeyShift = verseSteps[s.paragraphs % verseSteps.length];
            
            // Filter sweep drop
            if (masterFilter) {
                masterFilter.frequency.cancelScheduledValues(now);
                masterFilter.frequency.setValueAtTime(18000, now);
                masterFilter.frequency.exponentialRampToValueAtTime(300, now + SIXTEENTH_DUR * 4);
                masterFilter.frequency.exponentialRampToValueAtTime(18000, now + SIXTEENTH_DUR * 16);
            }
        } else if (key === ' ') {
            addTrace(40, now);
            if (window.VisualsEngine) window.VisualsEngine.spawnHardForkBlock('space', 0);
        } else if (/[.,;:!?]/.test(key)) {
            playGlitch(quantTime + SIXTEENTH_DUR); // Next offbeat
            addTrace(90, now);
            if (window.VisualsEngine) window.VisualsEngine.spawnHardForkBlock('punct', 0);
            
            if (currentSentenceLen >= 2) {
                fillScheduledForNextBar = true;
                fillGain = clamp(currentSentenceLen / 120, 0.4, 1.0);
                if (onSentenceCallback) onSentenceCallback({ length: currentSentenceLen });
            }
            currentSentenceLen = 0;
            
        } else if (ALPHABET.includes(lowKey)) {
            const idx = ALPHABET.indexOf(lowKey);
            const diff = idx - lastCharIndex;
            lastCharIndex = idx;
            
            let steg = clamp(Math.round(diff / 5), -2, 2);
            if (steg === 0 && diff !== 0) steg = diff > 0 ? 1 : -1;
            
            currentMelDegree = clamp(currentMelDegree + steg, 0, 9);
            
            // Quantize melody to chord on strong beats (0, 4, 8, 12)
            if (step16 % 4 === 0) {
                // Chord tones in pentatonic relative to root are 0, 1, 3 (root, minor 3rd, 5th)
                const relativeChordRoot = scale.indexOf((currentChordOffset + 12)%12) !== -1 ? scale.indexOf((currentChordOffset + 12)%12) : 0;
                // Actually simpler: just find closest valid degree
                const validSteps = [0, 1, 3, 5, 6, 8].map(s => s + relativeChordRoot); 
                let closest = currentMelDegree;
                let minDist = 99;
                for (let v of validSteps) {
                    if (Math.abs(v - currentMelDegree) < minDist) {
                        minDist = Math.abs(v - currentMelDegree);
                        closest = v;
                    }
                }
                currentMelDegree = closest;
            }
            
            let octaveOffset = 0;
            if ((step16 === 6 || step16 === 14) && Math.random() < typeHeat * 0.5) octaveOffset = 12;
            
            playPluck(quantTime, currentMelDegree + octaveOffset/12*5, 1.0);
            
            // Arp echo
            if (typeHeat > 0.5) {
                playPluck(quantTime + SIXTEENTH_DUR, currentMelDegree + 1, 0.4, 0.15, 0.6); // Third up
            }
            
            melodyBuffer.push(currentMelDegree);
            if (melodyBuffer.length > 8) melodyBuffer.shift();
            
            addTrace(degreeToMidi(currentMelDegree, 48 + currentKeyShift + octaveOffset), now);
            activeAckordDegrees = [currentMelDegree]; 
            if (window.VisualsEngine) window.VisualsEngine.spawnHardForkBlock('letter', currentMelDegree);
        }
    }

    function handleKey(e) {
        if (e && e.key) handleChar(e.key);
    }

    function addTrace(midiNum, time) {
        traces.push({ m: midiNum, born: time * 1000 });
        if (traces.length > 50) traces.shift();
    }

    function getState() {
        return { traces: traces, activeAckordDegrees: activeAckordDegrees };
    }

    let onSentenceCallback = null;
    function onSentence(cb) { onSentenceCallback = cb; }

    return { init, setVolume, setDepth, destroy, handleKey, handleChar, getState, onSentence };
})();
