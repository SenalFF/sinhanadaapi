const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

// Configuration
const PORT = process.env.PORT || 5000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const BASE_URL = 'https://sinhanada.net';

// Initialize Express
const app = express();
app.use(express.json());

// Create downloads directory if it doesn't exist
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Axios instance with headers
const client = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    timeout: 30000
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Parse search results from HTML
 */
function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const songs = [];
    const seenIds = new Set();

    // Find all links with pattern /data/file/{id}/
    $('a[href*="/data/file/"]').each((index, element) => {
        try {
            const href = $(element).attr('href');
            const match = href.match(/\/data\/file\/(\d+)\//);

            if (match) {
                const songId = match[1];

                // Skip duplicates
                if (seenIds.has(songId)) return;
                seenIds.add(songId);

                // Extract title
                let title = $(element).text().trim();
                if (!title) {
                    // Extract from URL if no text
                    const urlMatch = href.match(/\/data\/file\/\d+\/(.+?)\.html/);
                    if (urlMatch) {
                        title = urlMatch[1]
                            .replace(/-/g, ' ')
                            .replace(/_/g, ' ')
                            .replace(/\b\w/g, c => c.toUpperCase());
                    }
                }

                const songData = {
                    id: songId,
                    title: title || `Song ${songId}`,
                    detail_url: `${BASE_URL}${href}`,
                    download_url: `${BASE_URL}/downloadfile.php?id=${songId}`,
                    cover_url: `${BASE_URL}/show_cover.php?id=${songId}`,
                    api_download_url: `/api/download/${songId}`,
                    api_cover_url: `/api/cover/${songId}`
                };

                songs.push(songData);
            }
        } catch (error) {
            console.error('Error parsing song:', error.message);
        }
    });

    return songs;
}

/**
 * Extract title from detail page
 */
function extractTitleFromPage(html) {
    const $ = cheerio.load(html);
    
    // Try h1 first
    let title = $('h1').first().text().trim();
    
    // Try title tag
    if (!title) {
        title = $('title').first().text().trim();
    }
    
    return title || 'Unknown';
}

/**
 * Extract detailed metadata from music-info-box
 */
