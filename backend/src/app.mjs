import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const VALID_STATUSES = new Set(['todo', 'doing', 'done']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high']);

function jsonResponse(statusCode, payload) {
  if (statusCode === 204) {
    return { statusCode: 204 };
  }
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(payload),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Body must be a JSON object');
    }
    return parsed;
  } catch {
    const err = new Error('Corpo da requisição deve ser um JSON válido.');
    err.statusCode = 400;
    throw err;
  }
}

function extractUser(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  if (!claims || !claims.sub) {
    return null;
  }
  return {
    sub: String(claims.sub),
    email: claims.email ? String(claims.email) : null,
    username: String(claims['cognito:username'] || claims.username || claims.sub),
    tokenUse: claims.token_use ? String(claims.token_use) : null,
    scope: claims.scope ? String(claims.scope) : null,
    authTime: claims.auth_time ? Number(claims.auth_time) : null,
    exp: claims.exp ? Number(claims.exp) : null,
  };
}

function isValidIsoDate(val) {
  if (val === null || val === undefined || val === '') return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(val));
}

function stripInternalKeys(item) {
  if (!item) return null;
  const {
    PK: _pk,
    SK: _sk,
    entityType: _et,
    projectId: _pid,
    attachments: _att,
    ...rest
  } = item;
  return rest;
}

function matchRoute(method, rawPath) {
  const path = (rawPath || '/').replace(/\/+$/, '') || '/';

  if (method === 'GET' && path === '/health') {
    return { name: 'health', params: {} };
  }
  if (method === 'GET' && path === '/me') {
    return { name: 'me', params: {} };
  }
  if (method === 'GET' && path === '/tasks') {
    return { name: 'listTasks', params: {} };
  }
  if (method === 'POST' && path === '/tasks') {
    return { name: 'createTask', params: {} };
  }

  const match = path.match(/^\/tasks\/([^/]+)$/);
  if (match) {
    const taskId = decodeURIComponent(match[1]);
    if (method === 'GET') return { name: 'getTask', params: { taskId } };
    if (method === 'PUT') return { name: 'updateTask', params: { taskId } };
    if (method === 'DELETE') return { name: 'deleteTask', params: { taskId } };
  }

  return null;
}

