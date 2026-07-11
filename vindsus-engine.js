const VindsusEngine = (function() {
    let ctx = null;
    let mainGain = null;
    let noiseSrc = null;
    let filter1 = null; // Low rumble
    let filter2 = null; // Mid howl
    let filter3 = null; // High whistle
    
    let isInitialized = false;
    let masterVolume = 1.0;
    
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

    let lfo1, lfo2;

    function init(audioContext, destinationNode) {
        if (isInitialized) return;
        ctx = audioContext;
        
        mainGain = ctx.createGain();
        mainGain.gain.value = masterVolume;
        mainGain.connect(destinationNode);
        
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
        
        // Gain nodes for the resonant filters to control their volume separately
        const midGain = ctx.createGain();
        midGain.gain.value = 0.5;
        filter2.connect(midGain);
        midGain.connect(mainGain);
        
        const highGain = ctx.createGain();
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
    }

    function setVolume(v) {
        masterVolume = v;
        if (mainGain) {
            mainGain.gain.setTargetAtTime(v, ctx.currentTime, 0.1);
        }
    }

    function setDepth(val) {
        // Unused for now, maybe map to resonance?
    }

    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    function handleKey(key) {
        if (!isInitialized) return;
        
        // On keypress, trigger a "gust" of wind by briefly raising the filter frequencies
        // and increasing the main gain slightly.
        
        const currentMidFreq = filter2.frequency.value;
        const currentHighFreq = filter3.frequency.value;
        
        // Brief volume bump
        const currentVol = mainGain.gain.value;
        mainGain.gain.cancelScheduledValues(ctx.currentTime);
        mainGain.gain.setValueAtTime(currentVol, ctx.currentTime);
        mainGain.gain.linearRampToValueAtTime(masterVolume * 1.5, ctx.currentTime + 0.1);
        mainGain.gain.linearRampToValueAtTime(masterVolume, ctx.currentTime + 0.8);
        
        // Brief pitch sweep for the "whoosh"
        const isVowel = ['a','o','u','å','e','i','y','ä','ö'].includes(key.toLowerCase());
        const targetHigh = currentHighFreq + (isVowel ? 800 : 400);
        
        filter3.frequency.cancelScheduledValues(ctx.currentTime);
        filter3.frequency.setValueAtTime(currentHighFreq, ctx.currentTime);
        filter3.frequency.exponentialRampToValueAtTime(targetHigh, ctx.currentTime + 0.15);
        filter3.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 1.2);
        
        if (key === ' ' || key === 'Enter') {
            // Deeper gust on space/enter
            filter1.frequency.cancelScheduledValues(ctx.currentTime);
            filter1.frequency.setValueAtTime(filter1.frequency.value, ctx.currentTime);
            filter1.frequency.linearRampToValueAtTime(400, ctx.currentTime + 0.2);
            filter1.frequency.linearRampToValueAtTime(150, ctx.currentTime + 1.5);
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
