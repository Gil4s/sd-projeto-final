#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Provisionamento Idempotente — Projeto Final de Sistemas Distribuídos (UFERSA)
# Executar no AWS CloudShell (região us-east-1) a partir da raiz do repositório.
# Preserva 100% intactas a rota GET /dados (Av. 12) e o client app-guilhermeag (Av. 13).
# ==============================================================================

REGION="${AWS_REGION:-us-east-1}"
APP_DOMAIN="guilhermeag.grupo-06.sd.ufersa.dev.br"
API_DOMAIN="api.guilhermeag.grupo-06.sd.ufersa.dev.br"
POOL_NAME="pool-guilhermeag"
CLIENT_NAME="app-projeto-final"
TABLE_NAME="sd-projeto-final-guilhermeag"
LAMBDA_NAME="sd-projeto-final-api"
AUTH_NAME="cognito-projeto-final"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/LabRole"
BUCKET_NAME="sd-projeto-final-anexos-guilhermeag-${ACCOUNT_ID}"

echo "============================================================"
echo " Conta AWS : ${ACCOUNT_ID}"
echo " Região    : ${REGION}"
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
  echo "[Cognito] Criando domínio Hosted UI: ${COGNITO_DOMAIN_PREFIX}"
  aws cognito-idp create-user-pool-domain --user-pool-id "$POOL_ID" --domain "$COGNITO_DOMAIN_PREFIX" --region "$REGION"
fi
COGNITO_DOMAIN="https://${COGNITO_DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"
echo "[OK] Cognito Pool: ${POOL_ID} (${COGNITO_DOMAIN})"

# 2. Descobrir HTTP API existente mapeada em api.guilhermeag.grupo-06.sd.ufersa.dev.br
API_ID="$(aws apigatewayv2 get-api-mappings --domain-name "$API_DOMAIN" --region "$REGION" \
  --query "Items[0].ApiId" --output text)"
STAGE_NAME="$(aws apigatewayv2 get-api-mappings --domain-name "$API_DOMAIN" --region "$REGION" \
  --query "Items[0].Stage" --output text)"
if [[ -z "$API_ID" || "$API_ID" == "None" ]]; then
  echo "ERRO: Nenhum mapeamento encontrado para ${API_DOMAIN} no API Gateway v2." >&2
  exit 1
fi
echo "[OK] HTTP API existente: ${API_ID} (stage: ${STAGE_NAME})"

# 3. Tabela DynamoDB (Single-Table: PK = USER#sub, SK = PROJECT#id | TASK#id)
if aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "[OK] Tabela DynamoDB já existe: ${TABLE_NAME}"
else
  echo "[DynamoDB] Criando tabela ${TABLE_NAME} (PAY_PER_REQUEST)..."
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$REGION"
  echo "[OK] Tabela DynamoDB criada e ativa."
fi

# 4. Bucket S3 100% Privado + CORS para upload/download via Presigned URLs
if aws s3api head-bucket --bucket "$BUCKET_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "[OK] Bucket S3 já existe: ${BUCKET_NAME}"
else
  echo "[S3] Criando bucket privado ${BUCKET_NAME}..."
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  fi
fi

aws s3api put-public-access-block --bucket "$BUCKET_NAME" --region "$REGION" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

aws s3api put-bucket-cors --bucket "$BUCKET_NAME" --region "$REGION" --cors-configuration "{
  \"CORSRules\": [
    {
      \"AllowedOrigins\": [\"https://${APP_DOMAIN}\", \"http://localhost:5173\"],
      \"AllowedMethods\": [\"GET\", \"PUT\", \"HEAD\"],
      \"AllowedHeaders\": [\"*\"],
      \"ExposeHeaders\": [\"ETag\"],
      \"MaxAgeSeconds\": 3000
    }
  ]
}"
echo "[OK] Bucket S3 privado + CORS configurados."

# 5. App Client dedicado no Cognito (Authorization Code + PKCE, sem mexer na Av. 13)
CLIENT_ID="$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 60 --region "$REGION" \
  --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" --output text)"

CALLBACK_URLS=(
  "https://${APP_DOMAIN}"
  "https://${APP_DOMAIN}/callback"
  "http://localhost:5173"
  "http://localhost:5173/callback"
)
LOGOUT_URLS=(
  "https://${APP_DOMAIN}"
  "http://localhost:5173"
)

if [[ -z "$CLIENT_ID" || "$CLIENT_ID" == "None" ]]; then
  echo "[Cognito] Criando App Client '${CLIENT_NAME}'..."
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
  echo "[Cognito] Atualizando App Client existente '${CLIENT_NAME}' (${CLIENT_ID})..."
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