function extractMetadata(html) {
    const $ = cheerio.load(html);
    const metadata = {
        cover_artist: null,
        cover_artist_url: null,
        original_artist: null,
        music_rearrangement: null,
        youtube_url: null,
        artist: null,
        size: null,
        uploaded_on: null,
        views: null,
        downloads: null
    };

    try {
        // Find the music-info-box
        const infoBox = $('.music-info-box');
        
        if (infoBox.length > 0) {
            // Extract all content divs
            infoBox.find('.content').each((i, elem) => {
                const text = $(elem).text().trim();
                
                // Cover Artist
                if (text.includes('Cover Artist')) {
                    const link = $(elem).find('a');
                    if (link.length > 0) {
                        metadata.cover_artist = link.text().trim();
                        metadata.cover_artist_url = link.attr('href');
                    }
                }
                
                // Original Artist
                if (text.includes('Original Artist')) {
                    metadata.original_artist = text.replace('Original Artist :', '').replace('Original Artist:', '').trim();
                }
                
                // Music Rearrangement
                if (text.includes('Music Rearrangement')) {
                    metadata.music_rearrangement = text.replace('Music Rearrangement :', '').replace('Music Rearrangement:', '').trim();
                }
                
                // YouTube URL
                if (text.includes('Watch The Cover Song') || text.includes('Youtube')) {
                    const link = $(elem).find('a');
                    if (link.length > 0) {
                        metadata.youtube_url = link.attr('href');
                    }
                }
            });

            // Extract meta information
            infoBox.find('.meta').each((i, elem) => {
                const text = $(elem).text().trim();
                
                // Artist (emoji 🎤)
                if (text.includes('🎤') || text.includes('Artist :')) {
                    const match = text.match(/Artist\s*:\s*(.+)/);
                    if (match) {
                        metadata.artist = match[1].trim();
                    }
                }
                
                // Size (emoji 📦)
                if (text.includes('📦') || text.includes('Size :')) {
                    const match = text.match(/Size\s*:\s*(.+)/);
                    if (match) {
                        metadata.size = match[1].trim();
                    }
                }
                
                // Upload date (emoji ⏱)
                if (text.includes('⏱') || text.includes('Uploaded on :')) {
                    const match = text.match(/Uploaded on\s*:\s*(.+)/);
                    if (match) {
                        metadata.uploaded_on = match[1].trim();
                    }
                }
                
                // Views and Downloads (emoji 👁 and 📥)
                if (text.includes('👁') || text.includes('Views')) {
                    const viewsMatch = text.match(/Views\s*:\s*(\d+)/);
                    const downloadsMatch = text.match(/Downloads\s*:\s*(\d+)/);
                    
                    if (viewsMatch) {
                        metadata.views = parseInt(viewsMatch[1]);
                    }
                    if (downloadsMatch) {
                        metadata.downloads = parseInt(downloadsMatch[1]);
                    }
                }
            });
        }
    } catch (error) {
        console.error('Error extracting metadata:', error.message);
    }

    return metadata;
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * Root endpoint - API info
 */
app.get('/', (req, res) => {
    res.json({
        name: 'Sinhanada.net API',
        version: '2.0.0',
        description: 'Search and download MP3 songs from sinhanada.net with detailed metadata',
        endpoints: {
            'GET /': 'API information',
            'GET /api/search?q={query}': 'Search for songs',
            'GET /api/song/:id': 'Get song details by ID with full metadata',
            'GET /api/details?url={url}': 'Get song details from full URL',
            'GET /api/download/:id': 'Download MP3 file',
            'GET /api/cover/:id': 'Download cover image',
            'POST /api/batch-download': 'Batch download multiple songs',
            'GET /api/health': 'Health check'
        },
        examples: {
            search: '/api/search?q=sudu',
            song_details_by_id: '/api/song/45374',
            song_details_by_url: '/api/details?url=/data/file/45374/sudu-gawma-adan-ena-vita-cover-voice-of-achintha-rusiru-mp3.html',
            download_mp3: '/api/download/45374',
            download_cover: '/api/cover/45374'
        }
    });
});

/**
 * Search endpoint
 * GET /api/search?q=query&limit=10
 */
app.get('/api/search', async (req, res) => {
    try {
        const { q, limit } = req.query;

        if (!q) {
            return res.status(400).json({
                success: false,
                error: 'Query parameter "q" is required',
                example: '/api/search?q=sudu'
            });
        }

        console.log(`Searching for: ${q}`);

        const response = await client.get(`${BASE_URL}/search.php`, {
            params: { search: q }
        });

        let songs = parseSearchResults(response.data);

        // Apply limit if specified
        if (limit) {
            const limitNum = parseInt(limit);
            if (!isNaN(limitNum) && limitNum > 0) {
                songs = songs.slice(0, limitNum);
            }
        }

        res.json({
            success: true,
            query: q,
            total_results: songs.length,
            results: songs,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Search error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            query: req.query.q
        });
    }
});

/**
 * Get song details by ID
 * GET /api/song/:id
 */
app.get('/api/song/:id', async (req, res) => {
    try {
        const { id } = req.params;

        console.log(`Getting details for song ID: ${id}`);

        // Fetch detail page - try directory style first
        const detailUrl = `${BASE_URL}/data/file/${id}/`;
        
        const response = await client.get(detailUrl);
        const title = extractTitleFromPage(response.data);
        const metadata = extractMetadata(response.data);

        const songData = {
            success: true,
            id: id,
            title: title,
            detail_url: detailUrl,
            download_url: `${BASE_URL}/downloadfile.php?id=${id}`,
            cover_url: `${BASE_URL}/show_cover.php?id=${id}`,
            api_download_url: `/api/download/${id}`,
            api_cover_url: `/api/cover/${id}`,
            ...metadata,
            timestamp: new Date().toISOString()
        };

        res.json(songData);

    } catch (error) {
        console.error('Get song error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            id: req.params.id
        });
    }
});

/**
 * Get song details from full URL
 * GET /api/details?url=/data/file/45374/sudu-gawma-adan-ena-vita-cover.html
 */
app.get('/api/details', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'Query parameter "url" is required',
                example: '/api/details?url=/data/file/45374/sudu-gawma-adan-ena-vita-cover.html'
            });
        }

        // Build full URL
        const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
        console.log(`Getting details from URL: ${fullUrl}`);

        const response = await client.get(fullUrl);
        const title = extractTitleFromPage(response.data);
        const metadata = extractMetadata(response.data);
        
        // Extract ID from URL if possible
        const idMatch = fullUrl.match(/\/data\/file\/(\d+)\//);
        const id = idMatch ? idMatch[1] : null;

        const songData = {
            success: true,
            id: id,
            title: title,
            detail_url: fullUrl,
            download_url: id ? `${BASE_URL}/downloadfile.php?id=${id}` : null,
            cover_url: id ? `${BASE_URL}/show_cover.php?id=${id}` : null,
            api_download_url: id ? `/api/download/${id}` : null,
            api_cover_url: id ? `/api/cover/${id}` : null,
            ...metadata,
            timestamp: new Date().toISOString()
        };

        res.json(songData);

    } catch (error) {
        console.error('Get details error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            url: req.query.url
        });
    }
});

/**
 * Download MP3 file
 * GET /api/download/:id?save=true
 */
