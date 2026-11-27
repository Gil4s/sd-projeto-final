#!/usr/bin/env bash
set -euo pipefail

# Atualiza SOMENTE o Frontend no AWS Amplify em ~20 segundos
REGION="${AWS_REGION:-us-east-1}"
API_DOMAIN="api.guilhermeag.grupo-06.sd.ufersa.dev.br"
POOL_NAME="pool-guilhermeag"
CLIENT_NAME="app-projeto-final"
AMPLIFY_APP_NAME="taskcloud-guilhermeag"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

POOL_ID="$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text)"
DOMAIN_PREFIX="$(aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" --region "$REGION" --query "UserPool.Domain" --output text)"
CLIENT_ID="$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 60 --region "$REGION" --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" --output text)"
AMP_APP_ID="$(aws amplify list-apps --region "$REGION" --query "apps[?name=='${AMPLIFY_APP_NAME}'].appId | [0]" --output text)"

FE_BUILD="${WORK_DIR}/frontend"
cp -r "${ROOT_DIR}/frontend" "$FE_BUILD"
cat > "${FE_BUILD}/.env.production" <<EOF
VITE_API_URL=https://${API_DOMAIN}
VITE_COGNITO_DOMAIN=https://${DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com
VITE_COGNITO_CLIENT_ID=${CLIENT_ID}
VITE_COGNITO_USER_POOL_ID=${POOL_ID}
EOF

echo "[Amplify] Compilando novo frontend..."
(cd "$FE_BUILD" && npm ci --silent && npm run build)
(cd "${FE_BUILD}/dist" && zip -rq "${FE_BUILD}/dist.zip" .)

DEPLOY_JSON="$(aws amplify create-deployment --app-id "$AMP_APP_ID" --branch-name main --region "$REGION")"
JOB_ID="$(echo "$DEPLOY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")"
UPLOAD_URL="$(echo "$DEPLOY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['zipUploadUrl'])")"
curl -fsS -X PUT -T "${FE_BUILD}/dist.zip" "$UPLOAD_URL"
aws amplify start-deployment --app-id "$AMP_APP_ID" --branch-name main --job-id "$JOB_ID" --region "$REGION" >/dev/null

echo "[Amplify] Aguardando publicação..."
for _ in $(seq 1 25); do
  JOB_STATUS="$(aws amplify get-job --app-id "$AMP_APP_ID" --branch-name main --job-id "$JOB_ID" --region "$REGION" --query "job.summary.status" --output text)"
  if [[ "$JOB_STATUS" == "SUCCEED" ]]; then
    echo "[OK] Frontend atualizado ao vivo em https://guilhermeag.grupo-06.sd.ufersa.dev.br !"
    exit 0
  elif [[ "$JOB_STATUS" == "FAILED" ]]; then
    echo "ERRO: Deploy no Amplify falhou." >&2
    exit 1
  fi
  sleep 2
done
