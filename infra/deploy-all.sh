#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Deploy Completo End-to-End — TaskCloud (Projeto Final SD - UFERSA)
# Executar no AWS CloudShell (região us-east-1).
# Sobe/valida: DynamoDB, S3 Privado + CORS, Cognito App Client, Lambda (LabRole),
# API Gateway (preservando GET /dados da Av. 12) e Frontend no AWS Amplify + DNS.
# ==============================================================================

REGION="${AWS_REGION:-us-east-1}"
APP_DOMAIN="guilhermeag.grupo-06.sd.ufersa.dev.br"
API_DOMAIN="api.guilhermeag.grupo-06.sd.ufersa.dev.br"
POOL_NAME="pool-guilhermeag"
CLIENT_NAME="app-projeto-final"
TABLE_NAME="sd-projeto-final-guilhermeag"
LAMBDA_NAME="sd-projeto-final-api"
AUTH_NAME="cognito-projeto-final"
AMPLIFY_APP_NAME="taskcloud-guilhermeag"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/LabRole"
BUCKET_NAME="sd-projeto-final-anexos-guilhermeag-${ACCOUNT_ID}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "============================================================"
echo " Conta AWS : ${ACCOUNT_ID} (${REGION})"
echo " App DNS   : https://${APP_DOMAIN}"
echo " API DNS   : https://${API_DOMAIN}"
echo "============================================================"

# 1. Descobrir User Pool existente (pool-guilhermeag) e domínio Hosted UI
POOL_ID="$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text)"
if [[ -z "$POOL_ID" || "$POOL_ID" == "None" ]]; then
  echo "ERRO: User Pool '${POOL_NAME}' não encontrado em ${REGION}." >&2
  exit 1
fi

COGNITO_DOMAIN_PREFIX="$(aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" --region "$REGION" \
  --query "UserPool.Domain" --output text)"
if [[ -z "$COGNITO_DOMAIN_PREFIX" || "$COGNITO_DOMAIN_PREFIX" == "None" ]]; then
  COGNITO_DOMAIN_PREFIX="taskcloud-guilhermeag-${ACCOUNT_ID:0:6}"
  aws cognito-idp create-user-pool-domain --user-pool-id "$POOL_ID" --domain "$COGNITO_DOMAIN_PREFIX" --region "$REGION"
fi
COGNITO_DOMAIN="https://${COGNITO_DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"
echo "[1/7 OK] Cognito Pool: ${POOL_ID} (${COGNITO_DOMAIN})"

# 2. Descobrir HTTP API existente mapeada em api.guilhermeag.grupo-06.sd.ufersa.dev.br
API_ID="$(aws apigatewayv2 get-api-mappings --domain-name "$API_DOMAIN" --region "$REGION" \
  --query "Items[0].ApiId" --output text)"
STAGE_NAME="$(aws apigatewayv2 get-api-mappings --domain-name "$API_DOMAIN" --region "$REGION" \
  --query "Items[0].Stage" --output text)"
if [[ -z "$API_ID" || "$API_ID" == "None" ]]; then
  echo "ERRO: Nenhum mapeamento encontrado para ${API_DOMAIN}." >&2
  exit 1
fi
echo "[2/7 OK] HTTP API: ${API_ID} (stage: ${STAGE_NAME})"

# 3. Garantir DynamoDB e S3 Privado + CORS
if ! aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "[DynamoDB] Criando tabela ${TABLE_NAME}..."
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$REGION"
fi

if ! aws s3api head-bucket --bucket "$BUCKET_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "[S3] Criando bucket ${BUCKET_NAME}..."
  aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET_NAME" --region "$REGION" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# 4. Garantir App no AWS Amplify antes do Cognito para incluir também a URL preview no callback
AMP_APP_ID="$(aws amplify list-apps --region "$REGION" \
  --query "apps[?name=='${AMPLIFY_APP_NAME}'].appId | [0]" --output text)"
if [[ -z "$AMP_APP_ID" || "$AMP_APP_ID" == "None" ]]; then
  echo "[Amplify] Criando app ${AMPLIFY_APP_NAME}..."
  AMP_APP_ID="$(aws amplify create-app \
    --name "$AMPLIFY_APP_NAME" \
    --platform WEB \
    --custom-rules '[{"source":"</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/>","target":"/index.html","status":"200"}]' \
    --region "$REGION" \
    --query "app.appId" --output text)"
fi
if ! aws amplify get-branch --app-id "$AMP_APP_ID" --branch-name main --region "$REGION" >/dev/null 2>&1; then
  aws amplify create-branch --app-id "$AMP_APP_ID" --branch-name main --region "$REGION" >/dev/null
