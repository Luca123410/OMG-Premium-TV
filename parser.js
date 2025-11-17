const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config'); // Carica la configurazione base per i fallback

class PlaylistTransformer {
    constructor() {
        this.remappingRules = new Map();
        this.channelsMap = new Map(); // <-- BOMBA #1: Mappa per aggregare i canali
        this.channelsWithoutStreams = [];
    }

    /**
     * BOMBA #4: Normalizzazione "Fuzzy"
     * Rimuove TUTTI i caratteri non alfanumerici (inclusi . e _)
     * Ora 'sky.sport.1' e 'SkySport1' diventeranno entrambi 'skysport1'
     */
    normalizeId(id) {
        return id?.toLowerCase().replace(/[^\w]/g, '').trim() || '';
    }

    cleanChannelName(name) {
        // Rimuove tag (..), [..] e pulisce il nome
        return name
            .replace(/[\(\[].*?[\)\]]/g, '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '');
    }

    /**
     * Carica le regole di remapping per forzare la corrispondenza M3U -> EPG
     */
    async loadRemappingRules(config) {
        const defaultPath = path.join(__dirname, 'link.epg.remapping');
        const remappingPath = config?.remapper_path || defaultPath;
        
        try {
            let content;
            if (remappingPath.startsWith('http')) {
                try {
                    const response = await axios.get(remappingPath);
                    content = response.data;
                    console.log('✓ Download remapping remoto completato');
                } catch (downloadError) {
                    console.error('❌ Download remoto remapping fallito:', downloadError.message);
                    console.log('Uso fallback locale:', defaultPath);
                    content = await fs.promises.readFile(defaultPath, 'utf8');
                }
            } else {
                content = await fs.promises.readFile(remappingPath, 'utf8');
            }

            let ruleCount = 0;
            content.split('\n').forEach(line => {
                line = line.trim();
                if (!line || line.startsWith('#')) return;
                const [m3uId, epgId] = line.split('=').map(s => s.trim());
                if (m3uId && epgId) {
                    // Normalizza entrambe le parti della regola
                    this.remappingRules.set(this.normalizeId(m3uId), this.normalizeId(epgId));
                    ruleCount++;
                }
            });
            console.log(`✓ Caricate ${ruleCount} regole di remapping da ${remappingPath}`);
        } catch (error) {
             console.error('❌ Errore caricamento remapping (file non trovato?):', error.message);
        }
    }

    /**
     * BOMBA #3: Parsing Header Avanzato
     * Estrae header da #EXTINF, #EXTVLCOPT, e #EXTHTTP
     */
    parseVLCOpts(lines, currentIndex, extinf) {
        let i = currentIndex;
        const extinfHeaders = {};
        const vlcHeaders = {};
        const httpHeaders = {};

        // 1. Estrai header da #EXTINF (es. http-user-agent="...")
        const extinfopts = extinf.match(/http-[^=]+=["']([^"']+)/g);
        if (extinfopts) {
            extinfopts.forEach(opt => {
                const [key, value] = opt.split('=');
                extinfHeaders[key.replace('http-', '')] = value.replace(/["']/g, '');
            });
        }

        // 2. Estrai header da #EXTVLCOPT
        while (i < lines.length && lines[i].startsWith('#EXTVLCOPT:')) {
            const opt = lines[i].substring('#EXTVLCOPT:'.length).trim();
            const [key, ...value] = opt.split('=');
            vlcHeaders[key.replace('http-', '')] = value.join('=');
            i++;
        }

        // 3. Estrai header da #EXTHTTP
        if (i < lines.length && lines[i].startsWith('#EXTHTTP:')) {
            try {
                const parsed = JSON.parse(lines[i].substring('#EXTHTTP:'.length));
                Object.assign(httpHeaders, parsed);
                i++;
            } catch (e) {
                console.error('Errore parsing EXTHTTP:', e);
            }
        }

        const finalHeaders = { ...extinfHeaders, ...vlcHeaders, ...httpHeaders };

        // 4. Unifica gli header (con priorità e fallback)
        finalHeaders['User-Agent'] = httpHeaders['User-Agent'] || httpHeaders['user-agent'] ||
                                     vlcHeaders['user-agent'] || extinfHeaders['user-agent'] ||
                                     config.defaultUserAgent; // Fallback dalla config

        finalHeaders['referrer'] = httpHeaders['referrer'] || httpHeaders['referer'] ||
                                   vlcHeaders['referrer'] || vlcHeaders['referer'] ||
                                   extinfHeaders['referrer'] || extinfHeaders['referer'];
        
        if (finalHeaders['referrer']) delete finalHeaders['referer'];

        return { headers: finalHeaders, nextIndex: i };
    }
    
    /**
     * Estrae i dati del canale dalla riga #EXTINF
     */
    parseChannelFromLine(line, headers, config) {
        const metadata = line.substring(8).trim();
        const tvgData = {};
    
        const tvgMatches = metadata.match(/([a-zA-Z-]+)="([^"]+)"/g) || [];
        tvgMatches.forEach(match => {
            const [key, value] = match.split('=');
            const cleanKey = key.replace('tvg-', '');
            tvgData[cleanKey] = value.replace(/"/g, '');
        });

        const groupMatch = metadata.match(/group-title="([^"]+)"/);
        let genres = [];
        if (groupMatch) {
            genres = groupMatch[1].split(';')
                .map(g => g.trim())
                .filter(g => g && g.toLowerCase() !== 'undefined');
        }
        
        if (genres.length === 0) {
            genres = ['Altri Canali'];
        }

        const nameParts = metadata.split(',');
        const name = nameParts[nameParts.length - 1].trim();

        // Se tvg-id non esiste, creane uno dal nome (normalizzato)
        if (!tvgData.id) {
            tvgData.id = this.normalizeId(name);
        }

        return { name, group: genres, tvg: tvgData, headers };
    }

    /**
     * Trova l'ID corretto, applicando le regole di remapping
     */
    getRemappedId(channel) {
        const originalId = channel.tvg.id;
        const normalizedId = this.normalizeId(originalId);
        
        // Controlla le regole di remapping sull'ID normalizzato
        const remappedId = this.remappingRules.get(normalizedId);
        
        // Ritorna l'ID rimappato O quello normalizzato
        return remappedId || normalizedId;
    }

    /**
     * Crea l'oggetto Stremio base per un nuovo canale
     */
    createChannelObject(channel, remappedId, config) {
        const name = channel.tvg?.name || channel.name;
        const cleanName = name.replace(/\s*\(.*?\)\s*/g, '').trim();
        
        // Applica il suffisso (se esiste) all'ID finale UNA SOLA VOLTA
        const suffix = config?.id_suffix || '';
        const finalChannelId = remappedId + (suffix ? `.${suffix}` : '');

        return {
            id: `tv|${finalChannelId}`,
            type: 'tv',
            name: cleanName,
            genre: channel.group,
            posterShape: 'square',
            poster: channel.tvg?.logo,
            background: channel.tvg?.logo,
            logo: channel.tvg?.logo,
            description: `Canale: ${cleanName} - ID: ${finalChannelId}`,
            runtime: 'LIVE',
            behaviorHints: {
                defaultVideoId: `tv|${finalChannelId}`,
                isLive: true
            },
            streamInfo: {
                urls: [], // BOMBA #1: Sarà riempito da addStreamToChannel
                tvg: {
                    ...channel.tvg,
                    id: finalChannelId, // Usa l'ID finale e suffissato
                    name: cleanName
                }
            }
        };
    }

    /**
     * Aggiunge un nuovo stream (URL) a un canale *già esistente* nella Mappa
     */
    addStreamToChannel(channel, url, name, genres, headers) {
        if (genres) {
            genres.forEach(newGenre => {
                if (!channel.genre.includes(newGenre)) {
                    channel.genre.push(newGenre);
                }
            });
        }

        const streamName = name || channel.name; // Usa il nome della riga #EXTINF se disponibile

        if (url === null || url.toLowerCase() === 'null') {
            // Non aggiungiamo flussi 'null' se altri flussi esistono
            if (channel.streamInfo.urls.length === 0) {
                channel.streamInfo.urls.push({
                    url: 'https://static.vecteezy.com/system/resources/previews/001/803/236/mp4/no-signal-bad-tv-free-video.mp4',
                    name: 'Nessuno flusso presente',
                    headers
                });
            }
        } else {
            channel.streamInfo.urls.push({
                url,
                name: streamName, // Salva il nome dello stream
                headers
            });
        }
    }
    
    /**
     * Esegue il parsing del contenuto di UN file M3U
     */
    async parseM3UContent(content, config) {
        const lines = content.split('\n');
        let currentChannel = null;
        const genres = new Set();
    
        let epgUrl = null;
        if (lines[0].includes('url-tvg=')) {
            const match = lines[0].match(/url-tvg="([^"]+)"/);
            if (match) {
                epgUrl = match[1].split(',').map(url => url.trim());
            }
        }
    
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
        
            if (line.startsWith('#EXTINF:')) {
                const { headers, nextIndex } = this.parseVLCOpts(lines, i + 1, line);
                i = nextIndex - 1;
                currentChannel = this.parseChannelFromLine(line, headers, config);

            } else if ((line.startsWith('http') || line.toLowerCase() === 'null') && currentChannel) {
                
                // --- LOGICA BOMBA #1 (Aggregation) ---
                const remappedId = this.getRemappedId(currentChannel);
                
                if (!this.channelsMap.has(remappedId)) {
                    // 1. Se il canale non esiste nella mappa, lo creo
                    const channelObj = this.createChannelObject(currentChannel, remappedId, config); 
                    this.channelsMap.set(remappedId, channelObj);
                    currentChannel.group.forEach(genre => genres.add(genre));
                }

                // 2. Aggiungo lo stream (URL) al canale esistente
                const channelObj = this.channelsMap.get(remappedId);
                this.addStreamToChannel(channelObj, line, currentChannel.name, currentChannel.group, currentChannel.headers);
                // --- FINE LOGICA BOMBA ---
    
                currentChannel = null;
            }
        }
        
        return { genres: Array.from(genres), epgUrl };
    }

    /**
     * Funzione helper per scaricare e parsare UN M3U (per il download parallelo)
     */
    async downloadAndParseOneM3U(playlistUrl, config) {
        console.log(`Processo playlist: ${playlistUrl}`);
        const playlistResponse = await axios.get(playlistUrl, { timeout: 15000 });
        return await this.parseM3UContent(playlistResponse.data, config);
    }

    /**
     * Entry point: carica e trasforma TUTTI gli URL M3U
     */
    async loadAndTransform(url, config = {}) {
        try {
            this.channelsMap.clear(); // Resetta la mappa per ogni run
            this.channelsWithoutStreams = [];
            
            await this.loadRemappingRules(config);
            
            // 1. Espande l'URL di input (che può essere una lista di liste)
            const urlList = url.split(',').map(u => u.trim()).filter(u => u);
            console.log('\n=== Inizio Processamento Playlist ===');
            
            let playlistUrls = [];
            for (const singleUrl of urlList) {
                try {
                    const response = await axios.get(singleUrl, { timeout: 10000 });
                    const content = response.data;
                    
                    if (content.startsWith('#EXTM3U')) {
                        playlistUrls.push(singleUrl);
                    } else {
                        const urls = content.split('\n').filter(line => line.trim() && line.startsWith('http'));
                        playlistUrls.push(...urls);
                    }
                } catch (error) {
                    console.error(`❌ Fallito caricamento lista URL: ${singleUrl}`, error.message);
                }
            }

            console.log(`Trovate ${playlistUrls.length} playlist totali. Avvio download parallelo...`);
            const allGenres = new Set();
            const allEpgUrls = new Set();

            // --- BOMBA #2: Parsing Parallelo ---
            // Scarica e processa TUTTE le playlist contemporaneamente
            const allResults = await Promise.allSettled(
                playlistUrls.map(pUrl => this.downloadAndParseOneM3U(pUrl, config))
            );
            // --- FINE BOMBA #2 ---

            // 3. Unisci i risultati
            allResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    const { genres, epgUrl } = result.value;
                    genres.forEach(genre => allGenres.add(genre));
                    if (epgUrl) {
                        epgUrl.forEach(url => allEpgUrls.add(url));
                    }
                } else {
                    console.error(`❌ Fallito parsing di: ${playlistUrls[index]} (Motivo: ${result.reason.message})`);
                }
            });

            const finalChannels = Array.from(this.channelsMap.values());

            // 4. Pulizia finale e log
            finalChannels.forEach(channel => {
                // Rimuovi lo stream 'null' se ora ci sono stream validi
                if (channel.streamInfo.urls.length > 1) {
                    channel.streamInfo.urls = channel.streamInfo.urls.filter(
                        stream => stream.name !== 'Nessuno flusso presente'
                    );
                }
                if (channel.streamInfo.urls.length === 0) {
                     this.channelsWithoutStreams.push(channel.name);
                }
            });

            console.log('\nRiepilogo Processamento:');
            console.log(`✓ Totale canali unici aggregati: ${finalChannels.length}`);
            console.log(`✓ Totale generi unici: ${allGenres.size}`);
            if (this.channelsWithoutStreams.length > 0) {
                console.warn(`⚠️ Canali senza flussi validi: ${this.channelsWithoutStreams.length}`);
            }
            console.log('=== Processamento Completato ===\n');

            return {
                genres: Array.from(allGenres).sort(),
                channels: finalChannels,
                epgUrls: Array.from(allEpgUrls)
            };

        } catch (error) {
            console.error('❌ Errore critico in loadAndTransform:', error.message);
            this.channelsMap.clear(); // Pulisci la mappa
            throw error;
        }
    }
}

module.exports = PlaylistTransformer;
