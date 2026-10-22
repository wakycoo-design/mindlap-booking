#!/bin/sh
set -e

# Zoho Catalyst's console does not accept underscores in variable names, so DATABASE_URL can only be entered as DATABASEURL.
# For each setting the app reads, use the underscore-free spelling when the real one is not set.
for name in ADMIN_EMAILS ALLOWED_EMAIL_DOMAIN AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET AUTH_SECRET AUTH_URL AUTH_ZOHO_ACCOUNTS_URL \
  AUTH_ZOHO_ID AUTH_ZOHO_SECRET CALENDAR_ENCRYPTION_KEY CRON_SECRET DATABASE_SSL DATABASE_URL DATABASE_URL_UNPOOLED EMAIL_FROM \
  EMAIL_REPLY_TO GOOGLE_CALENDAR_CLIENT_ID GOOGLE_CALENDAR_CLIENT_SECRET RUN_MIGRATIONS SMTP_HOST SMTP_PASS SMTP_PORT SMTP_USER \
  OTP_META_API_URL OTP_META_TOKEN OTP_TEMPLATE_NAME OTP_TEMPLATE_LANGUAGE PASSWORD_LOGIN PUBLIC_API_ORIGINS WHATSAPP_ACCESS_TOKEN WHATSAPP_APP_SECRET WHATSAPP_PHONE_NUMBER_ID WHATSAPP_WEBHOOK_VERIFY_TOKEN WORKFLOW_INTERVAL_SEC WORKFLOW_RUNNER WORKFLOW_WEBHOOK_SECRET; do
  plain=$(printf '%s' "$name" | tr -d '_')
  if [ -z "$(printenv "$name")" ] && [ -n "$(printenv "$plain")" ]; then
    export "$name=$(printenv "$plain")"
  fi
done

# AppSail tells us which port to listen on; other hosts use PORT.
export PORT="${X_ZOHO_CATALYST_LISTEN_PORT:-${PORT:-3000}}"
export HOSTNAME=0.0.0.0

# A failed migration must not stop the server: hosts like AppSail only report "execution failed", while a
# running server shows what is missing at /api/v1/health.
if [ "$RUN_MIGRATIONS" = "true" ]; then
  node dist/migrate.cjs || echo "[migrate] Migrations failed; starting the server anyway. Check /api/v1/health." >&2
fi

exec node server.js
