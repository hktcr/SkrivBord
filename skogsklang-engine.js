/**
 * SkogsklangEngine (BYGGSPEC v5)
 * 
 * En mjuk FM/pad-syntes för SkrivR. Bygger upp ackord per mening (1 ton per ord, upp till 5).
 * Sväller vid meningsslut och tändar eldflugor via onSentence-callback.
 * DETERMINISM: Ingen Math.random för tonhöjd, harmoni eller tonart.
 */

export const SkogsklangEngine = (() => {
    let ctx = null;
    let masterGain, dryGain, wetGain, compressor, convolver;
    let baseOsc, baseOscTri, baseGain;
    let voiceFilter;
    
    // Ackordröster (1 till 5)
    let voices = [];
    
    let irBuffer = null;

    // State
    const ALPHABET = "abcdefghijklmnopqrstuvwxyzåäö";
    const SCALES = {
        moll: [0, 3, 5, 7, 10],   // moll-pentatonisk
        dur: [0, 2, 5, 7, 9]      // dur/sus-pentatonisk
    };
    
    let rootMidi = 43; // G2
    let degreeFloat = 4.0;
    let currentDegree = 4;
    
    let activeAckordDegrees = [];
    let prevSentenceDegrees = [];
    
    // Timing and Breathing
    let lastKeyTime = 0;
    let dtEma = 420;
    
    let idleLFO = null;
    let idleGain = null;
    let idleTimer = null;
    let isIdle = true;
    
    let onSentenceCallback = null;
    let isDurScale = false;
    
    let charCounter = 0;
    let currentWordChars = 0;
    let wordStartIx = null;
    let sentenceChars = 0;
    let sentenceLetters = 0;

    
    // Helper functions
    const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
    const lerp = (a, b, t) => a + (b - a) * t;
    const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
    
    const getScale = () => isDurScale ? SCALES.dur : SCALES.moll;
    const degreeToMidi = (deg, root) => {
        const octave = Math.floor(deg / 5);
        const scale = getScale();
        let modDegree = deg % 5;
        if (modDegree < 0) modDegree += 5;
        const note = scale[modDegree];
        return root + 12 * octave + note;
    };

    const createImpulseResponse = () => {
        const length = ctx.sampleRate * 8.0; // 8s per spec
        const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let channel = 0; channel < 2; channel++) {
            const channelData = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                const env = Math.pow(1 - (i / length), 3.2);
                // Slump är tillåten för IR (brus)
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
        masterGain.gain.value = Math.pow(0.6, 1.6) * 0.9;
        masterGain.connect(compressor);
        
        dryGain = ctx.createGain();
        dryGain.gain.value = 0.6;
        dryGain.connect(masterGain);
        
        wetGain = ctx.createGain();
        wetGain.gain.value = 0.4;
        
        convolver = ctx.createConvolver();
        irBuffer = createImpulseResponse();
        convolver.buffer = irBuffer;
        
        wetGain.connect(convolver);
        convolver.connect(masterGain);
        
        // Gemensamt lågpass (1200 Hz, Q 0.5)
        voiceFilter = ctx.createBiquadFilter();
        voiceFilter.type = 'lowpass';
        voiceFilter.frequency.value = 1200;
        voiceFilter.Q.value = 0.5;
        
        voiceFilter.connect(dryGain);
        voiceFilter.connect(wetGain);
        
        // Basrösten (Röst 0)
        baseOsc = ctx.createOscillator();
        baseOsc.type = 'sine';
        baseOscTri = ctx.createOscillator();
        baseOscTri.type = 'triangle';
        const baseTriGain = ctx.createGain();
        baseTriGain.gain.value = 0.3;
        baseOscTri.connect(baseTriGain);
        
        baseGain = ctx.createGain();
        baseGain.gain.value = 0.05;
        
        baseOsc.connect(baseGain);
        baseTriGain.connect(baseGain);
        baseGain.connect(voiceFilter);
        
        baseOsc.start();
        baseOscTri.start();
        
        // Ackordröster (1-5)
        voices = [];
        for(let i = 0; i < 5; i++) {
            const oscSin = ctx.createOscillator();
            oscSin.type = 'sine';
            const oscTri = ctx.createOscillator();
            oscTri.type = 'triangle';
            
            // ±4 cent detune
            const detune = (i % 2 === 0 ? 4 : -4);
            oscSin.detune.value = detune;
            oscTri.detune.value = -detune;
            
            const triGain = ctx.createGain();
            triGain.gain.value = 0.3;
            oscTri.connect(triGain);
            
            const vGain = ctx.createGain();
            vGain.gain.value = 0.0; // Tyst initialt
            
            oscSin.connect(vGain);
            triGain.connect(vGain);
            vGain.connect(voiceFilter);
            
            oscSin.start();
            oscTri.start();
            
            voices.push({
                sin: oscSin,
                tri: oscTri,
                gain: vGain,
                activeDegree: null
            });
        }
        
        // Init state
        const initialFreq = midiToFreq(degreeToMidi(currentDegree, rootMidi)) / 2; // Basrösten oktav under
        baseOsc.frequency.value = initialFreq;
        baseOscTri.frequency.value = initialFreq;
        
        isIdle = false;
        lastKeyTime = performance.now();
        activeAckordDegrees = [];
        charCounter = 0;
        currentWordChars = 0;
    }

    function destroy() {
        if (!ctx) return;
        clearTimeout(idleTimer);
        try {
            baseOsc.stop(); baseOscTri.stop();
            voices.forEach(v => { v.sin.stop(); v.tri.stop(); });
            if (idleLFO) idleLFO.stop();
        } catch(e) {}
        ctx = null;
    }

    function setVolume(val) {
        if (masterGain) masterGain.gain.setTargetAtTime(Math.pow(val, 1.6) * 0.9, ctx.currentTime, 0.1);
    }

    function setDepth(val) {
        if (wetGain) wetGain.gain.setTargetAtTime(0.2 + 0.2 * val, ctx.currentTime, 0.1);
    }
    
    function playGlimmer(degree, g = 1.0) {
        if (!ctx) return;
        // Kvint (+7 halvtoner) och en oktav mörkare för mjukare klang
        const freq = midiToFreq(degreeToMidi(degree, rootMidi) + 7) * 0.5;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        
        const gain = ctx.createGain();
        const maxG = 0.015 * g;
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.setTargetAtTime(maxG, ctx.currentTime, 0.1/3);
        gain.gain.setTargetAtTime(0, ctx.currentTime + 0.3, 1.2/3);
        
        osc.connect(gain);
        gain.connect(wetGain);
        
        osc.start();
        osc.stop(ctx.currentTime + 2.0);
    }

    function getState() {
        return {
            pitchNorm: clamp(currentDegree / 12, 0, 1),
            tempoNorm: clamp((dtEma - 90) / (1400 - 90), 0, 1),
            idle: isIdle,
            voicesActive: activeAckordDegrees.length
        };
    }

    function wakeUp() {
        if (isIdle) {
            isIdle = false;
            baseGain.gain.setTargetAtTime(0.05, ctx.currentTime, 1.0);
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!ctx) return;
            isIdle = true;
            baseGain.gain.setTargetAtTime(0.02, ctx.currentTime, 2.0);
            voices.forEach(v => {
                if (v.activeDegree !== null) {
                    v.gain.gain.setTargetAtTime(0, ctx.currentTime, 2.0);
                    v.activeDegree = null;
                }
            });
            activeAckordDegrees = [];
        }, 5000);
    }

    // Returnerar närmaste lediga degree (uppåt prioriterat)
    function getNextFreeDegree(desiredDeg) {
        let deg = desiredDeg;
        for (let i = 0; i <= 3; i++) {
            if (!activeAckordDegrees.includes(deg + i)) return deg + i;
        }
        return null;
    }

        function lightChordTone(startIx, stats, tempoNorm) {
        if (activeAckordDegrees.length >= 5) return;
        const degProp = Math.round(2 + (startIx / 28) * 8);
        let degPrev = degProp;
        if (prevSentenceDegrees.length > 0) {
            degPrev = prevSentenceDegrees.reduce((p, c) => Math.abs(c - degProp) < Math.abs(p - degProp) ? c : p);
        }
        const deg = Math.round(degProp * stats.g + degPrev * (1 - stats.g));
        const newDeg = getNextFreeDegree(deg);
        if (newDeg === null || (newDeg - deg) > 3) return;
        const v = voices.find(v => v.activeDegree === null);
        if (!v) return;
        const f = midiToFreq(degreeToMidi(newDeg, rootMidi));
        v.sin.frequency.setValueAtTime(f, ctx.currentTime);
        v.tri.frequency.setValueAtTime(f, ctx.currentTime);
        v.gain.gain.setValueAtTime(0, ctx.currentTime);
        v.gain.gain.setTargetAtTime(0.07, ctx.currentTime, lerp(1.2, 3.5, tempoNorm) / 3);
        v.activeDegree = newDeg;
        activeAckordDegrees.push(newDeg);
    }

    function handleKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        handleChar(e.key);
    }

    function handleChar(key) {
        if (!ctx) init();
        if (ctx.state === 'suspended') ctx.resume();
        
        const now = performance.now();
        const dt = clamp(now - lastKeyTime, 60, 2000);
        lastKeyTime = now;
        
        dtEma = 0.72 * dtEma + 0.28 * dt;
        const x = clamp((dtEma - 90) / (1400 - 90), 0, 1);
        const tempoNorm = x;
        
        // Kontext från TextContext
        const stats = window.TextContext ? window.TextContext.getStats() : { g: 1, meanAlpha: 14, vowelRatio: 0.38, paragraphs: 0 };
        const N = stats.N || 0;
        const g = stats.g;

        wakeUp();

        // 3.3 Tonart och skalfärg
        if (stats.vowelRatio > 0.42 && !isDurScale) isDurScale = true;
        if (stats.vowelRatio < 0.40 && isDurScale) isDurScale = false;

        const verseSteps = [0, -3, 2, -5, 4];
        const newRootMidi = clamp(48 + verseSteps[stats.paragraphs % 5], 43, 55);
        if (newRootMidi !== rootMidi) {
            rootMidi = newRootMidi; 
        }

        if (!key) return;
        const lowKey = key.toLowerCase();

        // 3.4 Basrösten (Context)
        const centerDegree = 2 + (stats.meanAlpha / 28) * 8;
        const baseTargetFreq = midiToFreq(degreeToMidi(Math.round(centerDegree), rootMidi)) / 2;
        baseOsc.frequency.setTargetAtTime(baseTargetFreq, ctx.currentTime, 3.0);
        baseOscTri.frequency.setTargetAtTime(baseTargetFreq, ctx.currentTime, 3.0);

                if (key === 'Enter') {
            voices.forEach(v => {
                if (v.activeDegree !== null) {
                    v.gain.gain.setTargetAtTime(0, ctx.currentTime, 3.0/3);
                    v.activeDegree = null;
                }
            });
            activeAckordDegrees = [];
            currentWordChars = 0;
            wordStartIx = null;
            sentenceChars = 0;
            sentenceLetters = 0;
            
        } else if (key === 'Backspace') {
            // Ingen ljudgest
        } else if (key === ' ') {
            if (currentWordChars >= 2) lightChordTone(wordStartIx ?? 14, stats, tempoNorm);
            currentWordChars = 0;
            wordStartIx = null;
            sentenceChars++;
            
        } else if (/[.,;:!?]/.test(key)) {
            sentenceChars++;
            if (key === '?' || key === '.' || key === '!') {
                if (currentWordChars >= 2) {
                    lightChordTone(wordStartIx ?? 14, stats, tempoNorm);
                }
                if (sentenceLetters >= 2) {
                    const maxGain = key === '!' ? 0.084 : 0.074; // Softer max
                    voices.forEach(v => {
                        if (v.activeDegree !== null) {
                            v.gain.gain.setTargetAtTime(maxGain, ctx.currentTime, 2.0/3); // Slower swell
                        }
                    });
                    
                    if (key === '?') {
                        const highestDeg = Math.max(...activeAckordDegrees, 0);
                        const newDeg = getNextFreeDegree(highestDeg + 2);
                        if (newDeg !== null) {
                            const freeVoice = voices.find(v => v.activeDegree === null);
                            if (freeVoice) {
                                const targetFreq = midiToFreq(degreeToMidi(newDeg, rootMidi));
                                freeVoice.sin.frequency.setValueAtTime(targetFreq, ctx.currentTime);
                                freeVoice.tri.frequency.setValueAtTime(targetFreq, ctx.currentTime);
                                freeVoice.gain.gain.setValueAtTime(0, ctx.currentTime);
                                freeVoice.gain.gain.setTargetAtTime(0.07, ctx.currentTime, 0.6/3);
                                freeVoice.activeDegree = newDeg;
                                activeAckordDegrees.push(newDeg);
                            }
                        }
                    }
                    
                    const releaseTC = clamp(sentenceChars * 0.05, 2, 10);
                    voices.forEach(v => {
                        if (v.activeDegree !== null) {
                            v.gain.gain.setTargetAtTime(0, ctx.currentTime + 1.5, (releaseTC * 2.0) / 3); // Double release
                            v.activeDegree = null; 
                        }
                    });
                    
                    if (onSentenceCallback) {
                        onSentenceCallback({ length: sentenceChars });
                    }
                }
                
                prevSentenceDegrees = [...activeAckordDegrees];
                activeAckordDegrees = [];
                sentenceChars = 0; 
                sentenceLetters = 0; 
                currentWordChars = 0; 
                wordStartIx = null;
            } else {
                voices.forEach(v => {
                    if (v.activeDegree !== null) {
                        const cur = v.gain.gain.value;
                        v.gain.gain.setTargetAtTime(cur * 0.8, ctx.currentTime, 0.5/3);
                        v.gain.gain.setTargetAtTime(0.07, ctx.currentTime + 0.6, 1.0/3);
                    }
                });
            }
        } else if (/[0-9]/.test(key)) {
            // Tyst
        } else if (ALPHABET.includes(lowKey)) {
            currentWordChars++;
            if (currentWordChars === 1) wordStartIx = ALPHABET.indexOf(lowKey);
            sentenceChars++; 
            sentenceLetters++;
            charCounter++;
            if (charCounter % 15 === 0 && activeAckordDegrees.length > 0) {
                const lastDeg = activeAckordDegrees[activeAckordDegrees.length - 1];
                playGlimmer(lastDeg, stats.g);
            }
        }
    }

    return {
        init,
        destroy,
        handleKey,
        handleChar,
        setVolume,
        setDepth,
        mute: (m) => setVolume(m ? 0 : 0.6),
        onSentence: (cb) => { onSentenceCallback = cb; },
        getState
    };
})();
