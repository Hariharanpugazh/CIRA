// ============================================================
// Secret/API Key Detection Patterns — Privacy-First Chrome Extension
// ============================================================
//
// RESEARCH SUMMARY:
//
// Existing Tools Landscape:
// 1. GitHub Secret Scanning — free for public repos, scans entire Git history.
//    Uses partner validation + generic high-entropy detection. Most comprehensive
//    partner list (200+ providers). Cannot be used client-side in extensions.
//
// 2. gitleaks (OSS, Go) — ~150 provider-specific rules in TOML config.
//    Uses keyword proximity matching (looks for provider keywords within 50 chars
//    of a high-entropy string). The gold standard for OSS secret scanning.
//    Uses "stopwords" lists and allowlists to suppress false positives.
//
// 3. detect-secrets (Yelp, Python) — Uses Shannon entropy with capping groups
//    for hex/base64. Heavy on false positives, requires baseline scanning.
//    Not ideal for real-time browser scanning.
//
// 4. truffleHog — Uses regex + entropy, checks validity via API calls.
//    Too heavy for a browser extension context.
//
// 5. secrets-patterns-db (mazen160) — ~1600 patterns, many overly broad.
//    Sourced from gitleaks, truffleHog, and manual research.
//    Good reference but high false positive rate without allowlists.
//
// Relay OSS (RelayCorp) — NOT open source's secret detection. Relay uses
// Awala protocol for censorship-resistant messaging, not secret scanning.
// The name is overloaded. No relevant secret detection code exists there.
//
// BEST PRACTICES for Browser Extension:
// - Auto-redact is DANGEROUS — can break application logic, miss secrets
//   split across messages, and gives false sense of security.
// - WARNING with highlights is the RECOMMENDED pattern for a privacy tool.
//   Show an inline warning badge, let user review and take action.
// - NEVER send detected secrets to any server for "validation."
//   All detection must happen 100% locally.
// - Use word-boundary-anchored patterns to minimize false positives.
// - Run detection BEFORE the user pastes/sends, as a "pre-flight check."
//
// EDGE CASES:
// - base64-encoded secrets: Detectable via Shannon entropy of the base64
//   charset over strings >20 chars. High FP without context keywords.
// - Secrets split across messages: Extremely hard to detect. Best effort
//   is checking if a partial key prefix appears at message boundaries.
// - Environment variable formats: VAR=val, export VAR=val, \${VAR},
//   secrets in .env format.
//
// ============================================================
// PATTERN SET ORGANIZED BY TYPE WITH DETECTION RATES & FP NOTES
// ============================================================
//
// Name                          | Detection Rate | False Positive Risk | Notes
// ------------------------------|---------------|---------------------|------
// OpenAI API Key                | Very High     | Low                 | `sk-proj-` + `sk-svcacct-` variants exist
// Anthropic API Key             | Very High     | Very Low            | 108 char, structured prefix
// AWS Access Key (AKIA/ASIA)    | Very High     | Low                 | Allowlist "EXAMPLE" suffix
// GitHub PAT (ghp_)             | High          | Very Low            | 40 char alphanumeric
// Google API Key                | High          | Medium              | Many documented test keys in repos
// Stripe Keys                   | Very High     | Low                 | Distinctive prefix
// JWT Tokens                    | Medium        | High                | 3-part base64 structure; many non-secret JWTs
// Private SSH Keys              | Very High     | Very Low            | PEM header detection is near-zero FP
// Database Connection Strings   | Medium        | Medium-High         | Many non-secret JDBC/connection URIs
// Slack Tokens                  | High          | Low                 | Multiple token formats
// Hugging Face Tokens           | High          | Very Low            | Clear `hf_` prefix
// Generic High-Entropy Strings  | Medium        | High                | Needs entropy threshold tuning

export interface DetectedSecret {
  type: string;
  value: string;
  startIndex: number;
  endIndex: number;
  confidence: 'high' | 'medium' | 'low';
  redactedPreview: string;
}

interface SecretRule {
  type: string;
  pattern: RegExp;
  confidence: 'high' | 'medium' | 'low';
  description: string;
}

// ============================================================
// COMPREHENSIVE SECRET DETECTION RULES
// Optimized for: low FP, browser extension performance, g flag
// ============================================================

