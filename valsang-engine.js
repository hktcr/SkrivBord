/**
 * ValsangEngine
 * 
 * En ljudmotor för SkrivR baserad på Web Audio API. 
 * Skapar ett kontinuerligt, dynamiskt fokusljud där melodi, andning 
 * och rum formas av vad och hur man skriver.
 */

export const ValsangEngine = (() => {
    let ctx = null;
    let masterGain, dryGain, wetGain, compressor, convolver;
    let voiceOsc1, voiceOsc2, subOsc, voiceGain;
    let voiceFilter;
    let vibratoLFO, vibratoGain;

    let noiseBuffer = null;
    let irBuffer = null;

    // State
    const ALPHABET = "abcdefghijklmnopqrstuvwxyzåäö";
    const SCALES = {
        odd: [0, 3, 5, 7, 10],   // moll-pentatonisk
        even: [0, 2, 5, 7, 9]    // dur/sus-pentatonisk
    };
    
    let rootMidi = 43; // G2
    let currentDegree = 4;
    let currentVerse = 0;
    let prevAlphaIdx = null;
    let sentenceBuffer = [];
    
    // Timing and Breathing
    let lastKeyTime = 0;
    let dtEma = 200; // Exponential moving average of time between keystrokes
    
    let currentChordDegree = 0;
    let chordTimer = null;
    let charsSinceStart = 0;
    
    let idleLFO = null;
    let idleGain = null;
    let idleTimer = null;
    
    let onTraceCallback = null;

    // Helper functions
    const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
    const lerp = (a, b, t) => a + (b - a) * t;
    const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
    
    const getScale = () => (currentVerse % 2 !== 0) ? SCALES.odd : SCALES.even;
    const degreeToMidi = (deg, root) => {
        const octave = Math.floor(deg / 5);
        const scale = getScale();
        const note = scale[deg % 5];
        return root + 12 * octave + note;
    };

    const createNoiseBuffer = () => {
        const bufferSize = ctx.sampleRate * 2.0; // 2 seconds of noise
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const output = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        return buffer;
    };

    const createImpulseResponse = () => {
        const length = ctx.sampleRate * 6.5;
        const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let channel = 0; channel < 2; channel++) {
            const channelData = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                const env = Math.pow(1 - (i / length), 3.2);
                channelData[i] = (Math.random() * 2 - 1) * env;
            }
        }
        return impulse;
    };

    function init(audioContext) {
        if (ctx) return;
        ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
        
        // Master chain
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -20;
        compressor.ratio.value = 6;
        compressor.connect(ctx.destination);
        
        masterGain = ctx.createGain();
        masterGain.gain.value = Math.pow(0.55, 1.6) * 0.9;
        masterGain.connect(compressor);
        
        dryGain = ctx.createGain();
        dryGain.gain.value = 0.7;
        dryGain.connect(masterGain);
        
        wetGain = ctx.createGain();
        wetGain.gain.value = 0.22;
        
        convolver = ctx.createConvolver();
        irBuffer = createImpulseResponse();
        convolver.buffer = irBuffer;
        
        wetGain.connect(convolver);
        convolver.connect(masterGain);
        
        // Voice
        voiceOsc1 = ctx.createOscillator();
        voiceOsc1.type = 'sine';
        voiceOsc2 = ctx.createOscillator();
        voiceOsc2.type = 'sine';
        voiceOsc2.detune.value = 6; // +6 cents
        subOsc = ctx.createOscillator();
        subOsc.type = 'sine';
        
        const subGain = ctx.createGain();
        subGain.gain.value = 0.18;
        subOsc.connect(subGain);
        
        voiceGain = ctx.createGain();
        voiceGain.gain.value = 0.0;
        
        voiceOsc1.connect(voiceGain);
        voiceOsc2.connect(voiceGain);
        subGain.connect(voiceGain);
        
        voiceFilter = ctx.createBiquadFilter();
        voiceFilter.type = 'lowpass';
        voiceFilter.frequency.value = 1600;
        voiceFilter.Q.value = 0.4;
        
        voiceGain.connect(voiceFilter);
        voiceFilter.connect(dryGain);
        voiceFilter.connect(wetGain);
        
        // Vibrato
        vibratoLFO = ctx.createOscillator();
        vibratoLFO.type = 'sine';
        vibratoLFO.frequency.value = 4.5;
        
        vibratoGain = ctx.createGain();
        vibratoGain.gain.value = 4; // cents
        
        vibratoLFO.connect(vibratoGain);
        vibratoGain.connect(voiceOsc1.detune);
        vibratoGain.connect(voiceOsc2.detune);
        
        // Start constant nodes
        voiceOsc1.start();
        voiceOsc2.start();
        subOsc.start();
        vibratoLFO.start();
        
        noiseBuffer = createNoiseBuffer();
        
        // Init state
        const initialFreq = midiToFreq(degreeToMidi(currentDegree, rootMidi));
        voiceOsc1.frequency.value = initialFreq;
        voiceOsc2.frequency.value = initialFreq;
        subOsc.frequency.value = initialFreq / 2;
        
        isIdle = false;
        lastKeyTime = performance.now();
        
        if (chordTimer) clearInterval(chordTimer);
        chordTimer = setInterval(() => {
            if (isIdle) return;
            const chords = [0, 2, -1, 3, 4]; // Pentatonic offsets for 'chords'
            currentChordDegree = chords[Math.floor(Math.random() * chords.length)];
        }, 12000); // Change harmony every 12 seconds
    }

    function destroy() {
        if (!ctx) return;
        clearTimeout(idleTimer);
        if (chordTimer) clearInterval(chordTimer);
        try {
            voiceOsc1.stop(); voiceOsc2.stop(); subOsc.stop(); vibratoLFO.stop();
            if (idleLFO) idleLFO.stop();
        } catch(e) {}
        ctx = null;
    }

    function setVolume(val) {
        if (masterGain) masterGain.gain.setTargetAtTime(Math.pow(val, 1.6) * 0.9, ctx.currentTime, 0.1);
    }

    function setDepth(val) {
        depthMultiplier = val;
    }

    let depthMultiplier = 1.0;
    
    // Play transient sounds (clicks, swishes)
    function playTransient(type, freq, q, gainVol, duration, routing) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        if (type === 'noise') {
            const noise = ctx.createBufferSource();
            noise.buffer = noiseBuffer;
            noise.loop = true;
            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = freq;
            filter.Q.value = q;
            
            gain.gain.setValueAtTime(gainVol, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
            
            noise.connect(filter);
            filter.connect(gain);
            noise.start();
            noise.stop(ctx.currentTime + duration);
        } else {
            // Sine blip
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(gainVol, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
            
            osc.connect(gain);
            osc.start();
            osc.stop(ctx.currentTime + duration);
        }
        
        if (routing === 'dry' || routing === 'both') gain.connect(dryGain);
        if (routing === 'wet' || routing === 'both') gain.connect(wetGain);
    }
    
    function playEchoPhrase(phrasePoints, exclamation) {
        const phraseDur = phrasePoints.length * 0.4;
        const gainVol = exclamation ? 0.075 : 0.05;
        const pan = (Math.random() - 0.5); // ±0.5
        
        const echoOsc = ctx.createOscillator();
        echoOsc.type = 'sine';
        const echoGain = ctx.createGain();
        echoGain.gain.value = 0;
        
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 900;
        
        const panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        
        echoOsc.connect(echoGain);
        echoGain.connect(filter);
        filter.connect(panner);
        panner.connect(wetGain); // Only wet
        
        echoOsc.start();
        
        let t = ctx.currentTime;
        phrasePoints.forEach(pt => {
            const freq = midiToFreq(degreeToMidi(pt.deg, rootMidi)) * 2; // EN OKTAV UPP
            const noteLen = clamp(dtEma * 0.4, 100, 240) / 1000;
            
            echoOsc.frequency.setValueAtTime(freq, t);
            echoGain.gain.setTargetAtTime(gainVol, t, 0.05);
            echoGain.gain.setTargetAtTime(0, t + noteLen * 0.5, 0.1);
            t += noteLen;
        });
        
        echoOsc.stop(t + 1.0);
    }

    function emitTrace(midi, type, durMs) {
        if (onTraceCallback) {
            onTraceCallback({ midi, type, durMs });
        }
    }

    const stateObj = { pitchNorm: 0.5, tempoNorm: 0.5, verse: 0, idle: false };
    
    function getState() {
        if (!ctx) return stateObj;
        stateObj.pitchNorm = clamp(currentDegree / 12, 0, 1);
        stateObj.tempoNorm = clamp((dtEma - 90) / (1400 - 90), 0, 1);
        stateObj.verse = currentVerse;
        stateObj.idle = isIdle;
        return stateObj;
    }

    function wakeUp() {
        if (isIdle) {
            isIdle = false;
            if (idleGain) {
                idleGain.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
            }
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!ctx) return;
            isIdle = true;
            voiceGain.gain.setTargetAtTime(0.018, ctx.currentTime, 2.5);
            
            if (!idleLFO) {
                idleLFO = ctx.createOscillator();
                idleLFO.type = 'sine';
                idleLFO.frequency.value = 0.05;
                idleGain = ctx.createGain();
                idleLFO.connect(idleGain);
                idleGain.connect(voiceOsc1.detune);
                idleGain.connect(voiceOsc2.detune);
                idleLFO.start();
            }
            idleGain.gain.setTargetAtTime(45, ctx.currentTime, 2.0); // ±45 cent
        }, 5000);
    }

    function handleKey(e) {
        if (!ctx) init();
        if (ctx.state === 'suspended') ctx.resume();
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        
        const now = performance.now();
        const dt = clamp(now - lastKeyTime, 60, 2000);
        lastKeyTime = now;
        
        dtEma = 0.72 * dtEma + 0.28 * dt;
        const x = clamp((dtEma - 90) / (1400 - 90), 0, 1);
        const glideTime = lerp(0.06, 0.55, x);
        const releaseTC = lerp(0.35, 2.2, x);
        
        vibratoLFO.frequency.setTargetAtTime(lerp(4.5, 0.18, x), ctx.currentTime, 0.1);
        vibratoGain.gain.setTargetAtTime(lerp(4, 18, x), ctx.currentTime, 0.1);
        wetGain.gain.setTargetAtTime(lerp(0.22, 0.55, x) * depthMultiplier, ctx.currentTime, 0.1);
        
        wakeUp();

        const key = e.key;
        const lowKey = key.toLowerCase();
        charsSinceStart++;

        if (key === 'Enter') {
            currentDegree = 0;
            const targetFreq = midiToFreq(degreeToMidi(currentDegree, rootMidi));
            voiceOsc1.frequency.setTargetAtTime(targetFreq, ctx.currentTime, 0.9);
            voiceOsc2.frequency.setTargetAtTime(targetFreq, ctx.currentTime, 0.9);
            subOsc.frequency.setTargetAtTime(targetFreq/2, ctx.currentTime, 0.9);
            
            voiceGain.gain.setTargetAtTime(0.22, ctx.currentTime, 0.1);
            voiceGain.gain.setTargetAtTime(0, ctx.currentTime + 0.2, 2.5);
            
            emitTrace(degreeToMidi(currentDegree, rootMidi), 'dive', 900);
            
            setTimeout(() => {
                if (!ctx) return;
                currentVerse++;
                const verseSteps = [0, -3, 2, -5, 4];
                rootMidi = clamp(41 + verseSteps[currentVerse % 5], 36, 48);
                currentDegree = 4;
                prevAlphaIdx = null;
            }, 900);
            
        } else if (key === 'Backspace') {
            voiceOsc1.detune.setValueAtTime(0, ctx.currentTime);
            voiceOsc1.detune.linearRampToValueAtTime(-90, ctx.currentTime + 0.09);
            voiceOsc1.detune.linearRampToValueAtTime(0, ctx.currentTime + 0.22);
            voiceOsc2.detune.setValueAtTime(6, ctx.currentTime);
            voiceOsc2.detune.linearRampToValueAtTime(-84, ctx.currentTime + 0.09);
            voiceOsc2.detune.linearRampToValueAtTime(6, ctx.currentTime + 0.22);
            
            if (sentenceBuffer.length > 0) sentenceBuffer.pop();
            
        } else if (key === ' ') {
            const currentVol = voiceGain.gain.value;
            voiceGain.gain.setTargetAtTime(Math.max(0.02, currentVol * 0.3), ctx.currentTime, 0.05);
            if (Math.random() < 0.4) {
                currentDegree = currentDegree > 6 ? currentDegree - 1 : currentDegree < 6 ? currentDegree + 1 : 6;
                const targetFreq = midiToFreq(degreeToMidi(currentDegree, rootMidi));
                voiceOsc1.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime);
                voiceOsc2.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime);
                subOsc.frequency.setTargetAtTime(targetFreq/2, ctx.currentTime, glideTime);
            }
            
        } else if (/[.,;:!?]/.test(key)) {
            if (key === '?' || key === '.' || key === '!') {
                if (key === '?') currentDegree = clamp(currentDegree + 2, 0, 12);
                else currentDegree = Math.floor(currentDegree / 5) * 5; // tonika under
                
                const targetFreq = midiToFreq(degreeToMidi(currentDegree, rootMidi));
                voiceOsc1.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime * 1.6);
                voiceOsc2.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime * 1.6);
                subOsc.frequency.setTargetAtTime(targetFreq/2, ctx.currentTime, glideTime * 1.6);
                
                voiceGain.gain.setTargetAtTime(key === '!' ? 0.26 : 0.17, ctx.currentTime, 0.1);
                
                const maxPoints = 14;
                let step = Math.max(1, Math.floor(sentenceBuffer.length / maxPoints));
                let phrasePoints = sentenceBuffer.filter((_, i) => i % step === 0).slice(-maxPoints);
                
                if (key === '?') phrasePoints.push({deg: currentDegree});
                else if (key === '!') { phrasePoints.push(sentenceBuffer[sentenceBuffer.length-1] || {deg: currentDegree}); phrasePoints.push({deg: currentDegree}); }
                else phrasePoints.push({deg: currentDegree});
                
                playEchoPhrase(phrasePoints, key === '!');
                
                const fadeDur = clamp(sentenceBuffer.length * 0.09, 1.5, 8);
                voiceGain.gain.setTargetAtTime(0.02, ctx.currentTime + 0.5, fadeDur / 3);
                
                sentenceBuffer = [];
                prevAlphaIdx = null;
            } else {
                currentDegree = clamp(currentDegree - 1, 0, 12);
                const targetFreq = midiToFreq(degreeToMidi(currentDegree, rootMidi));
                voiceOsc1.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime * 1.3);
                voiceOsc2.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime * 1.3);
                subOsc.frequency.setTargetAtTime(targetFreq/2, ctx.currentTime, glideTime * 1.3);
                voiceGain.gain.setTargetAtTime(0.10, ctx.currentTime, 0.1);
            }
            
        } else if (/[0-9]/.test(key)) {
            const num = parseInt(key);
            const freq = 1200 + num * 130;
            
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            
            gain.gain.setValueAtTime(0.2, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);
            
            const delay = ctx.createDelay();
            delay.delayTime.value = 0.260;
            const feedback = ctx.createGain();
            feedback.gain.value = 0.42;
            
            osc.connect(gain);
            gain.connect(delay);
            delay.connect(feedback);
            feedback.connect(delay);
            delay.connect(wetGain);
            gain.connect(wetGain);
            
            osc.start();
            osc.stop(ctx.currentTime + 0.12);
            
        } else if (ALPHABET.includes(lowKey)) {
            const isVowel = ['a','o','u','å','e','i','y','ä','ö'].includes(lowKey);
            
            // Smart harmonization: smooth pentatonic walk biased toward current harmony
            const targetBase = 5 + currentChordDegree; // Focus around middle octave + chord offset
            
            let jump = 0;
            if (currentDegree > targetBase + 2) jump = -1;
            else if (currentDegree < targetBase - 2) jump = 1;
            else {
                // If in zone, small smooth steps
                if (Math.random() > 0.4) jump = (Math.random() > 0.5 ? 1 : -1);
            }
            
            currentDegree = clamp(currentDegree + jump, 0, 15);
            
            const targetFreq = midiToFreq(degreeToMidi(currentDegree, rootMidi));
            
            const glideTime = isVowel ? 0.6 : 0.3;
            const releaseTC = isVowel ? 1.5 : 0.8;
            const isCapital = (key !== lowKey);
            
            let traceType = isVowel ? 'vowel' : 'cons';
            
            if (isVowel) {
                voiceOsc1.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime);
                voiceOsc2.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime);
                subOsc.frequency.setTargetAtTime(targetFreq/2, ctx.currentTime, glideTime);
                voiceGain.gain.setTargetAtTime(0.20, ctx.currentTime, 0.05);
                voiceGain.gain.setTargetAtTime(0.05, ctx.currentTime + 0.1, releaseTC);
            } else {
                voiceOsc1.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime * 0.6);
                voiceOsc2.frequency.setTargetAtTime(targetFreq, ctx.currentTime, glideTime * 0.6);
                subOsc.frequency.setTargetAtTime(targetFreq/2, ctx.currentTime, glideTime * 0.6);
                voiceGain.gain.setTargetAtTime(0.13, ctx.currentTime, 0.03);
                voiceGain.gain.setTargetAtTime(0.05, ctx.currentTime + 0.05, releaseTC * 0.8);
                
                if ('ptkbdg'.includes(lowKey)) {
                    playTransient('noise', 1100 + 45 * idx, 7, 0.08, 0.05, 'both');
                } else if ('sfvzchj'.includes(lowKey)) {
                    const dur = clamp(dtEma * 0.5, 120, 500) / 1000;
                    playTransient('noise', targetFreq * 4, 1.6, 0.1, dur, 'wet');
                } else if ('mnlr'.includes(lowKey)) {
                    playTransient('sine', targetFreq / 2, 1, 0.09, 0.16, 'both');
                }
            }
            
            if (isCapital) {
                const octQuintFreq = midiToFreq(degreeToMidi(currentDegree, rootMidi) + 19);
                playTransient('sine', octQuintFreq, 1, 0.05, 1.2, 'wet');
            }
            
            sentenceBuffer.push({deg: currentDegree});
            emitTrace(degreeToMidi(currentDegree, rootMidi), traceType, isVowel ? 300 : 150);
        }
    }

    return {
        init,
        destroy,
        handleKey,
        setVolume,
        setDepth,
        getState,
        onTrace: (cb) => { onTraceCallback = cb; }
    };
})();
