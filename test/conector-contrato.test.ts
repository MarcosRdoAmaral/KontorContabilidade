import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conectorDe, FalhaConector, podeTransitar } from '../src/cobranca/conectores/contrato.js';

test('máquina de estados do registro no banco: só transições válidas', () => {
  assert.ok(podeTransitar('AGUARDANDO_REGISTRO', 'EM_PROCESSAMENTO'));
  assert.ok(podeTransitar('EM_PROCESSAMENTO', 'RESULTADO_DESCONHECIDO'));
  assert.ok(podeTransitar('RESULTADO_DESCONHECIDO', 'REGISTRADO'), 'timeout resolvido por consulta');
  assert.ok(podeTransitar('BAIXA_SOLICITADA', 'REGISTRADO'), 'baixa recusada volta a registrado');
  assert.ok(podeTransitar('LIQUIDADO', 'EM_ANALISE'), 'divergência vem de qualquer estado');
  assert.ok(!podeTransitar('LIQUIDADO', 'BAIXA_SOLICITADA'), 'título liquidado não pede baixa');
  assert.ok(!podeTransitar('REJEITADO', 'REGISTRADO'), 'rejeitado exige nova tentativa');
  assert.ok(!podeTransitar('AGUARDANDO_REGISTRO', 'REGISTRADO'), 'registrado só depois do envio');
  assert.throws(() => conectorDe('NAO_EXISTE'), FalhaConector);
});
