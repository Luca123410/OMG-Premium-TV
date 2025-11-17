const fs = require('fs');
const path = require('path');

const baseConfig = {
    port: process.env.PORT || 10000,
    defaultUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    defaultLanguage: 'Italiana',
    cacheSettings: {
        updateInterval: 2 * 60 * 60 * 1000,
        maxAge: 12 * 60 * 60 * 1000,
        retryAttempts: 3,
        retryDelay: 5000
    },
    epgSettings: {
        maxProgramsPerChannel: 50,
        updateInterval: 2 * 60 * 60 * 1000,
        cacheExpiry: 12 * 60 * 60 * 1000
    },
    manifest: {
        id: 'org.mccoy88f.omgtv', // Sarà sovrascritto da addon-config.json
        version: '1.0.0', // Sarà sovrascritto
        name: 'OMG TV', // Sarà sovrascritto
        description: 'Modalita provvisoria, installazione con errori, attivo mod. provvisoria',
        logo: 'https://github.com/mccoy88f/OMG-TV-Stremio-Addon/blob/main/tv.png?raw=true',
        resources: ['stream', 'catalog', 'meta'],
        types: ['tv'],
        idPrefixes: ['tv'],
        catalogs: [
            // --- MODIFICA BOMBA: Catalogo "In Onda Ora" Aggiunto di Default ---
            {
                type: 'tv',
                id: 'omg_tv_now_playing', // L'ID che il tuo handlers.js si aspetta
                name: '📺 In Onda Ora',
                extra: [] // Questo catalogo non ha filtri
            },
            // --- FINE MODIFICA BOMBA ---
            {
                type: 'tv',
                id: 'omg_tv', // Il catalogo principale di base
                name: 'OMG TV',
                extra: [
                    {
                        name: 'genre',
                        isRequired: false,
                        options: []  // Verrà popolato dinamicamente
                    },
                    {
                        name: 'search',
                        isRequired: false
                    },
                    {
                        name: 'skip',
                        isRequired: false
                    }
                ]
            }
        ],
        behaviorHints: {
            configurationURL: null,  // Verrà impostato dinamicamente
            reloadRequired: true
        }
    }
};

function loadCustomConfig() {
    const configOverridePath = path.join(__dirname, 'addon-config.json');
    
    try {
        const addonConfigExists = fs.existsSync(configOverridePath);

        if (addonConfigExists) {
            const customConfig = JSON.parse(fs.readFileSync(configOverridePath, 'utf8'));
            
            // Definisci il tuo catalogo personalizzato (quello da addon-config.json)
            const customCatalog = {
                ...baseConfig.manifest.catalogs[1], // Prendi il template del catalogo principale
                id: 'omg_plus_tv', // ID personalizzato
                name: customConfig.addonName || 'OMG+ TV', // Nome personalizzato
                extra: [ ...baseConfig.manifest.catalogs[1].extra ] // Stessi extra
            };

            const mergedConfig = {
                ...baseConfig,
                defaultLanguage: customConfig.defaultLanguage || baseConfig.defaultLanguage,
                manifest: {
                    ...baseConfig.manifest,
                    id: customConfig.addonId || baseConfig.manifest.id,
                    name: customConfig.addonName || baseConfig.manifest.name,
                    description: customConfig.addonDescription || baseConfig.manifest.description,
                    version: customConfig.addonVersion || baseConfig.manifest.version,
                    logo: customConfig.addonLogo || baseConfig.manifest.logo,
                    behaviorHints: {
                        configurationURL: null,  // Verrà impostato dinamicamente
                        reloadRequired: true
                    },
                    // --- MODIFICA BOMBA: Unione Intelligente dei Cataloghi ---
                    // Ora l'utente vedrà [Il tuo Addon] E [📺 In Onda Ora]
                    catalogs: [
                        customCatalog, // Il tuo catalogo personalizzato (es. "Zenith")
                        ...baseConfig.manifest.catalogs // Tutti i cataloghi di base (incluso "In Onda Ora")
                    ]
                    // --- FINE MODIFICA BOMBA ---
                }
            };

            return mergedConfig;
        }
    } catch (error) {
        console.error('Errore nel caricare la configurazione personalizzata:', error);
    }

    return baseConfig;
}

const config = loadCustomConfig();
module.exports = config;
