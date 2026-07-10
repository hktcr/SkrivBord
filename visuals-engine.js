/**
 * VisualsEngine
 * 
 * Hanterar Sonogram, Djupvatten-bakgrund och Mareld-mål för SkrivR.
 * Använder en gemensam requestAnimationFrame-loop för prestanda.
 */

export const VisualsEngine = (() => {
    let sonogramCanvas, sonoCtx;
    let mareldCanvas, mareldCtx;
    let djupvattenLayers = [];
    
    // Configs
    let config = {
        sonogramEnabled: false,
        djupvattenEnabled: false,
        mareldEnabled: false,
        mareldGoalTarget: 0,
        mareldGoalType: 'words', // 'words' or 'time'
        mareldStartTime: 0,
        mareldStartChars: 0,
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
        if (!config.djupvattenEnabled) {
            djupvattenLayers.forEach(l => l.style.opacity = '0');
        } else {
            djupvattenLayers.forEach(l => l.style.opacity = '1');
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
                // Wait, I need a global char counter.
                const written = Math.max(0, window._charsTotal || 0 - config.mareldStartChars);
                const over = written - config.mareldGoalTarget;
                overage = Math.min(1, Math.max(0, over / 50.0));
            }
            
            const opacity = 0.25 + (0.97 - 0.25) * overage;
            mareldVeil.style.opacity = opacity.toFixed(2);
        } else {
            mareldVeil.style.opacity = '0';
        }
    }

    function spawnSparks(count, intensity) {
        let spawned = 0;
        for (let i = 0; i < sparks.length; i++) {
            if (!sparks[i].active) {
                sparks[i] = {
                    active: true,
                    x: Math.random() * window.innerWidth,
                    y: window.innerHeight * (0.3 + 0.5 * Math.random()), // 30-80% height
                    vx: (Math.random() - 0.5) * 20,
                    vy: -30 - Math.random() * 40,
                    life: 0.8 + Math.random() * 1.2 + intensity,
                    maxLife: 0.8 + Math.random() * 1.2 + intensity
                };
                spawned++;
                if (spawned >= count) break;
            }
        }
    }

    function updateDjupvatten() {
        if (!config.djupvattenEnabled || config.prefersReducedMotion || !getValsangState) return;
        const state = getValsangState();
        
        // Layer 0: Ytljus
        const l0 = djupvattenLayers[0];
        if (l0) {
            // Y: mapped from pitchNorm (0..1)
            const y = -30 + (1 - state.pitchNorm) * 60;
            l0.style.transform = `translate3d(0, ${y.toFixed(1)}%, 0) scale(1.2)`;
            l0.style.opacity = state.idle ? '0.3' : '0.6';
        }
        
        // Layer 1: Ström
        const l1 = djupvattenLayers[1];
        if (l1) {
            // Moves horizontally based on tempoNorm
            const speed = 20 + state.tempoNorm * 40; // 20s to 60s full cycle
            const t = (performance.now() / (speed * 1000)) % 1;
            const x = -50 + t * 100;
            l1.style.transform = `translate3d(${x.toFixed(1)}%, 10%, 0) scale(1.5)`;
            l1.style.opacity = state.idle ? '0.1' : '0.4';
        }
        
        // Layer 2: Eko-sken (skip for now, would need trigger from Valsang)
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
        if (config.mareldEnabled && mareldCanvas && mareldCtx) {
            let activeSparks = 0;
            mareldCtx.clearRect(0, 0, mareldCanvas.width, mareldCanvas.height);
            
            for (let i = 0; i < sparks.length; i++) {
                const s = sparks[i];
                if (s.active) {
                    s.x += s.vx * dt;
                    s.y += s.vy * dt;
                    s.life -= dt;
                    if (s.life <= 0) {
                        s.active = false;
                    } else {
                        activeSparks++;
                        const alpha = s.life / s.maxLife;
                        const radius = 2 + (1 - alpha) * 2;
                        
                        mareldCtx.beginPath();
                        mareldCtx.arc(s.x, s.y, radius, 0, Math.PI * 2);
                        mareldCtx.fillStyle = `rgba(124, 247, 212, ${alpha.toFixed(2)})`; // #7cf7d4
                        mareldCtx.fill();
                    }
                }
            }
            if (activeSparks > 0) needsNextFrame = true;
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

    return {
        init,
        setConfig,
        setGoal,
        addTrace,
        handleKey,
        triggerDive
    };
})();
