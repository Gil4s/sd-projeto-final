# TaskCloud — Projeto Final de Sistemas Distribuídos (UFERSA)

**Discente:** Guilherme Aguiar (`guilhermeag`, Grupo 06)  
**Docente:** Prof. Walber  
**Apresentação:** 27/11/2026

## Arquitetura em Três Camadas (100% Serverless na AWS)

1. **Camada de Apresentação:** SPA React + TypeScript + Vite hospedada no **AWS Amplify** com HTTPS automático via ACM/Route 53 em `https://guilhermeag.grupo-06.sd.ufersa.dev.br`.
2. **Camada de Negócios (API REST baseada em recursos):** **Amazon API Gateway (HTTP API)** em `https://api.guilhermeag.grupo-06.sd.ufersa.dev.br` integrada à função **AWS Lambda** (`sd-projeto-final-api`, Node.js 20, `LabRole`).
3. **Camada de Dados:**
   - **Amazon DynamoDB** (`sd-projeto-final-guilhermeag`): modelagem Single-Table (`PK = USER#<sub>`, `SK = PROJECT#<id> | TASK#<id>`) garantindo isolamento estrito por usuário autenticado.
   - **Amazon S3 Privado** (`sd-projeto-final-anexos-guilhermeag-737116127842`): armazenamento de anexos com bloqueio total de acesso público, acessado exclusivamente via **Presigned URLs** temporárias (`PUT` e `GET` de 5 min) emitidas pela Lambda após validação de posse.
4. **Autenticação e Autorização:** **Amazon Cognito** (`pool-guilhermeag`, OAuth 2.0 Authorization Code + PKCE) + **JWT Authorizer** no API Gateway bloqueando chamadas sem token com `401 Unauthorized` + validação de proprietário (`sub`) em todas as operações no banco.

## Endpoints REST

- `GET /health` — Saúde da API (pública)
- `GET /me` — Dados do usuário autenticado (claims JWT) e estatísticas
- `GET /projects`, `POST /projects`, `GET /projects/{projectId}`, `PUT /projects/{projectId}`, `DELETE /projects/{projectId}`
- `GET /tasks`, `POST /tasks`, `GET /tasks/{taskId}`, `PUT /tasks/{taskId}`, `DELETE /tasks/{taskId}`
- `POST /tasks/{taskId}/attachments/upload-url` — Gera URL pré-assinada `PUT` para upload direto ao S3
- `GET /tasks/{taskId}/attachments/{attachmentId}/download-url` — Gera URL pré-assinada `GET` temporária
- `DELETE /tasks/{taskId}/attachments/{attachmentId}` — Remove objeto no S3 e metadado no DynamoDB

> A rota `GET /dados` da Avaliação 12 é mantida intacta na mesma HTTP API.

## Configuração na AWS (Console)

1. **DynamoDB:** criar tabela `sd-projeto-final-guilhermeag` com Partition Key `PK` (`String`) e Sort Key `SK` (`String`), modo *On-demand*.
2. **S3:** criar bucket privado `sd-projeto-final-anexos-guilhermeag-737116127842` (*Block all public access* ligado) e configurar CORS para `https://guilhermeag.grupo-06.sd.ufersa.dev.br`.
3. **Cognito:** no User Pool `pool-guilhermeag`, criar App Client público `app-projeto-final` (Authorization code grant, escopos `openid`, `email`, `profile`, callback/logout `https://guilhermeag.grupo-06.sd.ufersa.dev.br`).
4. **Lambda:** criar função `sd-projeto-final-api` (Node.js 20, role `LabRole`, handler `src/index.handler`), enviar o `.zip` do `backend/` e definir `TABLE_NAME` e `BUCKET_NAME`.
5. **API Gateway (HTTP API):** na API mapeada em `api.guilhermeag.grupo-06.sd.ufersa.dev.br`, configurar CORS, criar JWT Authorizer apontando para o Cognito e registrar as rotas REST (mantendo `GET /dados` intacta).
6. **AWS Amplify:** conectar o repositório `Gil4s/sd-projeto-final`, configurar as variáveis `VITE_*` e vincular o domínio raiz `guilhermeag.grupo-06.sd.ufersa.dev.br`.

## Roteiro Rápido de Apresentação (27/11/2026)

1. Abrir `https://guilhermeag.grupo-06.sd.ufersa.dev.br` (HTTPS + DNS Route 53).
2. Ainda deslogado, clicar em **"Chamar GET /tasks sem token"** e mostrar `HTTP 401 Unauthorized` em `api.guilhermeag.grupo-06.sd.ufersa.dev.br/tasks` (e `200 OK` em `/health`).
3. Clicar em **"Entrar com AWS Cognito"** e mostrar o redirecionamento para o Cognito Hosted UI (OAuth2 + PKCE).
4. Criar um projeto, criar uma tarefa, mover no Kanban e anexar um arquivo (mostrando o upload direto via Presigned URL para o S3 privado e o download seguro).
5. Abrir **"Demo SD / JWT"** para exibir as 3 camadas, o token JWT decodificado (`sub`, `email`, `iss`), e disparar `GET /me` (`200 OK`) vs `GET /tasks` sem token (`401 Unauthorized`).
6. *(Opcional)* Criar uma 2ª conta no Cognito para comprovar o isolamento multi-usuário (`PK = USER#<sub>`).
