const config = require('./config');
const CacheManager = require('./cache-manager')(config);
const EPGManager = require('./epg-manager');

function normalizeId(id) {
    return id?.toLowerCase().replace(/[^\w.]/g, '').trim() || '';
}

// --- NUOVA BOMBA #3: Helper per lingua dinamica ---
function getLanguageFromConfig(userConfig) {
    return userConfig.language || config.defaultLanguage || 'Italiana';
}

// --- NUOVA BOMBA #2: Helper per pulizia nome e fallback logo ---
function cleanNameForImage(name) {
    let cleaned = name.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned || 'Canale';
}

function getFallbackLogo(name) {
    const displayName = cleanNameForImage(name);
    const encodedName = encodeURIComponent(displayName).replace(/%20/g, '+');
    return `https://dummyimage.com/500x500/8A5AAB/ffffff.jpg&text=${encodedName}`;
}
// --- FINE BOMBA #2 ---


function enrichWithDetailedEPG(meta, channelId, userConfig) {
    if (!userConfig.epg_enabled === 'true') { // Controllo più stretto
        return meta;
    }

    const normalizedId = normalizeId(channelId);
    if (!normalizedId) return meta;

    const currentProgram = EPGManager.getCurrentProgram(normalizedId);
    const upcomingPrograms = EPGManager.getUpcomingPrograms(normalizedId);

    if (currentProgram) {
        let description = [];
        
        description.push('📺 IN ONDA ORA:', currentProgram.title);
        
        if (currentProgram.description) {
            description.push('', currentProgram.description);
        }

        description.push('', `⏰ ${currentProgram.start} - ${currentProgram.stop}`);

        // --- MODIFICA BOMBA #1 e #3: Poster/Genere dinamici ---
        // Se l'EPG fornisce un'icona per il *programma*, la usiamo come poster!
        if (currentProgram.icon) { 
            meta.poster = currentProgram.icon;
            meta.background = currentProgram.icon;
        }

        // Il genere del meta diventa quello del programma in onda
        if (currentProgram.category) {
            meta.genre = [currentProgram.category]; // Sovrascrive il genere del canale
            description.push(`🏷️ ${currentProgram.category}`);
        }
        // --- FINE BOMBA #1 e #3 ---

        if (upcomingPrograms?.length > 0) {
            description.push('', '📅 PROSSIMI PROGRAMMI:');
            upcomingPrograms.forEach(program => {
                description.push('', `• ${program.start} - ${program.title}`);
                if (program.description) {
                    description.push(`  ${program.description.substring(0, 100)}...`); // Tronca per pulizia
                }
                if (program.category) {
                    description.push(`  🏷️ ${program.category}`);
                }
            });
        }

        meta.description = description.join('\n');
        meta.releaseInfo = `${currentProgram.title} (${currentProgram.start})`;
    }

    return meta;
}

async function metaHandler({ type, id, config: userConfig }) {
    try {
        if (!userConfig.m3u) {
            console.log('❌ URL M3U mancante');
            return { meta: null };
        }

        // --- OTTIMIZZAZIONE: Aggiorna la config del CacheManager ---
        // (Il tuo handlers.js lo fa, questo dovrebbe farlo anche per coerenza)
        await CacheManager.updateConfig(userConfig);

        // Non è necessario un rebuild forzato qui, getChannel è sufficiente.
        // Lasciamo che il polling gestisca l'aggiornamento.
        // if (CacheManager.cache.m3uUrl !== userConfig.m3u) { ... } // Rimosso per velocità

        const channelId = id.split('|')[1];
        const channel = CacheManager.getChannel(channelId);
        
        if (!channel) {
            console.log(`[MetaHandler] Canale non trovato: ${channelId}`);
            return { meta: null };
        }

        // --- MODIFICA BOMBA #2 e #3: Fallback e Lingua Dinamica ---
        const language = getLanguageFromConfig(userConfig);
        const epgIcon = EPGManager.getChannelIcon(normalizeId(channel.streamInfo?.tvg?.id));
        const fallbackLogo = getFallbackLogo(channel.name);

        const logo = channel.logo || epgIcon || fallbackLogo;
        const poster = channel.poster || logo; // Il poster di default è il logo

        const meta = {
            id: channel.id,
            type: 'tv',
            name: channel.streamInfo?.tvg?.chno 
                ? `${channel.streamInfo.tvg.chno}. ${channel.name}`
                : channel.name,
            poster: poster,
            background: channel.background || poster, // Background di default è il poster
            logo: logo,
            description: '', // Sarà popolato sotto
            releaseInfo: 'LIVE',
            genre: channel.genre || ['Live TV'], // Genere di fallback
            posterShape: 'square',
            language: language.substring(0, 3).toLowerCase(), // Es. 'ita'
            country: 'N/A', // Mantenuto generico
            isFree: true,
            behaviorHints: {
                isLive: true,
                defaultVideoId: channel.id
            }
        };
        // --- FINE BOMBA #2 e #3 ---

        let baseDescription = [];
        if (channel.streamInfo?.tvg?.chno) {
            baseDescription.push(`📺 Canale ${channel.streamInfo.tvg.chno}`);
        }
        if (channel.description) {
            baseDescription.push('', channel.description);
        } else {
            baseDescription.push('', `ID Canale: ${channel.streamInfo?.tvg?.id}`);
        }
        meta.description = baseDescription.join('\n');

        // Arricchisce il meta con EPG (che ora include la BOMBA #1)
        const enrichedMeta = enrichWithDetailedEPG(meta, channel.streamInfo?.tvg?.id, userConfig);

        return { meta: enrichedMeta };
    } catch (error) {
        console.error('[MetaHandler] Errore:', error.message, error.stack);
        return { meta: null };
    }
}

module.exports = metaHandler;
