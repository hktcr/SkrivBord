/**
 * SkogsklangEngine v2 "Glänta" (BYGGSPEC v5 + TILLÄGG v2)
 * 
 * En mjuk pad-syntes för SkrivR. Bygger upp ackord per mening (1 ton per ord, upp till 5).
 * Sväller vid meningsslut och tändar eldflugor via onSentence-callback.
 * 
 * v2: Toner blommar och vissnar, röster andas individuellt, mikrodrift i tonhöjd,
 *     ackord en oktav upp, kortare IR (glänta istf katedral), FM-glimmer (daggdroppe).
 * 
 * DETERMINISM: Ingen Math.random för tonhöjd, harmoni eller tonart.
 */

export const SkogsklangEngine = (() => {
    let ctx = null;
    let masterGain, dryGain, wetGain, compressor, convolver;
    let baseOsc, baseOscTri, baseGain;
    let droneOsc, droneGain;
    let breathLFO, breathLFOGain;
    let voiceFilter;
    
    // Ackordröster (1 till 5) med per-röst LFO:er
    let voices = [];
    let voiceLFOs = [];      // Ändring 2: amplitud-LFO per röst
    let voiceDriftLFOs = [];  // Ändring 3: mikrodrift i tonhöjd per röst
    
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

    // Ändring 6: Återblom-timer
    let rebloomInterval = null;

    
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

    // Ändring 7: IR 4.5s, decay 2.8 (glänta istf katedral)
    const createImpulseResponse = () => {
        const length = ctx.sampleRate * 4.5; // 4.5s (ändring 7, från 8s)
        const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let channel = 0; channel < 2; channel++) {
            const channelData = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                const env = Math.pow(1 - (i / length), 2.8); // decay 2.8 (ändring 7, från 3.2)
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
        
        // Ändring 7: wet default 0.35 (från 0.4)
        wetGain = ctx.createGain();
        wetGain.gain.value = 0.35;
        
        convolver = ctx.createConvolver();
        irBuffer = createImpulseResponse();
        convolver.buffer = irBuffer;
        
        wetGain.connect(convolver);
        convolver.connect(masterGain);
        
        // Ändring 7: Gemensamt lågpass 1400 Hz (från 1200), Q 0.5
        voiceFilter = ctx.createBiquadFilter();
        voiceFilter.type = 'lowpass';
        voiceFilter.frequency.value = 1400;
        voiceFilter.Q.value = 0.5;
        
        voiceFilter.connect(dryGain);
        voiceFilter.connect(wetGain);
        
        // Basrösten (Röst 0)
        baseOsc = ctx.createOscillator();
        baseOsc.type = 'sine';
        baseOscTri = ctx.createOscillator();
        baseOscTri.type = 'triangle';
        const baseTriGain = ctx.createGain();
        baseTriGain.gain.value = 0.15; // Ändring 4: 0.15 (från 0.3)
        baseOscTri.connect(baseTriGain);
        
        // Ändring 5: Basgain 0.035 (från 0.05)
        baseGain = ctx.createGain();
        baseGain.gain.value = 0.035;
        
        baseOsc.connect(baseGain);
        baseTriGain.connect(baseGain);
        baseGain.connect(voiceFilter);
        
        // Drone röst för H1 (lämna kvar klang)
        droneOsc = ctx.createOscillator();
        droneOsc.type = 'sine';
        droneGain = ctx.createGain();
        droneGain.gain.value = 0.0;
        droneOsc.connect(droneGain);
        droneGain.connect(voiceFilter);
        droneOsc.start();
        
        baseOsc.start();
        baseOscTri.start();
        
        // Ändring 5: Bas-andnings-LFO: 0.05 Hz, djup 0.014
        breathLFO = ctx.createOscillator();
        breathLFO.type = 'sine';
        breathLFO.frequency.value = 0.05; // Ändring 5: 0.05 Hz (marken häver sig)
        breathLFOGain = ctx.createGain();
        breathLFOGain.gain.value = 0.014; // Ändring 5: ±0.014
        breathLFO.connect(breathLFOGain);
        breathLFOGain.connect(baseGain.gain);
        breathLFO.start();
        
        // Ackordröster (1-5) med per-röst LFO:er
        voices = [];
        voiceLFOs = [];
        voiceDriftLFOs = [];
        for (let i = 0; i < 5; i++) {
            const oscSin = ctx.createOscillator();
            oscSin.type = 'sine';
            const oscTri = ctx.createOscillator();
            oscTri.type = 'triangle';
            
            // ±4 cent statisk detune (behålls)
            const detune = (i % 2 === 0 ? 4 : -4);
            oscSin.detune.value = detune;
            oscTri.detune.value = -detune;
            
            // Ändring 4: triangel-gain 0.15 (från 0.3)
            const triGain = ctx.createGain();
            triGain.gain.value = 0.15;
            oscTri.connect(triGain);
            
            const vGain = ctx.createGain();
            vGain.gain.value = 0.0; // Tyst initialt
            
            oscSin.connect(vGain);
            triGain.connect(vGain);
            vGain.connect(voiceFilter);
            
            oscSin.start();
            oscTri.start();
            
            // Ändring 2: Amplitud-LFO per röst (deterministisk)
            const ampLFO = ctx.createOscillator();
            ampLFO.type = 'sine';
            ampLFO.frequency.value = 0.07 + i * 0.023; // Olika per röst, aldrig slumpad
            const ampLFOGain = ctx.createGain();
            ampLFOGain.gain.value = 0.012; // Additivt på gain
            ampLFO.connect(ampLFOGain);
            ampLFOGain.connect(vGain.gain); // Modulerar röstens gain
            ampLFO.start();
            voiceLFOs.push({ osc: ampLFO, gain: ampLFOGain });
            
            // Ändring 3: Mikrodrift i tonhöjd per röst (deterministisk)
            const driftLFO = ctx.createOscillator();
            driftLFO.type = 'triangle';
            driftLFO.frequency.value = 0.031 + i * 0.017; // Olika per röst
            const driftGain = ctx.createGain();
            driftGain.gain.value = 4; // ±4 cent
            driftLFO.connect(driftGain);
            driftGain.connect(oscSin.detune); // Adderas till befintlig detune
            driftGain.connect(oscTri.detune);
            driftLFO.start();
            voiceDriftLFOs.push({ osc: driftLFO, gain: driftGain });
            
            voices.push({
                sin: oscSin,
                tri: oscTri,
                gain: vGain,
                activeDegree: null,
                litAt: 0 // Ändring 6: när tonen tändes
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

        // Ändring 6: Återblom-tick var 500ms (använder befintlig tidsbudget)
        rebloomInterval = setInterval(rebloomTick, 500);
    }

    function destroy() {
        if (!ctx) return;
        clearTimeout(idleTimer);
        if (rebloomInterval) { clearInterval(rebloomInterval); rebloomInterval = null; }
        try {
            baseOsc.stop(); baseOscTri.stop();
            if (droneOsc) droneOsc.stop();
            if (breathLFO) breathLFO.stop();
            voiceLFOs.forEach(l => l.osc.stop());
            voiceDriftLFOs.forEach(l => l.osc.stop());
            voices.forEach(v => { v.sin.stop(); v.tri.stop(); });
            if (idleLFO) idleLFO.stop();
        } catch(e) {}
        ctx = null;
    }

    function setVolume(val) {
        if (masterGain) masterGain.gain.setTargetAtTime(Math.pow(val, 1.6) * 0.9, ctx.currentTime, 0.1);
    }

    function setDepth(val) {
        // Ändring 7: wet baseline 0.2 + 0.15 * val (justerat för mindre rum)
        if (wetGain) wetGain.gain.setTargetAtTime(0.2 + 0.15 * val, ctx.currentTime, 0.1);
    }
    
    // Ändring 8: Glimmer → daggdroppe (FM-pling)
    function playGlimmer(degree, g = 1.0) {
        if (!ctx) return;
        // Kvint (+7 halvtoner), en oktav mörkare
        const freq = midiToFreq(degreeToMidi(degree, rootMidi) + 7) * 0.5;
        
        // Bärare: sinus
        const carrier = ctx.createOscillator();
        carrier.type = 'sine';
        carrier.frequency.value = freq;
        
        // Modulator: FM med ratio 3.01, index startar 60 Hz → 0
        const modulator = ctx.createOscillator();
        modulator.type = 'sine';
        modulator.frequency.value = freq * 3.01;
        const modGain = ctx.createGain();
        modGain.gain.setValueAtTime(60, ctx.currentTime); // FM-index 60 Hz
        modGain.gain.setTargetAtTime(0, ctx.currentTime, 0.13); // Decayar snabbt
        modulator.connect(modGain);
        modGain.connect(carrier.frequency); // FM: modulerar bärarens frekvens
        
        const gain = ctx.createGain();
        const maxG = 0.03 * g; // Ändring 8: gain 0.03 (från 0.015)
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.setTargetAtTime(maxG, ctx.currentTime, 0.08 / 3); // Snabb attack
        gain.gain.setTargetAtTime(0, ctx.currentTime + 0.15, 0.8 / 3); // 0.8s uttoning
        
        carrier.connect(gain);
        gain.connect(wetGain); // Endast wet-kanal
        
        carrier.start();
        modulator.start();
        carrier.stop(ctx.currentTime + 2.5);
        modulator.stop(ctx.currentTime + 2.5);
    }

    function getState() {
        return {
            pitchNorm: clamp(currentDegree / 12, 0, 1),
            tempoNorm: clamp((dtEma - 90) / (1400 - 90), 0, 1),
            idle: isIdle,
            voicesActive: activeAckordDegrees.length
        };
    }

    // Ändring 6: Återblom — toner blommar periodiskt
    function rebloomTick() {
        if (!ctx || isIdle) return;
        const now = ctx.currentTime;
        voices.forEach(v => {
            if (v.activeDegree === null) return;
            const period = 6 + v.activeDegree * 0.7; // Olika per ton, deterministiskt
            const elapsed = now - v.litAt;
            if (elapsed > 0 && elapsed % period < 0.5) {
                // Återblom: gain puls upp och ner
                const currentTarget = 0.035; // Viloglöd-nivån
                v.gain.gain.setTargetAtTime(currentTarget * 1.4, now, 0.3 / 3);
                v.gain.gain.setTargetAtTime(currentTarget, now + 0.5, 1.5);
            }
        });
    }

    function wakeUp() {
        if (isIdle) {
            isIdle = false;
            // Ändring 5: bas vaknar till 0.035 (från 0.05)
            baseGain.gain.setTargetAtTime(0.035, ctx.currentTime, 1.0);
            // Andningen vaknar
            if (breathLFO) breathLFO.frequency.setTargetAtTime(0.08, ctx.currentTime, 1.0);
            if (breathLFOGain) breathLFOGain.gain.setTargetAtTime(0.014, ctx.currentTime, 0.5);
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!ctx) return;
            isIdle = true;
            baseGain.gain.setTargetAtTime(0.02, ctx.currentTime, 2.0);
            // Vila: djup, långsam andning
            if (breathLFO) breathLFO.frequency.setTargetAtTime(0.04, ctx.currentTime, 3.0);
            if (breathLFOGain) breathLFOGain.gain.setTargetAtTime(0.016, ctx.currentTime, 2.0);
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

    // Ändring 1 + 4: Tonen blommar (peak 0.09 → sjunker till 0.035 viloglöd)
    // Ändring 4: Frekvens +12 halvtoner (en oktav upp)
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
        
        // Ändring 4: +12 halvtoner (en oktav upp) för luft mellan bas och ackord
        const f = midiToFreq(degreeToMidi(newDeg, rootMidi) + 12);
        v.sin.frequency.setValueAtTime(f, ctx.currentTime);
        v.tri.frequency.setValueAtTime(f, ctx.currentTime);
        
        // Ändring 1: Bloom-envelopp — peak 0.09, sedan sjunker till 0.035 viloglöd
        const attackTC = lerp(1.2, 3.5, tempoNorm) / 3;
        const attackTime = attackTC * 3; // Ungefärlig tid till peak
        v.gain.gain.setValueAtTime(0, ctx.currentTime);
        v.gain.gain.setTargetAtTime(0.09, ctx.currentTime, attackTC); // Peak
        v.gain.gain.setTargetAtTime(0.035, ctx.currentTime + attackTime + 0.5, 4.0); // Sjunker till viloglöd
        
        v.activeDegree = newDeg;
        v.litAt = ctx.currentTime; // Ändring 6: registrera tändningstid
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

        // Andningsrytm följer skrivtempot (ändring 5)
        const breathRate = lerp(0.12, 0.05, tempoNorm); // Justerat för bas-LFO
        if (breathLFO) breathLFO.frequency.setTargetAtTime(breathRate, ctx.currentTime, 2.0);

        // 3.3 Tonart och skalfärg baserat på aktuell sektion
        const sVowelRatio = stats.section_vowelRatio !== undefined ? stats.section_vowelRatio : stats.vowelRatio;
        let baseDurScale = isDurScale;
        if (sVowelRatio > 0.42) baseDurScale = true;
        if (sVowelRatio < 0.40) baseDurScale = false;
        
        isDurScale = (stats.lastHeadingLevel >= 3) ? !baseDurScale : baseDurScale;

        const verseSteps = [0, 7, -5, 2, -3, 4, 9, 5, -2, -7]; // Kvart/kvint-cirkeln inspirerat
        const harmonicShiftCount = stats.harmonicShiftCount || 0;
        const sectionRootMidi = clamp(48 + verseSteps[harmonicShiftCount % verseSteps.length], 36, 60);
        
        if (sectionRootMidi !== rootMidi) {
            // H1 / H2 Skifte detekterat! 
            // Aktivera drönaren på den GAMLA basfrekvensen
            if (droneOsc && droneGain) {
                const oldRootFreq = midiToFreq(rootMidi) / 2;
                droneOsc.frequency.setValueAtTime(oldRootFreq, ctx.currentTime);
                // Mjuk attack upp till drönarens peak (t.ex. 0.02)
                droneGain.gain.setTargetAtTime(0.015, ctx.currentTime, 0.5);
                // Därefter extremt långsam fadeout (ca 12 sekunder drone-release)
                droneGain.gain.setTargetAtTime(0, ctx.currentTime + 1.0, 4.0);
            }
            rootMidi = sectionRootMidi; 
        }

        // H3: Filter brightness
        const targetFilterFreq = (stats.lastHeadingLevel >= 3) ? 2200 : 1400;
        if (voiceFilter) voiceFilter.frequency.setTargetAtTime(targetFilterFreq, ctx.currentTime, 2.0);

        if (!key) return;
        if (key === '\n') key = 'Enter';
        else if (key === '\b') key = 'Backspace';
        const lowKey = key.toLowerCase();

        // 3.4 Basrösten (Global kontext)
        const baseRootMidi = 48; // Fast ankare för basen
        const centerDegree = 2 + (stats.meanAlpha / 28) * 8;
        const baseTargetFreq = midiToFreq(degreeToMidi(Math.round(centerDegree), baseRootMidi)) / 2;
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
                    // Ändring 1: sväll relativt peak 0.09
                    const maxGain = key === '!' ? 0.09 * 1.35 : 0.09 * 1.20; // +35% resp +20%
                    voices.forEach(v => {
                        if (v.activeDegree !== null) {
                            v.gain.gain.setTargetAtTime(maxGain, ctx.currentTime, 0.8/3); // 0.8s swell
                        }
                    });
                    
                    if (key === '?') {
                        const highestDeg = Math.max(...activeAckordDegrees, 0);
                        const newDeg = getNextFreeDegree(highestDeg + 2);
                        if (newDeg !== null) {
                            const freeVoice = voices.find(v => v.activeDegree === null);
                            if (freeVoice) {
                                // Ändring 4: +12 halvtoner
                                const targetFreq = midiToFreq(degreeToMidi(newDeg, rootMidi) + 12);
                                freeVoice.sin.frequency.setValueAtTime(targetFreq, ctx.currentTime);
                                freeVoice.tri.frequency.setValueAtTime(targetFreq, ctx.currentTime);
                                freeVoice.gain.gain.setValueAtTime(0, ctx.currentTime);
                                freeVoice.gain.gain.setTargetAtTime(0.09, ctx.currentTime, 0.6/3);
                                freeVoice.activeDegree = newDeg;
                                freeVoice.litAt = ctx.currentTime;
                                activeAckordDegrees.push(newDeg);
                            }
                        }
                    }
                    
                    const releaseTC = clamp(sentenceChars * 0.05, 2, 10);
                    voices.forEach(v => {
                        if (v.activeDegree !== null) {
                            v.gain.gain.setTargetAtTime(0, ctx.currentTime + 1.5, releaseTC / 3);
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
                // Komma/semikolon/kolon: mjuk dipp
                voices.forEach(v => {
                    if (v.activeDegree !== null) {
                        const cur = v.gain.gain.value;
                        v.gain.gain.setTargetAtTime(cur * 0.8, ctx.currentTime, 0.5/3);
                        v.gain.gain.setTargetAtTime(0.035, ctx.currentTime + 0.6, 1.0/3); // Tillbaka till viloglöd
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
            // Ändring 8: Glimmer var 4:e bokstav (specen säger var 4:e, ändrat från var 15:e)
            if (charCounter % 4 === 0 && activeAckordDegrees.length > 0) {
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
