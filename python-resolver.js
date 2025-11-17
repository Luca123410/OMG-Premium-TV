const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const cron = require('node-cron');

class PythonResolver {
    constructor() {
        this.scriptPath = path.join(__dirname, 'resolver_script.py');
        this.resolvedLinksCache = new Map();
        // --- NUOVA BOMBA #2: Prevenzione "Dog-Piling" ---
        this.pendingRequests = new Map(); // Mappa per le richieste in attesa
        // --- FINE BOMBA #2 ---
        this.cacheExpiryTime = 20 * 60 * 1000; // 20 minuti
        this.lastExecution = null;
        this.lastError = null;
        this.isRunning = false; // Mantenuto per logica di fallback
        this.scriptUrl = null;
        this.cronJob = null;
        this.updateInterval = null;
        this.pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        
        // La cartella temp non serve più per l'IPC, ma la lasciamo
        // nel caso l'utente carichi altri script che ne hanno bisogno.
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
            console.log(`\n=== Download script Python resolver da ${url} ===`);
            this.scriptUrl = url;
            
            const response = await axios.get(url, { responseType: 'text' });
            const scriptContent = response.data;
            fs.writeFileSync(this.scriptPath, scriptContent);
            
            if (!scriptContent.includes('def resolve_link') && !scriptContent.includes('def resolve_stream')) {
                this.lastError = 'Lo script deve contenere una funzione resolve_link o resolve_stream';
                console.error(`❌ ${this.lastError}`);
                return false;
            }

            // --- NUOVA BOMBA #3: Auto-Installazione Dipendenze ---
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
                        return false; // Fallisce se le dipendenze non possono essere installate
                    }
                }
            } else {
                console.log('Nessuna dipendenza extra richiesta dallo script.');
            }
            // --- FINE BOMBA #3 ---
            
            return true;
        } catch (error) {
            console.error('❌ Errore durante il download dello script Python resolver:', error.message);
            this.lastError = `Errore download: ${error.message}`;
            return false;
        }
    }

    async checkScriptHealth() {
        // (Invariato, è già ottimo)
        if (!fs.existsSync(this.scriptPath)) {
            console.error('❌ Script Python resolver non trovato');
            this.lastError = 'Script Python resolver non trovato';
            return false;
        }
        try {
            await execAsync(`${this.pythonCmd} --version`);
            const { stdout, stderr } = await execAsync(`${this.pythonCmd} ${this.scriptPath} --check`);
            if (stderr && !stderr.includes('resolver_ready')) {
                console.warn('⚠️ Warning durante la verifica dello script:', stderr);
            }
            return stdout.includes('resolver_ready') || stderr.includes('resolver_ready');
        } catch (error) {
            console.error('❌ Errore durante la verifica dello script resolver:', error.message);
            this.lastError = `Errore verifica: ${error.message}`;
            return false;
        }
    }

    /**
     * Risolve un URL tramite lo script Python usando IPC (stdin/stdout)
     * @param {string} url - L'URL da risolvere
     * @param {object} headers - Gli header da passare allo script
     * @param {string} channelName - Nome del canale (per logging)
     * @param {object} proxyConfig - Configurazione del proxy (opzionale)
     * @returns {Promise<object>} - Oggetto con l'URL risolto e gli header
     */
    async resolveLink(url, headers = {}, channelName = 'unknown', proxyConfig = null) {
        // 1. Controllo Cache Veloce
        const cacheKey = `${url}:${JSON.stringify(headers)}`;
        const cachedResult = this.resolvedLinksCache.get(cacheKey);
        if (cachedResult && (Date.now() - cachedResult.timestamp) < this.cacheExpiryTime) {
            console.log(`✓ Usando URL in cache per: ${channelName}`);
            return cachedResult.data;
        }
    
        // --- MODIFICA BOMBA #2: "Request Coalescing" ---
        // 2. Controllo Richieste in Attesa
        // Se un'altra richiesta identica è già in corso, ci accodiamo
        const pending = this.pendingRequests.get(cacheKey);
        if (pending) {
            console.log(`[Coalescing] Richiesta accodata per ${channelName}, in attesa...`);
            return pending; // Ritorna la promise in attesa
        }
        // --- FINE BOMBA #2 ---

        if (!fs.existsSync(this.scriptPath)) {
            console.error('❌ Script Python resolver non trovato');
            this.lastError = 'Script Python resolver non trovato';
            return null;
        }

        // 3. Crea la Promise di Esecuzione
        const workPromise = (async () => {
            try {
                this.isRunning = true;
                console.log(`\n=== [IPC] Risoluzione URL per: ${channelName} ===`);
        
                // --- MODIFICA BOMBA #1: RIMOZIONE FILE I/O ---
                // Non scriviamo più file, passiamo i dati via stdin
                const inputParams = {
                    url: url,
                    headers: headers,
                    channel_name: channelName,
                    proxy_config: proxyConfig
                };
                const inputString = JSON.stringify(inputParams);
        
                // Esegui lo script Python e passa i dati via stdin
                const cmd = `${this.pythonCmd} ${this.scriptPath} --resolve-ipc`;
                
                // Passiamo 'inputString' come 'input' a execAsync
                const { stdout, stderr } = await execAsync(cmd, { input: inputString });
                
                if (stderr) {
                    console.warn(`⚠️ Warning durante la risoluzione (IPC): ${stderr}`);
                }
        
                // Leggi il risultato direttamente da stdout
                try {
                    const result = JSON.parse(stdout);
                    
                    // Salva in cache
                    this.resolvedLinksCache.set(cacheKey, {
                        timestamp: Date.now(),
                        data: result
                    });
                    
                    this.lastExecution = new Date();
                    this.lastError = null;
                    console.log(`✓ [IPC] URL risolto per ${channelName}`);
                    return result;
                    
                } catch (parseError) {
                    console.error('❌ Errore nel parsing del risultato (IPC):', parseError.message);
                    console.error('Contenuto stdout:', stdout);
                    this.lastError = `Errore parsing: ${parseError.message}`;
                    return null;
                }
                // --- FINE BOMBA #1 ---
        
            } catch (error) {
                console.error('❌ Errore durante la risoluzione URL (IPC):', error.message);
                if (error.stderr) console.error('Stderr:', error.stderr);
                this.lastError = `Errore esecuzione: ${error.message}`;
                return null;
            } finally {
                this.isRunning = false;
                // --- MODIFICA BOMBA #2: Rimuovi la promise in attesa ---
                this.pendingRequests.delete(cacheKey);
                // --- FINE BOMBA #2 ---
            }
        })();

        // --- MODIFICA BOMBA #2: Salva la promise in attesa ---
        this.pendingRequests.set(cacheKey, workPromise);
        // --- FINE BOMBA #2 ---
        
        return workPromise;
    }

    /**
     * Imposta un aggiornamento automatico
     * (Invariato, ma con log migliorati)
     */
    scheduleUpdate(timeFormat) {
        this.stopScheduledUpdates();
        
        if (!timeFormat || !/^\d{1,2}:\d{2}$/.test(timeFormat)) {
            console.error('❌ [RESOLVER] Formato orario non valido. Usa HH:MM o H:MM');
            this.lastError = 'Formato orario non valido. Usa HH:MM o H:MM';
            return false;
        }
        
        try {
            const [hours, minutes] = timeFormat.split(':').map(Number);
            
            if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
                console.error('❌ [RESOLVER] Orario non valido. Ore: 0-23, Minuti: 0-59');
                this.lastError = 'Orario non valido. Ore: 0-23, Minuti: 0-59';
                return false;
            }
            
            let cronExpression;
            if (hours === 0) {
                cronExpression = `*/${minutes} * * * *`;
                console.log(`✓ [RESOLVER] Pianificazione impostata: ogni ${minutes} minuti`);
            } else {
                cronExpression = `${minutes} */${hours} * * *`;
                console.log(`✓ [RESOLVER] Pianificazione impostata: ogni ${hours} ore e ${minutes} minuti`);
            }
            
            this.cronJob = cron.schedule(cronExpression, async () => {
                console.log(`\n=== [RESOLVER] Aggiornamento automatico script resolver (${new Date().toLocaleString()}) ===`);
                if (this.scriptUrl) {
                    await this.downloadScript(this.scriptUrl);
                }
                this.resolvedLinksCache.clear();
            });
            
            this.updateInterval = timeFormat;
            return true;
        } catch (error) {
            console.error('❌ [RESOLVER] Errore nella pianificazione:', error.message);
            this.lastError = `Errore nella pianificazione: ${error.message}`;
            return false;
        }
    }
    
    stopScheduledUpdates() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
            this.updateInterval = null;
            console.log('✓ [RESOLVER] Aggiornamento automatico fermato');
            return true;
        }
        return false;
    }

    clearCache() {
        this.resolvedLinksCache.clear();
        console.log('✓ [RESOLVER] Cache dei link risolti svuotata');
        return true;
    }

    /**
     * Crea un esempio di script resolver (MODIFICATO PER BOMBA #1 e #3)
     * @returns {Promise<boolean>} - true se il template è stato creato
     */
    async createScriptTemplate() {
        try {
            // --- MODIFICATO: Aggiunta BOMBA #3 ---
            const templateContent = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# Python Resolver per OMG TV (Versione IPC - stdin/stdout)
# REQUIREMENTS: requests
#
# Questo script riceve i dati da STDIN e restituisce il JSON a STDOUT

import sys
import json
import os
import requests
import time
from urllib.parse import urlparse, parse_qs

# Configurazione globale
API_KEY = "la_tua_api_key"
API_SECRET = "il_tuo_secret"
RESOLVER_VERSION = "2.0-IPC" # Versione aggiornata

def get_token():
    """
    Esempio di funzione per ottenere un token di autenticazione
    """
    token = f"token_{int(time.time())}"
    return token

def resolve_link(url, headers=None, channel_name=None, proxy_config=None):
    """
    Funzione principale che risolve un link
    
    Parametri:
    - url: URL da risolvere
    - headers: dizionario con gli header HTTP da utilizzare 
    - channel_name: nome del canale per il logging
    - proxy_config: dizionario con info proxy (opzionale)
    
    Restituisce:
    - Un dizionario con l'URL risolto e gli header da utilizzare
    """
    # Usiamo sys.stderr per i log, così non "sporchiamo" stdout
    print(f"Risoluzione URL: {url}", file=sys.stderr)
    print(f"Canale: {channel_name}", file=sys.stderr)
    
    if proxy_config:
        print(f"Uso proxy: {proxy_config.get('url')}", file=sys.stderr)

    parsed_url = urlparse(url)
    params = parse_qs(parsed_url.query)
    token = get_token()
    
    # ESEMPIO 1: Aggiungi token a URL esistente
    if parsed_url.netloc == "example.com":
        resolved_url = f"{url}&token={token}"
    
    # ESEMPIO 2: Chiama API e ottieni URL reale
    elif "api" in parsed_url.netloc:
        try:
            api_response = requests.get(
                f"https://api.example.com/resolve",
                params={"url": url, "key": API_KEY},
                headers=headers
            )
            if api_response.status_code == 200:
                data = api_response.json()
                resolved_url = data.get("stream_url", url)
            else:
                print(f"Errore API: {api_response.status_code}", file=sys.stderr)
                resolved_url = url
        except Exception as e:
            print(f"Errore chiamata API: {str(e)}", file=sys.stderr)
            resolved_url = url
    
    # Caso predefinito: restituisci l'URL originale
    else:
        resolved_url = url
    
    # Aggiungi o modifica gli header
    final_headers = headers.copy() if headers else {}
    final_headers["User-Agent"] = final_headers.get("User-Agent", "Mozilla/5.0")
    final_headers["Authorization"] = f"Bearer {token}"
    
    # Restituisci il risultato
    return {
        "resolved_url": resolved_url,
        "headers": final_headers
    }

def main():
    """
    Funzione principale che gestisce i parametri di input
    """
    # Comando check: verifica che lo script sia valido
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        print("resolver_ready: True") # Scrive a stdout
        sys.exit(0)
    
    # --- MODIFICATO: Logica IPC (BOMBA #1) ---
    # Comando resolve-ipc: risolvi un URL da stdin
    if len(sys.argv) > 1 and sys.argv[1] == "--resolve-ipc":
        try:
            # Leggi i parametri di input da stdin
            input_data = json.load(sys.stdin)
            
            url = input_data.get('url', '')
            headers = input_data.get('headers', {})
            channel_name = input_data.get('channel_name', 'unknown')
            proxy_config = input_data.get('proxy_config', None)
            
            # Risolvi l'URL
            result = resolve_link(url, headers, channel_name, proxy_config)
            
            # Scrivi il risultato JSON su stdout
            json.dump(result, sys.stdout, indent=2)
            sys.exit(0)
            
        except Exception as e:
            # Scrivi l'errore su stderr
            print(f"Errore: {str(e)}", file=sys.stderr)
            sys.exit(1)
    
    print("Comando non valido. Usa --check o --resolve-ipc", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
    main()
`;
            
            fs.writeFileSync(this.scriptPath, templateContent);
            console.log('✓ Template dello script resolver (IPC) creato con successo');
            return true;
        } catch (error) {
            console.error('❌ Errore nella creazione del template:', error.message);
            this.lastError = `Errore creazione template: ${error.message}`;
            return false;
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            lastExecution: this.lastExecution ? this.formatDate(this.lastExecution) : 'Mai',
            lastError: this.lastError,
            scriptExists: fs.existsSync(this.scriptPath),
            scriptUrl: this.scriptUrl,
            updateInterval: this.updateInterval,
            scheduledUpdates: this.cronJob !== null,
            cacheItems: this.resolvedLinksCache.size,
            pendingRequests: this.pendingRequests.size, // Aggiunto per debug
            resolverVersion: this.getResolverVersion()
        };
    }

    getResolverVersion() {
        try {
            if (fs.existsSync(this.scriptPath)) {
                const content = fs.readFileSync(this.scriptPath, 'utf8');
                const versionMatch = content.match(/RESOLVER_VERSION\s*=\s*["']([^"']+)["']/);
                if (versionMatch && versionMatch[1]) {
                    return versionMatch[1];
                }
            }
            return 'N/A';
        } catch (error) {
            console.error('Errore nella lettura della versione:', error.message);
            return 'Errore';
        }
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

module.exports = new PythonResolver();
