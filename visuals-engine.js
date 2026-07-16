/**
 * VisualsEngine
 * 
 * Hanterar Sonogram, Djupvatten-bakgrund och Mareld-mål för SkrivR.
 * Använder en gemensam requestAnimationFrame-loop för prestanda.
 */

export const VisualsEngine = (() => {
    let sonogramCanvas, sonoCtx;
    let mareldCanvas, mareldCtx;
    let djupvattenContainer = null;
    let djupvattenLayers = [];
    
    // Configs
    let config = {
        sonogramEnabled: false,
        djupvattenEnabled: false,
        mareldEnabled: false,
        mareldGoalType: 'words', // 'words' or 'time'
        mareldStartTime: 0,
        mareldStartChars: 0,
        skogstemaMode: false,
        fireflyMode: 'sentence', // 'sentence', 'goal', 'off'
        goalProgress: 0,
        prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
    };

    // Data structures
    let traces = [];
    const MAX_TRACES = 400; // Ringbuffert storlek
    let traceHead = 0;
    
    const sparks = new Array(120).fill(null).map(() => ({ active: false }));
    
    let isLoopRunning = false;
    let rAFId = null;
    let lastTime = 0;
    
    // Valsang state ref
    let getValsangState = null;
    
    // DOM nodes
    let mareldVeil = null;

    function init(domElements, valsangStateGetter) {
        getValsangState = valsangStateGetter;
        
        sonogramCanvas = domElements.sonogramCanvas;
        if (sonogramCanvas) sonoCtx = sonogramCanvas.getContext('2d', { alpha: true });
        
        mareldCanvas = domElements.mareldCanvas;
        if (mareldCanvas) {
            mareldCtx = mareldCanvas.getContext('2d', { alpha: true });
            mareldCanvas.width = window.innerWidth;
            mareldCanvas.height = window.innerHeight;
            // Limit DPR
            const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
            mareldCanvas.width *= dpr;
            mareldCanvas.height *= dpr;
            mareldCtx.scale(dpr, dpr);
        }
        
        djupvattenContainer = domElements.djupvattenContainer;
        djupvattenLayers = domElements.djupvattenLayers || [];
        mareldVeil = domElements.mareldVeil;
        
        // Setup Resize
        window.addEventListener('resize', () => {
            if (mareldCanvas) {
                const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
                mareldCanvas.width = window.innerWidth * dpr;
                mareldCanvas.height = window.innerHeight * dpr;
                mareldCtx.scale(dpr, dpr);
            }
            if (sonogramCanvas) {
                sonogramCanvas.width = window.innerWidth;
            }
        });
        
        // Visibility
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopLoop();
            } else {
                startLoop();
            }
        });
        
        // Throttle Djupvatten updates (max 150ms)
        setInterval(updateDjupvatten, 150);
        
        // Ticker for Mareld time goal
        setInterval(tickTimeGoal, 500);
    }

    function setConfig(newConfig) {
        config = { ...config, ...newConfig };
        
        // Vindsus-läget tvingar bort havstemat
        if (config.skogstemaMode) {
            config.djupvattenEnabled = false;
            if (config.sonogramEnabled) {
                config.sonogramEnabled = false;
                if (sonogramCanvas && sonoCtx) {
                    sonoCtx.clearRect(0, 0, sonogramCanvas.width, sonogramCanvas.height);
                }
            }
        }
        
        if (!config.djupvattenEnabled) {
            djupvattenLayers.forEach(l => l.style.opacity = '0');
            if (djupvattenContainer) djupvattenContainer.style.backgroundColor = 'transparent';
        } else {
            djupvattenLayers.forEach(l => l.style.opacity = '1');
            if (djupvattenContainer) djupvattenContainer.style.backgroundColor = '#08101a';
            updateDjupvatten(); // Initial
        }
        
        if (!config.mareldEnabled && mareldVeil) {
            mareldVeil.style.opacity = '0';
        }
        
        startLoop();
    }
    
    function resetMareld(currentChars) {
        config.mareldStartTime = performance.now();
        config.mareldStartChars = currentChars;
        if (mareldVeil) mareldVeil.style.opacity = '0';
        startLoop();
    }
    
    function setGoal(type, target, currentChars) {
        setConfig({
            mareldEnabled: true,
            mareldGoalType: type,
            mareldGoalTarget: target
        });
        resetMareld(currentChars);
    }

    function addTrace(pt) {
        if (!config.sonogramEnabled) return;
        traces[traceHead] = { ...pt, born: performance.now() };
        traceHead = (traceHead + 1) % MAX_TRACES;
        startLoop();
    }
    
    function getMareldProgress(currentChars) {
        if (!config.mareldEnabled) return 0;
        let p = 0;
        if (config.mareldGoalType === 'words') {
            // Re-using the word goal as char goal since standard SkrivR aims for characters/words?
            // Actually goalType 'words' could mean characters depending on SkrivR setting, we assume target is numeric value
            const written = Math.max(0, currentChars - config.mareldStartChars);
            p = written / config.mareldGoalTarget;
        } else if (config.mareldGoalType === 'time') {
            const elapsedMins = (performance.now() - config.mareldStartTime) / 60000;
            p = elapsedMins / config.mareldGoalTarget;
        }
        return p;
    }
    
    function getMareldIntensity(p) {
        if (p < 0.5) return 0;
        if (p >= 1.0) return 1;
        const norm = (p - 0.5) / 0.5;
        return norm * norm; // Quadratic
    }

    function handleKey(currentChars) {
        if (!config.mareldEnabled || config.prefersReducedMotion) return;
        
        const p = getMareldProgress(currentChars);
        const i = getMareldIntensity(p);
        
        updateVeil(p);
        
        if (i > 0) {
            const count = 1 + Math.floor(4 * i);
            spawnSparks(count, i);
            startLoop();
        }
    }
    
    function tickTimeGoal() {
        if (!config.mareldEnabled || config.mareldGoalType !== 'time' || config.prefersReducedMotion) return;
        const p = getMareldProgress(0); // For time, currentChars doesn't matter
        const i = getMareldIntensity(p);
        updateVeil(p);
        if (i > 0 && Math.random() < 0.5) {
            spawnSparks(1, i);
            startLoop();
        }
    }

    function updateVeil(p) {
        if (!mareldVeil) return;
        if (p >= 1.0) {
            let overage = 0;
            if (config.mareldGoalType === 'time') {
                const elapsedMins = (performance.now() - config.mareldStartTime) / 60000;
                overage = (elapsedMins - config.mareldGoalTarget) * 60; // seconds over
                overage = Math.min(1, Math.max(0, overage / 30.0)); // 30s window
            } else {
                // assume ~5 chars per word, so if target is words, overage in chars?
                // The spec says 50 tecken. 
                // Let's assume the user logic passes the actual metric. We'll use 50 units for simplicity.
                const written = Math.max(0, (window._charsTotal || 0) - config.mareldStartChars);
                const over = written - config.mareldGoalTarget;
                overage = Math.min(1, Math.max(0, over / 50.0));
            }
            
            if (config.skogstemaMode) {
                mareldVeil.style.opacity = '0';
            } else {
                const opacity = 0.25 + (0.97 - 0.25) * overage;
                mareldVeil.style.opacity = opacity.toFixed(2);
            }
        } else {
            mareldVeil.style.opacity = '0';
        }
    }

    function spawnSparks(count, intensity) {
        if (config.skogstemaMode) {
            count = Math.max(1, Math.floor(count / 2)); // Färre eldflugor vid tangenttryck
        }
        
        let spawned = 0;
        for (let i = 0; i < sparks.length; i++) {
            if (!sparks[i].active) {
                const s = sparks[i];
                s.active = true;
                s.x = Math.random() * window.innerWidth;
                s.y = window.innerHeight * (0.3 + 0.5 * Math.random()); // 30-80% height
                
                if (config.skogstemaMode) {
                    s.vx = (Math.random() * 30 + 10) * (Math.random() > 0.5 ? 1 : -1);
                    s.vy = -Math.random() * 20 - 5;
                    s.maxLife = Math.random() * 4 + 3 + intensity * 2;
                    s.life = s.maxLife;
                } else {
                    s.vx = (Math.random() - 0.5) * 20;
                    s.vy = -30 - Math.random() * 40;
                    s.maxLife = 0.8 + Math.random() * 1.2 + intensity;
                    s.life = s.maxLife;
                }
                
                spawned++;
                if (spawned >= count) break;
            }
        }
    }
    
    function spawnAmbientEldfluga() {
        let emptyIdx = sparks.findIndex(s => !s.active);
        if (emptyIdx === -1) emptyIdx = Math.floor(Math.random() * sparks.length);
        
        const s = sparks[emptyIdx];
        s.active = true;
        s.type = 'ambient';
        s.x = Math.random() * window.innerWidth;
        s.y = Math.random() * window.innerHeight;
        s.vx = (Math.random() * 20 + 5) * (Math.random() > 0.5 ? 1 : -1);
        s.vy = -Math.random() * 15 - 2;
        s.maxLife = Math.random() * 6 + 4;
        s.life = s.maxLife;
    }

    function spawnSentenceFirefly(length) {
        if (!config.skogstemaMode || config.fireflyMode !== 'sentence') return;
        
        // Mappning enligt spec
        const norm = clamp((length - 15) / (150 - 15), 0, 1);
        
        // Find empty slot or oldest
        let targetIdx = sparks.findIndex(s => !s.active);
        if (targetIdx === -1) {
            // Find oldest
            let oldestLife = Infinity;
            for (let i = 0; i < sparks.length; i++) {
                if (sparks[i].life < oldestLife) {
                    oldestLife = sparks[i].life;
                    targetIdx = i;
                }
            }
        }
        
        const s = sparks[targetIdx];
        s.active = true;
        s.type = 'sentence';
        s.norm = norm;
        s.x = Math.random() * window.innerWidth;
        
        const spawnYCenter = lerp(0.15, 0.75, norm) * window.innerHeight;
        s.y = spawnYCenter + (Math.random() * 0.2 - 0.1) * window.innerHeight;
        
        s.vx = (Math.random() * 20 + 5) * (Math.random() > 0.5 ? 1 : -1);
        s.vy = -Math.random() * 10 - 2; // Drift
        
        // Sinus-parametrar för drift
        s.driftPhaseX = Math.random() * Math.PI * 2;
        s.driftPhaseY = Math.random() * Math.PI * 2;
        s.driftFreqX = 1 / (6 + Math.random() * 8); // 6-14s period
        s.driftFreqY = 1 / (6 + Math.random() * 8);
        
        // Blinkparametrar
        s.blinkPhase = 0;
        s.blinkState = 'attack'; // attack, sustain, release, dark
        s.blinkTimer = 0;
        s.darkDuration = 1.5 + Math.random() * 2.5; // 1.5-4s
        
        s.maxLife = Infinity; // Lever tills den tvingas bort (fast pool)
        s.life = 1000; // Högt värde
        
        startLoop();
    }
    
    function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }
    function lerp(a, b, t) { return a + (b - a) * t; }

    function updateDjupvatten() {
        if (!config.djupvattenEnabled || config.prefersReducedMotion || !getValsangState) return;
        const state = getValsangState();
        
        // Layer 0: Ytljus (Pitch)
        const l0 = djupvattenLayers[0];
        if (l0) {
            // Y: mapped from pitchNorm (0..1)
            const y = -40 + (1 - state.pitchNorm) * 80; // Range: -40% to +40%
            l0.style.transform = `translate3d(0, ${y.toFixed(1)}%, 0) scale(1.8)`;
            l0.style.opacity = state.idle ? '0.2' : '0.85';
            l0.style.filter = `hue-rotate(${(state.pitchNorm - 0.5) * 60}deg)`;
        }
        
        // Layer 1: Ström (Tempo)
        const l1 = djupvattenLayers[1];
        if (l1) {
            // Moves horizontally based on tempoNorm
            const speed = 10 + state.tempoNorm * 15; // 10s to 25s
            const t = (performance.now() / (speed * 1000)) % 1;
            const x = -30 + Math.sin(t * Math.PI * 2) * 60; // -90% to +30%
            const y = Math.cos(t * Math.PI * 2) * 20;
            l1.style.transform = `translate3d(${x.toFixed(1)}%, ${y.toFixed(1)}%, 0) scale(2.2)`;
            l1.style.opacity = state.idle ? '0.3' : '0.9';
        }
        
        // Layer 2: Djupet (Pulse)
        const l2 = djupvattenLayers[2];
        if (l2) {
            // Very slow pulse
            const t = (performance.now() / 12000) % 1;
            const s = 1.5 + Math.sin(t * Math.PI * 2) * 0.4 + (state.idle ? 0 : 0.3);
            l2.style.transform = `translate3d(0, 0, 0) scale(${s.toFixed(2)})`;
            l2.style.opacity = state.idle ? '0.4' : '1.0';
        }
    }

    function triggerDive() {
        if (!config.djupvattenEnabled || !djupvattenLayers[0]) return;
        const container = djupvattenLayers[0].parentElement;
        if (container) {
            container.style.transition = 'background-color 3s';
            container.style.backgroundColor = '#020a12';
            setTimeout(() => {
                container.style.transition = 'background-color 10s';
                container.style.backgroundColor = '';
            }, 3000);
        }
    }

    function startLoop() {
        if (!isLoopRunning && !document.hidden) {
            isLoopRunning = true;
            lastTime = performance.now();
            rAFId = requestAnimationFrame(loop);
        }
    }

    function stopLoop() {
        isLoopRunning = false;
        if (rAFId) cancelAnimationFrame(rAFId);
    }

    function loop(time) {
        if (!isLoopRunning) return;
        const dt = (time - lastTime) / 1000;
        lastTime = time;
        
        let needsNextFrame = false;
        
        // Render Mareld
        if ((config.mareldEnabled || config.skogstemaMode) && mareldCanvas && mareldCtx) {
            let activeSparks = 0;
            mareldCtx.clearRect(0, 0, mareldCanvas.width, mareldCanvas.height);
            
            // Ambient spawn for Eldflugor based on goal progress (if goal mode)
            if (config.skogstemaMode && config.goalProgress > 0 && config.fireflyMode === 'goal') {
                const targetAmbient = Math.floor(config.goalProgress * 60); // Up to 60 fireflies at 100%
                let currentAmbient = sparks.filter(s => s.active).length;
                if (currentAmbient < targetAmbient && Math.random() < 0.05) {
                    spawnAmbientEldfluga();
                }
            }
            
            for (let i = 0; i < sparks.length; i++) {
                const s = sparks[i];
                if (s.active) {
                    let drawAlpha = 0;
                    let radius = 2;
                    let fillStyle = '';

                    if (s.type === 'sentence') {
                        // Menings-eldfluga logic
                        const fart = lerp(8, 26, s.norm);
                        const dtSec = dt; // dt is in seconds already? Yes, (time - lastTime)/1000
                        
                        s.x += s.vx * dt + Math.sin(time/1000 * Math.PI * 2 * s.driftFreqX + s.driftPhaseX) * fart * dt;
                        s.y += s.vy * dt + Math.cos(time/1000 * Math.PI * 2 * s.driftFreqY + s.driftPhaseY) * (fart * 0.5) * dt;
                        
                        // Edge wrapping
                        if (s.x < -20) s.x = mareldCanvas.width + 20;
                        if (s.x > mareldCanvas.width + 20) s.x = -20;
                        if (s.y < -20) s.y = mareldCanvas.height + 20;
                        if (s.y > mareldCanvas.height + 20) s.y = -20;
                        
                        if (config.prefersReducedMotion) {
                            drawAlpha = 0.5;
                        } else {
                            s.blinkTimer += dtSec;
                            if (s.blinkState === 'attack') {
                                drawAlpha = s.blinkTimer / 0.25;
                                if (s.blinkTimer >= 0.25) { s.blinkState = 'sustain'; s.blinkTimer = 0; }
                            } else if (s.blinkState === 'sustain') {
                                drawAlpha = 1.0;
                                if (s.blinkTimer >= 0.6) { s.blinkState = 'release'; s.blinkTimer = 0; }
                            } else if (s.blinkState === 'release') {
                                drawAlpha = 1.0 - (s.blinkTimer / 0.6);
                                if (s.blinkTimer >= 0.6) { s.blinkState = 'dark'; s.blinkTimer = 0; }
                            } else if (s.blinkState === 'dark') {
                                drawAlpha = 0.06; // faint
                                if (s.blinkTimer >= s.darkDuration) {
                                    s.blinkState = 'attack'; s.blinkTimer = 0;
                                    s.darkDuration = 1.5 + Math.random() * 2.5;
                                }
                            }
                        }
                        
                        const maxGlod = lerp(0.30, 0.95, s.norm);
                        drawAlpha = Math.max(0.06 * s.norm, drawAlpha * maxGlod);
                        radius = lerp(1.2, 4.2, s.norm);
                        
                        // Kärna varmgul #ffe9a0, ytterglöd gulgrön #c8ff78
                        const grad = mareldCtx.createRadialGradient(s.x, s.y, 0, s.x, s.y, radius * 2);
                        grad.addColorStop(0, `rgba(255, 233, 160, ${drawAlpha})`);
                        grad.addColorStop(1, `rgba(200, 255, 120, 0)`);
                        fillStyle = grad;
                        radius = radius * 2; // draw size
                        
                        s.life -= dt;
                        
                    } else {
                        // Old Mareld/Goal spark
                        s.x += s.vx * dt;
                        s.y += s.vy * dt;
                        
                        if (config.skogstemaMode) {
                            s.x += Math.sin(time/1000 + i) * 0.5;
                            s.y += Math.cos(time/1200 + i) * 0.3;
                        }
                        
                        s.life -= dt;
                        if (s.life <= 0) {
                            s.active = false;
                            continue;
                        }
                        
                        const alpha = s.life / s.maxLife;
                        if (config.skogstemaMode) {
                            const pulse = Math.abs(Math.sin((s.maxLife - s.life) * 3));
                            radius = 1 + pulse * 2.5;
                            fillStyle = `rgba(200, 255, 120, ${alpha.toFixed(2)})`;
                        } else {
                            radius = 2 + (1 - alpha) * 2;
                            fillStyle = `rgba(124, 247, 212, ${alpha.toFixed(2)})`;
                        }
                    }
                    
                    if (s.active) {
                        activeSparks++;
                        mareldCtx.beginPath();
                        mareldCtx.arc(s.x, s.y, radius, 0, Math.PI * 2);
                        mareldCtx.fillStyle = fillStyle;
                        mareldCtx.fill();
                    }
                }
            }
            if (activeSparks > 0 || (config.skogstemaMode && config.goalProgress > 0)) needsNextFrame = true;
        }

        // Render Sonogram
        if (config.sonogramEnabled && sonogramCanvas && sonoCtx) {
            const w = sonogramCanvas.width;
            const h = sonogramCanvas.height;
            sonoCtx.clearRect(0, 0, w, h);
            
            // Ref lines (Midi 43, 55, 67)
            sonoCtx.strokeStyle = 'rgba(255,255,255,0.05)';
            sonoCtx.lineWidth = 1;
            [43, 55, 67].forEach(m => {
                const y = h - ((m - 36) / 36) * h;
                sonoCtx.beginPath();
                sonoCtx.moveTo(0, y);
                sonoCtx.lineTo(w, y);
                sonoCtx.stroke();
            });

            const speed = 55; // px per second
            let validTraces = 0;
            
            for (let i = 0; i < MAX_TRACES; i++) {
                const tr = traces[i];
                if (!tr) continue;
                const age = (time - tr.born) / 1000;
                const x = w - 20 - (age * speed); // 20px padding from right
                
                if (x > -100) {
                    validTraces++;
                    const y = h - ((tr.midi - 36) / 36) * h;
                    
                    const isEcho = tr.type === 'echo';
                    const isVowel = tr.type === 'vowel';
                    const isDive = tr.type === 'dive';
                    
                    const alpha = Math.max(0, 1 - (age / 24)); // 24s window
                    
                    if (isEcho) {
                        sonoCtx.fillStyle = `rgba(223, 174, 102, ${alpha})`; // Amber
                        sonoCtx.beginPath();
                        sonoCtx.arc(x, y, 3, 0, Math.PI*2);
                        sonoCtx.fill();
                    } else if (isDive) {
                        sonoCtx.fillStyle = `rgba(92, 232, 210, ${alpha})`;
                        sonoCtx.fillRect(x, y, 10, h - y);
                    } else {
                        sonoCtx.fillStyle = `rgba(92, 232, 210, ${alpha})`; // Cyan
                        const rw = Math.max(2, (tr.durMs / 1000) * speed);
                        const rh = isVowel ? 4 : 2;
                        sonoCtx.fillRect(x - rw/2, y - rh/2, rw, rh);
                    }
                }
            }
            if (validTraces > 0) needsNextFrame = true;
        }

        if (needsNextFrame && !document.hidden) {
            rAFId = requestAnimationFrame(loop);
        } else {
            isLoopRunning = false;
        }
    }

    function stop() {
        // Function to explicitly stop visuals if settings disabled
        stopLoop();
    }
    
    // Add start explicitly for outside access
    function start() {
        startLoop();
    }
    
    function setStateProvider(provider) {
        getValsangState = provider;
    }

    return {
        init,
        setConfig,
        setGoal,
        addTrace,
        handleKey,
        triggerDive,
        spawnSentenceFirefly,
        stop,
        start,
        setStateProvider
    };
})();
