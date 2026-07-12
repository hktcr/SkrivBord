const VindsusEngine = (function() {
    let ctx = null;
    let mainGain = null;
    let noiseSrc = null;
    let filter1 = null; // Low rumble
    let filter2 = null; // Mid howl
    let filter3 = null; // High whistle
    
    let midGain = null;
    let highGain = null;
    let lfo1, lfo2;
    
    let isInitialized = false;
    let masterVolume = 1.0;
    
    let sentenceChars = 0;
    let filter1Base = 150;
    
    // Buffer for white noise
    function createNoiseBuffer() {
        const bufferSize = ctx.sampleRate * 2; // 2 seconds
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const output = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        return buffer;
    }

    function init(audioContext, destinationNode) {
        if (isInitialized) return;
        ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
        
        mainGain = ctx.createGain();
        mainGain.gain.value = masterVolume;
        // destinationNode will typically be ctx.destination or a master compressor.
        // We handle fallback if destinationNode is not passed:
        mainGain.connect(destinationNode || ctx.destination);
        
        noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = createNoiseBuffer();
        noiseSrc.loop = true;
        
        // Base rumble
        filter1 = ctx.createBiquadFilter();
        filter1.type = 'lowpass';
        filter1.frequency.value = 150;
        
        // Mid howl (resonant)
        filter2 = ctx.createBiquadFilter();
        filter2.type = 'bandpass';
        filter2.Q.value = 8;
        filter2.frequency.value = 400;
        
        // High whistle (highly resonant)
        filter3 = ctx.createBiquadFilter();
        filter3.type = 'bandpass';
        filter3.Q.value = 15;
        filter3.frequency.value = 1200;
        
        // Parallel filters
        noiseSrc.connect(filter1);
        noiseSrc.connect(filter2);
        noiseSrc.connect(filter3);
        
        filter1.connect(mainGain);
        
        // Gain nodes for the resonant filters
        midGain = ctx.createGain();
        midGain.gain.value = 0.5;
        filter2.connect(midGain);
        midGain.connect(mainGain);
        
        highGain = ctx.createGain();
        highGain.gain.value = 0.15;
        filter3.connect(highGain);
        highGain.connect(mainGain);
        
        // Slow modulations to create the howling effect
        lfo1 = ctx.createOscillator();
        lfo1.type = 'sine';
        lfo1.frequency.value = 0.1; // 10 second cycle
        const lfo1Gain = ctx.createGain();
        lfo1Gain.gain.value = 200; // ±200 Hz
        lfo1.connect(lfo1Gain);
        lfo1Gain.connect(filter2.frequency);
        
        lfo2 = ctx.createOscillator();
        lfo2.type = 'triangle';
        lfo2.frequency.value = 0.05; // 20 second cycle
        const lfo2Gain = ctx.createGain();
        lfo2Gain.gain.value = 600; // ±600 Hz
        lfo2.connect(lfo2Gain);
        lfo2Gain.connect(filter3.frequency);
        
        noiseSrc.start();
        lfo1.start();
        lfo2.start();
        
        sentenceChars = 0;
        isInitialized = true;
    }

    function destroy() {
        if (!isInitialized) return;
        try {
            noiseSrc.stop();
            lfo1.stop();
            lfo2.stop();
        } catch (e) {}
        mainGain.disconnect();
        isInitialized = false;
        ctx = null;
    }

    function setVolume(v) {
        masterVolume = v;
        if (mainGain && ctx) {
            mainGain.gain.setTargetAtTime(v, ctx.currentTime, 0.1);
        }
    }

    function setDepth(val) {
        // Val = 0.0 to 1.0 (from settings). Map to Q-multiplier 0.5 to 1.5.
        const qMult = 0.5 + val;
        if (filter2) filter2.Q.setTargetAtTime(8 * qMult, ctx.currentTime, 0.5);
        if (filter3) filter3.Q.setTargetAtTime(15 * qMult, ctx.currentTime, 0.5);
    }

    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }
    
    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function handleKey(e) {
        if (!isInitialized || !ctx) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        
        const key = e.key || "";
        if (!key) return;
        
        if (ctx.state === 'suspended') ctx.resume();
        
        sentenceChars++;

        const stats = window.TextContext ? window.TextContext.getStats() : { 
            g: 1, fricRatio: 0.15, meanWordLen: 4.5, meanAlpha: 14, meanSentLen: 80 
        };
        
        // 10.2 Vindens karaktär ur texten
        const fricNorm = clamp((stats.fricRatio - 0.05) / 0.20, 0, 1);
        const wordNorm = clamp((stats.meanWordLen - 3) / 5, 0, 1);
        const alphaNorm = stats.meanAlpha / 28;
        
        const tNow = ctx.currentTime;
        
        highGain.gain.setTargetAtTime(lerp(0.05, 0.30, fricNorm), tNow, 2.0);
        filter1Base = lerp(110, 220, wordNorm);
        filter1.frequency.setTargetAtTime(filter1Base, tNow, 2.0);
        // lfo1 modulerar filter2.frequency, så base frekvensen ändras:
        // Notera att lfo1Gain adderas till base.
        // För att undvika klick, setTargetAtTime istället för value.
        // Vi sätter base utan LFO-noden. Wait, Web Audio API adderar lfo till base freq.
        // Men lfo1 är kopplad till filter2.freq. Dess base är vad vi sätter här.
        // Specen säger `filter2.freq (LFO-centrum) -> lerp(300, 550, alphaNorm)`
        filter2.frequency.setTargetAtTime(lerp(300, 550, alphaNorm), tNow, 2.0);
        midGain.gain.setTargetAtTime(lerp(0.35, 0.60, clamp(stats.meanSentLen / 120, 0, 1)), tNow, 2.0);
        
        // 10.3 Vindbyar med tröghet
        const byStyrka = stats.g;
        
        const currentMidFreq = filter2.frequency.value;
        const currentHighFreq = filter3.frequency.value;
        const isVowel = ['a','o','u','å','e','i','y','ä','ö'].includes(key.toLowerCase());
        
        if (key === ' ' || key === 'Enter') {
            // Djup by
            filter1.frequency.cancelScheduledValues(tNow);
            filter1.frequency.setValueAtTime(filter1.frequency.value, tNow);
            filter1.frequency.linearRampToValueAtTime(lerp(150, 400, byStyrka), tNow + 0.2);
            filter1.frequency.linearRampToValueAtTime(filter1Base, tNow + 1.5);
            
        } else if (key === '.' || key === '!' || key === '?') {
            // Långt svall vid meningsslut
            const fadeDur = clamp(sentenceChars * 0.03, 1.5, 4);
            
            mainGain.gain.cancelScheduledValues(tNow);
            mainGain.gain.setValueAtTime(mainGain.gain.value, tNow);
            mainGain.gain.linearRampToValueAtTime(masterVolume * 1.25, tNow + 0.5);
            mainGain.gain.linearRampToValueAtTime(masterVolume, tNow + 0.5 + fadeDur);
            
            sentenceChars = 0;
            
        } else {
            // Standardbokstav: volymtopp och visslingssvep
            mainGain.gain.cancelScheduledValues(tNow);
            mainGain.gain.setValueAtTime(mainGain.gain.value, tNow);
            mainGain.gain.linearRampToValueAtTime(masterVolume * (1 + 0.5 * byStyrka), tNow + 0.1);
            mainGain.gain.linearRampToValueAtTime(masterVolume, tNow + 0.8);
            
            const targetHigh = currentHighFreq + (isVowel ? 800 : 400) * byStyrka + 60;
            
            filter3.frequency.cancelScheduledValues(tNow);
            filter3.frequency.setValueAtTime(currentHighFreq, tNow);
            filter3.frequency.exponentialRampToValueAtTime(targetHigh, tNow + 0.15);
            filter3.frequency.exponentialRampToValueAtTime(1200, tNow + 1.2);
        }
    }

    return {
        init,
        destroy,
        setVolume,
        setDepth,
        handleKey
    };
})();

window.VindsusEngine = VindsusEngine;