app.get('/api/download/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { save } = req.query;

        console.log(`Downloading MP3 for song ID: ${id}`);

        const downloadUrl = `${BASE_URL}/downloadfile.php?id=${id}`;
        const response = await client.get(downloadUrl, {
            responseType: 'stream'
        });

        // Extract filename from Content-Disposition or use default
        let filename = `song_${id}.mp3`;
        const contentDisp = response.headers['content-disposition'];
        if (contentDisp) {
            const match = contentDisp.match(/filename="?(.+?)"?(?:;|$)/);
            if (match) {
                filename = match[1];
            }
        }

        // Ensure .mp3 extension
        if (!filename.endsWith('.mp3')) {
            filename += '.mp3';
        }

        // If save=true, save to disk and return JSON
        if (save === 'true') {
            const filepath = path.join(DOWNLOAD_DIR, filename);
            
            await pipeline(
                response.data,
                fs.createWriteStream(filepath)
            );

            const stats = fs.statSync(filepath);

            return res.json({
                success: true,
                song_id: id,
                filename: filename,
                filepath: filepath,
                file_size: stats.size,
                file_size_mb: (stats.size / (1024 * 1024)).toFixed(2),
                download_url: downloadUrl,
                timestamp: new Date().toISOString()
            });
        }

        // Otherwise, stream the file to client
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        response.data.pipe(res);

    } catch (error) {
        console.error('Download error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            song_id: req.params.id
        });
    }
});

/**
 * Download cover image
 * GET /api/cover/:id?save=true
 */
app.get('/api/cover/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { save } = req.query;

        console.log(`Downloading cover for song ID: ${id}`);

        const coverUrl = `${BASE_URL}/show_cover.php?id=${id}`;
        const response = await client.get(coverUrl, {
            responseType: 'stream'
        });

        const filename = `cover_${id}.jpg`;

        // If save=true, save to disk and return JSON
        if (save === 'true') {
            const filepath = path.join(DOWNLOAD_DIR, filename);
            
            await pipeline(
                response.data,
                fs.createWriteStream(filepath)
            );

            const stats = fs.statSync(filepath);

            return res.json({
                success: true,
                song_id: id,
                filename: filename,
                filepath: filepath,
                file_size: stats.size,
                file_size_kb: (stats.size / 1024).toFixed(2),
                cover_url: coverUrl,
                timestamp: new Date().toISOString()
            });
        }

        // Otherwise, stream the image to client
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        response.data.pipe(res);

    } catch (error) {
        console.error('Cover download error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            song_id: req.params.id
        });
    }
});

/**
 * Batch download multiple songs
 * POST /api/batch-download
 * Body: { "song_ids": ["45374", "12345"], "download_covers": true }
 */
app.post('/api/batch-download', async (req, res) => {
    try {
        const { song_ids, download_covers } = req.body;

        if (!song_ids || !Array.isArray(song_ids)) {
            return res.status(400).json({
                success: false,
                error: 'song_ids array is required',
                example: { song_ids: ["45374", "12345"], download_covers: true }
            });
        }

        console.log(`Batch downloading ${song_ids.length} songs`);

        const results = [];

        for (const id of song_ids) {
            const result = {
                song_id: id,
                mp3: null,
                cover: null
            };

            try {
                // Download MP3
                const downloadUrl = `${BASE_URL}/downloadfile.php?id=${id}`;
                const mp3Response = await client.get(downloadUrl, {
                    responseType: 'stream'
                });

                const mp3Filename = `song_${id}.mp3`;
                const mp3Filepath = path.join(DOWNLOAD_DIR, mp3Filename);

                await pipeline(
                    mp3Response.data,
                    fs.createWriteStream(mp3Filepath)
                );

                const mp3Stats = fs.statSync(mp3Filepath);

                result.mp3 = {
                    success: true,
                    filename: mp3Filename,
                    filepath: mp3Filepath,
                    file_size: mp3Stats.size,
                    file_size_mb: (mp3Stats.size / (1024 * 1024)).toFixed(2)
                };

                // Download cover if requested
                if (download_covers) {
                    try {
                        const coverUrl = `${BASE_URL}/show_cover.php?id=${id}`;
                        const coverResponse = await client.get(coverUrl, {
                            responseType: 'stream'
                        });
                        const coverFilename = `cover_${id}.jpg`;
                        const coverFilepath = path.join(DOWNLOAD_DIR, coverFilename);
                        await pipeline(coverResponse.data, fs.createWriteStream(coverFilepath));
                        const coverStats = fs.statSync(coverFilepath);
                        result.cover = {
                            success: true,
                            filename: coverFilename,
                            filepath: coverFilepath,
                            file_size: coverStats.size
                        };
                    } catch (e) {
                        result.cover = { success: false, error: e.message };
                    }
                }
                results.push(result);
            } catch (error) {
                result.mp3 = { success: false, error: error.message };
                results.push(result);
            }
        }

        res.json({
            success: true,
            total: song_ids.length,
            results: results,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});
