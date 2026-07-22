export const SpaceOdysseyEngine = (function() {
    let ctx = null;
    let masterGain = null;
    let globalVolume = 0.6;
    let effectDepth = 1.0;

    // Constants
    const ALPHABET = "abcdefghijklmnopqrstuvwxyzåäö";
    const BPM = 68;
    const SIXTEENTH_DUR = 60 / BPM / 4;
    const LOOKAHEAD = 0.12;

    // Scale
    let scale = [0, 2, 4, 7, 9]; // Dur-pentatonik
    let padScale = [0, 2, 4, 6, 7, 9, 11]; // Lydisk för pads

    // Audio nodes
    let synthBus, dryGain, sendGain;
    let compressor, waveshaper;
    let delayL, delayR, delayFB_L, delayFB_R, delayPanL, delayPanR;
    let masterFilter;
    let convolver, reverbGain;
    let noiseBuffer = null;

    // State
    let traces = [];
    let activeAckordDegrees = [];
    let isTyping = false;
    let typeHeat = 0;
    let lastKeyTime = 0;
    let heatInterval = null;
    let smoothedVowelRatio = 0.38;

    // Sequencer State
    let schedulerInterval = null;
    let nextNoteTime = 0;
    let step16 = 0;
    let barNumber = 0;
    let currentChordOffset = 0;
    let currentKeyShift = 0;
    let isOutro = false;

    // Melody State
    let lastCharIndex = -1; // A1
    let currentMelDegree = 4;
    let melodyBuffer = []; // Last 8 notes for fills
    let currentSentenceLen = 0;
    let fillScheduledForNextBar = false;
    let fillGain = 0;
    let isFillBar = false;

    // Punctuation as Production (Part B)
    let pendingFillVariant = 'normal';   // 'normal' | 'question' | 'exclaim'
    let activeFillVariant = 'normal';
    let delayBloomUntilBar = -1;
    let sweepUntilTime = 0;
    let lastGlitchTime = 0;

    // Sentence Memory (Part C)
    let lastHeadingCount = 0;
    let M = [0, 2, 4, 2, 0, 2, 4, 7].map(Number);
    let M_pending = null;
    let sentenceMelody = [];

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
        return { paragraphs: 0, vowelRatio: 0.38, g: 1.0, words: 0, headings: 0, N: 0, meanAlpha: 10 };
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

    
    // Persistent Pads
    let padOscs = [];
    let padGainNode = null;
    let padFilter = null;
    
    function initPads() {
        padGainNode = ctx.createGain();
        padGainNode.gain.value = 0;
        padFilter = ctx.createBiquadFilter();
        padFilter.type = 'lowpass';
        padFilter.frequency.value = 900;
        padFilter.Q.value = 0.6;
        padGainNode.connect(padFilter);
        padFilter.connect(synthBus);
        
        // Send to convolver (0.3)
        const padRevSend = ctx.createGain();
        padRevSend.gain.value = 0.3;
        padFilter.connect(padRevSend);
        padRevSend.connect(convolver);
        
        for (let i = 0; i < 4; i++) {
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.start();
            osc.connect(padGainNode);
            padOscs.push(osc);
        }
    }

    function makeDistortionCurve(amount) {
        let k = amount, n_samples = 44100, curve = new Float32Array(n_samples), deg = Math.PI / 180, i = 0, x;
        for ( ; i < n_samples; ++i ) {
            x = i * 2 / n_samples - 1;
            curve[i] = ( 3 + k ) * x * 20 * deg / ( Math.PI + k * Math.abs(x) );
        }
        return curve;
    }

    function init(audioContext) {
        ctx = audioContext || ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (!ctx) return;
        if (masterGain) return; // Already initialized

        createNoiseBuffer();

        masterGain = ctx.createGain();
        masterGain.gain.value = globalVolume;

        synthBus = ctx.createGain();
        synthBus.gain.value = 1.0;
        
        masterFilter = ctx.createBiquadFilter();
        masterFilter.type = 'lowpass';
        masterFilter.frequency.value = 18000;

        waveshaper = ctx.createWaveShaper();
        waveshaper.curve = makeDistortionCurve(10);
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

        
        // Convolver setup
        convolver = ctx.createConvolver();
        reverbGain = ctx.createGain();
        reverbGain.gain.value = 1.0;
        
        // Generate impulse response (7s, exp 3.0)
        const rate = ctx.sampleRate;
        const length = rate * 7;
        const impulse = ctx.createBuffer(2, length, rate);
        const impulseL = impulse.getChannelData(0);
        const impulseR = impulse.getChannelData(1);
        for (let i = 0; i < length; i++) {
            const decay = Math.pow(1 - i / length, 3.0);
            impulseL[i] = (Math.random() * 2 - 1) * decay;
            impulseR[i] = (Math.random() * 2 - 1) * decay;
        }
        convolver.buffer = impulse;
        convolver.connect(reverbGain);
        reverbGain.connect(masterGain);

        dryGain = ctx.createGain(); dryGain.gain.value = 1.0;
        sendGain = ctx.createGain(); sendGain.gain.value = 0.4;

        compressor.connect(dryGain);
        compressor.connect(sendGain);
        dryGain.connect(masterGain);

        delayL = ctx.createDelay(); delayL.delayTime.value = SIXTEENTH_DUR * 3;
        delayR = ctx.createDelay(); delayR.delayTime.value = SIXTEENTH_DUR * 4;
        delayFB_L = ctx.createGain(); delayFB_L.gain.value = 0.25;
        delayFB_R = ctx.createGain(); delayFB_R.gain.value = 0.25;
        delayPanL = ctx.createStereoPanner(); delayPanL.pan.value = -0.8;
        delayPanR = ctx.createStereoPanner(); delayPanR.pan.value = 0.8;
        
        const delayFilterL = ctx.createBiquadFilter(); delayFilterL.type = 'lowpass'; delayFilterL.frequency.value = 3000;
        const delayFilterR = ctx.createBiquadFilter(); delayFilterR.type = 'lowpass'; delayFilterR.frequency.value = 3000;

        sendGain.connect(delayL); delayL.connect(delayFilterL); delayFilterL.connect(delayPanL); delayPanL.connect(masterGain); delayFilterL.connect(delayFB_R);
        sendGain.connect(delayR); delayR.connect(delayFilterR); delayFilterR.connect(delayPanR); delayPanR.connect(masterGain); delayFilterR.connect(delayFB_L);
        delayFB_R.connect(delayR); delayFB_L.connect(delayL);

        masterGain.connect(ctx.destination);
        ctx.synthBus = synthBus;

        // NOTE: initPads MUST come after synthBus and convolver are created
        initPads();

        heatInterval = setInterval(() => {
            if (typeHeat > 0) {
                typeHeat = Math.max(0, typeHeat - 0.05);
            }
            if (ctx && ctx.currentTime - lastKeyTime > 2.0) {
                if (isTyping) {
                    isTyping = false;
                    isOutro = true;
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
            nextNoteTime = ctx ? ctx.currentTime + 0.05 : 0;
        }
    }

    function resetMemory() {
        M = [0, 2, 4, 2, 0, 2, 4, 7].map(Number);
        M_pending = null;
        sentenceMelody = [];
        melodyBuffer = [];
        isOutro = false;
        pendingFillVariant = 'normal';
        activeFillVariant = 'normal';
        typeHeat = 0;
        lastHeadingCount = 0;
    }

    function destroy() {
        if (heatInterval) clearInterval(heatInterval);
        if (schedulerInterval) clearInterval(schedulerInterval);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        if (masterGain) {
            const oldGain = masterGain;
            oldGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
            setTimeout(() => { try { oldGain.disconnect(); } catch(e) {} }, 200);
            masterGain = null;
        }
        
        if (padGainNode) {
            padGainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
            setTimeout(() => {
                try {
                    padOscs.forEach(o => o.stop());
                    padOscs.forEach(o => o.disconnect());
                    padFilter.disconnect();
                    padGainNode.disconnect();
                } catch(e){}
                padOscs = [];
                padGainNode = null;
                padFilter = null;
            }, 200);
        }

        resetMemory();
        ctx = null;
    }

    // --- Audio Playback ---

    
    function duckSidechain(time) {
        synthBus.gain.setValueAtTime(synthBus.gain.value, time);
        synthBus.gain.exponentialRampToValueAtTime(0.75, time + 0.02); // 0.75 softer ducking
        synthBus.gain.linearRampToValueAtTime(1.0, time + 0.38);
    }

    function updatePads(time) {
        if (!padGainNode || padOscs.length < 4) return;
        let root = 45 + currentKeyShift + currentChordOffset; // A2
        
        // Lydian Pad: Root, +7, +12, +6
        const offsets = [0, 7, 12, 6];
        const detunes = [-10, -4, 4, 10];
        
        for(let i=0; i<4; i++) {
            const freq = midiToFreq(root + offsets[i]);
            padOscs[i].frequency.setTargetAtTime(freq, time, 0.8);
            padOscs[i].detune.setTargetAtTime(detunes[i], time, 0.8);
        }
        
        // Swell gain
        padGainNode.gain.setTargetAtTime(0.0625, time, 0.2); // +25% of 0.05
        padGainNode.gain.setTargetAtTime(0.05, time + 1.0, 0.5);

        // Semantisk rumsakustik: justera reverb utifrån meningslängd
        const stats = getStats();
        if (reverbGain && stats && stats.meanSentLen) {
            const wetTarget = clamp(0.3 + (stats.meanSentLen / 120) * 0.4, 0.3, 0.7);
            reverbGain.gain.setTargetAtTime(wetTarget, time, 1.0);
        }
    }

    function playSubBass(time) {
        const osc = ctx.createOscillator(); osc.type = 'sine';
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 120;
        const gain = ctx.createGain();
        let root = 45 + currentKeyShift + currentChordOffset - 24; // A0
        osc.frequency.setValueAtTime(midiToFreq(root), time);
        gain.gain.setValueAtTime(0, time);
        gain.gain.setTargetAtTime(0.20, time, 0.05/3);
        gain.gain.setTargetAtTime(0.0001, time + 0.05, 1.6/3);
        osc.connect(filter); filter.connect(gain); gain.connect(synthBus);
        osc.start(time); osc.stop(time + 1.7);
        osc.onended = () => { try { filter.disconnect(); gain.disconnect(); } catch(e){} };
    }

    function playHeartbeatKick(time) {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.setValueAtTime(80, time); osc.frequency.exponentialRampToValueAtTime(35, time + 0.25);
        gain.gain.setValueAtTime(0, time); gain.gain.setTargetAtTime(0.5, time, 0.008 / 3); gain.gain.setTargetAtTime(0.0001, time + 0.01, 0.25 / 3);
        osc.connect(gain); gain.connect(compressor);
        osc.start(time); osc.stop(time + 0.3);
        osc.onended = () => { gain.disconnect(); };
        duckSidechain(time);
    }

    function playArp(time, degree, velocity, duration = 0.14) {
        const osc = ctx.createOscillator(); osc.type = 'square';
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1800;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.setTargetAtTime(0.06 * velocity, time, 0.01/3);
        gain.gain.setTargetAtTime(0.0001, time + 0.01, duration/3);
        const freq = midiToFreq(degreeToMidi(degree, 45 + currentKeyShift));
        osc.frequency.setValueAtTime(freq, time);
        
        // Delay send (ping-pong)
        const send = ctx.createGain(); send.gain.value = 0.5;
        osc.connect(filter); filter.connect(gain);
        gain.connect(synthBus); gain.connect(send); send.connect(delayL); send.connect(delayR);
        
        osc.start(time); osc.stop(time + duration + 0.1);
        osc.onended = () => { try { filter.disconnect(); gain.disconnect(); send.disconnect(); } catch(e){} };
    }

    function playSpaceHat(time) {
        const source = ctx.createBufferSource(); source.buffer = noiseBuffer;
        const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 9000; filter.Q.value = 12;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time); gain.gain.setTargetAtTime(0.03, time, 0.005/3); gain.gain.setTargetAtTime(0.0001, time + 0.005, 0.03/3);
        source.connect(filter); filter.connect(gain); gain.connect(synthBus);
        source.start(time); source.stop(time + 0.05);
        source.onended = () => { try { filter.disconnect(); gain.disconnect(); } catch(e){} };
    }

    function playTomPulse(time) {
        const osc = ctx.createOscillator(); osc.type = 'sine';
        const gain = ctx.createGain();
        osc.frequency.setValueAtTime(110, time); osc.frequency.exponentialRampToValueAtTime(70, time + 0.2);
        gain.gain.setValueAtTime(0, time); gain.gain.setTargetAtTime(0.12, time, 0.01/3); gain.gain.setTargetAtTime(0.0001, time + 0.01, 0.2/3);
        osc.connect(gain); gain.connect(synthBus);
        osc.start(time); osc.stop(time + 0.3);
        osc.onended = () => { try { gain.disconnect(); } catch(e){} };
    }

    function playLead(time, degree, velocity, duration = 0.8, volMod = 1.0) {
        const osc1 = ctx.createOscillator(); osc1.type = 'sine';
        const osc2 = ctx.createOscillator(); osc2.type = 'triangle';
        const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 4.5;
        const lfoGain = ctx.createGain(); lfoGain.gain.setValueAtTime(0, time); lfoGain.gain.setTargetAtTime(5, time + 0.3, 0.1);
        lfo.connect(lfoGain); lfoGain.connect(osc1.detune); lfoGain.connect(osc2.detune);
        
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time); gain.gain.setTargetAtTime(0.09 * velocity * volMod, time, 0.03/3); gain.gain.setTargetAtTime(0.0001, time + 0.03, duration/3);
        
        const stats = getStats();
        let leadOctave = stats.meanAlpha && stats.meanAlpha > 14 ? 12 : 0;
        const freq = midiToFreq(degreeToMidi(degree, 45 + currentKeyShift + leadOctave));
        osc1.frequency.setValueAtTime(freq, time); osc2.frequency.setValueAtTime(freq, time);
        
        const osc2Gain = ctx.createGain(); osc2Gain.gain.value = 0.4;
        osc2.connect(osc2Gain);
        
        osc1.connect(gain); osc2Gain.connect(gain);
        gain.connect(synthBus);
        
        // Convolver send
        const convSend = ctx.createGain(); convSend.gain.value = 0.35;
        gain.connect(convSend); convSend.connect(convolver);
        
        // Delay send
        const delSend = ctx.createGain(); delSend.gain.value = 0.4;
        gain.connect(delSend); delSend.connect(delayL); delSend.connect(delayR);
        
        osc1.start(time); osc2.start(time); lfo.start(time);
        osc1.stop(time + duration + 0.1); osc2.stop(time + duration + 0.1); lfo.stop(time + duration + 0.1);
        osc1.onended = () => { try { gain.disconnect(); osc2Gain.disconnect(); lfoGain.disconnect(); convSend.disconnect(); delSend.disconnect(); } catch(e){} };
    }
    
    function playTelemetry(time, melDegree) {
        const osc = ctx.createOscillator(); osc.type = 'sine';
        const gain = ctx.createGain();
        const panner = ctx.createStereoPanner();
        panner.pan.value = (Math.random() > 0.5 ? 1 : -1) * 0.8;
        
        osc.frequency.setValueAtTime(1800 + melDegree * 120, time);
        gain.gain.setValueAtTime(0, time); gain.gain.setTargetAtTime(0.025, time, 0.005/3); gain.gain.setTargetAtTime(0.0001, time + 0.005, 0.04/3);
        
        osc.connect(gain); gain.connect(panner); panner.connect(synthBus);
        osc.start(time); osc.stop(time + 0.05);
        osc.onended = () => { try { gain.disconnect(); panner.disconnect(); } catch(e){} };
    }

    function snapToChord(degree) {
        const relativeChordRoot = scale.indexOf((currentChordOffset + 12)%12) !== -1 ? scale.indexOf((currentChordOffset + 12)%12) : 0;
        const validSteps = [0, 1, 3, 5, 6, 8].map(s => s + relativeChordRoot); 
        let closest = degree;
        let minDist = 99;
        for (let v of validSteps) {
            if (Math.abs(v - degree) < minDist) {
                minDist = Math.abs(v - degree);
                closest = v;
            }
        }
        return closest;
    }

    // --- Sequencer ---

    function scheduleStep(step, time) {
        if (!ctx) return;
        
        if (step === 0) {
            // 2D lookup for scale based on smoothedVowelRatio
            const stats = getStats();
            smoothedVowelRatio += (stats.vowelRatio - smoothedVowelRatio) * 0.1;
            
            if (barNumber % 2 === 0 && !isOutro) {
                updatePads(time);
            }

            let docSeed = 0;
            if (typeof window.getActiveDoc === 'function') {
                const doc = window.getActiveDoc();
                if (doc && doc.title) {
                    for(let i = 0; i < doc.title.length; i++) {
                        docSeed += doc.title.charCodeAt(i) * Math.pow(7, i % 5);
                    }
                }
            }
            
            // Låt groovet utvecklas beroende på ordmängd (ändrar mönster var 30:e ord)
            const wordEvolSeed = Math.floor(stats.words / 30) * 113;
            
            prng = mulberry32(Math.floor(docSeed) + wordEvolSeed + stats.paragraphs * 1000 + barNumber);
            
            const prog = (stats.vowelRatio > 0.42) ? [0, -2, -4, -5] : [0, -4, 3, -2];
            currentChordOffset = prog[barNumber % 4];
            
            // Företrädesregel B3: synka inte fb om delay bloom är aktivt
            if (delayFB_L && delayFB_R && barNumber >= delayBloomUntilBar) {
                const fb = 0.25 + (typeHeat * 0.20);
                delayFB_L.gain.setTargetAtTime(fb, time, 0.5);
                delayFB_R.gain.setTargetAtTime(fb, time, 0.5);
            }
            
            if (M_pending) {
                M = M_pending;
                M_pending = null;
            }
        }

        const effectiveHeat = (isOutro || isFillBar) ? Math.max(0, typeHeat - 0.5) : typeHeat;
        
        // Layer 0: Bass
        if (step === 0 || step === 8) {
            playSubBass(time);
        }
        
        // Layer 1: Heartbeat
        if (effectiveHeat > 0.25 && (step === 0 || step === 8)) {
            playHeartbeatKick(time);
        }
        
        // Layer 2: Arp (Eighths)
        if (effectiveHeat > 0.5 && step % 2 === 0) {
            let od = Math.round(M[step / 2]);
            if (step % 4 === 0) od = snapToChord(od);
            playArp(time, od, 1.0);
        }
        
        // Layer 3: Arp (Sixteenths) + Space Hat
        if (effectiveHeat > 0.75) {
            if (step % 2 !== 0) {
                let od = Math.round(M[Math.floor(step / 2)]);
                playArp(time, od, 0.6);
            }
            if (step % 2 !== 0) playSpaceHat(time); // Offbeat hat
        }
        
        // Layer 4: Tom Pulse + Octave Arp
        if (effectiveHeat > 0.95) {
            if (step === 6 || step === 14) playTomPulse(time);
            if (step % 2 === 0 && Math.random() > 0.5) {
                let od = Math.round(M[step / 2]);
                playArp(time, od + 12, 0.8);
            }
        }
        
        // Fill logic (The Transmission)
        if (isFillBar) {
            if (step < 8 && step % 2 === 0) {
                let note = melodyBuffer[step/2 % melodyBuffer.length] || 4;
                if (activeFillVariant === 'question' && step === 6) note = 3;
                playLead(time, note, fillGain, 0.2); // Uses Lead voice
            }
            if (activeFillVariant === 'question') {
                if (step === 8) playSpaceHat(time); // Sweep substitute
            } else {
                if (step === 0) {
                    playHeartbeatKick(time);
                    playSubBass(time);
                }
                if (activeFillVariant === 'exclaim' && (step === 0 || step === 8)) {
                    playTomPulse(time);
                    playLead(time, 0, 1.3); // Root
                    playLead(time, 7, 1.3); // Fifth
                }
            }
        }
    }

    // --- Lookahead Scheduler (was missing — caused ReferenceError) ---
    function schedule() {
        if (!isTyping && !isOutro) return;
        if (!ctx) return;
        
        if (ctx.state === 'suspended') ctx.resume();
        
        const now = ctx.currentTime;
        if (nextNoteTime < now) nextNoteTime = now + 0.05;
        
        while (nextNoteTime < now + LOOKAHEAD) {
            scheduleStep(step16, nextNoteTime);
            
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
                    activeFillVariant = pendingFillVariant;
                } else if (isFillBar) {
                    isFillBar = false;
                }
                
                // Outro stops the clock here
                if (isOutro) {
                    isOutro = false;
                    isTyping = false;
                }
            }
        }
    }

    // --- Input Handling ---

    function handleChar(key, stats) {
        if (!ctx) init();
        if (!ctx) return; // Safety: if init still failed
        if (ctx.state === 'suspended') ctx.resume();
        
        const lowKey = key.toLowerCase();
        
        if (!isTyping) {
            isTyping = true;
            isOutro = false;
            nextNoteTime = Math.ceil((ctx.currentTime + 0.02) / SIXTEENTH_DUR) * SIXTEENTH_DUR;
            step16 = 0;
            playSubBass(ctx.currentTime);
        }
        
        lastKeyTime = ctx.currentTime;
        const now = ctx.currentTime;
        const quantTime = nextNoteTime;
        
        if (key === ' ' || key === 'Delete') {
            if (now - lastGlitchTime > 0.1) {
                lastGlitchTime = now;
                // Static noise skur
                const src = ctx.createBufferSource(); src.buffer = noiseBuffer;
                const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 2500; filter.Q.value = 3;
                const gain = ctx.createGain(); gain.gain.setValueAtTime(0, now); gain.gain.setTargetAtTime(0.05, now, 0.005); gain.gain.setTargetAtTime(0.0001, now + 0.08, 0.01);
                src.connect(filter); filter.connect(gain); gain.connect(synthBus);
                src.start(now); src.stop(now + 0.1);
            }
        } else if (key === '\n') {
            typeHeat = Math.min(1.2, typeHeat + 0.1);
            currentSentenceLen++;
            
            const s = getStats();
            const verseSteps = [0, -3, 2, -5, 4];
            currentKeyShift = verseSteps[(s.headings || 0) % verseSteps.length];
            
            // Hyperrymdshoppet
            // 1. Brusriser
            const src = ctx.createBufferSource(); src.buffer = noiseBuffer;
            const filter = ctx.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.setValueAtTime(200, now); filter.frequency.exponentialRampToValueAtTime(8000, now + 1.5);
            const gain = ctx.createGain(); gain.gain.setValueAtTime(0, now); gain.gain.setTargetAtTime(0.1, now, 0.5); gain.gain.setTargetAtTime(0.0001, now + 1.5, 0.1);
            src.connect(filter); filter.connect(gain); gain.connect(synthBus); src.start(now); src.stop(now + 2.0);
            
            // 2. Pad glide and master sweep
            if (masterFilter) {
                masterFilter.frequency.cancelScheduledValues(now);
                masterFilter.frequency.setValueAtTime(18000, now);
                masterFilter.frequency.exponentialRampToValueAtTime(500, now + SIXTEENTH_DUR * 8);
                masterFilter.frequency.exponentialRampToValueAtTime(18000, now + SIXTEENTH_DUR * 16);
                sweepUntilTime = now + SIXTEENTH_DUR * 16;
            }
            playSubBass(now);
            
        } else if (key === '#') {
            typeHeat = Math.min(1.2, typeHeat + 0.1);
            currentSentenceLen++;
            const s = getStats();
            if (s.headings > lastHeadingCount) {
                lastHeadingCount = s.headings;
                const harmonicShiftCount = s.harmonicShiftCount || 0;
                currentKeyShift = [0, -3, 2, -5, 4][harmonicShiftCount % 5];
            }
            if (window.VisualsEngine) window.VisualsEngine.spawnHardForkBlock('char', 14);
        } else if (key === ' ') {
            typeHeat = Math.min(1.2, typeHeat + 0.1);
            currentSentenceLen++;
            addTrace(40, now);
            if (window.VisualsEngine) window.VisualsEngine.spawnHardForkBlock('space', 0);
        } else if (/[.,;:!?]/.test(key)) {
            typeHeat = Math.min(1.2, typeHeat + 0.1);
            currentSentenceLen++;
            addTrace(90, now);
            if (window.VisualsEngine) window.VisualsEngine.spawnHardForkBlock('punct', 0);
            
            if (key === '.') {
                // Lufsslussen
                const src = ctx.createBufferSource(); src.buffer = noiseBuffer;
                const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.setValueAtTime(2000, now); filter.frequency.exponentialRampToValueAtTime(400, now + 0.6);
                const gain = ctx.createGain(); gain.gain.setValueAtTime(0, now); gain.gain.setTargetAtTime(0.04, now, 0.1); gain.gain.setTargetAtTime(0.0001, now + 0.6, 0.1);
                src.connect(filter); filter.connect(gain); gain.connect(synthBus); src.start(now); src.stop(now + 0.8);
            } else if (key === ',') {
                if (masterFilter && now > sweepUntilTime) {
                    masterFilter.frequency.cancelScheduledValues(now);
                    masterFilter.frequency.setValueAtTime(18000, now);
                    masterFilter.frequency.exponentialRampToValueAtTime(2500, now + SIXTEENTH_DUR * 2);
                    masterFilter.frequency.exponentialRampToValueAtTime(18000, now + SIXTEENTH_DUR * 4);
                }
            } else if (key === ';' || key === ':') {
                const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.setValueAtTime(300, now); osc.frequency.exponentialRampToValueAtTime(900, now + SIXTEENTH_DUR * 4);
                const gain = ctx.createGain(); gain.gain.setValueAtTime(0, now); gain.gain.setTargetAtTime(0.04, now, 0.1); gain.gain.setTargetAtTime(0.0001, now + SIXTEENTH_DUR * 4, 0.1);
                osc.connect(gain); gain.connect(synthBus); osc.start(now); osc.stop(now + SIXTEENTH_DUR * 5);
            }
            
            if (currentSentenceLen >= 2) {
                fillScheduledForNextBar = true;
                fillGain = clamp(currentSentenceLen / 120, 0.4, 1.0);
                pendingFillVariant = (key === '?') ? 'question' : (key === '!') ? 'exclaim' : 'normal';
                
                if (key === '?') {
                    currentChordOffset += 2; // Olöst
                }
                
                delayBloomUntilBar = barNumber + 2;
                if (delayFB_L && delayFB_R) {
                    delayFB_L.gain.setTargetAtTime(0.55, now, 0.4);
                    delayFB_R.gain.setTargetAtTime(0.55, now, 0.4);
                }
                if (onSentenceCallback) onSentenceCallback({ length: currentSentenceLen });
                
                if (sentenceMelody.length >= 2) {
                    const S = [];
                    for (let i = 0; i < 8; i++) {
                        S.push(sentenceMelody[Math.floor(i * sentenceMelody.length / 8) % sentenceMelody.length]);
                    }
                    const w = 0.2 + 0.3 * getStats().g;
                    M_pending = M.map((m, i) => clamp(w * S[i] + (1 - w) * m, 0, 9));
                }
            }
            currentSentenceLen = 0;
            lastCharIndex = -1;
            sentenceMelody = [];
            
        } else if (ALPHABET.includes(lowKey)) {
            typeHeat = Math.min(1.2, typeHeat + 0.1);
            currentSentenceLen++;
            const idx = ALPHABET.indexOf(lowKey);
            const diff = lastCharIndex === -1 ? 0 : idx - lastCharIndex;
            lastCharIndex = idx;
            
            let steg = clamp(Math.round(diff / 5), -2, 2);
            if (steg === 0 && diff !== 0) steg = diff > 0 ? 1 : -1;
            
            currentMelDegree = clamp(currentMelDegree + steg, 0, 9);
            
            if (step16 % 4 === 0) {
                currentMelDegree = snapToChord(currentMelDegree);
            }
            
            playLead(quantTime, currentMelDegree, 1.0);
            
            if (typeHeat < 0.25) {
                playTelemetry(quantTime, currentMelDegree);
            }
            
            melodyBuffer.push(currentMelDegree);
            if (melodyBuffer.length > 8) melodyBuffer.shift();
            
            sentenceMelody.push(currentMelDegree);
            if (sentenceMelody.length > 64) sentenceMelody.shift();
            
            addTrace(degreeToMidi(currentMelDegree, 45 + currentKeyShift), now);
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

    return { init, setVolume, setDepth, destroy, handleKey, handleChar, getState, onSentence, resetMemory };
})();