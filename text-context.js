const TextContext = (function() {
    const ALFABET = "abcdefghijklmnopqrstuvwxyzåäö";
    const VOKALER = new Set("aeiouyåäö".split(''));
    const FRIKATIVOR = new Set("sfvzchj".split(''));

    const statsObj = {
        // Raw counters
        N: 0,
        sumAlpha: 0,
        vowelCount: 0,
        fricCount: 0,
        wordCount: 0,
        longWordCount: 0,
        sumWordLen: 0,
        sentCount: 0,
        sumSentLen: 0,
        paragraphs: 0,
        headings: 0,
        harmonicShiftCount: 0,
        lastHeadingLevel: 0,
        lix: 0,

        // Derived stats
        meanAlpha: 14,
        vowelRatio: 0.38,
        fricRatio: 0.10,
        meanWordLen: 5,
        meanSentLen: 60,
        g: 1.0,
        
        // Section raw counters (from last heading to end)
        section_N: 0,
        section_sumAlpha: 0,
        section_vowelCount: 0,
        section_fricCount: 0,

        // Section derived stats
        section_meanAlpha: 14,
        section_vowelRatio: 0.38
    };

    let textarea = null;
    let dirty = true;
    let lastScanTime = 0;
    const MIN_RESCAN_INTERVAL = 5000; 
    let idleTimeout = null;
    let continuousTimeout = null;

    function resetCounters() {
        statsObj.N = 0;
        statsObj.sumAlpha = 0;
        statsObj.vowelCount = 0;
        statsObj.fricCount = 0;
        statsObj.wordCount = 0;
        statsObj.longWordCount = 0;
        statsObj.sumWordLen = 0;
        statsObj.sentCount = 0;
        statsObj.sumSentLen = 0;
        statsObj.paragraphs = 0;
        statsObj.headings = 0;
        statsObj.harmonicShiftCount = 0;
        statsObj.lastHeadingLevel = 0;
        statsObj.section_N = 0;
        statsObj.section_sumAlpha = 0;
        statsObj.section_vowelCount = 0;
        statsObj.section_fricCount = 0;
    }

    function computeDerived() {
        statsObj.meanAlpha = statsObj.N > 0 ? statsObj.sumAlpha / statsObj.N : 14;
        statsObj.vowelRatio = statsObj.N > 0 ? statsObj.vowelCount / statsObj.N : 0.38;
        statsObj.fricRatio = statsObj.N > 0 ? statsObj.fricCount / statsObj.N : 0.10;
        statsObj.meanWordLen = statsObj.wordCount > 0 ? statsObj.sumWordLen / statsObj.wordCount : 5;
        statsObj.meanSentLen = statsObj.sentCount > 0 ? statsObj.sumSentLen / statsObj.sentCount : 60;
        statsObj.g = 40 / (40 + statsObj.N);
        
        statsObj.section_meanAlpha = statsObj.section_N > 0 ? statsObj.section_sumAlpha / statsObj.section_N : statsObj.meanAlpha;
        statsObj.section_vowelRatio = statsObj.section_N > 0 ? statsObj.section_vowelCount / statsObj.section_N : statsObj.vowelRatio;

        // LIX (Läsbarhetsindex): (Ord / Meningar) + (Långa ord >6 bokstäver * 100 / Ord)
        if (statsObj.wordCount > 0 && statsObj.sentCount > 0) {
            const meanWordsPerSent = statsObj.wordCount / statsObj.sentCount;
            const longWordRatio = (statsObj.longWordCount * 100) / statsObj.wordCount;
            statsObj.lix = Math.round(meanWordsPerSent + longWordRatio);
        } else {
            statsObj.lix = 0;
        }
    }

    function doFullScan() {
        if (!textarea) return;
        const text = textarea.value;
        const lowerText = text.toLowerCase();
        
        resetCounters();

        let currentWordLen = 0;
        let currentSentLen = 0;

        for (let i = 0; i < text.length; i++) {
            const char = lowerText[i];
            const originalChar = text[i];
            const idx = ALFABET.indexOf(char);
            
            if (originalChar === '#' && (i === 0 || text[i-1] === '\n')) {
                let j = i;
                while(j < text.length && text[j] === '#') j++;
                if (j < text.length && text[j] === ' ' || text[j] === '\n' || j === text.length) {
                    const level = j - i;
                    statsObj.headings++;
                    statsObj.lastHeadingLevel = level;
                    
                    if (level === 1) statsObj.harmonicShiftCount += 2;
                    else if (level === 2) statsObj.harmonicShiftCount += 1;
                    else if (level >= 3) statsObj.harmonicShiftCount += 0;
                    
                    statsObj.section_N = 0;
                    statsObj.section_sumAlpha = 0;
                    statsObj.section_vowelCount = 0;
                    statsObj.section_fricCount = 0;
                }
            }
            
            currentSentLen++;

            if (idx !== -1) {
                statsObj.N++;
                statsObj.section_N++;
                statsObj.sumAlpha += idx;
                statsObj.section_sumAlpha += idx;
                if (VOKALER.has(char)) {
                    statsObj.vowelCount++;
                    statsObj.section_vowelCount++;
                }
                if (FRIKATIVOR.has(char)) {
                    statsObj.fricCount++;
                    statsObj.section_fricCount++;
                }
                currentWordLen++;
            } else {
                if (currentWordLen > 0) {
                    statsObj.wordCount++;
                    statsObj.sumWordLen += currentWordLen;
                    if (currentWordLen > 6) statsObj.longWordCount++;
                    currentWordLen = 0;
                }
            }

            if (char === '.' || char === '!' || char === '?') {
                statsObj.sentCount++;
                statsObj.sumSentLen += currentSentLen;
                currentSentLen = 0;
            }
        }
        
        // Handle trailing word/sentence
        if (currentWordLen > 0) {
            statsObj.wordCount++;
            statsObj.sumWordLen += currentWordLen;
            if (currentWordLen > 6) statsObj.longWordCount++;
        }
        if (currentSentLen > 0 && statsObj.N > 0) {
            statsObj.sentCount++;
            statsObj.sumSentLen += currentSentLen;
        }

        // Paragraphs
        const pMatches = text.match(/[^\r\n]+/g);
        statsObj.paragraphs = pMatches ? pMatches.length : 0;

        computeDerived();
        dirty = false;
        lastScanTime = performance.now();
    }

    function handleInput(e) {
        if (!textarea) return;

        // Try incremental update for simple typed characters
        if (e.inputType === 'insertText' && e.data && e.data.length === 1 && !dirty) {
            const char = e.data.toLowerCase();
            const idx = ALFABET.indexOf(char);
            
            if (idx !== -1) {
                statsObj.N++;
                statsObj.sumAlpha += idx;
                if (VOKALER.has(char)) statsObj.vowelCount++;
                if (FRIKATIVOR.has(char)) statsObj.fricCount++;
            }
            computeDerived();
            // Still mark dirty to eventually fix word/sentence counts
            dirty = true;
        } else {
            // Deletions, pastes, line breaks -> mark dirty
            dirty = true;
        }

        scheduleRescan();
    }

    function scheduleRescan() {
        if (!dirty) return;

        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
            if (dirty) doFullScan();
        }, 2000);

        if (!continuousTimeout) {
            continuousTimeout = setTimeout(() => {
                if (dirty) doFullScan();
                continuousTimeout = null;
            }, 10000);
        }
    }

    return {
        attach: function(el) {
            if (textarea) this.detach();
            textarea = el;
            if (textarea) {
                textarea.addEventListener('input', handleInput);
                doFullScan();
            }
        },
        detach: function() {
            if (textarea) {
                textarea.removeEventListener('input', handleInput);
                textarea = null;
            }
            clearTimeout(idleTimeout);
            clearTimeout(continuousTimeout);
        },
        getStats: function() {
            const now = performance.now();
            if (dirty && (now - lastScanTime > MIN_RESCAN_INTERVAL)) {
                doFullScan();
            }
            return statsObj;
        },
        forceRescan: function() {
            doFullScan();
        }
    };
})();

window.TextContext = TextContext;