export function createHandler({ ddb, config }) {
  const tableName = config.tableName;

  async function queryTasks(userSub) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `USER#${userSub}`,
          ':prefix': 'TASK#',
        },
      }),
    );
    return (res.Items || []).map(stripInternalKeys);
  }

  async function getTaskItem(userSub, taskId) {
    const res = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${userSub}`, SK: `TASK#${taskId}` },
      }),
    );
    return res.Item ? stripInternalKeys(res.Item) : null;
  }

  return async function handler(event) {
    const method = (event?.requestContext?.http?.method || event?.httpMethod || 'GET').toUpperCase();
    const rawPath = event?.rawPath || event?.path || '/';
    const route = matchRoute(method, rawPath);

    if (!route) {
      return jsonResponse(404, { message: 'Rota não encontrada.' });
    }

    if (route.name === 'health') {
      return jsonResponse(200, {
        status: 'ok',
        service: 'TaskCloud API — Projeto Final de Sistemas Distribuídos (UFERSA)',
        author: 'Guilherme Aguiar (Grupo 06)',
        dns: {
          app: 'https://guilhermeag.grupo-06.sd.ufersa.dev.br',
          api: 'https://api.guilhermeag.grupo-06.sd.ufersa.dev.br',
        },
        layers: {
          presentation: 'AWS Amplify (React + TypeScript + Vite)',
          business: 'Amazon API Gateway (HTTP API) + AWS Lambda',
          data: 'Amazon DynamoDB (Partição isolada por usuário)',
          auth: 'Amazon Cognito (OAuth2 + PKCE + JWT Authorizer)',
        },
        timestamp: new Date().toISOString(),
      });
    }

    const user = extractUser(event);
    if (!user) {
      return jsonResponse(401, {
        message: 'Não autorizado. Envie um token JWT válido do Amazon Cognito no header Authorization.',
      });
    }

    try {
      const pk = `USER#${user.sub}`;
      const query = event?.queryStringParameters || {};

      switch (route.name) {
        case 'me': {
          const tasks = await queryTasks(user.sub);
          const todo = tasks.filter((t) => t.status === 'todo').length;
          const doing = tasks.filter((t) => t.status === 'doing').length;
          const done = tasks.filter((t) => t.status === 'done').length;

          return jsonResponse(200, {
            user,
            stats: {
              tasks: tasks.length,
              todo,
              doing,
              done,
            },
            architecture: {
              api: 'https://api.guilhermeag.grupo-06.sd.ufersa.dev.br',
              database: tableName,
              isolationKey: pk,
            },
          });
        }

        case 'listTasks': {
          let tasks = await queryTasks(user.sub);
          if (query.status && VALID_STATUSES.has(query.status)) {
            tasks = tasks.filter((t) => t.status === query.status);
          }
          if (query.priority && VALID_PRIORITIES.has(query.priority)) {
            tasks = tasks.filter((t) => t.priority === query.priority);
          }
          tasks.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
          return jsonResponse(200, { items: tasks });
        }

        case 'createTask': {
          const body = parseBody(event);
          const title = String(body.title || '').trim();
          const description = String(body.description || '').trim();
          const status = body.status ? String(body.status) : 'todo';
          const priority = body.priority ? String(body.priority) : 'medium';
          const dueDate = body.dueDate ? String(body.dueDate).trim() : null;

          if (title.length < 2 || title.length > 120) {
            return jsonResponse(400, {
              message: 'O título da tarefa deve ter entre 2 e 120 caracteres.',
            });
          }
          if (description.length > 1500) {
            return jsonResponse(400, {
              message: 'A descrição da tarefa pode ter no máximo 1500 caracteres.',
            });
          }
          if (!VALID_STATUSES.has(status)) {
            return jsonResponse(400, { message: 'Status inválido. Use todo, doing ou done.' });
          }
          if (!VALID_PRIORITIES.has(priority)) {
            return jsonResponse(400, { message: 'Prioridade inválida. Use low, medium ou high.' });
          }
          if (!isValidIsoDate(dueDate)) {
            return jsonResponse(400, { message: 'Data de entrega deve estar no formato AAAA-MM-DD.' });
          }

          const now = new Date().toISOString();
          const id = randomUUID();
          const item = {
            PK: pk,
            SK: `TASK#${id}`,
            entityType: 'TASK',
            id,
            ownerId: user.sub,
            title,
            description,
            status,
            priority,
            dueDate: dueDate || null,
            createdAt: now,
            updatedAt: now,
          };

          await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
          return jsonResponse(201, { item: stripInternalKeys(item) });
        }

        case 'getTask': {
          const task = await getTaskItem(user.sub, route.params.taskId);
          if (!task) {
            return jsonResponse(404, { message: 'Tarefa não encontrada.' });
          }
          return jsonResponse(200, { item: task });
        }

        case 'updateTask': {
          const existing = await getTaskItem(user.sub, route.params.taskId);
          if (!existing) {
            return jsonResponse(404, { message: 'Tarefa não encontrada.' });
          }

          const body = parseBody(event);
          const title = body.title !== undefined ? String(body.title).trim() : existing.title;
          const description =
            body.description !== undefined ? String(body.description).trim() : existing.description;
          const status = body.status !== undefined ? String(body.status) : existing.status;
          const priority = body.priority !== undefined ? String(body.priority) : existing.priority;
          const dueDate =
            body.dueDate !== undefined ? String(body.dueDate || '').trim() || null : existing.dueDate;

          if (title.length < 2 || title.length > 120) {
            return jsonResponse(400, {
              message: 'O título da tarefa deve ter entre 2 e 120 caracteres.',
            });
          }
          if (description.length > 1500) {
            return jsonResponse(400, {
              message: 'A descrição da tarefa pode ter no máximo 1500 caracteres.',
            });
          }
          if (!VALID_STATUSES.has(status)) {
            return jsonResponse(400, { message: 'Status inválido. Use todo, doing ou done.' });
          }
          if (!VALID_PRIORITIES.has(priority)) {
            return jsonResponse(400, { message: 'Prioridade inválida. Use low, medium ou high.' });
          }
          if (!isValidIsoDate(dueDate)) {
            return jsonResponse(400, { message: 'Data de entrega deve estar no formato AAAA-MM-DD.' });
          }

          const updatedAt = new Date().toISOString();
          await ddb.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: pk, SK: `TASK#${existing.id}` },
              UpdateExpression:
                'SET title = :t, description = :d, #s = :s, priority = :p, dueDate = :due, updatedAt = :u',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: {
                ':t': title,
                ':d': description,
                ':s': status,
                ':p': priority,
                ':due': dueDate,
                ':u': updatedAt,
              },
            }),
          );

          return jsonResponse(200, {
            item: {
              ...existing,
              title,
              description,
              status,
              priority,
              dueDate,
              updatedAt,
            },
          });
        }

        case 'deleteTask': {
          const existing = await getTaskItem(user.sub, route.params.taskId);
          if (!existing) {
            return jsonResponse(404, { message: 'Tarefa não encontrada.' });
          }
          await ddb.send(
            new DeleteCommand({
              TableName: tableName,
              Key: { PK: pk, SK: `TASK#${existing.id}` },
            }),
          );
          return jsonResponse(204);
        }

        default:
          return jsonResponse(404, { message: 'Rota não encontrada.' });
      }
    } catch (err) {
      if (err?.statusCode === 400) {
        return jsonResponse(400, { message: err.message });
      }
      console.error('Erro interno na Lambda TaskCloud:', err);
      return jsonResponse(500, { message: 'Erro interno ao processar a solicitação.' });
    }
  };
}
