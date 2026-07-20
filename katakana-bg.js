class KatakanaEngine {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.chars = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ".split('');
        this.activeCharacters = [];
        this.enabled = false;
        
        this.resize();
        window.addEventListener('resize', () => this.resize());
        
        this.loop = this.loop.bind(this);
        requestAnimationFrame(this.loop);
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = window.innerWidth * dpr;
        this.canvas.height = window.innerHeight * dpr;
        this.ctx.scale(dpr, dpr);
    }

    toggle() {
        this.enabled = !this.enabled;
        this.canvas.style.display = this.enabled ? 'block' : 'none';
        
        // Save to localStorage
        localStorage.setItem('gaia_katakana_bg', this.enabled ? 'true' : 'false');
        
        const btn = document.getElementById('btnKatakana');
        if (btn) {
            btn.classList.toggle('active', this.enabled);
        }
    }

    setEnable(state) {
        this.enabled = state;
        this.canvas.style.display = this.enabled ? 'block' : 'none';
        const btn = document.getElementById('btnKatakana');
        if (btn) {
            btn.classList.toggle('active', this.enabled);
        }
    }

    spawn() {
        if (!this.enabled) return;
        
        const char = this.chars[Math.floor(Math.random() * this.chars.length)];
        // Random position, biased towards center area but covering screen
        const x = Math.random() * this.canvas.width;
        const y = Math.random() * this.canvas.height;
        
        // Random size between 16 and 48
        const size = Math.random() * 32 + 16;
        
        // Check if light mode is active to determine color
        const overlay = document.getElementById('fullscreenOverlay');
        const isLight = overlay && overlay.classList.contains('fs-light-mode');
        
        this.activeCharacters.push({
            char,
            x,
            y,
            size,
            alpha: 1.0,
            life: 1.0, // 1.0 to 0.0
            decay: Math.random() * 0.01 + 0.005, // How fast it fades
            isLight
        });
    }

    loop() {
        // Clear canvas (using window inner dimensions since we scaled the context)
        this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        
        if (this.enabled && this.activeCharacters.length > 0) {
            for (let i = this.activeCharacters.length - 1; i >= 0; i--) {
                const c = this.activeCharacters[i];
                c.life -= c.decay;
                
                if (c.life <= 0) {
                    this.activeCharacters.splice(i, 1);
                    continue;
                }
                
                this.ctx.font = `bold ${c.size}px monospace`;
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                
                // Color calculation based on theme
                // Dark mode: gray fading to dark
                // Light mode: gray fading to white
                if (c.isLight) {
                    this.ctx.fillStyle = `rgba(150, 150, 150, ${c.life * 0.5})`;
                } else {
                    this.ctx.fillStyle = `rgba(100, 100, 100, ${c.life * 0.5})`;
                }
                
                // Subtle glow
                this.ctx.shadowBlur = 10;
                this.ctx.shadowColor = c.isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)';
                
                this.ctx.fillText(c.char, c.x, c.y);
                
                // Reset shadow
                this.ctx.shadowBlur = 0;
            }
        }
        
        requestAnimationFrame(this.loop);
    }
}

// Global instance
window.katakanaEngine = null;

document.addEventListener('DOMContentLoaded', () => {
    window.katakanaEngine = new KatakanaEngine('katakanaCanvas');
    
    // Load state
    const savedState = localStorage.getItem('gaia_katakana_bg');
    if (savedState === 'true') {
        window.katakanaEngine.setEnable(true);
    }
    
    // Hook into typing events
    document.addEventListener('input', (e) => {
        if (e.target.tagName === 'TEXTAREA' && window.katakanaEngine) {
            // Spawn 1-3 characters per keystroke
            const count = Math.floor(Math.random() * 3) + 1;
            for (let i = 0; i < count; i++) {
                window.katakanaEngine.spawn();
            }
        }
    });
});

window.toggleKatakanaBg = function() {
    if (window.katakanaEngine) {
        window.katakanaEngine.toggle();
    }
};
