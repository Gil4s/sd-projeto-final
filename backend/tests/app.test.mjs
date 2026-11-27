import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/app.mjs';

function createMockRuntime() {
  const store = new Map();

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
        if (v[':t'] !== undefined) existing.title = v[':t'];
        if (v[':d'] !== undefined) existing.description = v[':d'];
        if (v[':s'] !== undefined) existing.status = v[':s'];
        if (v[':p'] !== undefined) existing.priority = v[':p'];
        if (v[':due'] !== undefined) existing.dueDate = v[':due'];
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

  const handler = createHandler({
    ddb,
    config: { tableName: 'test-table' },
  });

  return { handler, store };
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

test('Fluxo CRUD completo de tarefas com isolamento por usuário', async () => {
  const { handler } = createMockRuntime();

  // 1. Criar tarefa do Usuário A
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
      },
    }),
  );
  assert.equal(createTaskRes.statusCode, 201);
  const task = JSON.parse(createTaskRes.body).item;
  assert.equal(task.status, 'todo');

  // 2. Isolamento multi-usuário: Usuário B não enxerga nem consegue alterar dados do Usuário A
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

  // 3. Mover status da tarefa como Usuário A
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

  // 4. Verificar /me com estatísticas
  const meRes = await handler(makeEvent({ method: 'GET', path: '/me', user: userA }));
  assert.equal(meRes.statusCode, 200);
  const meData = JSON.parse(meRes.body);
  assert.equal(meData.stats.tasks, 1);
  assert.equal(meData.stats.done, 1);

  // 5. Excluir tarefa
  const delRes = await handler(
    makeEvent({ method: 'DELETE', path: `/tasks/${task.id}`, user: userA }),
  );
  assert.equal(delRes.statusCode, 204);

  const listAfter = await handler(makeEvent({ method: 'GET', path: '/tasks', user: userA }));
  assert.equal(JSON.parse(listAfter.body).items.length, 0);
});

test('Validação rejeita payload inválido', async () => {
  const { handler } = createMockRuntime();
  const badTitle = await handler(
    makeEvent({
      method: 'POST',
      path: '/tasks',
      user: userA,
      body: { title: 'A' },
    }),
  );
  assert.equal(badTitle.statusCode, 400);

  const badStatus = await handler(
    makeEvent({
      method: 'POST',
      path: '/tasks',
      user: userA,
      body: { title: 'Tarefa válida', status: 'invalido' },
    }),
  );
  assert.equal(badStatus.statusCode, 400);
});
