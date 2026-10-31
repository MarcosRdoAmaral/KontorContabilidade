import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodificarEntidades, htmlParaTexto } from '../src/servicos/parcelamentos-caixa.js';

test('texto da caixa postal: HTML e acentos escapados viram texto limpo', () => {
  const html = '<p>Prezado contribuinte,</p><p>&nbsp; H&amp;aacute; um ano, a seguran&amp;ccedil;a nos pagamentos &#233; maior.</p><ul><li>fazer empr&amp;eacute;stimos;</li> <li>emitir cart&otilde;es;</li></ul><p>1. Cadastre</p>';
  assert.equal(htmlParaTexto(html), 'Prezado contribuinte,\n\nHá um ano, a segurança nos pagamentos é maior.\n\n• fazer empréstimos;\n• emitir cartões;\n\n1. Cadastre');
  assert.equal(htmlParaTexto('&lt;p&gt;Intima&amp;ccedil;&amp;atilde;o&lt;/p&gt;&lt;p&gt;Fim&lt;/p&gt;'), 'Intimação\n\nFim');
  assert.equal(decodificarEntidades('Notifica&ccedil;&atilde;o &Aacute;rea &uuml; &ordm;'), 'Notificação Área ü º');
});