fi
AMPLIFY_PREVIEW_URL="https://main.${AMP_APP_ID}.amplifyapp.com"
echo "[3/7 OK] DynamoDB, S3 e Amplify App (${AMP_APP_ID}) prontos."

# Atualizar CORS do S3 incluindo o domínio customizado + Amplify preview + localhost
aws s3api put-bucket-cors --bucket "$BUCKET_NAME" --region "$REGION" --cors-configuration "{
  \"CORSRules\": [
    {
      \"AllowedOrigins\": [\"https://${APP_DOMAIN}\", \"${AMPLIFY_PREVIEW_URL}\", \"http://localhost:5173\"],
      \"AllowedMethods\": [\"GET\", \"PUT\", \"HEAD\"],
      \"AllowedHeaders\": [\"*\"],
      \"ExposeHeaders\": [\"ETag\"],
      \"MaxAgeSeconds\": 3000
    }
  ]
}"

# 5. Criar/atualizar App Client Cognito (sem mexer no app-guilhermeag da Av. 13)
CLIENT_ID="$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 60 --region "$REGION" \
  --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" --output text)"

CALLBACK_URLS=(
  "https://${APP_DOMAIN}"
  "https://${APP_DOMAIN}/callback"
  "${AMPLIFY_PREVIEW_URL}"
  "http://localhost:5173"
)
LOGOUT_URLS=(
  "https://${APP_DOMAIN}"
  "${AMPLIFY_PREVIEW_URL}"
  "http://localhost:5173"
)

if [[ -z "$CLIENT_ID" || "$CLIENT_ID" == "None" ]]; then
  CLIENT_ID="$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "$CLIENT_NAME" \
    --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --supported-identity-providers COGNITO \
    --allowed-o-auth-flows code \
    --allowed-o-auth-scopes openid email profile \
    --allowed-o-auth-flows-user-pool-client \
    --callback-urls "${CALLBACK_URLS[@]}" \
    --logout-urls "${LOGOUT_URLS[@]}" \
    --prevent-user-existence-errors ENABLED \
    --region "$REGION" \
    --query "UserPoolClient.ClientId" --output text)"
else
  aws cognito-idp update-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-id "$CLIENT_ID" \
    --client-name "$CLIENT_NAME" \
    --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --supported-identity-providers COGNITO \
    --allowed-o-auth-flows code \
    --allowed-o-auth-scopes openid email profile \
    --allowed-o-auth-flows-user-pool-client \
    --callback-urls "${CALLBACK_URLS[@]}" \
    --logout-urls "${LOGOUT_URLS[@]}" \
    --prevent-user-existence-errors ENABLED \
    --region "$REGION" >/dev/null
fi

aws cognito-idp create-managed-login-branding \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --use-cognito-provided-values \
  --region "$REGION" >/dev/null 2>&1 || true

echo "[4/7 OK] Cognito App Client '${CLIENT_NAME}': ${CLIENT_ID}"

# 6. Empacotar e publicar Lambda (Node.js 20 + LabRole)
BE_BUILD="${WORK_DIR}/backend"
mkdir -p "$BE_BUILD"
cp -r "${ROOT_DIR}/backend/src" "${ROOT_DIR}/backend/package.json" "${ROOT_DIR}/backend/package-lock.json" "$BE_BUILD/"
echo "[Lambda] Instalando dependências e empacotando..."
(cd "$BE_BUILD" && npm ci --omit=dev --silent && zip -rq function.zip src package.json node_modules)

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$LAMBDA_NAME" --zip-file "fileb://${BE_BUILD}/function.zip" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" --region "$REGION"
  aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --handler src/index.handler \
    --timeout 15 \
    --memory-size 256 \
    --environment "Variables={TABLE_NAME=${TABLE_NAME},BUCKET_NAME=${BUCKET_NAME}}" \
    --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" --region "$REGION"
else
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --handler src/index.handler \
    --timeout 15 \
    --memory-size 256 \
    --environment "Variables={TABLE_NAME=${TABLE_NAME},BUCKET_NAME=${BUCKET_NAME}}" \
    --zip-file "fileb://${BE_BUILD}/function.zip" \
    --region "$REGION" >/dev/null
  aws lambda wait function-active-v2 --function-name "$LAMBDA_NAME" --region "$REGION"
fi

LAMBDA_ARN="$(aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" \
  --query "Configuration.FunctionArn" --output text)"
aws lambda add-permission \
  --function-name "$LAMBDA_NAME" \
  --statement-id "apigw-projeto-final-${API_ID}" \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" \
  --region "$REGION" >/dev/null 2>&1 || true
