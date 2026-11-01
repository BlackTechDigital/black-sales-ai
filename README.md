# Black Sales AI 2.0 — fundação

Preparação privada sem Cloudflare Access: [homologação isolada com Basic Auth no Worker](docs/HOMOLOGATION.md). Nenhum deploy ou serviço foi ativado por essa preparação.

Painel comercial da Black Tech com React, TypeScript e Vite, API Hono em Cloudflare Workers e integração preparada com Supabase Auth/PostgreSQL. A migração separa interface, validação, integração e regras de dados para permitir testes e manutenção. Preto e azul da versão anterior foram preservados.

## Executar localmente

Requer Node.js 24 LTS e npm. As versões estão fixadas em `package-lock.json`.

```bash
npm ci
npm run dev
```

Abra **http://localhost:5173**. Sem configuração, a aplicação apresenta o estado de conexão pendente, sem empresas fictícias e sem gravar dados locais. O comando inicia somente processos locais; não publica nada. Não use `vite preview` isoladamente para autenticação: o painel precisa da API.

Para conectar um Supabase já autorizado, siga [docs/SUPABASE.md](docs/SUPABASE.md). Não há migração remota automática no `install`, `dev`, `test` ou `build`; testes de banco usam PostgreSQL temporário em memória. Não há script de deploy.

## O que está implementado

- Login com e-mail/senha, renovação de sessão e logout. Conta liberada pelo administrador; cadastro público não está implementado.
- Recuperação de senha em `/reset-password`, com confirmação, validação no servidor e suporte a PKCE, hash e links legados. Veja [como testar em localhost:5173](docs/PASSWORD_RECOVERY.md).
- Credenciais de integração e tokens do Supabase ficam na API. Cookies HttpOnly/Secure em HTTPS; acesso a dados protegido por RLS e vínculo de membro ativo.
- Cadastro, edição, busca por empresa/cidade/segmento e filtro pelas quatro etapas existentes.
- Exclusão confirmada para lixeira, restauração e histórico imutável de criação, alteração e exclusão lógica.
- Classificação manual da presença digital, inicialmente **Ainda não analisado**.
- Rascunhos por modelo de texto e revisão antes de copiar, sem IA, envio ou mudança automática de etapa.
- Importação JSON v1 com prévia, confirmação, deduplicação, conflitos e transação atômica.
- Exportação dos registros ativos no formato v1, compatível com o importador.
- Central **Descobrir empresas** em `/discover`, com filtros, importação manual revisada, procedência persistida e adição confirmada ao pipeline com verificação de possíveis duplicatas. Passos/MG é o filtro inicial; não há fonte externa ativa nem empresas pré-carregadas. Veja [docs/DISCOVERY.md](docs/DISCOVERY.md).
- **Creative Studio** em `/studio`: projetos vinculados a oportunidades ou de demonstração, 13 campos com procedência/verificação/uso público, rascunhos em versões imutáveis, revisão de alterações e aprovação por versão/hash. [Configuração e teste local](docs/STUDIO.md).
- **Geração de sites no Studio**: elegibilidade, confirmação humana, trabalhos idempotentes, acompanhamento e histórico de versões imutáveis. IA permanece desativada sem configuração autorizada de provedor/cotas/coordenador. [Fluxo integrado e testes sem API real](docs/STUDIO_GENERATION_FLOW.md).
- **Prévia segura no Studio**: seleção de versões salvas e simulação desktop/tablet/celular em iframe sem scripts, a partir do documento validado pelo backend. Links externos e imagens ficam desativados. [Como testar com documentos simulados](docs/STUDIO_SITE_PREVIEW.md).
- **Exportação revisada no Studio**: aprovação humana específica da versão e dos arquivos, ZIP determinístico HTML/CSS, manifesto SHA-256 e ferramentas locais sem dependências externas. Desativada até ativação controlada. [Baixar, testar e ativar futuramente](docs/STUDIO_SITE_EXPORT.md).

O histórico e a lixeira não fazem parte do JSON v1: backup completo exige backup do PostgreSQL. A revisão do rascunho é local e ainda não constitui aprovação auditável para uma integração de mensagens.

