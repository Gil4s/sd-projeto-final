#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Deploy Completo do Zero — TaskCloud (Projeto Final SD - UFERSA)
# Executar no AWS CloudShell (região us-east-1).
# Cria/reaproveita: Route 53, ACM SSL, Cognito User Pool + Usuário + Client,
# DynamoDB, S3 Privado + CORS, Lambda (LabRole), API Gateway HTTP + DNS custom,
# e AWS Amplify Frontend + DNS raiz.
# ==============================================================================

REGION="${AWS_REGION:-us-east-1}"
APP_DOMAIN="guilhermeag.grupo-06.sd.ufersa.dev.br"
API_DOMAIN="api.guilhermeag.grupo-06.sd.ufersa.dev.br"
POOL_NAME="pool-guilhermeag"
CLIENT_NAME="app-projeto-final"
TABLE_NAME="sd-projeto-final-guilhermeag"
LAMBDA_NAME="sd-projeto-final-api"
AUTH_NAME="cognito-projeto-final"
HTTP_API_NAME="sd-projeto-final-http-api"
AMPLIFY_APP_NAME="taskcloud-guilhermeag"
DEMO_EMAIL="guilherme.aguiar@alunos.ufersa.edu.br"
DEMO_PASSWORD="${DEMO_PASSWORD:-Ufersa2026!}"

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

# 1. Descobrir Zona Hospedada no Route 53
HOSTED_ZONE_ID="$(aws route53 list-hosted-zones-by-name --dns-name "${APP_DOMAIN}." \
  --query "HostedZones[?Name=='${APP_DOMAIN}.'].Id | [0]" --output text)"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID#/hostedzone/}"
if [[ -z "$HOSTED_ZONE_ID" || "$HOSTED_ZONE_ID" == "None" ]]; then
  echo "ERRO: Hosted Zone '${APP_DOMAIN}' não encontrada no Route 53." >&2
  exit 1
fi
echo "[1/9 OK] Route 53 Hosted Zone: ${HOSTED_ZONE_ID}"

# 2. Criar/reaproveitar Cognito User Pool + Domínio Hosted UI + Usuário padrão
POOL_ID="$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text)"

if [[ -z "$POOL_ID" || "$POOL_ID" == "None" ]]; then
  echo "[Cognito] Criando User Pool '${POOL_NAME}'..."
  POOL_ID="$(aws cognito-idp create-user-pool \
    --pool-name "$POOL_NAME" \
    --username-attributes email \
    --auto-verified-attributes email \
    --policies '{"PasswordPolicy":{"MinimumLength":8,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":false}}' \
    --region "$REGION" \
    --query "UserPool.Id" --output text)"
fi

COGNITO_DOMAIN_PREFIX="$(aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" --region "$REGION" \
  --query "UserPool.Domain" --output text)"
if [[ -z "$COGNITO_DOMAIN_PREFIX" || "$COGNITO_DOMAIN_PREFIX" == "None" ]]; then
  COGNITO_DOMAIN_PREFIX="taskcloud-guilhermeag-${ACCOUNT_ID:0:6}"
  echo "[Cognito] Criando domínio Hosted UI: ${COGNITO_DOMAIN_PREFIX}"
  aws cognito-idp create-user-pool-domain \
    --user-pool-id "$POOL_ID" \
    --domain "$COGNITO_DOMAIN_PREFIX" \
    --region "$REGION" >/dev/null
fi
COGNITO_DOMAIN="https://${COGNITO_DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"

# Garantir usuário pronto para login imediato na apresentação
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username "$DEMO_EMAIL" \
  --user-attributes "Name=email,Value=${DEMO_EMAIL}" "Name=email_verified,Value=true" \
  --message-action SUPPRESS \
  --region "$REGION" >/dev/null 2>&1 || true
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username "$DEMO_EMAIL" \
  --password "$DEMO_PASSWORD" \
  --permanent \
  --region "$REGION" >/dev/null
echo "[2/9 OK] Cognito Pool: ${POOL_ID} (${COGNITO_DOMAIN})"

# 3. Certificado ACM + Validação DNS no Route 53 para api.guilhermeag...
CERT_ARN="$(aws acm list-certificates --certificate-statuses ISSUED PENDING_VALIDATION --region "$REGION" \
  --query "CertificateSummaryList[?DomainName=='${API_DOMAIN}'].CertificateArn | [0]" --output text)"

