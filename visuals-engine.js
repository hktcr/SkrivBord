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
        prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        hardforkMode: false
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
        
        // Vindsus-läget och HardFork tvingar bort havstemat
        if (config.skogstemaMode || config.hardforkMode) {
            config.djupvattenEnabled = false;
            config.mareldEnabled = false;
            
            // Force hide DOM layers
            djupvattenLayers.forEach(l => { if (l) l.style.opacity = '0'; });
            const mareldVeil = document.getElementById('mareldVeil');
            if (mareldVeil) mareldVeil.style.opacity = '0';
            
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
                const totalChars = window.TextContext ? window.TextContext.getStats().N : 0;
                const written = Math.max(0, totalChars - config.mareldStartChars);
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
        if (!config.skogstemaMode || (config.fireflyMode && config.fireflyMode !== 'sentence')) {
            console.log('[Eldfluga] BLOCKERAD:', { skogstema: config.skogstemaMode, fireflyMode: config.fireflyMode });
            return;
        }
        
        // Mappning enligt spec: kort mening = avlägsen, lång = nära
        const norm = clamp((length - 15) / (150 - 15), 0, 1);
        
        // Hitta tom plats eller äldsta (pool = 60 st, se spec 2.5)
        let targetIdx = sparks.findIndex(s => !s.active);
        if (targetIdx === -1) {
            // Äldsta: tonar ut över 4s (spec 2.5)
            let oldestLife = Infinity;
            for (let i = 0; i < sparks.length; i++) {
                if (sparks[i].life < oldestLife) {
                    oldestLife = sparks[i].life;
                    targetIdx = i;
                }
            }
            // Markera fadout på den gamla
            if (sparks[targetIdx]) sparks[targetIdx].fadeOut = 4.0;
        }
        
        const s = sparks[targetIdx];
        s.active = true;
        s.type = 'sentence';
        s.norm = norm;
        s.fadeOut = 0; // Inte under uttoning
        s.x = Math.random() * window.innerWidth;
        
        // Avlägsna högt uppe (trädkronor), nära längre ner (spec 2.3)
        const spawnYCenter = lerp(0.15, 0.75, norm) * window.innerHeight;
        s.y = spawnYCenter + (Math.random() * 0.2 - 0.1) * window.innerHeight;
        
        // Biologiskt trovärdigt: Photinus pyralis flyger 0.1-0.5 m/s
        // Skala: norm=0 (avlägsen) långsam, norm=1 (nära) snabbare (parallax)
        const baseSpeed = lerp(4, 14, norm); // px/s
        const angle = Math.random() * Math.PI * 2;
        s.vx = Math.cos(angle) * baseSpeed;
        s.vy = Math.sin(angle) * baseSpeed;
        
        // Två sinusvandringsar med individuella faser och perioder (spec 2.4)
        // Ger mjuka, oregelbundna J-formade kurvor som riktiga eldflugor
        s.driftPhaseX = Math.random() * Math.PI * 2;
        s.driftPhaseY = Math.random() * Math.PI * 2;
        s.driftPeriodX = 6 + Math.random() * 8; // 6-14s (spec 2.4)
        s.driftPeriodY = 6 + Math.random() * 8;
        s.driftFreqX = 1 / s.driftPeriodX;
        s.driftFreqY = 1 / s.driftPeriodY;
        // Svag slumpvandring (random walk) för oregelbundenhet
        s.wanderAngle = Math.random() * Math.PI * 2;
        
        // Bioluminescens-blinkning (Photinus-mönster, spec 2.4)
        // attack 0.25s, platå 0.4-0.8s, release 0.6s, mörk 1.5-4s
        s.blinkState = 'attack';
        s.blinkTimer = 0;
        s.sustainDuration = 0.4 + Math.random() * 0.4; // 0.4-0.8s platå
        s.darkDuration = 1.5 + Math.random() * 2.5;    // 1.5-4s mörk
        
        s.maxLife = Infinity; // Lever tills poolen tvingar bort den
        s.life = 1000;
        s.born = performance.now();
        
        // Debug: räkna aktiva eldflugor
        const activeCount = sparks.filter(sp => sp.active && sp.type === 'sentence').length;
        console.log(`[Eldfluga] Spawnad #${activeCount} vid (${Math.round(s.x)}, ${Math.round(s.y)}), norm=${norm.toFixed(2)}, length=${length}`);
        
        startLoop();
    }
    
    function spawnHardForkBlock(keyType, degree) {
        if (!config.hardforkMode) return;
        
        let targetIdx = sparks.findIndex(s => !s.active);
        if (targetIdx === -1) {
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
        s.type = 'hardfork';
        s.keyType = keyType; // 'letter', 'space', 'punct'
        
        // Random position, maybe snapping to a grid
        const grid = 40;
        s.x = Math.floor((Math.random() * window.innerWidth) / grid) * grid;
        s.y = Math.floor((Math.random() * window.innerHeight) / grid) * grid;
        
        s.vx = 0;
        s.vy = 0;
        
        if (keyType === 'letter') {
            s.vy = 150 + Math.random() * 150; // Fall down
            s.maxLife = 0.8 + Math.random() * 1.0;
            s.color = '#00FF41'; // Matrix Green
            s.size = 18;
            s.char = String.fromCharCode(0x30A0 + Math.random() * 96);
        } else if (keyType === 'space') {
            // Big flash at bottom
            s.y = window.innerHeight - grid * 2;
            s.maxLife = 0.3;
            s.color = `rgba(255, 100, 200, 0.8)`;
            s.size = grid * 4;
        } else {
            // Glitch horizontal
            s.vx = (Math.random() > 0.5 ? 1 : -1) * 800;
            s.maxLife = 0.2;
            s.color = `rgba(100, 255, 255, 0.9)`;
            s.size = grid * 0.4;
        }
        
        s.life = s.maxLife;
        startLoop();
    }
    
    function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }
    function lerp(a, b, t) { return a + (b - a) * t; }

    function updateDjupvatten() {
        if (!config.djupvattenEnabled || config.prefersReducedMotion || !getValsangState) {
            djupvattenLayers.forEach(l => {
                if (l) l.style.opacity = '0';
            });
            return;
        }
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
        
        // Render Mareld & HardFork
        if ((config.mareldEnabled || config.skogstemaMode || config.hardforkMode) && mareldCanvas && mareldCtx) {
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
                        // ── Biologiskt trovärdigt flygbeteende ──
                        const fart = lerp(8, 26, s.norm); // Parallax: nära = snabbare
                        const timeSec = time / 1000;
                        
                        // Svag slumpvandring: ändra riktning gradvis (aldrig ryck)
                        s.wanderAngle += (Math.sin(timeSec * 0.7 + s.driftPhaseX * 3) * 0.3) * dt;
                        const wanderX = Math.cos(s.wanderAngle) * fart * 0.15 * dt;
                        const wanderY = Math.sin(s.wanderAngle) * fart * 0.15 * dt;
                        
                        // Sinusvandring: mjuka J-kurvor (spec 2.4)
                        const sinDriftX = Math.sin(timeSec * Math.PI * 2 * s.driftFreqX + s.driftPhaseX) * fart * dt;
                        const sinDriftY = Math.cos(timeSec * Math.PI * 2 * s.driftFreqY + s.driftPhaseY) * (fart * 0.5) * dt;
                        
                        s.x += s.vx * dt + sinDriftX + wanderX;
                        s.y += s.vy * dt + sinDriftY + wanderY;
                        
                        // Kantbeteende: mjuk tillbakavikning (spec 2.4)
                        // Hastighetskomponenten speglas med glidning, flugan försvinner aldrig
                        const W = window.innerWidth;
                        const H = window.innerHeight;
                        const margin = 30;
                        if (s.x < margin) { s.vx += (margin - s.x) * 0.02; s.vx = Math.abs(s.vx) * 0.7; }
                        if (s.x > W - margin) { s.vx -= (s.x - (W - margin)) * 0.02; s.vx = -Math.abs(s.vx) * 0.7; }
                        if (s.y < margin) { s.vy += (margin - s.y) * 0.02; s.vy = Math.abs(s.vy) * 0.5; }
                        if (s.y > H - margin) { s.vy -= (s.y - (H - margin)) * 0.02; s.vy = -Math.abs(s.vy) * 0.5; }
                        
                        // ── Bioluminescens (Photinus pyralis-mönster) ──
                        if (s.fadeOut > 0) {
                            // Uttoning: äldsta flugan dör mjukt (spec 2.5: 4s)
                            s.fadeOut -= dt;
                            drawAlpha = Math.max(0, s.fadeOut / 4.0) * 0.3;
                            if (s.fadeOut <= 0) { s.active = false; continue; }
                        } else if (config.prefersReducedMotion) {
                            drawAlpha = 0.5;
                        } else {
                            s.blinkTimer += dt;
                            if (s.blinkState === 'attack') {
                                drawAlpha = clamp(s.blinkTimer / 0.25, 0, 1); // 0.25s attack
                                if (s.blinkTimer >= 0.25) { s.blinkState = 'sustain'; s.blinkTimer = 0; }
                            } else if (s.blinkState === 'sustain') {
                                drawAlpha = 1.0;
                                if (s.blinkTimer >= s.sustainDuration) { s.blinkState = 'release'; s.blinkTimer = 0; }
                            } else if (s.blinkState === 'release') {
                                drawAlpha = 1.0 - clamp(s.blinkTimer / 0.6, 0, 1); // 0.6s release
                                if (s.blinkTimer >= 0.6) { s.blinkState = 'dark'; s.blinkTimer = 0; }
                            } else if (s.blinkState === 'dark') {
                                drawAlpha = 0.06 * s.norm; // Svag prick i mörkret (nära = synligare)
                                if (s.blinkTimer >= s.darkDuration) {
                                    s.blinkState = 'attack'; s.blinkTimer = 0;
                                    s.darkDuration = 1.5 + Math.random() * 2.5;
                                    s.sustainDuration = 0.4 + Math.random() * 0.4;
                                }
                            }
                        }
                        
                        const maxGlod = lerp(0.30, 0.95, s.norm);
                        drawAlpha = Math.max(0.06 * s.norm, drawAlpha * maxGlod);
                        radius = lerp(1.8, 5.0, s.norm); // Lite större för synlighet
                        
                        // ── Vetenskapligt korrekt färg ──
                        // Photinus pyralis: luciferin-emission ~560-590nm = varm orange-gul
                        // Solid kärna (#ffb347 orange) med mjuk glöd (#ff8c00 mörk orange)
                        const coreR = radius * 0.35; // Solid kärna
                        const glowR = radius * 2.5;  // Mjuk ytterglöd
                        const grad = mareldCtx.createRadialGradient(s.x, s.y, 0, s.x, s.y, glowR);
                        grad.addColorStop(0, `rgba(255, 220, 130, ${drawAlpha})`);       // Het kärna (ljusgul-orange)
                        grad.addColorStop(coreR / glowR, `rgba(255, 179, 71, ${drawAlpha * 0.9})`); // Solid orange
                        grad.addColorStop(0.5, `rgba(255, 140, 0, ${drawAlpha * 0.4})`);  // Varm orange glöd
                        grad.addColorStop(1, `rgba(255, 100, 0, 0)`);                     // Toning mot transparent
                        fillStyle = grad;
                        radius = glowR; // Rita hela glöden
                        
                        s.life -= dt;
                        
                    } else if (s.type === 'hardfork') {
                        s.life -= dt;
                        if (s.life <= 0) {
                            s.active = false;
                            continue;
                        }
                        
                        s.x += s.vx * dt;
                        s.y += s.vy * dt;
                        
                        const alpha = s.life / s.maxLife;
                        
                        if (s.keyType === 'letter') {
                            // Update character randomly for matrix flicker effect
                            if (Math.random() > 0.8) s.char = String.fromCharCode(0x30A0 + Math.random() * 96);
                            
                            mareldCtx.font = `bold ${s.size}px monospace`;
                            mareldCtx.textAlign = 'center';
                            
                            // Trail
                            mareldCtx.fillStyle = s.color;
                            for(let j=1; j<=4; j++) {
                                const trailAlpha = Math.max(0, alpha - (j * 0.2));
                                if (trailAlpha > 0) {
                                    mareldCtx.globalAlpha = trailAlpha;
                                    const trailChar = String.fromCharCode(0x30A0 + Math.random() * 96);
                                    mareldCtx.fillText(trailChar, s.x, s.y - j * s.size * 0.9);
                                }
                            }
                            
                            // Leading character (white/bright green)
                            mareldCtx.fillStyle = '#E0FFE0';
                            mareldCtx.globalAlpha = alpha;
                            mareldCtx.fillText(s.char, s.x, s.y);
                            
                        } else if (s.keyType === 'space') {
                            mareldCtx.fillStyle = '#00FF41';
                            mareldCtx.globalAlpha = alpha * 0.3;
                            mareldCtx.fillRect(s.x - s.size/2, s.y, s.size, s.size * 0.2);
                        } else {
                            // Punctuation glitch line
                            mareldCtx.fillStyle = '#00FF41';
                            mareldCtx.globalAlpha = alpha * 0.8;
                            mareldCtx.fillRect(s.x - s.size * 2.5, s.y, s.size * 5, s.size * 0.2);
                        }
                        mareldCtx.globalAlpha = 1.0;
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
            if (activeSparks > 0 || config.skogstemaMode) needsNextFrame = true;
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
        spawnHardForkBlock,
        stop,
        start,
        setStateProvider
    };
})();
