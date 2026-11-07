// Sobe a API de conexão (a mesma do kontorgestao.com.br) num servidor local, com banco em memória.
import http from 'node:http';
// @ts-ignore arquivo JS copiado do kontor-site
import { conexao, _reiniciar } from './api-conexao.js';
// @ts-ignore
import { d1Falso } from './d1-falso.js';

export async function servidorConexao() {
  _reiniciar();
  const env = { DB: d1Falso() };
  const srv = http.createServer(async (req, res) => {
    const partes: Buffer[] = [];
    for await (const p of req) partes.push(p as Buffer);
    const corpo = Buffer.concat(partes);
    const r: Response = await conexao(new Request(`http://local${req.url}`, { method: req.method, headers: req.headers as any, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : corpo }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/api/conexao/v1`;
  return { url, env, fechar: () => new Promise<void>((ok) => srv.close(() => ok())) };
}