if [[ -z "$CERT_ARN" || "$CERT_ARN" == "None" ]]; then
  echo "[ACM] Solicitando certificado HTTPS para ${API_DOMAIN}..."
  CERT_ARN="$(aws acm request-certificate \
    --domain-name "$API_DOMAIN" \
    --validation-method DNS \
    --region "$REGION" \
    --query "CertificateArn" --output text)"
fi

CERT_STATUS="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$REGION" \
  --query "Certificate.Status" --output text)"

if [[ "$CERT_STATUS" != "ISSUED" ]]; then
  echo "[ACM] Aguardando registro CNAME de validação DNS..."
  VAL_NAME=""
  VAL_VALUE=""
  for _ in $(seq 1 15); do
    VAL_NAME="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$REGION" \
      --query "Certificate.DomainValidationOptions[0].ResourceRecord.Name" --output text)"
    VAL_VALUE="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$REGION" \
      --query "Certificate.DomainValidationOptions[0].ResourceRecord.Value" --output text)"
    if [[ -n "$VAL_NAME" && "$VAL_NAME" != "None" ]]; then
      break
    fi
    sleep 2
  done

  aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "{
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"${VAL_NAME}\",
        \"Type\": \"CNAME\",
        \"TTL\": 300,
        \"ResourceRecords\": [{\"Value\": \"${VAL_VALUE}\"}]
      }
    }]
  }" >/dev/null

  echo "[ACM] Validando certificado via Route 53 (leva ~30 a 60 segundos)..."
  aws acm wait certificate-validated --certificate-arn "$CERT_ARN" --region "$REGION"
fi
echo "[3/9 OK] Certificado SSL emitido: ${CERT_ARN}"

# 4. Garantir DynamoDB e S3 Privado
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
  echo "[S3] Criando bucket privado ${BUCKET_NAME}..."
  aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET_NAME" --region "$REGION" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# 5. Garantir App no AWS Amplify (antes do Cognito para liberar URL preview no callback)
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

aws s3api put-bucket-cors --bucket "$BUCKET_NAME" --region "$REGION" --cors-configuration "{
  \"CORSRules\": [{
    \"AllowedOrigins\": [\"https://${APP_DOMAIN}\", \"${AMPLIFY_PREVIEW_URL}\", \"http://localhost:5173\"],
    \"AllowedMethods\": [\"GET\", \"PUT\", \"HEAD\"],
    \"AllowedHeaders\": [\"*\"],
    \"ExposeHeaders\": [\"ETag\"],
    \"MaxAgeSeconds\": 3000
  }]
}"
echo "[4/9 OK] DynamoDB, S3 privado + CORS e Amplify App (${AMP_APP_ID}) prontos."

# 6. Criar/atualizar App Client Cognito (OAuth2 Authorization Code + PKCE)
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
echo "[5/9 OK] Cognito App Client '${CLIENT_NAME}': ${CLIENT_ID}"

# 7. Empacotar e publicar AWS Lambda (Node.js 20 + LabRole)
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
echo "[6/9 OK] Lambda publicada: ${LAMBDA_NAME}"

# 8. Criar/reaproveitar HTTP API + Custom Domain + DNS ALIAS + Rotas REST + JWT Authorizer
API_ID="$(aws apigatewayv2 get-api-mappings --domain-name "$API_DOMAIN" --region "$REGION" \
  --query "Items[0].ApiId" --output text 2>/dev/null || true)"
STAGE_NAME="$(aws apigatewayv2 get-api-mappings --domain-name "$API_DOMAIN" --region "$REGION" \
  --query "Items[0].Stage" --output text 2>/dev/null || true)"

if [[ -z "$API_ID" || "$API_ID" == "None" ]]; then
  API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
    --query "Items[?Name=='${HTTP_API_NAME}'].ApiId | [0]" --output text)"
fi

if [[ -z "$API_ID" || "$API_ID" == "None" ]]; then
  echo "[API Gateway] Criando HTTP API '${HTTP_API_NAME}'..."
  API_ID="$(aws apigatewayv2 create-api \
    --name "$HTTP_API_NAME" \
    --protocol-type HTTP \
    --region "$REGION" \
    --query "ApiId" --output text)"
fi

if [[ -z "${STAGE_NAME:-}" || "${STAGE_NAME:-}" == "None" ]]; then
  STAGE_NAME='$default'
fi

if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name "$STAGE_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name "$STAGE_NAME" --auto-deploy --region "$REGION" >/dev/null
fi

aws lambda add-permission \
  --function-name "$LAMBDA_NAME" \
  --statement-id "apigw-projeto-final-${API_ID}" \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" \
  --region "$REGION" >/dev/null 2>&1 || true

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