echo "[5/7 OK] Lambda publicada: ${LAMBDA_NAME}"

# 7. Configurar CORS, JWT Authorizer e rotas REST no API Gateway (mantendo GET /dados!)
aws apigatewayv2 update-api \
  --api-id "$API_ID" \
  --cors-configuration "{\"AllowOrigins\":[\"https://${APP_DOMAIN}\",\"${AMPLIFY_PREVIEW_URL}\",\"http://localhost:5173\"],\"AllowMethods\":[\"GET\",\"POST\",\"PUT\",\"DELETE\",\"OPTIONS\"],\"AllowHeaders\":[\"authorization\",\"content-type\"],\"MaxAge\":86400}" \
  --region "$REGION" >/dev/null

INTEGRATION_ID="$(aws apigatewayv2 get-integrations --api-id "$API_ID" --region "$REGION" \
  --query "Items[?IntegrationUri=='${LAMBDA_ARN}'].IntegrationId | [0]" --output text)"
if [[ -z "$INTEGRATION_ID" || "$INTEGRATION_ID" == "None" ]]; then
  INTEGRATION_ID="$(aws apigatewayv2 create-integration \
    --api-id "$API_ID" \
    --integration-type AWS_PROXY \
    --integration-method POST \
    --integration-uri "$LAMBDA_ARN" \
    --payload-format-version 2.0 \
    --region "$REGION" \
    --query IntegrationId --output text)"
fi

ISSUER_URL="https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}"
JWT_CONFIG="{\"Issuer\":\"${ISSUER_URL}\",\"Audience\":[\"${CLIENT_ID}\"]}"
AUTH_ID="$(aws apigatewayv2 get-authorizers --api-id "$API_ID" --region "$REGION" \
  --query "Items[?Name=='${AUTH_NAME}'].AuthorizerId | [0]" --output text)"

if [[ -z "$AUTH_ID" || "$AUTH_ID" == "None" ]]; then
  AUTH_ID="$(aws apigatewayv2 create-authorizer \
    --api-id "$API_ID" \
    --name "$AUTH_NAME" \
    --authorizer-type JWT \
    --identity-source '$request.header.Authorization' \
    --jwt-configuration "$JWT_CONFIG" \
    --region "$REGION" \
    --query AuthorizerId --output text)"
else
  aws apigatewayv2 update-authorizer \
    --api-id "$API_ID" \
    --authorizer-id "$AUTH_ID" \
    --name "$AUTH_NAME" \
    --authorizer-type JWT \
    --identity-source '$request.header.Authorization' \
    --jwt-configuration "$JWT_CONFIG" \
    --region "$REGION" >/dev/null
fi

upsert_route() {
  local route_key="$1"
  local auth_mode="$2"
  local existing_id
  existing_id="$(aws apigatewayv2 get-routes --api-id "$API_ID" --region "$REGION" \
    --query "Items[?RouteKey=='${route_key}'].RouteId | [0]" --output text)"

  if [[ "$auth_mode" == "NONE" ]]; then
    if [[ -z "$existing_id" || "$existing_id" == "None" ]]; then
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$route_key" \
        --target "integrations/${INTEGRATION_ID}" --authorization-type NONE --region "$REGION" >/dev/null
    else
      aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$existing_id" \
        --target "integrations/${INTEGRATION_ID}" --authorization-type NONE --region "$REGION" >/dev/null
    fi
  else
    if [[ -z "$existing_id" || "$existing_id" == "None" ]]; then
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$route_key" \
        --target "integrations/${INTEGRATION_ID}" --authorization-type JWT --authorizer-id "$AUTH_ID" \
        --region "$REGION" >/dev/null
    else
      aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$existing_id" \
        --target "integrations/${INTEGRATION_ID}" --authorization-type JWT --authorizer-id "$AUTH_ID" \
        --region "$REGION" >/dev/null
    fi
  fi
}

upsert_route "GET /health" "NONE"
upsert_route "GET /me" "JWT"
upsert_route "GET /projects" "JWT"
upsert_route "POST /projects" "JWT"
upsert_route "GET /projects/{projectId}" "JWT"
upsert_route "PUT /projects/{projectId}" "JWT"
upsert_route "DELETE /projects/{projectId}" "JWT"
upsert_route "GET /tasks" "JWT"
upsert_route "POST /tasks" "JWT"
upsert_route "GET /tasks/{taskId}" "JWT"
upsert_route "PUT /tasks/{taskId}" "JWT"
upsert_route "DELETE /tasks/{taskId}" "JWT"
upsert_route "POST /tasks/{taskId}/attachments/upload-url" "JWT"
upsert_route "GET /tasks/{taskId}/attachments/{attachmentId}/download-url" "JWT"
upsert_route "DELETE /tasks/{taskId}/attachments/{attachmentId}" "JWT"

