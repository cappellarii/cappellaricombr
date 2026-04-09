# Projeto de Chat Privado + Chat Público + Páginas Especiais

Aplicação full stack em Node.js com Express, Socket.IO e SQLite, com foco em:
- Chat privado com autenticação por chave
- Chat público sem login
- Canais de texto e presença em tempo real
- Upload de arquivos nas mensagens
- Chamadas de voz com sinalização via Socket.IO
- Painel de administração para moderação e gestão de chaves
- Páginas extras acessíveis por URL, como Meu IP, Channel e Currículo

## Stack

- Node.js
- Express
- Socket.IO
- SQLite3
- Multer
- Frontend em HTML, CSS e JavaScript puro

## Estrutura do projeto

- server.js: servidor HTTP, APIs, Socket.IO e regras de negócio
- public/index.html: interface principal do chat privado
- public/open-chat.html: interface do chat público
- public/style.css: estilos da interface principal
- public/uploads: arquivos enviados no chat
- private-pages/meuip.html: página de IP público
- private-pages/channel.html: página especial channel
- curriculo/index.html: página de currículo
- curriculo/style.css: estilos da página de currículo
- curriculo/main.js: script da página de currículo
- auth.db: banco de autenticação, sessões, perfis, chaves e moderação
- channels.db: banco de canais
- messages.db: banco de mensagens (privadas e públicas)

## Como rodar localmente

### 1) Instalar dependências

npm install

### 2) Subir servidor

node server.js

Servidor padrão:
- http://localhost:8080

Porta customizada:
- export PORT=3000
- node server.js

## Variáveis de ambiente

- PORT: porta HTTP da aplicação. Padrão 8080
- ADMIN_SECRET: segredo para autenticação de rotas administrativas. Padrão poderesdoademir

Observação de segurança:
- Em produção, sempre defina um ADMIN_SECRET forte e exclusivo

## Funcionalidades principais

### Chat privado

- Login por chave de acesso
- Sessão com token Bearer
- Canais de texto
- Mensagens com:
- texto
- arquivo (imagem, vídeo, documentos)
- resposta a mensagem (reply)
- edição
- exclusão
- Indicador de digitação
- Presença de usuários online
- Perfil por usuário:
- avatarUrl
- nameColor
- statusText

### Chat público

- Sem autenticação
- Leitura e envio de mensagens simples

### Voz em tempo real

- Entrada e saída de canal de voz
- Mute e deafen
- Indicador de speaking
- Sinalização WebRTC via Socket.IO
- Ping de latência de voz

### Administração

- Criar e revogar chaves de acesso
- Listar chaves
- Ban e unban temporário
- Mute e unmute temporário
- Limpeza de canal
- Log de atividade administrativa

### Páginas por URL

- /meuip e /meu-ip
- /channel
- /curriculo
- Assets do currículo servidos em /curriculo-assets

## Rotas principais

### Páginas e utilitários

- GET /api/meu-ip
- GET /meuip e /meu-ip
- GET /channel
- GET /curriculo
- GET /curriculo-assets/*

### Autenticação

- POST /auth/login
- POST /auth/logout
- GET /auth/me

### Perfil

- GET /profile/me
- PUT /profile/me
- GET /profiles

### Canais e presença

- GET /channels
- POST /channels
- GET /presence
- GET /typing
- POST /typing/start
- POST /typing/stop

### Voz

- GET /voice/channels

### Administração

- POST /admin/mod/ban
- POST /admin/mod/mute
- POST /admin/mod/unban
- POST /admin/mod/unmute
- POST /admin/mod/clear-channel
- GET /admin/mod/activity
- POST /admin/keys
- GET /admin/keys
- POST /admin/keys/:id/revoke

### Mensagens

- GET /public-chat/messages
- POST /public-chat/messages
- GET /messages
- POST /messages
- PATCH /messages/:id
- DELETE /messages/:id

## Eventos Socket.IO de voz

- voice:join
- voice:leave
- voice:mute
- voice:deafen
- voice:speaking
- voice:signal
- voice:latency:ping

## Autenticação e autorização

- Rotas protegidas usam token Bearer no header Authorization
- Rotas administrativas exigem segredo administrativo
- Sessões expiram por tempo
- Usuários banidos ou mutados são validados no backend

## Upload de arquivos

- Upload em mensagens via multipart/form-data
- Campo esperado: file
- Limite de arquivo aplicado no servidor
- Arquivos ficam em public/uploads

## Bancos SQLite

A aplicação faz migração de schema automaticamente no startup.

Arquivos:
- auth.db
- channels.db
- messages.db

## Deploy (resumo)

### Processo Node

- Recomenda-se PM2 ou systemd para manter o processo ativo
- Evite rodar manualmente em terminal de sessão

### Reverse proxy

- Use Nginx ou similar apontando para 127.0.0.1:8080
- Se usar Cloudflare, confirme DNS e regras de cache/redirect

Exemplo conceitual Nginx:

server {
    server_name seu-dominio.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

## Solução de problemas

- Erro Porta 8080 já está em uso:
- Há outro processo node ativo. Finalize o processo e suba novamente

- Currículo não abre em /curriculo:
- Verifique se o processo em produção foi reiniciado
- Verifique se o proxy aponta para a instância atual
- Verifique acesso aos assets em /curriculo-assets

- Cannot GET em rotas específicas:
- Confirme que o servidor em execução é o mesmo código atualizado
- Reinicie o serviço gerenciado por PM2/systemd

## Melhorias sugeridas

- Adicionar scripts npm start e dev no package.json
- Adicionar .env com validação de variáveis
- Adicionar testes automatizados
- Versionar schema de banco com ferramenta de migração
- Adicionar limitação de taxa e hardening de segurança

## Licença

ISC
