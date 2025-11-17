const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const cron = require('node-cron');

class PythonRunner {
    constructor() {
        this.scriptPath = path.join(__dirname, 'temp_script.py');
        this.m3uOutputPath = path.join(__dirname, 'generated_playlist.m3u'); // Percorso standardizzato
        this.lastExecution = null;
        this.lastError = null;
        this.isRunning = false;
        this.scriptUrl = null;
        this.cronJob = null;
        this.updateInterval = null;
        this.pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        
        if (!fs.existsSync(path.join(__dirname, 'temp'))) {
            fs.mkdirSync(path.join(__dirname, 'temp'));
        }
    }

    /**
     * Scarica lo script Python e installa le sue dipendenze
     * @param {string} url - L'URL dello script Python
     * @returns {Promise<boolean>} - true se successo
     */
    async downloadScript(url) {
        try {
            console.log(`\n=== Download script Python Generatore da ${url} ===`);
            this.scriptUrl = url;
            
            const response = await axios.get(url, { responseType: 'text' });
            const scriptContent = response.data;
            fs.writeFileSync(this.scriptPath, scriptContent);
            
            // --- NUOVA BOMBA #1: Auto-Installazione Dipendenze ---
            console.log('Verifica dipendenze Python richieste dallo script...');
            const reqMatch = scriptContent.match(/#\s*REQUIREMENTS:\s*(.+)/i);
            if (reqMatch && reqMatch[1]) {
                const dependencies = reqMatch[1].split(',').map(d => d.trim()).filter(Boolean);
                if (dependencies.length > 0) {
                    console.log(`Trovate dipendenze: ${dependencies.join(', ')}. Installazione in corso...`);
                    const installCmd = `${this.pythonCmd} -m pip install -q ${dependencies.join(' ')} --break-system-packages`;
                    
                    try {
                        await execAsync(installCmd);
                        console.log('✓ Dipendenze Python installate con successo.');
                    } catch (pipError) {
                        console.error(`❌ Errore installazione dipendenze Python: ${pipError.message}`);
                        this.lastError = `Errore pip: ${pipError.message}`;
                        return false;
                    }
                }
            } else {
                console.log('Nessuna dipendenza extra richiesta dallo script.');
            }
            // --- FINE BOMBA #1 ---
            
            console.log('✓ Script Python Generatore scaricato con successo');
            return true;
        } catch (error) {
            console.error('❌ Errore durante il download dello script Python Generatore:', error.message);
            this.lastError = `Errore download: ${error.message}`;
            return false;
        }
    }

    /**
     * Esegue lo script Python scaricato usando I/O standardizzato
     * @returns {Promise<boolean>} - true se successo
     */
    async executeScript() {
        if (this.isRunning) {
            console.log('⚠️ Esecuzione Generatore già in corso, attendere...');
            return false;
        }

        if (!fs.existsSync(this.scriptPath)) {
            console.error('❌ Script Python Generatore non trovato. Eseguire prima downloadScript()');
            this.lastError = 'Script Python Generatore non trovato';
            return false;
        }

        try {
            this.isRunning = true;
            this.lastError = null; // Resetta l'errore precedente
            console.log('\n=== Esecuzione script Python Generatore ===');
            
            // Elimina il vecchio file di output prima di crearne uno nuovo
            if (fs.existsSync(this.m3uOutputPath)) {
                fs.unlinkSync(this.m3uOutputPath);
            }
            
            // Controlla se Python è installato
            await execAsync(`${this.pythonCmd} --version`);
            
            // --- NUOVA BOMBA #2: Standardizzazione I/O ---
            // Definisci l'entry del canale speciale
            const specialChannel = `
#EXTINF:-1 tvg-id="rigeneraplaylistpython" tvg-name="Rigenera Playlist Python" tvg-logo="https://raw.githubusercontent.com/mccoy88f/OMG-TV-Stremio-Addon/refs/heads/main/tv.png" group-title="~SETTINGS~",Rigenera Playlist Python
http://127.0.0.1/regenerate`;

            // Prepara il payload di configurazione per lo script Python
            const configPayload = {
                output_path: this.m3uOutputPath,
                regenerate_channel_m3u: specialChannel
            };
            
            // Codifica il payload in Base64 per passarlo come argomento
            const configB64 = Buffer.from(JSON.stringify(configPayload)).toString('base64');
            const cmd = `${this.pythonCmd} ${this.scriptPath} --config "${configB64}"`;

            console.log('Avvio script con I/O standardizzato...');
            const { stdout, stderr } = await execAsync(cmd);
            
            if (stderr) {
                console.warn('⚠️ Warning (stderr) durante l\'esecuzione:', stderr);
            }
            
            console.log('Output script (stdout):', stdout);
            
            // --- FINE BOMBA #2 ---

            // Verifica se lo script ha creato il file come richiesto
            if (fs.existsSync(this.m3uOutputPath)) {
                console.log(`✓ File M3U generato con successo in "${this.m3uOutputPath}"`);
                this.lastExecution = new Date();
                this.lastError = null;
                return true;
            } else {
                console.error('❌ Script eseguito, ma il file M3U di output non è stato creato.');
                // L'errore potrebbe essere in stdout/stderr
                this.lastError = stderr || stdout || 'File M3U non generato dallo script.';
                return false;
            }
            
        } catch (error) {
            // --- NUOVA BOMBA #3: Errori Chiari ---
            // Cattura il traceback completo di Python da stderr
            console.error('❌ ERRORE CRITICO durante l\'esecuzione dello script Python:');
            console.error(error.stderr || error.message);
            this.lastError = error.stderr || error.message; // Salva l'errore Python!
            return false;
            // --- FINE BOMBA #3 ---
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Imposta un aggiornamento automatico
     */
    scheduleUpdate(timeFormat) {
        this.stopScheduledUpdates();
        
        if (!timeFormat || !/^\d{1,2}:\d{2}$/.test(timeFormat)) {
            console.error('❌ [GENERATORE] Formato orario non valido. Usa HH:MM o H:MM');
            this.lastError = 'Formato orario non valido. Usa HH:MM o H:MM';
            return false;
        }
        
        try {
            const [hours, minutes] = timeFormat.split(':').map(Number);
            
            if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
                console.error('❌ [GENERATORE] Orario non valido. Ore: 0-23, Minuti: 0-59');
                this.lastError = 'Orario non valido. Ore: 0-23, Minuti: 0-59';
                return false;
            }
            
            let cronExpression;
            if (hours === 0) {
                cronExpression = `*/${minutes} * * * *`;
                console.log(`✓ [GENERATORE] Pianificazione impostata: ogni ${minutes} minuti`);
            } else {
                cronExpression = `${minutes} */${hours} * * *`;
                console.log(`✓ [GENERATORE] Pianificazione impostata: ogni ${hours} ore e ${minutes} minuti`);
            }
            
            this.cronJob = cron.schedule(cronExpression, async () => {
                console.log(`\n=== [GENERATORE] Esecuzione automatica script Python (${new Date().toLocaleString()}) ===`);
                const success = await this.executeScript();
                
                // (Logica complessa, ma necessaria, per ricaricare la cache)
                if (success) {
                    try {
                        const config = require('./config');
                        const CacheManager = require('./cache-manager')(config);
                        
                        const currentM3uUrl = CacheManager.cache.m3uUrl;
                        
                        if (currentM3uUrl) {
                            console.log(`\n=== [GENERATORE] Ricostruzione cache dopo esecuzione automatica ===`);
                            await CacheManager.rebuildCache(currentM3uUrl);
                            console.log(`✓ [GENERATORE] Cache ricostruita con successo`);
                        } else {
                            console.log(`❌ [GENERATORE] Nessun URL M3U configurato, impossibile ricostruire la cache.`);
                        }
                    } catch (cacheError) {
                        console.error(`❌ [GENERATORE] Errore ricostruzione cache:`, cacheError);
                    }
                }
            });
            
            this.updateInterval = timeFormat;
            return true;
        } catch (error) {
            console.error('❌ [GENERATORE] Errore nella pianificazione:', error.message);
            this.lastError = `Errore nella pianificazione: ${error.message}`;
            return false;
        }
    }
    
    stopScheduledUpdates() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
            this.updateInterval = null;
            console.log('✓ [GENERATORE] Aggiornamento automatico fermato');
            return true;
        }
        return false;
    }

