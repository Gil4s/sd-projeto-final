import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/app.mjs';

function createMockRuntime() {
  const store = new Map();
  const s3Deleted = [];

  const ddb = {
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      if (name === 'PutCommand') {
        store.set(`${input.Item.PK}|${input.Item.SK}`, structuredClone(input.Item));
        return {};
      }
      if (name === 'GetCommand') {
        const item = store.get(`${input.Key.PK}|${input.Key.SK}`);
        return { Item: item ? structuredClone(item) : undefined };
      }
      if (name === 'QueryCommand') {
        const pk = input.ExpressionAttributeValues[':pk'];
        const prefix = input.ExpressionAttributeValues[':prefix'];
        const items = [];
        for (const item of store.values()) {
          if (item.PK === pk && item.SK.startsWith(prefix)) {
            items.push(structuredClone(item));
          }
        }
        return { Items: items };
      }
      if (name === 'UpdateCommand') {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        const existing = store.get(key);
        if (!existing) return {};
        const v = input.ExpressionAttributeValues;
        if (v[':name'] !== undefined) existing.name = v[':name'];
        if (v[':desc'] !== undefined) existing.description = v[':desc'];
        if (v[':color'] !== undefined) existing.color = v[':color'];
        if (v[':t'] !== undefined) existing.title = v[':t'];
        if (v[':d'] !== undefined) existing.description = v[':d'];
        if (v[':s'] !== undefined) existing.status = v[':s'];
        if (v[':p'] !== undefined) existing.priority = v[':p'];
        if (v[':due'] !== undefined) existing.dueDate = v[':due'];
        if (v[':pid'] !== undefined) existing.projectId = v[':pid'];
        if (v[':a'] !== undefined) existing.attachments = structuredClone(v[':a']);
        if (v[':u'] !== undefined) existing.updatedAt = v[':u'];
        store.set(key, existing);
        return {};
      }
      if (name === 'DeleteCommand') {
        store.delete(`${input.Key.PK}|${input.Key.SK}`);
        return {};
      }
      throw new Error(`Comando mock não suportado: ${name}`);
    },
  };

  const s3 = {
    async send(cmd) {
      if (cmd.constructor.name === 'DeleteObjectCommand') {
        s3Deleted.push(cmd.input.Key);
        return {};
      }
      return {};
    },
  };

  const getSignedUrl = async (_client, cmd) =>
    `https://signed.example.com/${cmd.constructor.name}/${encodeURIComponent(cmd.input.Key)}`;

  const handler = createHandler({
    ddb,
    s3,
    getSignedUrl,
    config: { tableName: 'test-table', bucketName: 'test-bucket' },
  });

  return { handler, store, s3Deleted };
}

function makeEvent({ method, path, body, query, user }) {
  return {
    rawPath: path,
    queryStringParameters: query,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    requestContext: {
      http: { method },
      authorizer: user ? { jwt: { claims: user } } : undefined,
    },
  };
}

const userA = { sub: 'user-a-sub', email: 'guilherme@ufersa.edu.br', token_use: 'id' };
const userB = { sub: 'user-b-sub', email: 'outro@ufersa.edu.br', token_use: 'id' };

test('GET /health responde 200 sem autenticação', async () => {
  const { handler } = createMockRuntime();
  const res = await handler(makeEvent({ method: 'GET', path: '/health' }));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.status, 'ok');
  assert.equal(data.dns.api, 'https://api.guilhermeag.grupo-06.sd.ufersa.dev.br');
});

test('Rotas protegidas retornam 401 sem claims JWT', async () => {
  const { handler } = createMockRuntime();
  const res = await handler(makeEvent({ method: 'GET', path: '/tasks' }));
  assert.equal(res.statusCode, 401);
});