AUTO_DEPLOY="$(aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name "$STAGE_NAME" --region "$REGION" \
  --query "AutoDeploy" --output text)"
if [[ "$AUTO_DEPLOY" != "True" && "$AUTO_DEPLOY" != "true" ]]; then
  aws apigatewayv2 create-deployment --api-id "$API_ID" --stage-name "$STAGE_NAME" --region "$REGION" >/dev/null
fi
echo "[6/7 OK] API Gateway configurado (15 rotas REST + JWT Authorizer + CORS)."

# 8. Build e Deploy do Frontend direto no AWS Amplify + Vínculo DNS raiz
FE_BUILD="${WORK_DIR}/frontend"
cp -r "${ROOT_DIR}/frontend" "$FE_BUILD"
cat > "${FE_BUILD}/.env.production" <<EOF
VITE_API_URL=https://${API_DOMAIN}
VITE_COGNITO_DOMAIN=${COGNITO_DOMAIN}
VITE_COGNITO_CLIENT_ID=${CLIENT_ID}
VITE_COGNITO_USER_POOL_ID=${POOL_ID}
EOF

echo "[Amplify] Compilando React + Vite..."
(cd "$FE_BUILD" && npm ci --silent && npm run build)
(cd "${FE_BUILD}/dist" && zip -rq "${FE_BUILD}/dist.zip" .)

DEPLOY_JSON="$(aws amplify create-deployment --app-id "$AMP_APP_ID" --branch-name main --region "$REGION")"
JOB_ID="$(echo "$DEPLOY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")"
UPLOAD_URL="$(echo "$DEPLOY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['zipUploadUrl'])")"
curl -fsS -X PUT -T "${FE_BUILD}/dist.zip" "$UPLOAD_URL"
aws amplify start-deployment --app-id "$AMP_APP_ID" --branch-name main --job-id "$JOB_ID" --region "$REGION" >/dev/null

echo "[Amplify] Aguardando publicação..."
for _ in $(seq 1 20); do
  JOB_STATUS="$(aws amplify get-job --app-id "$AMP_APP_ID" --branch-name main --job-id "$JOB_ID" --region "$REGION" \
    --query "job.summary.status" --output text)"
  if [[ "$JOB_STATUS" == "SUCCEED" ]]; then
    break
  elif [[ "$JOB_STATUS" == "FAILED" ]]; then
    echo "ERRO: Deploy no Amplify falhou." >&2
    exit 1
  fi
  sleep 3
done

if ! aws amplify get-domain-association --app-id "$AMP_APP_ID" --domain-name "$APP_DOMAIN" --region "$REGION" >/dev/null 2>&1; then
  echo "[Amplify] Vinculando domínio raiz ${APP_DOMAIN} via Route 53 + ACM..."
  aws amplify create-domain-association \
    --app-id "$AMP_APP_ID" \
    --domain-name "$APP_DOMAIN" \
    --sub-domain-settings '[{"prefix":"","branchName":"main"}]' \
    --region "$REGION" >/dev/null || echo "[AVISO] Não foi possível vincular domínio automaticamente; verifique no console do Amplify."
fi
DOMAIN_STATUS="$(aws amplify get-domain-association --app-id "$AMP_APP_ID" --domain-name "$APP_DOMAIN" --region "$REGION" \
  --query "domainAssociation.domainStatus" --output text 2>/dev/null || echo "VERIFICAR_NO_CONSOLE")"

echo "[7/7 OK] Frontend publicado no AWS Amplify! (Status DNS/SSL: ${DOMAIN_STATUS})"

echo ""
echo "================ SMOKE TESTS AO VIVO ================"
echo " GET /health (pública)           -> HTTP $(curl -s -o /dev/null -w '%{http_code}' "https://${API_DOMAIN}/health") (esperado: 200)"
echo " GET /tasks  (sem JWT)           -> HTTP $(curl -s -o /dev/null -w '%{http_code}' "https://${API_DOMAIN}/tasks") (esperado: 401)"
echo " GET /dados  (Av. 12 preservada) -> HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: guilhermeag" "https://${API_DOMAIN}/dados") (esperado: 200)"
echo "====================================================="
echo " URL Customizada (DNS) : https://${APP_DOMAIN}"
echo " URL Imediata Amplify  : ${AMPLIFY_PREVIEW_URL}"
echo " API Customizada (DNS) : https://${API_DOMAIN}"
echo "====================================================="
