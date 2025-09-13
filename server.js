/**
 * FWEA-I Audio Processing Server
 * Advanced audio processing server for Hetzner VPS
 * Handles heavy audio processing tasks from Cloudflare Workers
 */

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
    MAX_FILE_SIZE: 200 * 1024 * 1024, // 200MB
    UPLOAD_PATH: './uploads',
    PROCESSED_PATH: './processed',
    TEMP_PATH: './temp',
    SUPPORTED_FORMATS: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'],
    QUALITY_SETTINGS: {
        single_track: { bitrate: '256k', sample: '44100' },
        dj_pro: { bitrate: '320k', sample: '44100' },
        studio_elite: { bitrate: '320k', sample: '48000' },
        day_pass: { bitrate: '256k', sample: '44100' }
    },
    PREVIEW_LENGTHS: {
        single_track: 30,
        dj_pro: 30,
        studio_elite: 60,
        day_pass: 30
    }
};

// Middleware
app.use(helmet());
app.use(cors({
    origin: [
        'https://omnibackend2.fweago-flavaz.workers.dev',
        'https://*.workers.dev'
    ],
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests, please try again later.'
});
app.use('/api/', limiter);

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Storage configuration
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        await ensureDirectoryExists(CONFIG.UPLOAD_PATH);
        cb(null, CONFIG.UPLOAD_PATH);
    },
    filename: (req, file, cb) => {
        const uniqueName = crypto.randomUUID() + '_' + Date.now() + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: CONFIG.MAX_FILE_SIZE
    },
    fileFilter: (req, file, cb) => {
        const extension = path.extname(file.originalname).toLowerCase().substring(1);
        if (CONFIG.SUPPORTED_FORMATS.includes(extension)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported format: ${extension}`), false);
        }
    }
});

// Initialize directories
async function initializeDirectories() {
    try {
        await ensureDirectoryExists(CONFIG.UPLOAD_PATH);
        await ensureDirectoryExists(CONFIG.PROCESSED_PATH);
        await ensureDirectoryExists(CONFIG.TEMP_PATH);
        console.log('✅ Directories initialized');
    } catch (error) {
        console.error('❌ Failed to initialize directories:', error);
        process.exit(1);
    }
}

async function ensureDirectoryExists(dirPath) {
    try {
        await fs.access(dirPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(dirPath, { recursive: true });
        } else {
            throw error;
        }
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        server: 'FWEA-I Audio Processing Server',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        loadAverage: require('os').loadavg()
    });
});

// Audio processing endpoint
app.post('/api/process-audio', upload.single('audio'), async (req, res) => {
    const processId = crypto.randomUUID();

    try {
        console.log(`Starting audio processing: ${processId}`);

        if (!req.file) {
            return res.status(400).json({ error: 'No audio file provided' });
        }

        const { planType = 'single_track', profanityTimestamps = '[]' } = req.body;
        const timestamps = JSON.parse(profanityTimestamps);

        const inputPath = req.file.path;
        const outputPath = path.join(CONFIG.PROCESSED_PATH, `cleaned_${processId}.mp3`);
        const previewPath = path.join(CONFIG.PROCESSED_PATH, `preview_${processId}.mp3`);

        // Get quality settings for plan
        const qualitySettings = CONFIG.QUALITY_SETTINGS[planType] || CONFIG.QUALITY_SETTINGS.single_track;
        const previewLength = CONFIG.PREVIEW_LENGTHS[planType] || 30;

        // Process main audio file
        const mainAudioBuffer = await processAudioFile(
            inputPath, 
            outputPath, 
            timestamps, 
            qualitySettings
        );

        // Generate preview
        const previewBuffer = await generatePreview(
            outputPath,
            previewPath,
            previewLength,
            qualitySettings
        );

        // Get file information
        const audioInfo = await getAudioInfo(outputPath);

        // Clean up upload file
        await fs.unlink(inputPath);

        console.log(`Audio processing completed: ${processId}`);

        res.json({
            success: true,
            processId,
            files: {
                cleaned: outputPath,
                preview: previewPath
            },
            audioInfo,
            processing: {
                segmentsCleaned: timestamps.length,
                qualityEnhanced: true,
                formatOptimized: true
            }
        });

    } catch (error) {
        console.error(`Audio processing failed: ${processId}`, error);
        res.status(500).json({
            error: 'Audio processing failed',
            processId,
            details: error.message
        });
    }
});

// Download processed audio
app.get('/api/download/:processId/:type', async (req, res) => {
    try {
        const { processId, type } = req.params;
        const filename = type === 'preview' ? `preview_${processId}.mp3` : `cleaned_${processId}.mp3`;
        const filePath = path.join(CONFIG.PROCESSED_PATH, filename);

        // Check if file exists
        try {
            await fs.access(filePath);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Set appropriate headers
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        // Stream file
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);

        // Clean up file after sending (optional)
        fileStream.on('end', async () => {
            try {
                // Keep files for 1 hour before cleanup
                setTimeout(async () => {
                    try {
                        await fs.unlink(filePath);
                        console.log(`Cleaned up file: ${filename}`);
                    } catch (err) {
                        console.warn(`Failed to cleanup ${filename}:`, err.message);
                    }
                }, 60 * 60 * 1000); // 1 hour
            } catch (err) {
                console.warn('Cleanup scheduling failed:', err.message);
            }
        });

    } catch (error) {
        console.error('Download failed:', error);
        res.status(500).json({ error: 'Download failed' });
    }
});

// Audio processing function
async function processAudioFile(inputPath, outputPath, profanityTimestamps, qualitySettings) {
    return new Promise((resolve, reject) => {
        console.log(`Processing audio: ${inputPath} -> ${outputPath}`);

        let ffmpegCommand = ffmpeg(inputPath)
            .audioBitrate(qualitySettings.bitrate)
            .audioFrequency(qualitySettings.sample)
            .audioCodec('libmp3lame')
            .format('mp3');

        // Apply profanity filtering (mute segments)
        if (profanityTimestamps.length > 0) {
            console.log(`Applying ${profanityTimestamps.length} profanity filters`);

            // Build complex filter for muting profanity segments
            let filters = [];
            let currentInput = '[0:a]';

            profanityTimestamps.forEach((timestamp, index) => {
                const startTime = Math.max(0, timestamp.timestamp - 0.5); // 0.5s buffer
                const endTime = timestamp.timestamp + (timestamp.duration || 1.0);

                filters.push({
                    filter: 'volume',
                    options: `enable='between(t,${startTime},${endTime})':volume=0`,
                    inputs: currentInput,
                    outputs: `[muted${index}]`
                });
                currentInput = `[muted${index}]`;
            });

            // Apply noise reduction and enhancement
            filters.push({
                filter: 'highpass',
                options: 'f=80', // Remove low frequency noise
                inputs: currentInput,
                outputs: '[filtered]'
            });

            filters.push({
                filter: 'compand',
                options: 'attacks=0.3:decays=0.8:points=-80/-169|-54/-80|-49.5/-64.6|-41.1/-41.1|-25.8/-15|-10.8/-4.5|0/0|20/8.3',
                inputs: '[filtered]',
                outputs: '[compressed]'
            });

            ffmpegCommand = ffmpegCommand.complexFilter(filters, '[compressed]');
        } else {
            // Apply basic audio enhancement even without profanity
            ffmpegCommand = ffmpegCommand
                .audioFilters([
                    'highpass=f=80',
                    'compand=attacks=0.3:decays=0.8:points=-80/-169|-54/-80|-49.5/-64.6|-41.1/-41.1|-25.8/-15|-10.8/-4.5|0/0|20/8.3'
                ]);
        }

        ffmpegCommand
            .on('start', (commandLine) => {
                console.log('FFmpeg process started:', commandLine);
            })
            .on('progress', (progress) => {
                console.log(`Processing: ${Math.round(progress.percent || 0)}% done`);
            })
            .on('end', () => {
                console.log('Audio processing completed');
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                reject(err);
            })
            .save(outputPath);
    });
}

// Generate preview from processed audio
async function generatePreview(inputPath, outputPath, duration, qualitySettings) {
    return new Promise((resolve, reject) => {
        console.log(`Generating ${duration}s preview: ${outputPath}`);

        ffmpeg(inputPath)
            .seekInput(0) // Start from beginning
            .duration(duration) // Limit duration
            .audioBitrate(qualitySettings.bitrate)
            .audioFrequency(qualitySettings.sample)
            .audioCodec('libmp3lame')
            .format('mp3')
            .on('end', () => {
                console.log('Preview generation completed');
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error('Preview generation error:', err);
                reject(err);
            })
            .save(outputPath);
    });
}

// Get audio file information
async function getAudioInfo(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }

            const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');
            if (!audioStream) {
                reject(new Error('No audio stream found'));
                return;
            }

            resolve({
                duration: parseFloat(metadata.format.duration),
                bitrate: parseInt(metadata.format.bit_rate),
                sampleRate: parseInt(audioStream.sample_rate),
                channels: audioStream.channels,
                codec: audioStream.codec_name,
                size: parseInt(metadata.format.size)
            });
        });
    });
}

// Cleanup old files periodically
async function cleanupOldFiles() {
    try {
        const directories = [CONFIG.PROCESSED_PATH, CONFIG.UPLOAD_PATH, CONFIG.TEMP_PATH];
        const maxAge = 4 * 60 * 60 * 1000; // 4 hours
        const now = Date.now();

        for (const dir of directories) {
            try {
                const files = await fs.readdir(dir);

                for (const file of files) {
                    const filePath = path.join(dir, file);
                    const stats = await fs.stat(filePath);

                    if (now - stats.mtime.getTime() > maxAge) {
                        await fs.unlink(filePath);
                        console.log(`Cleaned up old file: ${file}`);
                    }
                }
            } catch (error) {
                console.warn(`Failed to cleanup directory ${dir}:`, error.message);
            }
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);

    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large' });
        }
        return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
        process.exit(0);
    });
});

// Start server
async function startServer() {
    try {
        await initializeDirectories();

        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 FWEA-I Audio Processing Server running on port ${PORT}`);
            console.log(`🌐 Server accessible at http://178.156.190.229:${PORT}`);
            console.log(`💾 Upload path: ${CONFIG.UPLOAD_PATH}`);
            console.log(`🎵 Processed path: ${CONFIG.PROCESSED_PATH}`);
        });

        // Start cleanup routine
        setInterval(cleanupOldFiles, 60 * 60 * 1000); // Run every hour

        return server;

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Export for testing
module.exports = { app, startServer };

// Start server if run directly
if (require.main === module) {
    startServer();
}
