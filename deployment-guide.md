# FWEA-I: Complete Deployment Guide
## Professional Audio Cleaning Platform with AI-Powered Multilingual Profanity Detection

### 🚀 Quick Start

This is a complete, production-ready audio cleaning platform that:
- ✅ Supports 100+ languages for profanity detection
- ✅ Integrates with Cloudflare Workers, R2, KV, D1, and AI
- ✅ Uses RunPod for advanced audio processing
- ✅ Includes Stripe payments with subscription management
- ✅ Features responsive UI optimized for Wix embedding
- ✅ Provides admin bypass functionality
- ✅ Handles multiple audio formats (MP3, WAV, FLAC, etc.)

---

## 📋 Prerequisites

- Cloudflare account with Workers, R2, KV, D1 access
- Stripe account (test/live)
- GitHub account for version control
- Node.js 18+ and npm
- Wrangler CLI installed globally: `npm install -g wrangler`
- RunPod account (optional, for advanced processing)

---

## 🔧 Step-by-Step Setup

### 1. Repository Setup

```bash
# Clone your repository
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO

# Initialize if starting fresh
npm init -y
npm install wrangler stripe ahocorasick
```

### 2. File Structure

Create the following structure in your repository:

```
your-repo/
├── src/
│   └── worker.js          # Backend worker (use updated-worker.js content)
├── public/
│   └── index.html         # Frontend (use updated-frontend.html content)
├── wrangler.toml          # Config (use wrangler-config.toml content)
├── package.json
├── README.md
└── .github/
    └── workflows/
        └── deploy.yml     # CI/CD pipeline
```

### 3. Cloudflare Setup

#### A. Login to Cloudflare
```bash
wrangler login
```

#### B. Create KV Namespace for Profanity Lists
```bash
# Create the KV namespace
wrangler kv:namespace create "PROFANITY_LISTS"
# Note the ID returned, update it in wrangler.toml

# Create profanity lists
wrangler kv:key put --namespace-id="YOUR_KV_ID" "lists/en.json" '[
  "fuck", "shit", "damn", "hell", "bitch", "ass", "crap", "piss", "bastard", "whore",
  "asshole", "dickhead", "motherfucker", "cocksucker", "prick", "twat", "cunt"
]'

wrangler kv:key put --namespace-id="YOUR_KV_ID" "lists/es.json" '[
  "mierda", "joder", "puta", "cabrón", "coño", "gilipollas", "pendejo", "culero",
  "hijo de puta", "cabron", "puto", "marica", "maricon", "pinche"
]'

wrangler kv:key put --namespace-id="YOUR_KV_ID" "lists/fr.json" '[
  "merde", "putain", "salope", "connard", "enculé", "bordel", "foutre",
  "chiant", "con", "cul", "bite", "couilles", "pédale"
]'

# Add more languages as needed...
```

#### C. Create R2 Bucket for Audio Storage
```bash
# Create R2 bucket
wrangler r2 bucket create fwea-audio-storage

# Set CORS policy (create cors.json file first)
cat > cors.json << 'EOF'
[
  {
    "AllowedOrigins": [
      "https://fwea-i.com",
      "https://www.fwea-i.com",
      "https://editor.wix.com",
      "https://*.wixsite.com",
      "https://*.pages.dev",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["GET", "POST", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "X-Preview-Limit-Ms", "X-Profanity"],
    "MaxAgeSeconds": 3600
  }
]
EOF

wrangler r2 bucket cors put fwea-audio-storage --file cors.json
```

#### D. Create D1 Database
```bash
# Create D1 database
wrangler d1 create fwea-database
# Note the database ID and update wrangler.toml

# Apply schema
cat > schema.sql << 'EOF'
CREATE TABLE user_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    plan_type TEXT NOT NULL,
    stripe_session_id TEXT,
    stripe_subscription_id TEXT,
    email TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    expires_at INTEGER,
    is_active BOOLEAN DEFAULT 1
);

CREATE TABLE processing_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    process_id TEXT UNIQUE NOT NULL,
    original_filename TEXT,
    file_size INTEGER,
    detected_languages TEXT,
    words_removed INTEGER DEFAULT 0,
    processing_time_ms INTEGER,
    plan_type TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL,
    status TEXT DEFAULT 'pending'
);

CREATE TABLE payment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    plan_type TEXT NOT NULL,
    amount INTEGER,
    currency TEXT DEFAULT 'usd',
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER
);

CREATE TABLE usage_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    plan_type TEXT,
    file_size INTEGER,
    user_agent TEXT,
    ip_address TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    plan_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX idx_user_subscriptions_session_id ON user_subscriptions(stripe_session_id);
CREATE INDEX idx_processing_history_user_id ON processing_history(user_id);
CREATE INDEX idx_processing_history_process_id ON processing_history(process_id);
CREATE INDEX idx_payment_transactions_session_id ON payment_transactions(stripe_session_id);
CREATE INDEX idx_usage_analytics_user_id ON usage_analytics(user_id);
CREATE INDEX idx_verification_codes_email ON verification_codes(email);
EOF

wrangler d1 execute fwea-database --file schema.sql
```

