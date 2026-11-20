import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

const VALID_STATUSES = new Set(['todo', 'doing', 'done']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high']);
const VALID_COLORS = new Set([
  '#2563eb',
  '#0f766e',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0284c7',
  '#475569',
  '#059669',
]);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ATTACHMENTS_PER_TASK = 10;
const PRESIGNED_TTL_SECONDS = 300; // 5 minutos

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

function sanitizeFilename(name) {
  const base = String(name || '')
    .replace(/[/\\]+/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/[^a-zA-Z0-9._\-\s]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return base.slice(0, 100) || 'anexo';
}

function isValidIsoDate(val) {
  if (val === null || val === undefined || val === '') return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(val));
}

function stripInternalKeys(item) {
  if (!item) return null;
  const { PK: _pk, SK: _sk, entityType: _et, ...rest } = item;
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
  if (method === 'GET' && path === '/projects') {
    return { name: 'listProjects', params: {} };
  }
  if (method === 'POST' && path === '/projects') {
    return { name: 'createProject', params: {} };
  }

  let match = path.match(/^\/projects\/([^/]+)$/);
  if (match) {
    const projectId = decodeURIComponent(match[1]);
    if (method === 'GET') return { name: 'getProject', params: { projectId } };
    if (method === 'PUT') return { name: 'updateProject', params: { projectId } };
    if (method === 'DELETE') return { name: 'deleteProject', params: { projectId } };
  }

  if (method === 'GET' && path === '/tasks') {
    return { name: 'listTasks', params: {} };
  }
  if (method === 'POST' && path === '/tasks') {
    return { name: 'createTask', params: {} };
  }

  match = path.match(/^\/tasks\/([^/]+)$/);
  if (match) {
    const taskId = decodeURIComponent(match[1]);
    if (method === 'GET') return { name: 'getTask', params: { taskId } };
    if (method === 'PUT') return { name: 'updateTask', params: { taskId } };
    if (method === 'DELETE') return { name: 'deleteTask', params: { taskId } };
  }

  match = path.match(/^\/tasks\/([^/]+)\/attachments\/upload-url$/);
  if (match && method === 'POST') {
    return { name: 'createAttachmentUploadUrl', params: { taskId: decodeURIComponent(match[1]) } };
  }

  match = path.match(/^\/tasks\/([^/]+)\/attachments\/([^/]+)\/download-url$/);
  if (match && method === 'GET') {
    return {
      name: 'getAttachmentDownloadUrl',
      params: {
        taskId: decodeURIComponent(match[1]),
        attachmentId: decodeURIComponent(match[2]),
      },
    };
  }

  match = path.match(/^\/tasks\/([^/]+)\/attachments\/([^/]+)$/);
  if (match && method === 'DELETE') {
    return {
      name: 'deleteAttachment',
      params: {
        taskId: decodeURIComponent(match[1]),
        attachmentId: decodeURIComponent(match[2]),
      },
    };
  }

  return null;
}

export function createHandler({ ddb, s3, getSignedUrl, config }) {
  const tableName = config.tableName;
  const bucketName = config.bucketName;

  async function queryByPrefix(userSub, skPrefix) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `USER#${userSub}`,
          ':prefix': skPrefix,
        },
      }),
    );
    return (res.Items || []).map(stripInternalKeys);
  }

  async function getUserItem(userSub, sk) {
    const res = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${userSub}`, SK: sk },
      }),
    );
    return res.Item ? stripInternalKeys(res.Item) : null;
  }

  async function deleteS3ObjectSafe(key) {
    if (!key) return;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
    } catch (err) {
      if (err?.name !== 'NoSuchKey') {
        console.warn('Falha ao remover objeto do S3:', key, err?.message);
      }
    }
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
          data: 'Amazon DynamoDB + Amazon S3 (Privado)',
          auth: 'Amazon Cognito (OAuth2 / OIDC + JWT Authorizer)',
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
          const [projects, tasks] = await Promise.all([
            queryByPrefix(user.sub, 'PROJECT#'),
            queryByPrefix(user.sub, 'TASK#'),
          ]);
          const completedTasks = tasks.filter((t) => t.status === 'done').length;
          const attachments = tasks.reduce((acc, t) => acc + (t.attachments?.length || 0), 0);
          return jsonResponse(200, {
            user,
            stats: {
              projects: projects.length,
              tasks: tasks.length,
              completedTasks,
              attachments,
            },
            architecture: {
              api: 'https://api.guilhermeag.grupo-06.sd.ufersa.dev.br',
              database: tableName,
              storage: bucketName,
              isolationKey: pk,
            },
          });
        }

        // ---------------- PROJECTS ----------------
        case 'listProjects': {
          const [projects, tasks] = await Promise.all([
            queryByPrefix(user.sub, 'PROJECT#'),
            queryByPrefix(user.sub, 'TASK#'),
          ]);
          const counts = new Map();
          for (const task of tasks) {
            if (!task.projectId) continue;
            const current = counts.get(task.projectId) || { total: 0, done: 0 };
            current.total += 1;
            if (task.status === 'done') current.done += 1;
            counts.set(task.projectId, current);
          }
          const enriched = projects
            .map((p) => ({
              ...p,
              taskCount: counts.get(p.id)?.total || 0,
              completedCount: counts.get(p.id)?.done || 0,
            }))
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

          return jsonResponse(200, { items: enriched });
        }

        case 'createProject': {
          const body = parseBody(event);
          const name = String(body.name || '').trim();
          const description = String(body.description || '').trim();
          const color = body.color && VALID_COLORS.has(body.color) ? body.color : '#2563eb';

          if (name.length < 2 || name.length > 80) {
            return jsonResponse(400, {
              message: 'O nome do projeto deve ter entre 2 e 80 caracteres.',
            });
          }
          if (description.length > 300) {
            return jsonResponse(400, {
              message: 'A descrição do projeto pode ter no máximo 300 caracteres.',
            });
          }

          const now = new Date().toISOString();
          const id = randomUUID();
          const item = {
            PK: pk,
            SK: `PROJECT#${id}`,
            entityType: 'PROJECT',
            id,
            ownerId: user.sub,
            name,
            description,
            color,
            createdAt: now,
            updatedAt: now,
          };

          await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
          return jsonResponse(201, {
            item: { ...stripInternalKeys(item), taskCount: 0, completedCount: 0 },
          });
        }

        case 'getProject': {
          const project = await getUserItem(user.sub, `PROJECT#${route.params.projectId}`);
          if (!project) {
            return jsonResponse(404, { message: 'Projeto não encontrado.' });
          }
          const tasks = (await queryByPrefix(user.sub, 'TASK#')).filter(
            (t) => t.projectId === project.id,
          );
          return jsonResponse(200, { item: project, tasks });
        }

        case 'updateProject': {
          const existing = await getUserItem(user.sub, `PROJECT#${route.params.projectId}`);
          if (!existing) {
            return jsonResponse(404, { message: 'Projeto não encontrado.' });
          }
          const body = parseBody(event);
          const name = body.name !== undefined ? String(body.name).trim() : existing.name;
          const description =
            body.description !== undefined ? String(body.description).trim() : existing.description;
          const color =
            body.color !== undefined && VALID_COLORS.has(body.color) ? body.color : existing.color;

          if (name.length < 2 || name.length > 80) {
            return jsonResponse(400, {
              message: 'O nome do projeto deve ter entre 2 e 80 caracteres.',
            });
          }
          if (description.length > 300) {
            return jsonResponse(400, {
              message: 'A descrição do projeto pode ter no máximo 300 caracteres.',
            });
          }

          const updatedAt = new Date().toISOString();
          await ddb.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: pk, SK: `PROJECT#${existing.id}` },
              UpdateExpression: 'SET #n = :name, description = :desc, color = :color, updatedAt = :u',
              ExpressionAttributeNames: { '#n': 'name' },
              ExpressionAttributeValues: {
                ':name': name,
                ':desc': description,
                ':color': color,
                ':u': updatedAt,
              },
            }),
          );

          return jsonResponse(200, {
            item: { ...existing, name, description, color, updatedAt },
          });
        }

        case 'deleteProject': {
          const existing = await getUserItem(user.sub, `PROJECT#${route.params.projectId}`);
          if (!existing) {
            return jsonResponse(404, { message: 'Projeto não encontrado.' });
          }
          const tasks = (await queryByPrefix(user.sub, 'TASK#')).filter(
            (t) => t.projectId === existing.id,
          );
          for (const task of tasks) {
            for (const att of task.attachments || []) {
              await deleteS3ObjectSafe(att.s3Key);
            }
            await ddb.send(
              new DeleteCommand({
                TableName: tableName,
                Key: { PK: pk, SK: `TASK#${task.id}` },
              }),
            );
          }
          await ddb.send(
            new DeleteCommand({
              TableName: tableName,
              Key: { PK: pk, SK: `PROJECT#${existing.id}` },
            }),
          );
          return jsonResponse(204);
        }

        // ---------------- TASKS ----------------
        case 'listTasks': {
          let tasks = await queryByPrefix(user.sub, 'TASK#');
          if (query.projectId) {
            tasks = tasks.filter((t) => t.projectId === query.projectId);
          }
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
          const projectId = body.projectId ? String(body.projectId).trim() : null;

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
          if (projectId) {
            const proj = await getUserItem(user.sub, `PROJECT#${projectId}`);
            if (!proj) {
              return jsonResponse(404, { message: 'Projeto informado não foi encontrado.' });
            }
          }

          const now = new Date().toISOString();
          const id = randomUUID();
          const item = {
            PK: pk,
            SK: `TASK#${id}`,
            entityType: 'TASK',
            id,
            ownerId: user.sub,
            projectId,
            title,
            description,
            status,
            priority,
            dueDate: dueDate || null,
            attachments: [],
            createdAt: now,
            updatedAt: now,
          };

          await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
          return jsonResponse(201, { item: stripInternalKeys(item) });
        }

        case 'getTask': {
          const task = await getUserItem(user.sub, `TASK#${route.params.taskId}`);
          if (!task) {
            return jsonResponse(404, { message: 'Tarefa não encontrada.' });
          }
          return jsonResponse(200, { item: task });
        }

        case 'updateTask': {
          const existing = await getUserItem(user.sub, `TASK#${route.params.taskId}`);
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
          const projectId =
            body.projectId !== undefined
              ? String(body.projectId || '').trim() || null
              : existing.projectId;

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
          if (projectId && projectId !== existing.projectId) {
            const proj = await getUserItem(user.sub, `PROJECT#${projectId}`);
            if (!proj) {
              return jsonResponse(404, { message: 'Projeto informado não foi encontrado.' });
            }
          }

          const updatedAt = new Date().toISOString();
          await ddb.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: pk, SK: `TASK#${existing.id}` },
              UpdateExpression:
                'SET title = :t, description = :d, #s = :s, priority = :p, dueDate = :due, projectId = :pid, updatedAt = :u',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: {
                ':t': title,
                ':d': description,
                ':s': status,
                ':p': priority,
                ':due': dueDate,
                ':pid': projectId,
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
              projectId,
              updatedAt,
            },
          });
        }

        case 'deleteTask': {
          const existing = await getUserItem(user.sub, `TASK#${route.params.taskId}`);
          if (!existing) {
            return jsonResponse(404, { message: 'Tarefa não encontrada.' });
          }
          for (const att of existing.attachments || []) {
            await deleteS3ObjectSafe(att.s3Key);
          }
          await ddb.send(
            new DeleteCommand({
              TableName: tableName,
              Key: { PK: pk, SK: `TASK#${existing.id}` },
            }),
          );
          return jsonResponse(204);
        }

        // ---------------- ATTACHMENTS (S3 PRIVADO + PRESIGNED URLS) ----------------
        case 'createAttachmentUploadUrl': {
          const task = await getUserItem(user.sub, `TASK#${route.params.taskId}`);
          if (!task) {
            return jsonResponse(404, { message: 'Tarefa não encontrada.' });
          }
          const currentAttachments = task.attachments || [];
          if (currentAttachments.length >= MAX_ATTACHMENTS_PER_TASK) {
            return jsonResponse(400, {
              message: `Limite máximo de ${MAX_ATTACHMENTS_PER_TASK} anexos por tarefa atingido.`,
            });
          }

          const body = parseBody(event);
          const originalName = String(body.filename || '').trim();
          const contentType = String(body.contentType || 'application/octet-stream').trim();
          const size = Number(body.size);

          if (!originalName) {
            return jsonResponse(400, { message: 'Informe o nome do arquivo.' });
          }
          if (!Number.isFinite(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
            return jsonResponse(400, {
              message: 'O arquivo deve ter tamanho maior que 0 e no máximo 10 MB.',
            });
          }

          const safeName = sanitizeFilename(originalName);
          const attachmentId = randomUUID();
          const s3Key = `users/${user.sub}/tasks/${task.id}/${attachmentId}-${safeName}`;
          const uploadedAt = new Date().toISOString();

          const uploadUrl = await getSignedUrl(
            s3,
            new PutObjectCommand({
              Bucket: bucketName,
              Key: s3Key,
              ContentType: contentType,
            }),
            { expiresIn: PRESIGNED_TTL_SECONDS },
          );

          const attachment = {
            id: attachmentId,
            filename: originalName.slice(0, 120),
            safeName,
            contentType,
            size,
            s3Key,
            uploadedAt,
          };

          const updatedAttachments = [...currentAttachments, attachment];
          await ddb.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: pk, SK: `TASK#${task.id}` },
              UpdateExpression: 'SET attachments = :a, updatedAt = :u',
              ExpressionAttributeValues: {
                ':a': updatedAttachments,
                ':u': uploadedAt,
              },
            }),
          );

          return jsonResponse(201, {
            uploadUrl,
            expiresIn: PRESIGNED_TTL_SECONDS,
            attachment,
          });
        }

        case 'getAttachmentDownloadUrl': {
          const task = await getUserItem(user.sub, `TASK#${route.params.taskId}`);
          if (!task) {
            return jsonResponse(404, { message: 'Tarefa não encontrada.' });
          }
          const attachment = (task.attachments || []).find(
            (a) => a.id === route.params.attachmentId,
          );
          if (!attachment) {
            return jsonResponse(404, { message: 'Anexo não encontrado.' });
          }

          const downloadUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: bucketName,
              Key: attachment.s3Key,
              ResponseContentDisposition: `inline; filename="${attachment.safeName || 'anexo'}"`,
            }),
            { expiresIn: PRESIGNED_TTL_SECONDS },
          );

          return jsonResponse(200, {
            downloadUrl,
            expiresIn: PRESIGNED_TTL_SECONDS,
            attachment,
          });
        }

        case 'deleteAttachment': {
          const task = await getUserItem(user.sub, `TASK#${route.params.taskId}`);
          if (!task) {
            return jsonResponse(404, { message: 'Tarefa não encontrada.' });
          }
          const attachments = task.attachments || [];
          const attachment = attachments.find((a) => a.id === route.params.attachmentId);
          if (!attachment) {
            return jsonResponse(404, { message: 'Anexo não encontrado.' });
          }

          await deleteS3ObjectSafe(attachment.s3Key);
          const remaining = attachments.filter((a) => a.id !== attachment.id);
          await ddb.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: pk, SK: `TASK#${task.id}` },
              UpdateExpression: 'SET attachments = :a, updatedAt = :u',
              ExpressionAttributeValues: {
                ':a': remaining,
                ':u': new Date().toISOString(),
              },
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
