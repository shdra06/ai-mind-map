/**
 * AI Mind Map — Security Check Engine
 *
 * Full-stack security scanner for public GitHub repos:
 * 1. Fetches repository tree via GitHub API
 * 2. Scans code files for 60+ secret/credential patterns
 * 3. Parses dependency manifests (package.json, requirements.txt, go.mod, etc.)
 * 4. Queries Google OSV.dev for known vulnerabilities
 * 5. Calculates security grade (A–F)
 * 6. Renders interactive results with grouped findings
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════
     1. SECRET PATTERNS
     ═══════════════════════════════════════════════════════════════ */

  const SECRET_PATTERNS = [
    // ── Cloud Providers (Critical) ──────────────────────────────
    { name: 'AWS Access Key',           regex: /AKIA[0-9A-Z]{16}/,                                                                                   severity: 'critical', description: 'AWS IAM Access Key ID' },
    { name: 'AWS Secret Key',           regex: /(?:aws)?_?(?:secret)?_?(?:access)?_?key["'\s]*[:=]\s*["'][A-Za-z0-9/+=]{40}["']/i,                    severity: 'critical', description: 'AWS Secret Access Key' },
    { name: 'AWS MWS Key',              regex: /amzn\.mws\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,                            severity: 'critical', description: 'Amazon MWS Auth Token' },
    { name: 'AWS Session Token',        regex: /(?:aws.?session|session.?token)["'\s]*[:=]\s*["'][A-Za-z0-9/+=]{100,}["']/i,                          severity: 'critical', description: 'AWS temporary session token' },
    { name: 'Google API Key',           regex: /AIza[0-9A-Za-z_-]{35}/,                                                                              severity: 'critical', description: 'Google Cloud / Maps / Firebase API Key' },
    { name: 'Google OAuth Client',      regex: /[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com/,                                              severity: 'high',     description: 'Google OAuth 2.0 Client ID' },
    { name: 'Google Service Account',   regex: /"type":\s*"service_account"/,                                                                        severity: 'critical', description: 'GCP Service Account JSON key file' },
    { name: 'Google OAuth Secret',      regex: /(?:client_secret|google.?secret)["'\s]*[:=]\s*["'][A-Za-z0-9_-]{24}["']/i,                            severity: 'critical', description: 'Google OAuth client secret' },
    { name: 'Azure Storage Key',        regex: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{40,}/,                     severity: 'critical', description: 'Azure Storage connection string with key' },
    { name: 'Azure SAS Token',          regex: /[?&]sig=[A-Za-z0-9%+/=]{40,}/,                                                                       severity: 'high',     description: 'Azure Shared Access Signature token' },
    { name: 'Azure AD Client Secret',   regex: /(?:azure|ad).?(?:client)?_?secret["'\s]*[:=]\s*["'][A-Za-z0-9_~.-]{30,}["']/i,                        severity: 'critical', description: 'Azure Active Directory client secret' },
    { name: 'DigitalOcean Token',       regex: /dop_v1_[a-f0-9]{64}/,                                                                                severity: 'critical', description: 'DigitalOcean personal access token' },
    { name: 'DigitalOcean OAuth',       regex: /doo_v1_[a-f0-9]{64}/,                                                                                severity: 'critical', description: 'DigitalOcean OAuth token' },
    { name: 'DigitalOcean Refresh',     regex: /dor_v1_[a-f0-9]{64}/,                                                                                severity: 'critical', description: 'DigitalOcean refresh token' },
    { name: 'Alibaba Cloud Access Key', regex: /LTAI[A-Za-z0-9]{12,20}/,                                                                             severity: 'critical', description: 'Alibaba Cloud Access Key ID' },
    { name: 'IBM Cloud API Key',        regex: /(?:ibm|bluemix).?api.?key["'\s]*[:=]\s*["'][A-Za-z0-9_-]{40,}["']/i,                                  severity: 'critical', description: 'IBM Cloud / Bluemix API key' },

    // ── Payment (Critical) ──────────────────────────────────────
    { name: 'Stripe Live Secret Key',   regex: /sk_live_[a-zA-Z0-9]{24,}/,                                                                           severity: 'critical', description: 'Stripe live-mode secret API key' },
    { name: 'Stripe Publishable Key',   regex: /pk_live_[a-zA-Z0-9]{24,}/,                                                                           severity: 'medium',   description: 'Stripe publishable key (less risky but still exposable)' },
    { name: 'Stripe Test Secret Key',   regex: /sk_test_[a-zA-Z0-9]{24,}/,                                                                           severity: 'medium',   description: 'Stripe test-mode secret key' },
    { name: 'Stripe Restricted Key',    regex: /rk_live_[a-zA-Z0-9]{24,}/,                                                                           severity: 'critical', description: 'Stripe restricted API key (live)' },
    { name: 'Stripe Webhook Secret',    regex: /whsec_[a-zA-Z0-9]{24,}/,                                                                             severity: 'high',     description: 'Stripe webhook signing secret' },
    { name: 'PayPal Client ID',         regex: /paypal.*client[_-]?id["'\s]*[:=]\s*["']A[A-Za-z0-9_-]{30,}["']/i,                                     severity: 'critical', description: 'PayPal REST API client ID' },
    { name: 'Square Access Token',      regex: /sq0atp-[A-Za-z0-9_-]{22}/,                                                                           severity: 'critical', description: 'Square production access token' },
    { name: 'Square OAuth Secret',      regex: /sq0csp-[A-Za-z0-9_-]{43}/,                                                                           severity: 'critical', description: 'Square OAuth secret' },
    { name: 'Braintree Access Token',   regex: /access_token\$production\$[0-9a-z]{16}\$[0-9a-f]{32}/,                                               severity: 'critical', description: 'Braintree production access token' },

    // ── Version Control (Critical) ──────────────────────────────
    { name: 'GitHub Personal Token',    regex: /ghp_[a-zA-Z0-9]{36}/,                                                                                severity: 'critical', description: 'GitHub personal access token (classic)' },
    { name: 'GitHub OAuth Token',       regex: /gho_[a-zA-Z0-9]{36}/,                                                                                severity: 'critical', description: 'GitHub OAuth access token' },
    { name: 'GitHub User Token',        regex: /ghu_[a-zA-Z0-9]{36}/,                                                                                severity: 'critical', description: 'GitHub user-to-server token' },
    { name: 'GitHub Server Token',      regex: /ghs_[a-zA-Z0-9]{36}/,                                                                                severity: 'critical', description: 'GitHub server-to-server token' },
    { name: 'GitHub App Refresh',       regex: /ghr_[a-zA-Z0-9]{36}/,                                                                                severity: 'critical', description: 'GitHub App refresh token' },
    { name: 'GitHub Fine-Grained',      regex: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/,                                                         severity: 'critical', description: 'GitHub fine-grained personal access token' },
    { name: 'GitLab Token',             regex: /glpat-[a-zA-Z0-9_-]{20,}/,                                                                           severity: 'critical', description: 'GitLab personal access token' },
    { name: 'GitLab Pipeline Token',    regex: /glptt-[a-zA-Z0-9_-]{20,}/,                                                                           severity: 'high',     description: 'GitLab pipeline trigger token' },
    { name: 'GitLab Runner Token',      regex: /glrt-[a-zA-Z0-9_-]{20,}/,                                                                            severity: 'high',     description: 'GitLab runner registration token' },
    { name: 'Bitbucket Token',          regex: /bitbucket.*token["'\s]*[:=]\s*["'][a-zA-Z0-9]{20,}["']/i,                                             severity: 'critical', description: 'Bitbucket access/app token' },

    // ── Communication (High) ────────────────────────────────────
    { name: 'Slack Token',              regex: /xox[bpas]-[0-9]{10,}-[a-zA-Z0-9-]+/,                                                                 severity: 'high',     description: 'Slack bot, user, or app token' },
    { name: 'Slack Webhook',            regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[a-zA-Z0-9]{24}/,               severity: 'high',     description: 'Slack incoming webhook URL' },
    { name: 'Discord Bot Token',        regex: /[MN][A-Za-z\d]{23,}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27}/,                                             severity: 'high',     description: 'Discord bot / user authentication token' },
    { name: 'Discord Webhook',          regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/,                               severity: 'high',     description: 'Discord webhook URL' },
    { name: 'Twilio API Key',           regex: /SK[a-fA-F0-9]{32}/,                                                                                  severity: 'high',     description: 'Twilio API key SID' },
    { name: 'Twilio Account SID',       regex: /AC[a-fA-F0-9]{32}/,                                                                                  severity: 'medium',   description: 'Twilio Account SID (needs auth token to exploit)' },
    { name: 'Twilio Auth Token',        regex: /twilio.*auth.*token["'\s]*[:=]\s*["'][a-fA-F0-9]{32}["']/i,                                           severity: 'critical', description: 'Twilio auth token' },
    { name: 'SendGrid API Key',         regex: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/,                                                          severity: 'high',     description: 'SendGrid API key' },
    { name: 'Telegram Bot Token',       regex: /[0-9]{8,10}:[a-zA-Z0-9_-]{35}/,                                                                     severity: 'high',     description: 'Telegram Bot API token' },
    { name: 'Microsoft Teams Webhook',  regex: /https:\/\/[a-z0-9]+\.webhook\.office\.com\/webhookb2\/[^\s"']+/,                                      severity: 'high',     description: 'Microsoft Teams incoming webhook URL' },

    // ── Authentication (Critical) ───────────────────────────────
    { name: 'JWT Token',                regex: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,                                     severity: 'critical', description: 'JSON Web Token (may contain claims/identity)' },
    { name: 'RSA Private Key',          regex: /-----BEGIN RSA PRIVATE KEY-----/,                                                                     severity: 'critical', description: 'RSA private key in PEM format' },
    { name: 'EC Private Key',           regex: /-----BEGIN EC PRIVATE KEY-----/,                                                                      severity: 'critical', description: 'Elliptic Curve private key in PEM format' },
    { name: 'DSA Private Key',          regex: /-----BEGIN DSA PRIVATE KEY-----/,                                                                     severity: 'critical', description: 'DSA private key in PEM format' },
    { name: 'PGP Private Key',          regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----/,                                                               severity: 'critical', description: 'PGP/GPG private key block' },
    { name: 'SSH Private Key',          regex: /-----BEGIN OPENSSH PRIVATE KEY-----/,                                                                 severity: 'critical', description: 'OpenSSH private key' },
    { name: 'PKCS8 Private Key',        regex: /-----BEGIN PRIVATE KEY-----/,                                                                         severity: 'critical', description: 'PKCS#8 private key in PEM format' },
    { name: 'Encrypted Private Key',    regex: /-----BEGIN ENCRYPTED PRIVATE KEY-----/,                                                               severity: 'high',     description: 'Encrypted private key (passphrase may be nearby)' },

    // ── Database (Critical) ─────────────────────────────────────
    { name: 'PostgreSQL URL',           regex: /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@[^\s"']+/,                                                     severity: 'critical', description: 'PostgreSQL connection string with credentials' },
    { name: 'MySQL URL',                regex: /mysql:\/\/[^\s"']+:[^\s"']+@[^\s"']+/,                                                               severity: 'critical', description: 'MySQL connection string with credentials' },
    { name: 'MongoDB URL',              regex: /mongodb(?:\+srv)?:\/\/[^\s"']+:[^\s"']+@[^\s"']+/,                                                   severity: 'critical', description: 'MongoDB connection string with credentials' },
    { name: 'Redis URL',                regex: /redis:\/\/[^\s"']+:[^\s"']+@[^\s"']+/,                                                               severity: 'critical', description: 'Redis connection string with credentials' },
    { name: 'MSSQL URL',                regex: /Server=[^;]+;.*Password=[^;]+/i,                                                                     severity: 'critical', description: 'Microsoft SQL Server connection string with password' },
    { name: 'CockroachDB URL',          regex: /cockroachdb:\/\/[^\s"']+:[^\s"']+@[^\s"']+/,                                                         severity: 'critical', description: 'CockroachDB connection string with credentials' },
    { name: 'Firebase Database URL',    regex: /https:\/\/[a-z0-9-]+\.firebaseio\.com/,                                                              severity: 'medium',   description: 'Firebase Realtime Database URL (check rules)' },

    // ── Email (High) ────────────────────────────────────────────
    { name: 'Mailgun API Key',          regex: /key-[a-fA-F0-9]{32}/,                                                                                severity: 'high',     description: 'Mailgun API key' },
    { name: 'Mailchimp API Key',        regex: /[a-f0-9]{32}-us[0-9]{1,2}/,                                                                          severity: 'high',     description: 'Mailchimp API key' },
    { name: 'SMTP Password',            regex: /smtp.*password["'\s]*[:=]\s*["'][^"']{8,}["']/i,                                                     severity: 'high',     description: 'SMTP password in configuration' },
    { name: 'Postmark Server Token',    regex: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/,                                      severity: 'low',      description: 'Possible Postmark server token (also matches UUIDs)' },

    // ── Social / API Platforms (High) ───────────────────────────
    { name: 'Facebook Access Token',    regex: /EAA[a-zA-Z0-9]{20,}/,                                                                                severity: 'high',     description: 'Facebook / Meta Graph API access token' },
    { name: 'Twitter API Key',          regex: /(?:twitter|tw).*api[_-]?key["'\s]*[:=]\s*["'][a-zA-Z0-9]{25,}["']/i,                                  severity: 'high',     description: 'Twitter / X API consumer key' },
    { name: 'Twitter Bearer Token',     regex: /AAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+/,                                                                   severity: 'high',     description: 'Twitter API v2 bearer token' },
    { name: 'Heroku API Key',           regex: /[hH]eroku.*[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/,            severity: 'high',     description: 'Heroku platform API key' },
    { name: 'NPM Token',               regex: /npm_[a-zA-Z0-9]{36}/,                                                                                severity: 'critical', description: 'NPM automation / publish token' },
    { name: 'PyPI Token',              regex: /pypi-[A-Za-z0-9_-]{100,}/,                                                                            severity: 'critical', description: 'PyPI API upload token' },
    { name: 'NuGet API Key',           regex: /oy2[a-z0-9]{43}/,                                                                                     severity: 'critical', description: 'NuGet.org API key' },
    { name: 'RubyGems API Key',        regex: /rubygems_[a-f0-9]{48}/,                                                                               severity: 'critical', description: 'RubyGems API key' },
    { name: 'Shopify Token',           regex: /shpat_[a-fA-F0-9]{32}/,                                                                               severity: 'critical', description: 'Shopify admin API access token' },
    { name: 'Shopify Shared Secret',   regex: /shpss_[a-fA-F0-9]{32}/,                                                                               severity: 'critical', description: 'Shopify shared secret' },
    { name: 'Shopify Custom App',      regex: /shpca_[a-fA-F0-9]{32}/,                                                                               severity: 'critical', description: 'Shopify custom app access token' },
    { name: 'Shopify Private App',     regex: /shppa_[a-fA-F0-9]{32}/,                                                                               severity: 'critical', description: 'Shopify private app access token' },
    { name: 'Okta API Token',          regex: /(?:okta).?(?:api)?_?token["'\s]*[:=]\s*["'][a-zA-Z0-9_-]{30,}["']/i,                                   severity: 'critical', description: 'Okta API token' },
    { name: 'Auth0 Client Secret',     regex: /(?:auth0).?(?:client)?_?secret["'\s]*[:=]\s*["'][a-zA-Z0-9_-]{30,}["']/i,                              severity: 'critical', description: 'Auth0 client secret' },
    { name: 'Linear API Key',          regex: /lin_api_[a-zA-Z0-9]{40}/,                                                                             severity: 'high',     description: 'Linear issue tracker API key' },
    { name: 'Vercel Token',            regex: /vercel_[a-zA-Z0-9]{24}/i,                                                                             severity: 'high',     description: 'Vercel deployment token' },
    { name: 'Netlify Token',           regex: /(?:netlify).?(?:auth)?_?token["'\s]*[:=]\s*["'][a-zA-Z0-9_-]{40,}["']/i,                               severity: 'high',     description: 'Netlify personal access token' },
    { name: 'Supabase Service Key',    regex: /sbp_[a-f0-9]{40}/,                                                                                    severity: 'critical', description: 'Supabase service role key' },
    { name: 'OpenAI API Key',          regex: /sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}/,                                                          severity: 'critical', description: 'OpenAI API secret key' },
    { name: 'OpenAI Project Key',      regex: /sk-proj-[a-zA-Z0-9_-]{40,}/,                                                                         severity: 'critical', description: 'OpenAI project API key' },
    { name: 'Anthropic API Key',       regex: /sk-ant-[a-zA-Z0-9_-]{40,}/,                                                                           severity: 'critical', description: 'Anthropic / Claude API key' },
    { name: 'Cohere API Key',          regex: /(?:cohere).?(?:api)?_?key["'\s]*[:=]\s*["'][a-zA-Z0-9]{30,}["']/i,                                     severity: 'critical', description: 'Cohere NLP API key' },
    { name: 'HuggingFace Token',       regex: /hf_[a-zA-Z0-9]{34}/,                                                                                  severity: 'high',     description: 'HuggingFace API / Hub token' },
    { name: 'Mapbox Token',            regex: /pk\.[a-zA-Z0-9]{60,}/,                                                                                severity: 'medium',   description: 'Mapbox public access token' },
    { name: 'Cloudflare API Key',      regex: /(?:cloudflare).?(?:api)?_?key["'\s]*[:=]\s*["'][a-f0-9]{37}["']/i,                                     severity: 'high',     description: 'Cloudflare global API key' },
    { name: 'Cloudflare API Token',    regex: /(?:cloudflare).?(?:api)?_?token["'\s]*[:=]\s*["'][A-Za-z0-9_-]{40}["']/i,                              severity: 'high',     description: 'Cloudflare scoped API token' },
    { name: 'Datadog API Key',         regex: /(?:datadog|dd).?api.?key["'\s]*[:=]\s*["'][a-f0-9]{32}["']/i,                                          severity: 'high',     description: 'Datadog API key' },
    { name: 'Datadog App Key',         regex: /(?:datadog|dd).?app.?key["'\s]*[:=]\s*["'][a-f0-9]{40}["']/i,                                          severity: 'high',     description: 'Datadog application key' },
    { name: 'New Relic License Key',   regex: /(?:new.?relic).?license.?key["'\s]*[:=]\s*["'][a-fA-F0-9]{40}["']/i,                                   severity: 'high',     description: 'New Relic license / ingest key' },
    { name: 'Sentry DSN',             regex: /https:\/\/[a-f0-9]{32}@[a-z0-9]+\.ingest\.sentry\.io\/[0-9]+/,                                         severity: 'medium',   description: 'Sentry error tracking DSN (limited risk)' },
    { name: 'Algolia API Key',        regex: /(?:algolia).?(?:api)?_?key["'\s]*[:=]\s*["'][a-f0-9]{32}["']/i,                                         severity: 'high',     description: 'Algolia search API key' },
    { name: 'Algolia Admin Key',      regex: /(?:algolia).?admin.?key["'\s]*[:=]\s*["'][a-f0-9]{32}["']/i,                                            severity: 'critical', description: 'Algolia admin API key' },
    { name: 'CircleCI Token',         regex: /circle.?(?:ci)?_?token["'\s]*[:=]\s*["'][a-f0-9]{40}["']/i,                                             severity: 'high',     description: 'CircleCI personal API token' },
    { name: 'Travis CI Token',        regex: /travis.?(?:ci)?_?token["'\s]*[:=]\s*["'][a-zA-Z0-9_-]{20,}["']/i,                                      severity: 'high',     description: 'Travis CI authentication token' },

    // ── Infrastructure (High) ───────────────────────────────────
    { name: 'Docker Registry Auth',    regex: /dockercfg\s*[:=]/i,                                                                                   severity: 'high',     description: 'Docker registry authentication config' },
    { name: 'Docker Hub Token',        regex: /dckr_pat_[A-Za-z0-9_-]{24,}/,                                                                         severity: 'high',     description: 'Docker Hub personal access token' },
    { name: 'Kubernetes Service Token', regex: /['"]kubernetes\.io\/service-account-token['"]/,                                                       severity: 'high',     description: 'Kubernetes service account token reference' },
    { name: 'Terraform Cloud Token',   regex: /(?:TFE|TFC)_TOKEN["'\s]*[:=]\s*["'][a-zA-Z0-9.]+["']/,                                                severity: 'high',     description: 'Terraform Cloud / Enterprise API token' },
    { name: 'Terraform Token',        regex: /credentials\s+"app\.terraform\.io"/,                                                                    severity: 'high',     description: 'Terraform credentials block for app.terraform.io' },
    { name: 'Vault Token',            regex: /(?:vault.?token|VAULT_TOKEN)["'\s]*[:=]\s*["']s\.[a-zA-Z0-9]{24}["']/,                                  severity: 'critical', description: 'HashiCorp Vault access token' },
    { name: 'Consul Token',           regex: /(?:consul).?(?:http)?_?token["'\s]*[:=]\s*["'][a-f0-9-]{36}["']/i,                                      severity: 'high',     description: 'HashiCorp Consul ACL token' },
    { name: 'Pulumi Access Token',    regex: /pul-[a-f0-9]{40}/,                                                                                     severity: 'high',     description: 'Pulumi cloud access token' },
    { name: 'Doppler Token',          regex: /dp\.st\.[a-zA-Z0-9_-]+/,                                                                               severity: 'high',     description: 'Doppler service token' },

    // ── Generic Patterns (Medium) ───────────────────────────────
    { name: 'Generic API Key',         regex: /(?:api[_-]?key|apikey|api_secret)["'\s]*[:=]\s*["'][a-zA-Z0-9_-]{16,}["']/i,                           severity: 'medium',   description: 'Generic API key assignment detected' },
    { name: 'Generic Secret',          regex: /(?:secret|password|passwd|pwd|token|auth_token|access_token)["'\s]*[:=]\s*["'][^"'\s]{8,}["']/i,        severity: 'medium',   description: 'Generic secret/password/token assignment' },
    { name: 'Password in URL',         regex: /:\/\/[^\s:]+:[^\s@]+@/,                                                                               severity: 'high',     description: 'URL containing embedded credentials' },
    { name: 'Bearer Token',            regex: /[Bb]earer\s+[a-zA-Z0-9_-]{20,}/,                                                                     severity: 'medium',   description: 'HTTP Authorization Bearer token value' },
    { name: 'Basic Auth Header',       regex: /[Bb]asic\s+[A-Za-z0-9+/=]{20,}/,                                                                     severity: 'medium',   description: 'HTTP Basic Auth encoded credentials' },
    { name: 'IP with Credentials',     regex: /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[^\s]+@/,                                             severity: 'medium',   description: 'IP address with credentials pattern' },
    { name: 'Hardcoded Password',      regex: /(?:password|passwd|pwd)\s*=\s*["'][^"'\n]{8,64}["']/i,                                                severity: 'medium',   description: 'Hardcoded password value in code' },
    { name: 'Private Key Data',        regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                                                                   severity: 'critical', description: 'Generic private key in PEM format' },
    { name: '.env Assignment',         regex: /^[A-Z_]{3,}(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_APIKEY)=\S{8,}/m,                                        severity: 'medium',   description: 'Sensitive .env variable with value' },
  ];


  /* ═══════════════════════════════════════════════════════════════
     2. STATE & DOM REFS
     ═══════════════════════════════════════════════════════════════ */

  const state = {
    owner: '',
    repo: '',
    branch: 'main',
    scanning: false
  };

  const $ = id => document.getElementById(id);
  const urlInput     = $('security-url');
  const scanBtn      = $('security-scan-btn');
  const progressEl   = $('security-progress');
  const progressBar  = $('security-progress-bar');
  const progressText = $('security-progress-text');
  const resultsEl    = $('security-results');

  // Exit early if not on the security page
  if (!urlInput || !scanBtn) return;


  /* ═══════════════════════════════════════════════════════════════
     3. GITHUB API FUNCTIONS
     ═══════════════════════════════════════════════════════════════ */

  function parseGitHubUrl(url) {
    const match = url.trim().match(/github\.com\/([^\/]+)\/([^\/\s#?]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
  }

  async function fetchRepoTree(owner, repo) {
    for (const branch of ['main', 'master', 'develop']) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
        );
        if (res.ok) {
          state.branch = branch;
          const data = await res.json();
          return data.tree || [];
        }
      } catch (e) { /* try next branch */ }
    }
    throw new Error('Cannot access repository. Make sure it is public and the URL is correct.');
  }

  async function fetchFileContent(owner, repo, branch, path) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`
      );
      if (!res.ok) return null;
      const text = await res.text();
      // Cap file size at 200KB to avoid memory issues
      return text.length > 200000 ? text.substring(0, 200000) : text;
    } catch (e) {
      return null;
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }


  /* ═══════════════════════════════════════════════════════════════
     4. SECRET SCANNING ENGINE
     ═══════════════════════════════════════════════════════════════ */

  const SKIP_DIRS = new Set([
    'node_modules', 'vendor', '.git', 'dist', 'build', '__pycache__',
    '.next', 'coverage', '.cache', '.output', '.nuxt', '.svelte-kit',
    'bower_components', 'jspm_packages', '.terraform', '.serverless',
    'target', 'bin', 'obj', '.gradle', '.idea', '.vscode', '.vs'
  ]);

  const SKIP_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
    'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock',
    'go.sum', 'flake.lock', 'mix.lock', 'pubspec.lock'
  ]);

  const CODE_EXTENSIONS = new Set([
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
    'py', 'pyw',
    'java', 'kt', 'kts', 'scala',
    'go',
    'rb', 'erb',
    'rs',
    'c', 'cpp', 'cc', 'cxx', 'h', 'hpp',
    'cs',
    'php',
    'swift',
    'env', 'env.local', 'env.production', 'env.development',
    'yml', 'yaml',
    'json',
    'toml',
    'xml',
    'sh', 'bash', 'zsh',
    'cfg', 'conf', 'ini', 'properties',
    'tf', 'tfvars',
    'gradle',
    'dockerfile',
    'vue', 'svelte'
  ]);

  function shouldScanFile(path) {
    const parts = path.split('/');
    const filename = parts[parts.length - 1];

    // Skip lock files
    if (SKIP_FILES.has(filename)) return false;

    // Skip ignored directories
    for (let i = 0; i < parts.length - 1; i++) {
      if (SKIP_DIRS.has(parts[i])) return false;
    }

    // .env files with any suffix are always scannable
    if (filename.startsWith('.env')) return true;

    // Dockerfiles
    if (filename.toLowerCase() === 'dockerfile' || filename.toLowerCase().startsWith('dockerfile.')) return true;

    // Check extension
    const dotIdx = filename.lastIndexOf('.');
    if (dotIdx === -1) return false;
    const ext = filename.substring(dotIdx + 1).toLowerCase();
    return CODE_EXTENSIONS.has(ext);
  }

  function redactSecret(value) {
    if (value.length <= 12) return '****' + value.substring(value.length - 4);
    return value.substring(0, 4) + '****' + value.substring(value.length - 4);
  }

  function findLineNumber(content, matchIndex) {
    let line = 1;
    for (let i = 0; i < matchIndex && i < content.length; i++) {
      if (content[i] === '\n') line++;
    }
    return line;
  }

  // Patterns in comments / examples that should be skipped
  const SKIP_INDICATORS = [
    'example', 'YOUR_', 'xxx', 'placeholder', 'CHANGE_ME', 'INSERT_',
    'todo', 'fixme', 'sample', 'test_key', 'fake', 'dummy', 'REPLACE_',
    '<your', '<insert', 'XXXXXXXXX', '000000000', 'abcdef', 'put_your',
    'aaaaaaa', 'replace_with', 'fill_in'
  ];

  async function scanFileForSecrets(path, content) {
    const findings = [];
    const lines = content.split('\n');

    for (const pattern of SECRET_PATTERNS) {
      let regex;
      try {
        regex = new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : pattern.regex.flags + 'g');
      } catch (e) {
        continue;
      }

      let match;
      while ((match = regex.exec(content)) !== null) {
        const line = findLineNumber(content, match.index);
        const lineText = (lines[line - 1] || '').toLowerCase();

        // Skip obvious examples, docs, or placeholder values
        let isExample = false;
        for (const indicator of SKIP_INDICATORS) {
          if (lineText.includes(indicator.toLowerCase())) {
            isExample = true;
            break;
          }
        }
        if (isExample) continue;

        // Skip single-line and block comment lines that are clearly documentation
        const trimmedLine = lineText.trim();
        if (trimmedLine.startsWith('//') && (trimmedLine.includes('e.g.') || trimmedLine.includes('i.e.') || trimmedLine.includes('format:'))) continue;

        findings.push({
          pattern: pattern.name,
          severity: pattern.severity,
          description: pattern.description,
          file: path,
          line: line,
          value: redactSecret(match[0]),
          rawLength: match[0].length
        });

        // Cap findings per pattern per file to avoid noise
        if (findings.filter(f => f.pattern === pattern.name && f.file === path).length >= 5) break;
      }
    }

    return findings;
  }


  /* ═══════════════════════════════════════════════════════════════
     5. DEPENDENCY VULNERABILITY SCANNER
     ═══════════════════════════════════════════════════════════════ */

  const DEP_FILES = {
    'package.json':      'npm',
    'requirements.txt':  'PyPI',
    'Pipfile':           'PyPI',
    'setup.py':          'PyPI',
    'setup.cfg':         'PyPI',
    'pyproject.toml':    'PyPI',
    'go.mod':            'Go',
    'Cargo.toml':        'crates.io',
    'Gemfile':           'RubyGems',
    'pom.xml':           'Maven',
    'build.gradle':      'Maven',
    'build.gradle.kts':  'Maven',
    'composer.json':     'Packagist',
    'pubspec.yaml':      'Pub',
    'mix.exs':           'Hex'
  };

  function parsePackageJson(content) {
    try {
      const pkg = JSON.parse(content);
      const deps = [];
      for (const [name, version] of Object.entries(pkg.dependencies || {})) {
        deps.push({ name, version: version.replace(/^[^0-9]*/, ''), ecosystem: 'npm' });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
        deps.push({ name, version: version.replace(/^[^0-9]*/, ''), ecosystem: 'npm', dev: true });
      }
      return deps;
    } catch (e) {
      return [];
    }
  }

  function parseRequirementsTxt(content) {
    return content.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('git+'))
      .map(l => {
        const match = l.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\s*[=<>!~]+\s*(.+))?/);
        if (!match) return null;
        return {
          name: match[1],
          version: (match[2] || '').replace(/,.*/, '').trim(),
          ecosystem: 'PyPI'
        };
      })
      .filter(Boolean);
  }

  function parseGoMod(content) {
    const deps = [];
    const lines = content.split('\n');
    let inRequire = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('require (') || trimmed === 'require(') { inRequire = true; continue; }
      if (inRequire && trimmed === ')') { inRequire = false; continue; }
      if (inRequire || trimmed.startsWith('require ')) {
        const match = trimmed.match(/^(?:require\s+)?([a-zA-Z0-9./\-_]+)\s+(v[\d.]+(?:-[a-zA-Z0-9.+-]*)?)/);
        if (match) deps.push({ name: match[1], version: match[2], ecosystem: 'Go' });
      }
    }
    return deps;
  }

  function parseCargoToml(content) {
    const deps = [];
    const lines = content.split('\n');
    let inDeps = false;
    for (const line of lines) {
      if (line.match(/^\[.*dependencies.*\]/)) { inDeps = true; continue; }
      if (line.startsWith('[') && !line.includes('dependencies')) { inDeps = false; continue; }
      if (inDeps) {
        // Simple form: package = "version"
        const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
        if (match) { deps.push({ name: match[1], version: match[2], ecosystem: 'crates.io' }); continue; }
        // Table form: package = { version = "x.y.z", ... }
        const match2 = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/);
        if (match2) deps.push({ name: match2[1], version: match2[2], ecosystem: 'crates.io' });
      }
    }
    return deps;
  }

  function parseComposerJson(content) {
    try {
      const pkg = JSON.parse(content);
      const deps = [];
      for (const [name, version] of Object.entries(pkg.require || {})) {
        if (name === 'php' || name.startsWith('ext-')) continue;
        deps.push({ name, version: version.replace(/^[^0-9]*/, ''), ecosystem: 'Packagist' });
      }
      for (const [name, version] of Object.entries(pkg['require-dev'] || {})) {
        deps.push({ name, version: version.replace(/^[^0-9]*/, ''), ecosystem: 'Packagist', dev: true });
      }
      return deps;
    } catch (e) {
      return [];
    }
  }

  function parsePubspecYaml(content) {
    const deps = [];
    const lines = content.split('\n');
    let inDeps = false;
    for (const line of lines) {
      if (line.match(/^dependencies:|^dev_dependencies:/)) { inDeps = true; continue; }
      if (line.match(/^[a-z]/) && !line.startsWith(' ')) { inDeps = false; continue; }
      if (inDeps) {
        const match = line.match(/^\s+([a-zA-Z0-9_]+):\s*[\^~]?([\d.]+)/);
        if (match) deps.push({ name: match[1], version: match[2], ecosystem: 'Pub' });
      }
    }
    return deps;
  }

  function parseGemfile(content) {
    const deps = [];
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*gem\s+['"]([a-zA-Z0-9_-]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
      if (match) {
        deps.push({
          name: match[1],
          version: (match[2] || '').replace(/^[~>=<!\s]+/, ''),
          ecosystem: 'RubyGems'
        });
      }
    }
    return deps;
  }

  function parseDepsForFile(filename, content) {
    switch (filename) {
      case 'package.json':      return parsePackageJson(content);
      case 'requirements.txt':  return parseRequirementsTxt(content);
      case 'Pipfile':           return parseRequirementsTxt(content); // close enough
      case 'go.mod':            return parseGoMod(content);
      case 'Cargo.toml':        return parseCargoToml(content);
      case 'composer.json':     return parseComposerJson(content);
      case 'pubspec.yaml':      return parsePubspecYaml(content);
      case 'Gemfile':           return parseGemfile(content);
      default:                  return [];
    }
  }

  async function queryOSV(pkg) {
    try {
      const body = { package: { name: pkg.name, ecosystem: pkg.ecosystem } };
      if (pkg.version) body.version = pkg.version;
      const res = await fetch('https://api.osv.dev/v1/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.vulns || []).map(v => ({
        id: v.id,
        summary: v.summary || 'No description available',
        severity: extractSeverity(v),
        package: pkg.name,
        version: pkg.version,
        ecosystem: pkg.ecosystem,
        aliases: (v.aliases || []).join(', '),
        fixed: extractFixVersion(v),
        published: v.published || '',
        link: `https://osv.dev/vulnerability/${v.id}`
      }));
    } catch (e) {
      return [];
    }
  }

  function extractSeverity(vuln) {
    // 1. Check database_specific.severity
    if (vuln.database_specific && vuln.database_specific.severity) {
      return vuln.database_specific.severity.toLowerCase();
    }
    // 2. Try CVSS score
    if (vuln.severity && vuln.severity.length > 0) {
      for (const s of vuln.severity) {
        if (s.score) {
          // Try to parse CVSS numeric score
          const numMatch = s.score.match(/\/(\d+\.?\d*)/);
          if (numMatch) {
            const score = parseFloat(numMatch[1]);
            if (score >= 9.0) return 'critical';
            if (score >= 7.0) return 'high';
            if (score >= 4.0) return 'medium';
            return 'low';
          }
        }
        // Fallback to type
        if (s.type === 'CVSS_V3' || s.type === 'CVSS_V4') return 'high';
      }
    }
    // 3. Default
    return 'medium';
  }

  function extractFixVersion(vuln) {
    if (vuln.affected && vuln.affected.length > 0) {
      for (const affected of vuln.affected) {
        if (affected.ranges) {
          for (const range of affected.ranges) {
            if (range.events) {
              const fixEvent = range.events.find(e => e.fixed);
              if (fixEvent) return fixEvent.fixed;
            }
          }
        }
      }
    }
    return null;
  }


  /* ═══════════════════════════════════════════════════════════════
     6. PROGRESS & UTILITY
     ═══════════════════════════════════════════════════════════════ */

  function updateProgress(pct, message) {
    if (progressBar) {
      progressBar.style.width = Math.round(pct) + '%';
    }
    if (progressText) {
      progressText.textContent = message;
    }
  }

  function showError(message) {
    if (resultsEl) {
      resultsEl.classList.add('active');
      resultsEl.innerHTML = `
        <div class="security-error">
          <div class="error-icon">⚠️</div>
          <h3>Scan Failed</h3>
          <p>${escapeHtml(message)}</p>
        </div>
      `;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(dateStr) {
    if (!dateStr) return 'Unknown';
    try {
      return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return dateStr;
    }
  }


  /* ═══════════════════════════════════════════════════════════════
     7. MAIN SCAN ORCHESTRATOR
     ═══════════════════════════════════════════════════════════════ */

  async function runSecurityScan(owner, repo) {
    updateProgress(0, 'Fetching repository structure...');
    const tree = await fetchRepoTree(owner, repo);

    // Filter scannable files
    const codeFiles = tree.filter(f => f.type === 'blob' && shouldScanFile(f.path));
    const depFiles  = tree.filter(f => f.type === 'blob' && DEP_FILES[f.path.split('/').pop()]);

    updateProgress(10, `Found ${codeFiles.length} code files and ${depFiles.length} dependency files...`);

    // ── Phase 1: Scan for secrets (cap at 80 files) ──
    const filesToScan = codeFiles.slice(0, 80);
    let allSecrets = [];

    for (let i = 0; i < filesToScan.length; i++) {
      const file = filesToScan[i];
      const pct = 10 + (i / filesToScan.length) * 50;
      const shortName = file.path.split('/').pop();
      updateProgress(pct, `Scanning ${shortName} (${i + 1}/${filesToScan.length})...`);

      const content = await fetchFileContent(owner, repo, state.branch, file.path);
      if (content) {
        const secrets = await scanFileForSecrets(file.path, content);
        allSecrets.push(...secrets);
      }

      // Rate-limit: small delay every 5 files
      if (i % 5 === 0 && i > 0) await sleep(120);
    }

    updateProgress(65, 'Analyzing dependency manifests...');

    // ── Phase 2: Parse dependency files ──
    let allDeps = [];
    for (const file of depFiles) {
      const content = await fetchFileContent(owner, repo, state.branch, file.path);
      if (!content) continue;
      const filename = file.path.split('/').pop();
      const deps = parseDepsForFile(filename, content);
      allDeps.push(...deps);
    }

    // Deduplicate dependencies
    const depKey = d => `${d.ecosystem}/${d.name}`;
    const seen = new Set();
    allDeps = allDeps.filter(d => {
      const k = depKey(d);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    updateProgress(70, `Checking ${allDeps.length} dependencies for vulnerabilities...`);

    // ── Phase 3: Query OSV for each dependency (batch of 5) ──
    let allVulns = [];
    for (let i = 0; i < allDeps.length; i += 5) {
      const batch = allDeps.slice(i, i + 5);
      const results = await Promise.all(batch.map(queryOSV));
      for (const vulns of results) allVulns.push(...vulns);
      const pct = 70 + (Math.min(i + 5, allDeps.length) / Math.max(allDeps.length, 1)) * 25;
      updateProgress(pct, `Checked ${Math.min(i + 5, allDeps.length)}/${allDeps.length} packages...`);
    }

    // Deduplicate vulnerabilities by id + package
    const vulnSeen = new Set();
    allVulns = allVulns.filter(v => {
      const k = `${v.id}|${v.package}`;
      if (vulnSeen.has(k)) return false;
      vulnSeen.add(k);
      return true;
    });

    updateProgress(100, 'Scan complete!');

    // Calculate grade
    const grade = calculateGrade(allSecrets, allVulns);

    return {
      secrets: allSecrets,
      vulnerabilities: allVulns,
      dependencies: allDeps,
      grade,
      filesScanned: filesToScan.length,
      totalCodeFiles: codeFiles.length,
      branch: state.branch
    };
  }

  function calculateGrade(secrets, vulns) {
    let score = 100;

    // Deduct for secrets
    for (const s of secrets) {
      if (s.severity === 'critical') score -= 25;
      else if (s.severity === 'high') score -= 15;
      else if (s.severity === 'medium') score -= 8;
      else score -= 3;
    }

    // Deduct for vulnerabilities
    for (const v of vulns) {
      if (v.severity === 'critical') score -= 20;
      else if (v.severity === 'high') score -= 12;
      else if (v.severity === 'medium') score -= 6;
      else score -= 2;
    }

    score = Math.max(0, Math.min(100, score));

    if (score >= 90) return { letter: 'A', score, color: 'grade-a', label: 'Excellent' };
    if (score >= 75) return { letter: 'B', score, color: 'grade-b', label: 'Good' };
    if (score >= 55) return { letter: 'C', score, color: 'grade-c', label: 'Fair' };
    if (score >= 35) return { letter: 'D', score, color: 'grade-d', label: 'Poor' };
    return { letter: 'F', score, color: 'grade-f', label: 'Critical' };
  }


  /* ═══════════════════════════════════════════════════════════════
     8. UI RENDERING
     ═══════════════════════════════════════════════════════════════ */

  function renderResults(data) {
    if (!resultsEl) return;
    resultsEl.classList.add('active');
    resultsEl.innerHTML = '';

    // Build full results page
    const fragment = document.createDocumentFragment();

    // ── Stats Bar ──
    fragment.appendChild(renderStats(data));

    // ── Grade Card ──
    fragment.appendChild(renderGrade(data.grade));

    // ── Secrets Section ──
    fragment.appendChild(renderSecrets(data.secrets));

    // ── Vulnerabilities Section ──
    fragment.appendChild(renderVulnerabilities(data.vulnerabilities, data.dependencies));

    // ── Scan Metadata ──
    fragment.appendChild(renderMeta(data));

    resultsEl.appendChild(fragment);

    // Animate grade ring
    requestAnimationFrame(() => {
      const ring = resultsEl.querySelector('.grade-ring-fill');
      if (ring) {
        const circumference = 2 * Math.PI * 54;
        const offset = circumference - (data.grade.score / 100) * circumference;
        ring.style.strokeDashoffset = offset;
      }
    });
  }

  function renderStats(data) {
    const criticalSecrets = data.secrets.filter(s => s.severity === 'critical').length;
    const highSecrets     = data.secrets.filter(s => s.severity === 'high').length;
    const criticalVulns   = data.vulnerabilities.filter(v => v.severity === 'critical').length;
    const highVulns       = data.vulnerabilities.filter(v => v.severity === 'high').length;
    const safeCount       = data.dependencies.length - new Set(data.vulnerabilities.map(v => v.package)).size;

    const el = document.createElement('div');
    el.className = 'security-stats-bar';
    el.innerHTML = `
      <div class="stat-card">
        <div class="stat-value ${data.grade.color}">${data.grade.letter}</div>
        <div class="stat-label">Security Grade</div>
      </div>
      <div class="stat-card">
        <div class="stat-value ${data.secrets.length > 0 ? 'text-danger' : 'text-safe'}">${data.secrets.length}</div>
        <div class="stat-label">Secrets Found</div>
        ${criticalSecrets > 0 ? `<div class="stat-sub">${criticalSecrets} critical</div>` : ''}
      </div>
      <div class="stat-card">
        <div class="stat-value ${data.vulnerabilities.length > 0 ? 'text-warning' : 'text-safe'}">${data.vulnerabilities.length}</div>
        <div class="stat-label">Vulnerabilities</div>
        ${criticalVulns > 0 ? `<div class="stat-sub">${criticalVulns} critical, ${highVulns} high</div>` : ''}
      </div>
      <div class="stat-card">
        <div class="stat-value text-safe">${Math.max(0, safeCount)}</div>
        <div class="stat-label">Safe Dependencies</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.filesScanned}</div>
        <div class="stat-label">Files Scanned</div>
        ${data.totalCodeFiles > data.filesScanned ? `<div class="stat-sub">of ${data.totalCodeFiles} total</div>` : ''}
      </div>
    `;
    return el;
  }

  function renderGrade(grade) {
    const circumference = 2 * Math.PI * 54;
    const el = document.createElement('div');
    el.className = 'security-grade-section';
    el.innerHTML = `
      <div class="grade-card ${grade.color}">
        <div class="grade-visual">
          <svg class="grade-ring" viewBox="0 0 120 120">
            <circle class="grade-ring-bg" cx="60" cy="60" r="54" />
            <circle class="grade-ring-fill" cx="60" cy="60" r="54"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${circumference}" />
          </svg>
          <div class="grade-letter">${grade.letter}</div>
        </div>
        <div class="grade-info">
          <h3>Security Score: ${grade.score}/100</h3>
          <p class="grade-label">${grade.label}</p>
          <p class="grade-description">${getGradeDescription(grade)}</p>
        </div>
      </div>
    `;
    return el;
  }

  function getGradeDescription(grade) {
    switch (grade.letter) {
      case 'A': return 'This repository follows strong security practices. No critical secrets or known vulnerabilities were detected.';
      case 'B': return 'Generally secure with minor findings. Review the items below and address any medium-severity issues.';
      case 'C': return 'Several security concerns found. Prioritize fixing critical and high-severity findings immediately.';
      case 'D': return 'Significant security risks detected. This repository needs immediate attention to prevent credential leaks or exploitation.';
      case 'F': return 'Critical security failures. Leaked secrets and/or severe vulnerabilities put this project at high risk. Rotate all exposed credentials now.';
      default:  return '';
    }
  }

  function renderSecrets(secrets) {
    const section = document.createElement('div');
    section.className = 'security-section';

    if (secrets.length === 0) {
      section.innerHTML = `
        <h2 class="section-title">🔑 Secret Detection</h2>
        <div class="security-empty-state success">
          <div class="empty-icon">✅</div>
          <h3>No Secrets Detected</h3>
          <p>No hardcoded credentials, API keys, or tokens were found in the scanned files. Great job!</p>
        </div>
      `;
      return section;
    }

    // Group by severity
    const grouped = { critical: [], high: [], medium: [], low: [] };
    for (const s of secrets) {
      (grouped[s.severity] || grouped.medium).push(s);
    }

    let html = `<h2 class="section-title">🔑 Secret Detection <span class="finding-count">${secrets.length} finding${secrets.length !== 1 ? 's' : ''}</span></h2>`;

    for (const severity of ['critical', 'high', 'medium', 'low']) {
      const items = grouped[severity];
      if (items.length === 0) continue;

      html += `<div class="findings-group">
        <h3 class="severity-header severity-${severity}">
          <span class="severity-badge ${severity}">${severity.toUpperCase()}</span>
          ${items.length} finding${items.length !== 1 ? 's' : ''}
        </h3>`;

      for (const item of items) {
        html += `
          <div class="finding-card severity-border-${severity}">
            <div class="finding-header">
              <span class="finding-name">${escapeHtml(item.pattern)}</span>
              <span class="severity-badge ${severity}">${severity}</span>
            </div>
            <p class="finding-description">${escapeHtml(item.description)}</p>
            <div class="finding-details">
              <span class="finding-file" title="${escapeHtml(item.file)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 1.5a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v9.086A1.75 1.75 0 0112.25 16h-8.5A1.75 1.75 0 012 14.25V1.75z"/></svg>
                ${escapeHtml(item.file)}
              </span>
              <span class="finding-line">Line ${item.line}</span>
            </div>
            <div class="finding-value">
              <code>${escapeHtml(item.value)}</code>
              <span class="finding-length">(${item.rawLength} chars)</span>
            </div>
          </div>`;
      }

      html += `</div>`;
    }

    section.innerHTML = html;
    return section;
  }

  function renderVulnerabilities(vulns, deps) {
    const section = document.createElement('div');
    section.className = 'security-section';

    if (vulns.length === 0) {
      section.innerHTML = `
        <h2 class="section-title">📦 Dependency Vulnerabilities</h2>
        <div class="security-empty-state success">
          <div class="empty-icon">✅</div>
          <h3>All Dependencies Are Secure</h3>
          <p>${deps.length > 0 ? `All ${deps.length} dependencies checked against the OSV database — no known vulnerabilities found.` : 'No dependency manifest files were found to check.'}</p>
        </div>
      `;
      return section;
    }

    // Group by severity
    const grouped = { critical: [], high: [], medium: [], low: [] };
    for (const v of vulns) {
      (grouped[v.severity] || grouped.medium).push(v);
    }

    let html = `<h2 class="section-title">📦 Dependency Vulnerabilities <span class="finding-count">${vulns.length} issue${vulns.length !== 1 ? 's' : ''}</span></h2>`;

    for (const severity of ['critical', 'high', 'medium', 'low']) {
      const items = grouped[severity];
      if (items.length === 0) continue;

      html += `<div class="findings-group">
        <h3 class="severity-header severity-${severity}">
          <span class="severity-badge ${severity}">${severity.toUpperCase()}</span>
          ${items.length} vulnerabilit${items.length !== 1 ? 'ies' : 'y'}
        </h3>`;

      for (const item of items) {
        html += `
          <div class="finding-card severity-border-${severity}">
            <div class="finding-header">
              <a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer" class="finding-name vuln-link">
                ${escapeHtml(item.id)}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="margin-left:4px;opacity:0.5"><path d="M3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5zm6.75 0a.75.75 0 000 1.5h1.94L8.22 7.72a.75.75 0 001.06 1.06L13.5 4.56v1.94a.75.75 0 001.5 0v-3.5A.75.75 0 0014.25 2h-3.75z"/></svg>
              </a>
              <span class="severity-badge ${severity}">${severity}</span>
            </div>
            <p class="finding-description">${escapeHtml(item.summary)}</p>
            <div class="finding-details">
              <span class="finding-package">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8.878.392a1.75 1.75 0 00-1.756 0l-5.25 3.045A1.75 1.75 0 001 4.951v6.098c0 .624.332 1.2.872 1.514l5.25 3.045a1.75 1.75 0 001.756 0l5.25-3.045c.54-.313.872-.89.872-1.514V4.951c0-.624-.332-1.2-.872-1.514L8.878.392zM7.875 1.69a.25.25 0 01.25 0l4.63 2.685L8 7.133 3.245 4.375l4.63-2.685zM2.5 5.677v5.372c0 .09.047.171.125.216l4.625 2.683V8.432L2.5 5.677zm6.25 8.271l4.625-2.683a.25.25 0 00.125-.216V5.677L8.75 8.432v5.516z"/></svg>
                ${escapeHtml(item.package)}${item.version ? ' @ ' + escapeHtml(item.version) : ''}
              </span>
              <span class="finding-ecosystem">${escapeHtml(item.ecosystem)}</span>
              ${item.fixed ? `<span class="finding-fix">Fix: upgrade to ${escapeHtml(item.fixed)}</span>` : ''}
            </div>
            ${item.aliases ? `<div class="finding-aliases">Also known as: ${escapeHtml(item.aliases)}</div>` : ''}
            ${item.published ? `<div class="finding-published">Published: ${formatDate(item.published)}</div>` : ''}
          </div>`;
      }

      html += `</div>`;
    }

    section.innerHTML = html;
    return section;
  }

  function renderMeta(data) {
    const el = document.createElement('div');
    el.className = 'security-meta';
    el.innerHTML = `
      <div class="meta-info">
        <span>Scanned <strong>${state.owner}/${state.repo}</strong> (branch: ${state.branch})</span>
        <span>${data.filesScanned} files scanned · ${data.dependencies.length} dependencies checked</span>
        <span>Powered by <a href="https://osv.dev" target="_blank" rel="noopener noreferrer">OSV.dev</a> vulnerability database</span>
      </div>
    `;
    return el;
  }


  /* ═══════════════════════════════════════════════════════════════
     9. EVENT HANDLERS
     ═══════════════════════════════════════════════════════════════ */

  scanBtn.addEventListener('click', async () => {
    if (state.scanning) return;

    const url = urlInput.value.trim();
    if (!url) {
      urlInput.classList.add('input-error');
      urlInput.focus();
      setTimeout(() => urlInput.classList.remove('input-error'), 1500);
      return;
    }

    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      showError('Invalid GitHub URL. Please enter a URL like: https://github.com/owner/repo');
      return;
    }

    state.owner = parsed.owner;
    state.repo  = parsed.repo;
    state.scanning = true;

    // Show progress, hide old results
    if (progressEl) progressEl.style.display = 'block';
    if (resultsEl) resultsEl.classList.remove('active');
    scanBtn.disabled = true;
    scanBtn.innerHTML = '<span class="btn-spinner"></span> Scanning…';
    urlInput.disabled = true;

    try {
      const data = await runSecurityScan(parsed.owner, parsed.repo);
      if (progressEl) progressEl.style.display = 'none';
      renderResults(data);
    } catch (err) {
      if (progressEl) progressEl.style.display = 'none';
      showError(err.message || 'An unexpected error occurred during the scan.');
    } finally {
      state.scanning = false;
      scanBtn.disabled = false;
      scanBtn.innerHTML = 'Scan →';
      urlInput.disabled = false;
    }
  });

  // Enter key triggers scan
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      scanBtn.click();
    }
  });

  // Clear error state on input
  urlInput.addEventListener('input', () => {
    urlInput.classList.remove('input-error');
  });

  // Auto-populate from URL query param: ?repo=owner/repo
  (function autoFill() {
    try {
      const params = new URLSearchParams(window.location.search);
      const repoParam = params.get('repo');
      if (repoParam) {
        const fullUrl = repoParam.includes('github.com') ? repoParam : `https://github.com/${repoParam}`;
        urlInput.value = fullUrl;
      }
    } catch (e) { /* ignore */ }
  })();

})();