## Preservação e importação da versão 1.0

O HTML original está preservado integralmente em [legacy/index.html](legacy/index.html), fora dos arquivos publicados pelo build. A aplicação não escreve nem remove a chave `black_sales_ai_leads_v1`.

Use **Recuperar cópia local da v1** para baixar o conteúdo original sem filtrar ou truncar, ou exporte o JSON no navegador/origem onde utilizava a versão anterior. `localStorage` é separado por protocolo, domínio e porta; mudar de endereço não transfere dados automaticamente.

No painel autenticado, abra **Importar backup**. Arquivos de até 2 MB e 5.000 registros passam por validação antes da prévia. Confirme somente após revisar os totais. Nada é substituído: registros conflitantes são ignorados e identificados pela posição no arquivo. Uma tentativa repetida não duplica dados. Registros na lixeira também impedem duplicação.

O objeto original de cada novo registro é preservado em `legacy_snapshot`. Datas de criação antigas não são inferidas. A classificação digital importada é apresentada como legado não verificado. Sem CNPJ, a identidade usada nesta etapa é empresa + cidade + segmento + contato normalizados; coincidências exigem revisão, nunca fusão ou sobrescrita automática.

## Verificações

```bash
npm run format:check
npm run check
npx playwright install chromium
npm run test:e2e
```

Os testes de banco executam a migração em PostgreSQL WASM/PGlite **temporário, em memória**, com usuários sintéticos de teste. Não usam credenciais ou banco remoto. Os testes da API simulam o cliente Supabase; os testes de navegador simulam as respostas HTTP. Autenticação real, transporte PostgREST e restauração de um Supabase hospedado precisam de homologação após autorização de configuração.

Para usar um Chromium já instalado, defina `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. O CI executa verificações em pull requests, sem deploy e sem migrações remotas.

## Organização

- `src/`: interface e cliente HTTP sem credenciais.
- `shared/`: validação, tipos e modelos de texto.
- `server/`: autenticação, cookies, proteção de origem e API de dados.
- `supabase/migrations/`: tabelas, políticas RLS, gatilhos de histórico e funções transacionais.
- `tests/`: banco, API, validação e navegador.
- [docs/SUPABASE.md](docs/SUPABASE.md): configuração e operação.
- [docs/PASSWORD_RECOVERY.md](docs/PASSWORD_RECOVERY.md): configuração de e-mail e teste local da recuperação.
- [docs/LOCAL_NETWORK.md](docs/LOCAL_NETWORK.md): acesso local em dois computadores com lista exata de origens, mantendo autenticação e CSRF.
- [docs/BROWSER_COMPATIBILITY.md](docs/BROWSER_COMPATIBILITY.md): UUIDs seguros em HTTP, recuperação de erros do Studio e limites de HTTPS para exportação/clipboard.
- [docs/SECURITY.md](docs/SECURITY.md): limites e decisões de segurança.
- [docs/DISCOVERY.md](docs/DISCOVERY.md): configuração, importação e teste local da central de descoberta.
- [docs/STUDIO.md](docs/STUDIO.md): tabelas, migração, segurança e teste local de projetos/briefings.
- [docs/STUDIO_GENERATION_FLOW.md](docs/STUDIO_GENERATION_FLOW.md): endpoints, painel de geração, limitações e testes locais com simulações.
- [docs/STUDIO_SITE_PREVIEW.md](docs/STUDIO_SITE_PREVIEW.md): renderizador confiável, isolamento, versões e testes de prévia sem consumo de API.
- [docs/STUDIO_SITE_EXPORT.md](docs/STUDIO_SITE_EXPORT.md): revisão do site, permissões, ZIP auditável, execução local e ativação controlada.

Pesquisa externa, análise automática de empresas, mensageria, workspace compartilhado e Black CRM permanecem fora do escopo. A geração de sites tem fluxo integrado, prévia privada e exportação manual revisada, mas chamadas externas de IA continuam desativadas até configuração autorizada. Não há executor nem publicação automática. Cada usuário acessa apenas seus próprios registros.
