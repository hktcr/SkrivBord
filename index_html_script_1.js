
        // ═══════════════════════════════════════════════
        //  Skrivr — State & Storage
        // ═══════════════════════════════════════════════

        const STORAGE_KEY = 'skrivbord-docs';
        const SETTINGS_KEY = 'skrivbord-settings';
        const ACTIVE_KEY = 'skrivbord-active';
        const VIEW_KEY = 'skrivbord-view';

        let docs = [];
        let activeDocId = null;
        let saveTimer = null;
        let viewMode = localStorage.getItem(VIEW_KEY) || 'both';
        let fileHandles = {}; // docId -> FileSystemFileHandle

        // Default settings
        let isFullscreen = false;
        let typewriterEnabled = false;
        let typewriterSoundEnabled = false;
        let typewriterSoundProfile = 'digital';
        let highlightColor = 'rgba(124,92,191,0.12)';
        let focusDimmingEnabled = false;
        let zenTimer = null;
        
        // Audio API för skrivmaskinsljud
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        let audioCtx;

        // AudioContext resume on user interaction for iOS
        document.addEventListener('pointerdown', () => {
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
        }, { once: false });

        const DEFAULT_SETTINGS = {
            previewBg: '#ffffff',
            previewColor: '#212529',
            fontSize: 22,
            fsFontSize: 32, // Större text som default i fullscreen
            fsBgType: 'gradient',
            fontFamily: 'mono',
            editorBg: '#ffffff',
            editorColor: '#212529',
            editorWidth: 150,
            typewriter: true,
            typewriterSound: false,
            typewriterSoundProfile: 'digital',
            valsangVol: 0.6,
            valsangDepth: 1.0,
            valsangDjupvatten: true,
            valsangSonogram: true,
            valsangMareld: true,
            highlightColor: 'rgba(250,176,5,0.10)',
            focusDimming: true,
            focusZoneLines: 5,
            fsColumnWidth: 65
        };

        function loadDocs() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                docs = raw ? JSON.parse(raw) : [];
            } catch {
                docs = [];
            }
        }

        function saveDocs() {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
        }

        function loadSettings() {
            try {
                const raw = localStorage.getItem(SETTINGS_KEY);
                return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
            } catch {
                return { ...DEFAULT_SETTINGS };
            }
        }

        function saveSettings(settings) {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        }

        function getActiveDoc() {
            return docs.find(d => d.id === activeDocId) || null;
        }

        // ═══════════════════════════════════════════════
        //  Local File System Integration (gAIa Upgrades)
        // ═══════════════════════════════════════════════

        async function connectObsidianFile() {
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [{
                        description: 'Obsidian Markdown Files',
                        accept: {
                            'text/markdown': ['.md'],
                            'text/plain': ['.txt']
                        }
                    }],
                    excludeAcceptAllOption: true,
                    multiple: false
                });
                
                const file = await handle.getFile();
                const content = await file.text();
                const newId = 'doc-local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
                const title = file.name.replace(/\.[^/.]+$/, ""); // Strip extension
                
                const doc = {
                    id: newId,
                    title: title,
                    content: content,
                    created: new Date().toISOString(),
                    modified: new Date().toISOString(),
                    isLocalFile: true,
                    fileName: file.name
                };
                
                docs.push(doc);
                fileHandles[newId] = handle;
                
                saveDocs();
                setActiveDoc(newId);
                updateDocCount();
                renderTabs();
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('File System Picker Error:', err);
                    alert('Kunde inte ansluta till lokal fil: ' + err.message);
                }
            }
        }

        async function reconnectLocalFile(docId) {
            const doc = docs.find(d => d.id === docId);
            if (!doc) return;
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [{
                        description: 'Obsidian Markdown Files',
                        accept: {
                            'text/markdown': ['.md'],
                            'text/plain': ['.txt']
                        }
                    }],
                    excludeAcceptAllOption: true,
                    multiple: false
                });
                
                const file = await handle.getFile();
                fileHandles[doc.id] = handle;
                doc.fileName = file.name;
                
                const localContent = await file.text();
                if (localContent !== doc.content) {
                    if (confirm(`Innehållet i "${file.name}" på disk skiljer sig från Skrivr. Vill du läsa in disk-versionen?\n\n[OK] = Läs in från disk (Obsidian-version)\n[Avbryt] = Skriv över filen på disk med Skrivrs version`)) {
                        doc.content = localContent;
                        doc.modified = new Date().toISOString();
                        const textarea = document.getElementById('editorTextarea');
                        if (doc.id === activeDocId && textarea) {
                            textarea.value = doc.content;
                            renderPreview(doc.content);
                            updateStats(doc.content);
                        }
                    } else {
                        // Immediately save the Skrivr content to disk
                        const writable = await handle.createWritable();
                        await writable.write(doc.content);
                        await writable.close();
                    }
                }
                
                saveDocs();
                renderTabs();
                renderActiveDoc();
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('Reconnect Error:', err);
                    alert('Kunde inte återansluta till lokal fil: ' + err.message);
                }
            }
        }

        function triggerAutosave(doc) {
            if (!doc) return;
            const statusSaved = document.getElementById('statusSaved');
            if (statusSaved) {
                statusSaved.innerHTML = '<span style="color:var(--accent-light)">●</span> Ändrad…';
            }
            
            clearTimeout(saveTimer);
            saveTimer = setTimeout(async () => {
                saveDocs();
                
                if (doc.isLocalFile) {
                    const handle = fileHandles[doc.id];
                    if (handle) {
                        try {
                            const writable = await handle.createWritable();
                            await writable.write(doc.content);
                            await writable.close();
                            if (statusSaved) {
                                statusSaved.innerHTML =
                                    '<span class="status-saved" style="color:var(--success)">●</span> Sparad på disk';
                            }
                            return;
                        } catch (err) {
                            console.error('Error writing to local file:', err);
                            if (statusSaved) {
                                statusSaved.innerHTML =
                                    '<span style="color:var(--danger)">●</span> Fel vid disk-sparning';
                            }
                            return;
                        }
                    } else {
                        if (statusSaved) {
                            statusSaved.innerHTML =
                                '<span style="color:#fab005">●</span> Kräver återanslutning';
                        }
                        return;
                    }
                }
                
                if (statusSaved) {
                    statusSaved.innerHTML = '<span class="status-saved">●</span> Sparad';
                }
            }, 500);
        }

        // ═══════════════════════════════════════════════
        //  Document Management
        // ═══════════════════════════════════════════════

        function createNewDoc() {
            const id = 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
            const docNum = docs.length + 1;
            const doc = {
                id,
                title: `Dokument ${docNum}`,
                content: '',
                created: new Date().toISOString(),
                modified: new Date().toISOString()
            };
            docs.push(doc);
            saveDocs();
            setActiveDoc(id);
            renderTabs();
            updateDocCount();

            // Focus the editor
            setTimeout(() => {
                document.getElementById('editorTextarea').focus();
            }, 50);
        }

        function importFromCode() {
            const code = prompt('Fyll i importkoden från gAIa (t.ex. 2xu7rs2l):');
            if (!code || !code.trim()) return;
            
            // Vi använder TinyURL som länkförkortare för att transportera den gigantiska
            // lokal-hashen över HTTP. Den korta koden dirigerar tyst om oss tillbaka hit men med hashen.
            window.location.href = 'https://tinyurl.com/' + code.trim();
        }

        function importFile() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.md,.txt,.markdown';
            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const content = ev.target.result;
                    const newId = Date.now().toString();
                    const title = file.name.replace(/\.[^/.]+$/, ""); // Strip extension
                    const doc = {
                        id: newId,
                        title: title,
                        content: content,
                        created: new Date().toISOString(),
                        modified: new Date().toISOString()
                    };
                    docs.push(doc);
                    saveDocs();
                    setActiveDoc(newId);
                    updateDocCount();
                    
                    setTimeout(() => {
                        const ta = document.getElementById('editorTextarea');
                        if(ta) ta.focus();
                    }, 50);
                };
                reader.readAsText(file);
            };
            input.click();
        }

        function deleteDoc(id) {
            const doc = docs.find(d => d.id === id);
            if (!doc) return;

            document.getElementById('confirmMessage').textContent =
                `Ta bort "${doc.title}"? Detta kan inte ångras.`;

            const deleteBtn = document.getElementById('confirmDeleteBtn');
            deleteBtn.onclick = () => {
                docs = docs.filter(d => d.id !== id);
                saveDocs();

                if (activeDocId === id) {
                    activeDocId = docs.length > 0 ? docs[docs.length - 1].id : null;
                    localStorage.setItem(ACTIVE_KEY, activeDocId || '');
                }

                renderTabs();
                renderActiveDoc();
                updateDocCount();
                closeConfirm();
            };

            document.getElementById('confirmOverlay').classList.add('visible');
        }

        function closeConfirm() {
            document.getElementById('confirmOverlay').classList.remove('visible');
        }

        function setActiveDoc(id) {
            activeDocId = id;
            localStorage.setItem(ACTIVE_KEY, id || '');
            renderTabs();
            renderActiveDoc();
        }

        function renderActiveDoc() {
            const doc = getActiveDoc();
            const editorArea = document.getElementById('editorArea');
            const emptyState = document.getElementById('emptyState');
            const textarea = document.getElementById('editorTextarea');
            const statusBar = document.getElementById('statusBar');

            if (!doc) {
                editorArea.style.display = 'none';
                emptyState.style.display = 'flex';
                statusBar.style.display = 'none';
                document.title = 'Skrivr';
                return;
            }

            editorArea.style.display = 'flex';
            emptyState.style.display = 'none';
            statusBar.style.display = 'flex';

            textarea.value = doc.content;
            document.title = `${doc.title} — Skrivr`;

            renderPreview(doc.content);
            updateStats(doc.content);
            applySettings();
            setViewMode(viewMode);
            if (window.HardForkEngine && typeof window.HardForkEngine.resetMemory === 'function') window.HardForkEngine.resetMemory();

            // Update local file disk connection status indicator
            const statusSaved = document.getElementById('statusSaved');
            if (statusSaved) {
                if (doc.isLocalFile) {
                    const hasHandle = !!fileHandles[doc.id];
                    if (!hasHandle) {
                        statusSaved.innerHTML =
                            `<span style="color:#fab005">⚠️</span> Koppling bruten ` +
                            `<button onclick="reconnectLocalFile('${doc.id}')" style="background:#fab005; color:#1a1b1e; border:none; padding:2px 6px; border-radius:4px; font-size:0.6rem; cursor:pointer; font-weight:bold; margin-left:4px;">🔗 Återanslut</button>`;
                    } else {
                        statusSaved.innerHTML =
                            '<span style="color:var(--success)">●</span> Synkad mot disk';
                    }
                } else {
                    statusSaved.innerHTML =
                        '<span class="status-saved">●</span> Sparad';
                }
            }
        }

        // ═══════════════════════════════════════════════
        //  Tab Rendering
        // ═══════════════════════════════════════════════

        function renderTabs() {
            const bar = document.getElementById('tabBar');
            const insertBeforeNode = bar.querySelector('.tab-new') || bar.querySelector('.tab-action:last-child');

            // Remove old tabs
            bar.querySelectorAll('.tab').forEach(t => t.remove());

            docs.forEach(doc => {
                const tab = document.createElement('div');
                tab.className = 'tab' + (doc.id === activeDocId ? ' active' : '');
                tab.dataset.id = doc.id;

                const nameSpan = document.createElement('span');
                nameSpan.className = 'tab-name';
                nameSpan.textContent = doc.title;
                nameSpan.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    startRenameTab(doc.id, tab);
                });

                const close = document.createElement('span');
                close.className = 'tab-close';
                close.textContent = '×';
                close.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteDoc(doc.id);
                });

                tab.appendChild(nameSpan);

                // If local file, append disk icon / warning reconnect icon
                if (doc.isLocalFile) {
                    const localIcon = document.createElement('span');
                    localIcon.className = 'tab-local-icon';
                    
                    const hasHandle = !!fileHandles[doc.id];
                    if (hasHandle) {
                        localIcon.textContent = ' 💾';
                        localIcon.style.color = 'var(--success)';
                        localIcon.title = `Länkad till: ${doc.fileName || doc.title}`;
                    } else {
                        localIcon.textContent = ' 🔗';
                        localIcon.style.color = '#fab005';
                        localIcon.style.cursor = 'pointer';
                        localIcon.title = `Lokal fil bortkopplad: ${doc.fileName || doc.title}. Klicka för att återansluta.`;
                        localIcon.addEventListener('click', (e) => {
                            e.stopPropagation();
                            reconnectLocalFile(doc.id);
                        });
                    }
                    tab.appendChild(localIcon);
                }

                tab.appendChild(close);
                tab.addEventListener('click', () => setActiveDoc(doc.id));

                bar.insertBefore(tab, insertBeforeNode);
            });
        }

        function startRenameTab(docId, tabEl) {
            const doc = docs.find(d => d.id === docId);
            if (!doc) return;

            const nameSpan = tabEl.querySelector('.tab-name');
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'tab-rename-input';
            input.value = doc.title;

            nameSpan.replaceWith(input);
            input.focus();
            input.select();

            const finishRename = () => {
                const newTitle = input.value.trim() || doc.title;
                doc.title = newTitle;
                doc.modified = new Date().toISOString();
                saveDocs();
                renderTabs();
                if (doc.id === activeDocId) {
                    document.title = `${doc.title} — Skrivr`;
                }
            };

            input.addEventListener('blur', finishRename);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { input.blur(); }
                if (e.key === 'Escape') {
                    input.value = doc.title;
                    input.blur();
                }
            });
        }

        function renameFullscreenTitle() {
            const doc = getActiveDoc();
            if (!doc) return;
            const titleEl = document.getElementById('fsTitle');
            if (!titleEl) return;
            
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'fs-title-input';
            input.value = doc.title;
            
            titleEl.replaceWith(input);
            input.focus();
            input.select();
            
            const finishRename = () => {
                const newTitle = input.value.trim() || doc.title;
                doc.title = newTitle;
                doc.modified = new Date().toISOString();
                saveDocs();
                renderTabs(); // Updates background tabs
                document.title = `${doc.title} — Skrivr`;
                
                const span = document.createElement('span');
                span.className = 'fs-title tooltip-wrap';
                span.id = 'fsTitle';
                span.dataset.tip = 'Byt namn';
                span.textContent = newTitle;
                span.onclick = renameFullscreenTitle;
                input.replaceWith(span);
            };
            
            input.addEventListener('blur', finishRename);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { input.blur(); }
                if (e.key === 'Escape') {
                    input.value = doc.title;
                    input.blur();
                }
            });
        }

        // ═══════════════════════════════════════════════
        //  Preview Rendering
        // ═══════════════════════════════════════════════

        function renderPreview(content) {
            const container = document.getElementById('previewContent');
            if (!content || content.trim() === '') {
                container.innerHTML = '<p style="color:var(--text-muted);font-style:italic;">Börja skriva i editorn…</p>';
                return;
            }
            container.innerHTML = marked.parse(content);
        }

        // ═══════════════════════════════════════════════
        //  Editor Events
        // ═══════════════════════════════════════════════

        document.getElementById('editorTextarea').addEventListener('input', (e) => {
            const doc = getActiveDoc();
            if (!doc) return;

            doc.content = e.target.value;
            doc.modified = new Date().toISOString();

            renderPreview(doc.content);
            updateStats(doc.content);

            triggerAutosave(doc);
        });

        // Tab support in textarea
        document.getElementById('editorTextarea').addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const ta = e.target;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(end);
                ta.selectionStart = ta.selectionEnd = start + 4;
                ta.dispatchEvent(new Event('input'));
            }
        });

        // ═══════════════════════════════════════════════
        //  Stats
        // ═══════════════════════════════════════════════

        function updateStats(content) {
            const chars = content.length;
            const words = content.trim() === '' ? 0 : content.trim().split(/\s+/).length;
            const lines = content.split('\n').length;

            document.getElementById('statusChars').textContent = `${chars} tecken`;
            document.getElementById('statusWords').textContent = `${words} ord`;
            document.getElementById('statusLines').textContent = `${lines} rader`;
        }

        function updateDocCount() {
            document.getElementById('statusDocs').textContent = `${docs.length} dokument`;
        }

        // ═══════════════════════════════════════════════
        //  View Mode
        // ═══════════════════════════════════════════════

        function toggleMobileMenu() {
            document.getElementById('toolbarActions').classList.toggle('show');
        }

        function setViewMode(mode) {
            document.getElementById('toolbarActions').classList.remove('show'); // Auto-close menu on selection
            viewMode = mode;
            localStorage.setItem(VIEW_KEY, mode);

            const editorPane = document.getElementById('editorPane');
            const previewPane = document.getElementById('previewPane');

            // Reset
            editorPane.classList.remove('hidden');
            previewPane.classList.remove('hidden');

            if (mode === 'editor') {
                previewPane.classList.add('hidden');
            } else if (mode === 'preview') {
                editorPane.classList.add('hidden');
            }

            // Toggle buttons
            document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));
            document.getElementById('view' + mode.charAt(0).toUpperCase() + mode.slice(1)).classList.add('active');
        }

        // ═══════════════════════════════════════════════
        //  Settings
        // ═══════════════════════════════════════════════

        function openSettings() {
            document.getElementById('toolbarActions').classList.remove('show');
            const settings = loadSettings();
            document.getElementById('settBg').value = settings.previewBg;
            document.getElementById('settColor').value = settings.previewColor;
            document.getElementById('settFontSize').value = settings.fontSize;
            document.getElementById('settFont').value = settings.fontFamily;
            document.getElementById('settEditorBg').value = settings.editorBg;
            document.getElementById('settEditorColor').value = settings.editorColor;
            document.getElementById('settEditorWidth').value = settings.editorWidth || 150;
            updateFontSizeLabel();
            updateEditorWidthLabel();
            document.getElementById('settingsOverlay').classList.add('visible');

            // Live preview
            const inputs = ['settBg', 'settColor', 'settFontSize', 'settFont', 'settEditorBg', 'settEditorColor', 'settEditorWidth'];
            inputs.forEach(id => {
                document.getElementById(id).addEventListener('input', liveApplySettings);
                document.getElementById(id).addEventListener('change', liveApplySettings);
            });
        }

        function liveApplySettings() {
            const settings = {
                previewBg: document.getElementById('settBg').value,
                previewColor: document.getElementById('settColor').value,
                fontSize: parseInt(document.getElementById('settFontSize').value),
                fontFamily: document.getElementById('settFont').value,
                editorBg: document.getElementById('settEditorBg').value,
                editorColor: document.getElementById('settEditorColor').value,
                editorWidth: parseInt(document.getElementById('settEditorWidth').value)
            };
            // Bevara existerande inställningar (fokusläge)
            const old = loadSettings();
            old.previewBg = settings.previewBg;
            old.previewColor = settings.previewColor;
            old.fontSize = settings.fontSize;
            old.fontFamily = settings.fontFamily;
            old.editorBg = settings.editorBg;
            old.editorColor = settings.editorColor;
            old.editorWidth = settings.editorWidth;
            
            saveSettings(old);
            applySettings();
            updateFontSizeLabel();
            updateEditorWidthLabel();
        }

        function closeSettings() {
            document.getElementById('settingsOverlay').classList.remove('visible');
        }

        function resetSettings() {
            saveSettings(DEFAULT_SETTINGS);
            document.getElementById('settBg').value = DEFAULT_SETTINGS.previewBg;
            document.getElementById('settColor').value = DEFAULT_SETTINGS.previewColor;
            document.getElementById('settFontSize').value = DEFAULT_SETTINGS.fontSize;
            document.getElementById('settFont').value = DEFAULT_SETTINGS.fontFamily;
            document.getElementById('settEditorBg').value = DEFAULT_SETTINGS.editorBg;
            document.getElementById('settEditorColor').value = DEFAULT_SETTINGS.editorColor;
            document.getElementById('settEditorWidth').value = DEFAULT_SETTINGS.editorWidth;
            updateFontSizeLabel();
            updateEditorWidthLabel();
            applySettings();
        }

        function updateFontSizeLabel() {
            document.getElementById('fontSizeLabel').textContent =
                document.getElementById('settFontSize').value + 'px';
        }

        function updateEditorWidthLabel() {
            const val = document.getElementById('settEditorWidth').value;
            document.getElementById('editorWidthLabel').textContent = val >= 150 ? 'Max' : val + 'ch';
        }

        function applySettings() {
            const settings = loadSettings();
            const preview = document.getElementById('previewContent');
            const textarea = document.getElementById('editorTextarea');

            preview.style.background = settings.previewBg;
            preview.style.color = settings.previewColor;
            preview.style.fontSize = settings.fontSize + 'px';

            // Font family mapping
            const fontMap = {
                serif: 'var(--font-serif)',
                sans: 'var(--font-sans)',
                mono: 'var(--font-mono)'
            };
            // Apply to paragraphs and lists
            preview.querySelectorAll('p, li, blockquote').forEach(el => {
                el.style.fontFamily = fontMap[settings.fontFamily] || fontMap.serif;
                el.style.fontSize = settings.fontSize + 'px';
                el.style.color = settings.previewColor;
            });

            // Editor styling
            textarea.style.background = settings.editorBg;
            textarea.style.color = settings.editorColor;
            textarea.style.fontSize = settings.fontSize + 'px';
            textarea.style.fontFamily = fontMap[settings.fontFamily] || fontMap.mono;

            const eWidth = settings.editorWidth || 150;
            if (eWidth >= 150) {
                textarea.style.maxWidth = '100%';
            } else {
                textarea.style.maxWidth = eWidth + 'ch';
            }
            textarea.style.margin = '0 auto';

            // Also style the preview pane background
            document.getElementById('previewPane').querySelector('.pane-label + .preview-content') ||
            (document.querySelector('.preview-content').style.background = settings.previewBg);
        }

        // ═══════════════════════════════════════════════
        //  Copy & Export
        // ═══════════════════════════════════════════════

        async function copyMarkdown() {
            document.getElementById('toolbarActions').classList.remove('show');
            const doc = getActiveDoc();
            if (!doc) return;

            try {
                await navigator.clipboard.writeText(doc.content);
                const feedback = document.getElementById('copyFeedback');
                feedback.classList.add('show');
                setTimeout(() => feedback.classList.remove('show'), 2000);
            } catch {
                // Fallback
                const textarea = document.createElement('textarea');
                textarea.value = doc.content;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);

                const feedback = document.getElementById('copyFeedback');
                feedback.classList.add('show');
                setTimeout(() => feedback.classList.remove('show'), 2000);
            }
        }

        function exportTxt() {
            document.getElementById('toolbarActions').classList.remove('show');
            const doc = getActiveDoc();
            if (!doc) return;

            const blob = new Blob([doc.content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (doc.title || 'dokument') + '.txt';
            a.click();
            URL.revokeObjectURL(url);
        }

        function exportPdf() {
            document.getElementById('toolbarActions').classList.remove('show');
            const doc = getActiveDoc();
            if (!doc) return;

            // Ensure preview is visible for printing
            const previewPane = document.getElementById('previewPane');
            const wasHidden = previewPane.classList.contains('hidden');
            if (wasHidden) previewPane.classList.remove('hidden');

            window.print();

            // Restore view
            if (wasHidden) previewPane.classList.add('hidden');
        }

        // ═══════════════════════════════════════════════
        //  Keyboard Shortcuts
        // ═══════════════════════════════════════════════

        document.addEventListener('keydown', (e) => {
            const isCmd = e.metaKey || e.ctrlKey;

            if (isCmd && e.key === 'n') {
                e.preventDefault();
                createNewDoc();
            }

            if (isCmd && e.key === 's') {
                e.preventDefault();
                const doc = getActiveDoc();
                if (doc) {
                    saveDocs();
                    document.getElementById('statusSaved').innerHTML =
                        '<span class="status-saved">●</span> Sparad';
                }
            }

            if (isCmd && e.key === 'p') {
                e.preventDefault();
                exportPdf();
            }

            if (isCmd && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
                e.preventDefault();
                copyMarkdown();
            }

            if (isCmd && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
                e.preventDefault();
                toggleTimerPop({ target: document.getElementById('timerWidget') });
                setTimeout(() => {
                    const el = document.getElementById('goalTarget');
                    if(el) { el.focus(); el.select(); }
                }, 100);
            }

            // Switch tabs with Cmd+1-9
            if (isCmd && e.key >= '1' && e.key <= '9') {
                e.preventDefault();
                const idx = parseInt(e.key) - 1;
                if (idx < docs.length) {
                    setActiveDoc(docs[idx].id);
                }
            }

            // Fullscreen toggle (Focus Mode)
            if (isCmd && e.key === 'Enter') {
                e.preventDefault();
                if (isFullscreen) closeFocusMode();
                else enterFullscreen();
            }

            // Browser Fullscreen toggle
            if (e.key === 'F11' || (isCmd && e.shiftKey && (e.key === 'f' || e.key === 'F'))) {
                e.preventDefault();
                toggleBrowserFullscreen();
            }

            // Close settings/confirm/fullscreen on Escape
            if (e.key === 'Escape') {
                if (isFullscreen) {
                    closeFocusMode();
                } else if (document.getElementById('settingsOverlay').classList.contains('visible')) {
                    closeSettings();
                } else if (document.getElementById('confirmOverlay').classList.contains('visible')) {
                    closeConfirm();
                }
            }
        });

        // ═══════════════════════════════════════════════
        //  Close overlay on background click
        // ═══════════════════════════════════════════════

        document.getElementById('settingsOverlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeSettings();
        });

        document.getElementById('confirmOverlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeConfirm();
        });

        // ═══════════════════════════════════════════════
        //  Fullscreen / Focus Mode
        // ═══════════════════════════════════════════════

        function enterFullscreen() {
            document.getElementById('toolbarActions').classList.remove('show');
            const doc = getActiveDoc();
            if (!doc) return;

            // Trigger browser native fullscreen automatically
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
            }

            isFullscreen = true;
            const overlay = document.getElementById('fullscreenOverlay');
            const fsTa = document.getElementById('fsTextarea');
            const settings = loadSettings();

            // Sync content
            fsTa.value = doc.content;
            document.getElementById('fsTitle').textContent = doc.title;

            // Apply editor colors
            const fsWrap = document.getElementById('fsEditorWrap');
            fsWrap.style.background = '';
            overlay.style.background = '';
            fsTa.style.color = '#ffffff'; // Tvinga fram vit färg i Zen-läget för kontrast mot den mörka skogen


            fsTa.style.fontSize = (settings.fontSize || 16) + 'px';
            const fontMap = { serif: 'var(--font-serif)', sans: 'var(--font-sans)', mono: 'var(--font-mono)' };
            fsTa.style.fontFamily = fontMap[settings.fontFamily] || fontMap.mono;

            // Typewriter state
            typewriterEnabled = settings.typewriter || false;
            typewriterSoundEnabled = settings.typewriterSound || false;
            typewriterSoundProfile = settings.typewriterSoundProfile || 'digital';
            
            // Apply fsFontSize to slider and textarea
            if (settings.fsFontSize) {
                document.getElementById('fsFontSizeSlider').value = settings.fsFontSize;
                setFsFontSize(settings.fsFontSize, false); // apply without saving settings again
            }

            // Apply Zen background
            if (settings.fsBgType === 'image') {
                overlay.classList.add('bg-image');
            } else {
                overlay.classList.remove('bg-image');
            }
            
            if (typewriterSoundProfile === 'skogsklang') {
                overlay.style.background = "linear-gradient(to bottom, rgba(8, 12, 25, 0.85), rgba(4, 6, 12, 0.95)), url('forest-bg.jpg') no-repeat center center";
                overlay.style.backgroundSize = 'cover';
            } else {
                overlay.style.background = '';
            }
            
            document.getElementById('settZenBg').value = settings.fsBgType || 'gradient';

            highlightColor = settings.highlightColor || 'rgba(124,92,191,0.12)';
            const container = document.getElementById('fsEditorContainer');
            const btnCenter = document.getElementById('btnCenterScroll');
            if (typewriterEnabled) {
                container.classList.add('typewriter-active');
                if (btnCenter) btnCenter.style.display = 'inline-block';
            } else {
                container.classList.remove('typewriter-active');
                if (btnCenter) btnCenter.style.display = 'none';
            }
            document.getElementById('fsLineHighlight').style.background = highlightColor;

            // Focus dimming state
            focusDimmingEnabled = settings.focusDimming || false;
            const focusZoneLines = settings.focusZoneLines || 3;
            document.getElementById('fsZoneSlider').value = focusZoneLines;
            document.getElementById('fsZoneValue').textContent = focusZoneLines + ' Rader';
            
            const btnDim = document.getElementById('btnFocusDim');
            const zoneControl = document.getElementById('fsZoneControl');
            if (focusDimmingEnabled) {
                container.classList.add('focus-dimming');
                if (btnDim) {
                    btnDim.textContent = '👁 Dimma: På ✓';
                    btnDim.classList.add('active');
                }
                if (zoneControl) zoneControl.style.display = 'flex';
            } else {
                container.classList.remove('focus-dimming');
                if (btnDim) {
                    btnDim.textContent = '👁 Dimma: Av';
                    btnDim.classList.remove('active');
                }
                if (zoneControl) zoneControl.style.display = 'none';
            }

            // Column width
            const savedWidth = settings.fsColumnWidth || 72;
            const container2 = document.getElementById('fsEditorContainer');
            if (savedWidth >= 130) {
                container2.style.maxWidth = '100%';
            } else {
                container2.style.maxWidth = savedWidth + 'ch';
            }
            document.getElementById('fsWidthSlider').value = savedWidth;
            document.getElementById('fsWidthValue').textContent = savedWidth >= 130 ? '100%' : savedWidth + 'ch';

            overlay.classList.add('visible');
            updateFsWordCount(doc.content);
            buildOutline();
            startZenTimer();

            // Initiera Valsång/Skogsklang om det är valt
            if (window.TextContext) window.TextContext.attach(document.getElementById('fsTextarea'));
            const isContinuousProfile = ['valsang', 'skogsklang'].includes(typewriterSoundProfile);
            if (isContinuousProfile && typewriterSoundEnabled) {
                if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
                if (audioCtx.state === 'suspended') audioCtx.resume();
                if (typewriterSoundProfile === 'valsang' && window.ValsangEngine) {
                    window.ValsangEngine.init(audioCtx);
                    window.ValsangEngine.setVolume(settings.valsangVol !== undefined ? settings.valsangVol : 0.6);
                    window.ValsangEngine.setDepth(settings.valsangDepth !== undefined ? settings.valsangDepth : 1.0);
                }
                if (typewriterSoundProfile === 'skogsklang' && window.SkogsklangEngine) {
                    window.SkogsklangEngine.init(audioCtx);
                    window.SkogsklangEngine.setVolume(settings.valsangVol !== undefined ? settings.valsangVol : 0.6);
                    window.SkogsklangEngine.setDepth(settings.valsangDepth !== undefined ? settings.valsangDepth : 1.0);
                    window.SkogsklangEngine.onSentence(info => {
                        if (window.VisualsEngine) {
                            window.VisualsEngine.spawnSentenceFirefly(info.length);
                        }
                    });
                }
            }
            
            // Initiera VisualsEngine
            if (window.VisualsEngine) {
                const domElements = {
                    sonogramCanvas: document.getElementById('sonogramCanvas'),
                    mareldCanvas: document.getElementById('mareldCanvas'),
                    mareldVeil: document.getElementById('mareldVeil'),
                    djupvattenContainer: document.getElementById('djupvattenContainer'),
                    djupvattenLayers: Array.from(document.querySelectorAll('.dj-layer'))
                };
                
                let stateProvider = () => ({});
                if (typewriterSoundProfile === 'valsang' && window.ValsangEngine) {
                    stateProvider = () => window.ValsangEngine.getState();
                } else if (typewriterSoundProfile === 'skogsklang' && window.SkogsklangEngine) {
                    stateProvider = () => window.SkogsklangEngine.getState();
                }

                window.VisualsEngine.init(domElements, stateProvider);
                window.VisualsEngine.setConfig({
                    sonogramEnabled: settings.valsangSonogram !== false,
                    djupvattenEnabled: settings.valsangDjupvatten !== false,
                    mareldEnabled: settings.valsangMareld !== false,
                    skogstemaMode: (typewriterSoundProfile === 'skogsklang'),
                    fireflyMode: settings.fireflyMode || 'sentence',
                    goalProgress: window._currentGoalProgress || 0,
                    theme: 'dark'
                });
                
                // Bara kör om Valsång eller Skogsklang är valt
                if (isContinuousProfile && typewriterSoundEnabled) {
                    window.VisualsEngine.start();
                }
            }

            setTimeout(() => {
                fsTa.focus();
                updateLineHighlight(true);
            }, 50);
        }

        function closeFocusMode() {
            if (window.TextContext) window.TextContext.attach(document.getElementById('editorTextarea'));
            isFullscreen = false;
            const overlay = document.getElementById('fullscreenOverlay');
            const fsTa = document.getElementById('fsTextarea');

            // Sync content back
            const doc = getActiveDoc();
            if (doc) {
                doc.content = fsTa.value;
                doc.modified = new Date().toISOString();
                saveDocs();
                document.getElementById('editorTextarea').value = doc.content;
                renderPreview(doc.content);
                updateStats(doc.content);
            }

            overlay.classList.remove('visible');

            if (window.ValsangEngine) {
                window.ValsangEngine.destroy();
            }
            if (window.SkogsklangEngine) {
                window.SkogsklangEngine.destroy();
            }
            if (window.VisualsEngine) {
                window.VisualsEngine.stop();
            }

            // Exit browser fullscreen if active
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
        }

        function toggleBrowserFullscreen() {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen().catch(() => {});
            }
        }

        // Update button label when browser fullscreen changes
        document.addEventListener('fullscreenchange', () => {
            const btn = document.getElementById('btnBrowserFs');
            if (btn) {
                btn.textContent = document.fullscreenElement ? '⛶ Avsluta' : '⛶ Helskärm';
            }
        });

        // Fullscreen textarea events
        document.getElementById('fsTextarea').addEventListener('input', (e) => {
            const doc = getActiveDoc();
            if (!doc) return;

            doc.content = e.target.value;
            doc.modified = new Date().toISOString();

            updateFsWordCount(doc.content);

            triggerAutosave(doc);

            updateLineHighlight(true);
        });

        let _lastCursorPos = -1;
        function checkCursorMove() {
            if (!isFullscreen || !typewriterEnabled) return;
            const ta = document.getElementById('fsTextarea');
            if (ta && ta.selectionStart !== _lastCursorPos) {
                _lastCursorPos = ta.selectionStart;
                updateLineHighlight(true);
            }
        }
        document.getElementById('fsTextarea').addEventListener('click', () => setTimeout(checkCursorMove, 0));
        document.getElementById('fsTextarea').addEventListener('keyup', checkCursorMove);
        
        function ensureAudio() {
            if (!audioCtx || audioCtx.state === 'closed') {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtx.state === 'suspended') audioCtx.resume();
        }
        document.addEventListener('pointerdown', ensureAudio, { passive: true, capture: true });

        document.getElementById('fsTextarea').addEventListener('beforeinput', (ev) => {
            if (!typewriterSoundEnabled) return;
            ensureAudio();
            const profile = (typeof settings !== 'undefined' ? settings : loadSettings()).typewriterSoundProfile || typewriterSoundProfile;
            let engine = null;
            if (profile === 'valsang') engine = window.ValsangEngine;
            else if (profile === 'skogsklang') engine = window.SkogsklangEngine;
            if (!engine) return;
            
            const t = ev.inputType;
            if (t === 'insertText' && ev.data) {
                for (const ch of ev.data) engine.handleChar(ch);
            } else if (t === 'insertLineBreak' || t === 'insertParagraph') {
                engine.handleChar('\n');
            } else if (t.startsWith('deleteContent')) {
                engine.handleChar('\b');
            }
        });

        document.getElementById('fsTextarea').addEventListener('keydown', (e) => {
            setTimeout(checkCursorMove, 0);

            // Skrivmaskinsljud om påslaget
            if (typewriterSoundEnabled) {
                if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
                if (audioCtx.state === 'suspended') audioCtx.resume();
                
                if (typewriterSoundProfile === 'valsang' || typewriterSoundProfile === 'skogsklang') {
                    return; // Hanteras av beforeinput
                }
                if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                    const isEnter = e.key === 'Enter';
                    const isSpace = e.key === ' ';
                    const isBackspace = e.key === 'Backspace';
                    
                    const osc = audioCtx.createOscillator();
                    const oscGain = audioCtx.createGain();
                    const filter = audioCtx.createBiquadFilter();
                    
                    let frequency, rampToFreq, gainVol, rampToGain, duration, filterFreq, filterQ;
                    
                    if (typewriterSoundProfile === 'mechanical') {
                        // Mekanisk skrivmaskin (klack, klack, ding på enter)
                        osc.type = isEnter ? 'sine' : 'square';
                        if (isEnter) {
                            frequency = 1800; rampToFreq = 1800;
                            gainVol = 0.5; rampToGain = 0.01; duration = 0.4;
                            filterFreq = 2000; filterQ = 10.0;
                        } else if (isBackspace) {
                            frequency = 120; rampToFreq = 40;
                            gainVol = 0.4; rampToGain = 0.01; duration = 0.08;
                            filterFreq = 800; filterQ = 1.0;
                        } else if (isSpace) {
                            frequency = 100; rampToFreq = 50;
                            gainVol = 0.2; rampToGain = 0.01; duration = 0.05;
                            filterFreq = 600; filterQ = 1.0;
                        } else {
                            frequency = 400 + Math.random() * 100; rampToFreq = 50;
                            gainVol = 0.6; rampToGain = 0.01; duration = 0.05;
                            filterFreq = 1500; filterQ = 2.0;
                        }
                    } else if (typewriterSoundProfile === 'vintage') {
                        // Vintage, tung skrivmaskin
                        osc.type = isEnter ? 'triangle' : 'sawtooth';
                        if (isEnter) {
                            frequency = 2500; rampToFreq = 2000;
                            gainVol = 0.6; rampToGain = 0.01; duration = 0.5;
                            filterFreq = 3000; filterQ = 5.0;
                        } else if (isBackspace) {
                            frequency = 80; rampToFreq = 30;
                            gainVol = 0.6; rampToGain = 0.01; duration = 0.1;
                            filterFreq = 500; filterQ = 0.5;
                        } else {
                            frequency = 150 + Math.random() * 50; rampToFreq = 40;
                            gainVol = 0.8; rampToGain = 0.01; duration = 0.06;
                            filterFreq = 1000; filterQ = 0.5;
                        }
                    } else {
                        // Original digital
                        osc.type = 'square';
                        frequency = isEnter ? 150 : 250;
                        rampToFreq = 50;
                        gainVol = isEnter ? 0.6 : 0.4;
                        rampToGain = 0.01;
                        duration = isEnter ? 0.1 : 0.05;
                        filterFreq = isEnter ? 1000 : 2000;
                        filterQ = 1.0;
                    }

                    osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);
                    if (rampToFreq !== frequency) {
                        osc.frequency.exponentialRampToValueAtTime(rampToFreq, audioCtx.currentTime + (duration / 2));
                    }
                    
                    oscGain.gain.setValueAtTime(0, audioCtx.currentTime);
                    oscGain.gain.linearRampToValueAtTime(gainVol, audioCtx.currentTime + 0.01);
                    oscGain.gain.exponentialRampToValueAtTime(rampToGain, audioCtx.currentTime + duration);
                    
                    filter.type = 'bandpass';
                    filter.frequency.value = filterFreq;
                    filter.Q.value = filterQ;
                    
                    osc.connect(filter);
                    filter.connect(oscGain);
                    oscGain.connect(audioCtx.destination);
                    
                    // Add some noise for vintage mechanical feel
                    if (typewriterSoundProfile === 'mechanical' || typewriterSoundProfile === 'vintage') {
                        const bufferSize = audioCtx.sampleRate * duration;
                        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
                        const data = buffer.getChannelData(0);
                        for (let i = 0; i < bufferSize; i++) {
                            data[i] = Math.random() * 2 - 1;
                        }
                        const noise = audioCtx.createBufferSource();
                        noise.buffer = buffer;
                        const noiseFilter = audioCtx.createBiquadFilter();
                        noiseFilter.type = typewriterSoundProfile === 'vintage' ? 'lowpass' : 'highpass';
                        noiseFilter.frequency.value = typewriterSoundProfile === 'vintage' ? 800 : 3000;
                        
                        const noiseGain = audioCtx.createGain();
                        noiseGain.gain.setValueAtTime(0, audioCtx.currentTime);
                        noiseGain.gain.linearRampToValueAtTime(typewriterSoundProfile === 'vintage' ? 0.4 : 0.2, audioCtx.currentTime + 0.01);
                        noiseGain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
                        
                        noise.connect(noiseFilter);
                        noiseFilter.connect(noiseGain);
                        noiseGain.connect(audioCtx.destination);
                        noise.start(audioCtx.currentTime);
                        noise.stop(audioCtx.currentTime + duration);
                    }
                    
                    osc.start(audioCtx.currentTime);
                    osc.stop(audioCtx.currentTime + duration);
                }
            }
        });
        document.getElementById('fsTextarea').addEventListener('focus', checkCursorMove);

        // Suppress scroll re-centering while interacting with header buttons
        let _headerInteracting = false;
        const fsHeader = document.querySelector('.fs-header');
        fsHeader.addEventListener('mousedown', () => { _headerInteracting = true; });
        document.addEventListener('mouseup', () => { _headerInteracting = false; });

        // On manual scroll, update highlight position but do NOT force re-center
        // Also temporarily clear focus dimming if active so user can read everything
        document.getElementById('fsTextarea').addEventListener('scroll', () => {
            if (_suppressScroll || _headerInteracting) return;
            updateLineHighlight(false);
            if (focusDimmingEnabled) {
                const ta = document.getElementById('fsTextarea');
                ta.style.webkitMaskImage = '';
                ta.style.maskImage = '';
            }
        });

        // Tab in fullscreen
        document.getElementById('fsTextarea').addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const ta = e.target;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(end);
                ta.selectionStart = ta.selectionEnd = start + 4;
                ta.dispatchEvent(new Event('input'));
            }
        });

        function updateFsWordCount(content) {
            const words = content.trim() === '' ? 0 : content.trim().split(/\s+/).length;
            document.getElementById('fsWordCount').textContent = `${words} ord`;
        }

        // ═══════════════════════════════════════════════
        //  Typewriter Mode — Line Highlight
        // ═══════════════════════════════════════════════

        let _suppressScroll = false;

        function updateLineHighlight(autoScroll = false) {
            if (!isFullscreen || !typewriterEnabled) return;

            const ta = document.getElementById('fsTextarea');
            const highlight = document.getElementById('fsLineHighlight');
            if (!ta || !highlight) return;

            // Get line height from computed style (handle unitless + px) for highlight sizing
            const style = window.getComputedStyle(ta);
            let lineHeight = parseFloat(style.lineHeight);
            if (style.lineHeight.indexOf('px') === -1 || isNaN(lineHeight) || lineHeight < 5) {
                const fontSize = parseFloat(style.fontSize) || 16;
                lineHeight = (parseFloat(style.lineHeight) || 1.85) * fontSize;
            }

            // Sync visual typography to a mirror div to compute exact word-wrapped caret position
            let mirror = document.getElementById('fsMirror');
            if (!mirror) {
                mirror = document.createElement('div');
                mirror.id = 'fsMirror';
                document.body.appendChild(mirror);
            }

            const props = ['direction','paddingTop','paddingRight','paddingBottom','paddingLeft',
                'fontStyle','fontVariant','fontWeight','fontStretch','fontSize','fontSizeAdjust',
                'lineHeight','fontFamily','textAlign','textTransform','textIndent',
                'textDecoration','letterSpacing','wordSpacing','tabSize','MozTabSize'];
            props.forEach(p => mirror.style[p] = style[p]);
            
            mirror.style.position = 'absolute';
            mirror.style.visibility = 'hidden';
            mirror.style.whiteSpace = 'pre-wrap';
            mirror.style.wordWrap = 'break-word';
            mirror.style.top = '0';
            mirror.style.left = '-9999px';
            mirror.style.height = 'auto';
            mirror.style.boxSizing = 'border-box';
            mirror.style.border = '0';
            // Align exact padding box so scrollbars don't skew word-wrapping
            mirror.style.width = ta.clientWidth + 'px';

            const text = ta.value;
            const cursorPos = ta.selectionStart;
            mirror.textContent = text.substring(0, cursorPos);
            
            const span = document.createElement('span');
            span.textContent = text.substring(cursorPos, cursorPos + 1) || '\u200B';
            mirror.appendChild(span);

            // Fetch exact Y coordinate factoring in word-wraps natively
            const absoluteLineTop = span.offsetTop;

            // Auto-scroll: center the cursor line in the viewport
            if (autoScroll) {
                const viewportHeight = ta.clientHeight;
                const centerY = viewportHeight / 2;
                const targetScroll = absoluteLineTop - centerY + (lineHeight / 2);

                // Suppress the scroll event caused by us setting scrollTop
                _suppressScroll = true;
                ta.scrollTop = Math.max(0, targetScroll);

                // Release suppression after browser has settled
                requestAnimationFrame(() => { _suppressScroll = false; });
            }

            // Position highlight relative to the visible viewport
            const visibleTop = absoluteLineTop - ta.scrollTop;

            highlight.style.top = visibleTop + 'px';
            highlight.style.height = lineHeight + 'px';
            highlight.style.left = '16px';
            highlight.style.right = '16px';
            highlight.style.background = highlightColor;

            // Update focus dimming via CSS Mask
            if (focusDimmingEnabled) {
                const settings = loadSettings();
                const zoneLines = settings.focusZoneLines || 3;
                const fadeZone = lineHeight * zoneLines;
                const dimTopEnd = Math.max(0, visibleTop - fadeZone);
                const dimBottomStart = visibleTop + lineHeight + fadeZone;
                
                const maskCSS = `linear-gradient(to bottom, 
                    transparent 0px, 
                    transparent ${Math.max(0, dimTopEnd - fadeZone)}px, 
                    black ${dimTopEnd}px, 
                    black ${dimBottomStart}px, 
                    transparent ${dimBottomStart + fadeZone}px, 
                    transparent 100%)`;
                
                ta.style.webkitMaskImage = maskCSS;
                ta.style.maskImage = maskCSS;
            } else {
                ta.style.webkitMaskImage = '';
                ta.style.maskImage = '';
            }
        }

        // ═══════════════════════════════════════════════
        //  Focus Dimming, Zen Mode, Menu & Outline
        // ═══════════════════════════════════════════════

        function toggleFsSettings(e) {
            e.stopPropagation();
            document.getElementById('fsSettingsDropdown').classList.toggle('open');
            document.getElementById('btnFsSettings').classList.toggle('active');
        }

        document.addEventListener('click', (e) => {
            const dropdown = document.getElementById('fsSettingsDropdown');
            if (dropdown && dropdown.classList.contains('open') && !dropdown.contains(e.target)) {
                dropdown.classList.remove('open');
                document.getElementById('btnFsSettings').classList.remove('active');
            }
        });

        function toggleFocusDimming() {
            focusDimmingEnabled = !focusDimmingEnabled;
            const container = document.getElementById('fsEditorContainer');
            const btn = document.getElementById('btnFocusDim');
            const ta = document.getElementById('fsTextarea');
            const zoneControl = document.getElementById('fsZoneControl');
            if (focusDimmingEnabled) {
                container.classList.add('focus-dimming');
                if (btn) {
                    btn.textContent = '👁 Dimma: På ✓';
                    btn.classList.add('active');
                }
                if (zoneControl) zoneControl.style.display = 'flex';
            } else {
                container.classList.remove('focus-dimming');
                if (btn) {
                    btn.textContent = '👁 Dimma: Av';
                    btn.classList.remove('active');
                }
                if (zoneControl) zoneControl.style.display = 'none';
                if (ta) {
                    ta.style.webkitMaskImage = '';
                    ta.style.maskImage = '';
                }
            }
            const settings = loadSettings();
            settings.focusDimming = focusDimmingEnabled;
            saveSettings(settings);
            updateLineHighlight(false);
        }

        function setFsZone(val) {
            document.getElementById('fsZoneValue').textContent = val + ' Rader';
            const settings = loadSettings();
            settings.focusZoneLines = parseInt(val, 10);
            saveSettings(settings);
            updateLineHighlight(false);
        }

        // ── Total Zen ──
        let lastZenReset = 0;

        function startZenTimer() {
            const overlay = document.getElementById('fullscreenOverlay');
            clearTimeout(zenTimer);
            overlay.classList.remove('zen-mode');
            if (isFullscreen) {
                zenTimer = setTimeout(() => {
                    overlay.classList.add('zen-mode');
                }, 3000);
            }
        }

        function resetZen() {
            if (!isFullscreen) return;
            const now = Date.now();
            if (now - lastZenReset < 200) return; // VEP Opt: Throttle events to prevent GC thrashing
            lastZenReset = now;
            
            const overlay = document.getElementById('fullscreenOverlay');
            if (overlay.classList.contains('zen-mode')) {
                overlay.classList.remove('zen-mode');
            }
            clearTimeout(zenTimer);
            zenTimer = setTimeout(() => {
                if (isFullscreen) overlay.classList.add('zen-mode');
            }, 3000);
        }

        // Zen triggers: mouse, keyboard, touch
        document.getElementById('fullscreenOverlay').addEventListener('mousemove', resetZen);
        document.getElementById('fullscreenOverlay').addEventListener('touchstart', resetZen);
        document.getElementById('fsTextarea').addEventListener('keydown', resetZen);

        // ── Heading Outline ──
        let outlineDebounce = null;

        function toggleOutline() {
            const panel = document.getElementById('fsOutline');
            panel.classList.toggle('open');
            if (panel.classList.contains('open')) buildOutline();
        }

        function buildOutline() {
            const ta = document.getElementById('fsTextarea');
            const list = document.getElementById('fsOutlineList');
            if (!ta || !list) return;

            const text = ta.value;
            const regex = /^(#{1,4})\s+(.+)$/gm;
            let match;
            const items = [];
            while ((match = regex.exec(text)) !== null) {
                items.push({
                    level: match[1].length,
                    title: match[2].trim(),
                    index: match.index
                });
            }

            list.innerHTML = '';

            if (items.length === 0) {
                list.innerHTML = '<div class="fs-outline-empty">Inga rubriker hittades. Använd # för att skapa rubriker.</div>';
                return;
            }

            const cursorPos = ta.selectionStart;
            items.forEach((item, i) => {
                const btn = document.createElement('button');
                btn.className = `fs-outline-item h${item.level}`;
                btn.textContent = item.title;
                btn.dataset.charIndex = item.index;

                // Highlight active heading (closest before cursor)
                const nextIndex = (i + 1 < items.length) ? items[i + 1].index : text.length;
                if (cursorPos >= item.index && cursorPos < nextIndex) {
                    btn.classList.add('active');
                }

                btn.addEventListener('click', () => {
                    outlineNavigateTo(item.index);
                });
                list.appendChild(btn);
            });
        }

        function outlineNavigateTo(charIndex) {
            const ta = document.getElementById('fsTextarea');
            ta.focus();
            ta.selectionStart = ta.selectionEnd = charIndex;
            updateLineHighlight(true);
            buildOutline(); // refresh active state
        }

        // Rebuild outline on text input (debounced)
        document.getElementById('fsTextarea').addEventListener('input', () => {
            clearTimeout(outlineDebounce);
            outlineDebounce = setTimeout(buildOutline, 500);
        });

        // ═══════════════════════════════════════════════
        //  Typewriter Settings Helpers
        // ═══════════════════════════════════════════════

        function toggleTypewriterSetting() {
            const track = document.getElementById('settTypewriter');
            track.classList.toggle('active');
            const settings = loadSettings();
            settings.typewriter = track.classList.contains('active');
            saveSettings(settings);
        }

        function toggleTypewriterSoundSetting() {
            const track = document.getElementById('settTypewriterSound');
            track.classList.toggle('active');
            
            const settings = loadSettings();
            settings.typewriterSound = track.classList.contains('active');
            
            // Show/hide profile selection based on toggle
            document.getElementById('soundProfileRow').style.display = settings.typewriterSound ? 'flex' : 'none';

            if (settings.typewriterSound && !audioCtx) {
                audioCtx = new AudioContext();
            }

            saveSettings(settings);
            applySettings(settings);
        }

        function updateSoundProfileSetting() {
            const settings = loadSettings();
            settings.typewriterSoundProfile = document.getElementById('settTypewriterSoundProfile').value;
            saveSettings(settings);
            applySettings(settings);
            
            const isContinuous = ['valsang', 'skogsklang'].includes(settings.typewriterSoundProfile);
            document.getElementById('valsangSettings').style.display = isContinuous ? 'flex' : 'none';
            document.getElementById('valsangWaterSettings').style.display = (settings.typewriterSoundProfile === 'valsang') ? 'block' : 'none';
            document.getElementById('skogsklangSettings').style.display = (settings.typewriterSoundProfile === 'skogsklang') ? 'block' : 'none';
            
            if (window.ValsangEngine) window.ValsangEngine.destroy();
            if (window.SkogsklangEngine) window.SkogsklangEngine.destroy();
            
            if (isContinuous && settings.typewriterSound && isFullscreen) {
                if (settings.typewriterSoundProfile === 'valsang' && window.ValsangEngine) {
                    window.ValsangEngine.init(audioCtx);
                } else if (settings.typewriterSoundProfile === 'skogsklang' && window.SkogsklangEngine) {
                    window.SkogsklangEngine.init(audioCtx);
                    window.SkogsklangEngine.onSentence((info) => {
                        if (window.VisualsEngine) {
                            window.VisualsEngine.spawnSentenceFirefly(info.length);
                        }
                    });
                }
                
                if (window.VisualsEngine) {
                    window.VisualsEngine.setConfig({ 
                        skogstemaMode: (settings.typewriterSoundProfile === 'skogsklang'),
                        fireflyMode: settings.fireflyMode || 'sentence'
                    });
                    
                    let stateProvider = () => ({});
                    if (settings.typewriterSoundProfile === 'valsang' && window.ValsangEngine) {
                        stateProvider = () => window.ValsangEngine.getState();
                    } else if (settings.typewriterSoundProfile === 'skogsklang' && window.SkogsklangEngine) {
                        stateProvider = () => window.SkogsklangEngine.getState();
                    }
                    window.VisualsEngine.setStateProvider(stateProvider);
                    window.VisualsEngine.start();
                }
            } else {
                if (window.VisualsEngine) window.VisualsEngine.stop();
            }
            
            // Uppdatera bakgrund direkt om vi är i fullscreen
            if (isFullscreen) {
                const overlay = document.getElementById('fullscreenOverlay');
                if (settings.typewriterSoundProfile === 'skogsklang') {
                    overlay.style.background = "linear-gradient(to bottom, rgba(8, 12, 25, 0.7), rgba(4, 6, 12, 0.9)), url('forest-bg.jpg') no-repeat center center";
                    overlay.style.backgroundSize = 'cover';
                } else {
                    overlay.style.background = ""; 
                }
            }
        }

        function updateValsangSettings() {
            const settings = loadSettings();
            settings.valsangVol = parseFloat(document.getElementById('settValsangVol').value);
            settings.valsangDepth = parseFloat(document.getElementById('settValsangDepth').value);
            
            const fireflySelect = document.getElementById('settFireflyMode');
            if (fireflySelect) {
                settings.fireflyMode = fireflySelect.value;
            }
            
            saveSettings(settings);
            
            if (window.ValsangEngine) {
                window.ValsangEngine.setVolume(settings.valsangVol);
                window.ValsangEngine.setDepth(settings.valsangDepth);
            }
            if (window.SkogsklangEngine) {
                window.SkogsklangEngine.setVolume(settings.valsangVol);
                window.SkogsklangEngine.setDepth(settings.valsangDepth);
            }
            if (window.VisualsEngine) {
                window.VisualsEngine.setConfig({ fireflyMode: settings.fireflyMode || 'sentence' });
            }
        }
        
        function toggleDjupvatten() {
            const track = document.getElementById('settDjupvatten');
            track.classList.toggle('active');
            const settings = loadSettings();
            settings.valsangDjupvatten = track.classList.contains('active');
            saveSettings(settings);
            if (window.VisualsEngine) window.VisualsEngine.setConfig({ djupvattenEnabled: settings.valsangDjupvatten });
        }
        
        function toggleSonogram() {
            const track = document.getElementById('settSonogram');
            track.classList.toggle('active');
            const settings = loadSettings();
            settings.valsangSonogram = track.classList.contains('active');
            saveSettings(settings);
            if (window.VisualsEngine) window.VisualsEngine.setConfig({ sonogramEnabled: settings.valsangSonogram });
        }
        
        function toggleMareld() {
            const track = document.getElementById('settMareld');
            track.classList.toggle('active');
            const settings = loadSettings();
            settings.valsangMareld = track.classList.contains('active');
            saveSettings(settings);
            if (window.VisualsEngine) window.VisualsEngine.setConfig({ mareldEnabled: settings.valsangMareld });
        }

        function setHighlightColor(el) {
            document.querySelectorAll('#highlightSwatches .color-swatch').forEach(s => s.classList.remove('active'));
            el.classList.add('active');
            const settings = loadSettings();
            settings.highlightColor = el.dataset.color;
            saveSettings(settings);
        }

        function changeZenBg(val) {
            const settings = loadSettings();
            settings.fsBgType = val;
            saveSettings(settings);

            const overlay = document.getElementById('fullscreenOverlay');
            if (val === 'image') {
                overlay.classList.add('bg-image');
            } else {
                overlay.classList.remove('bg-image');
            }
        }

        function setFsWidth(val) {
            val = parseInt(val);
            const container = document.getElementById('fsEditorContainer');
            const label = document.getElementById('fsWidthValue');
            if (val >= 130) {
                container.style.maxWidth = '100%';
                label.textContent = '100%';
            } else {
                container.style.maxWidth = val + 'ch';
                label.textContent = val + 'ch';
            }
            const settings = loadSettings();
            settings.fsColumnWidth = val;
            saveSettings(settings);
        }

        function setFsFontSize(val, doSave = true) {
            val = parseInt(val);
            const ta = document.getElementById('fsTextarea');
            if (ta) {
                ta.style.fontSize = val + 'px';
                ta.style.lineHeight = Math.round(val * 1.6) + 'px';
                setTimeout(() => updateLineHighlight(false), 50); // uppdatera markören
            }
            if (doSave) {
                const settings = loadSettings();
                settings.fsFontSize = val;
                saveSettings(settings);
            }
        }

        // ── SHORTCUTS OVERLAY ──
        function openShortcuts() {
            document.getElementById('shortcutsOverlay').classList.add('visible');
        }
        function closeShortcuts() {
            document.getElementById('shortcutsOverlay').classList.remove('visible');
        }
        document.getElementById('shortcutsOverlay').addEventListener('mousedown', (e) => {
            if (e.target.id === 'shortcutsOverlay') closeShortcuts();
        });

        // ═══════════════════════════════════════════════
        //  Timer & Writing Goals
        // ═══════════════════════════════════════════════

        const TIMER_KEY = 'skrivbord_timer';
        const GOAL_KEY = 'skrivbord_goal';
        let timerInterval = null;

        function loadTimerState() {
            try { return JSON.parse(localStorage.getItem(TIMER_KEY)) || {}; } catch { return {}; }
        }
        function saveTimerState(s) { localStorage.setItem(TIMER_KEY, JSON.stringify(s)); }
        function loadGoalState() {
            try { return JSON.parse(localStorage.getItem(GOAL_KEY)) || {}; } catch { return {}; }
        }
        function saveGoalState(s) { localStorage.setItem(GOAL_KEY, JSON.stringify(s)); }

        function toggleTimerPopover(e) {
            e.stopPropagation();
            const pop = document.getElementById('timerPopover');
            pop.classList.toggle('open');
        }

        // Close popover on outside click
        document.addEventListener('click', (e) => {
            const pop = document.getElementById('timerPopover');
            if (pop && !pop.contains(e.target) && !e.target.closest('#timerWidget')) {
                pop.classList.remove('open');
            }
        });

        // Stop click inside popover from closing it
        document.getElementById('timerPopover').addEventListener('click', (e) => e.stopPropagation());

        function onTimerTypeChange() {
            const type = document.getElementById('timerType').value;
            const minInput = document.getElementById('timerMinutes');
            if (type === 'pomodoro') {
                minInput.value = 25;
                minInput.disabled = false;
            } else if (type === 'session') {
                minInput.value = '';
                minInput.disabled = true;
            } else {
                minInput.disabled = false;
            }
        }

        function startTimer() {
            // Request Notification permission if possible
            if ('Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
                Notification.requestPermission();
            }

            const type = document.getElementById('timerType').value;
            const minutes = parseInt(document.getElementById('timerMinutes').value) || 25;
            const showDigits = document.getElementById('timerShowDigits').checked;

            const state = {
                type,
                startTime: Date.now(),
                duration: type === 'session' ? null : minutes * 60 * 1000,
                running: true,
                showDigits,
                paused: false,
                elapsed: 0
            };
            saveTimerState(state);
            beginTimerTick();
            document.getElementById('timerPopover').classList.remove('open');
        }

        function pauseTimer() {
            const state = loadTimerState();
            if (!state.running) return;
            state.paused = true;
            state.elapsed = Date.now() - state.startTime;
            state.running = false;
            saveTimerState(state);
            clearInterval(timerInterval);
            renderTimerDisplay(state);
        }

        function stopTimer() {
            clearInterval(timerInterval);
            localStorage.removeItem(TIMER_KEY);
            document.getElementById('timerDisplay').textContent = '⏱ —';
            const fsTd = document.getElementById('fsTimerDisplay');
            if (fsTd) { fsTd.textContent = ''; fsTd.classList.remove('running'); }
            document.title = document.title.replace(/^⏱.*— /, '');
            document.getElementById('timerPopover').classList.remove('open');
        }

        function beginTimerTick() {
            clearInterval(timerInterval);
            timerInterval = setInterval(() => {
                const state = loadTimerState();
                if (!state.running) { clearInterval(timerInterval); return; }
                renderTimerDisplay(state);
            }, 1000);
            renderTimerDisplay(loadTimerState());
        }

        function renderTimerDisplay(state) {
            if (!state || !state.startTime) return;

            const elapsed = state.paused ? state.elapsed : Date.now() - state.startTime;
            let display = '';
            let finished = false;

            if (state.type === 'session') {
                // Count up
                const secs = Math.floor(elapsed / 1000);
                display = formatTime(secs);
            } else {
                // Count down
                const remaining = Math.max(0, state.duration - elapsed);
                const secs = Math.ceil(remaining / 1000);
                display = formatTime(secs);
                if (remaining <= 0) {
                    finished = true;
                    
                    // Respect focus mode & digits visibility for sound
                    const shouldPlaySound = state.showDigits || !isFullscreen;
                    if (shouldPlaySound) playAlarm();

                    // Browser notification
                    if ('Notification' in window && Notification.permission === 'granted') {
                        new Notification('⏱ Tiden ute!', { body: state.type === 'pomodoro' ? 'Dags för en paus!' : 'Din nedräkning är klar.' });
                    }

                    // Toast with optional Pomodoro action
                    let actionLabel = null;
                    let actionCb = null;
                    if (state.type === 'pomodoro') {
                        actionLabel = 'Ny runda?';
                        actionCb = () => {
                            document.getElementById('timerType').value = 'pomodoro';
                            startTimer();
                        };
                    }
                    showToast(`⏱ Tiden ute! ${state.type === 'pomodoro' ? '25 min pomodoro avklarad.' : ''}`, actionLabel, actionCb);

                    stopTimer();
                    document.getElementById('timerDisplay').textContent = '⏱ 0:00 ✓';
                    return;
                }
            }

            const icon = state.paused ? '⏸' : '⏱';
            const label = state.showDigits ? `${icon} ${display}` : `${icon} ●`;
            document.getElementById('timerDisplay').innerHTML =
                `<span class="${state.running ? 'timer-running' : ''}">${label}</span>`;

            // Fullscreen display
            const fsTd = document.getElementById('fsTimerDisplay');
            if (fsTd) {
                fsTd.textContent = state.showDigits ? display : '●';
                fsTd.classList.toggle('running', state.running);
            }

            // Tab title
            const baseTitle = document.title.replace(/^⏱.*— /, '');
            if (state.showDigits && state.running) {
                document.title = `⏱ ${display} — ${baseTitle}`;
            }
        }

        function formatTime(totalSecs) {
            const m = Math.floor(totalSecs / 60);
            const s = totalSecs % 60;
            return `${m}:${s.toString().padStart(2, '0')}`;
        }

        function playAlarm() {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                [0, 0.2, 0.4].forEach(delay => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.frequency.value = 880;
                    osc.type = 'sine';
                    gain.gain.value = 0.15;
                    osc.start(ctx.currentTime + delay);
                    osc.stop(ctx.currentTime + delay + 0.12);
                });
            } catch (e) {}
        }

        // ── Writing Goals ──

        function setWritingGoal() {
            const type = document.getElementById('goalType').value;
            const target = parseInt(document.getElementById('goalTarget').value) || 500;
            const state = { type, target, active: true, reached: false };
            saveGoalState(state);
            document.getElementById('goalWidget').style.display = 'flex';
            updateGoalProgress();
            document.getElementById('timerPopover').classList.remove('open');
        }

        function clearWritingGoal() {
            localStorage.removeItem(GOAL_KEY);
            document.getElementById('goalWidget').style.display = 'none';
            document.getElementById('goalFill').style.width = '0%';
            document.getElementById('goalFill').className = 'goal-fill';
            document.getElementById('goalDisplay').textContent = '—';
            const fsLine = document.getElementById('fsGoalFillLine');
            if (fsLine) { fsLine.style.width = '0%'; fsLine.className = 'fs-goal-fill-line'; }
            document.getElementById('timerPopover').classList.remove('open');
        }

        function updateGoalProgress() {
            const goal = loadGoalState();
            if (!goal || !goal.active) return;

            // Get content from active textarea
            const content = isFullscreen
                ? document.getElementById('fsTextarea').value
                : document.getElementById('editorTextarea').value;

            let current = 0;
            if (goal.type === 'words') {
                current = content.trim() === '' ? 0 : content.trim().split(/\s+/).length;
            } else {
                current = content.length;
            }

            const progressRaw = Math.min(1, Math.max(0, current / goal.target));
            const pct = Math.round(progressRaw * 100);
            const unit = goal.type === 'words' ? 'ord' : 'tecken';
            
            window._currentGoalProgress = progressRaw;
            if (window.VisualsEngine) {
                window.VisualsEngine.setConfig({ goalProgress: progressRaw });
            }

            // Status bar
            const fill = document.getElementById('goalFill');
            fill.style.width = pct + '%';
            fill.className = 'goal-fill' + (pct >= 100 ? ' done' : pct >= 75 ? ' progress-75' : '');
            document.getElementById('goalDisplay').textContent = `${current}/${goal.target} ${unit}`;

            // Fullscreen bar
            const fsLine = document.getElementById('fsGoalFillLine');
            if (fsLine) {
                fsLine.style.width = pct + '%';
                fsLine.className = 'fs-goal-fill-line' + (pct >= 100 ? ' done' : pct >= 75 ? ' progress-75' : '');
            }

            // Check if goal reached for the first time
            if (pct >= 100 && !goal.reached) {
                goal.reached = true;
                saveGoalState(goal);
                
                const shouldPlaySound = true; // Goals are affirmative, always play sound
                if (shouldPlaySound) playAlarm();
                
                showToast(`🎉 Skrivmålet uppnått — ${goal.target} ${unit}!`);
            } else if (pct < 100 && goal.reached) {
                // If they delete text and fall below goal, reset flag
                goal.reached = false;
                saveGoalState(goal);
            }
        }

        // ── Toast Notifications ──

        function showToast(message, actionLabel = null, actionCallback = null) {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = 'toast';
            
            const msgSpan = document.createElement('span');
            msgSpan.textContent = message;
            toast.appendChild(msgSpan);

            if (actionLabel && actionCallback) {
                const btn = document.createElement('button');
                btn.className = 'toast-action';
                btn.textContent = actionLabel;
                btn.onclick = (e) => {
                    e.stopPropagation(); // don't close immediately before action
                    actionCallback();
                    closeToast(toast);
                };
                toast.appendChild(btn);
            }

            // Click anywhere on toast to dismiss
            toast.onclick = () => closeToast(toast);

            container.appendChild(toast);

            // Auto dismiss after 4.5 seconds
            setTimeout(() => {
                if (toast.parentNode) closeToast(toast);
            }, 4500);
        }

        function closeToast(toast) {
            toast.classList.add('hiding');
            toast.addEventListener('animationend', () => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            });
        }

        // Hook goal updates to both textareas
        document.getElementById('editorTextarea').addEventListener('input', updateGoalProgress);
        document.getElementById('fsTextarea').addEventListener('input', updateGoalProgress);

        // ═══════════════════════════════════════════════
        //  Initialize
        // ═══════════════════════════════════════════════

        (function init() {
            loadDocs();
            activeDocId = localStorage.getItem(ACTIVE_KEY) || null;

            // ── URL Import: ?doc=BASE64&title=NAME or #doc=BASE64&title=NAME ──
            const urlParams = new URLSearchParams(window.location.search || window.location.hash.substring(1));
            const docParam = urlParams.get('doc');
            const titleParam = urlParams.get('title');
            if (docParam) {
                try {
                    const content = decodeURIComponent(atob(docParam));
                    const title = titleParam ? decodeURIComponent(titleParam) : 'Importerat dokument';
                    const newId = 'doc-import-' + Date.now();
                    const doc = {
                        id: newId,
                        title: title,
                        content: content,
                        created: new Date().toISOString(),
                        modified: new Date().toISOString()
                    };
                    docs.push(doc);
                    saveDocs();
                    activeDocId = newId;
                    localStorage.setItem(ACTIVE_KEY, newId);
                    // Clean URL to prevent re-import on reload
                    window.history.replaceState({}, '', window.location.pathname);
                    setTimeout(() => showToast(`📄 "${title}" importerat från gAIa`), 300);
                } catch (e) {
                    console.warn('Skrivr: URL import failed', e);
                }
            }

            // Validate active doc exists
            if (activeDocId && !docs.find(d => d.id === activeDocId)) {
                activeDocId = docs.length > 0 ? docs[0].id : null;
            }

            renderTabs();
            renderActiveDoc();
            updateDocCount();
            setViewMode(viewMode);

            // Load typewriter settings into UI
            const settings = loadSettings();
            if (settings.typewriter) {
                document.getElementById('settTypewriter').classList.add('active');
            }
            if (settings.typewriterSound) {
                document.getElementById('settTypewriterSound').classList.add('active');
                document.getElementById('soundProfileRow').style.display = 'flex';
            }
            if (settings.typewriterSoundProfile) {
                document.getElementById('settTypewriterSoundProfile').value = settings.typewriterSoundProfile || 'digital';
                document.getElementById('soundProfileRow').style.display = settings.typewriterSound ? 'flex' : 'none';
            }
            
            const isContinuousProfile = ['valsang', 'skogsklang'].includes(settings.typewriterSoundProfile);
            if (isContinuousProfile) {
                document.getElementById('valsangSettings').style.display = 'flex';
                document.getElementById('valsangWaterSettings').style.display = (settings.typewriterSoundProfile === 'valsang') ? 'block' : 'none';
                document.getElementById('skogsklangSettings').style.display = (settings.typewriterSoundProfile === 'skogsklang') ? 'block' : 'none';
            }
            
            if (settings.fireflyMode) {
                const fireflySelect = document.getElementById('settFireflyMode');
                if (fireflySelect) fireflySelect.value = settings.fireflyMode;
            }

            document.getElementById('settValsangVol').value = settings.valsangVol !== undefined ? settings.valsangVol : 0.6;
            document.getElementById('settValsangDepth').value = settings.valsangDepth !== undefined ? settings.valsangDepth : 1.0;
            if (settings.valsangDjupvatten !== false) document.getElementById('settDjupvatten').classList.add('active');
            if (settings.valsangSonogram !== false) document.getElementById('settSonogram').classList.add('active');
            if (settings.valsangMareld !== false) document.getElementById('settMareld').classList.add('active');
            if (settings.fsBgType) {
                document.getElementById('settZenBg').value = settings.fsBgType;
            }
            // Set active highlight swatch
            const swatches = document.querySelectorAll('#highlightSwatches .color-swatch');
            swatches.forEach(s => {
                if (s.dataset.color === settings.highlightColor) s.classList.add('active');
            });
            if (!document.querySelector('#highlightSwatches .color-swatch.active') && swatches.length) {
                swatches[0].classList.add('active');
            }

            // Attach TextContext for v4
            if (window.TextContext) {
                window.TextContext.attach(document.getElementById('editorTextarea'));
            }

            // Resume timer if running
            const timerState = loadTimerState();
            if (timerState.running) {
                beginTimerTick();
            } else if (timerState.paused) {
                renderTimerDisplay(timerState);
            }

            // Resume goal
            const goalState = loadGoalState();
            if (goalState && goalState.active) {
                document.getElementById('goalWidget').style.display = 'flex';
                document.getElementById('goalType').value = goalState.type || 'words';
                document.getElementById('goalTarget').value = goalState.target || 500;
                updateGoalProgress();
            }
        })();
    