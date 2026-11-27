# TaskCloud — Projeto Final de Sistemas Distribuídos (UFERSA)

**Discente:** Guilherme Aguiar (`guilhermeag`, Grupo 06)  
**Docente:** Prof. Walber  
**Apresentação:** 27/11/2026

## Arquitetura em Três Camadas (100% Serverless na AWS)

1. **Camada de Apresentação:** SPA React + TypeScript + Vite (Quadro Kanban interativo) hospedada no **AWS Amplify** com HTTPS automático via **Route 53 + ACM** em `https://guilhermeag.grupo-06.sd.ufersa.dev.br`.
2. **Camada de Negócios (API REST baseada em recursos):** **Amazon API Gateway (HTTP API)** em `https://api.guilhermeag.grupo-06.sd.ufersa.dev.br` integrada à função **AWS Lambda** (`sd-projeto-final-api`, Node.js 20, `LabRole`).
3. **Camada de Dados:** **Amazon DynamoDB** (`sd-projeto-final-guilhermeag`) com chave composta (`PK = USER#<sub>`, `SK = TASK#<id>`), garantindo isolamento estrito dos dados por usuário autenticado.
4. **Autenticação e Autorização:** **Amazon Cognito** (`pool-guilhermeag`, OAuth 2.0 Authorization Code + PKCE) + **JWT Authorizer** no API Gateway bloqueando chamadas sem token com `401 Unauthorized` + validação de proprietário (`sub`) em todas as operações no banco.

## Endpoints REST (7 rotas)

- `GET /health` — Saúde da API e resumo da arquitetura (**pública**)
- `GET /me` — Dados do usuário autenticado (claims JWT) e estatísticas (**JWT**)
- `GET /tasks` — Lista todas as tarefas do usuário autenticado (**JWT**)
- `POST /tasks` — Cria uma nova tarefa no DynamoDB (**JWT**)
- `GET /tasks/{taskId}` — Retorna detalhes de uma tarefa (**JWT**)
- `PUT /tasks/{taskId}` — Atualiza tarefa ou move de coluna no Kanban (**JWT**)
- `DELETE /tasks/{taskId}` — Exclui uma tarefa (**JWT**)

## Deploy (AWS CloudShell)

```bash
cd ~/sd-projeto-final && git pull origin main && bash infra/deploy-all.sh
```

## Roteiro Rápido de Apresentação

1. Abrir `https://guilhermeag.grupo-06.sd.ufersa.dev.br` (HTTPS + DNS Route 53).
2. Ainda deslogado, clicar em **"Chamar GET /tasks sem token"** (`401 Unauthorized`) e **"GET /health"** (`200 OK`).
3. Clicar em **"Entrar com AWS Cognito"** e autenticar na Hosted UI (OAuth 2.0 + PKCE).
4. Criar uma tarefa, arrastar o card entre as colunas do Kanban e mostrar o item salvo no **DynamoDB** com `PK = USER#<sub>`.
5. Abrir **"Demo SD / JWT"** para exibir as 3 camadas, o token JWT decodificado (`sub`, `email`, `iss`) e testar `GET /me` (`200 OK`) vs `GET /tasks` sem JWT (`401 Unauthorized`).
