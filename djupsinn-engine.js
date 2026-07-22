/**
 * DjupsinnEngine — "Monolith: Djupsinn" (Ultimat Fokusmotor för Skrivr)
 * 
 * En psykoakustiskt optimerad ljudmotor för djupt skrivfokus (Deep Work).
 * Kombinerar:
 * 1. Adaptivt Brunt Brus (1/f² bullermaskering & skyddsbubbla)
 * 2. Varm A=432Hz Ambient Drone (LFO-böljande öppna kvinter)
 * 3. Haptisk Fysisk Modellering för tangentljud (trällslag, mellanslagsduns, dropp-enter, pappers-backspace)
 * 4. Semantisk & Rytmisk Respons (WPM, meningslängd, paus-detektion)
 */

export const DjupsinnEngine = (() => {
    let ctx = null;
    let masterGain = null;
    let globalVolume = 0.6;
    let effectDepth = 1.0;

    // Audio nodes
    let synthBus, dryGain, wetGain, compressor, convolver;
    let brownNoiseNode, brownNoiseFilter, brownNoiseGain;
    let droneOscs = [], droneGains = [], droneFilters = [], droneLFOs = [];
    let noiseBuffer = null;

    // State
    const ALPHABET = "abcdefghijklmnopqrstuvwxyzåäö";
    let isTyping = false;
    let typeHeat = 0.0;
    let lastKeyTime = 0;
    let idleTimer = null;
    let isIdle = true;
    let lastWpm = 0;

    // Helper math
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
    const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
    // A=432Hz tuning helper (432/440 ratio ≈ 0.981818)
    const midiToFreq432 = m => 432 * Math.pow(2, (m - 69) / 12);

    function getStats() {
        if (window.TextContext && typeof window.TextContext.getStats === 'function') {
            return window.TextContext.getStats();
        }
        return { meanSentLen: 60, vowelRatio: 0.38, words: 0 };
    }

    function createNoiseBuffer() {
        if (noiseBuffer) return;
        const size = ctx.sampleRate * 2.0; // 2s
        noiseBuffer = ctx.createBuffer(1, size, ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < size; i++) {
            const white = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168980;
            output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.06;
            b6 = white * 0.115926;
        }
    }

    function createImpulseResponse() {
        const length = ctx.sampleRate * 3.5;
        const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let channel = 0; channel < 2; channel++) {
            const channelData = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                const env = Math.pow(1 - (i / length), 2.5);
                channelData[i] = (Math.random() * 2 - 1) * env;
            }
        }
        return impulse;
    }

    function init(audioContext) {
        ctx = audioContext || ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (!ctx) return;
        if (masterGain) return; // Already initialized

        createNoiseBuffer();

        // Dynamics & Master
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 12;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.01;
        compressor.release.value = 0.15;
        compressor.connect(ctx.destination);

        masterGain = ctx.createGain();
        masterGain.gain.value = globalVolume;
        masterGain.connect(compressor);

        dryGain = ctx.createGain(); dryGain.gain.value = 0.7;
        wetGain = ctx.createGain(); wetGain.gain.value = 0.3;

        convolver = ctx.createConvolver();
        convolver.buffer = createImpulseResponse();

        dryGain.connect(masterGain);
        wetGain.connect(convolver);
        convolver.connect(masterGain);

        synthBus = ctx.createGain();
        synthBus.gain.value = 1.0;
        synthBus.connect(dryGain);
        synthBus.connect(wetGain);

        // --- 1. Adaptivt Brunt Brus (Skyddsbubbla) ---
        if (noiseBuffer) {
            brownNoiseNode = ctx.createBufferSource();
            brownNoiseNode.buffer = noiseBuffer;
            brownNoiseNode.loop = true;

            brownNoiseFilter = ctx.createBiquadFilter();
            brownNoiseFilter.type = 'lowpass';
            brownNoiseFilter.frequency.value = 250;

            brownNoiseGain = ctx.createGain();
            brownNoiseGain.gain.value = 0.025; // Subtilt bakgrundsbrus

            brownNoiseNode.connect(brownNoiseFilter);
            brownNoiseFilter.connect(brownNoiseGain);
            brownNoiseGain.connect(masterGain);
            brownNoiseNode.start();
        }

        // --- 2. Varm A=432Hz Ambient Drone ---
        // Ackord: A2 (45), E3 (52), A3 (57), E4 (64)
        const droneNotes = [45, 52, 57, 64];
        droneOscs = []; droneGains = []; droneFilters = []; droneLFOs = [];

        droneNotes.forEach((midiNote, idx) => {
            const osc = ctx.createOscillator();
            osc.type = (idx % 2 === 0) ? 'sine' : 'triangle';
            osc.frequency.value = midiToFreq432(midiNote);

            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 350 + idx * 80;

            const gainNode = ctx.createGain();
            gainNode.gain.value = 0.015 / (idx + 1);

            // LFO för böljande rymd-textur
            const lfo = ctx.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = 0.02 + idx * 0.013;
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = 60 + idx * 20;

            lfo.connect(lfoGain);
            lfoGain.connect(filter.frequency);
            lfo.start();

            osc.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(synthBus);
            osc.start();

            droneOscs.push(osc);
            droneGains.push(gainNode);
            droneFilters.push(filter);
            droneLFOs.push({ osc: lfo, gain: lfoGain });
        });

        // Heat decay interval
        setInterval(() => {
            if (typeHeat > 0) {
                typeHeat = Math.max(0, typeHeat - 0.04);
            }
        }, 100);
    }

    function setVolume(val) {
        globalVolume = val;
        if (masterGain) masterGain.gain.setTargetAtTime(val, ctx.currentTime, 0.1);
    }

    function setDepth(val) {
        effectDepth = val;
        if (wetGain) wetGain.gain.setTargetAtTime(0.15 + (0.35 * val), ctx.currentTime, 0.1);
    }

    function wakeUp() {
        const now = ctx ? ctx.currentTime : 0;
        if (isIdle) {
            isIdle = false;
            // När man skriver sänks bruna bruset svagt till standardnivå
            if (brownNoiseGain) brownNoiseGain.gain.setTargetAtTime(0.02, now, 1.0);
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!ctx) return;
            isIdle = true;
            // Vid paus (>3s) sväller det bruna bruset upp (+1.5dB) för att skydda fokusbubblan
            if (brownNoiseGain) brownNoiseGain.gain.setTargetAtTime(0.045, ctx.currentTime, 2.5);
        }, 3200);
    }

    // --- Syntetiserad Fysisk Modellering (Transienter) ---

    function playFeltWoodKey(key, time) {
        if (!ctx) return;
        const lowKey = key.toLowerCase();

        // Karplus-Strong / Filt-mot-trä transient
        const osc = ctx.createOscillator();
        osc.type = 'sine';

        // Bokstavstoner baserade på alfabetet
        const idx = ALPHABET.indexOf(lowKey);
        const pitch = (idx !== -1) ? 220 + (idx % 12) * 15 : 240;
        osc.frequency.setValueAtTime(pitch, time);
        osc.frequency.exponentialRampToValueAtTime(80, time + 0.025);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1100 + (typeHeat * 300), time);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.18, time + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.035);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(synthBus);

        osc.start(time);
        osc.stop(time + 0.04);
        osc.onended = () => { try { filter.disconnect(); gain.disconnect(); } catch(e){} };
    }

    function playSpaceThud(time) {
        if (!ctx) return;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(110, time);
        osc.frequency.exponentialRampToValueAtTime(40, time + 0.05);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 500;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.25, time + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.07);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(synthBus);

        osc.start(time);
        osc.stop(time + 0.08);
        osc.onended = () => { try { filter.disconnect(); gain.disconnect(); } catch(e){} };
    }

    function playResonantEnter(time) {
        if (!ctx) return;
        // Djup analog droppe med katedral-reverb
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(280, time);
        osc.frequency.exponentialRampToValueAtTime(55, time + 0.25);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.35, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

        const send = ctx.createGain();
        send.gain.value = 0.55;

        osc.connect(gain);
        gain.connect(synthBus);
        gain.connect(send);
        send.connect(convolver);

        osc.start(time);
        osc.stop(time + 0.45);
        osc.onended = () => { try { gain.disconnect(); send.disconnect(); } catch(e){} };
    }

    function playPaperBackspace(time) {
        if (!ctx) return;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1800;
        filter.Q.value = 2.5;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.08, time + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

        src.connect(filter);
        filter.connect(gain);
        gain.connect(synthBus);

        src.start(time);
        src.stop(time + 0.05);
        src.onended = () => { try { filter.disconnect(); gain.disconnect(); } catch(e){} };
    }

    function handleChar(key) {
        if (!ctx) init(null);
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();

        const now = ctx.currentTime;
        typeHeat = Math.min(1.0, typeHeat + 0.08);
        wakeUp();

        // Semantisk rumsakustik & filteröppning baserat på WPM & meningslängd
        const stats = getStats();
        if (stats && stats.meanSentLen && wetGain) {
            const wetTarget = clamp(0.2 + (stats.meanSentLen / 120) * 0.35, 0.2, 0.65);
            wetGain.gain.setTargetAtTime(wetTarget, now, 0.8);
        }

        if (key === '\n' || key === 'Enter') {
            playResonantEnter(now);
        } else if (key === ' ' || key === 'Space') {
            playSpaceThud(now);
        } else if (key === '\b' || key === 'Backspace' || key === 'Delete') {
            playPaperBackspace(now);
        } else {
            playFeltWoodKey(key, now);
        }
    }

    function handleKey(e) {
        if (e && e.key) handleChar(e.key);
    }

    function destroy() {
        clearTimeout(idleTimer);
        if (brownNoiseNode) {
            try { brownNoiseNode.stop(); brownNoiseNode.disconnect(); } catch(e){}
            brownNoiseNode = null;
        }
        droneOscs.forEach(o => { try { o.stop(); o.disconnect(); } catch(e){} });
        droneLFOs.forEach(l => { try { l.osc.stop(); l.osc.disconnect(); } catch(e){} });
        droneOscs = []; droneGains = []; droneFilters = []; droneLFOs = [];
        if (masterGain) {
            try { masterGain.disconnect(); } catch(e){}
            masterGain = null;
        }
        ctx = null;
    }

    return {
        init,
        setVolume,
        setDepth,
        destroy,
        handleKey,
        handleChar,
        getState: () => ({ heat: typeHeat, isIdle })
    };
})();