const SECRET_RULES: SecretRule[] = [

  // ── AI/ML Platform Keys ──────────────────────────────────

  {
    type: 'OpenAI API Key',
    pattern: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,})[\s"'`;]|$/g,
    confidence: 'high',
    description: 'OpenAI project, service account, admin, and standard keys',
  },
  {
    type: 'Anthropic API Key',
    pattern: /\b(sk-ant-api03-[A-Za-z0-9_-]{93}AA)/g,
    confidence: 'high',
    description: 'Anthropic API key (api03 version)',
  },
  {
    type: 'Anthropic Admin Key',
    pattern: /\b(sk-ant-admin01-[A-Za-z0-9_-]{93}AA)/g,
    confidence: 'high',
    description: 'Anthropic admin API key',
  },
  {
    type: 'Hugging Face Token',
    pattern: /\b(hf_[A-Za-z]{2}[A-Za-z0-9]{32})\b/g,
    confidence: 'high',
    description: 'Hugging Face user or API token',
  },
  {
    type: 'Cohere API Key',
    pattern: /\b([A-Za-z0-9]{40})/g,
    confidence: 'low',
    description: 'Cohere API key — relies on keyword proximity',
  },
  {
    type: 'OpenRouter API Key',
    pattern: /\b(sk-or-v1-[A-Za-z0-9]{70,})\b/g,
    confidence: 'high',
    description: 'OpenRouter API key',
  },
  {
    type: 'Replicate API Key',
    pattern: /\b(r8_[A-Za-z0-9]{34})\b/g,
    confidence: 'high',
    description: 'Replicate API token',
  },
  {
    type: 'Azure OpenAI Key',
    pattern: /\b([A-Za-z0-9]{32})/g,
    confidence: 'low',
    description: 'Azure OpenAI — 32-char hex; use keyword proximity',
  },

  // ── Cloud Provider Keys ──────────────────────────────────

  {
    type: 'AWS Access Key',
    pattern: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
    confidence: 'high',
    description: 'AWS IAM access key ID (not the secret, but indicative)',
  },
  {
    type: 'AWS Secret Key',
    pattern: /\b((?:aws|AWS)_?(?:secret|SECRET)_?(?:access|ACCESS)_?(?:key|KEY)[\s:=]+['"]?([A-Za-z0-9/+]{40})['"]?)/g,
    confidence: 'high',
    description: 'AWS secret access key in config context',
  },
  {
    type: 'GCP API Key',
    pattern: /\b(AIza[A-Za-z0-9_-]{35})(?:[^A-Za-z0-9_-]|$)/g,
    confidence: 'high',
    description: 'Google Cloud Platform API key',
  },
  {
    type: 'Google OAuth Token',
    pattern: /\b(ya29\.[A-Za-z0-9_-]+)\b/g,
    confidence: 'medium',
    description: 'Google OAuth 2.0 access token (short-lived but sensitive)',
  },
  {
    type: 'GCP Service Account',
    pattern: /"type"\s*:\s*"service_account"/g,
    confidence: 'high',
    description: 'GCP service account key JSON marker',
  },
  {
    type: 'Azure AD Secret',
    pattern: /\b([A-Za-z0-9_~]{3}\dQ~[A-Za-z0-9_~.-]{31,34})\b/g,
    confidence: 'high',
    description: 'Azure AD app client secret (distinctive Q~ pattern)',
  },
  {
    type: 'Azure Storage Key',
    pattern: /\b(DefaultEndpointsProtocol=https;AccountName=[A-Za-z0-9]+;AccountKey=[A-Za-z0-9+/=]+)/g,
    confidence: 'high',
    description: 'Azure storage account connection string',
  },
  {
    type: 'Alibaba Access Key',
    pattern: /\b(LTAI[A-Za-z0-9]{20})\b/g,
    confidence: 'high',
    description: 'Alibaba Cloud access key ID',
  },
  {
    type: 'DigitalOcean PAT',
    pattern: /\b(dop_v1_[a-f0-9]{64})\b/g,
    confidence: 'high',
    description: 'DigitalOcean personal access token',
  },
  {
    type: 'DigitalOcean OAuth',
    pattern: /\b(doo_v1_[a-f0-9]{64})\b/g,
    confidence: 'high',
    description: 'DigitalOcean OAuth access token',
  },

  // ── Git Platform Tokens ──────────────────────────────────

  {
    type: 'GitHub Personal Access Token',
    pattern: /\b(ghp_[A-Za-z0-9]{36})\b/g,
    confidence: 'high',
    description: 'GitHub classic PAT',
  },
  {
    type: 'GitHub Fine-Grained Token',
    pattern: /\b(github_pat_[A-Za-z0-9_]{50,})\b/g,
    confidence: 'high',
    description: 'GitHub fine-grained PAT (newer format)',
  },
  {
    type: 'GitHub OAuth Token',
    pattern: /\b(gho_[A-Za-z0-9]{36})\b/g,
    confidence: 'high',
    description: 'GitHub OAuth access token',
  },
  {
    type: 'GitHub App Token',
    pattern: /\b(ghu_[A-Za-z0-9]{36})\b/g,
    confidence: 'high',
    description: 'GitHub App user-to-server token',
  },
  {
    type: 'GitHub Server Token',
    pattern: /\b(ghs_[A-Za-z0-9]{36})\b/g,
    confidence: 'high',
    description: 'GitHub App server-to-server token',
  },
  {
    type: 'GitHub Refresh Token',
    pattern: /\b(ghr_[A-Za-z0-9]{76})\b/g,
    confidence: 'high',
    description: 'GitHub OAuth refresh token',
  },
  {
    type: 'GitLab Personal Token',
    pattern: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g,
    confidence: 'high',
    description: 'GitLab personal access token (v2 format)',
  },
  {
    type: 'GitLab Runner Token',
    pattern: /\b(glrt-[A-Za-z0-9_-]{20,})\b/g,
    confidence: 'high',
    description: 'GitLab runner registration token',
  },
  {
    type: 'Bitbucket App Password',
    pattern: /\b(ATATT3[A-Za-z0-9_\-=]{186})\b/g,
    confidence: 'high',
    description: 'Atlassian/Bitbucket app password',
  },

  // ── Payment Provider Keys ────────────────────────────────

  {
    type: 'Stripe Live Key',
    pattern: /\b(sk_live_[A-Za-z0-9]{24,99})\b/g,
    confidence: 'high',
    description: 'Stripe live secret key',
  },
  {
    type: 'Stripe Test Key',
    pattern: /\b(sk_test_[A-Za-z0-9]{24,99})\b/g,
    confidence: 'medium',
    description: 'Stripe test secret key (lower risk but still sensitive)',
  },
  {
    type: 'Stripe Publishable Key',
    pattern: /\b(pk_(?:live|test)_[A-Za-z0-9]{24,99})\b/g,
    confidence: 'low',
    description: 'Stripe publishable key (public but indicates payment context)',
  },
  {
    type: 'Stripe Webhook Secret',
    pattern: /\b(whsec_[A-Za-z0-9]{32})\b/g,
    confidence: 'high',
    description: 'Stripe webhook signing secret',
  },
  {
    type: 'Stripe Restricted Key',
    pattern: /\b(rk_live_[A-Za-z0-9]{24,99})\b/g,
    confidence: 'high',
    description: 'Stripe restricted key',
  },
  {
    type: 'PayPal Braintree Token',
    pattern: /\b(access_token\$production\$[0-9a-z]{16}\$[0-9a-f]{32})\b/g,
    confidence: 'high',
    description: 'PayPal Braintree production access token',
  },

  // ── Messaging & Collaboration ────────────────────────────

  {
    type: 'Slack Bot Token',
    pattern: /\b(xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+)\b/g,
    confidence: 'high',
    description: 'Slack bot user OAuth token',
  },
  {
    type: 'Slack User Token',
    pattern: /\b(xoxp-[0-9]+-[0-9]+-[0-9]+-[A-Za-z0-9]+)\b/g,
    confidence: 'high',
    description: 'Slack user OAuth token',
  },
  {
    type: 'Slack App Token',
    pattern: /\b(xapp-[0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+)\b/g,
    confidence: 'high',
    description: 'Slack app-level token',
  },
  {
    type: 'Slack Webhook URL',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
    confidence: 'high',
    description: 'Slack incoming webhook URL',
  },
  {
    type: 'Discord Bot Token',
    pattern: /\b([MN][A-Za-z0-9]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})\b/g,
    confidence: 'high',
    description: 'Discord bot token (3-part JWT-like structure)',
  },
  {
    type: 'Discord Webhook URL',
    pattern: /https:\/\/discord\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
    confidence: 'high',
    description: 'Discord webhook URL',
  },
  {
    type: 'Telegram Bot Token',
    pattern: /\b([0-9]+:AA[A-Za-z0-9_-]{33})\b/g,
    confidence: 'high',
    description: 'Telegram bot token',
  },

  // ── JWT / Authentication Tokens ──────────────────────────

  {
    type: 'JWT Token',
    pattern: /\b(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
    confidence: 'medium',
    description: 'JSON Web Token (3-part base64url encoded); many non-secret uses',
  },
  {
    type: 'Generic Bearer Token',
    pattern: /\b(Bearer\s+)([A-Za-z0-9_\-\.=+/]{20,})\b/gi,
    confidence: 'medium',
    description: 'Authorization Bearer token in header context',
  },
  {
    type: 'Basic Auth Header',
    pattern: /\b(Basic\s+)([A-Za-z0-9+/]{20,}={0,2})\b/gi,
    confidence: 'medium',
    description: 'HTTP Basic auth base64 credentials',
  },
  {
    type: 'Generic API Key Header',
    pattern: /\b([Xx]-(?:[Aa]pi-?)?(?:[Kk]ey|[Tt]oken)|[Aa]pi-?[Kk]ey)\s*:\s*([A-Za-z0-9_\-.=+/]{16,})\b/g,
    confidence: 'low',
    description: 'Generic API key in HTTP header format',
  },

  // ── Database & Connection Strings ────────────────────────

  {
    type: 'MongoDB Connection',
    pattern: /\b(mongodb(?:\+srv)?:\/\/[^\s'"]+)/g,
    confidence: 'high',
    description: 'MongoDB connection string (often contains credentials)',
  },
  {
    type: 'PostgreSQL Connection',
    pattern: /\b(postgres(?:ql)?:\/\/[^\s'"]+)/g,
    confidence: 'high',
    description: 'PostgreSQL connection string',
  },
  {
    type: 'MySQL Connection',
    pattern: /\b(mysql:\/\/[^\s'"]+)/g,
    confidence: 'high',
    description: 'MySQL connection string',
  },
  {
    type: 'Redis Connection',
    pattern: /\b(redis:\/\/[^\s'"]+)/g,
    confidence: 'high',
    description: 'Redis connection string (may contain password)',
  },
  {
    type: 'JDBC Connection',
    pattern: /\b(jdbc:(?:mysql|postgresql|sqlserver|oracle|mariadb):\/\/[^\s'"]+)/g,
    confidence: 'high',
    description: 'JDBC database connection string',
  },
  {
    type: 'Database Password',
    pattern: /\b(?:(?:DB|DATABASE)_PASSWORD|DB_PASS|DBPASS)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
    confidence: 'high',
    description: 'Database password in environment variable format',
  },

  // ── Private Keys ─────────────────────────────────────────

  {
    type: 'SSH Private Key',
    pattern: /-----BEGIN (?:OPENSSH|RSA|DSA|EC|PGP) PRIVATE KEY(?: BLOCK)?-----/g,
    confidence: 'high',
    description: 'SSH / asymmetric private key PEM header',
  },
  {
    type: 'Encrypted Private Key',
    pattern: /-----BEGIN ENCRYPTED PRIVATE KEY-----/g,
    confidence: 'high',
    description: 'Encrypted private key (PEM)',
  },
  {
    type: 'Age Secret Key',
    pattern: /\b(AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58})\b/g,
    confidence: 'high',
    description: 'Age encryption secret key',
  },

  // ── Third-Party Service Keys ─────────────────────────────

  {
    type: 'SendGrid API Key',
    pattern: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g,
    confidence: 'high',
    description: 'SendGrid API key',
  },
  {
    type: 'Mailgun API Key',
    pattern: /\b(key-[A-Za-z0-9]{32})\b/g,
    confidence: 'medium',
    description: 'Mailgun API key',
  },
  {
    type: 'Twilio Account SID',
    pattern: /\b(AC[A-Za-z0-9]{32})\b/g,
    confidence: 'high',
    description: 'Twilio account SID',
  },
  {
    type: 'Twilio Auth Token',
    pattern: /\b(TWILIO_AUTH_TOKEN\s*[:=]\s*['"]?([A-Za-z0-9]{32})['"]?)/gi,
    confidence: 'high',
    description: 'Twilio auth token in config context',
  },
  {
    type: 'Heroku API Key',
    pattern: /\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/g,
    confidence: 'low',
    description: 'Heroku API key (UUID format, very high FP alone; use keyword proximity)',
  },
  {
    type: 'Datadog API Key',
    pattern: /\b([a-f0-9]{32})\b/g,
    confidence: 'low',
    description: 'Datadog app key format — use keyword proximity',
  },
  {
    type: 'Datadog App Key',
    pattern: /\b([a-f0-9]{40})\b/g,
    confidence: 'low',
    description: 'Datadog app key format — use keyword proximity',
  },
  {
    type: '1Password Secret Key',
    pattern: /\b(A3-[A-Z0-9]{6}-(?:[A-Z0-9]{11}|[A-Z0-9]{6}-[A-Z0-9]{5})-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5})\b/g,
    confidence: 'high',
    description: '1Password secret key',
  },
  {
    type: '1Password Service Token',
    pattern: /\b(ops_eyJ[A-Za-z0-9+/]{250,}={0,3})\b/g,
    confidence: 'high',
    description: '1Password service account token',
  },
  {
    type: 'npm Access Token',
    pattern: /\b(npm_[A-Za-z0-9]{36})\b/g,
    confidence: 'high',
    description: 'npm registry access token',
  },
  {
    type: 'PyPI Token',
    pattern: /\b(pypi-AgEI[A-Za-z0-9_\-]{50,})\b/g,
    confidence: 'high',
    description: 'PyPI upload token',
  },
  {
    type: 'Docker Hub Token',
    pattern: /\b(dckr_pat_[A-Za-z0-9_-]{27,})\b/g,
    confidence: 'high',
    description: 'Docker Hub personal access token',
  },
  {
    type: 'Cloudflare API Token',
    pattern: /\b([A-Za-z0-9_-]{40})\b/g,
    confidence: 'low',
    description: 'Cloudflare API token — use keyword proximity',
  },
  {
    type: 'Cloudflare Global Key',
    pattern: /\b([a-f0-9]{37})\b/g,
    confidence: 'low',
    description: 'Cloudflare global API key — use keyword proximity',
  },
  {
    type: 'Cloudflare CA Key',
    pattern: /\b(v1\.0-[a-f0-9]{24}-[a-f0-9]{146})\b/g,
    confidence: 'high',
    description: 'Cloudflare Origin CA key',
  },
  {
    type: 'Vercel Token',
    pattern: /\b([A-Za-z0-9]{24})\b/g,
    confidence: 'low',
    description: 'Vercel token — use keyword proximity',
  },
  {
    type: 'Netlify PAT',
    pattern: /\b(nfp_[A-Za-z0-9]{36})\b/g,
    confidence: 'high',
    description: 'Netlify personal access token',
  },
  {
    type: 'Contentful Delivery Token',
    pattern: /\b([A-Za-z0-9_-]{43})\b/g,
    confidence: 'low',
    description: 'Contentful token — use keyword proximity',
  },
  {
    type: 'Mapbox Token',
    pattern: /\b(pk\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
    confidence: 'medium',
    description: 'Mapbox access token (public but scoped)',
  },
  {
    type: 'Supabase Key',
    pattern: /\b(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})\b/g,
    confidence: 'medium',
    description: 'Supabase JWT key (anon is public, service_role is secret)',
  },

  // ── Environment Variable Secrets ─────────────────────────

  {
    type: 'Env Variable Secret',
    pattern: /\b(?:(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIALS?|AUTH)\s*[:=]\s*['"]?([^\s'"]{12,})['"]?)/gi,
    confidence: 'medium',
    description: 'Generic secret in env var format (SECRET=value); moderate FP on config files',
  },
  {
    type: '.env File Pattern',
    pattern: /^[A-Z_][A-Z0-9_]{2,}\s*=\s*.+/gm,
    confidence: 'low',
    description: 'Full .env file lines (very broad, use as supplementary)',
  },
];

// ============================================================
// PROXIMITY KEYWORD MAP
// Maps keywords that, when found near a high-entropy string,
// increase confidence for generic patterns
// ============================================================

const PROXIMITY_KEYWORDS: Record<string, string[]> = {
  'Heroku API Key': ['heroku', 'HEROKU'],
  'Datadog API Key': ['datadog', 'DATADOG', 'DD_API_KEY'],
  'Datadog App Key': ['datadog', 'DATADOG', 'DD_APP_KEY', 'DD_APPLICATION_KEY'],
  'Cloudflare API Token': ['cloudflare', 'CF_API_TOKEN', 'CLOUDFLARE'],
  'Cloudflare Global Key': ['cloudflare', 'CF_API_KEY', 'X-Auth-Key'],
  'Cohere API Key': ['cohere', 'CO_API_KEY', 'COHERE'],
  'Azure OpenAI Key': ['azure', 'openai', 'AZURE_OPENAI', 'cognitive'],
  'Vercel Token': ['vercel', 'ZE_TOKEN', 'VERCEL_TOKEN'],
  'Contentful Delivery Token': ['contentful', 'CONTENTFUL'],
};

// ============================================================
// FALSE POSITIVE ALLOWLIST
// Patterns that should NEVER be flagged
// ============================================================

const ALLOWLIST_PATTERNS: RegExp[] = [
  // Documented test/demo keys
  /\bAIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456\b/,
  /sk-proj-0{32,}/,
  /ghp_0{36}/,
  /00000000000000000000000000000000/,
  // Example/placeholder patterns
  /<[^>]+>/,
  /sk-test-/,
  /\{[^}]+\}/,
  /your[-_]?(?:api[-_]?)?(?:key|token|secret)/i,
  /change(?:it|me)/i,
  /REPLACE(?:[-_]?ME)?/i,
  /example/i,
  /placeholder/i,
  // SHA hashes, digests
  /\b[0-9a-f]{40}\b/i,
  // UUID-like strings that contain non-hex characters
  /\b[0-9a-f]{8}\b/i,
  // Domain names
  /\b[\w.-]+\.(?:com|org|net|io|dev|app|ai)\b/i,
  // File paths
  /\/(?:usr|home|var|etc|tmp|opt|bin)\/[\w./-]+/,
  // Common build artifacts
  /\b(?:node_modules|vendor|dist|build|\.next)\b/,
];

// ============================================================
// SHANNON ENTROPY CALCULATOR
// Used for detecting high-entropy base64/base32 strings
// that don't match known patterns
// ============================================================

function calculateShannonEntropy(str: string): number {
  const len = str.length;
  if (len === 0) return 0;

  const charCounts = new Map<string, number>();
  for (const char of str) {
    charCounts.set(char, (charCounts.get(char) || 0) + 1);
  }

  let entropy = 0;
  for (const count of charCounts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

// ============================================================
// BASE64 HIGH-ENTROPY DETECTOR
// ============================================================

function detectBase64Secret(text: string): DetectedSecret[] {
  const results: DetectedSecret[] = [];
  const patterns = [
    // Standard base64 (no padding) > 30 chars
    /\b([A-Za-z0-9+/]{30,}={0,3})\b/g,
    // URL-safe base64 > 30 chars
    /\b([A-Za-z0-9_-]{30,})\b/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = match[1];
      // Skip if already matched by a typed rule
      if (results.some(r => r.startIndex <= match!.index && r.endIndex >= pattern.lastIndex)) {
        continue;
      }

      // Entropy check: base64 charset entropy for a random 30-char string should be > 4.5
      const entropy = calculateShannonEntropy(candidate);
      if (entropy < 4.5) continue;

      // Skip if it looks like a base64 of non-random data (repeating patterns)
      if (/(.)\1{6,}/.test(candidate)) continue;

      // Skip if purely numeric or lowercase hex
      if (/^[0-9a-f]+$/.test(candidate)) continue;

      results.push({
        type: 'High-Entropy Base64 String',
        value: candidate,
        startIndex: match.index,
        endIndex: match.index + candidate.length,
        confidence: 'low',
        redactedPreview: `${candidate.slice(0, 4)}...${candidate.slice(-4)}`,
      });
    }
  }

  return results;
}

// ============================================================
// MAIN SCANNER
// ============================================================

export function scanForSecrets(text: string): DetectedSecret[] {
  const results: DetectedSecret[] = [];

  for (const rule of SECRET_RULES) {
    // Reset lastIndex for regexes with g flag
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      const value = match[1] || match[0];

      // Skip allowlisted patterns
      if (ALLOWLIST_PATTERNS.some(p => p.test(value))) {
        continue;
      }

      // For low-confidence patterns, check proximity keywords
      let confidence = rule.confidence;
      if (confidence === 'low' && PROXIMITY_KEYWORDS[rule.type]) {
        const contextStart = Math.max(0, match.index - 60);
        const contextEnd = Math.min(text.length, match.index + value.length + 60);
        const context = text.slice(contextStart, contextEnd);
        if (PROXIMITY_KEYWORDS[rule.type].some(kw => context.includes(kw))) {
          confidence = 'medium';
        }
      }

      results.push({
        type: rule.type,
        value,
        startIndex: match.index,
        endIndex: match.index + value.length,
        confidence,
        redactedPreview: `${value.slice(0, 4)}...${value.slice(-4)}`,
      });
    }
  }

  // Merge overlapping results (prefer higher confidence and specific rules)
  const merged = mergeOverlappingSecrets(results);

  // Add base64 entropy-only results for remaining undetected areas
  const base64Results = detectBase64Secret(text);
  const filteredBase64 = base64Results.filter(b64 =>
    !merged.some(m => m.startIndex <= b64.startIndex && m.endIndex >= b64.endIndex),
  );

  return [...merged, ...filteredBase64].sort((a, b) => a.startIndex - b.startIndex);
}

// ============================================================
// OVERLAP RESOLVER
// Prefers high-confidence, more specific matches
// ============================================================

function mergeOverlappingSecrets(secrets: DetectedSecret[]): DetectedSecret[] {
  if (secrets.length <= 1) return secrets;

  const sorted = [...secrets].sort((a, b) => a.startIndex - b.startIndex);
  const merged: DetectedSecret[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.startIndex <= current.endIndex) {
      // Overlap — prefer higher confidence; if equal, prefer specific (not generic)
      const currentIsGeneric = current.type.startsWith('High-Entropy') || current.type.includes('Generic');
      const nextIsGeneric = next.type.startsWith('High-Entropy') || next.type.includes('Generic');

      if (
        (next.confidence === 'high' && current.confidence !== 'high') ||
        (!nextIsGeneric && currentIsGeneric) ||
        next.endIndex > current.endIndex
      ) {
        current = next;
      }
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  return merged;
}

// ============================================================
// REDACTION UTILITY
// Replaces detected secrets with [REDACTED] tokens
// ============================================================

export function redactSecrets(text: string, secrets: DetectedSecret[]): string {
  let redacted = text;
  // Process in reverse to preserve indices
  for (const secret of [...secrets].sort((a, b) => b.startIndex - a.startIndex)) {
    const before = redacted.slice(0, secret.startIndex);
    const after = redacted.slice(secret.endIndex);
    redacted = `${before}[${secret.type}: REDACTED]${after}`;
  }
  return redacted;
}

// ============================================================
// WARNING GENERATOR
// Returns user-friendly warning messages
// ============================================================

export function generateWarnings(secrets: DetectedSecret[]): string[] {
  if (secrets.length === 0) return [];

  const highConfidence = secrets.filter(s => s.confidence === 'high');
  const mediumConfidence = secrets.filter(s => s.confidence === 'medium');

  const warnings: string[] = [];

  if (highConfidence.length > 0) {
    const types = [...new Set(highConfidence.map(s => s.type))];
    warnings.push(
      `HIGH RISK: ${highConfidence.length} potential secret(s) detected: ${types.join(', ')}. ` +
      'These should NOT be shared between AI platforms. Remove them before transferring.',
    );
  }

  if (mediumConfidence.length > 0) {
    const types = [...new Set(mediumConfidence.map(s => s.type))];
    warnings.push(
      `WARNING: ${mediumConfidence.length} possible secret(s) detected: ${types.join(', ')}. ` +
      'Review these before sending.',
    );
  }

  return warnings;
}

// ============================================================
// SUMMARY STATISTICS
// ============================================================

export function getScanSummary(secrets: DetectedSecret[]): {
  total: number;
  highRisk: number;
  mediumRisk: number;
  lowRisk: number;
  categories: Record<string, number>;
} {
  const categories: Record<string, number> = {};
  for (const s of secrets) {
    categories[s.type] = (categories[s.type] || 0) + 1;
  }

  return {
    total: secrets.length,
    highRisk: secrets.filter(s => s.confidence === 'high').length,
    mediumRisk: secrets.filter(s => s.confidence === 'medium').length,
    lowRisk: secrets.filter(s => s.confidence === 'low').length,
    categories,
  };
}