### 4. Configure Environment Variables

#### A. Required Secrets (Set these via CLI)
```bash
# Core Stripe configuration (REQUIRED)
wrangler secret put STRIPE_SECRET_KEY
# Enter: sk_test_... or sk_live_...

wrangler secret put STRIPE_WEBHOOK_SECRET
# Enter: whsec_...

# Audio URL signing (REQUIRED - generate random string)
wrangler secret put AUDIO_URL_SECRET
# Enter: a-long-random-string-for-signing-audio-urls-123456789

# Admin bypass token (REQUIRED - generate random string)
wrangler secret put ADMIN_API_TOKEN
# Enter: your-super-secret-admin-token-12345
```

#### B. Optional RunPod Integration
```bash
# RunPod API for advanced processing (OPTIONAL)
wrangler secret put RUNPOD_API_KEY
# Enter: your-runpod-api-key

wrangler secret put RUNPOD_ENDPOINT_ID
# Enter: your-runpod-endpoint-id

wrangler secret put RUNPOD_AUDIO_ENDPOINT
# Enter: your-runpod-audio-processing-endpoint
```

#### C. External Transcription Service (OPTIONAL)
```bash
wrangler secret put TRANSCRIBE_ENDPOINT
# Enter: https://your-external-transcription-service.com

wrangler secret put TRANSCRIBE_TOKEN
# Enter: your-transcription-service-token
```

### 5. Update Configuration Files

#### A. Update wrangler.toml
Replace the IDs in wrangler.toml with your actual resource IDs:
```toml
# Update these with your actual IDs
[[kv_namespaces]]
binding = "PROFANITY_LISTS"
id = "YOUR_ACTUAL_KV_NAMESPACE_ID"

[[d1_databases]]
binding = "DB"
database_name = "fwea-database"
database_id = "YOUR_ACTUAL_D1_DATABASE_ID"

[[r2_buckets]]
binding = "AUDIO_STORAGE"
bucket_name = "fwea-audio-storage"
```

#### B. Update Frontend Configuration
In your HTML file, update the CONFIG object:
```javascript
const CONFIG = {
    API_BASE: 'https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev',
    ADMIN_HEADER: 'your-super-secret-admin-token-12345', // Match your secret
    // ... other config
};
```

#### C. Update Stripe Price IDs
Replace the price IDs in both frontend and backend with your actual Stripe price IDs:
```javascript
STRIPE_PRICE_IDS: {
    single_track: 'price_YOUR_ACTUAL_SINGLE_TRACK_PRICE_ID',
    dj_pro: 'price_YOUR_ACTUAL_DJ_PRO_PRICE_ID',
    studio_elite: 'price_YOUR_ACTUAL_STUDIO_ELITE_PRICE_ID',
    day_pass: 'price_YOUR_ACTUAL_DAY_PASS_PRICE_ID'
}
```

### 6. Stripe Setup

#### A. Create Products and Prices in Stripe Dashboard
1. Go to Stripe Dashboard → Products
2. Create these products with prices:
   - **Single Track**: $4.99 one-time payment
   - **DJ Pro**: $29.99/month subscription
   - **Studio Elite**: $99.99/month subscription
   - **Day Pass**: $9.99 one-time payment

#### B. Configure Webhooks
1. Go to Stripe Dashboard → Webhooks
2. Add endpoint: `https://YOUR_WORKER.workers.dev/webhook`
3. Select events:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `customer.subscription.deleted`
   - `customer.subscription.updated`
4. Copy webhook secret and set as `STRIPE_WEBHOOK_SECRET`

### 7. Deploy the Application

#### A. Test Locally First
```bash
wrangler dev
```
Visit `http://localhost:8787/health` to test

#### B. Deploy to Production
```bash
wrangler deploy
```

#### C. Verify Deployment
```bash
# Test health endpoint
curl https://YOUR_WORKER.workers.dev/health

# Test with admin header
curl -H "X-FWEA-Admin: your-admin-token" https://YOUR_WORKER.workers.dev/debug-env
```

### 8. GitHub Actions CI/CD (Optional)

Create `.github/workflows/deploy.yml`:
```yaml
name: Deploy FWEA-I

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
```

Add secrets in GitHub:
- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID

### 9. Wix Integration