test('Fluxo CRUD completo de projeto, tarefa e anexo S3 com isolamento por usuário', async () => {
  const { handler, s3Deleted } = createMockRuntime();

  // 1. Criar projeto do Usuário A
  const createProjRes = await handler(
    makeEvent({
      method: 'POST',
      path: '/projects',
      user: userA,
      body: { name: 'Sistemas Distribuídos', description: 'Projeto final UFERSA', color: '#2563eb' },
    }),
  );
  assert.equal(createProjRes.statusCode, 201);
  const project = JSON.parse(createProjRes.body).item;
  assert.equal(project.name, 'Sistemas Distribuídos');

  // 2. Criar tarefa vinculada ao projeto
  const createTaskRes = await handler(
    makeEvent({
      method: 'POST',
      path: '/tasks',
      user: userA,
      body: {
        title: 'Configurar DNS no Route 53',
        description: 'Apontar raiz e subdomínio api',
        priority: 'high',
        dueDate: '2026-11-27',
        projectId: project.id,
      },
    }),
  );
  assert.equal(createTaskRes.statusCode, 201);
  const task = JSON.parse(createTaskRes.body).item;
  assert.equal(task.status, 'todo');

  // 3. Isolamento multi-usuário: Usuário B não enxerga nem consegue alterar dados do Usuário A
  const listB = await handler(makeEvent({ method: 'GET', path: '/tasks', user: userB }));
  assert.equal(listB.statusCode, 200);
  assert.equal(JSON.parse(listB.body).items.length, 0);

  const hijackRes = await handler(
    makeEvent({
      method: 'PUT',
      path: `/tasks/${task.id}`,
      user: userB,
      body: { status: 'done' },
    }),
  );
  assert.equal(hijackRes.statusCode, 404);

  // 4. Atualizar status da tarefa como Usuário A
  const updateRes = await handler(
    makeEvent({
      method: 'PUT',
      path: `/tasks/${task.id}`,
      user: userA,
      body: { status: 'done' },
    }),
  );
  assert.equal(updateRes.statusCode, 200);
  assert.equal(JSON.parse(updateRes.body).item.status, 'done');

  // 5. Gerar URL pré-assinada de upload e download no S3 privado
  const uploadUrlRes = await handler(
    makeEvent({
      method: 'POST',
      path: `/tasks/${task.id}/attachments/upload-url`,
      user: userA,
      body: { filename: 'diagrama arquitetura.pdf', contentType: 'application/pdf', size: 120400 },
    }),
  );
  assert.equal(uploadUrlRes.statusCode, 201);
  const uploadData = JSON.parse(uploadUrlRes.body);
  assert.ok(uploadData.uploadUrl.includes('PutObjectCommand'));
  assert.ok(uploadData.attachment.s3Key.startsWith(`users/${userA.sub}/tasks/${task.id}/`));

  // Usuário B não consegue baixar anexo do Usuário A
  const downloadB = await handler(
    makeEvent({
      method: 'GET',
      path: `/tasks/${task.id}/attachments/${uploadData.attachment.id}/download-url`,
      user: userB,
    }),
  );
  assert.equal(downloadB.statusCode, 404);

  // Usuário A gera URL de download
  const downloadA = await handler(
    makeEvent({
      method: 'GET',
      path: `/tasks/${task.id}/attachments/${uploadData.attachment.id}/download-url`,
      user: userA,
    }),
  );
  assert.equal(downloadA.statusCode, 200);
  assert.ok(JSON.parse(downloadA.body).downloadUrl.includes('GetObjectCommand'));

  // 6. Verificar /me com estatísticas
  const meRes = await handler(makeEvent({ method: 'GET', path: '/me', user: userA }));
  assert.equal(meRes.statusCode, 200);
  const meData = JSON.parse(meRes.body);
  assert.equal(meData.stats.projects, 1);
  assert.equal(meData.stats.tasks, 1);
  assert.equal(meData.stats.completedTasks, 1);
  assert.equal(meData.stats.attachments, 1);

  // 7. Excluir projeto remove tarefas e objetos S3 em cascata
  const delProjRes = await handler(
    makeEvent({ method: 'DELETE', path: `/projects/${project.id}`, user: userA }),
  );
  assert.equal(delProjRes.statusCode, 204);
  assert.equal(s3Deleted.length, 1);
  assert.equal(s3Deleted[0], uploadData.attachment.s3Key);
});

test('Validação rejeita payload inválido e anexo acima de 10 MB', async () => {
  const { handler } = createMockRuntime();
  const badTask = await handler(
    makeEvent({
      method: 'POST',
      path: '/tasks',
      user: userA,
      body: { title: 'A' },
    }),
  );
  assert.equal(badTask.statusCode, 400);

  const okTask = await handler(
    makeEvent({
      method: 'POST',
      path: '/tasks',
      user: userA,
      body: { title: 'Tarefa válida' },
    }),
  );
  const taskId = JSON.parse(okTask.body).item.id;

  const hugeFile = await handler(
    makeEvent({
      method: 'POST',
      path: `/tasks/${taskId}/attachments/upload-url`,
      user: userA,
      body: { filename: 'video.mp4', contentType: 'video/mp4', size: 25 * 1024 * 1024 },
    }),
  );
  assert.equal(hugeFile.statusCode, 400);
});
