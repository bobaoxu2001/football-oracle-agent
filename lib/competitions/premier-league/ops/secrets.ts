/**
 * Credential redaction for operator diagnostics and persisted job errors.
 * Public routes still go through classifyPublicOperationalError; this helper
 * is the shared last line before a secret can be stored or logged.
 */

const QUERY_SECRET_RE =
  /([?&](?:api[_-]?key|x-api-key|key|secret|token|access[_-]?token)=)[^&\s"'#]+/gi;
const BARE_API_KEY_RE = /((?:api[_-]?key|x-api-key)=)[^&\s"'#]+/gi;

export function credentialSecretsFromEnv(): string[] {
  return [
    process.env.ODDS_API_KEY,
    process.env.API_FOOTBALL_KEY,
    process.env.FOOTBALL_DATA_API_KEY,
    process.env.CRON_SECRET,
    process.env.MONGODB_URI,
    process.env.GOOGLE_API_KEY,
    process.env.GEMINI_API_KEY,
  ].filter((value): value is string => Boolean(value && value.length >= 4));
}

export function redactCredentialText(text: string, extraSecrets: string[] = []): string {
  let out = text;
  const secrets = [...extraSecrets, ...credentialSecretsFromEnv()].filter(
    (value, index, all) => value.length >= 4 && all.indexOf(value) === index
  );
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(QUERY_SECRET_RE, "$1[redacted]");
  out = out.replace(BARE_API_KEY_RE, "$1[redacted]");
  return out;
}