#### A. Embed in Wix
1. In Wix Editor, add an HTML iframe element
2. Set iframe source to your deployed frontend URL
3. Configure responsive settings
4. Test payment flow

#### B. Custom Domain (Optional)
1. Set up custom domain in Cloudflare Workers dashboard
2. Update `FRONTEND_URL` and `WORKER_BASE_URL` in wrangler.toml
3. Update Stripe webhook URL

---

## 🧪 Testing Checklist

### Basic Functionality
- [ ] Health endpoint responds: `/health`
- [ ] Upload page loads correctly
- [ ] File upload works (drag & drop and button)
- [ ] Processing animation shows
- [ ] Preview audio plays
- [ ] Pricing cards display correctly

### Payment Integration
- [ ] Stripe checkout redirects work
- [ ] Payment success/cancel handling
- [ ] Webhook receives events
- [ ] Subscription status updates

### Admin Features
- [ ] Admin bypass works with correct token
- [ ] Debug endpoint accessible: `/debug-env`
- [ ] Admin can process unlimited files

### Error Handling
- [ ] Large file rejection works
- [ ] Invalid file format rejection
- [ ] Network error handling
- [ ] Payment failure handling

---

## 🔧 Troubleshooting Guide

### Common Issues

#### 1. "Storage not configured" Error
**Solution:** Ensure R2 bucket is created and bound correctly in wrangler.toml

#### 2. "Access denied - missing or invalid admin token"
**Solution:** 
- Check `ADMIN_API_TOKEN` secret is set
- Verify token matches in frontend CONFIG.ADMIN_HEADER
- Ensure header is sent as `X-FWEA-Admin`

#### 3. "Missing FRONTEND_URL" Error
**Solution:** Set FRONTEND_URL in wrangler.toml vars section

#### 4. CORS Issues in Wix
**Solution:** 
- Verify CORS configuration in R2 bucket
- Check Origin header handling in worker
- Ensure Wix domain is in allowlist

#### 5. Stripe Webhook Failures
**Solution:**
- Verify webhook URL in Stripe dashboard
- Check webhook secret matches `STRIPE_WEBHOOK_SECRET`
- Ensure correct events are selected

#### 6. Large File Upload Failures
**Solution:**
- Check file size limits per plan
- Verify R2 upload permissions
- Check network timeout settings

#### 7. Audio Processing Fails
**Solution:**
- Verify AI binding is working: `/health`
- Check RunPod configuration if using
- Ensure audio format is supported

### Debug Commands

```bash
# Check worker logs
wrangler tail

# Test specific endpoints
curl -X POST https://YOUR_WORKER.workers.dev/process-audio \
  -H "X-FWEA-Admin: your-token" \
  -F "audio=@test.mp3"

# Check KV data
wrangler kv:key list --namespace-id="YOUR_KV_ID"

# Check D1 data
wrangler d1 execute fwea-database --command "SELECT * FROM user_subscriptions LIMIT 5"

# Test R2 access
wrangler r2 object list fwea-audio-storage
```

### Performance Monitoring

Monitor these metrics in Cloudflare Dashboard:
- Request rate and errors
- CPU time usage (watch for limit)
- Memory usage
- KV operations
- R2 bandwidth
- D1 queries

---

## 🚀 Production Optimizations

### 1. Enable Caching
- Set appropriate cache headers for audio files
- Use Cloudflare Page Rules for static assets

### 2. Optimize Audio Processing
- Use RunPod for heavy processing
- Implement audio chunking for large files
- Add progress callbacks

### 3. Scale Database
- Monitor D1 query performance
- Add indexes for frequently queried fields
- Consider data archiving for old records

### 4. Security Hardening
- Rotate admin tokens regularly
- Monitor for abuse patterns
- Implement rate limiting

### 5. Analytics Integration
- Add Google Analytics to frontend
- Set up Cloudflare Analytics
- Monitor conversion rates

---

## 📞 Support and Maintenance

### Regular Tasks
- Monitor error rates and fix issues
- Update profanity lists with new words
- Review and optimize database queries
- Update dependencies and security patches

### Scaling Considerations
- Monitor usage patterns
- Plan for increased file sizes
- Consider CDN for global performance
- Implement automated backups

---

## 📄 License and Legal

Ensure compliance with:
- Audio processing regulations in your jurisdiction
- Data privacy laws (GDPR, CCPA)
- Content moderation requirements
- Stripe terms of service

---

## 🎯 Success Metrics

Track these KPIs:
- File processing success rate
- Payment conversion rate
- User retention rate
- Average processing time
- Customer satisfaction scores

---

**🎉 Congratulations! Your FWEA-I platform is now ready for production use.**

For additional support or custom modifications, refer to the code comments and Cloudflare documentation.