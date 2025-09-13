-- FWEA-I Audio Cleaning Platform Database Schema v3.0
-- Updated for production deployment with actual Stripe integration

-- User Subscriptions Table
CREATE TABLE IF NOT EXISTS user_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    plan_type TEXT NOT NULL CHECK(plan_type IN ('single_track', 'dj_pro', 'studio_elite', 'day_pass')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'canceled', 'expired')),
    amount_paid INTEGER,
    currency TEXT DEFAULT 'usd',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    expires_at INTEGER, -- NULL for subscriptions, timestamp for day passes
    metadata TEXT -- JSON for additional data
);

-- Processing History Table
CREATE TABLE IF NOT EXISTS processing_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    process_id TEXT UNIQUE NOT NULL,
    stripe_session_id TEXT,
    original_filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    plan_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing', 'completed', 'failed')),

    -- Processing results
    words_removed INTEGER DEFAULT 0,
    detected_languages TEXT, -- JSON array of detected languages
    processing_time_ms INTEGER,

    -- File paths
    upload_key TEXT,
    preview_key TEXT,
    cleaned_key TEXT,

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    completed_at INTEGER,

    -- Error handling
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,

    FOREIGN KEY (stripe_session_id) REFERENCES user_subscriptions(stripe_session_id)
);

-- Payment Transactions Table
CREATE TABLE IF NOT EXISTS payment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id TEXT NOT NULL,
    stripe_payment_intent_id TEXT,
    user_email TEXT,
    plan_type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'pending',
    payment_method TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    metadata TEXT -- JSON for webhook data
);

-- Usage Analytics Table
CREATE TABLE IF NOT EXISTS usage_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL CHECK(event_type IN ('upload', 'process', 'download', 'payment', 'error')),
    process_id TEXT,
    stripe_session_id TEXT,
    plan_type TEXT,

    -- File information
    file_size INTEGER,
    processing_time_ms INTEGER,
    words_removed INTEGER,

    -- User information
    user_agent TEXT,
    ip_address TEXT,
    country TEXT,

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),

    -- Additional data
    metadata TEXT -- JSON for additional analytics data
);

-- System Health Table
CREATE TABLE IF NOT EXISTS system_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'unhealthy')),
    response_time_ms INTEGER,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    checked_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Profanity Lists Cache Table (for KV backup)
CREATE TABLE IF NOT EXISTS profanity_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language_code TEXT NOT NULL UNIQUE,
    word_count INTEGER NOT NULL,
    last_updated INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    checksum TEXT
);

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_session_id ON user_subscriptions(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_plan_type ON user_subscriptions(plan_type);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_created_at ON user_subscriptions(created_at);

CREATE INDEX IF NOT EXISTS idx_processing_history_process_id ON processing_history(process_id);
CREATE INDEX IF NOT EXISTS idx_processing_history_status ON processing_history(status);
CREATE INDEX IF NOT EXISTS idx_processing_history_session_id ON processing_history(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_processing_history_created_at ON processing_history(created_at);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_session_id ON payment_transactions(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_created_at ON payment_transactions(created_at);

CREATE INDEX IF NOT EXISTS idx_usage_analytics_event_type ON usage_analytics(event_type);
CREATE INDEX IF NOT EXISTS idx_usage_analytics_created_at ON usage_analytics(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_analytics_plan_type ON usage_analytics(plan_type);

CREATE INDEX IF NOT EXISTS idx_system_health_service_name ON system_health(service_name);
CREATE INDEX IF NOT EXISTS idx_system_health_checked_at ON system_health(checked_at);

-- Triggers for automatic timestamp updates
CREATE TRIGGER IF NOT EXISTS update_user_subscriptions_timestamp
    AFTER UPDATE ON user_subscriptions
    BEGIN
        UPDATE user_subscriptions SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_payment_transactions_timestamp
    AFTER UPDATE ON payment_transactions
    BEGIN
        UPDATE payment_transactions SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
    END;

-- Views for common queries
CREATE VIEW IF NOT EXISTS active_subscriptions AS
SELECT 
    s.*,
    COUNT(p.id) as processed_files,
    SUM(p.file_size) as total_data_processed
FROM user_subscriptions s
LEFT JOIN processing_history p ON s.stripe_session_id = p.stripe_session_id
WHERE s.status = 'active' 
AND (s.expires_at IS NULL OR s.expires_at > strftime('%s', 'now') * 1000)
GROUP BY s.id;

CREATE VIEW IF NOT EXISTS processing_stats AS
SELECT 
    DATE(created_at/1000, 'unixepoch') as date,
    plan_type,
    COUNT(*) as total_processed,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
    AVG(processing_time_ms) as avg_processing_time,
    SUM(words_removed) as total_words_removed,
    AVG(file_size) as avg_file_size
FROM processing_history
GROUP BY DATE(created_at/1000, 'unixepoch'), plan_type;

-- Sample data for testing (remove in production)
-- INSERT OR IGNORE INTO system_health (service_name, status, response_time_ms) 
-- VALUES 
--     ('cloudflare_workers', 'healthy', 120),
--     ('stripe_api', 'healthy', 200),
--     ('r2_storage', 'healthy', 80),
--     ('d1_database', 'healthy', 15),
--     ('hetzner_server', 'healthy', 150);

-- Clean up old records (run periodically)
-- DELETE FROM usage_analytics WHERE created_at < strftime('%s', 'now', '-30 days') * 1000;
-- DELETE FROM system_health WHERE checked_at < strftime('%s', 'now', '-7 days') * 1000;

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 10000;
PRAGMA temp_store = MEMORY;