    // --- FUNZIONI OBSOLETE (RIMOSSE) ---
    // cleanupM3UFiles() 
    // findAllM3UFiles()
    // findM3UPathFromOutput()
    // addRegenerateChannel()
    // --- (La loro logica è ora gestita da executeScript e dallo script Python) ---

    /**
     * Legge il contenuto del file M3U generato
     * @returns {string|null} - Il contenuto del file M3U o null se non esiste
     */
    getM3UContent() {
        try {
            if (fs.existsSync(this.m3uOutputPath)) {
                return fs.readFileSync(this.m3uOutputPath, 'utf8');
            }
            // Non cerca più altri file, sa dove deve essere
            return null;
        } catch (error) {
            console.error('❌ Errore nella lettura del file M3U generato:', error.message);
            return null;
        }
    }

    getM3UPath() {
        return this.m3uOutputPath;
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            lastExecution: this.lastExecution ? this.formatDate(this.lastExecution) : 'Mai',
            lastError: this.lastError,
            m3uExists: fs.existsSync(this.m3uOutputPath),
            m3uFiles: fs.existsSync(this.m3uOutputPath) ? 1 : 0, // Semplificato
            scriptExists: fs.existsSync(this.scriptPath),
            scriptUrl: this.scriptUrl,
            updateInterval: this.updateInterval,
            scheduledUpdates: this.cronJob !== null
        };
    }

    formatDate(date) {
        return date.toLocaleString('it-IT', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }
}

module.exports = new PythonRunner();
