const { contextBridge, ipcRenderer } = require('electron');
// Ponte mínima entre a interface e o aplicativo instalado (atualização automática).
contextBridge.exposeInMainWorld('nfseDesktop', {
  versaoPendente: () => ipcRenderer.invoke('atualizacao:pendente'),
  instalarAtualizacao: () => ipcRenderer.invoke('atualizacao:instalar'),
  verificarAtualizacao: () => ipcRenderer.invoke('atualizacao:verificar'),
  estadoAtualizacao: () => ipcRenderer.invoke('atualizacao:estado'),
  aoHaverAtualizacao: (cb) => ipcRenderer.on('atualizacao:nova', (_e, info) => cb(info)),
  // FGTS Digital (login no portal pelo usuário; o Kontor só lê as competências em aberto)
  fgtsConsultar: (clientes) => ipcRenderer.invoke('fgts:consultar', clientes),
  aoAndamentoFgts: (cb) => { ipcRenderer.removeAllListeners('fgts:andamento'); ipcRenderer.on('fgts:andamento', (_e, p) => cb(p)); },
});