# Garante estilo padrão do Managed Login v2 (caso o User Pool use Managed Login Essentials)
aws cognito-idp create-managed-login-branding \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --use-cognito-provided-values \
  --region "$REGION" >/dev/null 2>&1 || true

echo "[OK] Cognito App Client pronto: ${CLIENT_ID}"

# 6. Empacotar e publicar AWS Lambda (Node.js 20 + LabRole)
echo "[Lambda] Instalando dependências de produção e gerando pacote..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

cp -r "${ROOT_DIR}/backend/src" "${ROOT_DIR}/backend/package.json" "$BUILD_DIR/"
if [[ -f "${ROOT_DIR}/backend/package-lock.json" ]]; then
  cp "${ROOT_DIR}/backend/package-lock.json" "$BUILD_DIR/"
  (cd "$BUILD_DIR" && npm ci --omit=dev --silent)
else
  (cd "$BUILD_DIR" && npm install --omit=dev --silent)
fi
(cd "$BUILD_DIR" && zip -rq function.zip src package.json node_modules)

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "[Lambda] Atualizando código de ${LAMBDA_NAME}..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --zip-file "fileb://${BUILD_DIR}/function.zip" \
    --region "$REGION" >/dev/null
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
  echo "[Lambda] Criando função ${LAMBDA_NAME}..."
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --handler src/index.handler \
    --timeout 15 \
    --memory-size 256 \
    --environment "Variables={TABLE_NAME=${TABLE_NAME},BUCKET_NAME=${BUCKET_NAME}}" \
    --zip-file "fileb://${BUILD_DIR}/function.zip" \
    --region "$REGION" >/dev/null
  aws lambda wait function-active-v2 --function-name "$LAMBDA_NAME" --region "$REGION"
fi

LAMBDA_ARN="$(aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" \
  --query "Configuration.FunctionArn" --output text)"
echo "[OK] Lambda ativa: ${LAMBDA_ARN}"

# Permissão para API Gateway invocar a Lambda
aws lambda add-permission \
  --function-name "$LAMBDA_NAME" \
  --statement-id "apigw-projeto-final-${API_ID}" \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" \
  --region "$REGION" >/dev/null 2>&1 || true

# 7. Configurar CORS, Integração, JWT Authorizer e Rotas na HTTP API (preservando GET /dados!)
echo "[API Gateway] Configurando CORS na HTTP API ${API_ID}..."
aws apigatewayv2 update-api \
  --api-id "$API_ID" \
  --cors-configuration "{\"AllowOrigins\":[\"https://${APP_DOMAIN}\",\"http://localhost:5173\"],\"AllowMethods\":[\"GET\",\"POST\",\"PUT\",\"DELETE\",\"OPTIONS\"],\"AllowHeaders\":[\"authorization\",\"content-type\"],\"MaxAge\":86400}" \
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
echo "[OK] Integração Lambda: ${INTEGRATION_ID}"

ISSUER_URL="https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}"
AUTH_ID="$(aws apigatewayv2 get-authorizers --api-id "$API_ID" --region "$REGION" \
  --query "Items[?Name=='${AUTH_NAME}'].AuthorizerId | [0]" --output text)"

JWT_CONFIG="{\"Issuer\":\"${ISSUER_URL}\",\"Audience\":[\"${CLIENT_ID}\"]}"
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
echo "[OK] JWT Authorizer (${AUTH_NAME}): ${AUTH_ID}"

upsert_route() {
  local route_key="$1"
  local auth_mode="$2" # NONE ou JWT
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
  echo "  [ROTA ${auth_mode}] ${route_key}"
}

echo "[API Gateway] Registrando rotas REST (GET /dados mantida intacta)..."
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

# 8. Smoke tests ao vivo
echo ""
echo "================ SMOKE TESTS AO VIVO ================"
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://${API_DOMAIN}/health")"
UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://${API_DOMAIN}/tasks")"
AV12_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: guilhermeag" "https://${API_DOMAIN}/dados")"
echo " GET /health (pública)           -> HTTP ${HEALTH_CODE} (esperado: 200)"
echo " GET /tasks  (sem JWT)           -> HTTP ${UNAUTH_CODE} (esperado: 401)"
echo " GET /dados  (Av. 12 preservada) -> HTTP ${AV12_CODE} (esperado: 200)"

echo ""
echo "============================================================"
echo " VARIÁVEIS DE AMBIENTE PARA O FRONTEND / AWS AMPLIFY"
echo "============================================================"
echo "VITE_API_URL=https://${API_DOMAIN}"
echo "VITE_COGNITO_DOMAIN=${COGNITO_DOMAIN}"
echo "VITE_COGNITO_CLIENT_ID=${CLIENT_ID}"
echo "VITE_COGNITO_USER_POOL_ID=${POOL_ID}"
echo "============================================================"