# Custom Domain + API Mapping + Registro A ALIAS no Route 53
if ! aws apigatewayv2 get-domain-name --domain-name "$API_DOMAIN" --region "$REGION" >/dev/null 2>&1; then
  echo "[API Gateway] Criando Custom Domain ${API_DOMAIN}..."
  aws apigatewayv2 create-domain-name \
    --domain-name "$API_DOMAIN" \
    --domain-name-configurations "CertificateArn=${CERT_ARN},EndpointType=REGIONAL,SecurityPolicy=TLS_1_2" \
    --region "$REGION" >/dev/null
fi

EXISTING_MAP="$(aws apigatewayv2 get-api-mappings --domain-name "$API_DOMAIN" --region "$REGION" \
  --query "Items[?ApiId=='${API_ID}'].ApiMappingId | [0]" --output text)"
if [[ -z "$EXISTING_MAP" || "$EXISTING_MAP" == "None" ]]; then
  aws apigatewayv2 create-api-mapping \
    --domain-name "$API_DOMAIN" \
    --api-id "$API_ID" \
    --stage "$STAGE_NAME" \
    --region "$REGION" >/dev/null
fi

APIGW_TARGET_DOMAIN="$(aws apigatewayv2 get-domain-name --domain-name "$API_DOMAIN" --region "$REGION" \
  --query "DomainNameConfigurations[0].ApiGatewayDomainName" --output text)"
APIGW_TARGET_ZONE="$(aws apigatewayv2 get-domain-name --domain-name "$API_DOMAIN" --region "$REGION" \
  --query "DomainNameConfigurations[0].HostedZoneId" --output text)"

aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "{
  \"Changes\": [{
    \"Action\": \"UPSERT\",
    \"ResourceRecordSet\": {
      \"Name\": \"${API_DOMAIN}.\",
      \"Type\": \"A\",
      \"AliasTarget\": {
        \"HostedZoneId\": \"${APIGW_TARGET_ZONE}\",
        \"DNSName\": \"${APIGW_TARGET_DOMAIN}\",
        \"EvaluateTargetHealth\": false
      }
    }
  }]
}" >/dev/null
echo "[7/9 OK] API Gateway HTTP + 15 rotas REST + DNS ${API_DOMAIN} configurados."

# 9. Build e Deploy do Frontend no AWS Amplify + Domínio Raiz
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
for _ in $(seq 1 25); do
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
echo "[8/9 OK] Frontend publicado no AWS Amplify!"

if ! aws amplify get-domain-association --app-id "$AMP_APP_ID" --domain-name "$APP_DOMAIN" --region "$REGION" >/dev/null 2>&1; then
  echo "[Amplify] Vinculando domínio raiz ${APP_DOMAIN} via Route 53 + ACM..."
  aws amplify create-domain-association \
    --app-id "$AMP_APP_ID" \
    --domain-name "$APP_DOMAIN" \
    --sub-domain-settings '[{"prefix":"","branchName":"main"}]' \
    --region "$REGION" >/dev/null || echo "[AVISO] Verifique o vínculo do domínio no console do Amplify."
fi
DOMAIN_STATUS="$(aws amplify get-domain-association --app-id "$AMP_APP_ID" --domain-name "$APP_DOMAIN" --region "$REGION" \
  --query "domainAssociation.domainStatus" --output text 2>/dev/null || echo "VERIFICAR_NO_CONSOLE")"
echo "[9/9 OK] Domínio Amplify (${APP_DOMAIN}): ${DOMAIN_STATUS}"

echo ""
echo "================ SMOKE TESTS AO VIVO ================"
sleep 5
HEALTH_CODE="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "https://${API_DOMAIN}/health" || echo "DNS_PROPAGANDO")"
UNAUTH_CODE="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "https://${API_DOMAIN}/tasks" || echo "DNS_PROPAGANDO")"
echo " GET /health (pública)  -> HTTP ${HEALTH_CODE} (esperado: 200)"
echo " GET /tasks  (sem JWT)  -> HTTP ${UNAUTH_CODE} (esperado: 401)"
echo "====================================================="
echo " URL Customizada (DNS)  : https://${APP_DOMAIN}"
echo " URL Imediata Amplify   : ${AMPLIFY_PREVIEW_URL}"
echo " API Customizada (DNS)  : https://${API_DOMAIN}"
echo "-----------------------------------------------------"
echo " Login pronto no Cognito:"
echo "   E-mail : ${DEMO_EMAIL}"
echo "   Senha  : ${DEMO_PASSWORD}"
echo "====================================================="
