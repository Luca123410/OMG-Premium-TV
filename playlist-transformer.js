const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config'); // 'config' non è usato qui, ma lo manteniamo se serve in futuro

class PlaylistTransformer {
    constructor() {
        this.remappingRules = new Map();
        this.channelsMap = new Map();
        this.channelsWithoutStreams = [];
    }

    // --- MODIFICA BOMBA #2: Normalizzazione "Fuzzy" ---
    // Resa identica a cache-manager.js per coerenza.
    // Rimuove TUTTI i caratteri non alfanumerici (inclusi . e _)
    normalizeId(id) {
        return id?.toLowerCase().replace(/[^\w]/g, '').trim() || '';
    }
    // --- FINE BOMBA #2 ---

    cleanChannelName(name) {
        return name
            .replace(/[\(\[].*?[\)\]]/g, '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '');
    }

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
                    // Prova a leggere il file locale come fallback
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
            if (error.code === 'ENOENT' && remappingPath !== defaultPath) {
                console.warn(`⚠️ File remapping non trovato in ${remappingPath}, uso fallback locale.`);
                // Se il file remoto/personalizzato fallisce, prova a caricare quello di default
                await this.loadRemappingRules({ ...config, remapper_path: defaultPath });
            } else {
                console.error('❌ Errore finale remapping:', error.message);
            }
        }
    }

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
                console.error('Error parsing EXTHTTP:', e);
            }
        }

        const finalHeaders = { ...extinfHeaders, ...vlcHeaders, ...httpHeaders };

        // 4. Unifica gli header (con priorità)
        finalHeaders['User-Agent'] = httpHeaders['User-Agent'] || httpHeaders['user-agent'] ||
                                     vlcHeaders['user-agent'] || extinfHeaders['user-agent'] ||
                                     config.defaultUserAgent;

        finalHeaders['referrer'] = httpHeaders['referrer'] || httpHeaders['referer'] ||
                                   vlcHeaders['referrer'] || vlcHeaders['referer'] ||
                                   extinfHeaders['referrer'] || extinfHeaders['referer'];
        
        // Rimuovi 'referer' se 'referrer' esiste
        if (finalHeaders['referrer']) delete finalHeaders['referer'];

        return { headers: finalHeaders, nextIndex: i };
    }
    
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

        return {
            name,
            group: genres,
            tvg: tvgData,
            headers
        };
    }

    // --- MODIFICA BOMBA #3: Logica Suffissi Semplificata ---
    getRemappedId(channel) {
        // 1. Prendi l'ID (o il nome normalizzato se l'ID non c'è)
        const originalId = channel.tvg.id;
        const normalizedId = this.normalizeId(originalId);
        
        // 2. Controlla le regole di remapping sull'ID normalizzato
        const remappedId = this.remappingRules.get(normalizedId);
        
        // 3. Ritorna l'ID rimappato O quello normalizzato
        return remappedId || normalizedId;
    }

    createChannelObject(channel, remappedId, config) {
        const name = channel.tvg?.name || channel.name;
        const cleanName = name.replace(/\s*\(.*?\)\s*/g, '').trim();
        
        // 4. Applica il suffisso (se esiste) all'ID finale UNA SOLA VOLTA
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
                urls: [],
                tvg: {
                    ...channel.tvg,
                    id: finalChannelId, // Usa l'ID finale e suffissato
                    name: cleanName
                }
            }
        };
    }
    // --- FINE BOMBA #3 ---

    addStreamToChannel(channel, url, name, genres, headers) {
        if (genres) {
            genres.forEach(newGenre => {
                if (!channel.genre.includes(newGenre)) {
                    channel.genre.push(newGenre);
                }
            });
        }

        if (url === null || url.toLowerCase() === 'null') {
            channel.streamInfo.urls.push({
                url: 'https://static.vecteezy.com/system/resources/previews/001/803/236/mp4/no-signal-bad-tv-free-video.mp4',
                name: 'Nessuno flusso presente nelle playlist m3u',
                headers
            });
        } else {
            channel.streamInfo.urls.push({
                url,
                name,
                headers
            });
        }
    }
    
    async parseM3UContent(content, config) {
        const lines = content.split('\n');
        let currentChannel = null;
        const genres = new Set(['Undefined']); // 'Undefined' non verrà usato se un genere è trovato
    
        let epgUrl = null;
        if (lines[0].includes('url-tvg=')) {
            const match = lines[0].match(/url-tvg="([^"]+)"/);
            if (match) {
                epgUrl = match[1].split(',').map(url => url.trim());
                console.log('URL EPG trovati nella playlist:', epgUrl);
            }
        }
    
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
        
            if (line.startsWith('#EXTINF:')) {
                const { headers, nextIndex } = this.parseVLCOpts(lines, i + 1, line);
                i = nextIndex - 1;
                currentChannel = this.parseChannelFromLine(line, headers, config);

            } else if ((line.startsWith('http') || line.toLowerCase() === 'null') && currentChannel) {
                const remappedId = this.getRemappedId(currentChannel);
                
                if (!this.channelsMap.has(remappedId)) {
                    // Passa 'config' per la gestione del suffisso (BOMBA #3)
                    const channelObj = this.createChannelObject(currentChannel, remappedId, config); 
                    this.channelsMap.set(remappedId, channelObj);
                    currentChannel.group.forEach(genre => genres.add(genre));
                }

                const channelObj = this.channelsMap.get(remappedId);
                this.addStreamToChannel(channelObj, line, currentChannel.name, currentChannel.group, currentChannel.headers);
    
                currentChannel = null;
            }
        }
        
        // Rimuovi 'Undefined' se abbiamo trovato altri generi
        if (genres.size > 1) {
            genres.delete('Undefined');
        }

        // La logica di warning per canali senza stream è stata spostata
        // alla fine di loadAndTransform per un report unificato.

        return {
            genres: Array.from(genres),
            epgUrl
        };
    }

    // --- NUOVA FUNZIONE HELPER (per BOMBA #1) ---
    /**
     * Scarica e processa un singolo URL M3U
     */
    async downloadAndParseOneM3U(playlistUrl, config) {
        console.log('\nProcesso playlist:', playlistUrl);
        const playlistResponse = await axios.get(playlistUrl, { timeout: 15000 }); // Timeout 15 sec
        return await this.parseM3UContent(playlistResponse.data, config);
    }
    // --- FINE FUNZIONE HELPER ---


    // --- MODIFICA BOMBA #1: Parsing Parallelo ---
    async loadAndTransform(url, config = {}) {
        try {
            await this.loadRemappingRules(config);
            
            // 1. Ottieni la lista di tutti gli URL da processare
            const urlList = url.split(',').map(u => u.trim()).filter(u => u);
            console.log('\n=== Inizio Processamento Playlist ===');
            console.log('URL M3U forniti:', urlList.length);
            
            let playlistUrls = [];
            
            // Processa gli URL per espandere le "liste di liste"
            for (const singleUrl of urlList) {
                try {
                    const response = await axios.get(singleUrl, { timeout: 10000 }); // Timeout 10 sec
                    const content = response.data;
                    
                    if (content.startsWith('#EXTM3U')) {
                        playlistUrls.push(singleUrl);
                        console.log('✓ File M3U diretto trovato:', singleUrl);
                    } else {
                        const urls = content.split('\n').filter(line => line.trim() && line.startsWith('http'));
                        playlistUrls.push(...urls);
                        console.log(`✓ Lista URL trovata, contiene ${urls.length} playlist`);
                    }
                } catch (error) {
                    console.error('❌ Errore nel processare URL lista:', singleUrl, error.message);
                }
            }

            console.log(`\nDownload e Parsing Parallelo di ${playlistUrls.length} playlist...`);
            const allGenres = new Set();
            const allEpgUrls = new Set();

            // 2. Scarica e processa TUTTE le playlist in parallelo
            const allResults = await Promise.allSettled(
                playlistUrls.map(pUrl => this.downloadAndParseOneM3U(pUrl, config))
            );

            // 3. Unisci i risultati
            allResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    const { genres, epgUrl } = result.value;
                    genres.forEach(genre => allGenres.add(genre));
                    
                    if (epgUrl) {
                        if (Array.isArray(epgUrl)) {
                            epgUrl.forEach(url => allEpgUrls.add(url));
                        } else {
                            allEpgUrls.add(epgUrl);
                        }
                    }
                } else {
                    // Se una playlist fallisce, logga l'errore ma non bloccare l'intero processo
                    console.error(`❌ Fallito il parsing di: ${playlistUrls[index]}`);
                    console.error(`Motivo: ${result.reason.message}`);
                }
            });
            // --- FINE BOMBA #1 ---

            const finalResult = {
                genres: Array.from(allGenres),
                channels: Array.from(this.channelsMap.values()),
                epgUrls: Array.from(allEpgUrls)
            };

            // Pulizia dei canali con solo stream "dummy"
            this.channelsWithoutStreams = [];
            finalResult.channels.forEach(channel => {
                if (channel.streamInfo.urls.length > 1) {
                    channel.streamInfo.urls = channel.streamInfo.urls.filter(
                        stream => stream.name !== 'Nessuno flusso presente nelle playlist m3u'
                    );
                }
                if (channel.streamInfo.urls.length === 0) {
                     this.channelsWithoutStreams.push(channel.name);
                }
            });

            // Log di riepilogo
            console.log('\nRiepilogo Processamento:');
            console.log(`✓ Totale canali unici: ${finalResult.channels.length}`);
            console.log(`✓ Totale generi unici: ${finalResult.genres.length}`);
            if (allEpgUrls.size > 0) {
                console.log(`✓ URL EPG unici: ${allEpgUrls.size}`);
            }
            if (this.channelsWithoutStreams.length > 0) {
                console.warn(`⚠️ Canali senza flussi validi: ${this.channelsWithoutStreams.length}`);
            }
            console.log('=== Processamento Completato ===\n');

            this.channelsMap.clear(); // Pulisci la mappa per la prossima esecuzione
            this.channelsWithoutStreams = [];
            return finalResult;

        } catch (error) {
            console.error('❌ Errore critico in loadAndTransform:', error.message);
            this.channelsMap.clear(); // Pulisci anche in caso di errore
            throw error;
        }
    }
}

module.exports = PlaylistTransformer;
