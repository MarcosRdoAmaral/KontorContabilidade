import { test } from 'node:test';
import assert from 'node:assert/strict';

test('módulos do usuário seguem a ordem do menu (Painel do mês primeiro)', async () => {
  const { modulosDoUsuario } = await import('../src/auth.js');
  assert.deepEqual(modulosDoUsuario({ tipo: 'normal', permissoes: JSON.stringify(['painel', 'emitir', 'obrigacoes', 'visao']) } as any), ['painel', 'visao', 'obrigacoes', 'emitir']);
  assert.equal(modulosDoUsuario({ tipo: 'adm', permissoes: null } as any)[0], 'painel');
});
